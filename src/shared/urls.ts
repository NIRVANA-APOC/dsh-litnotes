/**
 * URL helpers shared by the Client half and the tests.
 *
 * Every URL is resolved against `document.baseURI` (or an explicit base), so a
 * reverse-proxied GUI that mounts the app under a path prefix keeps working.
 * The Host half never builds these URLs; it only answers them.
 */

import { API_PREFIX, ASSETS_PREFIX } from './constants.ts'

/** API base used when no document base is available (Node tests, SSR). */
export const API_BASE_FALLBACK = `http://localhost${API_PREFIX}`

/** Resolve a path against a base URL, tolerating a missing `document`. */
export function resolveUrl(path: string, base?: string | URL): string {
  const baseValue =
    base ??
    (typeof document !== 'undefined' && typeof document.baseURI === 'string'
      ? document.baseURI
      : 'http://localhost/')
  return new URL(path.replace(/^\/+/, ''), baseValue).toString()
}

/** Absolute URL of one JSON API method. */
export function apiUrl(method: string, base?: string | URL): string {
  return resolveUrl(`${API_PREFIX}/${method}`, base)
}

/** Absolute URL of one NDJSON streaming method. */
export function streamUrl(method: string, base?: string | URL): string {
  return apiUrl(method, base)
}

/** Absolute URL of the raw upload route. */
export function uploadUrl(base?: string | URL): string {
  return apiUrl('upload', base)
}

/** Absolute URL of a parsed-document asset (image/table attachment). */
export function assetUrl(documentId: string, relativePath: string, base?: string | URL): string {
  const url = new URL(resolveUrl(`${API_PREFIX}/asset`, base))
  url.searchParams.set('id', documentId)
  url.searchParams.set('path', relativePath)
  return url.toString()
}

/** Absolute URL of a document's original source file. */
export function sourceUrl(documentId: string, options: { download?: boolean } = {}, base?: string | URL): string {
  const url = new URL(resolveUrl(`${API_PREFIX}/source`, base))
  url.searchParams.set('id', documentId)
  if (options.download) url.searchParams.set('download', '1')
  return url.toString()
}

/** Absolute URL of a vendored package asset (KaTeX runtime, fonts). */
export function vendorAssetUrl(relativePath: string, base?: string | URL): string {
  return resolveUrl(`${ASSETS_PREFIX}/${relativePath.replace(/^\/+/, '')}`, base)
}
