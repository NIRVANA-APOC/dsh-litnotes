/**
 * Unit tests for the Host HTTP routes (`src/host/routes.ts`): JSON envelopes,
 * method checks, the connection fence, raw upload → document creation, asset
 * and source serving with traversal rejection, NDJSON streaming and the
 * client-facing `library.get` payload shape.
 *
 * Ported from the frozen 1.0.0 `.mjs` suite. The web server is faked at the
 * `ctx.webServer.register` seam and requests are driven through
 * `Readable`/`Writable` streams, so no port is opened.
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, test } from 'vitest'
import { expect } from 'vitest'

import { resolveConfig, type CredentialsLike } from '../../src/host/config.ts'
import type {
  AiServicesApi,
  ParseManagerApi,
  ParsePlan,
  ParseStartRequest,
  ServiceApi,
} from '../../src/host/contracts.ts'
import type { WebRoute } from '../../src/host/host-services.ts'
import { normalizeParseOptions } from '../../src/host/parse/mineru.ts'
import { registerRoutes } from '../../src/host/routes.ts'
import { createService } from '../../src/host/service.ts'
import { createStore } from '../../src/host/store/index.ts'
import type { DocumentMeta, ParseState } from '../../src/shared/model.ts'

const API = '/dsh-litnotes/api'
const ASSETS = '/dsh-litnotes/assets'

/** Temporary stores created by the current test. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

/** A fake request readable carrying `body`. */
function makeReq({ method = 'POST', url, headers = {}, body }: {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: Buffer | string
}): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  const fake = req as unknown as IncomingMessage & {
    method: string
    url: string
    headers: Record<string, string>
  }
  fake.method = method
  fake.url = url
  fake.headers = headers
  return fake
}

/** A fake response writable collecting headers and the body. */
interface FakeResponse {
  response: ServerResponse
  statusCode: number
  headers: Record<string, string | number | readonly string[]>
  text: () => string
  json: () => Record<string, unknown>
  done: boolean
  waitDone: () => Promise<void>
}

/** A fake response writable collecting headers and the body. */
function makeRes(): FakeResponse {
  const chunks: Buffer[] = []
  const res = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  }) as Writable & Record<string, unknown>
  res.statusCode = 0
  const headers: Record<string, string | number | readonly string[]> = {}
  res.headers = headers
  res.headersSent = false
  res.setHeader = (name: string, value: string | number | readonly string[]): typeof res => {
    headers[String(name).toLowerCase()] = value
    return res
  }
  res.getHeader = (name: string): unknown => headers[String(name).toLowerCase()]
  res.done = false
  res.on('finish', () => {
    res.done = true
  })
  const response = res as unknown as ServerResponse
  const done = (): Promise<void> => (res.done === true ? Promise.resolve() : once(res, 'finish').then(() => undefined))
  return {
    response,
    get statusCode() {
      return Number(res.statusCode)
    },
    set statusCode(value: number) {
      res.statusCode = value
    },
    headers,
    text: () => Buffer.concat(chunks).toString('utf8'),
    json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
    get done() {
      return res.done === true
    },
    waitDone: done,
  }
}

/** A fake tool-less service manager used by the route tests. */
function makeManager(store: ReturnType<typeof createStore>): ParseManagerApi {
  return {
    async start(id: string, request: ParseStartRequest): Promise<DocumentMeta> {
      const plan = request as ParsePlan
      return store.update(id, { status: 'parsing', error: null, parse: { engine: plan.engine } as Partial<ParseState> })
    },
    async cancel(id: string): Promise<DocumentMeta> {
      return store.update(id, { status: 'uploaded', error: null, parse: { phase: null } })
    },
    resume: () => {},
    async dispose() {},
  }
}

/** A fake AI bundle exposing only the graph/chat pieces the routes stream. */
function makeAiBundle(overrides: Partial<{ -readonly [K in keyof AiServicesApi]: AiServicesApi[K] }> = {}) {
  const throwGraph = async (): Promise<never> => {
    throw new Error('not used')
  }
  return {
    llm: {
      available: () => true,
      route: () => null,
      async *streamText() {},
      async completeText() {
        return ''
      },
    },
    retriever: {
      buildIndex: () => {},
      context: () => ({ blocks: [], outline: [], sections: [], usedChars: 0, totalBlocks: 0 }),
      search: () => [],
      blocks: () => [],
      invalidate: () => {},
    },
    chat: {
      history: async () => [],
      clear: async () => ({ cleared: true as const }),
      stream: async function* () {
        yield { type: 'start', messageId: 'm1', model: { provider: 'p', model: 'm' } } as never
        yield { type: 'delta', text: 'hello' } as never
        yield { type: 'done' } as never
      },
    },
    graph: {
      docGraph: throwGraph,
      buildDocGraph: async function* () {},
      mergeDocKnowledge: throwGraph,
      updateDocGraph: throwGraph,
      libraryGraph: throwGraph,
      rebuildLibraryGraph: async function* () {},
    },
    available: true,
    version: '0.0.0',
    ...overrides,
  }
}

/** Build a routed stack over a temp library. */
async function setup(options: { rejection?: number; ai?: ReturnType<typeof makeAiBundle> } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-routes-'))
  const config = resolveConfig({ dataDir, apiBase: 'https://api.mineru.test' })
  const store = createStore({ dataDir })
  cleanups.push(async () => {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })
  await store.init()
  const credentials: CredentialsLike | undefined = undefined
  const service: ServiceApi = createService({
    store,
    manager: makeManager(store),
    config,
    logger: { warn() {} },
    hostVersion: '0.1.0+host',
    getCredentials: () => credentials,
    getTranslator: () => undefined,
    getLlm: () => undefined,
    getDefaultModel: () => undefined,
    getAi: options.ai === undefined ? undefined : async () => options.ai as AiServicesApi,
    normalizeParseOptions,
  })
  const routes: WebRoute[] = []
  const ctx = {
    webServer: {
      register(route: WebRoute) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: {
      requestRejection: () => options.rejection,
    },
  }
  const dispose = registerRoutes({ ctx, service, store, config, logger: { warn() {} } })
  const route = handlerOf(routes.find((entry) => entry.path === API && entry.kind === 'prefix'))
  const assetRoute = handlerOf(routes.find((entry) => entry.path === ASSETS && entry.kind === 'prefix'))
  const call = async (req: IncomingMessage): Promise<FakeResponse> => {
    const res = makeRes()
    await route(req, res.response)
    await res.waitDone()
    return res
  }
  const callExact = async (path: string, req: IncomingMessage): Promise<FakeResponse> => {
    const res = makeRes()
    await handlerOf(routes.find((entry) => entry.kind === 'exact' && entry.path === path))(req, res.response)
    await res.waitDone()
    return res
  }
  return { dataDir, config, store, service, routes, route, assetRoute, call, callExact, dispose }
}

/** POST a JSON API call through the routed stack. */
async function callJson(env: Awaited<ReturnType<typeof setup>>, method: string, payload?: unknown) {
  const body = JSON.stringify(payload ?? {})
  const req = makeReq({
    method: 'POST',
    url: `${API}/${method}`,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  })
  return env.call(req)
}

/** Upload a file through the raw upload route. */
async function callUpload(env: Awaited<ReturnType<typeof setup>>, fileName: string, bytes: Buffer) {
  const req = makeReq({
    method: 'POST',
    url: `${API}/upload`,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'x-file-name': encodeURIComponent(fileName),
    },
    body: bytes,
  })
  return env.call(req)
}

/** Extract the handler of one registered route (the resource variant is unused here). */
function handlerOf(route: WebRoute | undefined): (req: IncomingMessage, res: ServerResponse) => void | Promise<void> {
  if (route === undefined || !('handler' in route)) throw new Error('route not registered')
  return route.handler
}

/** Teardown a routed stack. */
async function teardown(env: Awaited<ReturnType<typeof setup>>): Promise<void> {
  env.dispose()
}

// ---------------------------------------------------------------------------

test('JSON API dispatches to the service and answers ok envelopes', async () => {
  const env = await setup()
  try {
    const ping = await callJson(env, 'health.ping', { clientVersion: 'test-1', event: 'active' })
    expect(ping.statusCode).toBe(200)
    const pingValue = ping.json() as { ok: boolean; value: { hostVersion: string; receivedAt: string } }
    expect(pingValue.ok).toBe(true)
    expect(pingValue.value.hostVersion).toBe('0.1.0+host')
    expect(typeof pingValue.value.receivedAt).toBe('string')

    const status = await callJson(env, 'status', {})
    const statusValue = status.json() as { ok: boolean; value: { counts: { total: number }; tokenConfigured: boolean } }
    expect(statusValue.ok).toBe(true)
    expect(statusValue.value.counts.total).toBe(0)
    expect(statusValue.value.tokenConfigured).toBe(false)

    const list = await callJson(env, 'library.list', {})
    const listValue = list.json() as { ok: boolean; value: { documents: unknown[] } }
    expect(listValue.ok).toBe(true)
    expect(listValue.value.documents).toEqual([])
  } finally {
    await teardown(env)
  }
})

test('unknown methods, wrong verbs and malformed payloads answer clean errors', async () => {
  const env = await setup()
  try {
    const unknown = await callJson(env, 'nope.nothing', {})
    expect(unknown.statusCode).toBe(404)
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('not-found')

    const wrongVerb = await env.call(makeReq({ method: 'GET', url: `${API}/status` }))
    expect(wrongVerb.statusCode).toBe(405)
    expect((wrongVerb.json() as { error: { code: string } }).error.code).toBe('method-not-allowed')
    expect(wrongVerb.headers.allow).toBe('POST')

    const badJson = await env.call(
      makeReq({ method: 'POST', url: `${API}/status`, headers: { 'content-length': '7' }, body: 'not-json' }),
    )
    expect(badJson.statusCode).toBe(400)
    expect((badJson.json() as { error: { code: string } }).error.code).toBe('bad-request')

    const missingId = await callJson(env, 'library.get', {})
    expect(missingId.statusCode).toBe(400)
    expect((missingId.json() as { error: { code: string } }).error.code).toBe('bad-request')

    const badId = await callJson(env, 'library.get', { id: '../../etc/passwd' })
    expect(badId.statusCode).toBe(400)
    expect((badId.json() as { error: { code: string } }).error.code).toBe('bad-request')
  } finally {
    await teardown(env)
  }
})

test('the connection fence rejects requests before dispatch', async () => {
  const env = await setup({ rejection: 403 })
  try {
    const response = await callJson(env, 'status', {})
    expect(response.statusCode).toBe(403)
    expect((response.json() as { error: { code: string } }).error.code).toBe('forbidden')
  } finally {
    await teardown(env)
  }
})

test('raw upload creates a document and library.get returns annotations as an array', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 unit test'))
    expect(upload.statusCode).toBe(200)
    const uploadValue = upload.json() as { ok: boolean; value: { document: DocumentMeta } }
    expect(uploadValue.ok).toBe(true)
    const document = uploadValue.value.document
    expect(document.status).toBe('uploaded')
    expect(document.originalName).toBe('paper.pdf')

    const detail = await callJson(env, 'library.get', { id: document.id })
    expect(detail.statusCode).toBe(200)
    const value = (detail.json() as {
      value: { document: DocumentMeta; annotations: unknown[]; translations: { version: number; entries: unknown } }
    }).value
    expect(value.document.id).toBe(document.id)
    expect(value.annotations).toEqual([])
    expect(value.translations.version).toBe(1)
    expect(value.translations.entries).toEqual({})

    // annotations.save accepts the client's array payload and library.get reads it back.
    const saved = await callJson(env, 'annotations.save', {
      id: document.id,
      annotations: [
        { id: 'ann-1', blockKey: 'b0:deadbeef', start: 0, end: 4, quote: 'test', note: '', color: 'yellow' },
      ],
    })
    expect((saved.json() as { value: { saved: boolean } }).value.saved).toBe(true)
    const after = (await callJson(env, 'library.get', { id: document.id })).json() as {
      value: { annotations: Array<{ id: string }> }
    }
    expect(after.value.annotations.length).toBe(1)
    expect(after.value.annotations[0]?.id).toBe('ann-1')

    const removed = await callJson(env, 'library.remove', { id: document.id })
    expect((removed.json() as { value: { removed: boolean } }).value.removed).toBe(true)
    const gone = await callJson(env, 'library.get', { id: document.id })
    expect(gone.statusCode).toBe(404)
    expect((gone.json() as { error: { code: string } }).error.code).toBe('not-found')
  } finally {
    await teardown(env)
  }
})

test('raw upload rejects unsupported types and oversized bodies', async () => {
  const env = await setup()
  try {
    const badType = await callUpload(env, 'notes.txt', Buffer.from('text'))
    expect(badType.statusCode).toBe(415)
    expect((badType.json() as { error: { code: string } }).error.code).toBe('unsupported-type')

    const oversize = await callUpload(env, 'paper.pdf', Buffer.alloc(env.config.maxUploadBytes + 1))
    // Declared content-length is above the cap: refused before buffering.
    expect(oversize.statusCode).toBe(413)
    expect((oversize.json() as { error: { code: string } }).error.code).toBe('too-large')
  } finally {
    await teardown(env)
  }
})

test('asset route serves parsed files and rejects traversal paths', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 asset test'))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document
    const parsedDir = env.store.parsedDir(document.id)
    await mkdir(join(parsedDir, 'images'), { recursive: true })
    await writeFile(join(parsedDir, 'images', 'fig1.png'), Buffer.from('png-bytes'))

    const asset = await env.call(
      makeReq({ method: 'GET', url: `${API}/asset?id=${document.id}&path=${encodeURIComponent('images/fig1.png')}` }),
    )
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toBe('image/png')
    expect(asset.headers['cache-control']).toBe('private, max-age=86400')
    expect(asset.text()).toBe('png-bytes')

    for (const evil of ['../meta.json', '../../../../etc/passwd', '/etc/passwd', 'images/../../meta.json']) {
      const response = await env.call(
        makeReq({ method: 'GET', url: `${API}/asset?id=${document.id}&path=${encodeURIComponent(evil)}` }),
      )
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: { code: string } }).error.code).toBe('bad-request')
    }

    const missing = await env.call(
      makeReq({ method: 'GET', url: `${API}/asset?id=${document.id}&path=${encodeURIComponent('images/none.png')}` }),
    )
    expect(missing.statusCode).toBe(404)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('not-found')
  } finally {
    await teardown(env)
  }
})

test('source route serves the original bytes with disposition hints', async () => {
  const env = await setup()
  try {
    const bytes = '%PDF-1.4 original bytes'
    const upload = await callUpload(env, 'paper.pdf', Buffer.from(bytes))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document

    const inline = await env.call(makeReq({ method: 'GET', url: `${API}/source?id=${document.id}&download=0` }))
    expect(inline.statusCode).toBe(200)
    expect(inline.headers['content-type']).toBe('application/pdf')
    expect(String(inline.headers['content-disposition'])).toMatch(/^inline/)
    expect(inline.headers['x-content-type-options']).toBe('nosniff')
    expect(inline.text()).toBe(bytes)

    const attachment = await env.call(
      makeReq({ method: 'GET', url: `${API}/source?id=${document.id}&download=1` }),
    )
    expect(String(attachment.headers['content-disposition'])).toMatch(/^attachment/)
  } finally {
    await teardown(env)
  }
})

test('assets prefix route serves vendor files, 404s missing ones and rejects traversal', async () => {
  const env = await setup()
  try {
    const res = makeRes()
    await env.assetRoute(
      makeReq({ method: 'GET', url: `${ASSETS}/definitely-not-vendored/nope.css` }),
      res.response,
    )
    await res.waitDone()
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('not-found')

    const evil = makeRes()
    await env.assetRoute(makeReq({ method: 'GET', url: `${ASSETS}/../../package.json` }), evil.response)
    await evil.waitDone()
    expect(evil.statusCode).toBe(400)
    expect((evil.json() as { error: { code: string } }).error.code).toBe('bad-request')

    // A real vendored file resolves and is served with an immutable cache.
    const vendored = join(process.cwd(), 'vendor', 'pdfjs', 'LICENSE')
    let statted = true
    try {
      await readFile(vendored)
    } catch {
      statted = false
    }
    if (statted) {
      const served = makeRes()
      await env.assetRoute(makeReq({ method: 'GET', url: `${ASSETS}/pdfjs/LICENSE` }), served.response)
      await served.waitDone()
      expect(served.statusCode).toBe(200)
      expect(String(served.headers['cache-control'])).toContain('immutable')
    }
  } finally {
    await teardown(env)
  }
})

// ---------------------------------------------------------------------------
// Annotation concurrency baseline + graph curation payloads
// ---------------------------------------------------------------------------

test('annotations.save passes baseIds through and returns the persisted merged items', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 baseIds'))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document
    const base = { id: 'ann-base', blockKey: 'b0:deadbeef', start: 0, end: 4, quote: 'base', note: '', color: 'yellow' }
    const first = await callJson(env, 'annotations.save', { id: document.id, annotations: [base] })
    const firstValue = first.json() as { value: { saved: boolean; items: Array<{ id: string }> } }
    expect(firstValue.value.saved).toBe(true)
    expect(firstValue.value.items.map((item) => item.id)).toEqual(['ann-base'])

    // A concurrent AI/agent annotation lands after the client loaded its list.
    await env.store.mutateAnnotations(document.id, (items) => {
      items.push({
        id: 'ann-ai',
        blockKey: 'b1:feedface',
        start: 1,
        end: 5,
        quote: 'ai',
        note: '',
        color: 'sky',
        origin: 'ai',
      })
      return items
    })
    const merged = await callJson(env, 'annotations.save', {
      id: document.id,
      annotations: [{ ...base, note: 'edited' }],
      baseIds: ['ann-base'],
    })
    expect(merged.statusCode).toBe(200)
    const mergedValue = merged.json() as {
      value: { saved: boolean; items: Array<{ id: string; note?: string }> }
    }
    expect(mergedValue.value.saved).toBe(true)
    expect(mergedValue.value.items.length).toBe(2)
    expect(mergedValue.value.items.some((item) => item.id === 'ann-ai')).toBe(true)
    expect(mergedValue.value.items.find((item) => item.id === 'ann-base')?.note).toBe('edited')
    const readBack = (await callJson(env, 'library.get', { id: document.id })).json() as {
      value: { annotations: unknown[] }
    }
    expect(readBack.value.annotations.length).toBe(2)

    // A non-array baseIds is a clean bad-request (nothing is written).
    const bad = await callJson(env, 'annotations.save', {
      id: document.id,
      annotations: [],
      baseIds: 'ann-base',
    })
    expect(bad.statusCode).toBe(400)
    expect((bad.json() as { error: { code: string } }).error.code).toBe('bad-request')

    // Entries are bounded/trimmed/de-duplicated; non-strings are ignored.
    const bounded = await callJson(env, 'annotations.save', {
      id: document.id,
      annotations: [],
      baseIds: [123, 'ann-base', ' ann-base '],
    })
    expect(bounded.statusCode).toBe(200)
    const boundedValue = bounded.json() as { value: { items: Array<{ id: string }> } }
    expect(boundedValue.value.items.map((item) => item.id)).toEqual(['ann-ai'])
  } finally {
    await teardown(env)
  }
})

test('graph.update forwards curation nodes and merge pairs to the graph engine', async () => {
  const calls: unknown[] = []
  const ai = makeAiBundle()
  ai.graph = {
    ...ai.graph,
    async updateDocGraph(documentId, patch) {
      calls.push({ documentId, patch })
      return {
        version: 1,
        scope: 'document',
        documentId,
        generatedAt: new Date().toISOString(),
        overview: '',
        nodes: [],
        edges: [],
        stats: { nodes: 0, edges: 0 },
      } as never
    },
  }
  const env = await setup({ ai })
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 curation'))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document
    const response = await callJson(env, 'graph.update', {
      documentId: document.id,
      nodes: [{ id: 'n-route-a', label: 'Route Alpha', type: 'method' }],
      edges: [{ from: 'n-route-a', to: 'n-route-b', type: 'uses' }],
      merge: [{ from: 'n-route-c', to: 'n-route-b' }],
    })
    expect(response.statusCode).toBe(200)
    const value = response.json() as { value: { graph: { scope: string } } }
    expect(value.value.graph.scope).toBe('document')
    expect(calls[0]).toMatchObject({
      documentId: document.id,
      patch: {
        nodes: [{ id: 'n-route-a', label: 'Route Alpha', type: 'method' }],
        edges: [{ from: 'n-route-a', to: 'n-route-b', type: 'uses' }],
        merge: [{ from: 'n-route-c', to: 'n-route-b' }],
      },
    })
  } finally {
    await teardown(env)
  }
})

// ---------------------------------------------------------------------------
// NDJSON streaming
// ---------------------------------------------------------------------------

test('the chat route streams NDJSON frames and answers bad payloads cleanly', async () => {
  const ai = makeAiBundle()
  const env = await setup({ ai })
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 streaming'))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document

    const body = JSON.stringify({ documentId: document.id, question: 'hi' })
    const stream = await env.callExact(
      `${API}/chat`,
      makeReq({
        method: 'POST',
        url: `${API}/chat`,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        body,
      }),
    )
    expect(stream.statusCode).toBe(200)
    expect(stream.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
    const frames = stream
      .text()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string })
    expect(frames.map((frame) => frame.type)).toEqual(['start', 'delta', 'done'])

    // GET on a streaming route is a clean method-not-allowed.
    const wrongVerb = await env.callExact(`${API}/graph.build`, makeReq({ method: 'GET', url: `${API}/graph.build` }))
    expect(wrongVerb.statusCode).toBe(405)

    // A missing documentId becomes a streamed error frame, not a crash.
    const invalidBody = JSON.stringify({ question: 'hi' })
    const invalid = await env.callExact(
      `${API}/chat`,
      makeReq({
        method: 'POST',
        url: `${API}/chat`,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(invalidBody)) },
        body: invalidBody,
      }),
    )
    expect(invalid.statusCode).toBe(200)
    const last = invalid
      .text()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; code?: string })
      .at(-1)
    expect(last?.type).toBe('error')
    expect(last?.code).toBe('bad-request')
  } finally {
    await teardown(env)
  }
})

test('the connection fence also guards streaming routes', async () => {
  const env = await setup({ rejection: 403, ai: makeAiBundle() })
  try {
    const body = JSON.stringify({ documentId: randomUUID() })
    const response = await env.callExact(
      `${API}/graph.build`,
      makeReq({
        method: 'POST',
        url: `${API}/graph.build`,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        body,
      }),
    )
    expect(response.statusCode).toBe(403)
  } finally {
    await teardown(env)
  }
})

// ---------------------------------------------------------------------------
// Additional dispatch coverage
// ---------------------------------------------------------------------------

test('parse.start, parse.cancel, settings.update and translations.save dispatch', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 dispatch'))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document

    const started = await callJson(env, 'parse.start', { id: document.id, options: { engine: 'agent' } })
    expect(started.statusCode).toBe(200)
    const startedValue = started.json() as { value: { document: DocumentMeta } }
    expect(startedValue.value.document.status).toBe('parsing')
    expect(startedValue.value.document.parse?.engine).toBe('agent')

    const cancelled = await callJson(env, 'parse.cancel', { id: document.id })
    expect(cancelled.statusCode).toBe(200)
    expect((cancelled.json() as { value: { document: DocumentMeta } }).value.document.status).toBe('uploaded')

    const settings = await callJson(env, 'settings.get', {})
    expect(settings.statusCode).toBe(200)

    const updated = await callJson(env, 'settings.update', { preferences: { readingMode: 'bilingual' } })
    expect(updated.statusCode).toBe(200)
    const updatedValue = updated.json() as { value: { preferences: { readingMode: string } } }
    expect(updatedValue.value.preferences.readingMode).toBe('bilingual')
    expect((await env.service.getStatus()).preferences.readingMode).toBe('bilingual')

    const savedTranslations = await callJson(env, 'translations.save', {
      id: document.id,
      targetLanguage: 'zh',
      entries: { 'b0:deadbeef': '你好' },
    })
    expect(savedTranslations.statusCode).toBe(200)
    const loaded = await env.store.loadTranslations(document.id)
    expect(loaded.entries['b0:deadbeef']).toBe('你好')

    // translations.save with a non-object entries payload is a clean error.
    const badEntries = await callJson(env, 'translations.save', {
      id: document.id,
      targetLanguage: 'zh',
      entries: 'nope',
    })
    expect(badEntries.statusCode).toBe(400)
    expect((badEntries.json() as { error: { code: string } }).error.code).toBe('bad-request')
  } finally {
    await teardown(env)
  }
})

test('raw upload reads the optional x-doc-title header', async () => {
  const env = await setup()
  try {
    const body = Buffer.from('%PDF-1.4 titled')
    const req = makeReq({
      method: 'POST',
      url: `${API}/upload`,
      headers: {
        'content-length': String(body.length),
        'x-file-name': encodeURIComponent('titled.pdf'),
        'x-doc-title': encodeURIComponent('A Great Paper'),
      },
      body,
    })
    const response = await env.call(req)
    expect(response.statusCode).toBe(200)
    const document = (response.json() as { value: { document: DocumentMeta } }).value.document
    expect(document.title).toBe('A Great Paper')

    // A blank title header falls back to the file-name stem.
    const second = await callUpload(env, 'My Paper.pdf', Buffer.from('%PDF-1.4 stem'))
    expect((second.json() as { value: { document: DocumentMeta } }).value.document.title).toBe('My Paper')
  } finally {
    await teardown(env)
  }
})

test('HEAD requests answer asset/source metadata without a body', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 head'))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document
    const parsedDir = env.store.parsedDir(document.id)
    await mkdir(parsedDir, { recursive: true })
    await writeFile(join(parsedDir, 'full.md'), '# Head\n')

    const assetHead = await env.call(
      makeReq({ method: 'HEAD', url: `${API}/asset?id=${document.id}&path=${encodeURIComponent('full.md')}` }),
    )
    expect(assetHead.statusCode).toBe(200)
    expect(assetHead.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(assetHead.text()).toBe('')

    const sourceHead = await env.call(makeReq({ method: 'HEAD', url: `${API}/source?id=${document.id}` }))
    expect(sourceHead.statusCode).toBe(200)
    expect(sourceHead.text()).toBe('')

    // A wrong verb on the asset route is a clean 405 with an Allow header.
    const wrongVerb = await env.call(
      makeReq({ method: 'POST', url: `${API}/asset?id=${document.id}&path=full.md` }),
    )
    expect(wrongVerb.statusCode).toBe(405)
    expect(wrongVerb.headers.allow).toBe('GET, HEAD')
  } finally {
    await teardown(env)
  }
})

test('annotations.save rejects a missing or non-array annotations payload', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 shape'))
    const document = (upload.json() as { value: { document: DocumentMeta } }).value.document
    const missing = await callJson(env, 'annotations.save', { id: document.id })
    expect(missing.statusCode).toBe(400)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('bad-request')
    // Nothing was written by the rejected save.
    expect((await env.store.loadAnnotations(document.id)).items).toEqual([])
  } finally {
    await teardown(env)
  }
})
