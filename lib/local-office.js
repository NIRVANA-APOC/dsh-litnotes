/**
 * T0.5 Office → PDF adapter for dsh-litnotes.
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
 * @module lib/local-office
 */
import { WireError } from './wire.js'

/** Office extensions the official converter accepts. */
export const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'])

/**
 * @param {unknown} ext - file extension such as `.docx`.
 * @returns {boolean} whether the extension is an Office binary/OOXML format.
 */
export function isOfficeExtension(ext) {
  return typeof ext === 'string' && OFFICE_EXTENSIONS.has(ext.toLowerCase())
}

/** Map one `OfficeToPdfError.code` onto a WireError. */
function mapOfficeError(error, logger) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').slice(0, 200)
  switch (code) {
    case 'input-too-large':
    case 'output-too-large':
      return new WireError('too-large', '文件超过本地 Office 转换上限（Office file exceeds the local conversion limit）', 413)
    case 'invalid-document':
    case 'unsupported-format':
    case 'invalid-output':
      return new WireError('local-unsupported', 'Office 文件无法在本地转换（The Office file cannot be converted locally）', 422)
    case 'timeout':
      return new WireError('local-failed', 'Office 本地转换超时（Local Office conversion timed out）', 500)
    case 'unavailable':
    case 'busy':
      return new WireError('local-missing-tool', 'Office 转换服务暂不可用，请稍后重试或改用云端解析（Office conversion is temporarily unavailable）', 503)
    case 'source-changed':
      return new WireError('local-failed', '源文件已变化，请重新导入后再解析（The source changed; re-import the file）', 500)
    default:
      logger?.warn?.(`[dsh-litnotes] office-to-pdf failed: ${code || 'unknown'} ${message}`)
      return new WireError('local-failed', `Office 本地转换失败（Local Office conversion failed）：${message || 'unknown error'}`, 500)
  }
}

/**
 * Convert one Office document to PDF bytes through the DSH `officeToPdf` service.
 *
 * @param {{
 *   officeToPdf?: { convert?: Function },
 *   meta: { id: string, ext?: string, size?: number, sha256?: string, updatedAt?: string },
 *   readSource: (maxBytes?: number) => Promise<Uint8Array|Buffer>,
 *   signal?: AbortSignal,
 *   maxBytes?: number,
 *   logger?: { warn?: Function },
 * }} input - converter, document metadata and deferred source reader.
 * @returns {Promise<{pdf: Uint8Array, missingFonts: string[]}>} converted PDF.
 */
export async function convertOfficeToPdf({ officeToPdf, meta, readSource, signal, maxBytes = 100 * 1024 * 1024, logger } = {}) {
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
  if (typeof readSource !== 'function') throw new TypeError('convertOfficeToPdf: readSource is required')
  const version = typeof meta?.sha256 === 'string' && meta.sha256 !== ''
    ? meta.sha256
    : String(meta?.updatedAt ?? meta?.id ?? '')
  const declaredSize = Number.isFinite(meta?.size) && meta.size > 0 ? Math.floor(meta.size) : undefined
  let result
  try {
    result = await officeToPdf.convert(
      {
        extension: ext.slice(1),
        priority: 'foreground',
        source: {
          key: String(meta?.id ?? ''),
          version,
          bytes: declaredSize,
          read: async (readSignal, reservedBytes) => {
            if (readSignal?.aborted) throw abortError()
            const limit = Math.min(
              Number.isFinite(reservedBytes) && reservedBytes > 0 ? reservedBytes : maxBytes,
              maxBytes,
            )
            const data = await readSource(limit)
            return { bytes: new Uint8Array(data), version }
          },
        },
      },
      signal,
    )
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw abortError()
    if (error instanceof WireError) throw error
    throw mapOfficeError(error, logger)
  }
  const pdf = result?.pdf
  if (!(pdf instanceof Uint8Array) || pdf.byteLength === 0) {
    throw new WireError('local-failed', 'Office 转换未返回有效 PDF（The Office conversion returned no PDF）', 500)
  }
  return {
    pdf,
    missingFonts: Array.isArray(result?.missingFonts) ? result.missingFonts.filter((font) => typeof font === 'string') : [],
  }
}

/** Abort-shaped error understood by the parse manager. */
function abortError() {
  const error = new Error('本地解析已取消（Local parse cancelled）')
  error.name = 'AbortError'
  return error
}
