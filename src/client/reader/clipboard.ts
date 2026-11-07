/**
 * Clipboard helper (copy translation / note quote).
 *
 * Prefers the async clipboard API; falls back to the legacy selection +
 * `execCommand` path for hosts that block clipboard writes. Never throws: the
 * caller decides whether to report the failure.
 */

/**
 * Copy one string to the clipboard.
 *
 * @returns whether the copy appears to have succeeded.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  if (typeof document === 'undefined') return false
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
    area.parentNode?.removeChild(area)
    return ok
  } catch {
    return false
  }
}
