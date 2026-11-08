/**
 * The tether layer — the product's memorable element (DESIGN-V2 §2).
 *
 * A 1px hairline in the annotation's aspect ink runs from a margin slip to the
 * exact sentence it rests on. Tethers are content, not decoration: they encode
 * provenance. The layer is a fixed, pointer-events:none SVG overlay; geometry is
 * measured from the live DOM with `getBoundingClientRect()` after layout (no
 * canvas measurements), recomputed on scroll/resize/margin-entry changes, and
 * skipped entirely under `prefers-reduced-motion` for the draw-in animation
 * (the line itself stays — it is information).
 *
 * Works for reader notes and AI margin entries alike: every entry root carries
 * `data-anchor-block` (and optionally `data-anchor-id` to target one mark).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import { useMediaQuery } from '../design/primitives.tsx'

/** One rendered tether line in viewport coordinates. */
interface TetherLine {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  aspect: string
  active: boolean
}

/** Props of the tether layer. */
export interface TethersProps {
  /** The scrolling read container (scroll events drive remeasurement). */
  scrollRef: RefObject<HTMLElement | null>
  /** The paper column (tether destination). */
  paperRef: RefObject<HTMLElement | null>
  /** The margin column (tether origin). */
  marginRef: RefObject<HTMLElement | null>
  /** Active/flashed annotation id (emphasized tether). */
  activeAnnotationId: string | null
  /** Hovered annotation id (emphasized tether + underlined sentence). */
  hoveredAnnotationId: string | null
  /** Hovered block key (AI entries anchor at block level). */
  hoveredBlockKey: string | null
  /** Any value that changes when entries/annotations change (recompute trigger). */
  revision: number
  /** Disable the layer entirely (narrow layout overlay, tests). */
  enabled?: boolean
}

/** Escape a value for use inside a quoted attribute selector. */
function escapeSelector(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/** Whether a rectangle is at least partly inside the viewport. */
function intersectsViewport(rect: DOMRect): boolean {
  if (typeof window === 'undefined') return false
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
}

/** Measure one entry's tether endpoint. */
function targetOf(
  paper: HTMLElement,
  anchorBlockKey: string,
  anchorId: string | null,
): DOMRect | null {
  try {
    if (anchorId !== null && anchorId !== '') {
      const mark = paper.querySelector<HTMLElement>(
        `[data-annotation-id="${escapeSelector(anchorId)}"],[data-id="${escapeSelector(anchorId)}"]`,
      )
      if (mark !== null) return mark.getBoundingClientRect()
    }
    const block = paper.querySelector<HTMLElement>(
      `[data-block-key="${escapeSelector(anchorBlockKey)}"]`,
    )
    return block === null ? null : block.getBoundingClientRect()
  } catch {
    return null
  }
}

/** The tether layer component. */
export function Tethers({
  scrollRef,
  paperRef,
  marginRef,
  activeAnnotationId,
  hoveredAnnotationId,
  hoveredBlockKey,
  revision,
  enabled = true,
}: TethersProps): ReactElement | null {
  const [lines, setLines] = useState<TetherLine[]>([])
  const frameRef = useRef<number | null>(null)
  // Tethers are content, but the task's accessibility floor asks for a
  // non-motion fallback: under reduced motion the slips still show the aspect
  // dot + quote, so the provenance hairline is not drawn.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const active = enabled && !reducedMotion

  const update = useCallback((): void => {
    frameRef.current = null
    const paper = paperRef.current
    const margin = marginRef.current
    if (!active || paper === null || margin === null) {
      setLines((previous) => (previous.length === 0 ? previous : []))
      return
    }
    const entries: HTMLElement[] = []
    margin.querySelectorAll<HTMLElement>('[data-anchor-block]').forEach((element) => {
      if (element.closest('[aria-hidden="true"]') !== null) return
      const blockKey = element.dataset.anchorBlock
      if (blockKey !== undefined && blockKey !== '') entries.push(element)
    })
    // The docked AI panel is a separate surface: a tether must point at the
    // panel's left edge, never across the cards inside it.
    const panel = margin.closest<HTMLElement>('.ln-ai-panel')
    const panelRect = panel === null ? null : panel.getBoundingClientRect()
    const marginRect = margin.getBoundingClientRect()
    const next: TetherLine[] = []
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (entry === undefined) continue
      const blockKey = entry.dataset.anchorBlock ?? ''
      const anchorId = entry.dataset.anchorId ?? null
      const annotationId = entry.dataset.annotationId ?? anchorId
      const entryRect = entry.getBoundingClientRect()
      if (!intersectsViewport(entryRect)) continue
      const target = targetOf(paper, blockKey, anchorId)
      if (target === null || !intersectsViewport(target)) continue
      let x1 = entryRect.left - 6
      let y1 = entryRect.top + Math.min(16, Math.max(10, entryRect.height / 2))
      if (panelRect !== null) {
        x1 = Math.round(panelRect.left - 2)
        const anchor = entryRect.top + Math.min(16, Math.max(10, entryRect.height / 2))
        y1 = Math.round(Math.min(Math.max(anchor, marginRect.top + 8), marginRect.bottom - 8))
      }
      const x2 = Math.min(target.right + 6, x1 - 8)
      if (x2 >= x1) continue
      const y2 = target.top + Math.min(14, Math.max(6, target.height / 2))
      const active =
        (annotationId !== null && annotationId === activeAnnotationId) ||
        (annotationId !== null && annotationId === hoveredAnnotationId) ||
        (hoveredBlockKey !== null && hoveredBlockKey === blockKey)
      const aspect = entry.dataset.aspect
      next.push({
        key: `${blockKey}:${annotationId ?? index}`,
        x1,
        y1,
        x2,
        y2,
        aspect: aspect === undefined || aspect === '' ? 'definition' : aspect,
        active,
      })
    }
    setLines((previous) => {
      if (previous.length === next.length) {
        let same = true
        for (let index = 0; index < next.length; index += 1) {
          const before = previous[index]
          const after = next[index]
          if (
            before === undefined ||
            after === undefined ||
            before.key !== after.key ||
            before.x1 !== after.x1 ||
            before.y1 !== after.y1 ||
            before.x2 !== after.x2 ||
            before.y2 !== after.y2 ||
            before.active !== after.active ||
            before.aspect !== after.aspect
          ) {
            same = false
            break
          }
        }
        if (same) return previous
      }
      return next
    })
  }, [
    active,
    activeAnnotationId,
    hoveredAnnotationId,
    hoveredBlockKey,
    marginRef,
    paperRef,
  ])

  const schedule = useCallback((): void => {
    if (typeof window === 'undefined') {
      update()
      return
    }
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(update)
  }, [update])

  useEffect(() => {
    schedule()
    return () => {
      if (frameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [schedule, revision])

  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return undefined
    scroller.addEventListener('scroll', schedule, { passive: true })
    // The margin column scrolls independently on desktop.
    const marginScroller = marginRef.current
    marginScroller?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const paper = paperRef.current
    const margin = marginRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => schedule())
      if (paper !== null) observer.observe(paper)
      if (margin !== null) observer.observe(margin)
    }
    // AI margin entries mount/stream independently of reader state; any child
    // list change in the margin re-measures the tether endpoints.
    let mutations: MutationObserver | null = null
    if (margin !== null && typeof MutationObserver !== 'undefined') {
      mutations = new MutationObserver(() => schedule())
      mutations.observe(margin, { childList: true, subtree: true })
    }
    return () => {
      scroller.removeEventListener('scroll', schedule)
      marginScroller?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [marginRef, paperRef, schedule, scrollRef])

  if (!active || lines.length === 0) return null
  return (
    <svg className="ln-tether-layer" aria-hidden="true">
      {lines.map((line) => (
        <line
          key={line.key}
          className="ln-tether"
          data-aspect={line.aspect}
          data-active={line.active ? 'true' : undefined}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
        />
      ))}
    </svg>
  )
}
