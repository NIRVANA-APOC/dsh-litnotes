/**
 * AI 精读 store — the close-reading run state machine for one open document.
 *
 * Owns the persisted record fetch (`deepread.get`), the streaming run (every
 * NDJSON frame of the `deepread` method), stop/retry/rerun and the annotation
 * adoption seam. The store is DOM-free and props-free: the panel calls
 * {@link setDeepReadTranslate} for localized copy (the success toast) and
 * registers host hooks through {@link useDeepReadStore}`.getState().setHostHooks`
 * (the reader owns the annotation reload), exactly like the chat store.
 *
 * Frame contract (`src/shared/model.ts` `DeepReadFrame`): start → progress* →
 * report → annotations? → usage? → done | error. A cached (non-forced) run
 * replays the stored record without model calls. A run never throws: every
 * failure settles as `runState: 'error'` + a reader-facing message, and an
 * aborted run leaves the previous record intact. Switching documents abandons
 * an in-flight run (the Host writes nothing for an aborted run).
 */

import { create } from 'zustand'
import type { DeepReadFrame, DeepReadPhase, DeepReadRecord, DeepReadRequest } from '../../shared/model.ts'
import { getHostClient } from '../api/client.ts'
import { activeLocale } from '../shell/locale-context.ts'
import { useUiStore } from '../state/ui.ts'
import { formatCount } from './chat.ts'
import type { AiTranslate } from './chat.ts'
import {
  deepReadErrorMessage,
  deepReadFailure,
  deepReadT,
  normalizeDeepReadRecord,
} from './deepread.ts'

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Streamed workflow progress of one run. */
export interface DeepReadProgress {
  phase: DeepReadPhase
  done: number
  total: number
  section?: string
}

/** Reader seam the store calls when a run wrote annotations. */
export interface DeepReadHostHooks {
  /** Reload the page annotations after a successful run. */
  onAnnotationsChanged?: () => void | Promise<void>
}

/** Persisted-record load state. */
export type DeepReadRecordState = 'idle' | 'loading' | 'ready' | 'error'

/** Run state machine. */
export type DeepReadRunState = 'idle' | 'running' | 'done' | 'error'

/** AI 精读 store shape (design §6 contract). */
export interface DeepReadState {
  /** Document the current record/run belongs to. */
  documentId: string | null
  /** Persisted run record of `documentId` (null when never deep-read). */
  record: DeepReadRecord | null
  recordState: DeepReadRecordState
  runState: DeepReadRunState
  progress: DeepReadProgress | null
  /** Localized failure message of the last run (null when healthy). */
  error: string | null
  busy: boolean
  /** Annotations the Host reported creating in this run. */
  annotationsCreated: number
  load: (documentId: string) => Promise<void>
  start: (documentId: string, options?: { force?: boolean }) => Promise<void>
  stop: () => void
  retry: () => Promise<void>
  dismissError: () => void
  setHostHooks: (hooks: DeepReadHostHooks) => void
}

/* -------------------------------------------------------------------------- */
/* Module-level run bookkeeping (not render state)                            */
/* -------------------------------------------------------------------------- */

/** The active run; only one deep read can execute at a time. */
interface ActiveDeepReadRun {
  documentId: string
  cancelled: boolean
  finalized: boolean
  controller: AbortController | null
  /** Record received through the `report` frame. */
  record: DeepReadRecord | null
  /** Count reported by the `annotations` frame. */
  annotationsCreated: number
}

let activeRun: ActiveDeepReadRun | null = null
/** Monotonic revision of the adopted record (a stale fetch is discarded). */
let recordRevision = 0
/** Translate callback captured from the mounted panel (toast copy). */
let deepReadTranslate: AiTranslate | null = null
/** Reader hooks registered by the reader scene / panel. */
let hostHooks: DeepReadHostHooks = {}

/**
 * Capture the translate function for store-owned copy (the success toast).
 *
 * @param t - bound translate function of the `dsh-litnotes` namespace.
 */
export function setDeepReadTranslate(t: AiTranslate | null): void {
  deepReadTranslate = t
}

/** Whether one thrown value is an abort (cross-realm safe). */
function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}

/** Abort the active run without touching the rendered state (document switch). */
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

/** Notify the reader that a finished run wrote annotations (best effort). */
function notifyAnnotationsChanged(): void {
  const hook = hostHooks.onAnnotationsChanged
  if (hook === undefined) return
  try {
    void Promise.resolve(hook()).catch(() => {
      /* a failed reload must not change the run outcome */
    })
  } catch {
    /* a reader hook must not break the store */
  }
}

/** Toast after a successful run, with the localized runner copy. */
function toastDone(count: number): void {
  const text = deepReadT(deepReadTranslate, 'deepread.toast.done', { count: formatCount(count) })
  useUiStore.getState().toast(text, 'success')
}

/** Sanitize one streamed `progress` frame into render state. */
function progressOf(frame: Extract<DeepReadFrame, { type: 'progress' }>): DeepReadProgress {
  const done = Number(frame.done)
  const total = Number(frame.total)
  const section = typeof frame.section === 'string' ? frame.section.trim() : ''
  const progress: DeepReadProgress = {
    phase: frame.phase,
    done: Number.isFinite(done) && done > 0 ? Math.trunc(done) : 0,
    total: Number.isFinite(total) && total > 0 ? Math.trunc(total) : 1,
  }
  if (section !== '') progress.section = section.slice(0, 200)
  return progress
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

/** The AI 精读 store. */
export const useDeepReadStore = create<DeepReadState>((set, get) => {
  /** Finalize one run as cancelled/stopped (no error, previous record stays). */
  function finishStop(run: ActiveDeepReadRun): void {
    if (run.finalized) return
    run.cancelled = true
    run.finalized = true
    if (activeRun === run) activeRun = null
    try {
      run.controller?.abort()
    } catch {
      /* already closed */
    }
    if (get().documentId !== run.documentId) {
      set({ busy: false, progress: null })
      return
    }
    set({
      busy: false,
      progress: null,
      error: null,
      runState: get().record !== null ? 'done' : 'idle',
    })
  }

  /** Finalize one run once (success or failure). */
  function finishRun(run: ActiveDeepReadRun, failure: { code: string; message: string } | null): void {
    if (run.finalized) return
    run.finalized = true
    if (activeRun === run) activeRun = null
    const state = get()
    if (state.documentId !== run.documentId) {
      set({ busy: false, progress: null })
      return
    }
    if (run.cancelled) {
      set({ busy: false, progress: null })
      return
    }
    if (failure !== null) {
      set({
        busy: false,
        progress: null,
        runState: 'error',
        error: deepReadErrorMessage(deepReadTranslate, failure.code, failure.message),
      })
      return
    }
    const record = run.record ?? state.record
    const count = run.annotationsCreated > 0 ? run.annotationsCreated : (record?.highlights.length ?? 0)
    recordRevision += 1
    set({
      busy: false,
      progress: null,
      runState: 'done',
      error: null,
      annotationsCreated: count,
      ...(run.record !== null ? { record: run.record, recordState: 'ready' as const } : {}),
    })
    notifyAnnotationsChanged()
    if (record !== null) toastDone(count)
  }

  /** Apply one streaming frame to its run. */
  function applyFrame(run: ActiveDeepReadRun, frame: DeepReadFrame): void {
    if (run.finalized || activeRun !== run) return
    if (get().documentId !== run.documentId) return
    switch (frame.type) {
      case 'start': {
        // The model route is carried by the report record; nothing to render.
        return
      }
      case 'progress': {
        set({ progress: progressOf(frame) })
        return
      }
      case 'report': {
        const record = normalizeDeepReadRecord(frame.record)
        if (record === null) return
        run.record = record
        recordRevision += 1
        set((state) => ({
          record,
          recordState: 'ready',
          annotationsCreated: Math.max(state.annotationsCreated, record.highlights.length),
        }))
        return
      }
      case 'annotations': {
        const created = Number(frame.created)
        run.annotationsCreated = Number.isFinite(created) && created > 0 ? Math.trunc(created) : 0
        set({ annotationsCreated: run.annotationsCreated })
        return
      }
      case 'usage': {
        // Tokens already live in the report stats; nothing extra to render.
        return
      }
      case 'done': {
        finishRun(run, null)
        return
      }
      case 'error': {
        try {
          run.controller?.abort()
        } catch {
          /* already closed */
        }
        finishRun(run, { code: frame.code, message: frame.message })
        return
      }
      default:
        return
    }
  }

  return {
    documentId: null,
    record: null,
    recordState: 'idle',
    runState: 'idle',
    progress: null,
    error: null,
    busy: false,
    annotationsCreated: 0,

    setHostHooks: (hooks) => {
      hostHooks = hooks
    },

    load: async (documentId) => {
      const target = typeof documentId === 'string' ? documentId.trim() : ''
      if (target === '') return
      const state = get()
      if (state.documentId === target) {
        // A record already adopted, a fetch already running, or a live run:
        // never clobber it with a stale read.
        if (state.recordState === 'ready' || state.recordState === 'loading') return
        if (activeRun !== null && activeRun.documentId === target) return
      } else if (activeRun !== null) {
        abandonRun()
      }
      const switching = state.documentId !== target
      if (switching) {
        set({
          documentId: target,
          record: null,
          recordState: 'loading',
          runState: 'idle',
          progress: null,
          error: null,
          busy: false,
          annotationsCreated: 0,
        })
      } else {
        set({ recordState: 'loading', error: null })
      }
      const revision = recordRevision
      try {
        const value = await getHostClient().call('deepread.get', { documentId: target })
        if (get().documentId !== target) return
        // A run finished/reported while this fetch was in flight: its record is
        // newer than the persisted snapshot the fetch answers with.
        if (recordRevision !== revision) return
        if (activeRun !== null && activeRun.documentId === target) return
        const record = normalizeDeepReadRecord(value?.record ?? null)
        recordRevision += 1
        set({
          record,
          recordState: 'ready',
          runState: record !== null ? 'done' : 'idle',
          progress: null,
        })
      } catch {
        // A paper without a readable record is normal (never deep-read); the
        // panel keeps the idle CTA / offers a reload instead of failing hard.
        if (get().documentId !== target) return
        if (activeRun !== null && activeRun.documentId === target) return
        set({ recordState: 'error', record: null })
      }
    },

    start: async (documentId, options = {}) => {
      const target = typeof documentId === 'string' ? documentId.trim() : ''
      if (target === '') return
      if (activeRun !== null) return
      const state = get()
      const switching = state.documentId !== target
      const run: ActiveDeepReadRun = {
        documentId: target,
        cancelled: false,
        finalized: false,
        controller: null,
        record: null,
        annotationsCreated: 0,
      }
      activeRun = run
      set({
        documentId: target,
        record: switching ? null : state.record,
        recordState: switching ? 'idle' : state.recordState === 'error' ? 'idle' : state.recordState,
        runState: 'running',
        progress: { phase: 'mapping', done: 0, total: 1 },
        error: null,
        busy: true,
        annotationsCreated: 0,
      })
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      run.controller = controller
      const request: DeepReadRequest = {
        documentId: target,
        language: activeLocale(),
      }
      if (options.force === true) request.force = true
      try {
        await getHostClient().stream('deepread', request, {
          onFrame: (frame) => {
            try {
              applyFrame(run, frame)
            } catch {
              /* one malformed frame must not tear down the panel */
            }
          },
          ...(controller === null ? {} : { signal: controller.signal }),
        })
        finishRun(run, null)
      } catch (error) {
        if (run.finalized) return
        if (isAbortError(error)) {
          finishStop(run)
          return
        }
        const failure = deepReadFailure(error)
        finishRun(run, { code: failure.code, message: failure.message })
      }
    },

    stop: () => {
      const run = activeRun
      if (run === null) return
      finishStop(run)
    },

    retry: async () => {
      const state = get()
      if (state.documentId === null || state.runState === 'running') return
      set({ error: null })
      await get().start(state.documentId, { force: true })
    },

    dismissError: () => {
      const state = get()
      if (state.error === null) return
      set({
        error: null,
        ...(state.runState === 'error'
          ? { runState: state.record !== null ? ('done' as const) : ('idle' as const) }
          : {}),
      })
    },
  }
})
