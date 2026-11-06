/**
 * Local parse engine facade for dsh-litnotes (P0: T0 + T0.5).
 *
 * Providers:
 *   - `builtin`             vendored pdf.js text-layer extraction for `.pdf`
 *   - `system:officeToPdf`  DSH `officeToPdf` service → PDF bytes → builtin
 *
 * The engine is intentionally independent of `lib/mineru.js` (cloud/local
 * decoupling): it validates its own inputs, maps failures to `WireError`
 * codes and produces artifacts through `lib/local-synth.js`. The parse manager
 * treats it as one more engine behind `executeTask()`.
 *
 * @module lib/local-engine
 */
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WireError } from './wire.js'
import { extractPdfText, PDFJS_VERSION } from './local-pdf.js'
import { synthLocalDocument } from './local-synth.js'
import { convertOfficeToPdf, isOfficeExtension } from './local-office.js'

/** Provider id for the vendored pdf.js extractor. */
export const BUILTIN_PROVIDER = 'builtin'
/** Provider id for the DSH Office→PDF conversion path. */
export const OFFICE_PROVIDER = 'system:officeToPdf'

/** Extensions handled by the builtin PDF text layer. */
const PDF_EXTENSIONS = new Set(['.pdf'])

/** Local 配置默认值（与 lib/config.js 的 resolveConfig 保持一致）。 */
export const DEFAULT_LOCAL_CONFIG = Object.freeze({
  enabled: true,
  maxPages: 500,
  maxPdfBytes: 200 * 1024 * 1024,
  maxTextBytes: 32 * 1024 * 1024,
  minCharsPerPage: 30,
  maxParagraphChars: 4000,
  keepContentList: true,
  timeoutMs: 120000,
  maxOfficePdfBytes: 100 * 1024 * 1024,
})

/** Abort-shaped error understood by the parse manager. */
function abortError() {
  const error = new Error('本地解析已取消（Local parse cancelled）')
  error.name = 'AbortError'
  return error
}

/** Read at most `maxBytes` bytes from disk, refusing larger files. */
async function readFileCapped(path, maxBytes) {
  const info = await stat(path)
  if (info.size > maxBytes) {
    throw new WireError('too-large', `文件超过本地解析上限（File exceeds the local limit of ${maxBytes} bytes）`, 413, {
      limit: maxBytes,
    })
  }
  return readFile(path)
}

/** Merge the resolved config block over the defaults. */
function resolveLocalConfig(config) {
  const source = config && typeof config.local === 'object' && config.local !== null ? config.local : {}
  const pickInteger = (value, fallback, min, max) => {
    const number = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_LOCAL_CONFIG.enabled,
    maxPages: pickInteger(source.maxPages, DEFAULT_LOCAL_CONFIG.maxPages, 1, 5000),
    maxPdfBytes: pickInteger(source.maxPdfBytes, DEFAULT_LOCAL_CONFIG.maxPdfBytes, 64 * 1024, 2 * 1024 * 1024 * 1024),
    maxTextBytes: pickInteger(source.maxTextBytes, DEFAULT_LOCAL_CONFIG.maxTextBytes, 64 * 1024, 256 * 1024 * 1024),
    minCharsPerPage: pickInteger(source.minCharsPerPage, DEFAULT_LOCAL_CONFIG.minCharsPerPage, 0, 10000),
    maxParagraphChars: pickInteger(source.maxParagraphChars, DEFAULT_LOCAL_CONFIG.maxParagraphChars, 500, 8000),
    keepContentList: typeof source.keepContentList === 'boolean' ? source.keepContentList : DEFAULT_LOCAL_CONFIG.keepContentList,
    timeoutMs: pickInteger(source.timeoutMs, DEFAULT_LOCAL_CONFIG.timeoutMs, 1000, 60 * 60 * 1000),
    maxOfficePdfBytes: pickInteger(
      source.maxOfficePdfBytes,
      DEFAULT_LOCAL_CONFIG.maxOfficePdfBytes,
      64 * 1024,
      1024 * 1024 * 1024,
    ),
  }
}

/**
 * Create the local engine facade.
 *
 * Dependencies are injectable so unit tests can fake pdf.js and the DSH
 * Office converter without any native/optional service.
 *
 * @param {{
 *   config?: Record<string, any>,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   officeToPdf?: { convert?: Function },
 *   getOfficeToPdf?: () => { convert?: Function } | undefined,
 *   now?: () => number,
 *   readSourceCapped?: (path: string, maxBytes: number) => Promise<Uint8Array|Buffer>,
 *   pdfExtractor?: Function,
 *   officeConverter?: Function,
 * }} [options] - injected dependencies. `getOfficeToPdf` is preferred over
 *   `officeToPdf` in the real Host: the DSH service may be mounted after this
 *   engine is created, so the capability must be resolved lazily.
 * @returns {object} engine facade.
 */
export function createLocalEngine({
  config,
  logger,
  officeToPdf,
  getOfficeToPdf,
  now,
  readSourceCapped,
  pdfExtractor,
  officeConverter,
} = {}) {
  const log = logger ?? {}
  const localConfig = resolveLocalConfig(config)
  const clock = typeof now === 'function' ? now : Date.now
  const readCappedDefault =
    typeof readSourceCapped === 'function'
      ? readSourceCapped
      : (path, maxBytes) => readFileCapped(path, maxBytes)
  const extractPdf = typeof pdfExtractor === 'function' ? pdfExtractor : extractPdfText
  const convertOffice = typeof officeConverter === 'function' ? officeConverter : convertOfficeToPdf

  /** Resolve the optional DSH Office→PDF service lazily (may mount later). */
  function officeService() {
    try {
      const service = typeof getOfficeToPdf === 'function' ? getOfficeToPdf() : officeToPdf
      return service !== null && typeof service === 'object' ? service : undefined
    } catch {
      return undefined
    }
  }

  /** Whether the vendored pdf.js files exist in this installation. */
  const vendorAvailable =
    existsSync(join(import.meta.dirname, '..', 'vendor', 'pdfjs', 'pdf.mjs')) &&
    existsSync(join(import.meta.dirname, '..', 'vendor', 'pdfjs', 'pdf.worker.mjs'))

  const builtinAvailable = localConfig.enabled && vendorAvailable

  /** Whether the optional DSH Office→PDF service is currently mounted. */
  function officeAvailableNow() {
    const service = officeService()
    return localConfig.enabled && service !== undefined && typeof service.convert === 'function'
  }

  /** Capability snapshot shared by `status` and `settings.get`. */
  function snapshot() {
    const officeAvailable = officeAvailableNow()
    const providers = [
      { id: BUILTIN_PROVIDER, available: builtinAvailable, version: `pdfjs-dist/${PDFJS_VERSION}` },
      {
        id: OFFICE_PROVIDER,
        available: officeAvailable,
        version: officeAvailable ? 'office-to-pdf' : '',
        ...(officeAvailable ? {} : { reason: 'office-to-pdf service is not mounted in this profile' }),
      },
    ]
    const capabilities = {
      textLayerPdf: builtinAvailable,
      office: builtinAvailable && officeAvailable,
      images: false,
      html: false,
    }
    const available = capabilities.textLayerPdf || capabilities.office
    return {
      enabled: localConfig.enabled,
      available,
      recommended: capabilities.textLayerPdf ? BUILTIN_PROVIDER : capabilities.office ? OFFICE_PROVIDER : null,
      providers,
      capabilities,
    }
  }

  /** Normalize one document extension (`.pdf`). */
  function extOf(meta) {
    if (typeof meta?.ext === 'string' && meta.ext !== '') return meta.ext.toLowerCase()
    if (typeof meta?.originalName === 'string') {
      const match = /(\.[^./\\]+)$/.exec(meta.originalName)
      if (match !== null) return match[1].toLowerCase()
    }
    return ''
  }

  /**
   * Whether the local engine can parse one document, without throwing.
   *
   * @param {Record<string, any>} meta - document metadata.
   * @returns {{supported:boolean, provider:string|null, reason?:string}} support info.
   */
  function supports(meta) {
    if (!localConfig.enabled) return { supported: false, provider: null, reason: 'local parsing is disabled' }
    const ext = extOf(meta)
    if (PDF_EXTENSIONS.has(ext)) {
      return builtinAvailable
        ? { supported: true, provider: BUILTIN_PROVIDER }
        : { supported: false, provider: null, reason: 'builtin pdf extractor is unavailable' }
    }
    if (isOfficeExtension(ext)) {
      if (!builtinAvailable) return { supported: false, provider: null, reason: 'builtin pdf extractor is unavailable' }
      if (!officeAvailableNow()) return { supported: false, provider: null, reason: 'office-to-pdf service is unavailable' }
      return { supported: true, provider: OFFICE_PROVIDER }
    }
    return { supported: false, provider: null, reason: `unsupported extension ${ext || '(unknown)'}` }
  }

  /**
   * Validate parse options and resolve the provider plan.
   *
   * @param {Record<string, any>} meta - document metadata.
   * @param {{ localProvider?: string }} [options] - requested provider override.
   * @returns {{ provider: string, params: Record<string, any> }} execution plan.
   * @throws {WireError} `local-unsupported` / `local-missing-tool` / `too-large`.
   */
  function plan(meta, options) {
    if (!localConfig.enabled) {
      throw new WireError('local-missing-tool', '本地解析已禁用（Local parsing is disabled）', 503)
    }
    const support = supports(meta)
    if (!support.supported) {
      const ext = extOf(meta)
      const missingTool = support.reason !== undefined && support.reason.includes('unavailable')
      throw new WireError(
        missingTool ? 'local-missing-tool' : 'local-unsupported',
        missingTool
          ? '本地解析工具不可用；请配置 MinerU Token 或改用云端解析（Local parsing tool unavailable）'
          : `本地解析不支持这种文件 ${ext || '（unknown）'}（Local parsing does not support this file）`,
        missingTool ? 503 : 415,
      )
    }
    const requested = typeof options?.localProvider === 'string' && options.localProvider !== ''
      ? options.localProvider
      : 'auto'
    if (requested !== 'auto' && requested !== support.provider) {
      throw new WireError(
        'local-unsupported',
        `本地解析不支持指定的 provider：${requested}（Unsupported local provider ${requested}）`,
        415,
      )
    }
    const size = Number.isFinite(meta?.size) && meta.size > 0 ? Math.floor(meta.size) : 0
    const limit = support.provider === OFFICE_PROVIDER ? localConfig.maxOfficePdfBytes : localConfig.maxPdfBytes
    if (size > limit) {
      throw new WireError(
        'too-large',
        `文件超过本地解析上限（File exceeds the local limit of ${Math.floor(limit / (1024 * 1024))} MB）`,
        413,
        { limit },
      )
    }
    return {
      provider: support.provider,
      params: {
        fileName: typeof meta?.originalName === 'string' ? meta.originalName : '',
        language: 'local',
        localProvider: support.provider,
      },
    }
  }

  /**
   * Extract one document into the reading-desk artifact payload.
   *
   * @param {{
   *   id: string,
   *   meta: Record<string, any>,
   *   sourcePath: string,
   *   params?: Record<string, any>,
   *   signal?: AbortSignal,
   *   onProgress?: (progress: {extracted:number,total:number}) => void,
   * }} input - task inputs.
   * @returns {Promise<{
   *   markdown: string, contentList: object[], pages: number, provider: string,
   *   title: string|null, warnings: string[],
   *   stats: {pageCount:number, textChars:number, extractMs:number, toolVersion:string, provider:string},
   * }>} synthesized artifacts + diagnostics.
   */
  async function extract({ id, meta, sourcePath, params, signal, onProgress } = {}) {
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new WireError('host-error', '本地解析缺少源文件路径（Missing source path）', 500)
    }
    const startedAt = clock()
    const execution = plan(meta, params)
    const warnings = []

    // Link caller cancellation with a local deadline.
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), localConfig.timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const linked = signal !== undefined ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    let timedOut = false
    const onLinkedAbort = () => {
      if (!timeoutController.signal.aborted) return
      if (signal?.aborted !== true) timedOut = true
    }
    linked.addEventListener('abort', onLinkedAbort, { once: true })

    try {
      let data
      let toolVersion = `pdfjs-dist/${PDFJS_VERSION}`
      if (execution.provider === OFFICE_PROVIDER) {
        const service = officeService()
        if (service === undefined || typeof service.convert !== 'function') {
          throw new WireError(
            'local-missing-tool',
            '当前环境没有 Office 本地转换服务（office-to-pdf）；请配置 MinerU Token 或使用云端解析（Office-to-PDF service is unavailable）',
            503,
          )
        }
        const converted = await convertOffice({
          officeToPdf: service,
          meta,
          readSource: (maxBytes) => readCappedDefault(sourcePath, maxBytes),
          signal: linked,
          maxBytes: localConfig.maxOfficePdfBytes,
          logger: log,
        })
        if (converted.missingFonts.length > 0) warnings.push('missing-fonts')
        data = converted.pdf
        toolVersion = 'office-to-pdf'
      } else {
        data = await readCappedDefault(sourcePath, localConfig.maxPdfBytes)
      }

      const extracted = await extractPdf({
        data,
        maxPages: localConfig.maxPages,
        maxTextBytes: localConfig.maxTextBytes,
        signal: linked,
        onProgress,
        logger: log,
      })

      const pageCount = Number.isInteger(extracted.pageCount) ? extracted.pageCount : extracted.pages.length
      const minChars = Math.max(200, localConfig.minCharsPerPage * Math.max(1, pageCount))
      if (extracted.chars < minChars) {
        throw new WireError(
          'local-empty-text',
          '没有从文件中提取到文字（可能是扫描件）；请用云端解析或配置 MinerU Token（No text extracted; the file may be scanned）',
          422,
          { chars: extracted.chars, pages: pageCount },
        )
      }

      const synth = synthLocalDocument({
        pages: extracted.pages,
        title: extracted.title,
        maxParagraphChars: localConfig.maxParagraphChars,
        keepContentList: localConfig.keepContentList,
      })
      for (const warning of synth.warnings) if (!warnings.includes(warning)) warnings.push(warning)
      if (extracted.outlineUsed === false) warnings.push('no-outline')

      const stats = {
        pageCount: synth.pageCount,
        textChars: synth.textChars,
        extractMs: Math.max(0, Math.round(clock() - startedAt)),
        toolVersion,
        provider: execution.provider,
      }
      log.info?.(
        '[dsh-litnotes] local parse %s via %s: %d pages, %d chars, %d ms',
        id ?? '?',
        execution.provider,
        stats.pageCount,
        stats.textChars,
        stats.extractMs,
      )
      return {
        markdown: synth.markdown,
        contentList: synth.contentList,
        pages: synth.pageCount,
        provider: execution.provider,
        title: synth.title,
        warnings,
        stats,
      }
    } catch (error) {
      if (timedOut) {
        throw new WireError('local-failed', '本地解析超时（Local parsing timed out）', 500)
      }
      throw error
    } finally {
      clearTimeout(timer)
      linked.removeEventListener?.('abort', onLinkedAbort)
    }
  }

  return {
    snapshot,
    supports,
    plan,
    extract,
    config: localConfig,
    providers: { BUILTIN_PROVIDER, OFFICE_PROVIDER },
  }
}
