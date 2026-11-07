/**
 * Local mock of the MinerU REST API for offline parse flow tests, ported to
 * TypeScript from the frozen `test/mock-mineru.mjs`.
 *
 * Dependency-free (`node:http` only). Tests script the poll state sequences and
 * read the captured request/upload state directly:
 *
 * ```ts
 * const mock = await startMockMineru({ token: 'test-token', zip: makeStoredZip([...]) })
 * // mock.url  -> apiBase for resolveConfig
 * // mock.state -> scriptable control surface
 * await mock.close()
 * ```
 *
 * Implemented endpoints:
 *   POST /api/v4/file-urls/batch            (standard; Bearer token required)
 *   PUT  /api/v4/upload/:uploadId           (signed upload target, captures bytes)
 *   GET  /api/v4/extract-results/batch/:id  (standard; token required)
 *   POST /api/v1/agent/parse/file           (agent; no token)
 *   PUT  /api/v1/agent/upload/:id           (signed upload target, captures bytes)
 *   GET  /api/v1/agent/parse/:taskId        (agent; no token)
 *   GET  /files/:name                       (serves registered result artifacts)
 *
 * Every batch/task advances through its own state script on each poll (the last
 * element repeats), so tests can express "pending, running, running, done" or
 * "running, failed" without timing tricks. `extract_progress` is only attached
 * in the states listed by `progressStates` (default just `running`, like the
 * real API); `extractedScript` pins the per-poll page counter to model the
 * pipeline/OCR `0`-page warm-up.
 *
 * @module test/helpers/mock-mineru
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { makeZip } from './zip-builder.ts'

/** Maximum accepted request body. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** Content types served from `/files/:name`. */
const MIME: Readonly<Record<string, string>> = {
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/** Fallback agent-API markdown when the test does not pass one. */
const DEFAULT_AGENT_MARKDOWN = '# Mock MinerU result\n\nParsed by the mock agent (lightweight) API.\n'

/** Fallback standard-API result archive when the test does not pass one. */
function defaultResultZip(): Buffer<ArrayBuffer> {
  return makeZip([
    { name: 'full.md', data: '# Mock MinerU result\n\nParsed by the mock standard API.\n' },
    { name: 'mock_content_list.json', data: '[]' },
  ])
}

/** One captured signed upload. */
export interface MockUpload {
  id: string
  kind: 'standard' | 'agent'
  bytes: Buffer
  contentType: string | undefined
  authorization: string | undefined
  at: string
}

/** One standard-API batch row. */
export interface MockBatchRow {
  batchId: string
  fileName: string
  dataId: string | null
  pollIndex: number
  runningIndex: number
  pretend: boolean
  fixedState: string | null
  request: Record<string, unknown> | null
  uploadedBytes: Buffer | null
}

/** One agent-API task row. */
export interface MockTaskRow {
  taskId: string
  fileName: string
  pollIndex: number
  pretend: boolean
  fixedState: string | null
  request: Record<string, unknown> | null
  uploadedBytes: Buffer | null
}

/** One captured request (method, path, auth header, time). */
export interface MockRequest {
  method: string
  path: string
  auth: string | undefined
  at: string
}

/** Scriptable mock state; tests mutate it directly between polls. */
export interface MockMineruState {
  token: string
  baseUrl: string
  standardStates: string[]
  agentStates: string[]
  totalPages: number
  progressStates: string[]
  extractedScript: number[] | null
  standardErrMsg: string
  agentErrMsg: string
  agentErrCode: number
  files: Map<string, Buffer>
  uploads: Map<string, MockUpload>
  batches: Map<string, MockBatchRow>
  tasks: Map<string, MockTaskRow>
  requests: MockRequest[]
  pollCounts: { standard: number; agent: number }
  counter: number
  zipName: string
  markdownName: string
  addFile: (name: string, buffer: Uint8Array) => void
  setZip: (buffer: Uint8Array) => void
  setMarkdown: (text: string) => void
  setStandardStates: (states: string[]) => void
  setAgentStates: (states: string[]) => void
  pretendBatch: (batchId: string, info?: { fileName?: string; dataId?: string; state?: string }) => MockBatchRow
  pretendTask: (taskId: string, info?: { fileName?: string; state?: string }) => MockTaskRow
  lastStandardUpload: () => Buffer | null
  lastAgentUpload: () => Buffer | null
}

/** Options of {@link startMockMineru}. */
export interface StartMockMineruOptions {
  token?: string
  host?: string
  port?: number
  standardStates?: string[]
  agentStates?: string[]
  progressStates?: string[]
  extractedScript?: number[]
  zip?: Uint8Array
  markdown?: string
  totalPages?: number
  standardErrMsg?: string
  agentErrMsg?: string
  agentErrCode?: number
  delayMs?: number
}

/** A running mock server. */
export interface MockMineru {
  url: string
  port: number
  token: string
  state: MockMineruState
  server: Server
  close: () => Promise<void>
}

/** Create the scriptable mock state. */
function createState(options: StartMockMineruOptions, token: string): MockMineruState {
  const state: MockMineruState = {
    token,
    baseUrl: '',
    standardStates: [...(options.standardStates ?? ['pending', 'running', 'running', 'converting', 'done'])],
    agentStates: [...(options.agentStates ?? ['pending', 'running', 'done'])],
    totalPages: options.totalPages ?? 3,
    progressStates: [...(options.progressStates ?? ['running'])],
    extractedScript: Array.isArray(options.extractedScript) ? [...options.extractedScript] : null,
    standardErrMsg: options.standardErrMsg ?? 'mock MinerU failure: task failed (-60010)',
    agentErrMsg: options.agentErrMsg ?? 'mock MinerU agent failure: too many pages (-30003)',
    agentErrCode: options.agentErrCode ?? -30003,
    files: new Map(),
    uploads: new Map(),
    batches: new Map(),
    tasks: new Map(),
    requests: [],
    pollCounts: { standard: 0, agent: 0 },
    counter: 0,
    zipName: 'result.zip',
    markdownName: 'full.md',
    addFile(name, buffer) {
      state.files.set(name, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
    },
    setZip(buffer) {
      state.files.set(state.zipName, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
    },
    setMarkdown(text) {
      state.files.set(state.markdownName, Buffer.from(String(text), 'utf8'))
    },
    setStandardStates(states) {
      state.standardStates = [...states]
      for (const batch of state.batches.values()) {
        batch.pollIndex = 0
        batch.runningIndex = 0
      }
    },
    setAgentStates(states) {
      state.agentStates = [...states]
      for (const task of state.tasks.values()) task.pollIndex = 0
    },
    pretendBatch(batchId, info = {}) {
      const row: MockBatchRow = {
        batchId,
        fileName: info.fileName ?? 'resumed.pdf',
        dataId: info.dataId ?? null,
        pollIndex: 0,
        runningIndex: 0,
        pretend: true,
        fixedState: info.state ?? 'done',
        request: null,
        uploadedBytes: null,
      }
      state.batches.set(batchId, row)
      return row
    },
    pretendTask(taskId, info = {}) {
      const row: MockTaskRow = {
        taskId,
        fileName: info.fileName ?? 'resumed.pdf',
        pollIndex: 0,
        pretend: true,
        fixedState: info.state ?? 'done',
        request: null,
        uploadedBytes: null,
      }
      state.tasks.set(taskId, row)
      return row
    },
    lastStandardUpload() {
      const views = [...state.uploads.values()].filter((upload) => upload.kind === 'standard')
      return views.at(-1)?.bytes ?? null
    },
    lastAgentUpload() {
      const views = [...state.uploads.values()].filter((upload) => upload.kind === 'agent')
      return views.at(-1)?.bytes ?? null
    },
  }
  return state
}

/** Read a request body into one Buffer, capped. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Read and parse a JSON request body; empty bodies become `{}`. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buffer = await readBody(req)
  if (buffer.length === 0) return {}
  const parsed: unknown = JSON.parse(buffer.toString('utf8'))
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

/** Write one JSON response. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Write one plain-text response. */
function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** MinerU-style API error envelope (HTTP 200 + non-zero `code`). */
function sendApiError(res: ServerResponse, code: number | string, msg: string): void {
  sendJson(res, 200, { code, msg })
}

/** Advance one poll script; the last state repeats. */
function nextState(sequence: string[], index: number): string {
  return sequence[Math.min(index, sequence.length - 1)] ?? 'unknown'
}

/** Last path segment of a request path. */
function lastSegment(pathname: string): string {
  return decodeURIComponent(pathname.split('/').at(-1) ?? '')
}

/** Read one string header from a request. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** The result row for one standard batch poll (frozen mock shape). */
function standardResult(state: MockMineruState, row: MockBatchRow): Record<string, unknown> {
  if (row.pretend) {
    state.pollCounts.standard += 1
    const result: Record<string, unknown> = {
      file_name: row.fileName,
      data_id: row.dataId,
      state: row.fixedState,
      err_msg: row.fixedState === 'failed' ? state.standardErrMsg : '',
    }
    if (row.fixedState === 'done') result.full_zip_url = `${state.baseUrl}/files/${state.zipName}`
    if (state.progressStates.includes(row.fixedState ?? '')) {
      result.extract_progress = {
        extracted_pages:
          state.extractedScript !== null && state.extractedScript.length > 0 ? state.extractedScript[0] : 1,
        total_pages: state.totalPages,
        start_time: new Date().toISOString(),
      }
    }
    return result
  }

  const resultState = nextState(state.standardStates, row.pollIndex)
  row.pollIndex += 1
  state.pollCounts.standard += 1
  const result: Record<string, unknown> = {
    file_name: row.fileName,
    data_id: row.dataId,
    state: resultState,
    err_msg: resultState === 'failed' ? state.standardErrMsg : '',
  }
  if (resultState === 'done') {
    result.full_zip_url = `${state.baseUrl}/files/${state.zipName}`
  } else if (state.progressStates.includes(resultState)) {
    const runningIndex = Number.isInteger(row.runningIndex) ? row.runningIndex : 0
    row.runningIndex = runningIndex + 1
    let extracted: number
    if (state.extractedScript !== null && state.extractedScript.length > 0) {
      extracted = state.extractedScript[Math.min(runningIndex, state.extractedScript.length - 1)] ?? 0
    } else {
      extracted = Math.min(row.pollIndex, state.totalPages)
    }
    result.extract_progress = {
      extracted_pages: Number(extracted) || 0,
      total_pages: state.totalPages,
      start_time: new Date().toISOString(),
    }
  }
  return result
}

/** The result payload for one agent task poll (frozen mock shape). */
function agentResult(state: MockMineruState, row: MockTaskRow): Record<string, unknown> {
  if (row.pretend) {
    state.pollCounts.agent += 1
    const payload: Record<string, unknown> = {
      task_id: row.taskId,
      state: row.fixedState,
      err_msg: row.fixedState === 'failed' ? state.agentErrMsg : '',
      err_code: row.fixedState === 'failed' ? state.agentErrCode : 0,
    }
    if (row.fixedState === 'done') payload.markdown_url = `${state.baseUrl}/files/${state.markdownName}`
    return payload
  }

  const resultState = nextState(state.agentStates, row.pollIndex)
  row.pollIndex += 1
  state.pollCounts.agent += 1
  const payload: Record<string, unknown> = {
    task_id: row.taskId,
    state: resultState,
    err_msg: resultState === 'failed' ? state.agentErrMsg : '',
    err_code: resultState === 'failed' ? state.agentErrCode : 0,
  }
  if (resultState === 'done') {
    payload.markdown_url = `${state.baseUrl}/files/${state.markdownName}`
  }
  return payload
}

/**
 * Start the mock MinerU server on `127.0.0.1`.
 *
 * @param options - token, poll scripts, result artifacts and artificial delay.
 * @returns the running mock (URL, token, scriptable state, close()).
 */
export async function startMockMineru(options: StartMockMineruOptions = {}): Promise<MockMineru> {
  const token = options.token ?? 'mock-token-1234'
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 0
  const delayMs = options.delayMs ?? 0
  const state = createState(options, token)
  state.addFile(state.zipName, options.zip ?? defaultResultZip())
  state.addFile(state.markdownName, Buffer.from(options.markdown ?? DEFAULT_AGENT_MARKDOWN, 'utf8'))

  /** Is this request authorized for the standard API? */
  function authorized(req: IncomingMessage): boolean {
    return headerOf(req, 'authorization') === `Bearer ${state.token}`
  }

  /** Apply the optional artificial delay. */
  const maybeDelay = (): Promise<void> =>
    delayMs > 0
      ? new Promise((resolve) => {
          setTimeout(resolve, delayMs)
        })
      : Promise.resolve()

  /** One signed upload target: captures raw bytes and links them to its owner. */
  async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, kind: 'standard' | 'agent'): Promise<void> {
    const id = lastSegment(url.pathname)
    const bytes = await readBody(req)
    const upload: MockUpload = {
      id,
      kind,
      bytes,
      contentType: headerOf(req, 'content-type'),
      authorization: headerOf(req, 'authorization'),
      at: new Date().toISOString(),
    }
    state.uploads.set(`${kind}:${id}`, upload)
    if (kind === 'standard') {
      // The signed upload URL embeds the batch id; attach bytes to that batch.
      const batch = state.batches.get(id)
      if (batch !== undefined) batch.uploadedBytes = bytes
    } else {
      const task = state.tasks.get(id)
      if (task !== undefined) task.uploadedBytes = bytes
    }
    sendText(res, 200, 'ok')
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      state.requests.push({
        method: req.method ?? '',
        path: url.pathname,
        auth: headerOf(req, 'authorization'),
        at: new Date().toISOString(),
      })
      try {
        await maybeDelay()

        // --- Result artifacts (unsigned; stand-ins for the CDN) -------------
        if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
          const name = decodeURIComponent(url.pathname.slice('/files/'.length))
          const buffer = state.files.get(name)
          if (buffer === undefined) {
            sendJson(res, 404, { code: -404, msg: `file not found: ${name}` })
            return
          }
          const ext = name.slice(name.lastIndexOf('.'))
          res.writeHead(200, {
            'content-type': MIME[ext] ?? 'application/octet-stream',
            'content-length': buffer.length,
          })
          res.end(buffer)
          return
        }

        // --- Standard (precise) API: token required -------------------------
        if (req.method === 'POST' && url.pathname === '/api/v4/file-urls/batch') {
          if (!authorized(req)) {
            sendApiError(res, 'A0202', 'invalid token')
            return
          }
          const body = await readJson(req)
          const files = Array.isArray(body.files) ? body.files : []
          if (files.length === 0) {
            sendApiError(res, -500, 'bad params: files is required')
            return
          }
          state.counter += 1
          const batchId = `mock-batch-${state.counter}`
          const uploadId = batchId
          const file: Record<string, unknown> = files[0] !== null && typeof files[0] === 'object'
            ? (files[0] as Record<string, unknown>)
            : {}
          state.batches.set(batchId, {
            batchId,
            fileName: typeof file.name === 'string' ? file.name : 'upload.pdf',
            dataId: typeof file.data_id === 'string' ? file.data_id : null,
            pollIndex: 0,
            runningIndex: 0,
            pretend: false,
            fixedState: null,
            request: { ...body, batchId, uploadId },
            uploadedBytes: null,
          })
          sendJson(res, 200, {
            code: 0,
            msg: 'ok',
            data: {
              batch_id: batchId,
              // The signed target is absolute and points back at this mock.
              file_urls: [`${state.baseUrl}/api/v4/upload/${encodeURIComponent(uploadId)}`],
            },
          })
          return
        }

        if (req.method === 'PUT' && url.pathname.startsWith('/api/v4/upload/')) {
          await handleUpload(req, res, url, 'standard')
          return
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/v4/extract-results/batch/')) {
          if (!authorized(req)) {
            sendApiError(res, 'A0202', 'invalid token')
            return
          }
          const batchId = decodeURIComponent(url.pathname.slice('/api/v4/extract-results/batch/'.length))
          const batch = state.batches.get(batchId)
          if (batch === undefined) {
            sendApiError(res, -60012, `batch not found: ${batchId}`)
            return
          }
          sendJson(res, 200, {
            code: 0,
            msg: 'ok',
            data: { batch_id: batchId, extract_result: [standardResult(state, batch)] },
          })
          return
        }

        // --- Agent (lightweight) API: no token ------------------------------
        if (req.method === 'POST' && url.pathname === '/api/v1/agent/parse/file') {
          const body = await readJson(req)
          state.counter += 1
          const taskId = `mock-task-${state.counter}`
          state.tasks.set(taskId, {
            taskId,
            fileName: typeof body.file_name === 'string' ? body.file_name : 'upload.pdf',
            pollIndex: 0,
            pretend: false,
            fixedState: null,
            request: body,
            uploadedBytes: null,
          })
          sendJson(res, 200, {
            code: 0,
            msg: 'ok',
            data: {
              task_id: taskId,
              file_url: `${state.baseUrl}/api/v1/agent/upload/${encodeURIComponent(taskId)}`,
            },
          })
          return
        }

        if (req.method === 'PUT' && url.pathname.startsWith('/api/v1/agent/upload/')) {
          await handleUpload(req, res, url, 'agent')
          return
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/v1/agent/parse/')) {
          const taskId = decodeURIComponent(url.pathname.slice('/api/v1/agent/parse/'.length))
          const task = state.tasks.get(taskId)
          if (task === undefined) {
            sendApiError(res, -60012, `task not found: ${taskId}`)
            return
          }
          sendJson(res, 200, { code: 0, msg: 'ok', data: agentResult(state, task) })
          return
        }

        // --- Anything else --------------------------------------------------
        sendJson(res, 404, { code: -404, msg: `mock MinerU: no route ${req.method ?? ''} ${url.pathname}` })
      } catch (error) {
        sendJson(res, 500, {
          code: -10001,
          msg: `mock MinerU internal error: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort
  state.baseUrl = `http://${host}:${port}`

  return {
    url: state.baseUrl,
    port,
    token: state.token,
    state,
    server,
    /** Stop the server, dropping keep-alive sockets so tests never hang. */
    async close() {
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      server.closeAllConnections()
      await closed
    },
  }
}
