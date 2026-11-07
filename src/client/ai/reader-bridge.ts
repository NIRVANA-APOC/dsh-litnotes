/**
 * Reader ↔ AI margin bridge.
 *
 * The margin component renders inside the reader's column but must stay usable
 * with props only (tests mount it without the reader): this module is the single
 * place where the AI side touches the reader seam. It
 *
 *  - registers the composer focus handler (`registerAskAI`) once, so the
 *    reader's selection toolbar "问 AI" fills the composer;
 *  - mirrors the reader's live `selectionContext` into the AI store so the
 *    composer shows the 选区 chip whenever text is selected;
 *  - exposes the reader-owned annotation counts for the margin filter chips.
 *
 * Everything here is optional at runtime: if the reader seam is missing or
 * unmounted the bridge is inert and the component still renders from props.
 */

import { plainTextOfBlock } from '../../shared/markdown/model.ts'
import { useReaderStore } from '../reader/store.ts'
import { clearAskAI, registerAskAI } from '../reader/api.ts'
import { useMemo } from 'react'
import { useAiStore } from './store.ts'

let installed = false

/**
 * Install the reader seam once (idempotent; called by the margin component).
 *
 * Safe to call repeatedly across HMR remounts: the reader keeps the registered
 * handler and the store subscription is module-scoped.
 */
export function installReaderBridge(): void {
  if (installed) return
  installed = true
  registerAskAI((context) => {
    useAiStore.getState().focusComposer(context)
  })
  useReaderStore.subscribe((state, previous) => {
    if (state.selectionContext !== previous.selectionContext) {
      useAiStore.getState().setComposerContext(state.selectionContext)
    }
  })
  const initial = useReaderStore.getState().selectionContext
  if (initial !== null) useAiStore.getState().setComposerContext(initial)
}

/** Clear the selection context on both sides (composer chip clear button). */
export function clearReaderSelection(): void {
  try {
    clearAskAI()
  } catch {
    /* the reader seam is optional */
  }
  useAiStore.getState().clearComposerContext()
}

/**
 * The block currently under the reader's reading line (live IntersectionObserver
 * signal, reset when the paper closes). Used for the composer's 本段 chip.
 *
 * @returns the visible block anchor, or null when the reader is not ready.
 */
export function useVisibleBlockKey(): string | null {
  return useReaderStore((state) => state.visibleBlockKey)
}

/**
 * Plain text of one block of the open paper, for the composer's 本段 chip.
 *
 * The reader owns the paper model; the AI margin only needs the excerpt of the
 * paragraph currently in view (the reader records it as `lastBlockKey`).
 *
 * @param blockKey - block anchor from the reading position (null when unknown).
 * @returns the block's plain text, or '' when it cannot be resolved.
 */
export function useBlockExcerpt(blockKey: string | null): string {
  const model = useReaderStore((state) => state.model)
  return useMemo(() => {
    if (blockKey === null || blockKey === '') return ''
    const block = model.blocks.find((candidate) => candidate.key === blockKey)
    return block === undefined ? '' : plainTextOfBlock(block)
  }, [model, blockKey])
}

/** Annotation counts shown on the margin filter chips. */
export interface MarginAnnotationCounts {
  ai: number
  user: number
}

/**
 * Count AI-authored vs reader-authored annotations from the reader store.
 *
 * The reader owns annotations; the AI margin only needs the two counts for its
 * filter chips (the note slips themselves stay reader-owned).
 *
 * @returns counts of AI annotations and user annotations for the open paper.
 */
export function useMarginAnnotationCounts(): MarginAnnotationCounts {
  const annotations = useReaderStore((state) => state.annotations)
  return useMemo(() => {
    let ai = 0
    let user = 0
    for (const annotation of annotations) {
      if (annotation.origin === 'ai') ai += 1
      else user += 1
    }
    return { ai, user }
  }, [annotations])
}
