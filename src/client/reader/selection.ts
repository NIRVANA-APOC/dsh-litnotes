/**
 * Selection → annotation offsets.
 *
 * Port of the frozen reader selection reader: a native selection inside the
 * paper body is mapped back to the block's plain-text offset space using the
 * `data-off` / `data-len` markers emitted by the inline renderer. Annotations
 * are character offsets into `block.plainText`, so this mapping is what makes a
 * highlight survive re-render/restore.
 *
 * Pure DOM helpers; the scene owns the UI state around them.
 */

import { isAnnotatableBlock } from '../../shared/annotate/highlight.ts'
import type { Block } from '../../shared/markdown/model.ts'

/** Maximum quote length carried by a live selection/annotation. */
export const MAX_SELECTION_QUOTE = 2000

/** How the selection was produced (keyboard selections focus the toolbar). */
export type SelectionSource = 'mouse' | 'keyboard'

/** One selection read from the paper body. */
export interface ReaderSelection {
  blockKey: string
  /** Offsets into the block plain text. */
  start: number
  end: number
  quote: string
  /** Viewport rectangle of the selection (toolbar/card anchor). */
  rect: DOMRect
  source: SelectionSource
  /** Existing annotations the selection overlaps (offered as 取消高亮). */
  annotationIds: string[]
}

/** Clamp `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Closest `[data-block-key]` ancestor of a DOM node. */
function blockElementOf(node: Node | null): HTMLElement | null {
  if (node === null) return null
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  if (element === null || typeof element.closest !== 'function') return null
  return element.closest<HTMLElement>('[data-block-key]')
}

/** Closest `[data-off]` segment ancestor of a DOM node. */
function segmentElementOf(node: Node | null): HTMLElement | null {
  if (node === null) return null
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  if (element === null || typeof element.closest !== 'function') return null
  return element.closest<HTMLElement>('[data-off]')
}

/**
 * Character offset of a DOM point inside a block's plain-text space.
 *
 * Prefers the segment marker (`data-off` + `data-len`) emitted by the inline
 * renderer; falls back to walking the block element with a Range when the point
 * is outside any segment (e.g. the block's own padding).
 */
export function offsetOfPoint(blockElement: HTMLElement, node: Node, nodeOffset: number): number {
  const segment = segmentElementOf(node)
  if (segment !== null && blockElement.contains(segment)) {
    const base = Number(segment.getAttribute('data-off'))
    const length = Number(segment.getAttribute('data-len'))
    let within = 0
    try {
      const range = document.createRange()
      range.setStart(segment, 0)
      range.setEnd(node, nodeOffset)
      within = range.toString().length
    } catch {
      within = 0
    }
    if (!Number.isFinite(length)) return (Number.isFinite(base) ? base : 0) + Math.max(0, within)
    return (Number.isFinite(base) ? base : 0) + clamp(within, 0, Math.max(0, length))
  }
  try {
    const range = document.createRange()
    range.selectNodeContents(blockElement)
    range.setEnd(node, nodeOffset)
    return range.toString().length
  } catch {
    return 0
  }
}

/**
 * Read the current window selection inside the paper body.
 *
 * Returns `null` when the selection is collapsed, outside the body, or not
 * inside an annotatable block. A selection spanning several blocks is clamped
 * to the first block (frozen 1.0.0 contract: annotations never cross blocks).
 */
export function readSelection(
  body: HTMLElement,
  blocksByKey: Map<string, Block>,
  source: SelectionSource = 'mouse',
): ReaderSelection | null {
  if (typeof window === 'undefined') return null
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!body.contains(range.commonAncestorContainer)) return null
  const text = selection.toString()
  if (text.trim() === '') return null
  const startElement = blockElementOf(range.startContainer)
  if (startElement === null) return null
  const blockKey = startElement.getAttribute('data-block-key')
  if (blockKey === null || blockKey === '') return null
  const block = blocksByKey.get(blockKey)
  if (block === undefined || !isAnnotatableBlock(block)) return null
  const plainLength = block.plainText.length
  const start = clamp(offsetOfPoint(startElement, range.startContainer, range.startOffset), 0, plainLength)
  const endElement = blockElementOf(range.endContainer)
  const end =
    endElement === startElement && endElement !== null
      ? clamp(offsetOfPoint(endElement, range.endContainer, range.endOffset), 0, plainLength)
      : plainLength
  if (end <= start) return null
  const quote = text.length > MAX_SELECTION_QUOTE ? text.slice(0, MAX_SELECTION_QUOTE) : text
  return {
    blockKey,
    start,
    end: Math.min(end, start + MAX_SELECTION_QUOTE),
    quote,
    rect: range.getBoundingClientRect(),
    source,
    annotationIds: [],
  }
}

/** Index the model blocks by key for selection mapping. */
export function blocksByKey(modelBlocks: readonly Block[]): Map<string, Block> {
  const map = new Map<string, Block>()
  for (const block of modelBlocks) {
    if (typeof block.key === 'string' && block.key !== '') map.set(block.key, block)
  }
  return map
}

/** Clear the browser selection without stealing focus back to the paper. */
export function clearBrowserSelection(): void {
  if (typeof window === 'undefined') return
  try {
    window.getSelection()?.removeAllRanges()
  } catch {
    // best effort only
  }
}
