/**
 * MinerU HTTP client and parse-option normalization for dsh-litnotes.
 *
 * Two MinerU APIs are supported (docs/MINERU.md):
 *
 *  - **standard** (`/api/v4`, Bearer token): batch upload → poll → full ZIP
 *    result (`full.md`, `*_content_list.json`, `images/**`).
 *  - **agent** (`/api/v1`, no token): signed upload → poll → markdown URL.
 *
 * `fetchImpl` is injectable so unit and end-to-end tests run fully offline.
 * Every method throws {@link MineruError} with the upstream API code, HTTP
 * status and a friendly bilingual message that never contains the API token.
 *
 * @module lib/mineru
 */
import { SUPPORTED_EXTENSIONS, extOf } from './mime.js'
import { WireError } from './wire.js'

/** Standard (precise) API limits, mirrored from docs/MINERU.md §A. */
export const STANDARD_LIMITS = Object.freeze({ maxBytes: 200 * 1024 * 1024, maxPages: 200 })
/** Agent (lightweight) API limits, mirrored from docs/MINERU.md §B. */
export const AGENT_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxPages: 20 })
/** MinerU `language` values offered by the UI (docs/MINERU.md §D). */
export const MINERU_LANGUAGES = Object.freeze([
  'ch',
  'en',
  'japan',
  'korean',
  'chinese_cht',
  'latin',
  'arabic',
  'cyrillic',
  'east_slavic',
  'devanagari',
  'ta',
  'te',
  'ka',
  'el',
  'th',
])

/** File extensions accepted by the token-free agent API. */
const AGENT_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.jp2',
  '.webp',
  '.gif',
  '.bmp',
  '.docx',
  '.pptx',
  '.xlsx',
])

/** Accepted `model_version` values. */
const MODEL_VERSIONS = new Set(['pipeline', 'vlm', 'MinerU-HTML'])
/** Accepted extra output formats from the standard API. */
const EXTRA_FORMATS = new Set(['docx', 'html', 'latex'])
/** Sanity bounds for pageRanges strings. */
const PAGE_RANGE_PATTERN = /^(\d+)(?:-(\d+))?$/
/** Per-request response cap for small JSON control responses. */
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024
/** Abort error code for cancelled tasks. */
const ABORTED_MESSAGE = '解析已取消（Cancelled）'

/** Friendly bilingual descriptions keyed by MinerU API code (docs/MINERU.md §C). */
const API_CODE_MESSAGES = Object.freeze({
  A0202: 'MinerU Token 无效，请在设置中重新填写（Invalid API token）',
  A0211: 'MinerU Token 已过期，请重新填写（Expired API token）',
  '-500': 'MinerU 请求参数有误（Invalid request parameters）',
  '-10001': 'MinerU 服务暂时不可用，请稍后重试（Service temporarily unavailable）',
  '-10002': 'MinerU 请求参数有误（Invalid request parameters）',
  '-60001': '获取上传地址失败（Cannot obtain upload URL）',
  '-60002': '文件类型不匹配（File type mismatch）',
  '-60003': '文件读取失败（Cannot read file）',
  '-60004': '文件为空（Empty file）',
  '-60005': '文件超过 200 MB 限制（File exceeds the 200 MB limit）',
  '-60006': '文件页数超过 200 页限制（File exceeds the 200-page limit）',
  '-60007': '所选模型暂不可用（Model unavailable）',
  '-60008': 'MinerU 读取文件超时（File read timeout）',
  '-60009': 'MinerU 解析队列已满，请稍后重试（Parse queue is full）',
  '-60010': 'MinerU 解析失败（Parse failed）',
  '-60011': '没有可解析的有效文件（No valid file）',
  '-60012': '解析任务不存在（Task not found）',
  '-60013': '解析任务不属于当前账号（Task not owned by this account）',
  '-60018': '今日解析配额已用完（Daily quota exhausted）',
  '-60019': 'HTML 解析配额已用完（HTML quota exhausted）',
  '-60022': '网页读取失败（Web page fetch failed）',
  '-30001': '文件超过 10 MB 限制（File exceeds the 10 MB limit）',
  '-30002': '该文件类型不支持轻量解析（Unsupported type for the lightweight API）',
  '-30003': '文件页数超过 20 页限制（File exceeds the 20-page limit）',
  '-30004': '请求参数有误（Invalid parameters）',
})

/** Strip control characters and collapse whitespace from an upstream message. */
function sanitize(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Abort error used for cancelled network work. */
function abortError() {
  const error = new MineruError('aborted', ABORTED_MESSAGE, 0)
  error.name = 'AbortError'
  return error
}

/**
 * Error raised by the MinerU client.
 *
 * `code` is the upstream MinerU API code when one is known (`A0202`, `-60005`,
 * …), otherwise a client-side code (`network-error`, `bad-response`,
 * `http-429`, `aborted`, `parse-failed`). `message` is always safe to persist
 * in `meta.error` and show in the browser; the API token is never included.
 */
export class MineruError extends Error {
  /**
   * @param {string} code - upstream API code or client-side error code.
   * @param {string} message - friendly bilingual message.
   * @param {number} [httpStatus] - upstream HTTP status when known.
   * @param {{ apiCode?: string, msg?: string, state?: string, limit?: number } | undefined} [detail]
   *   safe extra detail.
   */
  constructor(code, message, httpStatus = 0, detail) {
    super(message)
    this.name = 'MineruError'
    this.code = String(code)
    this.httpStatus = Number.isFinite(httpStatus) ? httpStatus : 0
    if (detail !== undefined && detail !== null) this.detail = detail
  }
}

/**
 * Build the error for an upstream response whose `code` / `err_code` is not 0.
 *
 * @param {unknown} apiCode - MinerU code.
 * @param {unknown} rawMessage - upstream `msg` / `err_msg`.
 * @param {number} httpStatus - HTTP status of the response.
 * @returns {MineruError} mapped failure.
 */
function apiCodeError(apiCode, rawMessage, httpStatus) {
  const code = String(apiCode)
  const mapped = API_CODE_MESSAGES[code]
  const message = sanitize(rawMessage).slice(0, 500)
  const detail = { apiCode: code, msg: message }
  const friendly = mapped ?? `MinerU 接口错误（MinerU API error ${code}）`
  return new MineruError(code, message === '' ? friendly : `${friendly}（${message}）`, httpStatus, detail)
}

/**
 * Build the error for an HTTP failure without a usable API code.
 * @param {number} status - HTTP status.
 * @returns {MineruError} mapped failure.
 */
function httpError(status) {
  if (status === 401 || status === 403) {
    return new MineruError(`http-${status}`, 'MinerU Token 无效或已过期（Invalid or expired token）', status)
  }
  if (status === 404) return new MineruError('http-404', 'MinerU 接口不存在（Endpoint not found）', status)
  if (status === 413) return new MineruError('http-413', '文件超过 MinerU 限制（File too large）', status)
  if (status === 429) {
    return new MineruError('http-429', 'MinerU 请求过于频繁，请稍后重试（Rate limited）', status)
  }
  return new MineruError(`http-${status}`, `MinerU 服务返回 HTTP ${status}（HTTP ${status}）`, status)
}

/** Turn an arbitrary thrown network error into a {@link MineruError}. */
function networkError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return abortError()
  const detail = sanitize(error?.message ?? error)
    .replace(/\?[^\s]*/g, '?…')
    .slice(0, 300)
  return new MineruError('network-error', `无法连接 MinerU 服务（Cannot reach MinerU）${detail ? `：${detail}` : ''}`, 0)
}

/** Abortable delay used between retries. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Read the HTTP status of a Response-like object. */
function statusOf(response) {
  const status = Number(response?.status)
  return Number.isFinite(status) && status > 0 ? status : 200
}

/** Whether a Response-like object reports success. */
function okOf(response) {
  if (typeof response?.ok === 'boolean') return response.ok
  const status = statusOf(response)
  return status >= 200 && status < 300
}

/** Read a Response-like object as JSON, deflating the body safely. */
async function jsonOf(response) {
  const status = statusOf(response)
  if (typeof response?.json === 'function') {
    try {
      return await response.json()
    } catch {
      throw new MineruError('bad-response', 'MinerU 返回了无法解析的响应（Invalid JSON response）', status)
    }
  }
  if (typeof response?.text === 'function') {
    const text = await response.text()
    if (text.length > MAX_JSON_RESPONSE_BYTES) {
      throw new MineruError('bad-response', 'MinerU 响应过大（Response too large）', status)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new MineruError('bad-response', 'MinerU 返回了无法解析的响应（Invalid JSON response）', status)
    }
  }
  throw new MineruError('bad-response', '无法读取 MinerU 响应（Cannot read response）', status)
}

/**
 * Unwrap the standard `{ code, data, msg }` envelope of a response.
 *
 * @param {object} response - Response-like object.
 * @param {unknown} json - parsed body.
 * @returns {any} the envelope's `data` (or the body when it has no envelope).
 * @throws {MineruError} on HTTP failure or non-zero API code.
 */
function unwrap(response, json) {
  const status = statusOf(response)
  if (json === null || typeof json !== 'object') {
    if (!okOf(response)) throw httpError(status)
    throw new MineruError('bad-response', 'MinerU 返回了意外的响应（Unexpected response）', status)
  }
  const apiCode = json.code ?? json.err_code
  const hasCode = apiCode !== undefined && apiCode !== null
  if (!okOf(response) || (hasCode && String(apiCode) !== '0')) {
    if (hasCode) throw apiCodeError(apiCode, json.msg ?? json.message ?? json.err_msg, status)
    throw httpError(status)
  }
  return json.data === undefined ? {} : json.data
}

/** Drain a response body so its socket can be reused. */
async function drain(response) {
  try {
    if (typeof response?.body?.cancel === 'function') await response.body.cancel()
    else if (typeof response?.text === 'function') await response.text()
  } catch {
    /* best effort */
  }
}

/** Convert a value to a non-negative integer, otherwise undefined. */
function toInt(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined
}

/** Read a Response-like body with a hard byte cap. */
async function readBodyCapped(response, maxBytes) {
  const chunks = []
  let total = 0
  const body = response?.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            /* ignore */
          }
          throw new MineruError('too-large', `解析结果超过 ${maxBytes} 字节限制（Result too large）`, 413, {
            limit: maxBytes,
          })
        }
        chunks.push(chunk)
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        /* ignore */
      }
    }
    return Buffer.concat(chunks, total)
  }
  if (typeof response?.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw new MineruError('too-large', `解析结果超过 ${maxBytes} 字节限制（Result too large）`, 413, {
        limit: maxBytes,
      })
    }
    return buffer
  }
  if (typeof response?.text === 'function') {
    const buffer = Buffer.from(await response.text())
    if (buffer.length > maxBytes) {
      throw new MineruError('too-large', `解析结果超过 ${maxBytes} 字节限制（Result too large）`, 413, {
        limit: maxBytes,
      })
    }
    return buffer
  }
  throw new MineruError('bad-response', '无法读取下载内容（Cannot read download body）')
}

/**
 * Build a failure from a terminal MinerU task state (`failed` / `err_msg`).
 *
 * @param {unknown} errCode - upstream `err_code` / error code.
 * @param {unknown} errMsg - upstream `err_msg`.
 * @returns {MineruError} mapped failure.
 */
export function failureFromApi(errCode, errMsg) {
  const code =
    errCode === undefined || errCode === null || errCode === ''
      ? 'parse-failed'
      : String(errCode)
  const mapped = API_CODE_MESSAGES[code]
  const message = sanitize(errMsg).slice(0, 500)
  if (mapped !== undefined) {
    return new MineruError(code, message === '' ? mapped : `${mapped}（${message}）`, 0, {
      apiCode: code,
      msg: message,
    })
  }
  const fallback = message === '' ? `解析失败（Parse failed ${code}）` : `解析失败（Parse failed）：${message}`
  return new MineruError(code, fallback, 0, { apiCode: code, msg: message })
}

/**
 * Create the MinerU HTTP client.
 *
 * @param {{
 *   getToken?: () => Promise<string | undefined> | string | undefined,
 *   apiBase?: string,
 *   fetchImpl?: typeof fetch,
 *   logger?: { warn?: Function },
 * }} options - token accessor, API base override, injectable fetch and logger.
 * @returns {{
 *   standardCreateBatch(input: { fileName: string, dataId: string, options?: object, signal?: AbortSignal }): Promise<{ batchId: string, uploadUrl: string }>,
 *   putBytes(uploadUrl: string, bytes: Buffer | Uint8Array, opts?: { signal?: AbortSignal }): Promise<{ status: number }>,
 *   standardBatchResult(batchId: string, opts?: { signal?: AbortSignal }): Promise<{ batchId: string, results: object[] }>,
 *   agentCreateTask(input: { fileName: string, options?: object, signal?: AbortSignal }): Promise<{ taskId: string, uploadUrl: string }>,
 *   agentTaskResult(taskId: string, opts?: { signal?: AbortSignal }): Promise<{ state: string, markdownUrl?: string, errMsg: string, errCode?: number, progress?: object | null }>,
 *   downloadBytes(url: string, opts?: { maxBytes?: number, signal?: AbortSignal }): Promise<Buffer>,
 * }} the client facade.
 */
export function createMineruClient({ getToken, apiBase = 'https://mineru.net', fetchImpl, logger } = {}) {
  const log = logger ?? {}
  const base = String(apiBase ?? 'https://mineru.net').replace(/\/+$/, '')
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch

  /** Return the usable fetch implementation or throw a clear error. */
  function requireFetch() {
    if (typeof fetchFn !== 'function') {
      throw new MineruError('network-error', '当前运行环境没有 fetch（fetch is unavailable）', 0)
    }
    return fetchFn
  }

  /** Resolve the API token or throw `token-missing`. */
  async function requireToken() {
    let token
    try {
      token = typeof getToken === 'function' ? await getToken() : undefined
    } catch {
      token = undefined
    }
    if (typeof token !== 'string' || token.trim() === '') {
      throw new MineruError('token-missing', '需要先配置 MinerU Token（MinerU token is required）', 401)
    }
    return token.trim()
  }

  /** Absolute URL for an API path. */
  function resolveUrl(target) {
    if (typeof target === 'string' && /^https?:\/\//i.test(target)) return target
    const path = String(target)
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`
  }

  /** One JSON request with bounded retries on network/5xx failures. */
  async function requestJson(pathname, { method = 'GET', body, authToken, signal, attempts } = {}) {
    const url = resolveUrl(pathname)
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (authToken !== undefined) headers.authorization = `Bearer ${authToken}`
    const init = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (signal !== undefined) init.signal = signal
    const maxAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : method === 'GET' ? 3 : 2
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await requireFetch()(url, init)
        let json
        try {
          json = await jsonOf(response)
        } catch (parseError) {
          // A non-JSON error body is still an HTTP failure worth mapping.
          if (!okOf(response)) throw httpError(statusOf(response))
          throw parseError
        }
        return { response, json }
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        const mapped = error instanceof MineruError ? error : networkError(error)
        const retriable = mapped.httpStatus === 0 || (mapped.httpStatus >= 500 && mapped.httpStatus <= 599)
        lastError = mapped
        if (!retriable || attempt === maxAttempts) throw mapped
        await delay(200 * attempt, signal)
      }
    }
    throw lastError ?? new MineruError('network-error', 'MinerU 请求失败（Request failed）', 0)
  }

  /** POST /api/v4/file-urls/batch. */
  async function standardCreateBatch({ fileName, dataId, options = {}, signal } = {}) {
    if (typeof fileName !== 'string' || fileName.trim() === '') {
      throw new MineruError('bad-request', '缺少文件名（Missing file name）', 0)
    }
    if (typeof dataId !== 'string' || dataId.trim() === '') {
      throw new MineruError('bad-request', '缺少 data_id（Missing data_id）', 0)
    }
    const authToken = await requireToken()
    const file = { name: fileName, data_id: dataId, is_ocr: options.isOcr === true }
    if (typeof options.pageRanges === 'string' && options.pageRanges !== '') file.page_ranges = options.pageRanges
    const body = {
      files: [file],
      model_version: options.modelVersion ?? 'vlm',
      language: options.language ?? 'ch',
      enable_formula: options.enableFormula !== false,
      enable_table: options.enableTable !== false,
    }
    if (Array.isArray(options.extraFormats) && options.extraFormats.length > 0) {
      body.extra_formats = options.extraFormats.slice(0, 3)
    }
    const { response, json } = await requestJson('/api/v4/file-urls/batch', {
      method: 'POST',
      body,
      authToken,
      signal,
    })
    const data = unwrap(response, json)
    const batchId = data?.batch_id
    const uploadUrl = Array.isArray(data?.file_urls) ? data.file_urls[0] : undefined
    if (typeof batchId !== 'string' || batchId.trim() === '') {
      throw new MineruError('bad-response', 'MinerU 未返回 batch_id（Missing batch_id）', statusOf(response))
    }
    if (typeof uploadUrl !== 'string' || !/^https?:\/\//i.test(uploadUrl)) {
      throw new MineruError('bad-response', 'MinerU 未返回上传地址（Missing upload URL）', statusOf(response))
    }
    return { batchId, uploadUrl }
  }

  /** PUT the raw file bytes to the signed upload URL (no content-type header). */
  async function putBytes(uploadUrl, bytes, { signal } = {}) {
    if (typeof uploadUrl !== 'string' || !/^https?:\/\//i.test(uploadUrl)) {
      throw new MineruError('bad-request', '无效的上传地址（Invalid upload URL）', 0)
    }
    const payload = Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes) : null
    if (payload === null) throw new MineruError('bad-request', '上传内容必须是字节（Upload body must be bytes）', 0)
    let lastError
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await requireFetch()(uploadUrl, {
          method: 'PUT',
          headers: {},
          body: payload,
          signal,
        })
        const status = statusOf(response)
        if (status >= 200 && status < 300) return { status }
        await drain(response)
        throw httpError(status)
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        const mapped = error instanceof MineruError ? error : networkError(error)
        lastError = mapped
        const retriable = mapped.httpStatus === 0 || (mapped.httpStatus >= 500 && mapped.httpStatus <= 599)
        if (!retriable || attempt === 2) throw mapped
        await delay(400 * attempt, signal)
      }
    }
    throw lastError ?? new MineruError('network-error', 'MinerU 上传失败（Upload failed）', 0)
  }

  /** GET /api/v4/extract-results/batch/<batchId>. */
  async function standardBatchResult(batchId, { signal } = {}) {
    if (typeof batchId !== 'string' || batchId.trim() === '') {
      throw new MineruError('bad-request', '缺少 batch_id（Missing batch_id）', 0)
    }
    const authToken = await requireToken()
    const { response, json } = await requestJson(
      `/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
      { method: 'GET', authToken, signal },
    )
    const data = unwrap(response, json)
    const rows = Array.isArray(data?.extract_result)
      ? data.extract_result
      : Array.isArray(data)
        ? data
        : []
    const results = rows
      .filter((row) => row !== null && typeof row === 'object')
      .map((row) => {
        const progress = row.extract_progress ?? row.progress ?? {}
        const extracted = toInt(progress?.extracted_pages ?? row.extracted_pages)
        const total = toInt(progress?.total_pages ?? row.total_pages)
        return {
          dataId: typeof row.data_id === 'string' ? row.data_id : '',
          fileName: typeof row.file_name === 'string' ? row.file_name : '',
          state: typeof row.state === 'string' ? row.state.toLowerCase() : 'unknown',
          fullZipUrl: typeof row.full_zip_url === 'string' && row.full_zip_url !== '' ? row.full_zip_url : undefined,
          errMsg: typeof row.err_msg === 'string' ? row.err_msg : '',
          progress: extracted !== undefined || total !== undefined
            ? { extracted: extracted ?? 0, total: total ?? 0 }
            : null,
        }
      })
    return { batchId: typeof data?.batch_id === 'string' ? data.batch_id : batchId, results }
  }

  /** POST /api/v1/agent/parse/file (no token). */
  async function agentCreateTask({ fileName, options = {}, signal } = {}) {
    if (typeof fileName !== 'string' || fileName.trim() === '') {
      throw new MineruError('bad-request', '缺少文件名（Missing file name）', 0)
    }
    const body = {
      file_name: fileName,
      language: options.language ?? 'ch',
      enable_table: options.enableTable !== false,
      is_ocr: options.isOcr === true,
      enable_formula: options.enableFormula !== false,
    }
    if (typeof options.pageRanges === 'string' && options.pageRanges !== '') {
      body.page_range = options.pageRanges
    }
    const { response, json } = await requestJson('/api/v1/agent/parse/file', { method: 'POST', body, signal })
    const data = unwrap(response, json)
    const taskId = data?.task_id
    const uploadUrl = data?.file_url
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new MineruError('bad-response', 'MinerU 未返回 task_id（Missing task_id）', statusOf(response))
    }
    if (typeof uploadUrl !== 'string' || !/^https?:\/\//i.test(uploadUrl)) {
      throw new MineruError('bad-response', 'MinerU 未返回上传地址（Missing upload URL）', statusOf(response))
    }
    return { taskId, uploadUrl }
  }

  /** GET /api/v1/agent/parse/<taskId> (no token). */
  async function agentTaskResult(taskId, { signal } = {}) {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new MineruError('bad-request', '缺少 task_id（Missing task_id）', 0)
    }
    const { response, json } = await requestJson(
      `/api/v1/agent/parse/${encodeURIComponent(taskId)}`,
      { method: 'GET', signal },
    )
    const data = unwrap(response, json)
    const progress = data?.extract_progress ?? data?.progress
    const extracted = toInt(progress?.extracted_pages)
    const total = toInt(progress?.total_pages)
    return {
      state: typeof data?.state === 'string' ? data.state.toLowerCase() : 'unknown',
      markdownUrl:
        typeof data?.markdown_url === 'string' && data.markdown_url !== '' ? data.markdown_url : undefined,
      errMsg: typeof data?.err_msg === 'string' ? data.err_msg : '',
      errCode: data?.err_code ?? data?.code,
      progress: extracted !== undefined || total !== undefined
        ? { extracted: extracted ?? 0, total: total ?? 0 }
        : null,
    }
  }

  /** Download a result artifact (ZIP / markdown) with a hard size cap. */
  async function downloadBytes(target, { maxBytes = 512 * 1024 * 1024, signal } = {}) {
    if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
      throw new MineruError('bad-request', '无效的下载地址（Invalid download URL）', 0)
    }
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 512 * 1024 * 1024
    let lastError
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await requireFetch()(target, { method: 'GET', redirect: 'follow', signal })
        const status = statusOf(response)
        if (status < 200 || status >= 300) {
          await drain(response)
          throw httpError(status)
        }
        const declared = Number(response?.headers?.get?.('content-length'))
        if (Number.isFinite(declared) && declared > limit) {
          await drain(response)
          throw new MineruError('too-large', `解析结果超过 ${limit} 字节限制（Result too large）`, 413, { limit })
        }
        return await readBodyCapped(response, limit)
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        const mapped = error instanceof MineruError ? error : networkError(error)
        lastError = mapped
        const retriable = mapped.httpStatus === 0 || (mapped.httpStatus >= 500 && mapped.httpStatus <= 599)
        if (!retriable || attempt === 2) throw mapped
        log.warn?.('[dsh-litnotes] download retry %d for %s', attempt, mapped.code)
        await delay(500 * attempt, signal)
      }
    }
    throw lastError ?? new MineruError('network-error', 'MinerU 下载失败（Download failed）', 0)
  }

  return {
    standardCreateBatch,
    putBytes,
    standardBatchResult,
    agentCreateTask,
    agentTaskResult,
    downloadBytes,
  }
}

/** Validate a page-range expression and enforce the engine page cap. */
function normalizePageRanges(value, engine) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') {
    throw new WireError('bad-request', 'pageRanges 必须是字符串（pageRanges must be a string）')
  }
  const text = value.trim().replace(/\s+/g, '')
  if (text === '') return ''
  if (text.length > 200) throw new WireError('bad-request', '页码范围过长（Page range too long）')
  const limit = engine === 'agent' ? AGENT_LIMITS.maxPages : STANDARD_LIMITS.maxPages
  for (const part of text.split(',')) {
    const match = PAGE_RANGE_PATTERN.exec(part)
    if (match === null) {
      throw new WireError('bad-request', `页码范围格式无效：${part}（Invalid page range）`)
    }
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new WireError('bad-request', `页码范围格式无效：${part}（Invalid page range）`)
    }
    if (end > limit) {
      throw new WireError('bad-request', `页码范围超过 ${limit} 页限制（Page range exceeds the ${limit}-page limit）`)
    }
  }
  return text
}

/** Validate and normalize extra output formats (standard API only). */
function normalizeExtraFormats(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new WireError('bad-request', 'extraFormats 必须是数组（extraFormats must be an array）')
  }
  const formats = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const format = item.trim().toLowerCase()
    if (format === '' || formats.includes(format)) continue
    if (!EXTRA_FORMATS.has(format)) {
      throw new WireError('bad-request', `不支持的输出格式：${item}（Unsupported format）`)
    }
    formats.push(format)
  }
  return formats.slice(0, 3)
}

/**
 * Validate and normalize `parse.start` options against one document.
 *
 * Preconditions are checked here so a doomed task is rejected with a
 * branchable error instead of being started and failing asynchronously:
 * `token-missing` (token needed / agent limits exceeded), `too-large`,
 * `unsupported-type`, `bad-request`.
 *
 * @param {Record<string, unknown> | undefined} options - raw client options.
 * @param {{ ext?: string, originalName?: string, size?: number }} meta - document metadata.
 * @param {{ hasToken?: boolean, maxUploadBytes?: number }} ctxInfo - host capabilities.
 * @returns {{ engine: 'standard' | 'agent', params: {
 *   fileName: string, modelVersion?: string, language: string,
 *   isOcr: boolean, enableFormula: boolean, enableTable: boolean,
 *   pageRanges: string, extraFormats?: string[],
 * } }} resolved engine and API parameters.
 */
export function normalizeParseOptions(options, meta = {}, ctxInfo = {}) {
  const raw = options !== null && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const hasToken = ctxInfo.hasToken === true
  const maxUploadBytes =
    Number.isFinite(ctxInfo.maxUploadBytes) && ctxInfo.maxUploadBytes > 0
      ? Math.floor(ctxInfo.maxUploadBytes)
      : STANDARD_LIMITS.maxBytes

  const requestedEngine = raw.engine ?? 'auto'
  if (!['auto', 'standard', 'agent'].includes(requestedEngine)) {
    throw new WireError('bad-request', 'engine 必须是 auto / standard / agent（Invalid engine）')
  }
  const engine = requestedEngine === 'auto' ? (hasToken ? 'standard' : 'agent') : requestedEngine
  if (engine === 'standard' && !hasToken) {
    throw new WireError(
      'token-missing',
      '使用精准解析需要先在设置中配置 MinerU Token（Configure a MinerU token for the standard API）',
      401,
    )
  }

  const ext = typeof meta.ext === 'string' && meta.ext !== '' ? meta.ext.toLowerCase() : extOf(meta.originalName)
  const standardAllowed = SUPPORTED_EXTENSIONS.has(ext)
  const agentAllowed = AGENT_EXTENSIONS.has(ext)
  if (engine === 'standard' ? !standardAllowed : !agentAllowed) {
    if (engine === 'agent' && !agentAllowed && standardAllowed && !hasToken) {
      throw new WireError(
        'token-missing',
        '该文件类型需要 MinerU Token（精准解析）；配置 Token 后即可解析（This file type requires a MinerU token）',
        401,
      )
    }
    throw new WireError(
      'unsupported-type',
      `不支持的文件类型 ${ext || '（unknown）'}（Unsupported file type）`,
      415,
    )
  }

  const size = Number.isFinite(meta.size) && meta.size > 0 ? Math.floor(meta.size) : 0
  if (engine === 'standard') {
    const limit = Math.min(maxUploadBytes, STANDARD_LIMITS.maxBytes)
    if (size > limit) {
      throw new WireError('too-large', `文件超过 ${Math.floor(limit / (1024 * 1024))} MB 限制（File too large）`, 413, {
        limit,
      })
    }
  } else if (size > AGENT_LIMITS.maxBytes) {
    const standardLimit = Math.min(maxUploadBytes, STANDARD_LIMITS.maxBytes)
    if (!hasToken && size <= standardLimit) {
      throw new WireError(
        'token-missing',
        '文件超过轻量解析 10 MB 限制；配置 MinerU Token 后可解析最大 200 MB 文件（Configure a token for larger files）',
        401,
        { limit: AGENT_LIMITS.maxBytes },
      )
    }
    throw new WireError('too-large', '文件超过轻量解析 10 MB 限制（File exceeds the 10 MB agent limit）', 413, {
      limit: AGENT_LIMITS.maxBytes,
    })
  }

  const language =
    typeof raw.language === 'string' && /^[a-z][a-z0-9_]{1,31}$/i.test(raw.language.trim())
      ? raw.language.trim()
      : 'ch'
  const pageRanges = normalizePageRanges(raw.pageRanges, engine)
  const isOcr = raw.isOcr === true
  const enableFormula = raw.enableFormula !== false
  const enableTable = raw.enableTable !== false
  const fileName = typeof meta.originalName === 'string' && meta.originalName !== '' ? meta.originalName : `source${ext}`

  if (engine === 'agent') {
    return { engine, params: { fileName, language, isOcr, enableFormula, enableTable, pageRanges } }
  }

  let modelVersion = typeof raw.modelVersion === 'string' ? raw.modelVersion.trim() : 'vlm'
  if (modelVersion === '') modelVersion = 'vlm'
  if (!MODEL_VERSIONS.has(modelVersion)) {
    throw new WireError('bad-request', 'modelVersion 必须是 pipeline 或 vlm（Invalid model version）')
  }
  if (ext === '.html' || ext === '.htm') modelVersion = 'MinerU-HTML'
  const extraFormats = normalizeExtraFormats(raw.extraFormats)
  const params = { fileName, modelVersion, language, isOcr, enableFormula, enableTable, pageRanges }
  if (extraFormats.length > 0) params.extraFormats = extraFormats
  return { engine, params }
}

/**
 * Human-friendly one-line description of any parse failure. Safe to persist in
 * `meta.error` and display in the browser; never contains the API token.
 *
 * @param {unknown} error - thrown value.
 * @returns {string} bilingual message.
 */
export function describeMineruError(error) {
  if (error instanceof MineruError) {
    const detail = error.detail
    const base = error.message || `解析失败（Parse failed ${error.code}）`
    if (detail?.state === 'failed' && typeof detail.msg === 'string' && detail.msg !== '' && !base.includes(detail.msg)) {
      return `${base}（${detail.msg}）`
    }
    return base
  }
  if (error instanceof WireError) return error.message
  if (error?.name === 'AbortError') return ABORTED_MESSAGE
  const message = sanitize(error?.message ?? error).slice(0, 300)
  return message === '' ? '解析失败（Parse failed）' : `解析失败（Parse failed）：${message}`
}
