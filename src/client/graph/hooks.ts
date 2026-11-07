/**
 * Small graph-scene hooks.
 *
 * `useMediaQuery` in the design primitives assumes `window.matchMedia` exists;
 * the graph owners keep a guarded local variant so the scene also renders under
 * minimal DOM environments (happy-dom tests, embedded webviews).
 */

import { useEffect, useState } from 'react'

/** Whether a media query matches (guarded; `false` without `matchMedia`). */
export function useGraphMediaQuery(query: string): boolean {
  const read = (): boolean => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  )
  const [matches, setMatches] = useState<boolean>(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = (): void => setMatches(list.matches)
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}
