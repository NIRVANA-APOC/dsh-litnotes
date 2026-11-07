/**
 * End-to-end harness for the dsh-litnotes AI features.
 *
 * Boots the REAL `index.js` with `apply(fakeCtx, {})` (same pattern as
 * test/e2e/boot.test.mjs) against a temp `$DSH_HOME`, with:
 *   - a seeded parsed document on disk (sqlite-free: meta.json + parsed files),
 *   - a fake Host `llm` service (test/helpers/fake-llm.mjs),
 *   - a fake `agentDefaultModel` selection,
 *   - a fake connection fence and web server that records exact/prefix routes.
 *
 * HTTP helpers below drive the registered handlers directly with fake
 * IncomingMessage/ServerResponse objects, including NDJSON streaming responses
 * (frame parsing + mid-stream abort via `emit('close')`).
 *
 * Everything is discovered tolerantly (`findHandler` prefers an exact route and
 * falls back to the `/dsh-litnotes/api` prefix dispatcher) because the AI routes
 * are wired by the Lead after the engines land.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMarkdown, plainTextOfBlock } from '../../ui/markdown.js'
import { createFakeDefaultModel, createFakeLlm, entailmentText } from '../helpers/fake-llm.mjs'
import {
  createFakeCredentials,
  createFakeCtx,
  fixtureText,
  responseJson,
  waitFor,
} from './helpers.mjs'

/** Every AI route defined by docs/AI-SPEC.md §4. */
export const AI_ROUTES = Object.freeze({
  chat: '/dsh-litnotes/api/chat',
  history: '/dsh-litnotes/api/chat.history',
  clear: '/dsh-litnotes/api/chat.clear',
  graphDoc: '/dsh-litnotes/api/graph.doc',
  graphBuild: '/dsh-litnotes/api/graph.build',
  graphUpdate: '/dsh-litnotes/api/graph.update',
  graphLibrary: '/dsh-litnotes/api/graph.library',
  graphLibraryRebuild: '/dsh-litnotes/api/graph.library.rebuild',
})

/** API mount point (prefix dispatcher for JSON methods). */
const API_PREFIX = '/dsh-litnotes/api'

/* ------------------------------------------------------------------ */
/* Fake HTTP streaming req/res                                         */
/* ------------------------------------------------------------------ */

/** Tiny EventEmitter used by the fake req/res (route handlers listen for 'close'). */
function makeEmitter(target) {
  const listeners = new Map()
  target.on = (event, listener) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return target
  }
  target.once = (event, listener) => {
    const wrapper = (...args) => {
      target.removeListener(event, wrapper)
      listener(...args)
    }
    return target.on(event, wrapper)
  }
  target.removeListener = (event, listener) => {
    const list = listeners.get(event) ?? []
    listeners.set(event, list.filter((entry) => entry !== listener))
    return target
  }
  target.off = target.removeListener
  target.emit = (event, ...args) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    return true
  }
  target.listenerCount = (event) => (listeners.get(event) ?? []).length
  return target
}

/**
 * An IncomingMessage stand-in that can emit 'close' mid-stream (request abort).
 * @param {{ method?: string, url?: string, headers?: Record<string, string>,
 *           body?: string | Buffer }} [options]
 */
export function createStreamingRequest(options = {}) {
  const { method = 'POST', url = '/', headers = {}, body } = options
  const normalizedHeaders = {}
  for (const [key, value] of Object.entries(headers)) normalizedHeaders[key.toLowerCase()] = String(value)
  const chunks = body === undefined || body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]
  const req = {
    method,
    url,
    headers: normalizedHeaders,
    aborted: false,
    complete: true,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    resume() {},
    destroy() {},
    /** Simulate the client going away mid-response (aborts the stream). */
    abortStream() {
      req.aborted = true
      req.emit('close')
      req.emit('aborted')
    },
  }
  return makeEmitter(req)
}

/**
 * A ServerResponse stand-in for JSON and NDJSON responses. `write()` splits
 * complete NDJSON lines into `state.frames` as they arrive, so tests can observe
 * frames while the stream is still open.
 */
export function createStreamingResponse() {
  const state = {
    statusCode: undefined,
    headers: {},
    rawChunks: [],
    text: '',
    lines: [],
    frames: [],
    headersSent: false,
    writableEnded: false,
    destroyed: false,
  }
  /** Consume complete lines from the accumulated text. */
  const drainLines = () => {
    let newline = state.text.indexOf('\n')
    while (newline >= 0) {
      const line = state.text.slice(0, newline)
      state.text = state.text.slice(newline + 1)
      if (line.trim() !== '') {
        state.lines.push(line)
        try {
          state.frames.push(JSON.parse(line))
        } catch {
          state.frames.push({ __unparsed: line })
        }
      }
      newline = state.text.indexOf('\n')
    }
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
    flushHeaders() {
      state.headersSent = true
    },
    write(chunk) {
      if (chunk === undefined || chunk === null) return true
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      state.rawChunks.push(buffer)
      state.headersSent = true
      state.text += buffer.toString('utf8')
      drainLines()
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.write(chunk)
      state.headersSent = true
      state.writableEnded = true
      return res
    },
    destroy() {
      state.destroyed = true
      state.writableEnded = true
    },
    get headersSent() {
      return state.headersSent
    },
    get writableEnded() {
      return state.writableEnded
    },
    /** Parsed JSON body (the complete raw text, trimmed). */
    json() {
      const text = Buffer.concat(state.rawChunks).toString('utf8').trim()
      if (text === '') return null
      return JSON.parse(text)
    },
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => state.statusCode,
    set: (value) => {
      state.statusCode = value
    },
  })
  return makeEmitter(res)
}

/* ------------------------------------------------------------------ */
/* Library seeding                                                     */
/* ------------------------------------------------------------------ */

/** The fixture paper markdown used by the seeded document. */
export function defaultAiMarkdown() {
  return fixtureText('paper.md')
}

/** The fixture content list used by the seeded document. */
export function defaultAiContentList() {
  return JSON.parse(fixtureText('content_list.json'))
}

/**
 * Write one fully-parsed document into `<dataDir>/documents/<uuid>/` exactly as
 * the parse manager would after a successful parse, so AI services can read it.
 *
 * @param {string} dataDir - resolved plugin data directory.
 * @param {{ id?: string, markdown?: string, contentList?: object[], title?: string,
 *           originalName?: string }} [options]
 */
export async function seedParsedDocument(dataDir, options = {}) {
  const id = options.id ?? randomUUID()
  const markdown = options.markdown ?? defaultAiMarkdown()
  const contentList = options.contentList ?? defaultAiContentList()
  const title = options.title ?? 'Sparse Expert Routing for Efficient Document Retrieval'
  const originalName = options.originalName ?? 'sparse-route.pdf'
  const docDir = join(dataDir, 'documents', id)
  await mkdir(join(docDir, 'parsed'), { recursive: true })
  const now = new Date().toISOString()
  const meta = {
    schemaVersion: 1,
    id,
    title,
    originalName,
    ext: '.pdf',
    mime: 'application/pdf',
    size: 2048,
    sha256: '0'.repeat(64),
    createdAt: now,
    updatedAt: now,
    status: 'parsed',
    error: null,
    parse: {
      engine: 'standard',
      modelVersion: 'vlm',
      language: 'ch',
      options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
      phase: null,
      taskId: null,
      batchId: 'seed-batch',
      startedAt: now,
      finishedAt: now,
      pages: 3,
      progress: { extracted: 3, total: 3 },
      hasContentList: true,
    },
  }
  await writeFile(join(docDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  await writeFile(join(docDir, 'source.pdf'), '%PDF-1.4\n% e2e fixture\n%%EOF\n')
  await writeFile(join(docDir, 'parsed', 'full.md'), markdown)
  await writeFile(join(docDir, 'parsed', 'sample_content_list.json'), `${JSON.stringify(contentList, null, 2)}\n`)
  return { id, dir: docDir, meta, markdown, contentList }
}

/**
 * Locate a citation target: a block key + quote + offsets inside the parsed
 * fixture markdown (the parser used by the AI retriever/chat service).
 *
 * @param {string} markdown
 * @param {string} needle - short verbatim phrase from the markdown.
 * @returns {{ blockKey: string, quote: string, start: number, end: number, block: object }}
 */
export function findCitationTarget(markdown, needle) {
  const model = parseMarkdown(markdown)
  for (const block of model.blocks) {
    const plain = plainTextOfBlock(block)
    const start = typeof plain === 'string' ? plain.indexOf(needle) : -1
    if (start < 0) continue
    return {
      blockKey: block.key,
      quote: needle,
      start,
      end: start + needle.length,
      block,
    }
  }
  throw new Error(`findCitationTarget: quote not found in parsed markdown: ${JSON.stringify(needle)}`)
}

/* ------------------------------------------------------------------ */
/* Chat harness scripting                                              */
/* ------------------------------------------------------------------ */

/**
 * Install a persistent fake-llm rule that answers every citation–claim
 * entailment call of one harness, matched on the dedicated system prompt (the
 * chat answer calls keep using the normal queue/rules). Each result is
 * `{ index, verdict: 'supported'|'partial'|'unsupported', reason? }`.
 *
 * @param {{ llm: object }} harness - harness created by {@link createAiHarness}.
 * @param {{ index: number, verdict: string, reason?: string }[]} results - verdicts.
 * @returns {{ llm: object }} the same harness (for chaining).
 */
export function scriptEntailment(harness, results = []) {
  if (harness === null || typeof harness !== 'object' || harness.llm === null || harness.llm === undefined
    || typeof harness.llm.match !== 'function') {
    throw new Error('scriptEntailment: a harness with a fake llm is required')
  }
  harness.llm.match(
    (request) => typeof request?.system === 'string' && request.system.includes('litnotes-entailment'),
    { text: entailmentText(results) },
  )
  return harness
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Read a JSON file, returning `null` when missing/corrupt. */
export async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** Whether a file exists. */
export async function fileExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/** Find the handler for one pathname (exact route first, then the API prefix). */
function findHandler(routes, pathname) {
  const exact = routes.find((route) => route.path === pathname && typeof route.handler === 'function')
  if (exact !== undefined) return exact
  return routes.find(
    (route) =>
      (route.kind === 'prefix' || route.path === API_PREFIX) &&
      typeof route.handler === 'function' &&
      (pathname === route.path || pathname.startsWith(`${route.path}/`)),
  )
}

/**
 * Create the AI end-to-end harness.
 *
 * @param {import('node:test').TestContext} t
 * @param {{
 *   config?: object,
 *   markdown?: string,
 *   contentList?: object[],
 *   llm?: object | null,
 *   defaultModel?: object | null,
 *   seed?: boolean,
 *   documentId?: string,
 *   extraGet?: Record<string, unknown>,
 * }} [options]
 */
export async function createAiHarness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-litnotes-ai-e2e-'))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const dataDir = join(root, 'litnotes')
  const markdown = options.markdown ?? defaultAiMarkdown()
  const contentList = options.contentList ?? defaultAiContentList()
  const seeded = options.seed === false
    ? null
    : await seedParsedDocument(dataDir, { id: options.documentId, markdown, contentList })

  const llm = options.llm === undefined ? createFakeLlm() : options.llm
  const defaultModel = options.defaultModel === undefined ? createFakeDefaultModel() : options.defaultModel
  const credentials = createFakeCredentials()
  const get = { credentials }
  if (llm !== null) get.llm = llm
  if (defaultModel !== null) get.agentDefaultModel = defaultModel
  if (options.extraGet) Object.assign(get, options.extraGet)
  const ctx = createFakeCtx({ get })

  const plugin = await import('../../index.js')
  plugin.apply(ctx, options.config ?? {})

  const harness = {
    root,
    dataDir,
    ctx,
    llm,
    defaultModel,
    markdown,
    contentList,
    documentId: seeded?.id ?? null,
    docDir: seeded?.dir ?? null,
    plugin,
    /** Path of the seeded document's aux file (chat.json / graph.json). */
    docFile(name) {
      if (seeded === null) throw new Error('AI harness was created without a seeded document')
      return join(seeded.dir, name)
    },
    /** Path of the library-level aux file (library-graph.json). */
    libraryFile(name) {
      return join(dataDir, name)
    },
    /** Whether any route exists for an AI pathname (exact or through the prefix). */
    hasRoute(pathname) {
      return findHandler(ctx.routes, pathname) !== undefined
    },
    /** Whether the AI JSON routes are wired at all (skip-guard for missing wiring). */
    async isWired() {
      if (!harness.hasRoute(AI_ROUTES.history) && !harness.hasRoute(AI_ROUTES.graphDoc)) return false
      try {
        const history = await harness.invokeJson(AI_ROUTES.history, {
          method: 'POST',
          payload: { documentId: harness.documentId ?? randomUUID() },
        })
        return history.status !== 404 && history.status !== 405
      } catch {
        return false
      }
    },
    /** Whether the knowledge-graph engine answers graph.doc (engine ready). */
    async isGraphReady() {
      if (!harness.hasRoute(AI_ROUTES.graphDoc)) return false
      try {
        const response = await harness.invokeJson(AI_ROUTES.graphDoc, {
          method: 'POST',
          payload: { documentId: harness.documentId },
        })
        return response.status === 200
      } catch {
        return false
      }
    },
    /** Whether the grounded-chat engine answers chat.history (engine ready). */
    async isChatReady() {
      try {
        const response = await harness.invokeJson(AI_ROUTES.history, {
          method: 'POST',
          payload: { documentId: harness.documentId },
        })
        return response.status === 200
      } catch {
        return false
      }
    },
    /**
     * Invoke one JSON route and return `{ status, headers, body, raw, res }`.
     * `body` is the parsed envelope (existing JSON API style `{ok,value}`).
     */
    async invokeJson(pathname, options = {}) {
      const { method = 'GET', payload, query } = options
      const url = query === undefined ? pathname : `${pathname}?${new URLSearchParams(query).toString()}`
      const route = findHandler(ctx.routes, pathname)
      if (route === undefined) throw new Error(`no route registered for ${url}`)
      const body = method === 'GET' || payload === undefined ? undefined : JSON.stringify(payload)
      const req = createStreamingRequest({
        method,
        url,
        headers: body === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      })
      const res = createStreamingResponse()
      await route.handler(req, res)
      let parsed = null
      try {
        parsed = res.json()
      } catch (error) {
        throw new Error(`${method} ${url} returned non-JSON (${error?.message ?? error}): ${Buffer.concat(res.state.rawChunks).toString('utf8').slice(0, 300)}`)
      }
      return { status: res.state.statusCode, headers: res.state.headers, body: parsed, res }
    },
    /**
     * Start one streaming (NDJSON) route. Returns the in-flight handler promise
     * plus live frame access — call `await settled` to wait for the stream end.
     */
    startStream(pathname, payload, options = {}) {
      const route = findHandler(ctx.routes, pathname)
      if (route === undefined) throw new Error(`no route registered for ${pathname}`)
      const body = payload === undefined ? undefined : JSON.stringify(payload)
      const req = createStreamingRequest({
        method: 'POST',
        url: pathname,
        headers: body === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
        signal: options.signal,
      })
      const res = createStreamingResponse()
      const settled = Promise.resolve().then(() => route.handler(req, res))
      return { req, res, frames: res.state.frames, settled }
    },
    /** Dispose effects (reverse registration order), then restore env + delete temp dir. */
    async close() {
      for (const effect of [...ctx.effects].reverse()) {
        try {
          if (typeof effect.cleanup === 'function') effect.cleanup()
        } catch {
          /* cleanup best effort */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
      await rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
  t.after(() => harness.close())
  return harness
}

/** Wait (bounded) for the stream handler promise to settle. */
export async function settleStream(settled, { timeout = 10_000, label = 'NDJSON stream' } = {}) {
  let timer
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeout}ms waiting for ${label}`)), timeout)
  })
  try {
    return await Promise.race([settled, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait until the fake response has emitted at least `count` parsed NDJSON
 * frames (bounded), then return them.
 */
export async function waitForFrames(res, count = 1, options = {}) {
  const { timeout = 8000, label = `stream to emit ${count} frame(s)` } = options
  await waitFor(() => res.state.frames.length >= count, { timeout, label, interval: 5 })
  return res.state.frames
}

/** Parse the JSON envelope in a JSON-route response into its value. */
export function envelopeValue(response, label = 'response') {
  const body = response.body
  if (body !== null && typeof body === 'object' && body.ok === true && 'value' in body) return body.value
  if (body !== null && typeof body === 'object' && 'ok' in body && body.ok === false) {
    const code = body.error?.code ?? 'unknown'
    throw new Error(`${label} failed with ${code}: ${body.error?.message ?? ''}`)
  }
  return body
}

/** Assert helper: return the first frame of a type, or undefined. */
export function frameOfType(frames, type) {
  return frames.find((frame) => frame?.type === type)
}

/** All frames of one type. */
export function framesOfType(frames, type) {
  return frames.filter((frame) => frame?.type === type)
}

/** Text concatenation of `delta` frames (the streamed answer). */
export function deltaText(frames) {
  return frames
    .filter((frame) => frame?.type === 'delta' && typeof frame.text === 'string')
    .map((frame) => frame.text)
    .join('')
}

/** Read the persisted chat history file (`{version, messages}`) for the seeded doc. */
export async function readChatFile(harness) {
  return (await readJsonFile(harness.docFile('chat.json'))) ?? null
}

/** Read the persisted doc graph file. */
export async function readDocGraphFile(harness) {
  return (await readJsonFile(harness.docFile('graph.json'))) ?? null
}

/** Read the persisted library graph file. */
export async function readLibraryGraphFile(harness) {
  return (await readJsonFile(harness.libraryFile('library-graph.json'))) ?? null
}

export { responseJson }
