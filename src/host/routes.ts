/**
 * HTTP routes registered on the DSH web server.
 *
 * Everything lives under `/dsh-litnotes`:
 *
 *  - `prefix /dsh-litnotes/api` — JSON dispatch (`POST /dsh-litnotes/api/<method>`),
 *    the raw upload endpoint, and the authenticated asset/source GET routes.
 *  - `prefix /dsh-litnotes/assets` — vendored package assets (KaTeX) under `vendor/`.
 *
 * Every request is admitted through the Host connection fence
 * (`ctx.connection.requestRejection(req)`) before any work happens, then
 * method-checked, then answered with the shared JSON envelope. Response bodies
 * from disk are streamed under a path-traversal proof.
 *
 * @module host/routes
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  API_PREFIX,
  ASSETS_PREFIX,
  MAX_BASE_IDS,
  MAX_JSON_BODY,
  UPLOAD_HEADERS,
} from '../shared/constants.ts'
import type {
  Annotation,
  ChatRequest,
  DeepReadRequest,
  GraphPatch,
  ParseStartOptions,
  Preferences,
} from '../shared/model.ts'
import type { AssetQuery, SourceQuery, UploadResult } from '../shared/protocol.ts'
import type { ResolvedConfig, ServiceApi, StoreApi } from './contracts.ts'
import type { ConnectionService, Logger, WebRoute, WebServerService } from './host-services.ts'
import { isSupportedSource, mimeForPath } from './mime.ts'
import {
  WireError,
  readJsonBody,
  requireString,
  requireUuid,
  safeDecode,
  writeError,
  writeOk,
} from './wire.ts'

/** The subset of the plugin context the routes need. */
export interface RoutesContext {
  webServer: WebServerService
  connection?: ConnectionService
}

/** Dependencies accepted by {@link registerRoutes}. */
export interface RoutesDeps {
  ctx: RoutesContext
  service: ServiceApi
  store: StoreApi
  config: ResolvedConfig
  logger?: Logger
  /** Vendored asset root; defaults to the repository `vendor/` directory. */
  vendorDir?: string
}

/** JSON method dispatcher: one async operation per API method. */
type DispatchTable = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>

/**
 * Normalize the optional `baseIds` concurrency baseline of `annotations.save`.
 *
 * The client sends the annotation ids it loaded before editing; the store uses
 * them for its additive 3-way merge so concurrent AI/agent annotations are
 * never lost. Unknown shapes are a `bad-request`; entries are bounded, trimmed
 * and de-duplicated so a hostile payload cannot grow without limit.
 *
 * @param raw - `payload.baseIds` (string[] or undefined/null).
 * @returns the normalized ids, or undefined when absent.
 * @throws {WireError} `bad-request` when the value is not a string array.
 */
function normalizeBaseIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new WireError('bad-request', 'baseIds 必须是字符串数组（baseIds must be a string array）', 400)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (id === '' || id.length > 200 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_BASE_IDS) break
  }
  return out
}

/**
 * Build the `<method>` → service dispatcher for the JSON API.
 *
 * @param service - the operation service.
 * @returns the dispatch table.
 */
function buildDispatch(service: ServiceApi): DispatchTable {
  return {
    'health.ping': (payload) => service.healthPing(payload),
    status: () => service.getStatus(),
    'library.list': () => service.listDocuments(),
    // docs/ARCH.md §4.1: the HTTP payload carries annotations as a plain
    // Annotation[] (the client owns the versioned envelope on disk).
    'library.get': async (payload) => {
      const value = await service.getDocument(requireString(payload, 'id'))
      const annotations = value.annotations
      return {
        ...value,
        annotations: Array.isArray(annotations)
          ? annotations
          : Array.isArray((annotations as { items?: unknown } | undefined)?.items)
            ? (annotations as { items: unknown[] }).items
            : [],
      }
    },
    'library.update': (payload) => {
      const patch: { title?: string } = {}
      if (typeof payload.title === 'string') patch.title = payload.title
      return service.updateDocument(requireString(payload, 'id'), patch)
    },
    'library.remove': (payload) => service.removeDocument(requireString(payload, 'id')),
    'library.importUrl': (payload) =>
      service.importUrl({
        url: requireString(payload, 'url'),
        title: typeof payload.title === 'string' ? payload.title : undefined,
      }),
    'parse.start': (payload) => {
      const options =
        payload.options !== null && typeof payload.options === 'object' && !Array.isArray(payload.options)
          ? (payload.options as ParseStartOptions)
          : (payload as unknown as ParseStartOptions)
      return service.startParse(requireString(payload, 'id'), options)
    },
    'parse.cancel': (payload) => service.cancelParse(requireString(payload, 'id')),
    'document.markdown': (payload) => service.readMarkdown(requireString(payload, 'id')),
    'annotations.save': (payload) =>
      // The service validates the array shape; a missing/non-array payload is a
      // clean `bad-request` rather than an accidental "clear the list".
      service.saveAnnotations(
        requireString(payload, 'id'),
        payload.annotations as Annotation[],
        normalizeBaseIds(payload.baseIds),
      ),
    'translations.save': (payload) =>
      service.saveTranslations(
        requireString(payload, 'id'),
        requireString(payload, 'targetLanguage'),
        (payload.entries ?? {}) as Record<string, string>,
      ),
    translate: (payload) =>
      service.translate({
        text: requireString(payload, 'text'),
        targetLanguage: typeof payload.targetLanguage === 'string' ? payload.targetLanguage : undefined,
        sourceLanguage: typeof payload.sourceLanguage === 'string' ? payload.sourceLanguage : undefined,
        provider: typeof payload.provider === 'string' ? payload.provider : undefined,
      }),
    'settings.get': () => service.getSettings(),
    'settings.setToken': (payload) => service.setToken(requireString(payload, 'token')),
    'settings.clearToken': () => service.clearToken(),
    'settings.update': (payload) =>
      service.updatePreferences((payload.preferences ?? {}) as Partial<Preferences>),
    // AI features (docs/AI-SPEC.md §4): JSON half; streaming methods have
    // dedicated exact routes below.
    'chat.history': (payload) => service.chatHistory(requireString(payload, 'documentId')),
    'chat.clear': (payload) => service.chatClear(requireString(payload, 'documentId')),
    'deepread.get': (payload) => service.deepReadRecord(requireString(payload, 'documentId')),
    'graph.doc': (payload) => service.docGraph(requireString(payload, 'documentId')),
    'graph.update': (payload) =>
      service.updateDocGraph(requireString(payload, 'documentId'), {
        nodes: payload.nodes as GraphPatch['nodes'],
        edges: payload.edges as GraphPatch['edges'],
        merge: payload.merge as GraphPatch['merge'],
      }),
    'graph.library': () => service.libraryGraph(),
  }
}

/** Whether a path segment list is safe to resolve under a root directory. */
function safeSegments(relativePath: string): string[] | null {
  const normalized = String(relativePath ?? '').replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null
  return segments
}

/** Resolve a client-supplied relative path under `baseDir`, refusing escapes. */
function resolveWithin(baseDir: string, relativePath: string): string {
  const segments = safeSegments(relativePath)
  if (segments === null) {
    throw new WireError('bad-request', '非法路径（Invalid path）', 400)
  }
  const root = resolve(baseDir)
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new WireError('bad-request', '非法路径（Invalid path）', 400)
  }
  return target
}

/** Stream a file to the response, mapping a mid-stream failure to a destroyed socket. */
function pipeFile(filePath: string, res: ServerResponse): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(filePath)
    stream.on('error', (error: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 404
        res.end()
      } else {
        res.destroy()
      }
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    stream.on('end', () => resolvePromise())
    stream.pipe(res)
  })
}

/** Answer 405 with an Allow header. */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow)
  writeError(res, new WireError('method-not-allowed', `仅支持 ${allow}（Method not allowed）`, 405))
}

/** Answer the connection-fence rejection, returning true when rejected. */
function fenced(ctx: RoutesContext, req: IncomingMessage, res: ServerResponse): boolean {
  let rejection: number | undefined
  try {
    rejection = ctx.connection?.requestRejection?.(req)
  } catch {
    rejection = 403
  }
  if (rejection === undefined) return false
  writeError(res, new WireError('forbidden', '请求被拒绝（Request rejected）', rejection === 401 ? 401 : 403))
  return true
}

/** Locate the vendored asset directory (works bundled at the package root and unbundled). */
function resolveVendorDir(explicit: string | undefined): string {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDir, '..', '..', 'vendor'), // src/host/routes.ts (unbundled)
    join(moduleDir, 'vendor'), // index.js at the package root (bundled)
    join(moduleDir, '..', 'vendor'),
    join(process.cwd(), 'vendor'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return candidates[0] ?? join(process.cwd(), 'vendor')
}

/**
 * Register all web routes.
 *
 * @param deps - plugin context, service, store and resolved config.
 * @returns a disposer that unregisters every route.
 */
export function registerRoutes({ ctx, service, store, config, logger, vendorDir }: RoutesDeps): () => void {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('registerRoutes: ctx.webServer.register is required')
  }
  if (!service || !store) throw new TypeError('registerRoutes: service and store are required')
  const log: Logger = logger ?? {}
  const dispatch = buildDispatch(service)
  const resolvedVendorDir = resolveVendorDir(vendorDir)
  const disposers: Array<() => void> = []

  /** Register one route and collect its disposer. */
  function register(route: WebRoute): () => void {
    const dispose = ctx.webServer.register(route)
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }

  /** Stream the raw upload body to a temp file, capped by config.maxUploadBytes. */
  async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const fileNameHeader = req.headers[UPLOAD_HEADERS.fileName]
    if (typeof fileNameHeader !== 'string' || fileNameHeader.trim() === '') {
      throw new WireError('bad-request', '缺少 x-file-name 请求头（Missing x-file-name header）', 400)
    }
    const fileName = safeDecode(fileNameHeader).trim().slice(0, 255)
    if (fileName === '' || !isSupportedSource(fileName)) {
      throw new WireError('unsupported-type', `不支持的文件类型（Unsupported file type: ${fileName}）`, 415)
    }
    const titleHeader = req.headers[UPLOAD_HEADERS.docTitle]
    const title =
      typeof titleHeader === 'string' && titleHeader.trim() !== ''
        ? safeDecode(titleHeader).trim().slice(0, 300)
        : undefined
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
      throw new WireError('too-large', `文件超过 ${config.maxUploadBytes} 字节限制（File too large）`, 413)
    }
    const id = randomUUID()
    const tempPath = store.newTempPath(id)
    await mkdir(dirname(tempPath), { recursive: true })
    const stream = createWriteStream(tempPath, { flags: 'wx' })
    let size = 0
    try {
      for await (const chunk of req as AsyncIterable<Buffer | string>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > config.maxUploadBytes) {
          throw new WireError('too-large', `文件超过 ${config.maxUploadBytes} 字节限制（File too large）`, 413)
        }
        if (!stream.write(buffer)) await once(stream, 'drain')
      }
      await new Promise<void>((resolvePromise, reject) =>
        stream.end((error?: Error | null) => (error ? reject(error) : resolvePromise())),
      )
      if (size === 0) throw new WireError('bad-request', '上传文件为空（Empty upload）', 400)
    } catch (error) {
      stream.destroy()
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
    try {
      const meta = await store.createFromFile({ id, tempPath, originalName: fileName, title })
      const payload: UploadResult = { document: meta }
      writeOk(res, payload)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Serve an extracted parse asset (`parsed/**` only). */
  async function handleAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const query: AssetQuery = {
      id: url.searchParams.get('id') ?? '',
      path: url.searchParams.get('path') ?? '',
    }
    await store.init()
    const docId = requireUuid(query.id)
    const parsedDir = store.parsedDir(docId)
    const target = resolveWithin(parsedDir, query.path)
    let fileStats
    try {
      fileStats = await stat(target)
    } catch {
      throw new WireError('not-found', '文件不存在（Asset not found）', 404)
    }
    if (!fileStats.isFile()) throw new WireError('not-found', '文件不存在（Asset not found）', 404)
    res.statusCode = 200
    res.setHeader('content-type', mimeForPath(target))
    res.setHeader('content-length', fileStats.size)
    res.setHeader('cache-control', 'private, max-age=86400')
    res.setHeader('x-content-type-options', 'nosniff')
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await pipeFile(target, res)
  }

  /** Serve the original source file (inline PDF; attachment on demand). */
  async function handleSource(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const query: SourceQuery = {
      id: url.searchParams.get('id') ?? '',
      download: url.searchParams.get('download') === '1',
    }
    await store.init()
    const docId = requireUuid(query.id)
    const meta = store.get(docId)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    const sourcePath = await store.sourcePath(docId)
    const fileStats = await stat(sourcePath)
    const contentType =
      typeof meta.mime === 'string' && meta.mime !== '' ? meta.mime : mimeForPath(meta.originalName ?? sourcePath)
    const ext = typeof meta.ext === 'string' ? meta.ext.toLowerCase() : ''
    const dangerous = ext === '.html' || ext === '.htm' || ext === '.svg'
    const disposition = query.download === true || dangerous ? 'attachment' : 'inline'
    const fileName =
      typeof meta.originalName === 'string' && meta.originalName !== '' ? meta.originalName : `source${ext}`
    const encodedName = encodeURIComponent(fileName.replace(/[\r\n"]/g, '_'))
    res.statusCode = 200
    res.setHeader('content-type', contentType)
    res.setHeader('content-length', fileStats.size)
    res.setHeader('content-disposition', `${disposition}; filename*=UTF-8''${encodedName}`)
    res.setHeader('cache-control', 'private, max-age=86400')
    res.setHeader('x-content-type-options', 'nosniff')
    if (dangerous) res.setHeader('content-security-policy', "default-src 'none'; sandbox")
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await pipeFile(sourcePath, res)
  }

  /** Dispatch one JSON API method. */
  async function handleJsonMethod(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): Promise<void> {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const handler = dispatch[method]
    if (handler === undefined) {
      throw new WireError('not-found', `未知接口方法 ${method}（Unknown API method）`, 404)
    }
    const payload = await readJsonBody(req, MAX_JSON_BODY)
    const value = await handler(payload)
    writeOk(res, value)
  }

  /** Prefix handler for `/dsh-litnotes/api`. */
  async function apiHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (fenced(ctx, req, res)) return
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const pathname = url.pathname
      if (pathname === `${API_PREFIX}/upload`) {
        await handleUpload(req, res)
        return
      }
      if (pathname === `${API_PREFIX}/asset`) {
        await handleAsset(req, res)
        return
      }
      if (pathname === `${API_PREFIX}/source`) {
        await handleSource(req, res)
        return
      }
      if (pathname.startsWith(`${API_PREFIX}/`)) {
        const method = pathname.slice(API_PREFIX.length + 1)
        if (method === '' || method.includes('/')) {
          throw new WireError('not-found', '接口不存在（API not found）', 404)
        }
        await handleJsonMethod(req, res, method)
        return
      }
      throw new WireError('not-found', '接口不存在（API not found）', 404)
    } catch (error) {
      if (!res.headersSent) writeError(res, error)
      else if (!res.writableEnded) res.end()
      if (!(error instanceof WireError)) {
        log.warn?.(
          '[dsh-litnotes] API handler error: %s',
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
      }
    }
  }

  /** Prefix handler for `/dsh-litnotes/assets` (vendored KaTeX and friends). */
  async function assetsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (fenced(ctx, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, 'GET, HEAD')
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const relative = url.pathname.slice(ASSETS_PREFIX.length).replace(/^\/+/, '')
      const target = resolveWithin(resolvedVendorDir, relative)
      let fileStats
      try {
        fileStats = await stat(target)
      } catch {
        throw new WireError('not-found', '资源不存在（Asset not found）', 404)
      }
      if (!fileStats.isFile()) throw new WireError('not-found', '资源不存在（Asset not found）', 404)
      res.statusCode = 200
      res.setHeader('content-type', mimeForPath(target))
      res.setHeader('content-length', fileStats.size)
      res.setHeader('cache-control', 'public, max-age=31536000, immutable')
      res.setHeader('x-content-type-options', 'nosniff')
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      await pipeFile(target, res)
    } catch (error) {
      if (!res.headersSent) writeError(res, error)
      else if (!res.writableEnded) res.end()
      if (!(error instanceof WireError)) {
        log.warn?.(
          '[dsh-litnotes] asset handler error: %s',
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
      }
    }
  }

  /**
   * Stream an async iterable of NDJSON frames over a raw POST response.
   * The request body is one JSON payload; a client disconnect aborts `signal`.
   */
  async function handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    produce: (payload: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<unknown>,
  ): Promise<void> {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    if (fenced(ctx, req, res)) return
    let payload: Record<string, unknown>
    try {
      payload = await readJsonBody(req, MAX_JSON_BODY)
    } catch (error) {
      writeError(res, error)
      return
    }
    const controller = new AbortController()
    const onClose = (): void => controller.abort(new Error('client disconnected'))
    req.on('close', onClose)
    res.statusCode = 200
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-accel-buffering', 'no')
    res.flushHeaders?.()
    try {
      for await (const frame of produce(payload, controller.signal)) {
        if (controller.signal.aborted || res.writableEnded) break
        res.write(`${JSON.stringify(frame)}\n`)
      }
      if (!res.writableEnded) res.end()
    } catch (error) {
      if (!res.writableEnded) {
        const failure = {
          type: 'error',
          code: error instanceof WireError ? error.code : 'ai-failed',
          message: error instanceof Error ? error.message : String(error),
        }
        try {
          res.write(`${JSON.stringify(failure)}\n`)
        } catch {
          /* socket already gone */
        }
        res.end()
      }
      if (!(error instanceof WireError)) {
        log.warn?.(
          '[dsh-litnotes] AI stream error: %s',
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
      }
    } finally {
      req.off('close', onClose)
    }
  }

  register({
    kind: 'exact',
    path: `${API_PREFIX}/chat`,
    handler: (req, res) =>
      handleStream(req, res, (payload, signal) =>
        service.chatFrames({ ...payload, documentId: String(payload.documentId ?? '') } as unknown as ChatRequest, signal),
      ),
  })
  register({
    kind: 'exact',
    path: `${API_PREFIX}/deepread`,
    handler: (req, res) =>
      handleStream(req, res, (payload, signal) => {
        const request: DeepReadRequest = { documentId: String(payload.documentId ?? '') }
        if (payload.force === true) request.force = true
        if (typeof payload.language === 'string' && payload.language.trim() !== '') {
          request.language = payload.language
        }
        return service.deepReadFrames(request, signal)
      }),
  })
  register({
    kind: 'exact',
    path: `${API_PREFIX}/graph.build`,
    handler: (req, res) =>
      handleStream(req, res, (payload, signal) =>
        service.graphBuildFrames(
          {
            documentId: String(payload.documentId ?? ''),
            force: payload.force === true,
          },
          signal,
        ),
      ),
  })
  register({
    kind: 'exact',
    path: `${API_PREFIX}/graph.library.rebuild`,
    handler: (req, res) => handleStream(req, res, (_payload, signal) => service.libraryGraphBuildFrames(signal)),
  })

  register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler })
  register({ kind: 'prefix', path: ASSETS_PREFIX, handler: assetsHandler })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        log.warn?.(
          '[dsh-litnotes] route disposer failed: %s',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
}
