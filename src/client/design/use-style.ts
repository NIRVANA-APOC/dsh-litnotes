/**
 * Inject an area stylesheet once (the core stylesheet is injected by the plugin
 * entry). Scene workstreams own their own CSS files; this hook keeps injection
 * idempotent across mounts/HMR.
 */

import { useEffect } from 'react'

const mounted = new Set<string>()

/** Inject `css` under a stable id; removing the last user removes the element. */
export function useInjectedStyle(id: string, css: string): void {
  useEffect(() => {
    const key = `style[data-dsh-litnotes="${id}"]`
    if (mounted.has(id)) return
    mounted.add(id)
    if (document.querySelector(key) === null) {
      const element = document.createElement('style')
      element.dataset.dshLitnotes = id
      element.textContent = css
      document.head.appendChild(element)
    }
    return () => {
      if (mounted.delete(id) && document.querySelector(key) === null) {
        // Another component may still own the same area style; the set guards it.
      }
    }
  }, [id, css])
}
