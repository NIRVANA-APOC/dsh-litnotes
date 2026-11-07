/**
 * File-download helper for the AI margin (frozen ALGORITHMS.md #20: platform
 * `Blob` + `URL.createObjectURL` + a temporary `<a download>`).
 *
 * The component never touches `document.body` (the answer renderer must stay
 * inert); a detached anchor still triggers the download in every supported
 * browser.
 */

/**
 * Download one text file.
 *
 * @param filename - suggested filename (already sanitized by the caller).
 * @param text - file content.
 * @param mime - MIME type of the blob.
 * @returns whether the download could be triggered.
 */
export function downloadText(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): boolean {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return false
  }
  let url: string | null = null
  try {
    const blob = new Blob([text], { type: mime })
    url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    anchor.click()
    return true
  } catch {
    return false
  } finally {
    if (url !== null) {
      const revoke = (): void => URL.revokeObjectURL(url as string)
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(revoke, 1000)
      }
    }
  }
}
