/**
 * Reader seam — the small stable module other client workstreams import.
 *
 * The reading scene owns its store; these are the only cross-workstream entry
 * points (brokered by the Lead):
 *
 *  - `client-ai` renders `AiMarginEntries` inside the margin and after an
 *    answer calls {@link refreshAnnotations}; its composer is focused through
 *    {@link registerAskAI} (the reader toolbar's 问 AI action calls
 *    {@link askAI}, so the reader never imports the AI store at runtime).
 *  - `client-graph` jumps from a graph node to its source through
 *    {@link jumpToBlock} (cross-document capable: it opens the target paper,
 *    switches to the read scene and scrolls+flashes the block).
 *
 * Import functions from here rather than reaching into store internals.
 */

import type { ReactElement } from 'react'
import { useReaderStore } from './store.ts'
import { useUiStore } from '../state/ui.ts'
import type { ReaderSelectionContext } from './store.ts'

/* -------------------------------------------------------------------------- */
/* AI margin contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Props of `AiMarginEntries` — the AI conversation stream rendered inside the
 * reader's margin column (`src/client/ai/AiMarginEntries.tsx`, owned by
 * `client-ai`).
 *
 * Each AI entry root exposes `data-anchor-block="<blockKey>"` (and
 * `data-created-at`) so the reader's tether layer can draw the provenance
 * hairline to the sentence exactly like it does for notes.
 */
export interface AiMarginEntriesProps {
  documentId: string
  /** Document order of a block key, used to sort entries by anchor (`null` → end). */
  orderOf: (blockKey: string) => number | null
  /** Scroll+flash one block in the paper (citation click). */
  onJump: (blockKey: string) => void
  /** Called after an answer adopted new annotations: reload them into the margin. */
  onAnnotationsChanged: () => void | Promise<void>
}

/** Selection context handed from the reader to the AI composer. */
export type AskAIContext = ReaderSelectionContext

/** Handler registered by the AI store to focus its composer on a selection. */
export type AskAIHandler = (context: AskAIContext | null) => void

let askHandler: AskAIHandler | null = null

/**
 * Register the AI composer focus handler (call once from the AI store module).
 *
 * The reader keeps the returned disposer: on unmount the handler is detached so
 * a stale store instance can never receive focus requests.
 */
export function registerAskAI(handler: AskAIHandler): () => void {
  askHandler = handler
  return () => {
    if (askHandler === handler) askHandler = null
  }
}

/**
 * Ask the AI composer about the current selection.
 *
 * Stores the selection context (the AI margin reads it through
 * `useReaderStore`), opens the margin and forwards the focus request to the
 * registered AI handler. Safe to call when no AI store is mounted yet.
 */
export function askAI(context: AskAIContext): void {
  useReaderStore.getState().setSelectionContext(context)
  useUiStore.getState().setMarginOpen(true)
  if (askHandler !== null) askHandler(context)
}

/** Clear the selection context after the composer consumed it. */
export function clearAskAI(): void {
  useReaderStore.getState().setSelectionContext(null)
}

/* -------------------------------------------------------------------------- */
/* Annotation refresh                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reload the open paper's annotations from the Host and re-render them.
 *
 * The AI margin calls this after an answer adopted AI annotations. Pending
 * local edits are saved first, so a refresh can never clobber a user note.
 */
export function refreshAnnotations(): Promise<void> {
  return useReaderStore.getState().refreshAnnotations()
}

/* -------------------------------------------------------------------------- */
/* Jump to block (citations, graph nodes, outline)                            */
/* -------------------------------------------------------------------------- */

/** Options of {@link jumpToBlock}. */
export interface ReaderBlockJumpOptions {
  /** Target paper when the block belongs to another document (graph scope). */
  documentId?: string
  /** Flash the block after scrolling (default `true`). */
  flash?: boolean
}

/**
 * Open the read scene at one block and flash it.
 *
 * This is the graph→source contract: it switches the scene, opens the target
 * document when needed (the reader store reloads and restores when the model is
 * ready) and leaves a jump request the scene applies once the sheet mounts.
 * Fire-and-forget by design; a missing/unmounted paper is a no-op.
 */
export function jumpToBlock(blockKey: string, options: ReaderBlockJumpOptions = {}): void {
  if (blockKey === '') return
  const ui = useUiStore.getState()
  const targetDocumentId = options.documentId ?? ui.currentDocumentId
  ui.setScene('read')
  if (targetDocumentId !== null && ui.currentDocumentId !== targetDocumentId) {
    ui.openDocument(targetDocumentId)
  }
  useReaderStore.getState().requestJump(blockKey, {
    flash: options.flash !== false,
    documentId: targetDocumentId ?? undefined,
  })
}

/** Document order of a block key (`null` when it does not resolve). */
export { orderOf } from './store.ts'

/* -------------------------------------------------------------------------- */
/* Renderer type (kept here so the reader scene can type its seat)            */
/* -------------------------------------------------------------------------- */

/** The component type of the AI margin stream (avoids a runtime import). */
export type AiMarginEntriesComponent = (props: AiMarginEntriesProps) => ReactElement
