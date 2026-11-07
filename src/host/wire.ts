/**
 * HTTP wire helpers for the Host half.
 *
 * Every JSON API answer uses one envelope:
 *
 *     { ok: true, value: <json> }
 *     { ok: false, error: { code, message } }
 *
 * Failures are thrown as {@link WireError}; its stable `code` is what the
 * browser client branches on (for example `token-missing` opens the token
 * setup callout). Bodies are always bounded and the reader never trusts the
 * declared `content-length` alone.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** HTTP status used when a code has no more specific mapping. */
const DEFAULT_STATUS = 400

/** Stable error codes understood by the client and the HTTP dispatcher. */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  'bad-request': 400,
  'token-missing': 401,
  forbidden: 403,
  'not-found': 404,
  'method-not-allowed': 405,
  'not-parsed': 409,
  conflict: 409,
  'too-large': 413,
  'unsupported-type': 415,
  'rate-limited': 429,
  'host-error': 500,
  internal: 500,
  'ai-failed': 500,
  'llm-failed': 502,
  'llm-unavailable': 503,
  'context-too-large': 413,
  'translate-unavailable': 503,
  'local-unsupported': 415,
  'local-missing-tool': 503,
  'local-empty-text': 422,
  'local-encrypted': 422,
  'local-failed': 500,
  aborted: 499,
})

/** Message used for any unexpected internal failure. */
const INTERNAL_MESSAGE = '服务器内部错误（Internal host error）'

/** Optional safe extra detail carried on a wire failure. */
export type WireErrorMeta = Record<string, unknown>

/**
 * An error with a stable, client-branchable code.
 *
 * `code` is one of the keys of {@link STATUS_BY_CODE} for host-thrown errors;
 * MinerU API failures use their own error class and are mapped to friendly
 * messages before they reach a document's persisted `error` field.
 */
export class WireError extends Error {
  readonly code: string
  readonly status: number
  readonly meta: WireErrorMeta | undefined

  constructor(code: string, message: string, status?: number, meta?: WireErrorMeta) {
    super(message)
    this.name = 'WireError'
    this.code = code
    this.status = Number.isInteger(status) ? (status as number) : (STATUS_BY_CODE[code] ?? DEFAULT_STATUS)
    this.meta = meta !== undefined && meta !== null && typeof meta === 'object' ? meta : undefined
  }
}

/** Throw a {@link WireError} with the given code. */
export function fail(code: string, message: string, meta?: WireErrorMeta): never {
  throw new WireError(code, message, undefined, meta)
}

/**
 * Read a request body as UTF-8 text, refusing bodies larger than `maxBytes`.
 *
 * The declared `content-length` is checked first so an oversized upload is
 * refused before any bytes are buffered; the running total is still enforced
 * because a client can lie about the header or stream without one.
 */
export async function readTextBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 1024 * 1024
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    req.resume?.()
    fail('too-large', `请求体超过 ${limit} 字节限制（Request body too large）`, { limit })
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > limit) {
        req.resume?.()
        fail('too-large', `请求体超过 ${limit} 字节限制（Request body too large）`, { limit })
      }
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof WireError) throw error
    fail('bad-request', '读取请求体失败（Failed to read request body）')
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/**
 * Read a JSON object body. An empty body counts as `{}`; arrays and scalars
 * are rejected because every API method takes a plain object payload.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 2 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const text = await readTextBody(req, maxBytes)
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('bad-request', '请求体不是合法 JSON（Malformed JSON body）')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('bad-request', '请求体必须是 JSON 对象（Request body must be a JSON object）')
  }
  return parsed as Record<string, unknown>
}

/**
 * Write a JSON response. Safe to call once per request; duplicate calls are
 * ignored so a late failure cannot corrupt a response that already started.
 */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  if (!res || res.writableEnded || res.headersSent) return
  let body: string
  try {
    body = JSON.stringify(value) ?? 'null'
  } catch {
    body = JSON.stringify({ ok: false, error: { code: 'host-error', message: INTERNAL_MESSAGE } })
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

/** Write a success envelope `{ ok: true, value }`. */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/**
 * Write a failure envelope, mapping {@link WireError} and known coded errors
 * to their HTTP status. Unknown errors never leak their message to the client.
 */
export function writeError(res: ServerResponse, error: unknown): void {
  let status = 500
  let code = 'host-error'
  let message = INTERNAL_MESSAGE
  let meta: unknown
  if (error instanceof WireError) {
    code = error.code
    status = Number.isInteger(error.status) ? error.status : (STATUS_BY_CODE[error.code] ?? 500)
    message = error.message || INTERNAL_MESSAGE
    meta = error.meta
  } else if (error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    const candidate = error as { code: string; message?: unknown }
    const mapped = STATUS_BY_CODE[candidate.code]
    if (mapped !== undefined) {
      code = candidate.code
      status = mapped
      message = typeof candidate.message === 'string' && candidate.message ? candidate.message : INTERNAL_MESSAGE
    }
  }
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500
  const envelope: { ok: false; error: { code: string; message: string; meta?: unknown } } = {
    ok: false,
    error: { code, message },
  }
  if (meta !== undefined && meta !== null && typeof meta === 'object') envelope.error.meta = meta
  writeJson(res, status, envelope)
}

/**
 * Read a required, trimmed, non-empty string field from a payload.
 *
 * @throws {WireError} `bad-request` when absent, non-string, or blank.
 */
export function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail('bad-request', `缺少参数 ${key}（Missing parameter: ${key}）`)
  }
  return value.trim()
}

/**
 * Decode a URI component, returning the raw input when it is not valid
 * percent-encoding (a bad header must never crash a route).
 */
export function safeDecode(value: unknown): string {
  const raw =
    typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Assert that a value looks like a UUID. Used before any filesystem path is
 * built from client input; a non-UUID can never address a document directory.
 *
 * @throws {WireError} `bad-request` for ids outside the UUID grammar.
 */
export function requireUuid(id: unknown): string {
  if (typeof id !== 'string') fail('bad-request', '无效的文档 ID（Invalid document id）')
  const value = id.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    fail('bad-request', '无效的文档 ID（Invalid document id）')
  }
  return value
}

/** Whether the value is a plain JSON object (not an array, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/** Clamp an integer option into a range, falling back on invalid input. */
export function integerOption(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}
