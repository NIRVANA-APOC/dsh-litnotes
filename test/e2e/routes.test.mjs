/**
 * Web-route level tests: the JSON API envelope, the raw upload endpoint, the
 * source/asset routes (including path-traversal rejection — the route-level
 * companion to the ZIP traversal tests), and the connection fence.
 *
 * The routes are registered against a fake Cordis context exactly as index.js
 * does in production; the handlers are then invoked with fake req/res objects.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerRoutes } from '../../lib/routes.js'
import { createHarness, importDocument } from './harness.mjs'
import {
  createFakeCtx,
  createFakeRequest,
  createFakeResponse,
  figureBytes,
  pdfBytes,
  responseJson,
} from './helpers.mjs'

const API = '/dsh-litnotes/api'
const ASSETS = '/dsh-litnotes/assets'

/**
 * Register the real routes on a fake ctx and return a caller that runs one HTTP
 * request through a prefix handler.
 */
async function createRouteStack(t, options = {}) {
  const harness = await createHarness(t, { config: { maxUploadBytes: 64 * 1024, ...options.config } })
  const ctx = createFakeCtx(options.ctx)
  const dispose = registerRoutes({
    ctx,
    service: harness.service,
    store: harness.store,
    config: harness.config,
    logger: harness.logger,
  })
  t.after(() => dispose())
  const api = ctx.routes.find((route) => route.path === API)
  const assets = ctx.routes.find((route) => route.path === ASSETS)
  assert.ok(api, `${API} prefix route registered`)
  assert.ok(assets, `${ASSETS} prefix route registered`)

  /** @param {{ method?: string, url?: string, headers?: Record<string, string>, body?: string | Buffer }} request */
  async function call(route, request) {
    const req = createFakeRequest(request)
    const res = createFakeResponse()
    await route.handler(req, res)
    const text = Buffer.concat(res.state.chunks).toString('utf8')
    let body = null
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    return {
      status: res.state.statusCode,
      headers: res.state.headers,
      text,
      raw: Buffer.concat(res.state.chunks),
      body,
      res,
    }
  }

  return { harness, ctx, api, assets, call, callApi: (request) => call(api, request), callAssets: (request) => call(assets, request) }
}

/** Build a JSON POST for one API method. */
function jsonPost(method, payload) {
  const body = JSON.stringify(payload ?? {})
  return {
    method: 'POST',
    url: `${API}/${method}`,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  }
}

test('JSON API answers health.ping and status with ok envelopes', async (t) => {
  const stack = await createRouteStack(t)

  const ping = await stack.callApi(jsonPost('health.ping', { clientVersion: 'routes-test', event: 'active' }))
  assert.equal(ping.status, 200)
  assert.equal(ping.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(ping.body.ok, true)
  assert.equal(ping.body.value.ok, true)
  assert.equal(typeof ping.body.value.receivedAt, 'string')

  const status = await stack.callApi(jsonPost('status', {}))
  assert.equal(status.status, 200)
  assert.equal(status.body.ok, true)
  assert.equal(status.body.value.version, 'test+host')
  assert.deepEqual(status.body.value.counts, { total: 0, parsed: 0, parsing: 0, failed: 0 })
  assert.equal(status.body.value.configured.token, true)

  const list = await stack.callApi(jsonPost('library.list', {}))
  assert.deepEqual(list.body.value.documents, [])

  // The ping reached the diagnostics log.
  const diagnostics = await readFile(join(stack.harness.dataDir, 'diagnostics', 'client.log'), 'utf8')
  assert.match(diagnostics, /routes-test/)
})

test('JSON API rejects unknown methods, bad payloads and wrong HTTP verbs', async (t) => {
  const stack = await createRouteStack(t)

  const unknown = await stack.callApi(jsonPost('nope.method', {}))
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.ok, false)
  assert.equal(unknown.body.error.code, 'not-found')

  const missingId = await stack.callApi(jsonPost('library.get', {}))
  assert.equal(missingId.status, 400)
  assert.equal(missingId.body.error.code, 'bad-request')

  const badJson = await stack.callApi({
    method: 'POST',
    url: `${API}/status`,
    headers: { 'content-type': 'application/json', 'content-length': '1' },
    body: '{',
  })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.error.code, 'bad-request')

  const wrongVerb = await stack.callApi({ method: 'GET', url: `${API}/status` })
  assert.equal(wrongVerb.status, 405)
  assert.equal(wrongVerb.body.error.code, 'method-not-allowed')
  assert.equal(wrongVerb.headers.allow, 'POST')
})

test('raw upload creates a document from the request stream', async (t) => {
  const stack = await createRouteStack(t)
  const bytes = pdfBytes()
  const upload = await stack.callApi({
    method: 'POST',
    url: `${API}/upload`,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'x-file-name': encodeURIComponent('uploaded-paper.pdf'),
    },
    body: bytes,
  })
  assert.equal(upload.status, 200)
  assert.equal(upload.body.ok, true)
  const doc = upload.body.value.document
  assert.equal(doc.status, 'uploaded')
  assert.equal(doc.originalName, 'uploaded-paper.pdf')
  assert.equal(doc.size, bytes.length)
  assert.deepEqual(await readFile(await stack.harness.store.sourcePath(doc.id)), bytes)
})

test('raw upload enforces type and size limits and answers clean envelopes', async (t) => {
  const stack = await createRouteStack(t)

  const unsupported = await stack.callApi({
    method: 'POST',
    url: `${API}/upload`,
    headers: { 'content-length': '1', 'x-file-name': encodeURIComponent('malware.exe') },
    body: 'x',
  })
  assert.equal(unsupported.status, 415)
  assert.equal(unsupported.body.error.code, 'unsupported-type')

  const missingName = await stack.callApi({
    method: 'POST',
    url: `${API}/upload`,
    headers: { 'content-length': '1' },
    body: 'x',
  })
  assert.equal(missingName.status, 400)
  assert.equal(missingName.body.error.code, 'bad-request')

  const oversized = Buffer.alloc(70 * 1024, 0x41)
  const tooLarge = await stack.callApi({
    method: 'POST',
    url: `${API}/upload`,
    headers: {
      'content-length': String(oversized.length),
      'x-file-name': encodeURIComponent('big.pdf'),
    },
    body: oversized,
  })
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.body.error.code, 'too-large')
  assert.deepEqual(stack.harness.store.list(), [], 'no document was created')
})

test('asset route serves parsed images and rejects every traversal shape', async (t) => {
  const stack = await createRouteStack(t)
  const doc = await importDocument(stack.harness)
  const parsedDir = stack.harness.store.parsedDir(doc.id)
  await mkdir(join(parsedDir, 'images'), { recursive: true })
  await writeFile(join(parsedDir, 'images', 'fig1.svg'), figureBytes())
  await writeFile(join(parsedDir, 'full.md'), '# parsed')

  const good = await stack.callApi({
    method: 'GET',
    url: `${API}/asset?id=${doc.id}&path=${encodeURIComponent('images/fig1.svg')}`,
  })
  assert.equal(good.status, 200)
  assert.equal(good.headers['content-type'], 'image/svg+xml')
  assert.deepEqual(good.raw, figureBytes())

  const traversals = [
    '../meta.json',
    'images/../../meta.json',
    '/etc/passwd',
    'C:\\windows\\win.ini',
    'images/./../../meta.json',
    '',
  ]
  for (const path of traversals) {
    const response = await stack.callApi({
      method: 'GET',
      url: `${API}/asset?id=${doc.id}&path=${encodeURIComponent(path)}`,
    })
    assert.equal(response.status, 400, `traversal ${JSON.stringify(path)} must be rejected`)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'bad-request')
    assert.equal(response.text.includes('"schemaVersion"'), false, 'metadata must never be served')
  }

  // Double-encoded separators stay literal on disk, so they cannot escape either:
  // a 404 is the safe outcome (never a 200 serving library metadata).
  for (const encoded of ['..%2Fmeta.json', 'images%2F..%2F..%2Fmeta.json']) {
    const doubleEncoded = await stack.callApi({
      method: 'GET',
      url: `${API}/asset?id=${doc.id}&path=${encodeURIComponent(encoded)}`,
    })
    assert.notEqual(doubleEncoded.status, 200)
    assert.equal(doubleEncoded.text.includes('"schemaVersion"'), false)
  }

  const badId = await stack.callApi({ method: 'GET', url: `${API}/asset?id=not-a-uuid&path=full.md` })
  assert.equal(badId.status, 400)
  assert.equal(badId.body.error.code, 'bad-request')

  const missingFile = await stack.callApi({
    method: 'GET',
    url: `${API}/asset?id=${doc.id}&path=${encodeURIComponent('images/missing.png')}`,
  })
  assert.equal(missingFile.status, 404)
  assert.equal(missingFile.body.error.code, 'not-found')

  const wrongVerb = await stack.callApi({
    method: 'POST',
    url: `${API}/asset?id=${doc.id}&path=${encodeURIComponent('images/fig1.svg')}`,
  })
  assert.equal(wrongVerb.status, 405)
})

test('source route serves the original bytes (inline vs attachment)', async (t) => {
  const stack = await createRouteStack(t)
  const doc = await importDocument(stack.harness)
  const bytes = pdfBytes()

  const inline = await stack.callApi({ method: 'GET', url: `${API}/source?id=${doc.id}` })
  assert.equal(inline.status, 200)
  assert.equal(inline.headers['content-type'], 'application/pdf')
  assert.match(String(inline.headers['content-disposition']), /^inline;/)
  assert.deepEqual(inline.raw, bytes)

  const download = await stack.callApi({ method: 'GET', url: `${API}/source?id=${doc.id}&download=1` })
  assert.equal(download.status, 200)
  assert.match(String(download.headers['content-disposition']), /^attachment;/)
  assert.match(String(download.headers['content-disposition']), /sparse-route\.pdf/)

  const unknown = await stack.callApi({ method: 'GET', url: `${API}/source?id=${randomUUID()}` })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'not-found')
})

test('vendored assets route serves KaTeX files and refuses traversal', async (t) => {
  const stack = await createRouteStack(t)

  const katex = await stack.callAssets({ method: 'GET', url: `${ASSETS}/katex/katex.min.js` })
  assert.equal(katex.status, 200)
  assert.equal(katex.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.ok(katex.raw.length > 1000)
  assert.match(String(katex.headers['cache-control']), /immutable/)

  const font = await stack.callAssets({ method: 'GET', url: `${ASSETS}/katex/fonts/KaTeX_Main-Regular.woff2` })
  assert.equal(font.status, 200)
  assert.equal(font.headers['content-type'], 'font/woff2')
  assert.ok(font.raw.length > 0)

  const escaped = await stack.callAssets({ method: 'GET', url: `${ASSETS}/%2e%2e%2fpackage.json` })
  assert.equal(escaped.status, 404)
  assert.equal(escaped.text.includes('"name": "dsh-litnotes"'), false)

  const wrongVerb = await stack.callAssets({ method: 'POST', url: `${ASSETS}/katex/katex.min.js` })
  assert.equal(wrongVerb.status, 405)
})

test('the connection fence rejects every request before dispatch', async (t) => {
  const stack = await createRouteStack(t, { ctx: { requestRejection: () => 403 } })
  for (const request of [
    jsonPost('status', {}),
    { method: 'GET', url: `${API}/asset?id=${randomUUID()}&path=full.md` },
    { method: 'GET', url: `${ASSETS}/katex/katex.min.js` },
  ]) {
    const route = request.url.startsWith(ASSETS) ? stack.assets : stack.api
    const response = await stack.call(route, request)
    assert.equal(response.status, 403)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'forbidden')
  }
})
