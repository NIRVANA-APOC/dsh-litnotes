/**
 * Local parse engine facade (T0 + T0.5), typed 1.0.0 port.
 *
 * Providers:
 *   - `builtin`             vendored pdf.js text-layer extraction for `.pdf`
 *   - `system:officeToPdf`  DSH `officeToPdf` service → PDF bytes → builtin
 *
 * The engine is intentionally independent of the MinerU client (cloud/local
 * decoupling): it validates its own inputs, maps failures to `WireError` codes
 * and produces artifacts through `host/parse/local/synth.ts`. The parse manager
 * treats it as one more engine behind `executeTask()`.
 *
 * The optional DSH Office→PDF service may be mounted after this engine is
 * created, so the capability is always resolved lazily through `getOfficeToPdf`.
 *
 * @module host/parse/local/engine
 */

import { readFile, stat } from 'node:fs/promises'
import type { LocalCapabilities, ParseProgress } from '../../../shared/model.ts'
import { LOCAL_PROVIDERS } from '../../../shared/constants.ts'
import type { LocalProvider } from '../../../shared/constants.ts'
import type { LocalConfig, LocalEngineApi, LocalExtractResult, LocalPlan } from '../../contracts.ts'
import type { Logger, OfficeToPdfService } from '../../host-services.ts'
import { WireError } from '../../wire.ts'
import { convertOfficeToPdf, isOfficeExtension } from './office.ts'
import type {
  ConvertOfficeToPdfInput,
  ConvertOfficeToPdfResult,
  OfficeDocumentMeta,
} from './office.ts'
import { PDFJS_VERSION, extractPdfText, pdfjsRuntimeAvailable } from './pdf.ts'
import type { ExtractPdfTextInput, PdfExtractionResult } from './pdf.ts'
import { synthLocalDocument } from './synth.ts'

/** Provider id for the vendored pdf.js extractor. */
export const BUILTIN_PROVIDER = 'builtin' as const
/** Provider id for the DSH Office→PDF conversion path. */
export const OFFICE_PROVIDER = 'system:officeToPdf' as const

/** Extensions handled by the builtin PDF text layer. */
const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['.pdf'])

/** Local config default values (kept in sync with the resolved Host config). */
export const DEFAULT_LOCAL_CONFIG: LocalConfig = Object.freeze({
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

/**
 * Document metadata the local engine reads.
 *
 * A structural subset of the persisted `DocumentMeta` so tests can pass plain
 * fixtures while the service passes the real metadata record.
 */
export interface LocalDocumentMeta {
  id?: string
  ext?: string
  originalName?: string
  size?: number
  sha256?: string
  updatedAt?: string
}

/** Injected PDF extractor signature (defaults to {@link extractPdfText}). */
export type PdfExtractor = (input: ExtractPdfTextInput) => Promise<PdfExtractionResult>

/** Injected Office converter signature (defaults to {@link convertOfficeToPdf}). */
export type OfficeConverter = (input: ConvertOfficeToPdfInput) => Promise<ConvertOfficeToPdfResult>

/** Injected source reader signature. */
export type SourceReader = (path: string, maxBytes: number) => Promise<Uint8Array>

/** Dependencies of {@link createLocalEngine} (all optional; the Host supplies real ones). */
export interface CreateLocalEngineOptions {
  /** Resolved config (or the raw row config with a `local:` block). */
  config?: { local?: unknown } | Record<string, unknown>
  /** Host logger. */
  logger?: Logger
  /** Direct Office→PDF service handle (tests); the Host should use `getOfficeToPdf`. */
  officeToPdf?: OfficeToPdfService
  /** Lazy resolver for the optional DSH Office→PDF service (`ctx.get('officeToPdf')`). */
  getOfficeToPdf?: () => unknown
  /** Clock override (tests). */
  now?: () => number
  /** Source reader override (tests). */
  readSourceCapped?: SourceReader
  /** PDF extractor override (tests). */
  pdfExtractor?: PdfExtractor
  /** Office converter override (tests). */
  officeConverter?: OfficeConverter
}

/** The local engine facade consumed by the service layer and the parse manager. */
export interface LocalEngine extends LocalEngineApi {
  readonly config: LocalConfig
  readonly providers: { builtin: string; office: string }
  snapshot: () => LocalCapabilities & { configuration: LocalConfig }
  supports: (meta: LocalDocumentMeta) => { supported: boolean; provider: string | null; reason?: string }
  plan: (meta: LocalDocumentMeta, options?: { localProvider?: LocalProvider }) => LocalPlan
  extract: (input: LocalExtractInput) => Promise<LocalExtractResult>
}

/** Input of the engine's `extract()` method. */
export interface LocalExtractInput {
  id: string
  meta: LocalDocumentMeta
  sourcePath: string
  params?: Record<string, unknown>
  /** Cancellation from the parse manager. */
  signal?: AbortSignal
  onProgress?: (progress: ParseProgress) => void
}

/** Clamp an integer config value into `[min, max]`, falling back on invalid input. */
function pickInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
}

/** Merge the raw `local:` config block over the defaults. */
function resolveLocalConfig(config: unknown): LocalConfig {
  const record = config !== null && typeof config === 'object' ? (config as { local?: unknown }) : {}
  const source: Record<string, unknown> =
    record.local !== null && typeof record.local === 'object' ? (record.local as Record<string, unknown>) : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_LOCAL_CONFIG.enabled,
    maxPages: pickInteger(source.maxPages, DEFAULT_LOCAL_CONFIG.maxPages, 1, 5000),
    maxPdfBytes: pickInteger(source.maxPdfBytes, DEFAULT_LOCAL_CONFIG.maxPdfBytes, 64 * 1024, 2 * 1024 * 1024 * 1024),
    maxTextBytes: pickInteger(source.maxTextBytes, DEFAULT_LOCAL_CONFIG.maxTextBytes, 64 * 1024, 256 * 1024 * 1024),
    minCharsPerPage: pickInteger(source.minCharsPerPage, DEFAULT_LOCAL_CONFIG.minCharsPerPage, 0, 10000),
    maxParagraphChars: pickInteger(source.maxParagraphChars, DEFAULT_LOCAL_CONFIG.maxParagraphChars, 500, 8000),
    keepContentList:
      typeof source.keepContentList === 'boolean' ? source.keepContentList : DEFAULT_LOCAL_CONFIG.keepContentList,
    timeoutMs: pickInteger(source.timeoutMs, DEFAULT_LOCAL_CONFIG.timeoutMs, 1000, 60 * 60 * 1000),
    maxOfficePdfBytes: pickInteger(
      source.maxOfficePdfBytes,
      DEFAULT_LOCAL_CONFIG.maxOfficePdfBytes,
      64 * 1024,
      1024 * 1024 * 1024,
    ),
  }
}

/** Normalize one document extension (`.pdf`). */
function extensionOf(meta: LocalDocumentMeta | undefined): string {
  if (typeof meta?.ext === 'string' && meta.ext !== '') return meta.ext.toLowerCase()
  if (typeof meta?.originalName === 'string') {
    const match = /(\.[^./\\]+)$/.exec(meta.originalName)
    if (match?.[1] !== undefined) return match[1].toLowerCase()
  }
  return ''
}

/** Whether the optional DSH Office→PDF service is currently mounted. */
function officeServiceOf(options: CreateLocalEngineOptions): OfficeToPdfService | undefined {
  try {
    const service = typeof options.getOfficeToPdf === 'function' ? options.getOfficeToPdf() : options.officeToPdf
    if (service === null || typeof service !== 'object') return undefined
    const candidate = service as { convert?: unknown }
    if (typeof candidate.convert !== 'function') return undefined
    return service as OfficeToPdfService
  } catch {
    return undefined
  }
}

/** Default source reader: stat the file, refuse oversized input, then read it. */
async function readFileCapped(path: string, maxBytes: number): Promise<Uint8Array> {
  const info = await stat(path)
  if (info.size > maxBytes) {
    throw new WireError('too-large', `文件超过本地解析上限（File exceeds the local limit of ${maxBytes} bytes）`, 413, {
      limit: maxBytes,
    })
  }
  return readFile(path)
}

/**
 * Create the local engine facade.
 *
 * @param options - injected dependencies (config, logger, optional services, test hooks).
 * @returns the engine facade consumed by the service layer and the parse manager.
 */
export function createLocalEngine(options: CreateLocalEngineOptions = {}): LocalEngine {
  const log: Logger = options.logger ?? {}
  const localConfig = resolveLocalConfig(options.config)
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const readCapped: SourceReader =
    typeof options.readSourceCapped === 'function' ? options.readSourceCapped : readFileCapped
  const extractPdf: PdfExtractor = typeof options.pdfExtractor === 'function' ? options.pdfExtractor : extractPdfText
  const convertOffice: OfficeConverter =
    typeof options.officeConverter === 'function' ? options.officeConverter : convertOfficeToPdf

  const builtinAvailable = localConfig.enabled && pdfjsRuntimeAvailable()

  /** Whether the optional DSH Office→PDF service is currently mounted. */
  function officeAvailableNow(): boolean {
    const service = officeServiceOf(options)
    return localConfig.enabled && service !== undefined
  }

  /** Capability snapshot shared by `status` and `settings.get`. */
  function snapshot(): LocalCapabilities & { configuration: LocalConfig } {
    const officeAvailable = officeAvailableNow()
    const providers: LocalCapabilities['providers'] = [
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
      configuration: { ...localConfig },
    }
  }

  /** Whether the local engine can parse one document, without throwing. */
  function supports(meta: LocalDocumentMeta): { supported: boolean; provider: string | null; reason?: string } {
    if (!localConfig.enabled) return { supported: false, provider: null, reason: 'local parsing is disabled' }
    const ext = extensionOf(meta)
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

  /** Validate parse options and resolve the provider execution plan. */
  function plan(meta: LocalDocumentMeta, planOptions?: { localProvider?: LocalProvider }): LocalPlan {
    if (!localConfig.enabled) {
      throw new WireError('local-missing-tool', '本地解析已禁用（Local parsing is disabled）', 503)
    }
    const support = supports(meta)
    if (!support.supported || support.provider === null) {
      const ext = extensionOf(meta)
      const missingTool = support.reason !== undefined && support.reason.includes('unavailable')
      throw new WireError(
        missingTool ? 'local-missing-tool' : 'local-unsupported',
        missingTool
          ? '本地解析工具不可用；请配置 MinerU Token 或改用云端解析（Local parsing tool unavailable）'
          : `本地解析不支持这种文件 ${ext || '（unknown）'}（Local parsing does not support this file）`,
        missingTool ? 503 : 415,
      )
    }
    const requested = typeof planOptions?.localProvider === 'string' ? planOptions.localProvider : 'auto'
    if (requested !== 'auto' && requested !== support.provider) {
      throw new WireError(
        'local-unsupported',
        `本地解析不支持指定的 provider：${requested}（Unsupported local provider ${requested}）`,
        415,
      )
    }
    const size = typeof meta.size === 'number' && Number.isFinite(meta.size) && meta.size > 0 ? Math.floor(meta.size) : 0
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
        fileName: typeof meta.originalName === 'string' ? meta.originalName : '',
        language: 'local',
        localProvider: support.provider,
      },
    }
  }

  /** Read the requested local provider from raw task params. */
  function localProviderOf(params: Record<string, unknown> | undefined): LocalProvider | undefined {
    const value = params?.localProvider
    if (typeof value !== 'string') return undefined
    return (LOCAL_PROVIDERS as readonly string[]).includes(value) ? (value as LocalProvider) : undefined
  }

  /**
   * Extract one document into the reading-desk artifact payload.
   *
   * @param input - task inputs (id, metadata, source path, params, cancellation).
   * @returns synthesized artifacts plus diagnostics.
   * @throws {WireError} on unsupported input, missing tool, empty text or timeout.
   */
  async function extract(input: LocalExtractInput): Promise<LocalExtractResult> {
    const { id, meta, sourcePath, params, signal, onProgress } = input
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new WireError('host-error', '本地解析缺少源文件路径（Missing source path）', 500)
    }
    const startedAt = clock()
    const execution = plan(meta, { localProvider: localProviderOf(params) })
    const warnings: string[] = []

    // Link caller cancellation with a local deadline.
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), localConfig.timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const linked = signal !== undefined ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    let timedOut = false
    const onLinkedAbort = (): void => {
      if (!timeoutController.signal.aborted) return
      if (signal?.aborted !== true) timedOut = true
    }
    linked.addEventListener('abort', onLinkedAbort, { once: true })

    try {
      let data: Uint8Array
      let toolVersion = `pdfjs-dist/${PDFJS_VERSION}`
      if (execution.provider === OFFICE_PROVIDER) {
        const service = officeServiceOf(options)
        if (service === undefined) {
          throw new WireError(
            'local-missing-tool',
            '当前环境没有 Office 本地转换服务（office-to-pdf）；请配置 MinerU Token 或使用云端解析（Office-to-PDF service is unavailable）',
            503,
          )
        }
        const officeMeta: OfficeDocumentMeta = { ...meta }
        const converted = await convertOffice({
          officeToPdf: service,
          meta: officeMeta,
          readSource: (maxBytes) => readCapped(sourcePath, maxBytes),
          signal: linked,
          maxBytes: localConfig.maxOfficePdfBytes,
          logger: log,
        })
        if (converted.missingFonts.length > 0) warnings.push('missing-fonts')
        data = converted.pdf
        toolVersion = 'office-to-pdf'
      } else {
        data = await readCapped(sourcePath, localConfig.maxPdfBytes)
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
      log.info?.(`[dsh-litnotes] local parse ${id} via ${execution.provider}: ${stats.pageCount} pages, ${stats.textChars} chars, ${stats.extractMs} ms`)
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
      linked.removeEventListener('abort', onLinkedAbort)
    }
  }

  return {
    snapshot,
    supports,
    plan,
    extract,
    config: localConfig,
    // Provider ids under the contract's `{ builtin, office }` keys; the
    // capability rows (ids + availability) are exposed through `snapshot()`.
    providers: { builtin: BUILTIN_PROVIDER, office: OFFICE_PROVIDER },
  }
}

/** Whether the vendored pdf.js runtime exists in this installation. */
export function localPdfRuntimeAvailable(): boolean {
  try {
    return pdfjsRuntimeAvailable()
  } catch {
    return false
  }
}
