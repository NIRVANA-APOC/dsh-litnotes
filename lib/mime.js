/**
 * File extension and content-type map for the dsh-litnotes Host half.
 *
 * The supported source list is exactly what the MinerU standard API accepts
 * (see docs/MINERU.md §A). Extracted parse assets (images) use the wider
 * {@link IMAGE_EXTENSIONS} set because MinerU archives may contain formats the
 * upload path never accepts.
 *
 * @module lib/mime
 */

/**
 * Extensions accepted for an uploaded / imported source document.
 * Lowercase and dot-prefixed.
 * @type {ReadonlySet<string>}
 */
export const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.jp2',
  '.webp',
  '.gif',
  '.bmp',
  '.html',
  '.htm',
])

/**
 * Image extensions served from `parsed/images/**`; `.svg` is included for
 * MinerU output and for the vendored asset route.
 * @type {ReadonlySet<string>}
 */
export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.jp2',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
])

/** Exact extension → content type table. */
const MIME_BY_EXTENSION = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.jp2', 'image/jp2'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.wasm', 'application/wasm'],
  ['.ico', 'image/x-icon'],
])

/**
 * Lowercased extension including the leading dot, or `''` when the name has
 * none. Only the last extension is considered (`paper.tar.gz` → `.gz`).
 *
 * @param {unknown} fileName - file name or path.
 * @returns {string} e.g. `.pdf`.
 */
export function extOf(fileName) {
  if (typeof fileName !== 'string') return ''
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot).toLowerCase()
}

/**
 * Content type for a path or file name; unknown extensions get the generic
 * binary type so a download still works.
 *
 * @param {unknown} filePath - path or file name.
 * @returns {string} content type header value.
 */
export function mimeForPath(filePath) {
  return MIME_BY_EXTENSION.get(extOf(filePath)) ?? 'application/octet-stream'
}

/**
 * Whether a file name is an accepted MinerU source document.
 *
 * @param {unknown} fileName - file name or path.
 * @returns {boolean} true when the extension is in {@link SUPPORTED_EXTENSIONS}.
 */
export function isSupportedSource(fileName) {
  return SUPPORTED_EXTENSIONS.has(extOf(fileName))
}

/**
 * Whether a file name has an image extension (including `.svg`).
 * @param {unknown} fileName - file name or path.
 * @returns {boolean} true for images.
 */
export function isImagePath(fileName) {
  return IMAGE_EXTENSIONS.has(extOf(fileName))
}
