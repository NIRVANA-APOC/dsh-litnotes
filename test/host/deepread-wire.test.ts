/**
 * Wire tests for AI 精读 (`docs/AI-SPEC.md` §3.2/§5): the `deepread.get` JSON
 * envelope, the `${API_PREFIX}/deepread` NDJSON stream (frame order,
 * content-type, error frames, client-close abort), the lazy-bundle degraded
 * fallback and the `library_deepread` agent tool.
 *
 * The close-reading engine itself is faked at the AI-bundle seam
 * (`AiServicesApi.deepread`); the service, the routes and the agent tool under
 * test are the real implementations.
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, test } from 'vitest'
import { expect } from 'vitest'

import { createAiServices, type AiServicesDeps } from '../../src/host/ai/index.ts'
import { resolveConfig } from '../../src/host/config.ts'
import type { AiServicesApi, ParseManagerApi, ResolvedConfig, ServiceApi, StoreApi } from '../../src/host/contracts.ts'
import type { ToolDefinition, ToolsService, WebRoute } from '../../src/host/host-services.ts'
import { normalizeParseOptions } from '../../src/host/parse/mineru.ts'
import { registerRoutes } from '../../src/host/routes.ts'
import { createService } from '../../src/host/service.ts'
import { createStore } from '../../src/host/store/index.ts'
import { LIBRARY_TOOL_NAMES, registerLibraryTools } from '../../src/host/agent-tools.ts'
import type { DeepReadFrame, DeepReadRecord, DocumentMeta, ParseState } from '../../src/shared/model.ts'
import { createFakeDefaultModel, createFakeLlm } from '../helpers/fake-llm.ts'

const API = '/dsh-litnotes/api'

/** Temporary stores created by the current test. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete persisted deep-read record for one document. */
function makeRecord(documentId: string): DeepReadRecord {
  return {
    version: 1,
    documentId,
    generatedAt: '2026-11-08T00:00:00.000Z',
    language: 'zh',
    model: { provider: 'fake-provider', model: 'fake-model' },
    promptVersion: 1,
    report: {
      tldr: ['论文提出清单驱动的执行层约束，实验覆盖三个基准。'],
      problem: { label: '研究问题', detail: '代理能力如何被安全地约束。', blockKeys: ['b0:deadbeef'] },
      gap: { label: '研究空白', detail: '提示层约束不可验证。', blockKeys: ['b1:feedface'] },
      contributions: [
        { label: '核心贡献', detail: '执行层能力清单。', blockKeys: ['b0:deadbeef'], evidence: 'strong' },
      ],
      method: [{ label: '方法', detail: '清单编译为执行策略。', blockKeys: ['b0:deadbeef'] }],
      evaluation: [{ label: '评估', detail: '三个基准与两个基线。', blockKeys: ['b2:0badc0de'] }],
      findings: [{ label: '发现', detail: '违规执行下降 80%。', blockKeys: ['b2:0badc0de'] }],
      limitations: [{ label: '局限', detail: '清单自动生成误差。', blockKeys: ['b3:12345678'] }],
      openQuestions: [{ label: '开放问题', detail: '清单的组合语义未定义。', blockKeys: [] }],
      argumentMap: [{ from: '提示注入', to: '执行边界', relation: 'motivates' }],
      glossary: [{ term: 'manifest', definition: '能力声明清单。', blockKeys: ['b0:deadbeef'] }],
      readingPath: ['先读方法，再读评估。'],
      verdict: { strengths: ['机制清晰'], weaknesses: ['评估面窄'], confidence: 'medium' },
    },
    highlights: [
      {
        annotationId: 'ann-deep-1',
        blockKey: 'b0:deadbeef',
        quote: 'The manifest declares the capabilities the agent may touch.',
        start: 0,
        end: 60,
        page: 2,
        aspect: 'method',
        note: '关键方法定义：能力清单在执行层被强制，而不是只在提示层声明。',
        importance: 5,
        section: 'Method',
        kind: 'method',
      },
      {
        annotationId: 'ann-deep-2',
        blockKey: 'b2:0badc0de',
        quote: 'Violating executions dropped by 80.9% with a 3.1% overhead.',
        start: 4,
        end: 64,
        page: 7,
        aspect: 'result',
        note: '决定性数字：约束带来的开销只有 3.1%，因此不是纸上机制。',
        importance: 4,
        section: 'Results',
        kind: 'result',
      },
    ],
    stats: {
      sections: 6,
      sectionsRead: 5,
      chunks: 7,
      chunksRead: 6,
      candidates: 12,
      kept: 2,
      skipped: 10,
      coverage: 0.83,
      calls: 8,
      durationMs: 120000,
      inputTokens: 48000,
      outputTokens: 6200,
      truncated: false,
    },
  }
}

/** Mutable fake deep-read engine state (frames are recorded per call). */
interface DeepReadFakeState {
  record: DeepReadRecord | null
  getCalls: string[]
  runCalls: Array<{ documentId: string; options: { signal: AbortSignal; force?: boolean; language?: string } }>
  /** Overrides the default frame sequence (used by the abort/error tests). */
  frames?: (
    documentId: string,
    options: { signal: AbortSignal; force?: boolean; language?: string },
  ) => AsyncGenerator<DeepReadFrame>
}

/** A stateful fake of the deep-read engine. */
function makeDeepreadStub(state: DeepReadFakeState): AiServicesApi['deepread'] {
  return {
    async get(documentId) {
      state.getCalls.push(documentId)
      return state.record
    },
    run(documentId, options) {
      state.runCalls.push({ documentId, options })
      if (state.frames !== undefined) return state.frames(documentId, options)
      return defaultFrames(documentId, options, state.record)
    },
  }
}

/** The default frame sequence of one cached/replayed run. */
async function* defaultFrames(
  documentId: string,
  options: { signal: AbortSignal; force?: boolean; language?: string },
  record: DeepReadRecord | null,
): AsyncGenerator<DeepReadFrame> {
  yield {
    type: 'start',
    model: { provider: 'fake-provider', model: 'fake-model' },
    language: options.language ?? 'en',
  }
  yield { type: 'progress', phase: 'mapping', done: 0, total: 1 }
  yield { type: 'progress', phase: 'reading', done: 1, total: 2, section: 'Method' }
  if (record !== null) {
    const stored: DeepReadRecord = { ...record, documentId }
    yield { type: 'report', record: stored }
    yield { type: 'annotations', created: stored.highlights.length, highlights: stored.highlights }
    yield {
      type: 'usage',
      usage: { inputTokens: stored.stats.inputTokens, outputTokens: stored.stats.outputTokens },
    }
  }
  yield { type: 'done' }
}

/** A fresh fake-engine state. */
function makeDeepReadState(record: DeepReadRecord | null = null): DeepReadFakeState {
  return { record, getCalls: [], runCalls: [] }
}

/** A complete AI bundle whose deep-read engine is the fake above. */
function makeAiBundle(deepread: AiServicesApi['deepread'], available = true): AiServicesApi {
  const unused = async (): Promise<never> => {
    throw new Error('not used by the deep-read wire tests')
  }
  return {
    llm: {
      available: () => available,
      route: () => (available ? { provider: 'fake-provider', model: 'fake-model' } : null),
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
      history: unused,
      clear: unused,
      stream: async function* () {},
    },
    graph: {
      docGraph: unused,
      buildDocGraph: async function* () {},
      mergeDocKnowledge: unused,
      updateDocGraph: unused,
      libraryGraph: unused,
      rebuildLibraryGraph: async function* () {},
    },
    deepread,
    available,
    version: '0.0.0-test',
  }
}

// ---------------------------------------------------------------------------
// Host request/response fakes (same seams as routes.test.ts, kept local)
// ---------------------------------------------------------------------------

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
  let done = false
  res.on('finish', () => {
    done = true
  })
  return {
    response: res as unknown as ServerResponse,
    get statusCode() {
      return Number(res.statusCode)
    },
    set statusCode(value: number) {
      res.statusCode = value
    },
    headers,
    text: () => Buffer.concat(chunks).toString('utf8'),
    json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
    waitDone: () => (done ? Promise.resolve() : once(res, 'finish').then(() => undefined)),
  }
}

/** Parse an NDJSON stream body into typed frames. */
function ndjsonFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Extract the handler of one registered route. */
function handlerOf(
  route: WebRoute | undefined,
): (req: IncomingMessage, res: ServerResponse) => void | Promise<void> {
  if (route === undefined || !('handler' in route)) throw new Error('route not registered')
  return route.handler
}

/** A fake parse manager that only flips the document status. */
function makeManager(store: ReturnType<typeof createStore>): ParseManagerApi {
  return {
    async start(id: string): Promise<DocumentMeta> {
      return store.update(id, { status: 'parsing', error: null, parse: {} as Partial<ParseState> })
    },
    async cancel(id: string): Promise<DocumentMeta> {
      return store.update(id, { status: 'uploaded', error: null, parse: { phase: null } })
    },
    resume: () => {},
    async dispose() {},
  }
}

/** A routed stack over a temp library with a fake AI bundle (or none). */
async function setup(options: { ai?: AiServicesApi } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-deepread-'))
  const config = resolveConfig({ dataDir, apiBase: 'https://api.mineru.test' })
  const store = createStore({ dataDir })
  cleanups.push(async () => {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })
  await store.init()
  const ai = options.ai
  const service: ServiceApi = createService({
    store,
    manager: makeManager(store),
    config,
    logger: { warn() {} },
    hostVersion: '0.1.0+host',
    getCredentials: () => undefined,
    getTranslator: () => undefined,
    getLlm: () => undefined,
    getDefaultModel: () => undefined,
    getAi: ai === undefined ? undefined : async () => ai,
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
    connection: { requestRejection: () => undefined },
  }
  const dispose = registerRoutes({ ctx, service, store, config, logger: { warn() {} } })
  const route = handlerOf(routes.find((entry) => entry.path === API && entry.kind === 'prefix'))
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
  const addParsedDocument = async (markdown: string): Promise<DocumentMeta> => {
    const id = randomUUID()
    const tempPath = store.newTempPath(id)
    await writeFile(tempPath, '%PDF-1.4 deep read')
    await store.createFromFile({ id, tempPath, originalName: 'paper.pdf' })
    const parsedDir = store.parsedDir(id)
    await mkdir(parsedDir, { recursive: true })
    await writeFile(join(parsedDir, 'full.md'), markdown)
    return store.update(id, { status: 'parsed' })
  }
  return { dataDir, config, store, service, routes, call, callExact, addParsedDocument, dispose }
}

/** POST one JSON API method through the routed stack. */
async function callJson(env: Awaited<ReturnType<typeof setup>>, method: string, payload: unknown) {
  const body = JSON.stringify(payload)
  const req = makeReq({
    method: 'POST',
    url: `${API}/${method}`,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  })
  return env.call(req)
}

/** POST one NDJSON streaming request through the routed stack. */
async function callStream(
  env: Awaited<ReturnType<typeof setup>>,
  path: string,
  payload: unknown,
): Promise<FakeResponse> {
  const body = JSON.stringify(payload)
  return env.callExact(
    path,
    makeReq({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    }),
  )
}

// ---------------------------------------------------------------------------
// deepread.get (JSON envelope)
// ---------------------------------------------------------------------------

test('deepread.get returns the persisted record and validates documentId', async () => {
  const state = makeDeepReadState(makeRecord('placeholder'))
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n\nBody.\n')
    state.record = makeRecord(document.id)

    const response = await callJson(env, 'deepread.get', { documentId: document.id })
    expect(response.statusCode).toBe(200)
    const envelope = response.json() as { ok: boolean; value: { record: DeepReadRecord } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.record.documentId).toBe(document.id)
    expect(envelope.value.record.report.tldr.length).toBe(1)
    expect(envelope.value.record.highlights[0]?.blockKey).toBe('b0:deadbeef')
    expect(state.getCalls).toEqual([document.id])

    // A never-deep-read document answers `{ record: null }`.
    state.record = null
    const empty = await callJson(env, 'deepread.get', { documentId: document.id })
    expect(empty.statusCode).toBe(200)
    expect((empty.json() as { value: { record: unknown } }).value.record).toBeNull()

    const missing = await callJson(env, 'deepread.get', {})
    expect(missing.statusCode).toBe(400)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('bad-request')

    const unknown = await callJson(env, 'deepread.get', { documentId: randomUUID() })
    expect(unknown.statusCode).toBe(404)
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('not-found')
  } finally {
    env.dispose()
  }
})

test('deepread.get answers ai-unavailable without an AI bundle (read-only degrade)', async () => {
  const env = await setup()
  try {
    const document = await env.addParsedDocument('# Paper\n')
    const response = await callJson(env, 'deepread.get', { documentId: document.id })
    expect(response.statusCode).toBe(503)
    expect((response.json() as { error: { code: string } }).error.code).toBe('ai-unavailable')
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// deepread stream route
// ---------------------------------------------------------------------------

test('the deepread route streams NDJSON frames in order with the documented content type', async () => {
  const state = makeDeepReadState(null)
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n\nBody.\n')
    state.record = makeRecord(document.id)
    const response = await callStream(env, `${API}/deepread`, { documentId: document.id })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
    const frames = ndjsonFrames(response.text())
    expect(frames.map((frame) => frame.type)).toEqual([
      'start',
      'progress',
      'progress',
      'report',
      'annotations',
      'usage',
      'done',
    ])
    const report = frames.find((frame) => frame.type === 'report') as { record: DeepReadRecord }
    expect(report.record.documentId).toBe(document.id)
    expect(report.record.highlights.length).toBe(2)
    const annotations = frames.find((frame) => frame.type === 'annotations') as {
      created: number
      highlights: unknown[]
    }
    expect(annotations.created).toBe(2)
    expect(annotations.highlights.length).toBe(2)

    // The service forwards the validated document id and normalizes the flags.
    expect(state.runCalls.length).toBe(1)
    expect(state.runCalls[0]?.documentId).toBe(document.id)
    expect(state.runCalls[0]?.options.force).toBe(false)
    expect(state.runCalls[0]?.options.language).toBeUndefined()
    expect(state.runCalls[0]?.options.signal).toBeInstanceOf(AbortSignal)
  } finally {
    env.dispose()
  }
})

test('the deepread route normalizes force and the reader language id', async () => {
  const state = makeDeepReadState(null)
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n')
    let response = await callStream(env, `${API}/deepread`, {
      documentId: document.id,
      force: true,
      language: ' ZH-Hant ',
    })
    expect(response.statusCode).toBe(200)
    expect(state.runCalls[0]?.options.force).toBe(true)
    expect(state.runCalls[0]?.options.language).toBe('zh-hant')

    // An invalid language id is dropped (the engine keeps its default `en`).
    response = await callStream(env, `${API}/deepread`, {
      documentId: document.id,
      force: 'yes',
      language: 'not a language!',
    })
    expect(response.statusCode).toBe(200)
    expect(state.runCalls[1]?.options.force).toBe(false)
    expect(state.runCalls[1]?.options.language).toBeUndefined()
  } finally {
    env.dispose()
  }
})

test('the deepread route maps bad payloads and missing engines to error frames', async () => {
  const state = makeDeepReadState(null)
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    // Missing documentId becomes a streamed bad-request frame, not a crash.
    const invalid = await callStream(env, `${API}/deepread`, {})
    expect(invalid.statusCode).toBe(200)
    const frames = ndjsonFrames(invalid.text())
    const last = frames.at(-1) as { type: string; code?: string }
    expect(last.type).toBe('error')
    expect(last.code).toBe('bad-request')

    // A wrong verb is a clean 405.
    const wrongVerb = await env.callExact(
      `${API}/deepread`,
      makeReq({ method: 'GET', url: `${API}/deepread` }),
    )
    expect(wrongVerb.statusCode).toBe(405)
  } finally {
    env.dispose()
  }

  // No AI bundle at all: the model-requiring stream answers llm-unavailable.
  const bareEnv = await setup()
  try {
    const document = await bareEnv.addParsedDocument('# Paper\n')
    const response = await callStream(bareEnv, `${API}/deepread`, { documentId: document.id })
    expect(response.statusCode).toBe(200)
    const last = ndjsonFrames(response.text()).at(-1) as { type: string; code?: string }
    expect(last.type).toBe('error')
    expect(last.code).toBe('ai-unavailable')
  } finally {
    bareEnv.dispose()
  }
})

test('a client disconnect aborts the deep-read run and ends the stream', async () => {
  const state = makeDeepReadState(null)
  let started: () => void = () => {}
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  let aborted = false
  state.frames = async function* frames(
    _documentId: string,
    options: { signal: AbortSignal },
  ): AsyncGenerator<DeepReadFrame> {
    yield { type: 'progress', phase: 'mapping', done: 0, total: 1 }
    started()
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve()
      else options.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    aborted = true
    yield { type: 'done' }
  }
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n')
    const body = JSON.stringify({ documentId: document.id })
    const req = makeReq({
      method: 'POST',
      url: `${API}/deepread`,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    })
    const res = makeRes()
    const running = handlerOf(
      env.routes.find((entry) => entry.kind === 'exact' && entry.path === `${API}/deepread`),
    )(req, res.response)
    await began
    // The client goes away mid-run: the route aborts the engine signal.
    req.emit('close')
    await running
    await res.waitDone()
    expect(aborted).toBe(true)
    expect(state.runCalls[0]?.options.signal.aborted).toBe(true)
    const frames = ndjsonFrames(res.text())
    expect(frames.map((frame) => frame.type)).toEqual(['progress'])
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// Service facade (direct)
// ---------------------------------------------------------------------------

test('deepReadRecord requires the document and deepReadFrames requires a model route', async () => {
  const state = makeDeepReadState(makeRecord('placeholder'))
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n')
    state.record = makeRecord(document.id)
    expect(await env.service.deepReadRecord(document.id)).toEqual({ record: state.record })
    await expect(env.service.deepReadRecord(randomUUID())).rejects.toMatchObject({ code: 'not-found' })

    // The stream validates the document before opening the engine.
    const missing = env.service.deepReadFrames({ documentId: randomUUID() }, new AbortController().signal)
    await expect(missing.next()).rejects.toMatchObject({ code: 'not-found' })
    // A run with a valid document reaches the engine unchanged.
    const iterator = env.service.deepReadFrames({ documentId: document.id }, new AbortController().signal)
    const first = await iterator.next()
    expect((first.value as DeepReadFrame).type).toBe('start')
    await iterator.return(undefined)
  } finally {
    env.dispose()
  }

  // No AI bundle: the read path degrades, the stream needs a model.
  const bareEnv = await setup()
  try {
    const document = await bareEnv.addParsedDocument('# Paper\n')
    await expect(bareEnv.service.deepReadRecord(document.id)).rejects.toMatchObject({
      code: 'ai-unavailable',
    })
    const stream = bareEnv.service.deepReadFrames({ documentId: document.id }, new AbortController().signal)
    await expect(stream.next()).rejects.toMatchObject({ code: 'ai-unavailable' })
  } finally {
    bareEnv.dispose()
  }

  // A bundle that is not model-available refuses to run the workflow.
  const offlineEnv = await setup({ ai: makeAiBundle(makeDeepreadStub(makeDeepReadState(null)), false) })
  try {
    const document = await offlineEnv.addParsedDocument('# Paper\n')
    const stream = offlineEnv.service.deepReadFrames(
      { documentId: document.id, force: true },
      new AbortController().signal,
    )
    await expect(stream.next()).rejects.toMatchObject({ code: 'ai-unavailable' })
  } finally {
    offlineEnv.dispose()
  }
})

// ---------------------------------------------------------------------------
// Lazy bundle: AiServicesApi.deepread + degraded fallback
// ---------------------------------------------------------------------------

/** Minimal resolved Host config for the lazy bundle. */
function makeConfig(): ResolvedConfig {
  return {
    dataDir: '/tmp/litnotes-deepread-test',
    apiBase: '/dsh-litnotes/api',
    maxUploadBytes: 1000,
    maxConcurrentParses: 1,
    pollIntervalMs: 10,
    parseTimeoutMs: 1000,
    toolMaxChars: 1000,
    ai: {
      provider: '',
      model: '',
      maxContextChars: 9000,
      historyTurns: 6,
      answerMaxTokens: 1024,
      graphMaxTokens: 3000,
      graphSummaryChars: 4000,
      maxAnnotationsPerAnswer: 5,
      reasoningEffort: 'low',
      maxGraphChunks: 12,
      maxGraphSourceChars: 160000,
      entailmentCheck: true,
      entailmentMaxTokens: 600,
      deepReadMaxChunks: 24,
      deepReadMaxSourceChars: 240000,
      deepReadMaxAnnotations: 24,
      deepReadMaxTokens: 2400,
      deepReadSynthesisChars: 14000,
      deepReadCoveragePass: true,
      deepReadJudge: true,
    },
    local: {
      enabled: false,
      maxPages: 1,
      maxPdfBytes: 1,
      maxTextBytes: 1,
      minCharsPerPage: 1,
      maxParagraphChars: 1,
      keepContentList: false,
      timeoutMs: 1,
      maxOfficePdfBytes: 1,
    },
    hostVersion: '1.0.0',
  }
}

/** A store stub exposing the aux API the bundle's factories validate. */
function makeBundleStore(): StoreApi {
  const store = {
    list: () => [],
    get: () => undefined,
    readMarkdown: async () => ({ markdown: '', contentList: null, pages: null }),
    loadAnnotations: async () => ({ version: 1 as const, items: [] }),
    saveAnnotations: async () => ({ version: 1 as const, items: [] }),
    mutateAnnotations: async () => ({ version: 1 as const, items: [] }),
    readAux: async () => undefined,
    writeAux: async () => undefined,
    readLibraryAux: async () => undefined,
    writeLibraryAux: async () => undefined,
    mutateAux: async (_id: string, _name: string, mutate: (current: unknown) => unknown) => mutate(undefined),
  }
  return store as unknown as StoreApi
}

/** Bundle deps with a fake Host llm + default model. */
function makeBundleDeps(store: StoreApi): AiServicesDeps {
  const fake = createFakeLlm()
  return {
    store,
    config: makeConfig(),
    logger: { warn(): void {}, debug(): void {}, error(): void {} },
    getLlm: () => fake,
    getDefaultModel: () => createFakeDefaultModel(),
    getTokenMeter: () => undefined,
    hostVersion: '1.0.0-test',
  }
}

test('the lazy bundle exposes deepread and degrades it when the engine cannot be built', async () => {
  const built = await createAiServices(makeBundleDeps(makeBundleStore())).ensure()
  expect(built.deepread).toBeDefined()
  expect(typeof built.deepread.get).toBe('function')
  expect(typeof built.deepread.run).toBe('function')

  // A store without the aux API cannot host deepread.json: the graph and the
  // close-reading engine degrade, while the rest of the bundle still builds.
  const deps = makeBundleDeps({ ...makeBundleStore(), readAux: undefined } as unknown as StoreApi)
  const degraded = await createAiServices(deps).ensure()
  expect(degraded.deepread).toBeDefined()
  await expect(degraded.deepread.get('doc-1')).rejects.toThrow(/精读服务不可用|Deep-read service unavailable/)
  const frames: DeepReadFrame[] = []
  for await (const frame of degraded.deepread.run('doc-1', { signal: new AbortController().signal })) {
    frames.push(frame)
  }
  expect(frames).toHaveLength(1)
  expect(frames[0]).toMatchObject({ type: 'error', code: 'llm-unavailable' })
  // The bundle itself still works (chat stays available).
  expect(typeof degraded.chat.stream).toBe('function')
  expect(degraded.available).toBe(true)
})

// ---------------------------------------------------------------------------
// Agent tool: library_deepread
// ---------------------------------------------------------------------------

/** Fake tool registry capturing definitions. */
function makeTools() {
  const definitions = new Map<string, ToolDefinition>()
  const disposed: string[] = []
  const tools: ToolsService = {
    register(definition: ToolDefinition) {
      definitions.set(definition.name, definition)
      return () => {
        disposed.push(definition.name)
        definitions.delete(definition.name)
      }
    },
  }
  return { definitions, disposed, tools }
}

/** Invoke one registered tool and render its bounded result. */
async function runTool(
  tools: ReturnType<typeof makeTools>,
  name: string,
  args: Record<string, unknown>,
  exec?: { signal?: AbortSignal },
): Promise<{ value: Record<string, unknown>; text: string }> {
  const definition = tools.definitions.get(name)
  if (definition === undefined) throw new Error(`tool ${name} not registered`)
  const value = (await definition.execute(args, exec)) as Record<string, unknown>
  const blocks = definition.output.render(args, value) as Array<{ type: string; text?: string }>
  return { value, text: blocks.map((block) => block.text ?? '').join('\n') }
}

test('library_deepread is registered as the eighth tool', () => {
  expect(LIBRARY_TOOL_NAMES).toContain('library_deepread')
  expect(LIBRARY_TOOL_NAMES.length).toBe(8)
  const tools = makeTools()
  const dispose = registerLibraryTools({
    tools: tools.tools,
    service: undefined as unknown as ServiceApi,
    config: makeConfig(),
  })
  // Registration does not call the service; the definition is present.
  const definition = tools.definitions.get('library_deepread')
  expect(definition).toBeTruthy()
  expect(definition?.parameters.required).toEqual(['action', 'documentId'])
  const action = (definition?.parameters.properties as Record<string, { enum?: string[] }>).action
  expect(action?.enum).toEqual(['get', 'run'])
  dispose()
})

test('library_deepread get returns the persisted record (and null when absent)', async () => {
  const state = makeDeepReadState(null)
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n\nBody.\n')
    state.record = makeRecord(document.id)
    const tools = makeTools()
    const dispose = registerLibraryTools({ tools: tools.tools, service: env.service, config: env.config })
    try {
      const get = await runTool(tools, 'library_deepread', { action: 'get', documentId: document.id })
      const record = get.value.record as Record<string, unknown>
      expect(record.documentId).toBe(document.id)
      expect(record.highlightCount).toBe(2)
      expect((record.highlights as Array<Record<string, unknown>>)[0]?.annotationId).toBe('ann-deep-1')
      const report = record.report as Record<string, unknown>
      expect((report.tldr as string[]).length).toBe(1)
      expect((report.contributions as unknown[]).length).toBe(1)
      // The rendered text is the JSON record with citation coordinates.
      expect(get.text).toContain('b0:deadbeef')
      expect(get.text).toContain('ann-deep-1')

      // A never-deep-read document yields record: null (not an error).
      state.record = null
      const empty = await runTool(tools, 'library_deepread', { action: 'get', documentId: document.id })
      expect(empty.value.record).toBeNull()
      expect(empty.text).toContain('null')
    } finally {
      dispose()
    }
  } finally {
    env.dispose()
  }
})

test('library_deepread run consumes the workflow with the exec signal and returns the report', async () => {
  const state = makeDeepReadState(null)
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n\nBody.\n')
    state.record = makeRecord(document.id)
    const tools = makeTools()
    const dispose = registerLibraryTools({ tools: tools.tools, service: env.service, config: env.config })
    try {
      const controller = new AbortController()
      const run = await runTool(
        tools,
        'library_deepread',
        { action: 'run', documentId: document.id, language: 'zh' },
        { signal: controller.signal },
      )
      const record = run.value.record as Record<string, unknown>
      expect(record.documentId).toBe(document.id)
      expect(run.value.progressFrames).toBe(2)
      const runCall = state.runCalls.at(-1)
      expect(runCall?.documentId).toBe(document.id)
      // The tool runs with the agent execution signal, not a private controller.
      expect(runCall?.options.signal).toBe(controller.signal)
      expect(runCall?.options.language).toBe('zh')
    } finally {
      dispose()
    }
  } finally {
    env.dispose()
  }
})

test('library_deepread surfaces streamed errors and rejects unknown actions', async () => {
  const state = makeDeepReadState(null)
  state.frames = async function* frames(): AsyncGenerator<DeepReadFrame> {
    yield { type: 'start', model: { provider: 'fake-provider', model: 'fake-model' }, language: 'en' }
    yield { type: 'error', code: 'llm-failed', message: '模型调用失败（Model call failed）' }
  }
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n')
    const tools = makeTools()
    const dispose = registerLibraryTools({ tools: tools.tools, service: env.service, config: env.config })
    try {
      await expect(
        runTool(tools, 'library_deepread', { action: 'run', documentId: document.id }),
      ).rejects.toThrow(/模型调用失败/)
      await expect(
        runTool(tools, 'library_deepread', { action: 'nope', documentId: document.id }),
      ).rejects.toThrow(/unknown action/)
      await expect(runTool(tools, 'library_deepread', {})).rejects.toThrow(/documentId/)
    } finally {
      dispose()
    }
  } finally {
    env.dispose()
  }
})

test('library_deepread renders a bounded result for a record with many highlights', async () => {
  const state = makeDeepReadState(null)
  const env = await setup({ ai: makeAiBundle(makeDeepreadStub(state)) })
  try {
    const document = await env.addParsedDocument('# Paper\n')
    const record = makeRecord(document.id)
    record.highlights = Array.from({ length: 120 }, (_, index) => ({
      annotationId: `ann-${index}`,
      blockKey: `b${index}:deadbeef`,
      quote: `Q${index} ${'quote '.repeat(40)}`,
      start: 0,
      end: 220,
      page: index + 1,
      aspect: 'method' as const,
      note: `N${index} ${'interpretation '.repeat(30)}`,
      importance: 3,
      section: 'Method',
      kind: 'method' as const,
    }))
    state.record = record
    const tools = makeTools()
    const dispose = registerLibraryTools({ tools: tools.tools, service: env.service, config: env.config })
    try {
      const get = await runTool(tools, 'library_deepread', { action: 'get', documentId: document.id })
      const value = get.value.record as Record<string, unknown>
      expect(value.highlightCount).toBe(120)
      expect(value.highlightsTruncated).toBe(true)
      expect((value.highlights as unknown[]).length).toBe(60)
      // The rendered tool result is bounded by the shared tool budget.
      expect(get.text.length).toBeLessThanOrEqual(16_000 + 100)
      expect(get.text).toContain('truncated')
    } finally {
      dispose()
    }
  } finally {
    env.dispose()
  }
})
