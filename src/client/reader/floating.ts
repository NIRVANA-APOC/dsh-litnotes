/**
 * Floating-ui plumbing for the reader overlays (selection toolbar, selection
 * translation card, note editor).
 *
 * The reader's overlays are anchored to a DOM `Range` rectangle captured when
 * the selection was read, not to a stable element, so they use floating-ui's
 * virtual-element support with a fixed strategy and the same small middleware
 * stack (offset → flip → shift) for every overlay.
 */

import { flip, offset, shift, useFloating } from '@floating-ui/react'
import type { Placement } from '@floating-ui/react'
import { useLayoutEffect, useMemo } from 'react'
import type { CSSProperties } from 'react'

/** Return shape of {@link useRectFloating}. */
export interface RectFloating {
  /** Attach to the floating element. */
  setFloating: (node: HTMLElement | null) => void
  /** Position styles for the floating element. */
  floatingStyles: CSSProperties
}

/**
 * Position a floating overlay against a captured rectangle.
 *
 * `rect === null` keeps the overlay closed (floating-ui simply has no
 * reference); the caller decides whether to render it.
 */
export function useRectFloating(
  rect: DOMRect | null,
  placement: Placement = 'bottom-start',
  gap = 8,
): RectFloating {
  const reference = useMemo(() => {
    if (rect === null) return null
    return {
      getBoundingClientRect: (): DOMRect => rect,
    }
  }, [rect])
  const { refs, floatingStyles } = useFloating({
    open: rect !== null,
    placement,
    strategy: 'fixed',
    middleware: [offset(gap), flip({ padding: 8 }), shift({ padding: 8 })],
  })
  useLayoutEffect(() => {
    refs.setPositionReference(reference)
  }, [reference, refs])
  return { setFloating: refs.setFloating, floatingStyles }
}
