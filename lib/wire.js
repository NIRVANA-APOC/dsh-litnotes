/**
 * HTTP wire helpers for the dsh-litnotes Host half.
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
 *
 * @module lib/wire
 */

/** HTTP status used when a code has no more specific mapping. */
const DEFAULT_STATUS = 400

/**
 * Stable error codes understood by the client and the HTTP dispatcher.
 * Values are the default HTTP status for each code.
 * @type {Readonly<Record<string, number>>}
 */
export const STATUS_BY_CODE = Object.freeze({
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
  'translate-unavailable': 503,
})

/** Message used for any unexpected internal failure. */
const INTERNAL_MESSAGE = '服务器内部错误（Internal host error）'

/**
 * An error with a stable, client-branchable code.
 *
 * `code` is one of the keys of {@link STATUS_BY_CODE} for host-thrown errors;
 * MinerU API codes use their own `MineruError` and are mapped to friendly
 * messages before they reach a document's persisted `error` field.
 */
export class WireError extends Error {
  /**
   * @param {string} code - stable machine-readable error code.
   * @param {string} message - human readable bilingual message.
   * @param {number} [status] - HTTP status; defaults from the code.
   * @param {Record<string, unknown>} [meta] - optional safe extra detail.
   */
  constructor(code, message, status = STATUS_BY_CODE[code] ?? DEFAULT_STATUS, meta) {
    super(message)
    this.name = 'WireError'
    this.code = code
    this.status = Number.isInteger(status) ? status : DEFAULT_STATUS
    if (meta !== undefined && meta !== null && typeof meta === 'object') this.meta = meta
  }
}

/** Throw a {@link WireError} with the given code. */
function fail(code, message, meta) {
  throw new WireError(code, message, undefined, meta)
}

/**
 * Read a request body as UTF-8 text, refusing bodies larger than `maxBytes`.
 *
 * The declared `content-length` is checked first so an oversized upload is
 * refused before any bytes are buffered; the running total is still enforced
 * because a client can lie about the header or stream without one.
 *
 * @param {import('node:http').IncomingMessage} req - request stream.
 * @param {number} [maxBytes] - hard cap in bytes.
 * @returns {Promise<string>} the decoded body.
 * @throws {WireError} `too-large` when the cap is exceeded.
 */
export async function readTextBody(req, maxBytes = 1024 * 1024) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 1024 * 1024
  const declared = Number(req?.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    req.resume?.()
    fail('too-large', `请求体超过 ${limit} 字节限制（Request body too large）`, { limit })
  }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
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
 *
 * @param {import('node:http').IncomingMessage} req - request stream.
 * @param {number} [maxBytes] - hard cap in bytes.
 * @returns {Promise<Record<string, unknown>>} parsed payload.
 * @throws {WireError} `bad-request` for invalid JSON / non-object payloads.
 */
export async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const text = await readTextBody(req, maxBytes)
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('bad-request', '请求体不是合法 JSON（Malformed JSON body）')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('bad-request', '请求体必须是 JSON 对象（Request body must be a JSON object）')
  }
  return parsed
}

/**
 * Write a JSON response. Safe to call once per request; duplicate calls are
 * ignored so a late failure cannot corrupt a response that already started.
 *
 * @param {import('node:http').ServerResponse} res - response sink.
 * @param {number} status - HTTP status code.
 * @param {unknown} value - JSON-serializable body.
 */
export function writeJson(res, status, value) {
  if (!res || res.writableEnded || res.headersSent) return
  let body
  try {
    body = JSON.stringify(value)
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

/**
 * Write a success envelope `{ ok: true, value }`.
 *
 * @param {import('node:http').ServerResponse} res - response sink.
 * @param {unknown} value - JSON-serializable result.
 */
export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/**
 * Write a failure envelope, mapping {@link WireError} and known coded errors
 * to their HTTP status. Unknown errors never leak their message to the client.
 *
 * @param {import('node:http').ServerResponse} res - response sink.
 * @param {unknown} error - thrown value.
 */
export function writeError(res, error) {
  let status = 500
  let code = 'host-error'
  let message = INTERNAL_MESSAGE
  let meta
  if (error instanceof WireError) {
    code = error.code
    status = Number.isInteger(error.status) ? error.status : STATUS_BY_CODE[error.code] ?? 500
    message = error.message || INTERNAL_MESSAGE
    meta = error.meta
  } else if (error && typeof error === 'object' && typeof error.code === 'string') {
    const mapped = STATUS_BY_CODE[error.code]
    if (mapped !== undefined) {
      code = error.code
      status = mapped
      message = typeof error.message === 'string' && error.message ? error.message : INTERNAL_MESSAGE
    }
  }
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500
  const envelope = { ok: false, error: { code, message } }
  if (meta !== undefined && meta !== null && typeof meta === 'object') envelope.error.meta = meta
  writeJson(res, status, envelope)
}

/**
 * Read a required, trimmed, non-empty string field from a payload.
 *
 * @param {Record<string, unknown>} payload - JSON payload.
 * @param {string} key - field name.
 * @returns {string} the trimmed value.
 * @throws {WireError} `bad-request` when absent, non-string, or blank.
 */
export function requireString(payload, key) {
  const value = payload?.[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail('bad-request', `缺少参数 ${key}（Missing parameter: ${key}）`)
  }
  return value.trim()
}

/**
 * Decode a URI component, returning the raw input when it is not valid
 * percent-encoding (query strings from clients are never trusted to be well
 * formed; a bad header must not crash a route).
 *
 * @param {unknown} value - encoded text.
 * @returns {string} decoded text or the raw string.
 */
export function safeDecode(value) {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
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
 * @param {unknown} id - candidate id.
 * @returns {string} the lowercase UUID string.
 * @throws {WireError} `bad-request` for ids outside the UUID grammar.
 */
export function requireUuid(id) {
  if (typeof id !== 'string') fail('bad-request', '无效的文档 ID（Invalid document id）')
  const value = id.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    fail('bad-request', '无效的文档 ID（Invalid document id）')
  }
  return value
}

/**
 * Whether the value is a plain JSON object (not an array, not null).
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true for plain records.
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
