/**
 * File extension and content-type map for the dsh-litnotes Host half.
 *
 * The supported source list is exactly what the MinerU standard API accepts
 * (see docs/MINERU.md §A). Extracted parse assets (images) use the wider
 * {@link IMAGE_EXTENSIONS} set because MinerU archives may contain formats the
 * upload path never accepts.
 *
 * This module is pure data plus string helpers: no filesystem access, so the
 * route layer, the store and the parse pipeline can all share it.
 *
 * @module host/mime
 */

import {
  IMAGE_EXTENSIONS as SHARED_IMAGE_EXTENSIONS,
  SUPPORTED_EXTENSIONS as SHARED_SUPPORTED_EXTENSIONS,
} from '../shared/constants.ts'

/**
 * Extensions accepted for an uploaded or imported source document.
 * Lowercase and dot-prefixed.
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(SHARED_SUPPORTED_EXTENSIONS)

/**
 * Image extensions served from `parsed/images/**`; `.svg` is included for
 * MinerU output and for the vendored asset route.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(SHARED_IMAGE_EXTENSIONS)

/** Exact extension → content type table. */
const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
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
 * @param fileName - file name or path (any non-string yields `''`).
 * @returns the lowercased extension, e.g. `.pdf`.
 */
export function extOf(fileName: unknown): string {
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
 * @param filePath - path or file name.
 * @returns the `content-type` header value.
 */
export function mimeForPath(filePath: unknown): string {
  return MIME_BY_EXTENSION.get(extOf(filePath)) ?? 'application/octet-stream'
}

/**
 * Whether a file name is an accepted MinerU source document.
 *
 * @param fileName - file name or path.
 * @returns true when the extension is in {@link SUPPORTED_EXTENSIONS}.
 */
export function isSupportedSource(fileName: unknown): boolean {
  return SUPPORTED_EXTENSIONS.has(extOf(fileName))
}

/**
 * Whether a file name has an image extension (including `.svg`).
 *
 * @param fileName - file name or path.
 * @returns true for image paths.
 */
export function isImagePath(fileName: unknown): boolean {
  return IMAGE_EXTENSIONS.has(extOf(fileName))
}
