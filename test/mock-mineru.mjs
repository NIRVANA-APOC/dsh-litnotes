/**
 * Local mock of the MinerU REST API for offline end-to-end tests and manual
 * verification. Dependency-free (`node:http` only).
 *
 * In tests:
 *
 *   import { startMockMineru } from '../mock-mineru.mjs'
 *   const mock = await startMockMineru({ token: 'test-token', zip: makeZip([...]) })
 *   // mock.url  -> apiBase for lib/config.js
 *   // mock.token -> token for lib/config.js getToken()
 *   // mock.state -> scriptable control surface (see createState)
 *   await mock.close()
 *
 * Implemented endpoints:
 *   POST /api/v4/file-urls/batch            (standard; Bearer token required)
 *   PUT  /api/v4/upload/:uploadId           (signed upload target, captures bytes)
 *   GET  /api/v4/extract-results/batch/:id  (standard; token required)
 *   POST /api/v1/agent/parse/file           (agent; no token)
 *   PUT  /api/v1/agent/upload/:id           (signed upload target, captures bytes)
 *   GET  /api/v1/agent/parse/:taskId        (agent; no token)
 *   GET  /files/:name                       (serves registered result zip / markdown)
 *
 * Scripted states: every batch/task advances through its own state sequence on
 * each poll (the last element repeats), so tests can express "pending, running,
 * running, done" or "running, failed" without timing tricks.
 *
 * CLI:
 *   node test/mock-mineru.mjs --standalone [--port 9000] [--token my-token]
 *       [--fail-standard] [--fail-agent] [--zip path/to/result.zip]
 *       [--markdown path/to/full.md]
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeZip } from './fixtures/make-zip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 32 * 1024 * 1024

const MIME = {
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/** Fallback agent-API markdown when the test does not pass one. */
const DEFAULT_AGENT_MARKDOWN = '# Mock MinerU result\n\nParsed by the mock agent (lightweight) API.\n'

/** Fallback standard-API result archive when the test does not pass one. */
function defaultResultZip() {
  return makeZip([
    { name: 'full.md', data: '# Mock MinerU result\n\nParsed by the mock standard API.\n' },
    { name: 'mock_content_list.json', data: '[]' },
  ])
}

/** Read a request body into one Buffer, capped. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
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

/** Read and parse a JSON request body; empty bodies become {}. */
async function readJson(req) {
  const buffer = await readBody(req)
  if (buffer.length === 0) return {}
  return JSON.parse(buffer.toString('utf8'))
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Write one plain-text response. */
function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** MinerU-style API error envelope (HTTP 200 + non-zero `code`). */
function sendApiError(res, code, msg) {
  sendJson(res, 200, { code, msg })
}

/**
 * Create the scriptable mock state. Tests mutate this object directly between
 * polls; every request handler reads it live.
 */
function createState(options) {
  const state = {
    token: options.token,
    /** Absolute base URL, filled in once the server is listening. */
    baseUrl: '',
    /** Standard-API poll script; the last element repeats. */
    standardStates: [...(options.standardStates ?? ['pending', 'running', 'running', 'converting', 'done'])],
    /** Agent-API poll script; the last element repeats. */
    agentStates: [...(options.agentStates ?? ['pending', 'running', 'done'])],
    /** Total page count exposed in standard progress metadata. */
    totalPages: options.totalPages ?? 3,
    standardErrMsg: options.standardErrMsg ?? 'mock MinerU failure: task failed (-60010)',
    agentErrMsg: options.agentErrMsg ?? 'mock MinerU agent failure: too many pages (-30003)',
    agentErrCode: options.agentErrCode ?? -30003,
    /** @type {Map<string, Buffer>} GET /files/:name payloads. */
    files: new Map(),
    /** @type {Map<string, object>} captured PUT uploads keyed by upload id. */
    uploads: new Map(),
    /** @type {Map<string, object>} standard batches keyed by batch id. */
    batches: new Map(),
    /** @type {Map<string, object>} agent tasks keyed by task id. */
    tasks: new Map(),
    /** @type {Array<{method: string, path: string, at: string, auth: string|undefined}>} */
    requests: [],
    /** Throttle/instrumentation counters. */
    pollCounts: { standard: 0, agent: 0 },
    counter: 0,
    /** Name of the registered zip result file served by GET /files. */
    zipName: 'result.zip',
    /** Name of the registered markdown result file served by GET /files. */
    markdownName: 'full.md',

    /** Register a buffer that GET /files/:name serves. */
    addFile(name, buffer) {
      state.files.set(name, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
    },
    /** Replace the standard-API result archive served on `full_zip_url`. */
    setZip(buffer) {
      state.files.set(state.zipName, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
    },
    /** Replace the agent-API markdown served on `markdown_url`. */
    setMarkdown(text) {
      state.files.set(state.markdownName, Buffer.from(String(text), 'utf8'))
    },
    /** Replace the standard poll script (e.g. make the next polls fail). */
    setStandardStates(states) {
      state.standardStates = [...states]
      for (const batch of state.batches.values()) batch.pollIndex = 0
    },
    /** Replace the agent poll script. */
    setAgentStates(states) {
      state.agentStates = [...states]
      for (const task of state.tasks.values()) task.pollIndex = 0
    },
    /**
     * Pre-register a standard batch as if it had been created by an earlier
     * process (used to test parse-manager.resume()). It polls with a fixed state.
     * @param {string} batchId
     * @param {{ fileName?: string, dataId?: string, state?: string }} [info]
     */
    pretendBatch(batchId, info = {}) {
      state.batches.set(batchId, {
        batchId,
        fileName: info.fileName ?? 'resumed.pdf',
        dataId: info.dataId ?? null,
        pollIndex: 0,
        pretend: true,
        fixedState: info.state ?? 'done',
        request: null,
        uploadedBytes: null,
      })
      return state.batches.get(batchId)
    },
    /**
     * Pre-register an agent task as if it had been created by an earlier
     * process (used to test parse-manager.resume()).
     * @param {string} taskId
     * @param {{ fileName?: string, state?: string }} [info]
     */
    pretendTask(taskId, info = {}) {
      state.tasks.set(taskId, {
        taskId,
        fileName: info.fileName ?? 'resumed.pdf',
        pollIndex: 0,
        pretend: true,
        fixedState: info.state ?? 'done',
        request: null,
        uploadedBytes: null,
      })
      return state.tasks.get(taskId)
    },
    /** Bytes captured by the most recent standard upload, if any. */
    lastStandardUpload() {
      const views = [...state.uploads.values()].filter((upload) => upload.kind === 'standard')
      return views.at(-1)?.bytes ?? null
    },
    /** Bytes captured by the most recent agent upload, if any. */
    lastAgentUpload() {
      const views = [...state.uploads.values()].filter((upload) => upload.kind === 'agent')
      return views.at(-1)?.bytes ?? null
    },
  }
  return state
}

/** Advance one poll script; the last state repeats. */
function nextState(sequence, index) {
  return sequence[Math.min(index, sequence.length - 1)]
}

/**
 * Start the mock MinerU server on `127.0.0.1`.
 *
 * @param {{
 *   token?: string,
 *   host?: string,
 *   port?: number,
 *   standardStates?: string[],
 *   agentStates?: string[],
 *   zip?: Buffer,
 *   markdown?: string,
 *   totalPages?: number,
 *   standardErrMsg?: string,
 *   agentErrMsg?: string,
 *   agentErrCode?: number,
 *   delayMs?: number,
 * }} [options]
 * @returns {Promise<{ url: string, port: number, token: string, state: object,
 *   server: import('node:http').Server, close: () => Promise<void> }>}
 */
export async function startMockMineru(options = {}) {
  const settings = {
    token: 'mock-token-1234',
    host: '127.0.0.1',
    port: 0,
    delayMs: 0,
    ...options,
  }
  const state = createState(settings)
  state.addFile(state.zipName, settings.zip ?? defaultResultZip())
  state.addFile(state.markdownName, Buffer.from(settings.markdown ?? DEFAULT_AGENT_MARKDOWN, 'utf8'))

  /** Is this request authorized for the standard API? */
  function authorized(req) {
    return req.headers.authorization === `Bearer ${state.token}`
  }

  /** Apply the optional artificial delay. */
  const maybeDelay = () =>
    settings.delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, settings.delayMs)) : Promise.resolve()

  /** Build the standard result row for one batch poll. */
  function standardResult(row) {
    if (row.pretend) {
      state.pollCounts.standard += 1
      const result = {
        file_name: row.fileName,
        data_id: row.dataId,
        state: row.fixedState,
        err_msg: row.fixedState === 'failed' ? state.standardErrMsg : '',
      }
      if (row.fixedState === 'done') result.full_zip_url = `${state.baseUrl}/files/${state.zipName}`
      if (!['done', 'failed'].includes(row.fixedState)) {
        result.extract_progress = {
          extracted_pages: 1,
          total_pages: state.totalPages,
          start_time: new Date().toISOString(),
        }
      }
      return result
    }

    const resultState = nextState(state.standardStates, row.pollIndex)
    row.pollIndex += 1
    state.pollCounts.standard += 1
    const result = {
      file_name: row.fileName,
      data_id: row.dataId,
      state: resultState,
      err_msg: resultState === 'failed' ? state.standardErrMsg : '',
    }
    if (resultState === 'done') {
      result.full_zip_url = `${state.baseUrl}/files/${state.zipName}`
    } else if (!['failed', 'waiting-file'].includes(resultState)) {
      result.extract_progress = {
        extracted_pages: Math.min(row.pollIndex, state.totalPages),
        total_pages: state.totalPages,
        start_time: new Date().toISOString(),
      }
    }
    return result
  }

  /** Build the agent result payload for one task poll. */
  function agentResult(row) {
    if (row.pretend) {
      state.pollCounts.agent += 1
      const payload = {
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
    const payload = {
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

  /** One signed upload target: captures raw bytes and links them to its owner. */
  async function handleUpload(req, res, url, kind) {
    const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
    const bytes = await readBody(req)
    const upload = {
      id,
      kind,
      bytes,
      contentType: req.headers['content-type'],
      authorization: req.headers.authorization,
      at: new Date().toISOString(),
    }
    state.uploads.set(`${kind}:${id}`, upload)
    if (kind === 'standard') {
      // The signed upload URL embeds the batch id; attach bytes to that batch.
      const batch = state.batches.get(id)
      if (batch) batch.uploadedBytes = bytes
    } else {
      const task = state.tasks.get(id)
      if (task) task.uploadedBytes = bytes
    }
    sendText(res, 200, 'ok')
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    state.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      auth: req.headers.authorization,
      at: new Date().toISOString(),
    })
    try {
      await maybeDelay()

      // --- Result artifacts (unsigned; stand-ins for the CDN) -------------
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const name = decodeURIComponent(url.pathname.slice('/files/'.length))
        const buffer = state.files.get(name)
        if (!buffer) return sendJson(res, 404, { code: -404, msg: `file not found: ${name}` })
        const ext = name.slice(name.lastIndexOf('.'))
        res.writeHead(200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'content-length': buffer.length,
        })
        return res.end(buffer)
      }

      // --- Standard (precise) API: token required -------------------------
      if (req.method === 'POST' && url.pathname === '/api/v4/file-urls/batch') {
        if (!authorized(req)) return sendApiError(res, 'A0202', 'invalid token')
        const body = await readJson(req)
        const files = Array.isArray(body.files) ? body.files : []
        if (files.length === 0) return sendApiError(res, -500, 'bad params: files is required')
        state.counter += 1
        const batchId = `mock-batch-${state.counter}`
        const uploadId = batchId
        const file = files[0]
        state.batches.set(batchId, {
          batchId,
          fileName: file.name ?? 'upload.pdf',
          dataId: file.data_id ?? null,
          pollIndex: 0,
          pretend: false,
          fixedState: null,
          request: { ...body, batchId, uploadId },
          uploadedBytes: null,
        })
        return sendJson(res, 200, {
          code: 0,
          msg: 'ok',
          data: {
            batch_id: batchId,
            // The signed target is absolute and points back at this mock.
            file_urls: [`${state.baseUrl}/api/v4/upload/${encodeURIComponent(uploadId)}`],
          },
        })
      }

      if (req.method === 'PUT' && url.pathname.startsWith('/api/v4/upload/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
        return await handleUpload(req, res, url, 'standard')
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/v4/extract-results/batch/')) {
        if (!authorized(req)) return sendApiError(res, 'A0202', 'invalid token')
        const batchId = decodeURIComponent(url.pathname.slice('/api/v4/extract-results/batch/'.length))
        const batch = state.batches.get(batchId)
        if (!batch) return sendApiError(res, -60012, `batch not found: ${batchId}`)
        return sendJson(res, 200, {
          code: 0,
          msg: 'ok',
          data: { batch_id: batchId, extract_result: [standardResult(batch)] },
        })
      }

      // --- Agent (lightweight) API: no token ------------------------------
      if (req.method === 'POST' && url.pathname === '/api/v1/agent/parse/file') {
        const body = await readJson(req)
        state.counter += 1
        const taskId = `mock-task-${state.counter}`
        state.tasks.set(taskId, {
          taskId,
          fileName: body.file_name ?? 'upload.pdf',
          pollIndex: 0,
          pretend: false,
          fixedState: null,
          request: body,
          uploadedBytes: null,
        })
        return sendJson(res, 200, {
          code: 0,
          msg: 'ok',
          data: {
            task_id: taskId,
            file_url: `${state.baseUrl}/api/v1/agent/upload/${encodeURIComponent(taskId)}`,
          },
        })
      }

      if (req.method === 'PUT' && url.pathname.startsWith('/api/v1/agent/upload/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
        return await handleUpload(req, res, url, 'agent')
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/agent/parse/')) {
        const taskId = decodeURIComponent(url.pathname.slice('/api/v1/agent/parse/'.length))
        const task = state.tasks.get(taskId)
        if (!task) return sendApiError(res, -60012, `task not found: ${taskId}`)
        return sendJson(res, 200, { code: 0, msg: 'ok', data: agentResult(task) })
      }

      // --- Anything else --------------------------------------------------
      return sendJson(res, 404, { code: -404, msg: `mock MinerU: no route ${req.method} ${url.pathname}` })
    } catch (error) {
      return sendJson(res, 500, {
        code: -10001,
        msg: `mock MinerU internal error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(settings.port, settings.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : settings.port
  state.baseUrl = `http://${settings.host}:${port}`

  return {
    url: state.baseUrl,
    port,
    token: state.token,
    state,
    server,
    /** Stop the server, dropping keep-alive sockets so tests never hang. */
    async close() {
      const closed = new Promise((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await closed
    },
  }
}

/* ------------------------------------------------------------------ */
/* Standalone CLI for manual verification                              */
/* ------------------------------------------------------------------ */

/** Build the default result zip from the checked-in fixtures. */
function fixtureZip() {
  const read = (rel) => readFileSync(join(HERE, 'fixtures', rel))
  return makeZip([
    { name: 'full.md', data: read('paper.md') },
    { name: 'sample_content_list.json', data: read('content_list.json') },
    { name: 'images/fig1.svg', data: read('images/fig1.svg') },
  ])
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const args = process.argv.slice(2)
  if (!args.includes('--standalone')) {
    console.error('usage: node test/mock-mineru.mjs --standalone [--port N] [--token T] [--fail-standard] [--fail-agent]')
    process.exitCode = 2
  } else {
    const valueOf = (flag) => {
      const index = args.indexOf(flag)
      return index >= 0 ? args[index + 1] : undefined
    }
    const zipPath = valueOf('--zip')
    const markdownPath = valueOf('--markdown')
    const options = {
      port: Number(valueOf('--port') ?? 0),
      token: valueOf('--token') ?? 'mock-token-1234',
      standardStates: args.includes('--fail-standard') ? ['running', 'failed'] : undefined,
      agentStates: args.includes('--fail-agent') ? ['running', 'failed'] : undefined,
      zip: zipPath ? readFileSync(zipPath) : fixtureZip(),
      markdown: markdownPath ? readFileSync(markdownPath, 'utf8') : undefined,
    }
    startMockMineru(options)
      .then((mock) => {
        console.log(`[mock-mineru] listening on ${mock.url}`)
        console.log(`[mock-mineru] token: ${mock.token}`)
        console.log(`[mock-mineru] apiBase: ${mock.url}`)
        console.log('[mock-mineru] standard: POST /api/v4/file-urls/batch -> GET /api/v4/extract-results/batch/:id')
        console.log('[mock-mineru] agent:    POST /api/v1/agent/parse/file  -> GET /api/v1/agent/parse/:id')
        console.log(`[mock-mineru] result zip: ${mock.url}/files/result.zip`)
        console.log('[mock-mineru] Ctrl-C to stop')
        const stop = () => {
          mock.close().finally(() => process.exit(0))
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
      .catch((error) => {
        console.error(`[mock-mineru] FAILED: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      })
  }
}
