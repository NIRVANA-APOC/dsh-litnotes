/**
 * KaTeX loader — lazily loads the vendored runtime through `client.vendor(...)`.
 *
 * The 1.0.0 client loaded `vendor/katex/katex.min.js` + `.css` as static
 * assets; 2.0 keeps that approach (ALGORITHMS.md "Vendored KaTeX runtime —
 * already the mature renderer; loaded lazily as a static asset") because the
 * math renderer is large and most papers never need it. The global `katex`
 * object is the host the runtime installs on `window`; formulas render as raw
 * source until it is ready and never block the sheet.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { getHostClient } from '../api/client.ts'

/** Subset of the KaTeX global this plugin uses. */
interface KatexGlobal {
  renderToString(
    latex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean; strict?: 'ignore' | 'warn' | 'error' | boolean },
  ): string
}

/** Where the lazy runtime currently is. */
export type KatexStatus = 'idle' | 'loading' | 'ready' | 'failed'

type Listener = (status: KatexStatus) => void

const listeners = new Set<Listener>()

let status: KatexStatus = 'idle'
let scriptElement: HTMLScriptElement | null = null
let styleElement: HTMLLinkElement | null = null

/** Read the global KaTeX object the vendored script installs. */
function katexGlobal(): KatexGlobal | null {
  if (typeof window === 'undefined') return null
  const runtime = (window as unknown as { katex?: unknown }).katex
  if (runtime === null || typeof runtime !== 'object') return null
  const candidate = runtime as { renderToString?: unknown }
  if (typeof candidate.renderToString !== 'function') return null
  return runtime as KatexGlobal
}

/** Publish a new loader status to every subscriber. */
function setStatus(next: KatexStatus): void {
  if (status === next) return
  status = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch {
      // A subscriber failure must not break the loader.
    }
  }
}

/**
 * Load the vendored KaTeX runtime + stylesheet once.
 *
 * Idempotent and safe when called before mount; failures stay quiet (the
 * reader keeps rendering raw `$…$` source).
 */
export function ensureKatex(): void {
  if (typeof document === 'undefined') {
    setStatus('failed')
    return
  }
  if (katexGlobal() !== null) {
    setStatus('ready')
    return
  }
  if (status === 'loading') return
  setStatus('loading')
  const client = getHostClient()
  try {
    if (styleElement === null) {
      styleElement = document.createElement('link')
      styleElement.rel = 'stylesheet'
      styleElement.href = client.vendor('katex/katex.min.css')
      styleElement.setAttribute('data-dsh-litnotes', 'katex')
      document.head.appendChild(styleElement)
    }
    if (scriptElement === null) {
      scriptElement = document.createElement('script')
      scriptElement.src = client.vendor('katex/katex.min.js')
      scriptElement.async = true
      scriptElement.setAttribute('data-dsh-litnotes', 'katex')
      scriptElement.onload = () => setStatus(katexGlobal() !== null ? 'ready' : 'failed')
      scriptElement.onerror = () => setStatus('failed')
      document.head.appendChild(scriptElement)
    }
  } catch {
    setStatus('failed')
  }
}

/** Current loader status (non-reactive). */
export function getKatexStatus(): KatexStatus {
  return status
}

/** Subscribe to loader status changes (returns a disposer). */
export function subscribeKatex(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Remove the injected runtime (plugin unload / tests). */
export function disposeKatex(): void {
  listeners.clear()
  scriptElement?.parentNode?.removeChild(scriptElement)
  styleElement?.parentNode?.removeChild(styleElement)
  scriptElement = null
  styleElement = null
  status = 'idle'
}

/**
 * Render one LaTeX formula to sanitized KaTeX HTML.
 *
 * Returns an empty string until the runtime is ready or when KaTeX rejects the
 * source; callers fall back to the raw source in monospace.
 */
export function renderFormula(latex: string, display: boolean): string {
  const runtime = katexGlobal()
  if (runtime === null || latex.trim() === '') return ''
  try {
    return runtime.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
    })
  } catch {
    return ''
  }
}

/** Reactive KaTeX readiness; loading starts on first use. */
export function useKatexReady(): boolean {
  const snapshot = useSyncExternalStore(
    (onChange) => subscribeKatex(() => onChange()),
    () => status,
    () => 'idle' as KatexStatus,
  )
  useEffect(() => {
    if (snapshot === 'idle') ensureKatex()
  }, [snapshot])
  return snapshot === 'ready'
}
