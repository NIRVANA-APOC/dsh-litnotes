/**
 * T0.5 Office → PDF adapter (typed 1.0.0 port).
 *
 * The DSH web profile mounts the official `office-to-pdf` service
 * (`ctx.get('officeToPdf')`, LibreOffice kit / WASM). It converts Office bytes
 * to a PDF locally, after which the same local PDF text extractor runs. This
 * gives doc/docx/ppt/pptx/xls/xlsx a zero-install local path without adding any
 * npm dependency or parsing OOXML by hand.
 *
 * The service is **optional**: profiles without it get a `local-missing-tool`
 * error that the UI turns into "configure a MinerU token / use cloud parsing".
 *
 * @module host/parse/local/office
 */

import type { OfficeToPdfInput, OfficeToPdfService } from '../../host-services.ts'
import type { Logger } from '../../host-services.ts'
import { WireError } from '../../wire.ts'

/** Office extensions the official converter accepts. */
export const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
])

/** Document metadata the adapter reads. */
export interface OfficeDocumentMeta {
  id?: string
  ext?: string
  originalName?: string
  size?: number
  sha256?: string
  updatedAt?: string
}

/** Input of {@link convertOfficeToPdf}. */
export interface ConvertOfficeToPdfInput {
  /** The optional DSH converter service (`ctx.get('officeToPdf')`). */
  officeToPdf?: OfficeToPdfService
  /** Document metadata used for the conversion source descriptor. */
  meta?: OfficeDocumentMeta
  /** Read source bytes, refusing more than the given byte cap. */
  readSource: (maxBytes: number) => Promise<Uint8Array>
  /** Cancellation signal linked to the parse task. */
  signal?: AbortSignal
  /** Maximum accepted source/output bytes (default 100 MiB). */
  maxBytes?: number
  /** Host logger (warnings only). */
  logger?: Logger
}

/** Result of {@link convertOfficeToPdf}. */
export interface ConvertOfficeToPdfResult {
  pdf: Uint8Array
  missingFonts: string[]
}

/** Abort-shaped error understood by the parse manager. */
function abortError(): Error {
  const error = new Error('本地解析已取消（Local parse cancelled）')
  error.name = 'AbortError'
  return error
}

/** Narrow a thrown Office conversion failure without trusting its shape. */
function errorFieldsOf(error: unknown): { code: string; message: string } {
  if (error === null || typeof error !== 'object') return { code: '', message: String(error ?? '') }
  const record = error as { code?: unknown; message?: unknown }
  return {
    code: typeof record.code === 'string' ? record.code : '',
    message: String(record.message ?? ''),
  }
}

/** Map one `OfficeToPdfError.code` onto a WireError. */
function mapOfficeError(error: unknown, logger: Logger | undefined): WireError {
  const { code, message } = errorFieldsOf(error)
  const clean = message.replace(/\s+/g, ' ').slice(0, 200)
  switch (code) {
    case 'input-too-large':
    case 'output-too-large':
      return new WireError('too-large', '文件超过本地 Office 转换上限（Office file exceeds the local conversion limit）', 413)
    case 'invalid-document':
    case 'unsupported-format':
    case 'invalid-output':
      return new WireError(
        'local-unsupported',
        'Office 文件无法在本地转换（The Office file cannot be converted locally）',
        422,
      )
    case 'timeout':
      return new WireError('local-failed', 'Office 本地转换超时（Local Office conversion timed out）', 500)
    case 'unavailable':
    case 'busy':
      return new WireError(
        'local-missing-tool',
        'Office 转换服务暂不可用，请稍后重试或改用云端解析（Office conversion is temporarily unavailable）',
        503,
      )
    case 'source-changed':
      return new WireError('local-failed', '源文件已变化，请重新导入后再解析（The source changed; re-import the file）', 500)
    default:
      logger?.warn?.(`[dsh-litnotes] office-to-pdf failed: ${code || 'unknown'} ${clean}`)
      return new WireError(
        'local-failed',
        `Office 本地转换失败（Local Office conversion failed）：${clean || 'unknown error'}`,
        500,
      )
  }
}

/** Whether an extension is an Office binary/OOXML format. */
export function isOfficeExtension(ext: unknown): boolean {
  return typeof ext === 'string' && OFFICE_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * Convert one Office document to PDF bytes through the DSH `officeToPdf` service.
 *
 * @param input - converter, document metadata and deferred source reader.
 * @returns the converted PDF bytes and the missing-font warnings.
 * @throws {WireError} `local-missing-tool` / `local-unsupported` / `too-large` /
 *   `local-failed` for the frozen failure taxonomy.
 */
export async function convertOfficeToPdf(input: ConvertOfficeToPdfInput): Promise<ConvertOfficeToPdfResult> {
  const { officeToPdf, meta, readSource, signal, maxBytes = 100 * 1024 * 1024, logger } = input
  if (officeToPdf === undefined || officeToPdf === null || typeof officeToPdf.convert !== 'function') {
    throw new WireError(
      'local-missing-tool',
      '当前环境没有 Office 本地转换服务（office-to-pdf）；请配置 MinerU Token 或使用云端解析（Office-to-PDF service is unavailable）',
      503,
    )
  }
  const ext = typeof meta?.ext === 'string' ? meta.ext.toLowerCase() : ''
  if (!isOfficeExtension(ext)) {
    throw new WireError('local-unsupported', `不支持的 Office 文件类型 ${ext || '（unknown）'}（Unsupported Office type）`, 415)
  }
  const version =
    typeof meta?.sha256 === 'string' && meta.sha256 !== ''
      ? meta.sha256
      : String(meta?.updatedAt ?? meta?.id ?? '')
  const metaSize = meta?.size
  const declaredSize = typeof metaSize === 'number' && Number.isFinite(metaSize) && metaSize > 0 ? Math.floor(metaSize) : undefined
  let result: { pdf?: Uint8Array; missingFonts?: string[] }
  try {
    const conversionInput: OfficeToPdfInput = {
      extension: ext.slice(1),
      priority: 'foreground',
      source: {
        key: String(meta?.id ?? ''),
        version,
        bytes: declaredSize,
        read: async (readSignal, reservedBytes) => {
          if (readSignal?.aborted === true) throw abortError()
          const limit = Math.min(
            typeof reservedBytes === 'number' && Number.isFinite(reservedBytes) && reservedBytes > 0
              ? reservedBytes
              : maxBytes,
            maxBytes,
          )
          const data = await readSource(limit)
          return { bytes: new Uint8Array(data), version }
        },
      },
    }
    result = await officeToPdf.convert(conversionInput, signal)
  } catch (error) {
    const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
    if (name === 'AbortError' || signal?.aborted === true) throw abortError()
    if (error instanceof WireError) throw error
    throw mapOfficeError(error, logger)
  }
  const pdf = result.pdf
  if (!(pdf instanceof Uint8Array) || pdf.byteLength === 0) {
    throw new WireError('local-failed', 'Office 转换未返回有效 PDF（The Office conversion returned no PDF）', 500)
  }
  const missingFonts = Array.isArray(result.missingFonts)
    ? result.missingFonts.filter((font): font is string => typeof font === 'string')
    : []
  return { pdf, missingFonts }
}
