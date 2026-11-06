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
 * @module lib/routes
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { isSupportedSource, mimeForPath } from './mime.js'
import { WireError, requireString, requireUuid, readJsonBody, safeDecode, writeError, writeOk } from './wire.js'

/** Route mount points (no trailing slash). */
export const API_PREFIX = '/dsh-litnotes/api'
/** Vendored static assets mount point. */
export const ASSETS_PREFIX = '/dsh-litnotes/assets'
/** JSON request body cap. */
const MAX_JSON_BODY = 2 * 1024 * 1024
/** Directory holding vendored package assets. */
const VENDOR_DIR = resolve(import.meta.dirname, '..', 'vendor')

/**
 * Build the `<method>` → service dispatcher for the JSON API.
 * @param {object} service - the operation service.
 * @returns {Record<string, (payload: Record<string, unknown>) => Promise<unknown>>} dispatch table.
 */
function buildDispatch(service) {
  return {
    'health.ping': (payload) => service.healthPing(payload),
    status: () => service.getStatus(),
    'library.list': () => service.listDocuments(),
    // docs/ARCH.md §4.1: the HTTP payload carries annotations as a plain
    // Annotation[] (the client owns the versioned envelope on disk).
    'library.get': async (payload) => {
      const value = await service.getDocument(requireString(payload, 'id'))
      const annotations = value?.annotations
      return {
        ...value,
        annotations: Array.isArray(annotations)
          ? annotations
          : Array.isArray(annotations?.items)
            ? annotations.items
            : [],
      }
    },
    'library.update': (payload) => service.updateDocument(requireString(payload, 'id'), payload),
    'library.remove': (payload) => service.removeDocument(requireString(payload, 'id')),
    'library.importUrl': (payload) =>
      service.importUrl({ url: requireString(payload, 'url'), title: payload.title }),
    'parse.start': (payload) => {
      const options =
        payload.options !== null && typeof payload.options === 'object' && !Array.isArray(payload.options)
          ? payload.options
          : payload
      return service.startParse(requireString(payload, 'id'), options)
    },
    'parse.cancel': (payload) => service.cancelParse(requireString(payload, 'id')),
    'document.markdown': (payload) => service.readMarkdown(requireString(payload, 'id')),
    'annotations.save': (payload) =>
      service.saveAnnotations(requireString(payload, 'id'), payload.annotations),
    'translations.save': (payload) =>
      service.saveTranslations(requireString(payload, 'id'), payload.targetLanguage, payload.entries),
    translate: (payload) => service.translate(payload),
    'settings.get': () => service.getSettings(),
    'settings.setToken': (payload) => service.setToken(requireString(payload, 'token')),
    'settings.clearToken': () => service.clearToken(),
    'settings.update': (payload) => service.updatePreferences(payload.preferences),
  }
}

/** Whether a path segment list is safe to resolve under a root directory. */
function safeSegments(relativePath) {
  const normalized = String(relativePath ?? '').replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null
  return segments
}

/** Resolve a client-supplied relative path under `baseDir`, refusing escapes. */
function resolveWithin(baseDir, relativePath) {
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
function pipeFile(filePath, res) {
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(filePath)
    stream.on('error', (error) => {
      if (!res.headersSent) {
        res.statusCode = 404
        res.end()
      } else {
        res.destroy()
      }
      reject(error)
    })
    stream.on('end', () => resolvePromise())
    stream.pipe(res)
  })
}

/** Answer 405 with an Allow header. */
function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  writeError(res, new WireError('method-not-allowed', `仅支持 ${allow}（Method not allowed）`, 405))
}

/** Answer the connection-fence rejection, returning true when rejected. */
function fenced(ctx, req, res) {
  let rejection
  try {
    rejection = ctx?.connection?.requestRejection?.(req)
  } catch (error) {
    rejection = 403
  }
  if (rejection === undefined) return false
  writeError(res, new WireError('forbidden', '请求被拒绝（Request rejected）', rejection === 401 ? 401 : 403))
  return true
}

/**
 * Register all web routes.
 *
 * @param {{
 *   ctx: { webServer: { register(route: object): Function }, connection?: object },
 *   service: object,
 *   store: object,
 *   config: { maxUploadBytes: number },
 *   logger?: object,
 * }} options - plugin context, service, store and resolved config.
 * @returns {() => void} disposer that unregisters every route.
 */
export function registerRoutes({ ctx, service, store, config, logger } = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('registerRoutes: ctx.webServer.register is required')
  }
  if (!service || !store) throw new TypeError('registerRoutes: service and store are required')
  const log = logger ?? {}
  const dispatch = buildDispatch(service)
  const disposers = []

  /** Register one route and collect its disposer. */
  function register(route) {
    const dispose = ctx.webServer.register(route)
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }

  /** Stream the raw upload body to a temp file, capped by config.maxUploadBytes. */
  async function handleUpload(req, res) {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const fileNameHeader = req.headers['x-file-name']
    if (typeof fileNameHeader !== 'string' || fileNameHeader.trim() === '') {
      throw new WireError('bad-request', '缺少 x-file-name 请求头（Missing x-file-name header）', 400)
    }
    const fileName = safeDecode(fileNameHeader).trim().slice(0, 255)
    if (fileName === '' || !isSupportedSource(fileName)) {
      throw new WireError('unsupported-type', `不支持的文件类型（Unsupported file type: ${fileName}）`, 415)
    }
    const titleHeader = req.headers['x-doc-title']
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
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > config.maxUploadBytes) {
          throw new WireError('too-large', `文件超过 ${config.maxUploadBytes} 字节限制（File too large）`, 413)
        }
        if (!stream.write(buffer)) await once(stream, 'drain')
      }
      await new Promise((resolvePromise, reject) =>
        stream.end((error) => (error ? reject(error) : resolvePromise())),
      )
      if (size === 0) throw new WireError('bad-request', '上传文件为空（Empty upload）', 400)
    } catch (error) {
      stream.destroy()
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
    try {
      const meta = await store.createFromFile({ id, tempPath, originalName: fileName, title })
      writeOk(res, { document: meta })
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Serve an extracted parse asset (`parsed/**` only). */
  async function handleAsset(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const id = url.searchParams.get('id') ?? ''
    const relativePath = url.searchParams.get('path') ?? ''
    await store.init()
    const docId = requireUuid(id)
    const parsedDir = store.parsedDir(docId)
    const target = resolveWithin(parsedDir, relativePath)
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
  async function handleSource(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const id = url.searchParams.get('id') ?? ''
    const download = url.searchParams.get('download') === '1'
    await store.init()
    const docId = requireUuid(id)
    const meta = store.get(docId)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    const sourcePath = await store.sourcePath(docId)
    const fileStats = await stat(sourcePath)
    const contentType =
      typeof meta.mime === 'string' && meta.mime !== '' ? meta.mime : mimeForPath(meta.originalName ?? sourcePath)
    const ext = typeof meta.ext === 'string' ? meta.ext.toLowerCase() : ''
    const dangerous = ext === '.html' || ext === '.htm' || ext === '.svg'
    const disposition = download || dangerous ? 'attachment' : 'inline'
    const fileName = typeof meta.originalName === 'string' && meta.originalName !== '' ? meta.originalName : `source${ext}`
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
  async function handleJsonMethod(req, res, method) {
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
  async function apiHandler(req, res) {
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
        log.warn?.('[dsh-litnotes] API handler error: %s', error?.stack ?? error)
      }
    }
  }

  /** Prefix handler for `/dsh-litnotes/assets` (vendored KaTeX and friends). */
  async function assetsHandler(req, res) {
    try {
      if (fenced(ctx, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, 'GET, HEAD')
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const relative = url.pathname.slice(ASSETS_PREFIX.length).replace(/^\/+/, '')
      const target = resolveWithin(VENDOR_DIR, relative)
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
        log.warn?.('[dsh-litnotes] asset handler error: %s', error?.stack ?? error)
      }
    }
  }

  register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler })
  register({ kind: 'prefix', path: ASSETS_PREFIX, handler: assetsHandler })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        log.warn?.('[dsh-litnotes] route disposer failed: %s', error?.message ?? error)
      }
    }
  }
}
