/**
 * MinerU HTTP client and parse-option engine policy.
 *
 * Two MinerU APIs are supported (frozen 1.0.0 behaviour):
 *
 *  - **standard** (`/api/v4`, Bearer token): batch upload → poll → full ZIP
 *    result (`full.md`, `*_content_list.json`, `images/**`).
 *  - **agent** (`/api/v1`, no token): signed upload → poll → markdown URL.
 *
 * `fetchImpl` is injectable so unit and flow tests run fully offline. Every
 * method throws {@link MineruError} with the upstream API code, HTTP status and
 * a friendly bilingual message that never contains the API token.
 *
 * The module also owns the engine policy ({@link normalizeParseOptions}) and
 * the one-line error description ({@link describeMineruError}) used to persist a
 * document's `error` field; both are consumed by the service layer and the
 * parse manager, never re-implemented there.
 *
 * @module host/parse/mineru
 */

import type { DocumentMeta, ParseOptions, ParseProgress } from '../../shared/model.ts'
import type { ParseEngine } from '../../shared/constants.ts'
import { SUPPORTED_EXTENSIONS } from '../../shared/constants.ts'
import type { ParseOptionContext } from '../contracts.ts'
import type { Logger } from '../host-services.ts'
import { WireError } from '../wire.ts'

/** Standard (precise) API limits, mirrored from the frozen MinerU contract. */
export const STANDARD_LIMITS = Object.freeze({ maxBytes: 200 * 1024 * 1024, maxPages: 200 })
/** Agent (lightweight) API limits, mirrored from the frozen MinerU contract. */
export const AGENT_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxPages: 20 })
/** MinerU `language` values offered by the UI. */
export const MINERU_LANGUAGES: readonly string[] = Object.freeze([
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
const AGENT_EXTENSIONS: ReadonlySet<string> = new Set([
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

/** Extensions the standard API accepts (shared constant, as a lookup set). */
const STANDARD_EXTENSIONS: ReadonlySet<string> = new Set(SUPPORTED_EXTENSIONS)

/** Accepted `model_version` values (the standard API also takes HTML sources). */
const MODEL_VERSIONS: ReadonlySet<string> = new Set(['pipeline', 'vlm', 'MinerU-HTML'])
/** Accepted extra output formats from the standard API. */
const EXTRA_FORMATS: ReadonlySet<string> = new Set(['docx', 'html', 'latex'])
/** Sanity pattern for one page-range component. */
const PAGE_RANGE_PATTERN = /^(\d+)(?:-(\d+))?$/
/** Per-request response cap for small JSON control responses. */
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024
/** Abort message persisted on a cancelled task. */
const ABORTED_MESSAGE = '解析已取消（Cancelled）'

/** Friendly bilingual descriptions keyed by MinerU API code. */
const API_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
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

/** Safe, structured detail attached to a {@link MineruError}. */
export interface MineruErrorDetail {
  /** Upstream MinerU API code, when the failure carried one. */
  apiCode?: string
  /** Sanitized upstream message. */
  msg?: string
  /** Terminal upstream task state, when known. */
  state?: string
  /** Configured byte limit for limit failures. */
  limit?: number
  /** Any additional safe diagnostic fields (never the API token). */
  [key: string]: unknown
}

/**
 * Error raised by the MinerU client, the parse manager and the local engine.
 *
 * `code` is the upstream MinerU API code when one is known (`A0202`,
 * `-60005`, …), otherwise a client-side code (`network-error`, `bad-response`,
 * `http-429`, `aborted`, `parse-failed`, `timeout`). `message` is always safe to
 * persist in `meta.error` and show in the browser; the API token is never
 * included. `detail` carries structured, safe context (never the token).
 */
export class MineruError extends Error {
  /** Upstream API code or client-side error code. */
  readonly code: string
  /** Upstream HTTP status when known (0 for transport failures). */
  readonly httpStatus: number
  /** Safe structured detail (never contains the API token). */
  readonly detail: MineruErrorDetail | undefined

  constructor(code: string, message: string, httpStatus = 0, detail?: MineruErrorDetail) {
    super(message)
    this.name = 'MineruError'
    this.code = String(code)
    this.httpStatus = Number.isFinite(httpStatus) ? httpStatus : 0
    this.detail = detail ?? undefined
  }
}

/** Normalized parameters of one remote parse (standard or agent API). */
export type MineruParams = {
  fileName: string
  language: string
  /** Requested local provider (`auto` when the engine decides). */
  localProvider?: string
  modelVersion?: string
  isOcr?: boolean
  enableFormula?: boolean
  enableTable?: boolean
  pageRanges?: string
  extraFormats?: string[]
}

/** Result of {@link normalizeParseOptions}: an engine plus its API parameters. */
export type NormalizedParsePlan = {
  engine: ParseEngine
  params: MineruParams
}

/** Standard-API batch row (camelCase projection of one MinerU result row). */
export interface StandardBatchRow {
  dataId: string
  fileName: string
  state: string
  fullZipUrl?: string
  errMsg: string
  progress: ParseProgress | null
}

/** Standard-API batch snapshot. */
export interface StandardBatchSnapshot {
  batchId: string
  results: StandardBatchRow[]
}

/** Agent-API task outcome. */
export interface AgentTaskOutcome {
  state: string
  markdownUrl?: string
  errMsg: string
  errCode?: unknown
  progress: ParseProgress | null
}

/** Streaming body shape read by the capped downloader. */
export interface MineruResponseBody {
  getReader?: () => ReadableStreamDefaultReader<Uint8Array>
  cancel?: () => Promise<void>
}

/**
 * Structural HTTP response used by the client.
 *
 * A real `Response` satisfies it; fakes only need the members their test path
 * consumes, mirroring the frozen 1.0.0 duck typing.
 */
export interface MineruResponse {
  status: number
  ok?: boolean
  headers?: { get?: (name: string) => string | null }
  json?: () => Promise<unknown>
  text?: () => Promise<string>
  arrayBuffer?: () => Promise<ArrayBuffer>
  body?: MineruResponseBody | null
}

/** Injected fetch implementation. */
export type MineruFetch = (url: string, init: RequestInit) => Promise<MineruResponse>

/** Dependencies of {@link createMineruClient}. */
export interface CreateMineruClientOptions {
  /** Resolve the configured API token (undefined / empty = not configured). */
  getToken?: () => Promise<string | undefined> | string | undefined
  /** API origin, default `https://mineru.net`. */
  apiBase?: string
  /** Injected fetch implementation (defaults to `globalThis.fetch`). */
  fetchImpl?: MineruFetch
  /** Host logger (warnings only). */
  logger?: Logger
}

/** Normalized document metadata `normalizeParseOptions` reads. */
export interface MineruMeta {
  ext?: string
  originalName?: string
  size?: number
}

/** The client facade consumed by the parse manager. */
export interface MineruClient {
  standardCreateBatch: (input: {
    fileName: string
    dataId: string
    options?: Record<string, unknown>
    signal?: AbortSignal
  }) => Promise<{ batchId: string; uploadUrl: string }>
  putBytes: (uploadUrl: string, bytes: Uint8Array, opts?: { signal?: AbortSignal }) => Promise<{ status: number }>
  standardBatchResult: (batchId: string, opts?: { signal?: AbortSignal }) => Promise<StandardBatchSnapshot>
  agentCreateTask: (input: {
    fileName: string
    options?: Record<string, unknown>
    signal?: AbortSignal
  }) => Promise<{ taskId: string; uploadUrl: string }>
  agentTaskResult: (taskId: string, opts?: { signal?: AbortSignal }) => Promise<AgentTaskOutcome>
  downloadBytes: (url: string, opts?: { maxBytes?: number; signal?: AbortSignal }) => Promise<Buffer>
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Empty detail-safe fallback error used where no upstream data exists. */
function abortError(): MineruError {
  const error = new MineruError('aborted', ABORTED_MESSAGE, 0)
  error.name = 'AbortError'
  return error
}

/** Strip control characters and collapse whitespace from an upstream message. */
function sanitize(text: unknown): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Narrow a value to a plain record without trusting its shape. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** File extension (with dot, lowercase) of a name, or ''. */
function extensionOf(name: unknown): string {
  if (typeof name !== 'string') return ''
  const match = /(\.[^./\\]+)$/.exec(name)
  return match?.[1]?.toLowerCase() ?? ''
}

/** Build the error for an upstream response whose `code` / `err_code` is not 0. */
function apiCodeError(apiCode: unknown, rawMessage: unknown, httpStatus: number): MineruError {
  const code = String(apiCode)
  const mapped = API_CODE_MESSAGES[code]
  const message = sanitize(rawMessage).slice(0, 500)
  const detail: MineruErrorDetail = { apiCode: code, msg: message }
  const friendly = mapped ?? `MinerU 接口错误（MinerU API error ${code}）`
  return new MineruError(code, message === '' ? friendly : `${friendly}（${message}）`, httpStatus, detail)
}

/** Build the error for an HTTP failure without a usable API code. */
function httpError(status: number): MineruError {
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
function networkError(error: unknown): MineruError {
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (name === 'AbortError' || code === 'ABORT_ERR') return abortError()
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const detail = sanitize(raw)
    .replace(/\?[^\s]*/g, '?…')
    .slice(0, 300)
  return new MineruError('network-error', `无法连接 MinerU 服务（Cannot reach MinerU）${detail ? `：${detail}` : ''}`, 0)
}

/** Abortable delay used between retries. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Read the HTTP status of a response-like object. */
function statusOf(response: MineruResponse): number {
  const status = Number(response.status)
  return Number.isFinite(status) && status > 0 ? status : 200
}

/** Whether a response-like object reports success. */
function okOf(response: MineruResponse): boolean {
  if (typeof response.ok === 'boolean') return response.ok
  const status = statusOf(response)
  return status >= 200 && status < 300
}

/** Read a response-like object as JSON, mapping malformed bodies to `bad-response`. */
async function jsonOf(response: MineruResponse): Promise<unknown> {
  const status = statusOf(response)
  if (typeof response.json === 'function') {
    try {
      return await response.json()
    } catch {
      throw new MineruError('bad-response', 'MinerU 返回了无法解析的响应（Invalid JSON response）', status)
    }
  }
  if (typeof response.text === 'function') {
    const text = await response.text()
    if (text.length > MAX_JSON_RESPONSE_BYTES) {
      throw new MineruError('bad-response', 'MinerU 响应过大（Response too large）', status)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new MineruError('bad-response', 'MinerU 返回了无法解析的响应（Invalid JSON response）', status)
    }
  }
  throw new MineruError('bad-response', '无法读取 MinerU 响应（Cannot read response）', status)
}

/**
 * Unwrap the standard `{ code, data, msg }` envelope of a response.
 *
 * @throws {MineruError} on HTTP failure, non-zero API code or an unusable body.
 */
function unwrap(response: MineruResponse, json: unknown): unknown {
  const status = statusOf(response)
  const record = recordOf(json)
  if (record === null) {
    if (!okOf(response)) throw httpError(status)
    throw new MineruError('bad-response', 'MinerU 返回了意外的响应（Unexpected response）', status)
  }
  const apiCode = record.code ?? record.err_code
  const hasCode = apiCode !== undefined && apiCode !== null
  if (!okOf(response) || (hasCode && String(apiCode) !== '0')) {
    if (hasCode) throw apiCodeError(apiCode, record.msg ?? record.message ?? record.err_msg, status)
    throw httpError(status)
  }
  return record.data === undefined ? {} : record.data
}

/** Drain a response body so its socket can be reused. */
async function drain(response: MineruResponse): Promise<void> {
  try {
    const body = response.body
    if (body !== null && body !== undefined && typeof body.cancel === 'function') await body.cancel()
    else if (typeof response.text === 'function') await response.text()
  } catch {
    /* best effort */
  }
}

/** Convert a value to a non-negative integer, otherwise undefined. */
function toInt(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined
}

/** Read a response body with a hard byte cap. */
async function readBodyCapped(response: MineruResponse, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const body = response.body
  if (body !== null && body !== undefined && typeof body.getReader === 'function' && typeof ReadableStream !== 'undefined') {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
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
        reader.releaseLock()
      } catch {
        /* ignore */
      }
    }
    return Buffer.concat(chunks, total)
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw new MineruError('too-large', `解析结果超过 ${maxBytes} 字节限制（Result too large）`, 413, {
        limit: maxBytes,
      })
    }
    return buffer
  }
  if (typeof response.text === 'function') {
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
 * @param errCode - upstream `err_code` / error code.
 * @param errMsg - upstream `err_msg`.
 * @returns the mapped, token-free failure.
 */
export function failureFromApi(errCode: unknown, errMsg: unknown): MineruError {
  const code = errCode === undefined || errCode === null || errCode === '' ? 'parse-failed' : String(errCode)
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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Read an injected fetch, falling back to the runtime `fetch`. */
function resolveFetch(fetchImpl: MineruFetch | undefined): MineruFetch | undefined {
  if (typeof fetchImpl === 'function') return fetchImpl
  if (typeof globalThis.fetch === 'function') {
    return (url, init) => globalThis.fetch(url, init) as Promise<MineruResponse>
  }
  return undefined
}

/**
 * Create the MinerU HTTP client.
 *
 * @param options - token accessor, API base override, injectable fetch and logger.
 * @returns the client facade.
 */
export function createMineruClient(options: CreateMineruClientOptions = {}): MineruClient {
  const log: Logger = options.logger ?? {}
  const base = String(options.apiBase ?? 'https://mineru.net').replace(/\/+$/, '')
  const fetchFn = resolveFetch(options.fetchImpl)

  /** Return the usable fetch implementation or throw a clear error. */
  function requireFetch(): MineruFetch {
    if (fetchFn === undefined) {
      throw new MineruError('network-error', '当前运行环境没有 fetch（fetch is unavailable）', 0)
    }
    return fetchFn
  }

  /** Resolve the API token or throw `token-missing`. */
  async function requireToken(): Promise<string> {
    let token: unknown
    try {
      token = typeof options.getToken === 'function' ? await options.getToken() : undefined
    } catch {
      token = undefined
    }
    if (typeof token !== 'string' || token.trim() === '') {
      throw new MineruError('token-missing', '需要先配置 MinerU Token（MinerU token is required）', 401)
    }
    return token.trim()
  }

  /** Absolute URL for an API path. */
  function resolveUrl(target: string): string {
    if (/^https?:\/\//i.test(target)) return target
    return `${base}${target.startsWith('/') ? '' : '/'}${target}`
  }

  /** One JSON request with bounded retries on network/5xx failures. */
  async function requestJson(
    pathname: string,
    requestOptions: {
      method?: 'GET' | 'POST'
      body?: Record<string, unknown>
      authToken?: string
      signal?: AbortSignal
      attempts?: number
    } = {},
  ): Promise<{ response: MineruResponse; json: unknown }> {
    const { method = 'GET', body, authToken, signal, attempts } = requestOptions
    const url = resolveUrl(pathname)
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (authToken !== undefined) headers.authorization = `Bearer ${authToken}`
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (signal !== undefined) init.signal = signal
    const maxAttempts = typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0
      ? attempts
      : method === 'GET'
        ? 3
        : 2
    let lastError: MineruError | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await requireFetch()(url, init)
        let json: unknown
        try {
          json = await jsonOf(response)
        } catch (parseError) {
          // A non-JSON error body is still an HTTP failure worth mapping.
          if (!okOf(response)) throw httpError(statusOf(response))
          if (parseError instanceof MineruError) throw parseError
          throw new MineruError('bad-response', 'MinerU 返回了无法解析的响应（Invalid JSON response）', statusOf(response))
        }
        return { response, json }
      } catch (error) {
        if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw abortError()
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
  async function standardCreateBatch(input: {
    fileName: string
    dataId: string
    options?: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<{ batchId: string; uploadUrl: string }> {
    const { fileName, dataId, signal } = input
    const requestOptions = input.options ?? {}
    if (typeof fileName !== 'string' || fileName.trim() === '') {
      throw new MineruError('bad-request', '缺少文件名（Missing file name）', 0)
    }
    if (typeof dataId !== 'string' || dataId.trim() === '') {
      throw new MineruError('bad-request', '缺少 data_id（Missing data_id）', 0)
    }
    const authToken = await requireToken()
    const file: Record<string, unknown> = { name: fileName, data_id: dataId, is_ocr: requestOptions.isOcr === true }
    if (typeof requestOptions.pageRanges === 'string' && requestOptions.pageRanges !== '') {
      file.page_ranges = requestOptions.pageRanges
    }
    const body: Record<string, unknown> = {
      files: [file],
      model_version: requestOptions.modelVersion ?? 'vlm',
      language: requestOptions.language ?? 'ch',
      enable_formula: requestOptions.enableFormula !== false,
      enable_table: requestOptions.enableTable !== false,
    }
    if (Array.isArray(requestOptions.extraFormats) && requestOptions.extraFormats.length > 0) {
      body.extra_formats = requestOptions.extraFormats.slice(0, 3)
    }
    const { response, json } = await requestJson('/api/v4/file-urls/batch', {
      method: 'POST',
      body,
      authToken,
      signal,
    })
    const data = recordOf(unwrap(response, json))
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
  async function putBytes(
    uploadUrl: string,
    bytes: Uint8Array,
    putOptions: { signal?: AbortSignal } = {},
  ): Promise<{ status: number }> {
    const { signal } = putOptions
    if (typeof uploadUrl !== 'string' || !/^https?:\/\//i.test(uploadUrl)) {
      throw new MineruError('bad-request', '无效的上传地址（Invalid upload URL）', 0)
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new MineruError('bad-request', '上传内容必须是字节（Upload body must be bytes）', 0)
    }
    const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    // Node's `Buffer` is a `Uint8Array`; the DOM `BodyInit` type only admits
    // `ArrayBuffer`-backed views, so narrow at this single fetch boundary.
    const body = payload as unknown as BodyInit
    let lastError: MineruError | undefined
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await requireFetch()(uploadUrl, {
          method: 'PUT',
          headers: {},
          body,
          signal,
        })
        const status = statusOf(response)
        if (status >= 200 && status < 300) return { status }
        await drain(response)
        throw httpError(status)
      } catch (error) {
        if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw abortError()
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
  async function standardBatchResult(
    batchId: string,
    resultOptions: { signal?: AbortSignal } = {},
  ): Promise<StandardBatchSnapshot> {
    if (typeof batchId !== 'string' || batchId.trim() === '') {
      throw new MineruError('bad-request', '缺少 batch_id（Missing batch_id）', 0)
    }
    const authToken = await requireToken()
    const { response, json } = await requestJson(
      `/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
      { method: 'GET', authToken, signal: resultOptions.signal },
    )
    const data = recordOf(unwrap(response, json))
    const rowsRaw: unknown[] = Array.isArray(data?.extract_result)
      ? data.extract_result
      : Array.isArray(data)
        ? data
        : []
    const results: StandardBatchRow[] = []
    for (const raw of rowsRaw) {
      const row = recordOf(raw)
      if (row === null) continue
      const progressSource = recordOf(row.extract_progress) ?? recordOf(row.progress)
      const extracted = toInt(progressSource?.extracted_pages ?? row.extracted_pages)
      const total = toInt(progressSource?.total_pages ?? row.total_pages)
      results.push({
        dataId: typeof row.data_id === 'string' ? row.data_id : '',
        fileName: typeof row.file_name === 'string' ? row.file_name : '',
        state: typeof row.state === 'string' ? row.state.toLowerCase() : 'unknown',
        fullZipUrl: typeof row.full_zip_url === 'string' && row.full_zip_url !== '' ? row.full_zip_url : undefined,
        errMsg: typeof row.err_msg === 'string' ? row.err_msg : '',
        progress:
          extracted !== undefined || total !== undefined
            ? { extracted: extracted ?? 0, total: total ?? 0 }
            : null,
      })
    }
    return { batchId: typeof data?.batch_id === 'string' ? data.batch_id : batchId, results }
  }

  /** POST /api/v1/agent/parse/file (no token). */
  async function agentCreateTask(input: {
    fileName: string
    options?: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<{ taskId: string; uploadUrl: string }> {
    const { fileName, signal } = input
    const requestOptions = input.options ?? {}
    if (typeof fileName !== 'string' || fileName.trim() === '') {
      throw new MineruError('bad-request', '缺少文件名（Missing file name）', 0)
    }
    const body: Record<string, unknown> = {
      file_name: fileName,
      language: requestOptions.language ?? 'ch',
      enable_table: requestOptions.enableTable !== false,
      is_ocr: requestOptions.isOcr === true,
      enable_formula: requestOptions.enableFormula !== false,
    }
    if (typeof requestOptions.pageRanges === 'string' && requestOptions.pageRanges !== '') {
      body.page_range = requestOptions.pageRanges
    }
    const { response, json } = await requestJson('/api/v1/agent/parse/file', { method: 'POST', body, signal })
    const data = recordOf(unwrap(response, json))
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
  async function agentTaskResult(
    taskId: string,
    resultOptions: { signal?: AbortSignal } = {},
  ): Promise<AgentTaskOutcome> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new MineruError('bad-request', '缺少 task_id（Missing task_id）', 0)
    }
    const { response, json } = await requestJson(`/api/v1/agent/parse/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      signal: resultOptions.signal,
    })
    const data = recordOf(unwrap(response, json))
    const progressSource = recordOf(data?.extract_progress) ?? recordOf(data?.progress)
    const extracted = toInt(progressSource?.extracted_pages)
    const total = toInt(progressSource?.total_pages)
    return {
      state: typeof data?.state === 'string' ? data.state.toLowerCase() : 'unknown',
      markdownUrl:
        typeof data?.markdown_url === 'string' && data.markdown_url !== '' ? data.markdown_url : undefined,
      errMsg: typeof data?.err_msg === 'string' ? data.err_msg : '',
      errCode: data?.err_code ?? data?.code,
      progress:
        extracted !== undefined || total !== undefined
          ? { extracted: extracted ?? 0, total: total ?? 0 }
          : null,
    }
  }

  /** Download a result artifact (ZIP / markdown) with a hard size cap. */
  async function downloadBytes(
    target: string,
    downloadOptions: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<Buffer> {
    const { signal } = downloadOptions
    const maxBytes = downloadOptions.maxBytes
    if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
      throw new MineruError('bad-request', '无效的下载地址（Invalid download URL）', 0)
    }
    const limit = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : 512 * 1024 * 1024
    let lastError: MineruError | undefined
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await requireFetch()(target, { method: 'GET', redirect: 'follow', signal })
        const status = statusOf(response)
        if (status < 200 || status >= 300) {
          await drain(response)
          throw httpError(status)
        }
        const declared = Number(response.headers?.get?.('content-length'))
        if (Number.isFinite(declared) && declared > limit) {
          await drain(response)
          throw new MineruError('too-large', `解析结果超过 ${limit} 字节限制（Result too large）`, 413, { limit })
        }
        return await readBodyCapped(response, limit)
      } catch (error) {
        if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw abortError()
        const mapped = error instanceof MineruError ? error : networkError(error)
        lastError = mapped
        const retriable = mapped.httpStatus === 0 || (mapped.httpStatus >= 500 && mapped.httpStatus <= 599)
        if (!retriable || attempt === 2) throw mapped
        log.warn?.(`[dsh-litnotes] download retry ${attempt} for ${mapped.code}`)
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

// ---------------------------------------------------------------------------
// Engine policy
// ---------------------------------------------------------------------------

/** Validate a page-range expression and enforce the engine page cap. */
function normalizePageRanges(value: unknown, engine: ParseEngine): string {
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
function normalizeExtraFormats(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new WireError('bad-request', 'extraFormats 必须是数组（extraFormats must be an array）')
  }
  const formats: string[] = []
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

/** Read a positive integer from an unknown value, or a fallback. */
function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  return fallback
}

/**
 * Validate and normalize `parse.start` options against one document.
 *
 * Preconditions are checked here so a doomed task is rejected with a branchable
 * error instead of being started and failing asynchronously: `token-missing`
 * (token needed / agent limits exceeded), `too-large`, `unsupported-type`,
 * `bad-request`, `local-unsupported`, `local-missing-tool`.
 *
 * Engine policy (`auto`): a stored MinerU token keeps using the precise
 * standard API; without a token the local engine wins when it supports the
 * file (privacy: no upload), otherwise the token-free cloud agent API is used
 * unless `autoAllowAgentFallback` is disabled.
 *
 * @param options - raw client options (any non-object value is treated as `{}`).
 * @param meta - document metadata (extension, original name, byte size).
 * @param context - host capabilities (token, local engine, limits).
 * @returns the resolved engine and its API parameters.
 * @throws {WireError} when the request is invalid for the chosen engine.
 */
export function normalizeParseOptions(
  options: unknown,
  meta: MineruMeta = {},
  context: ParseOptionContext = {
    hasToken: false,
    maxUploadBytes: STANDARD_LIMITS.maxBytes,
    localSupported: false,
    localMaxBytes: 0,
    autoAllowAgentFallback: true,
  },
): NormalizedParsePlan {
  const raw: Record<string, unknown> =
    options !== null && typeof options === 'object' && !Array.isArray(options)
      ? (options as Record<string, unknown>)
      : {}
  const hasToken = context.hasToken === true
  const localSupported = context.localSupported === true
  const autoAllowAgentFallback = context.autoAllowAgentFallback !== false
  const maxUploadBytes = positiveInteger(context.maxUploadBytes, STANDARD_LIMITS.maxBytes)

  const requestedEngine = raw.engine ?? 'auto'
  if (
    typeof requestedEngine !== 'string' ||
    !['auto', 'standard', 'agent', 'local'].includes(requestedEngine)
  ) {
    throw new WireError('bad-request', 'engine 必须是 auto / standard / agent / local（Invalid engine）')
  }
  let engine: ParseEngine
  if (requestedEngine === 'auto') {
    if (hasToken) engine = 'standard'
    else if (localSupported) engine = 'local'
    else if (!autoAllowAgentFallback) {
      throw new WireError(
        'token-missing',
        '未配置 MinerU Token，且本地解析不支持该文件；云端回退已关闭。请配置 Token 或改用支持的文件（No token; local parsing does not support this file and cloud fallback is disabled）',
        401,
      )
    } else engine = 'agent'
  } else {
    engine = requestedEngine === 'standard' || requestedEngine === 'agent' || requestedEngine === 'local'
      ? requestedEngine
      : 'agent'
  }
  if (engine === 'standard' && !hasToken) {
    throw new WireError(
      'token-missing',
      '使用精准解析需要先在设置中配置 MinerU Token（Configure a MinerU token for the standard API）',
      401,
    )
  }

  const ext = typeof meta.ext === 'string' && meta.ext !== '' ? meta.ext.toLowerCase() : extensionOf(meta.originalName)
  const fileName =
    typeof meta.originalName === 'string' && meta.originalName !== '' ? meta.originalName : `source${ext}`
  const language =
    typeof raw.language === 'string' && /^[a-z][a-z0-9_]{1,31}$/i.test(raw.language.trim())
      ? raw.language.trim()
      : 'ch'

  if (engine === 'local') {
    if (!localSupported) {
      const reason = typeof context.localReason === 'string' ? context.localReason : ''
      const missingTool = /unavailable|disabled|not mounted/i.test(reason)
      throw new WireError(
        missingTool ? 'local-missing-tool' : 'local-unsupported',
        missingTool
          ? '本地解析工具不可用；请配置 MinerU Token 或改用云端解析（Local parsing tool unavailable）'
          : `本地解析不支持这种文件 ${ext || '（unknown）'}；可用云端解析或配置 Token（Local parsing does not support this file）`,
        missingTool ? 503 : 415,
      )
    }
    const localLimit = positiveInteger(context.localMaxBytes, 0)
    const size = positiveInteger(meta.size, 0)
    if (localLimit > 0 && size > localLimit) {
      throw new WireError(
        'too-large',
        `文件超过本地解析上限（File exceeds the local limit of ${Math.floor(localLimit / (1024 * 1024))} MB）`,
        413,
        { limit: localLimit },
      )
    }
    return {
      engine: 'local',
      params: {
        fileName,
        language,
        localProvider: typeof raw.localProvider === 'string' && raw.localProvider !== '' ? raw.localProvider : 'auto',
      },
    }
  }

  const standardAllowed = STANDARD_EXTENSIONS.has(ext)
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

  const size = positiveInteger(meta.size, 0)
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

  const pageRanges = normalizePageRanges(raw.pageRanges, engine)
  const isOcr = raw.isOcr === true
  const enableFormula = raw.enableFormula !== false
  const enableTable = raw.enableTable !== false

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
  const params: MineruParams = { fileName, modelVersion, language, isOcr, enableFormula, enableTable, pageRanges }
  if (extraFormats.length > 0) params.extraFormats = extraFormats
  return { engine, params }
}

/**
 * Human-friendly one-line description of any parse failure. Safe to persist in
 * `meta.error` and display in the browser; never contains the API token.
 *
 * @param error - thrown value.
 * @returns bilingual message.
 */
export function describeMineruError(error: unknown): string {
  if (error instanceof MineruError) {
    const detail = error.detail
    const base = error.message || `解析失败（Parse failed ${error.code}）`
    if (
      detail?.state === 'failed' &&
      typeof detail.msg === 'string' &&
      detail.msg !== '' &&
      !base.includes(detail.msg)
    ) {
      return `${base}（${detail.msg}）`
    }
    return base
  }
  if (error instanceof WireError) return error.message
  if (error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError') {
    return ABORTED_MESSAGE
  }
  const message = sanitize(error instanceof Error ? error.message : error).slice(0, 300)
  return message === '' ? '解析失败（Parse failed）' : `解析失败（Parse failed）：${message}`
}

/**
 * Type-level check that the local normalizer matches the Lead-owned contract.
 *
 * `NormalizeParseOptions` takes `ParseOptions | undefined`; this function must
 * stay assignable to it (a compile-time assertion, no runtime cost).
 */
export const _normalizeParseOptionsTypecheck: (
  options: ParseOptions | undefined,
  meta: DocumentMeta,
  context: ParseOptionContext,
) => NormalizedParsePlan = normalizeParseOptions
