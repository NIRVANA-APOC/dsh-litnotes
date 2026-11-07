/**
 * AI margin store — the conversation state machine for one open document.
 *
 * Owns the per-document chat history, the streaming run (all NDJSON frames of
 * the `chat` method), stop/regenerate/follow-up/clear, citation adoption, the
 * composer context and the export of the conversation. The store is DOM-free
 * (the component layers scroll, hover cards and copy/download primitives on top)
 * and calls the reader seam only through host hooks registered by the margin
 * component; it cannot render or scroll anything itself.
 *
 * Frame contract (`src/shared/model.ts` `ChatFrame`): start → delta* → (phase)?
 * → answer → graph? → usage? → done | error. A frame after `answer` never
 * appends to the streamed text; a `done`/`error` frame finalizes the run once.
 */

import { create } from 'zustand'
import { ApiError, getHostClient } from '../api/client.ts'
import type { ChatFrame, ChatRequest, KnowledgeDelta } from '../../shared/model.ts'
import { useUiStore } from '../state/ui.ts'
import {
  aiT,
  errorText,
  exportMarkdown,
  localEntry,
  normalizeCitationList,
  normalizeMessages,
  parseAnswer,
  patchEntry,
  previousQuestion,
} from './chat.ts'
import type { AiTranslate, ChatEntry, ExportResult } from './chat.ts'
import { downloadText } from './download.ts'

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Composer context handed over by the reader's selection toolbar (问 AI). */
export interface AiComposerContext {
  blockKey: string
  quote: string
  text: string
}

/** Reader seam functions the store calls (registered by the margin component). */
export interface AiHostHooks {
  /** Scroll+flash a cited block. */
  onJump?: (blockKey: string) => void
  /** Reload annotations after an answer adopted new ones. */
  onAnnotationsChanged?: () => void | Promise<void>
}

/** One failed run, rendered under the corresponding question. */
export interface AiStreamError {
  message: string
  question: string
  /** Entry the failure belongs to (question label stays visible). */
  entryId: string
  retryable: boolean
}

/** History load state. */
export type AiHistoryState = 'idle' | 'loading' | 'ready' | 'error'

/** A host/stream failure normalized for display. */
export interface AiFailure {
  code: string
  message: string
  retryable: boolean
}

/** Options of one ask/regenerate run. */
export interface AiAskOptions {
  /** Append the user question as its own entry (default true). */
  appendUser?: boolean
  /** Drop this entry and everything after it before appending (regenerate). */
  dropFromId?: string
  /** Host message id to regenerate (chat request `regenerateOf`). */
  regenerateOf?: string
  /** Explicit retrieval focus; defaults to the composer context. */
  focus?: { blockKey?: string; quote?: string }
}

/** Conversation export metadata supplied by the component (localized). */
export interface AiExportOptions {
  title?: string
  modelLabel?: string
  t?: AiTranslate | null
}

/** AI margin store shape. */
export interface AiState {
  documentId: string | null
  messages: ChatEntry[]
  historyState: AiHistoryState
  historyError: AiFailure | null
  /** Local id of the assistant entry currently streaming (`null` when idle). */
  streamingId: string | null
  busy: boolean
  /** Current composer text (controlled). */
  input: string
  /** Selection context shown as the 选区 chip and sent as `focus`. */
  composerContext: AiComposerContext | null
  /** Visible-paragraph block key shown as the 本段 chip when no selection exists. */
  autoFocusBlockKey: string | null
  /** Incremented when the reader asks for composer focus. */
  composerFocusTick: number
  /** Last failed run (entry-level error + retry). */
  streamError: AiStreamError | null
  /** Last knowledge delta produced by an answer (graph store seam). */
  lastKnowledgeDelta: KnowledgeDelta | null
  lastKnowledgeDocumentId: string | null
  /** Reader hooks registered by the mounted margin component. */
  hostHooks: AiHostHooks
  setHostHooks: (hooks: AiHostHooks) => void
  load: (documentId: string, options?: { force?: boolean }) => Promise<void>
  retryHistory: () => Promise<void>
  ask: (question: string, options?: AiAskOptions) => Promise<void>
  askFollowup: (question: string) => Promise<void>
  stop: () => void
  regenerate: (entryId: string) => Promise<void>
  retryStream: () => Promise<void>
  clearConversation: () => Promise<void>
  setInput: (input: string) => void
  setComposerContext: (context: AiComposerContext | null) => void
  clearComposerContext: () => void
  setAutoFocus: (blockKey: string | null) => void
  focusComposer: (context: AiComposerContext | null) => void
  dismissError: () => void
  /** Build the export payload (null for an empty/unusable conversation). */
  buildExport: (options?: AiExportOptions) => ExportResult | null
  /** Export and download the conversation, with toasts. */
  downloadConversation: (options?: AiExportOptions) => ExportResult | null
  /** Copy helper used by the message action (resolves `true` on success). */
  copyAnswer: (entryId: string) => Promise<boolean>
}

/* -------------------------------------------------------------------------- */
/* Module-level run bookkeeping (not serialized into render state)            */
/* -------------------------------------------------------------------------- */

/** The active streaming run; only one conversation can answer at a time. */
interface ActiveRun {
  id: string
  documentId: string
  question: string
  draft: string
  answered: boolean
  announced: boolean
  cancelled: boolean
  finalized: boolean
  stopped: boolean
  controller: AbortController | null
  focus: { blockKey?: string; quote?: string } | undefined
  regenerateOf: string
}

let activeRun: ActiveRun | null = null
let sequence = 0
/** Translate callback captured from the mounted component (toasts/export). */
let activeTranslate: AiTranslate | null = null

/** Listeners for knowledge deltas (graph store can subscribe without an import). */
type KnowledgeListener = (delta: KnowledgeDelta, documentId: string) => void
const knowledgeListeners = new Set<KnowledgeListener>()

/**
 * Subscribe to the knowledge deltas produced by answers.
 *
 * The graph workstream consumes this to refresh its per-document graph after a
 * Q&A turn without importing the AI store (Lead-brokered seam; the graph store
 * is spawned later).
 *
 * @param listener - called with each delta and its document id.
 * @returns disposer.
 */
export function onAiKnowledge(listener: KnowledgeListener): () => void {
  knowledgeListeners.add(listener)
  return () => knowledgeListeners.delete(listener)
}

/** Publish one delta to every knowledge listener (a listener failure is isolated). */
function publishKnowledge(delta: KnowledgeDelta, documentId: string): void {
  for (const listener of knowledgeListeners) {
    try {
      listener(delta, documentId)
    } catch {
      /* a graph listener must not break the answer stream */
    }
  }
}

/**
 * Capture the translate function for store-owned copy (toasts, export framing).
 * Called by the mounted margin component; harmless when never called.
 *
 * @param t - bound translate function of the `dsh-litnotes` namespace.
 */
export function setAiTranslate(t: AiTranslate | null): void {
  activeTranslate = t
}

/** Normalize one thrown value into a display failure. */
function failureOf(error: unknown): AiFailure {
  if (error instanceof ApiError) {
    const code = typeof error.code === 'string' ? error.code : 'network'
    return { code, message: error.message, retryable: code !== 'token-missing' && code !== 'llm-unavailable' }
  }
  if (error !== null && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown }
    const code = typeof record.code === 'string' ? record.code : 'ai-failed'
    const message = typeof record.message === 'string' ? record.message : ''
    if (message !== '') return { code, message, retryable: code !== 'aborted' }
  }
  return { code: 'ai-failed', message: String(error), retryable: true }
}

/** Toast helper through the shared UI store (copy localized by the active t). */
function toast(key: string, tone: 'info' | 'success' | 'error' = 'info', params?: Record<string, unknown>): void {
  useUiStore.getState().toast(aiT(activeTranslate, key, params), tone)
}

/** Abort the active run without touching the rendered entries (document switch). */
function abandonRun(): void {
  const run = activeRun
  activeRun = null
  if (run === null) return
  run.cancelled = true
  run.finalized = true
  try {
    run.controller?.abort()
  } catch {
    /* already closed */
  }
}

/** Build the composer/selection focus payload for the chat request. */
function wireFocus(
  context: AiComposerContext | null,
  explicit: AiAskOptions['focus'],
): { blockKey?: string; selectionQuote?: string } | undefined {
  if (explicit !== undefined) {
    const blockKey = explicit.blockKey ?? ''
    const selectionQuote = explicit.quote ?? ''
    if (blockKey === '' && selectionQuote === '') return undefined
    return { ...(blockKey !== '' ? { blockKey } : {}), ...(selectionQuote !== '' ? { selectionQuote } : {}) }
  }
  if (context === null) return undefined
  const blockKey = context.blockKey.trim()
  const selectionQuote = context.quote.trim()
  if (blockKey === '' && selectionQuote === '') return undefined
  return { ...(blockKey !== '' ? { blockKey } : {}), ...(selectionQuote !== '' ? { selectionQuote } : {}) }
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

/** The AI margin store. */
export const useAiStore = create<AiState>((set, get) => {
  /** Patch one entry in place without touching the others. */
  function updateEntry(id: string, update: (entry: ChatEntry) => ChatEntry): void {
    set((state) => ({ messages: patchEntry(state.messages, id, update) }))
  }

  /** Finalize the active run (done/error/abort), once. */
  function finishRun(run: ActiveRun, failure: AiFailure | null): void {
    if (run.finalized) return
    run.finalized = true
    if (activeRun === run) activeRun = null
    if (get().documentId !== run.documentId) {
      set({ streamingId: null, busy: false })
      return
    }
    set({ streamingId: null, busy: false })
    if (run.cancelled) return
    if (failure !== null) {
      updateEntry(run.id, (entry) => ({ ...entry, streaming: false, failed: true, phase: '' }))
      set({
        streamError: {
          message: errorText(activeTranslate, failure),
          question: run.question,
          entryId: run.id,
          retryable: failure.retryable,
        },
      })
      return
    }
    if (!run.answered) {
      if (run.stopped) {
        updateEntry(run.id, (entry) => ({ ...entry, streaming: false, stopped: true }))
        return
      }
      if (run.draft.trim() !== '') {
        const parsed = parseAnswer(run.draft)
        const fenced = parsed.data
        updateEntry(run.id, (entry) => ({
          ...entry,
          answer: parsed.answer !== '' ? parsed.answer : entry.answer,
          citations: normalizeCitationList(fenced?.['citations'], false),
          followups: Array.isArray(fenced?.['followups'])
            ? (fenced?.['followups'] as unknown[])
                .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
                .map((item) => item.trim())
            : [],
          streaming: false,
        }))
        return
      }
      updateEntry(run.id, (entry) => ({ ...entry, streaming: false, failed: true }))
      set({
        streamError: {
          message: aiT(activeTranslate, 'ai.answerEmpty'),
          question: run.question,
          entryId: run.id,
          retryable: true,
        },
      })
      return
    }
    updateEntry(run.id, (entry) => ({ ...entry, streaming: false, failed: false }))
  }

  /** Apply one streaming frame to its run. */
  function applyFrame(run: ActiveRun, frame: ChatFrame): void {
    if (run.finalized || activeRun !== run) return
    switch (frame.type) {
      case 'start': {
        const serverId = frame.messageId
        const model = frame.model
        updateEntry(run.id, (entry) => ({
          ...entry,
          serverId: serverId !== '' ? serverId : entry.serverId,
          model,
        }))
        return
      }
      case 'delta': {
        if (run.answered) return
        if (frame.text === '') return
        run.draft += frame.text
        const parsed = parseAnswer(run.draft)
        updateEntry(run.id, (entry) => ({ ...entry, answer: parsed.answer, streaming: true }))
        return
      }
      case 'phase': {
        if (frame.phase === 'entailment') {
          updateEntry(run.id, (entry) => ({ ...entry, phase: 'entailment' }))
        }
        return
      }
      case 'answer': {
        const parsed = parseAnswer(frame.markdown !== '' ? frame.markdown : run.draft)
        const fenced = parsed.data
        const answer = parsed.answer !== '' ? parsed.answer : frame.markdown
        const citations = normalizeCitationList(
          Array.isArray(frame.citations) ? frame.citations : fenced?.['citations'],
          false,
        )
        const unverified = normalizeCitationList(frame.unverified, true)
        const followups = Array.isArray(frame.followups) ? frame.followups : []
        const annotationIds = Array.isArray(frame.annotationIds) ? frame.annotationIds : []
        run.answered = true
        updateEntry(run.id, (entry) => ({
          ...entry,
          answer,
          citations,
          unverified,
          followups: followups.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()),
          annotationIds,
          entailment: frame.entailment,
          phase: '',
          streaming: true,
          serverId: frame.messageId !== '' ? frame.messageId : entry.serverId,
        }))
        if (annotationIds.length > 0 && !run.announced) {
          run.announced = true
          const hooks = get().hostHooks
          void hooks.onAnnotationsChanged?.()
          toast('ai.annotationsNotice', 'success', { count: annotationIds.length })
        }
        return
      }
      case 'graph': {
        set({ lastKnowledgeDelta: frame.delta, lastKnowledgeDocumentId: run.documentId })
        publishKnowledge(frame.delta, run.documentId)
        return
      }
      case 'usage': {
        const usage = {
          inputTokens: frame.usage.inputTokens ?? 0,
          outputTokens: frame.usage.outputTokens ?? 0,
        }
        updateEntry(run.id, (entry) => ({ ...entry, usage }))
        return
      }
      case 'done': {
        finishRun(run, null)
        return
      }
      case 'error': {
        const failure: AiFailure = {
          code: frame.code,
          message: frame.message,
          retryable: frame.code !== 'aborted',
        }
        try {
          run.controller?.abort()
        } catch {
          /* already closed */
        }
        finishRun(run, failure)
        return
      }
      default:
        return
    }
  }

  /** Start one streaming run; the caller already validated the question. */
  async function runQuestion(question: string, options: AiAskOptions): Promise<void> {
    const documentId = get().documentId
    if (documentId === null || question === '' || activeRun !== null) return
    sequence += 1
    const assistantId = `local-assistant-${sequence}`
    const userEntry =
      options.appendUser === false ? null : localEntry(`local-user-${sequence}`, 'user', question)
    const assistant = localEntry(assistantId, 'assistant', question)
    const autoFocus = get().autoFocusBlockKey
    const focus =
      wireFocus(get().composerContext, options.focus) ??
      (autoFocus !== null && autoFocus !== '' ? { blockKey: autoFocus } : undefined)
    const run: ActiveRun = {
      id: assistantId,
      documentId,
      question,
      draft: '',
      answered: false,
      announced: false,
      cancelled: false,
      finalized: false,
      stopped: false,
      controller: null,
      focus,
      regenerateOf: options.regenerateOf ?? '',
    }
    activeRun = run
    set((state) => {
      let messages = state.messages
      if (options.dropFromId !== undefined) {
        const index = messages.findIndex((entry) => entry.id === options.dropFromId)
        if (index !== -1) messages = messages.slice(0, index)
      }
      const next = [...messages]
      if (userEntry !== null) next.push(userEntry)
      next.push(assistant)
      return {
        messages: next,
        streamingId: assistantId,
        busy: true,
        streamError: null,
        input: '',
      }
    })
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    run.controller = controller
    const request: ChatRequest = { documentId, question, mode: 'doc' }
    if (focus !== undefined) request.focus = focus
    if (run.regenerateOf !== '') request.regenerateOf = run.regenerateOf
    try {
      await getHostClient().stream('chat', request, {
        onFrame: (frame) => {
          try {
            applyFrame(run, frame)
          } catch {
            /* one malformed frame must not tear down the conversation */
          }
        },
        ...(controller === null ? {} : { signal: controller.signal }),
      })
      finishRun(run, null)
    } catch (error) {
      if (run.finalized) return
      if (error instanceof DOMException && error.name === 'AbortError') {
        run.stopped = true
        finishRun(run, null)
        return
      }
      finishRun(run, failureOf(error))
    }
  }

  return {
    documentId: null,
    messages: [],
    historyState: 'idle',
    historyError: null,
    streamingId: null,
    busy: false,
    input: '',
    composerContext: null,
    autoFocusBlockKey: null,
    composerFocusTick: 0,
    streamError: null,
    lastKnowledgeDelta: null,
    lastKnowledgeDocumentId: null,
    hostHooks: {},

    setHostHooks: (hooks) => set({ hostHooks: hooks }),

    load: async (documentId, options = {}) => {
      const state = get()
      if (!options.force && state.documentId === documentId && state.historyState !== 'error') return
      abandonRun()
      set({
        documentId,
        messages: [],
        historyState: 'loading',
        historyError: null,
        streamError: null,
        streamingId: null,
        busy: false,
        input: '',
        lastKnowledgeDelta: null,
      })
      try {
        const value = await getHostClient().call('chat.history', { documentId })
        if (get().documentId !== documentId) return
        set({ messages: normalizeMessages(value), historyState: 'ready' })
      } catch (error) {
        if (get().documentId !== documentId) return
        set({ historyError: failureOf(error), historyState: 'error' })
      }
    },

    retryHistory: async () => {
      const documentId = get().documentId
      if (documentId === null) return
      await get().load(documentId, { force: true })
    },

    ask: async (question, options = {}) => {
      const trimmed = question.trim()
      if (trimmed === '') return
      if (get().historyState === 'loading') return
      await runQuestion(trimmed, options)
    },

    askFollowup: async (question) => {
      await get().ask(question, { appendUser: true })
    },

    stop: () => {
      const run = activeRun
      if (run === null) return
      activeRun = null
      run.cancelled = true
      run.finalized = true
      run.stopped = true
      try {
        run.controller?.abort()
      } catch {
        /* already closed */
      }
      set({ streamingId: null, busy: false })
      if (get().documentId !== run.documentId) return
      updateEntry(run.id, (entry) => ({ ...entry, streaming: false, stopped: true, phase: '' }))
    },

    regenerate: async (entryId) => {
      const state = get()
      const entry = state.messages.find((candidate) => candidate.id === entryId)
      if (entry === undefined || entry.role !== 'assistant') return
      const question = entry.question.trim() !== '' ? entry.question : previousQuestion(state.messages, entryId)
      if (question.trim() === '' || activeRun !== null) return
      const regenerateOf = entry.serverId !== '' ? entry.serverId : entry.local ? '' : entry.id
      await runQuestion(question, {
        appendUser: false,
        dropFromId: entry.id,
        ...(regenerateOf !== '' ? { regenerateOf } : {}),
      })
    },

    retryStream: async () => {
      const error = get().streamError
      if (error === null || activeRun !== null) return
      set({ streamError: null })
      await runQuestion(error.question, { appendUser: false, dropFromId: error.entryId })
    },

    clearConversation: async () => {
      const documentId = get().documentId
      if (documentId === null) return
      abandonRun()
      try {
        await getHostClient().call('chat.clear', { documentId })
        if (get().documentId !== documentId) return
        set({ messages: [], streamError: null, streamingId: null, busy: false })
        toast('ai.cleared', 'success')
      } catch {
        toast('ai.clearFailed', 'error')
      }
    },

    setInput: (input) => set({ input }),

    setComposerContext: (context) => set({ composerContext: context }),

    clearComposerContext: () => set({ composerContext: null }),

    setAutoFocus: (blockKey) => set({ autoFocusBlockKey: blockKey === null || blockKey === '' ? null : blockKey }),

    focusComposer: (context) => {
      set((state) => ({
        composerContext: context,
        composerFocusTick: state.composerFocusTick + 1,
      }))
    },

    dismissError: () => set({ streamError: null }),

    buildExport: (options = {}) =>
      exportMarkdown(get().messages, {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.modelLabel === undefined ? {} : { modelLabel: options.modelLabel }),
        exportedAt: new Date().toISOString(),
        t: options.t ?? activeTranslate,
      }),

    downloadConversation: (options = {}) => {
      const result = get().buildExport(options)
      if (result === null) {
        toast('ai.exportFailed', 'error')
        return null
      }
      if (!downloadText(result.filename, result.markdown)) {
        toast('ai.exportFailed', 'error')
        return null
      }
      toast('ai.exported', 'success')
      return result
    },

    copyAnswer: async (entryId) => {
      const entry = get().messages.find((candidate) => candidate.id === entryId)
      const answer = entry?.answer ?? ''
      if (answer === '') return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(answer)
          return true
        }
      } catch {
        return false
      }
      return false
    },
  }
})
