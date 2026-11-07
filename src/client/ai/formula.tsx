/**
 * KaTeX loading for AI answers.
 *
 * The vendored KaTeX runtime (`.agents`-plan ALGORITHMS.md: "the mature
 * renderer, loaded lazily as a static asset") is fetched through the Host's
 * vendored-asset route only when an answer actually contains formula runs. The
 * loader is a module singleton with subscribe semantics so any number of
 * streaming answers can share one script/stylesheet pair.
 *
 * Failure is non-fatal: formulas fall back to their LaTeX source as plain text.
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { getHostClient } from '../api/client.ts'

/** Lifecycle of the lazy KaTeX runtime. */
export type KatexStatus = 'idle' | 'loading' | 'ready' | 'failed'

/** The global object the vendored browser build installs. */
interface KatexGlobal {
  renderToString: (latex: string, options?: Record<string, unknown>) => string
}

let status: KatexStatus = 'idle'
const listeners = new Set<(next: KatexStatus) => void>()

/** Publish one status transition to every subscriber. */
function setStatus(next: KatexStatus): void {
  status = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch {
      /* a subscriber failure must not break the others */
    }
  }
}

/** Current loader status (read-only snapshot for tests). */
export function katexStatus(): KatexStatus {
  return status
}

/** Read the vendored runtime from the global scope, when loaded. */
function katexGlobal(): KatexGlobal | null {
  const candidate = (globalThis as { katex?: unknown }).katex
  if (candidate !== null && typeof candidate === 'object') {
    const api = candidate as { renderToString?: unknown }
    if (typeof api.renderToString === 'function') return candidate as KatexGlobal
  }
  return null
}

/** Subscribe to KaTeX status changes (returns a disposer). */
export function subscribeKatex(listener: (next: KatexStatus) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Inject the vendored stylesheet and script once. */
export function ensureKatex(): void {
  if (status === 'loading' || status === 'ready') return
  if (typeof document === 'undefined') {
    setStatus('failed')
    return
  }
  if (katexGlobal() !== null) {
    setStatus('ready')
    return
  }
  setStatus('loading')
  try {
    const client = getHostClient()
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = client.vendor('katex/katex.min.css')
    link.dataset.dshLitnotes = 'katex'
    document.head.appendChild(link)
    const script = document.createElement('script')
    script.src = client.vendor('katex/katex.min.js')
    script.async = true
    script.dataset.dshLitnotes = 'katex'
    script.addEventListener('load', () => setStatus(katexGlobal() !== null ? 'ready' : 'failed'))
    script.addEventListener('error', () => setStatus('failed'))
    document.head.appendChild(script)
  } catch {
    setStatus('failed')
  }
}

/**
 * Render one LaTeX string with KaTeX.
 *
 * @param latex - LaTeX source.
 * @param display - display (block) mode.
 * @returns trusted KaTeX HTML, or null when the runtime is unavailable/errors.
 */
export function renderKatex(latex: string, display: boolean): string | null {
  const api = katexGlobal()
  if (api === null) return null
  try {
    return api.renderToString(latex, { displayMode: display, throwOnError: false, strict: 'ignore' })
  } catch {
    return null
  }
}

/** Whether the lazy runtime has finished loading. */
export function useKatexReady(): boolean {
  const [ready, setReady] = useState<boolean>(status === 'ready')
  useEffect(() => {
    if (status === 'idle') ensureKatex()
    setReady(status === 'ready')
    return subscribeKatex((next) => setReady(next === 'ready'))
  }, [])
  return ready
}

/** Props of {@link Formula}. */
export interface FormulaProps {
  latex: string
  display?: boolean
  className?: string
}

/**
 * One formula: KaTeX output when the runtime is ready, LaTeX source otherwise.
 *
 * KaTeX output is injected as HTML because that is its documented contract
 * (models never author raw HTML: `markdown-it` runs with `html:false`).
 */
export function Formula({ latex, display = false, className }: FormulaProps): ReactElement {
  const ready = useKatexReady()
  const html = ready ? renderKatex(latex, display) : null
  const classes = display ? 'ln-ai__formula ln-ai__formula--display' : 'ln-ai__formula'
  if (html !== null) {
    return (
      <span
        className={className === undefined ? classes : `${classes} ${className}`}
        data-display={display ? 'true' : undefined}
        // KaTeX-authored markup, not model-authored HTML (html:false above).
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <span
      className={className === undefined ? `${classes} is-source` : `${classes} ${className} is-source`}
      data-display={display ? 'true' : undefined}
      title={latex}
    >
      {display ? `$$${latex}$$` : `$${latex}$`}
    </span>
  )
}
