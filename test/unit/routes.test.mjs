/**
 * Unit tests for the Host HTTP routes (`lib/routes.js`): JSON envelopes, method
 * checks, the connection fence, raw upload → document creation, asset serving
 * with traversal rejection, and the client-facing `library.get` payload shape.
 *
 * The web server is faked at the `ctx.webServer.register` seam and requests are
 * driven through `Readable`/`Writable` streams, so no port is opened.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../../lib/config.js'
import { registerRoutes } from '../../lib/routes.js'
import { createService } from '../../lib/service.js'
import { createStore } from '../../lib/store.js'
import { createGraphService } from '../../lib/ai/graph.js'

const API = '/dsh-litnotes/api'
const ASSETS = '/dsh-litnotes/assets'

/** A fake request readable carrying `body`. */
function makeReq({ method = 'POST', url, headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

/** A fake response writable collecting headers and the body. */
function makeRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  res.statusCode = 0
  res.headers = {}
  res.headersSent = false
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value
    return res
  }
  res.getHeader = (name) => res.headers[String(name).toLowerCase()]
  res.done = false
  res.on('finish', () => {
    res.done = true
  })
  res.text = () => Buffer.concat(chunks).toString('utf8')
  res.json = () => JSON.parse(res.text())
  return res
}

/** Build a routed stack over a temp library. */
async function setup({ rejection, ai } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-routes-'))
  const config = resolveConfig({ dataDir, apiBase: 'https://api.mineru.test' })
  const store = createStore({ dataDir })
  await store.init()
  const manager = {
    async start() {
      throw new Error('manager.start should not be called by these tests')
    },
    async cancel() {
      throw new Error('manager.cancel should not be called by these tests')
    },
    async resume() {},
    async dispose() {},
  }
  const service = createServiceForTest(store, manager, config, ai)
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: {
      requestRejection: () => (rejection === undefined ? undefined : rejection),
    },
  }
  const dispose = registerRoutes({ ctx, service, store, config, logger: { warn() {} } })
  const route = routes.find((entry) => entry.path === API)
  const assetRoute = routes.find((entry) => entry.path === ASSETS)
  assert.ok(route, 'api route registered')
  assert.ok(assetRoute, 'assets route registered')
  const call = async (req) => {
    const res = makeRes()
    await route.handler(req, res)
    if (!res.done) await once(res, 'finish')
    return res
  }
  return { dataDir, config, store, manager, service, routes, route, assetRoute, call, dispose }
}

/** Create the service with a stub manager (and optionally an injected AI bundle). */
function createServiceForTest(store, manager, config, ai) {
  return createService({
    store,
    manager,
    config,
    logger: { warn() {} },
    hostVersion: '0.1.0+host',
    getCredentials: () => undefined,
    getTranslator: () => undefined,
    getLlm: () => undefined,
    getDefaultModel: () => undefined,
    getAi: ai === undefined ? undefined : () => ai,
  })
}

/** POST a JSON API call through the routed stack. */
async function callJson(env, method, payload) {
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
async function callUpload(env, fileName, bytes) {
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

/** Teardown a routed stack. */
async function teardown(env) {
  env.dispose()
  await env.store.dispose()
  await rm(env.dataDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------

test('JSON API dispatches to the service and answers ok envelopes', async () => {
  const env = await setup()
  try {
    const ping = await callJson(env, 'health.ping', { clientVersion: 'test-1', event: 'active' })
    assert.equal(ping.statusCode, 200)
    assert.equal(ping.json().ok, true)
    assert.equal(ping.json().value.hostVersion, '0.1.0+host')
    assert.equal(typeof ping.json().value.receivedAt, 'string')

    const status = await callJson(env, 'status', {})
    assert.equal(status.json().ok, true)
    assert.equal(status.json().value.counts.total, 0)
    assert.equal(status.json().value.tokenConfigured, false)

    const list = await callJson(env, 'library.list', {})
    assert.equal(list.json().ok, true)
    assert.deepEqual(list.json().value.documents, [])
  } finally {
    await teardown(env)
  }
})

test('unknown methods, wrong verbs and malformed payloads answer clean errors', async () => {
  const env = await setup()
  try {
    const unknown = await callJson(env, 'nope.nothing', {})
    assert.equal(unknown.statusCode, 404)
    assert.equal(unknown.json().error.code, 'not-found')

    const wrongVerb = await env.call(makeReq({ method: 'GET', url: `${API}/status` }))
    assert.equal(wrongVerb.statusCode, 405)
    assert.equal(wrongVerb.json().error.code, 'method-not-allowed')
    assert.equal(wrongVerb.headers.allow, 'POST')

    const badJson = await env.call(
      makeReq({
        method: 'POST',
        url: `${API}/status`,
        headers: { 'content-length': '7' },
        body: 'not-json',
      }),
    )
    assert.equal(badJson.statusCode, 400)
    assert.equal(badJson.json().error.code, 'bad-request')

    const missingId = await callJson(env, 'library.get', {})
    assert.equal(missingId.statusCode, 400)
    assert.equal(missingId.json().error.code, 'bad-request')

    const badId = await callJson(env, 'library.get', { id: '../../etc/passwd' })
    assert.equal(badId.statusCode, 400)
    assert.equal(badId.json().error.code, 'bad-request')
  } finally {
    await teardown(env)
  }
})

test('the connection fence rejects requests before dispatch', async () => {
  const env = await setup({ rejection: 403 })
  try {
    const response = await callJson(env, 'status', {})
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'forbidden')
  } finally {
    await teardown(env)
  }
})

test('raw upload creates a document and library.get returns annotations as an array', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 unit test'))
    assert.equal(upload.statusCode, 200)
    assert.equal(upload.json().ok, true)
    const document = upload.json().value.document
    assert.equal(document.status, 'uploaded')
    assert.equal(document.originalName, 'paper.pdf')

    const detail = await callJson(env, 'library.get', { id: document.id })
    assert.equal(detail.statusCode, 200)
    const value = detail.json().value
    assert.equal(value.document.id, document.id)
    assert.deepEqual(value.annotations, [], 'HTTP payload carries a plain Annotation[]')
    assert.equal(value.translations.version, 1)
    assert.deepEqual(value.translations.entries, {})

    // annotations.save accepts the client's array payload and library.get reads it back.
    const saved = await callJson(env, 'annotations.save', {
      id: document.id,
      annotations: [
        { id: 'ann-1', blockKey: 'b0:deadbeef', start: 0, end: 4, quote: 'test', note: '', color: 'yellow' },
      ],
    })
    assert.equal(saved.json().value.saved, true)
    const after = (await callJson(env, 'library.get', { id: document.id })).json().value
    assert.equal(after.annotations.length, 1)
    assert.equal(after.annotations[0].id, 'ann-1')

    const removed = await callJson(env, 'library.remove', { id: document.id })
    assert.equal(removed.json().value.removed, true)
    const gone = await callJson(env, 'library.get', { id: document.id })
    assert.equal(gone.statusCode, 404)
    assert.equal(gone.json().error.code, 'not-found')
  } finally {
    await teardown(env)
  }
})

test('raw upload rejects unsupported types and oversized bodies', async () => {
  const env = await setup()
  try {
    const badType = await callUpload(env, 'notes.txt', Buffer.from('text'))
    assert.equal(badType.statusCode, 415)
    assert.equal(badType.json().error.code, 'unsupported-type')

    const oversize = await callUpload(env, 'paper.pdf', Buffer.alloc(env.config.maxUploadBytes + 1))
    // Declared content-length is above the cap: refused before buffering.
    assert.equal(oversize.statusCode, 413)
    assert.equal(oversize.json().error.code, 'too-large')
  } finally {
    await teardown(env)
  }
})

test('asset route serves parsed files and rejects traversal paths', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 asset test'))
    const document = upload.json().value.document
    const parsedDir = env.store.parsedDir(document.id)
    await mkdir(join(parsedDir, 'images'), { recursive: true })
    await writeFile(join(parsedDir, 'images', 'fig1.png'), Buffer.from('png-bytes'))

    const asset = await env.call(
      makeReq({ method: 'GET', url: `${API}/asset?id=${document.id}&path=${encodeURIComponent('images/fig1.png')}` }),
    )
    assert.equal(asset.statusCode, 200)
    assert.equal(asset.headers['content-type'], 'image/png')
    assert.equal(asset.headers['cache-control'], 'private, max-age=86400')
    assert.equal(asset.text(), 'png-bytes')

    for (const evil of ['../meta.json', '../../../../etc/passwd', '/etc/passwd', 'images/../../meta.json']) {
      const response = await env.call(
        makeReq({ method: 'GET', url: `${API}/asset?id=${document.id}&path=${encodeURIComponent(evil)}` }),
      )
      assert.equal(response.statusCode, 400, `traversal ${evil} must be rejected`)
      assert.equal(response.json().error.code, 'bad-request')
    }

    const missing = await env.call(
      makeReq({ method: 'GET', url: `${API}/asset?id=${document.id}&path=${encodeURIComponent('images/none.png')}` }),
    )
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().error.code, 'not-found')
  } finally {
    await teardown(env)
  }
})

test('source route serves the original bytes with disposition hints', async () => {
  const env = await setup()
  try {
    const bytes = '%PDF-1.4 original bytes'
    const upload = await callUpload(env, 'paper.pdf', Buffer.from(bytes))
    const document = upload.json().value.document

    const inline = await env.call(
      makeReq({ method: 'GET', url: `${API}/source?id=${document.id}&download=0` }),
    )
    assert.equal(inline.statusCode, 200)
    assert.equal(inline.headers['content-type'], 'application/pdf')
    assert.match(inline.headers['content-disposition'], /^inline/)
    assert.equal(inline.headers['x-content-type-options'], 'nosniff')
    assert.equal(inline.text(), bytes)

    const attachment = await env.call(
      makeReq({ method: 'GET', url: `${API}/source?id=${document.id}&download=1` }),
    )
    assert.match(attachment.headers['content-disposition'], /^attachment/)
  } finally {
    await teardown(env)
  }
})

test('assets prefix route serves vendor files, 404s missing ones and rejects traversal', async () => {
  const env = await setup()
  try {
    const res = makeRes()
    await env.assetRoute.handler(
      makeReq({ method: 'GET', url: `${ASSETS}/definitely-not-vendored/nope.css` }),
      res,
    )
    if (!res.done) await once(res, 'finish')
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'not-found')

    const evil = makeRes()
    await env.assetRoute.handler(makeReq({ method: 'GET', url: `${ASSETS}/../../package.json` }), evil)
    if (!evil.done) await once(evil, 'finish')
    assert.equal(evil.statusCode, 400)
    assert.equal(evil.json().error.code, 'bad-request')
  } finally {
    await teardown(env)
  }
})

// ---------------------------------------------------------------------------
// Annotation concurrency baseline + graph curation payloads (PLAN C1/C3)
// ---------------------------------------------------------------------------

test('annotations.save passes baseIds through and returns the persisted merged items', async () => {
  const env = await setup()
  try {
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 baseIds'))
    const document = upload.json().value.document
    const base = { id: 'ann-base', blockKey: 'b0:deadbeef', start: 0, end: 4, quote: 'base', note: '', color: 'yellow' }
    const first = await callJson(env, 'annotations.save', { id: document.id, annotations: [base] })
    assert.equal(first.json().value.saved, true)
    assert.deepEqual(first.json().value.items.map((item) => item.id), ['ann-base'])

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
    assert.equal(merged.statusCode, 200)
    assert.equal(merged.json().value.saved, true)
    assert.equal(merged.json().value.items.length, 2, 'the concurrent AI annotation is returned')
    assert.ok(merged.json().value.items.some((item) => item.id === 'ann-ai'))
    assert.equal(merged.json().value.items.find((item) => item.id === 'ann-base').note, 'edited')
    const readBack = (await callJson(env, 'library.get', { id: document.id })).json().value
    assert.equal(readBack.annotations.length, 2, 'the returned items are the persisted ones')

    // A non-array baseIds is a clean bad-request (nothing is written).
    const bad = await callJson(env, 'annotations.save', {
      id: document.id,
      annotations: [],
      baseIds: 'ann-base',
    })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error.code, 'bad-request')

    // Entries are bounded/trimmed/de-duplicated; non-strings are ignored.
    const bounded = await callJson(env, 'annotations.save', {
      id: document.id,
      annotations: [],
      baseIds: [123, 'ann-base', ' ann-base '],
    })
    assert.equal(bounded.statusCode, 200)
    assert.deepEqual(bounded.json().value.items.map((item) => item.id), ['ann-ai'])
  } finally {
    await teardown(env)
  }
})

test('graph.update forwards curation nodes and merge pairs to the graph engine', async () => {
  const ai = { graph: null }
  const env = await setup({ ai })
  try {
    // The real graph engine over the real store; reads/updates never need the LLM.
    ai.graph = createGraphService({
      store: env.store,
      config: env.config,
      logger: { warn() {} },
      readMarkdown: (id) => env.store.readMarkdown(id),
    })
    const upload = await callUpload(env, 'paper.pdf', Buffer.from('%PDF-1.4 curation'))
    const document = upload.json().value.document

    const seeded = await callJson(env, 'graph.update', {
      documentId: document.id,
      nodes: [
        { id: 'n-route-a', type: 'method', label: 'Route Alpha', source: 'ai-summary', weight: 1 },
        { id: 'n-route-b', type: 'concept', label: 'Route Beta', source: 'ai-summary', weight: 2 },
        { id: 'n-route-c', type: 'finding', label: 'Route Gamma', source: 'ai-summary', weight: 1 },
      ],
      edges: [
        { id: 'e-route-1', from: 'n-route-a', to: 'n-route-c', type: 'uses', weight: 1, source: 'ai-summary' },
        { id: 'e-route-2', from: 'n-route-a', to: 'n-route-b', type: 'uses', weight: 4, source: 'ai-summary' },
      ],
    })
    assert.equal(seeded.statusCode, 200)
    const seededGraph = seeded.json().value.graph
    assert.equal(seededGraph.nodes.length, 3)
    assert.ok(seededGraph.nodes.every((node) => node.curated === true), 'API-created nodes are curated')

    const curated = await callJson(env, 'graph.update', {
      documentId: document.id,
      nodes: [
        { id: 'n-route-a', label: 'Route Alpha Renamed', pinned: true, position: { x: 12.34, y: 56.78 } },
        { id: 'n-route-b', pinned: true, position: { x: 900, y: 1200 } },
      ],
      merge: [{ from: 'n-route-c', into: 'n-route-b' }],
    })
    assert.equal(curated.statusCode, 200)
    const graph = curated.json().value.graph
    const alpha = graph.nodes.find((node) => node.id === 'n-route-a')
    assert.equal(alpha.label, 'Route Alpha Renamed')
    assert.equal(alpha.source, 'ai-summary', 'a curation patch never clobbers source')
    assert.equal(alpha.curated, true)
    assert.equal(alpha.pinned, true)
    assert.deepEqual(alpha.position, { x: 12.3, y: 56.8 }, 'position is clamped/rounded')
    const beta = graph.nodes.find((node) => node.id === 'n-route-b')
    assert.equal(beta.pinned, true)
    assert.deepEqual(beta.position, { x: 900, y: 1200 })
    assert.equal(graph.nodes.some((node) => node.id === 'n-route-c'), false, 'merged source node is removed')
    const uses = graph.edges.filter((edge) => edge.from === 'n-route-a' && edge.to === 'n-route-b' && edge.type === 'uses')
    assert.equal(uses.length, 1, 'rewired duplicate edges dedupe')
    assert.equal(uses[0].weight, 4, 'duplicate edges keep the max weight')
    assert.ok(
      graph.edges.every(
        (edge) => graph.nodes.some((node) => node.id === edge.from) && graph.nodes.some((node) => node.id === edge.to),
      ),
      'no dangling edges survive curation',
    )

    const readBack = await callJson(env, 'graph.doc', { documentId: document.id })
    const persisted = readBack.json().value.graph
    assert.equal(persisted.nodes.find((node) => node.id === 'n-route-a').label, 'Route Alpha Renamed')
    assert.equal(persisted.nodes.find((node) => node.id === 'n-route-b').pinned, true)
  } finally {
    await teardown(env)
  }
})
