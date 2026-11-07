/**
 * Client-side JSON/NDJSON transport for the Host half.
 *
 * The transport mirrors the frozen 1.0.0 wire contract (`src/shared/protocol.ts`):
 * one POST per JSON method with a `{ok,value}|{ok,error}` envelope, raw NDJSON
 * for streaming methods, and a raw byte POST with header metadata for uploads.
 * URLs resolve against `document.baseURI` when available (reverse-proxy safe) or
 * an explicit base (tests).
 */

import { API_PREFIX, UPLOAD_HEADERS, type WireErrorCode } from '../../shared/constants.ts'
import type { ApiEnvelope, ApiMethod, ApiRequests, ApiResults, StreamMethod, StreamMethods } from '../../shared/protocol.ts'
import type { DocumentMeta } from '../../shared/model.ts'
import { assetUrl, resolveUrl, sourceUrl, uploadUrl, vendorAssetUrl } from '../../shared/urls.ts'

/** One wire failure surfaced to the UI. */
export class ApiError extends Error {
  readonly code: WireErrorCode | string
  readonly status: number
  readonly detail: unknown

  constructor(code: string, message: string, status = 0, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.detail = detail
  }

  /** Whether the failure means "the capability is not configured" (setup hint). */
  get isSetup(): boolean {
    return this.code === 'token-missing' || this.code === 'llm-unavailable' || this.code === 'translate-unavailable'
  }
}

/** Resolve the API base once (document.baseURI when present). */
function defaultBase(): string | URL {
  if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
    return document.baseURI
  }
  return 'http://localhost/'
}

/** Combine an optional caller signal with a timeout signal. */
function deadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Parse one JSON envelope or throw a typed ApiError. */
async function readEnvelope<T>(response: Response): Promise<T> {
  const text = await response.text()
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new ApiError('bad-response', response.ok ? '主机返回了非 JSON 响应（Invalid host response）' : response.statusText, response.status)
  }
  const typed = envelope as ApiEnvelope<T>
  if (typed !== null && typeof typed === 'object' && typed.ok === true) return typed.value
  const error = (typed as { error?: { code?: unknown; message?: unknown; meta?: unknown } }).error
  const code = typeof error?.code === 'string' ? error.code : 'http-error'
  const message =
    typeof error?.message === 'string' && error.message !== ''
      ? error.message
      : `请求失败（Request failed: ${response.status}）`
  throw new ApiError(code, message, response.status, error?.meta)
}

/** The Client half's typed Host client. */
export interface HostClient {
  /** Absolute API base used for requests (for tests/asserts). */
  readonly base: string
  call: <K extends ApiMethod>(method: K, payload: ApiRequests[K], options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<ApiResults[K]>
  stream: <K extends StreamMethod>(
    method: K,
    request: StreamMethods[K]['request'],
    handlers: { onFrame: (frame: StreamMethods[K]['frame']) => void; signal?: AbortSignal },
  ) => Promise<void>
  upload: (
    file: File,
    options?: { title?: string; onProgress?: (ratio: number) => void; signal?: AbortSignal },
  ) => Promise<{ document: DocumentMeta }>
  asset: (documentId: string, relativePath: string) => string
  source: (documentId: string, download?: boolean) => string
  vendor: (relativePath: string) => string
  /** Fire-and-forget diagnostics ping (never throws). */
  ping: (event: string, detail?: unknown) => void
}

/** Build a Host client bound to one base. */
export function createHostClient(base?: string | URL): HostClient {
  const resolvedBase = base ?? defaultBase()

  async function call<K extends ApiMethod>(
    method: K,
    payload: ApiRequests[K],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ApiResults[K]> {
    const url = resolveUrl(`${API_PREFIX}/${method}`, resolvedBase)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      credentials: 'same-origin',
      signal: deadline(options.signal, options.timeoutMs ?? 60_000),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ApiError('timeout', '请求超时（Request timed out）')
      }
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiError('network', '无法连接主机（Cannot reach the Host）', 0, error)
    })
    return readEnvelope<ApiResults[K]>(response)
  }

  async function stream<K extends StreamMethod>(
    method: K,
    request: StreamMethods[K]['request'],
    handlers: { onFrame: (frame: StreamMethods[K]['frame']) => void; signal?: AbortSignal },
  ): Promise<void> {
    const url = resolveUrl(`${API_PREFIX}/${method}`, resolvedBase)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(request ?? {}),
      credentials: 'same-origin',
      signal: handlers.signal,
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiError('network', '无法连接主机（Cannot reach the Host）', 0, error)
    })
    if (!response.ok || response.body === null) {
      await readEnvelope<never>(response)
      throw new ApiError('bad-response', '流式响应不可用（Stream unavailable）', response.status)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line !== '') {
            const frame = JSON.parse(line) as StreamMethods[K]['frame']
            handlers.onFrame(frame)
          }
          newline = buffer.indexOf('\n')
        }
      }
      const tail = `${buffer}${decoder.decode()}`.trim()
      if (tail !== '') handlers.onFrame(JSON.parse(tail) as StreamMethods[K]['frame'])
    } finally {
      reader.releaseLock()
    }
  }

  async function upload(
    file: File,
    options: { title?: string; onProgress?: (ratio: number) => void; signal?: AbortSignal } = {},
  ): Promise<{ document: DocumentMeta }> {
    const url = uploadUrl(resolvedBase)
    const headers: Record<string, string> = {
      [UPLOAD_HEADERS.fileName]: encodeURIComponent(file.name),
    }
    if (options.title !== undefined && options.title !== '') {
      headers[UPLOAD_HEADERS.docTitle] = encodeURIComponent(options.title)
    }
    if (typeof XMLHttpRequest === 'undefined') {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: file,
        credentials: 'same-origin',
        signal: options.signal,
      })
      return readEnvelope<{ document: DocumentMeta }>(response)
    }
    return new Promise<{ document: DocumentMeta }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', url)
      xhr.withCredentials = true
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total)
      })
      xhr.addEventListener('error', () => reject(new ApiError('network', '上传失败（Upload failed）')))
      xhr.addEventListener('abort', () => reject(new ApiError('aborted', '已取消（Cancelled）')))
      xhr.addEventListener('load', () => {
        let envelope: ApiEnvelope<{ document: DocumentMeta }>
        try {
          envelope = JSON.parse(xhr.responseText) as ApiEnvelope<{ document: DocumentMeta }>
        } catch {
          reject(new ApiError('bad-response', '上传响应无效（Invalid upload response）', xhr.status))
          return
        }
        if (envelope.ok) resolve(envelope.value)
        else reject(new ApiError(envelope.error.code, envelope.error.message, xhr.status))
      })
      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }
      xhr.send(file)
    })
  }

  return {
    base: resolveUrl(API_PREFIX, resolvedBase),
    call,
    stream,
    upload,
    asset: (documentId, relativePath) => assetUrl(documentId, relativePath, resolvedBase),
    source: (documentId, download) => sourceUrl(documentId, { download }, resolvedBase),
    vendor: (relativePath) => vendorAssetUrl(relativePath, resolvedBase),
    ping: (event, detail) => {
      void call('health.ping', { clientVersion: '1.0.0', event, detail }).catch(() => {})
    },
  }
}

/** The single client used by stores (tests may call `setHostClient`). */
let hostClient: HostClient = createHostClient()

/** Read the current client. */
export function getHostClient(): HostClient {
  return hostClient
}

/** Replace the client (tests only). */
export function setHostClient(next: HostClient): void {
  hostClient = next
}
