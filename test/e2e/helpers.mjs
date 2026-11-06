/**
 * Shared helpers for the dsh-litnotes end-to-end tests.
 *
 * Not a test file itself (the Node test runner only picks up `*.test.mjs`): it
 * holds the temp-directory lifecycle, bounded waits, fixture loaders, a fake
 * credentials service and the canonical fixture ZIP used by the parse flows.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeZip } from '../fixtures/make-zip.mjs'

/** Read a checked-in fixture. */
export function fixture(rel) {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url)))
}

/** Read a checked-in fixture as UTF-8 text. */
export function fixtureText(rel) {
  return fixture(rel).toString('utf8')
}

/** The paper markdown served inside the mock's standard-API result ZIP. */
export function standardMarkdown() {
  return fixtureText('paper.md')
}

/** The content list served inside the mock's standard-API result ZIP. */
export function standardContentList() {
  return JSON.parse(fixtureText('content_list.json'))
}

/** The figure bytes served inside the mock's standard-API result ZIP. */
export function figureBytes() {
  return fixture(join('images', 'fig1.svg'))
}

/** Markdown returned by the agent (lightweight) API mock. */
export function agentMarkdown() {
  return [
    '# Lightweight Parsing Result',
    '',
    'This document was parsed by the mock agent engine. It has no content list',
    'and no local images, which is exactly what the real lightweight API returns.',
    '',
    '## Equation',
    '',
    '$$',
    'y = \\sum_{i=1}^{n} x_i',
    '$$',
    '',
  ].join('\n')
}

/**
 * The canonical MinerU result archive: full markdown, a content list, one image,
 * plus files the parse manager must ignore (layout JSON, the original PDF).
 * @returns {Buffer}
 */
export function standardResultZip() {
  return makeZip([
    { name: 'full.md', data: standardMarkdown() },
    { name: 'sample_content_list.json', data: fixtureText('content_list.json') },
    { name: 'images/fig1.svg', data: figureBytes() },
    { name: 'layout.json', data: '{"pdf_info":[]}' },
    { name: 'paper.pdf', data: pdfBytes() },
  ])
}

/** A small but plausible PDF payload for the "source" side of the upload. */
export function pdfBytes() {
  return Buffer.from(
    '%PDF-1.4\n% dsh-litnotes end-to-end fixture\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'utf8',
  )
}

/**
 * Create a temp directory inside os.tmpdir() that is removed after the test
 * (via `t.after`) even when the test fails.
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
export async function createTempDir(t, prefix = 'dsh-litnotes-e2e-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * Poll `check` until it returns a truthy value or the timeout expires.
 * Tests never busy-wait indefinitely: every wait is bounded and labelled.
 *
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {{ timeout?: number, interval?: number, label?: string }} [options]
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitFor(check, options = {}) {
  const { timeout = 5000, interval = 10, label = 'condition' } = options
  const deadline = Date.now() + timeout
  let lastError
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      const suffix = lastError === undefined ? '' : ` (last error: ${lastError?.message ?? lastError})`
      throw new Error(`timed out after ${timeout}ms waiting for ${label}${suffix}`)
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** Wait until the document reaches `status`, returning the fresh meta. */
export async function waitForStatus(store, id, status, options = {}) {
  return waitFor(
    () => {
      const meta = store.get(id)
      return meta?.status === status ? meta : undefined
    },
    { label: `document ${id} to become ${status}`, ...options },
  )
}

/**
 * A minimal console-like logger for host modules; records entries so tests can
 * assert that recoverable failures were logged instead of thrown.
 */
export function createLogger() {
  /** @type {Array<{ level: string, args: unknown[] }>} */
  const entries = []
  const record = (level) => (...args) => {
    entries.push({ level, args })
  }
  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    log: record('log'),
  }
}

/**
 * In-memory stand-in for `ctx.get('credentials')`, matching the ApiKeyRecord
 * surface the host code uses.
 * @param {Record<string, unknown>} [initial]
 */
export function createFakeCredentials(initial = {}) {
  /** @type {Map<string, unknown>} */
  const records = new Map(Object.entries(initial))
  const credentials = {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutator) {
      const current = records.get(key)
      const next = typeof mutator === 'function' ? await mutator(current) : mutator
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      records.delete(key)
    },
    async describeRecord(key) {
      return { key, writable: true, present: records.has(key) }
    },
  }
  return credentials
}

/**
 * A `getTranslator` fake matching the Host translator surface lib/service.js
 * uses: `availableProviders()`, `resolve(request) -> spec`, `translate(spec) -> string`.
 */
export function createFakeTranslator(prefix = '【译】') {
  return {
    requested: [],
    async availableProviders() {
      return ['google', 'bing']
    },
    resolve(request) {
      this.requested.push({ kind: 'resolve', ...request })
      return { provider: request.provider, text: request.text, targetLanguage: request.targetLanguage }
    },
    async translate(spec) {
      this.requested.push({ kind: 'translate', ...spec })
      return `${prefix}${spec.text}`
    },
  }
}

/**
 * Minimal IncomingMessage stand-in: an async iterable of body chunks plus the
 * headers/method/url the route handlers read. Event hooks are no-ops.
 * @param {{ method?: string, url?: string, headers?: Record<string, string>, body?: string | Buffer }} [options]
 */
export function createFakeRequest(options = {}) {
  const { method = 'POST', url = '/', headers = {}, body } = options
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value)
  const chunks = body === undefined || body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]
  return {
    method,
    url,
    headers: normalized,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    resume() {},
    destroy() {},
    on() {
      return this
    },
    once() {
      return this
    },
    removeListener() {
      return this
    },
  }
}

/**
 * Minimal ServerResponse stand-in capturing status, headers and body chunks.
 * `pipeFile()` only needs write()/end()/on(), which are provided.
 */
export function createFakeResponse() {
  const state = {
    statusCode: undefined,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
    destroyed: false,
  }
  const res = {
    state,
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value
      return res
    },
    getHeader(name) {
      return state.headers[String(name).toLowerCase()]
    },
    removeHeader(name) {
      delete state.headers[String(name).toLowerCase()]
    },
    writeHead(status, headers) {
      state.statusCode = status
      state.headersSent = true
      if (headers !== undefined && headers !== null && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
      }
      return res
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      state.headersSent = true
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      state.headersSent = true
      state.writableEnded = true
      return res
    },
    destroy() {
      state.destroyed = true
    },
    // EventEmitter surface used by stream.pipe() and createReadStream().
    on() {
      return res
    },
    once() {
      return res
    },
    emit() {
      return false
    },
    removeListener() {
      return res
    },
  }
  Object.defineProperty(res, 'headersSent', { get: () => state.headersSent })
  Object.defineProperty(res, 'writableEnded', { get: () => state.writableEnded })
  Object.defineProperty(res, 'statusCode', {
    get: () => state.statusCode,
    set: (value) => {
      state.statusCode = value
    },
  })
  return res
}

/** Parse the JSON body a fake response captured. */
export function responseJson(res) {
  return JSON.parse(Buffer.concat(res.state.chunks).toString('utf8'))
}

/**
 * Minimal Cordis plugin context for route/plugin boot tests: an effect
 * collector, an in-memory `get(name)` map and a fake web server.
 *
 * @param {{ get?: Record<string, unknown>, requestRejection?: (req: any) => unknown }} [options]
 */
export function createFakeCtx(options = {}) {
  const routes = []
  const effects = []
  const ctx = {
    routes,
    effects,
    logger: createLogger(),
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label: label ?? '', cleanup, disposed: false })
      return () => {}
    },
    get(name) {
      return options.get?.[name]
    },
    webServer: {
      register(route) {
        const record = { ...route, disposed: false }
        routes.push(record)
        return () => {
          record.disposed = true
        }
      },
    },
    connection: {
      requestRejection: options.requestRejection ?? (() => undefined),
    },
  }
  return ctx
}
