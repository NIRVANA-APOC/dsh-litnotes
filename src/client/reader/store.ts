/**
 * Reader store — everything the reading scene needs, independent of the DOM.
 *
 * Responsibilities (DESIGN-V2 §6, task-7 deliverable 1):
 *  - load `document.markdown` + `library.get` in parallel, build the shared
 *    paper model lazily (after the paper shell paints) and cache it per
 *    document + markdown hash;
 *  - normalize persisted annotations against the live model, keep the ones
 *    whose anchor no longer resolves as stale entries (never erase a note),
 *    and save through `annotations.save` with the `baseIds` merge baseline;
 *  - expose `refreshAnnotations()` so the AI margin can pull in annotations
 *    the Host created during an answer without clobbering user edits;
 *  - run translation jobs (single block + whole paper, 4 workers, cancel,
 *    retry) and flush them through `translations.save` in batches;
 *  - restore/persist the reading position (`lastBlockKey`, throttled through
 *    `settings.update`) and expose a jump signal the scene turns into a
 *    scroll + flash.
 *
 * The store owns no React and no DOM access: the scene maps its signals to
 * scrolling, measurement and tethers. All copy leaves the store as typed
 * `notice` keys so components translate with `t()`.
 */

import { create } from 'zustand'
import { ApiError, getHostClient } from '../api/client.ts'
import { useSettingsStore } from '../state/settings.ts'
import { groupAnnotations, isAnnotatableBlock, newAnnotationId, normalizeAnnotation } from '../../shared/annotate/highlight.ts'
import type { NormalizedAnnotation } from '../../shared/annotate/highlight.ts'
import { emptyModel } from '../../shared/markdown/model.ts'
import type { Block, PaperModel } from '../../shared/markdown/model.ts'
import type {
  Annotation,
  ContentListEntry,
  DocumentSummary,
  ParsedDocument,
  TranslationEnvelope,
} from '../../shared/model.ts'
import type { ReadCopyKey } from '../i18n/read.ts'
import type { ToastTone } from '../state/ui.ts'
import {
  MAX_ANNOTATION_QUOTE,
  mergeAnnotationsForSave,
  normalizeStaleAnnotation,
} from './annotations.ts'
import type { StaleAnnotation } from './annotations.ts'
import {
  buildDocumentOrder,
  findBlock,
  getBaseModel,
  getViewableModel,
  isTextBlock,
  translatableBlocks,
} from './model-cache.ts'

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Lifecycle of the open paper. */
export type ReaderPhase = 'empty' | 'loading' | 'ready' | 'error'

/** One-block translation job state (rendered inline under the paragraph). */
export interface TranslationJob {
  state: 'pending' | 'error'
  /** i18n key of the failure notice, when `state === 'error'`. */
  messageKey?: ReadCopyKey
}

/** Whole-paper translation progress. */
export interface TranslateAllState {
  running: boolean
  done: number
  total: number
}

/** Text selection context handed to the AI composer by the selection toolbar. */
export interface ReaderSelectionContext {
  blockKey: string
  quote: string
  text: string
  /** Where the context came from: a text selection or the per-block AI button. */
  kind?: 'selection' | 'paragraph'
}

/** A typed transient notice; the scene turns it into a toast with `t()`. */
export interface ReaderNotice {
  key: ReadCopyKey
  params?: Record<string, string | number>
  tone: ToastTone
}

/** One scroll+flash request (outline clicks, citation jumps, graph→source). */
export interface ReaderJumpRequest {
  blockKey: string
  flash: boolean
  /** Target paper; the request survives the store's own open() for it. */
  documentId: string | null
  /** Monotonic id so the scene handles each request exactly once. */
  seq: number
}

/** One translation request for a text block. */
export interface TranslateBlockOptions {
  /** Translate again even when a translation already exists. */
  force?: boolean
  /** Do not toast on failure (batch translation reports its own summary). */
  quiet?: boolean
  /** Switch the reading mode to bilingual so the result has somewhere to appear. */
  reveal?: boolean
}

/** The reader store shape. */
export interface ReaderState {
  /* Open paper */
  documentId: string | null
  document: DocumentSummary | null
  phase: ReaderPhase
  error: string | null
  /** Fetched markdown payload (kept for page-mark rebuilds). */
  source: ParsedDocument | null
  /** Markdown-hash cache key of `source`. */
  modelKey: string | null
  /** View model (page marks applied when the preference is on). */
  model: PaperModel
  /** Block key → document order; `orderOf()` source. */
  documentOrder: Map<string, number>
  pages: number | null

  /* Annotations */
  annotations: NormalizedAnnotation[]
  staleAnnotations: StaleAnnotation[]
  annotationsByBlock: Map<string, NormalizedAnnotation[]>
  droppedAnnotations: number
  activeAnnotationId: string | null
  selectionContext: ReaderSelectionContext | null

  /* Translations */
  translations: TranslationEnvelope
  translationJobs: Record<string, TranslationJob>
  translationProviders: Record<string, string>
  translateAll: TranslateAllState | null

  /* Navigation & notices */
  /** Block key the sheet should restore to once the model is ready. */
  restoreBlockKey: string | null
  jumpRequest: ReaderJumpRequest | null
  notice: ReaderNotice | null

  /* Actions */
  open: (document: DocumentSummary) => Promise<void>
  close: () => void
  /** Re-derive the view model from the cache (page-mark preference changed). */
  rebuildModel: () => void
  /** Reload annotations from the Host after an AI answer / reparse. */
  refreshAnnotations: () => Promise<void>
  /** Send a queued annotation save immediately (awaited by refresh/close). */
  flushAnnotations: () => Promise<void>
  setSelectionContext: (context: ReaderSelectionContext | null) => void
  setActiveAnnotation: (id: string | null) => void
  addAnnotation: (input: {
    blockKey: string
    start: number
    end: number
    quote: string
    color: Annotation['color']
    aspect?: Annotation['aspect']
    note?: string
  }) => NormalizedAnnotation | null
  updateAnnotation: (id: string, patch: Partial<Pick<Annotation, 'note' | 'color' | 'aspect'>>) => void
  deleteAnnotation: (id: string) => void
  removeAnnotations: (ids: readonly string[]) => void
  /** Ask the scene to scroll to a block; the store keeps the request until handled. */
  requestJump: (blockKey: string, options?: { flash?: boolean; documentId?: string }) => void
  /** Record the block under the reading line (updates position memory + prefs). */
  recordPosition: (blockKey: string) => void
  translateBlock: (blockKey: string, options?: TranslateBlockOptions) => Promise<void>
  translateAllBlocks: () => Promise<void>
  cancelTranslateAll: () => void
  retryTranslation: (blockKey: string) => Promise<void>
  clearNotice: () => void
}

/* -------------------------------------------------------------------------- */
/* Module-private state                                                        */
/* -------------------------------------------------------------------------- */

/** Throttle window for persisting the reading position to the host. */
const POSITION_SAVE_MS = 600

/** Debounce window for the whole-list annotation save. */
const ANNOTATIONS_SAVE_MS = 800

/** Debounce window for the translations save. */
const TRANSLATIONS_SAVE_MS = 1000

/** Translation concurrency cap for "translate all" (frozen 1.0.0 value). */
const TRANSLATE_CONCURRENCY = 4

/** Monotonic open-request id: a stale fetch must never overwrite a newer open. */
let openSeq = 0

/** Jump-request id, handed to the scene so each request is handled once. */
let jumpSeq = 0

/** Ids the client is authoritative about for the additive annotation merge. */
let baseIds = new Set<string>()

/** Session scroll memory per document (survives document switches). */
const positions = new Map<string, string>()

/** Ids with an in-flight single-block translation request. */
const translationInflight = new Set<string>()

/** Timer handles (module scope so `close()` can always clear them). */
let annotationsTimer: number | null = null
let translationsTimer: number | null = null
let positionTimer: number | null = null
let activeAnnotationTimer: number | null = null

/** Pending whole-list annotation payload (document id + merged items). */
let pendingAnnotationsSave: { documentId: string; items: Annotation[] } | null = null

/** Pending translations payload. */
let pendingTranslationsSave: { documentId: string; envelope: TranslationEnvelope } | null = null

/** Pending reading position. */
let pendingPosition: string | null = null

/** Active "translate all" run, if any. */
let translateAllController: AbortController | null = null

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Group and freeze the per-block annotation index. */
function annotationIndex(annotations: NormalizedAnnotation[]): Map<string, NormalizedAnnotation[]> {
  return groupAnnotations(annotations)
}

/** Current reading preferences (settings store is the persistence owner). */
function prefs(): ReturnType<typeof useSettingsStore.getState>['preferences'] {
  return useSettingsStore.getState().preferences
}

/** Raise a typed notice the scene turns into a localized toast. */
function notify(set: StoreSetter, notice: ReaderNotice): void {
  set({ notice })
}

/** Build a translation envelope from the current one plus one entry. */
function withTranslation(
  current: TranslationEnvelope,
  blockKey: string,
  text: string,
  targetLanguage: string,
  provider: string | null,
): TranslationEnvelope {
  const entries = { ...current.entries, [blockKey]: text }
  const providers = { ...(current.providers ?? {}) }
  if (provider !== null && provider !== '') providers[blockKey] = provider
  const envelope: TranslationEnvelope = { version: 1, targetLanguage, entries }
  if (Object.keys(providers).length > 0) envelope.providers = providers
  return envelope
}

/** Tolerate a missing/partial translations payload from the Host. */
function normalizeTranslations(value: unknown, fallbackLanguage: string): TranslationEnvelope {
  if (value === null || typeof value !== 'object') {
    return { version: 1, targetLanguage: fallbackLanguage, entries: {} }
  }
  const source = value as Partial<TranslationEnvelope>
  const entries: Record<string, string> = {}
  if (source.entries !== null && typeof source.entries === 'object' && !Array.isArray(source.entries)) {
    for (const [key, entry] of Object.entries(source.entries)) {
      if (typeof entry === 'string' && entry !== '') entries[key] = entry
    }
  }
  const providers: Record<string, string> = {}
  if (source.providers !== null && source.providers !== undefined && typeof source.providers === 'object') {
    for (const [key, provider] of Object.entries(source.providers)) {
      if (typeof provider === 'string' && provider !== '') providers[key] = provider
    }
  }
  const envelope: TranslationEnvelope = {
    version: 1,
    targetLanguage: typeof source.targetLanguage === 'string' && source.targetLanguage !== ''
      ? source.targetLanguage
      : fallbackLanguage,
    entries,
  }
  if (Object.keys(providers).length > 0) envelope.providers = providers
  return envelope
}

/** Error message for diagnostics/toasts, without leaking wire internals. */
function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error)
}

/** Whether a failure is an abort (silent by contract). */
function isAbort(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.code === 'aborted') ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}

/** Run `task` after the browser has painted (idle callback, timeout fallback). */
function scheduleAfterPaint(task: () => void): void {
  if (typeof window === 'undefined') {
    task()
    return
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout: 120 })
    return
  }
  window.setTimeout(task, 0)
}

/** The zustand `set` signature, kept explicit for helper parameters. */
type StoreSetter = (partial: Partial<ReaderState> | ((state: ReaderState) => Partial<ReaderState>)) => void

/* -------------------------------------------------------------------------- */
/* Annotation normalization                                                   */
/* -------------------------------------------------------------------------- */

/** Result of normalizing every persisted annotation against the live model. */
interface NormalizedAnnotations {
  normalized: NormalizedAnnotation[]
  stale: StaleAnnotation[]
  dropped: number
  baseIds: Set<string>
}

/**
 * Split persisted annotations into renderable ones and stale/orphan ones.
 *
 * Port of the frozen reader normalization effect: an annotation whose block is
 * missing, not annotatable or already flagged `stale` becomes a stale entry
 * (kept and saved); a malformed entry that cannot be normalized at all is
 * dropped from the rendered list (it never had a usable anchor).
 */
function normalizeAnnotationsAgainst(
  annotations: readonly unknown[] | null | undefined,
  model: PaperModel,
): NormalizedAnnotations {
  const blocksByKey = new Map<string, Block>()
  for (const block of model.blocks) {
    if (typeof block.key === 'string' && block.key !== '') blocksByKey.set(block.key, block)
  }
  const normalized: NormalizedAnnotation[] = []
  const stale: StaleAnnotation[] = []
  const base = new Set<string>()
  let dropped = 0
  for (const candidate of Array.isArray(annotations) ? annotations : []) {
    if (candidate === null || typeof candidate !== 'object') {
      dropped += 1
      continue
    }
    const annotation = candidate as Annotation
    const block = typeof annotation.blockKey === 'string' ? blocksByKey.get(annotation.blockKey) : undefined
    if (annotation.stale === true || block === undefined || !isAnnotatableBlock(block)) {
      const orphan = normalizeStaleAnnotation(annotation)
      if (orphan === null) {
        dropped += 1
        continue
      }
      stale.push(orphan)
      base.add(orphan.id)
      continue
    }
    const result = normalizeAnnotation(annotation, block)
    if (result === null) {
      dropped += 1
      continue
    }
    normalized.push(result)
    base.add(result.id)
  }
  return { normalized, stale, dropped, baseIds: base }
}

/** Apply a normalization result to the store (index + merge baseline included). */
function applyNormalized(set: StoreSetter, result: NormalizedAnnotations): void {
  baseIds = result.baseIds
  set({
    annotations: result.normalized,
    staleAnnotations: result.stale,
    annotationsByBlock: annotationIndex(result.normalized),
    droppedAnnotations: result.dropped,
  })
}

/** Re-normalize the store's current annotations against the current model. */
function renormalize(set: StoreSetter, get: () => ReaderState): void {
  if (get().phase !== 'ready') return
  const all: Annotation[] = [...get().annotations, ...get().staleAnnotations]
  applyNormalized(set, normalizeAnnotationsAgainst(all, get().model))
}

/* -------------------------------------------------------------------------- */
/* Persistence queues                                                        */
/* -------------------------------------------------------------------------- */

/** Queue the whole-list annotation save (debounced; one pending list wins). */
function queueAnnotationsSave(
  get: () => ReaderState,
  documentId: string,
): void {
  const state = get()
  pendingAnnotationsSave = {
    documentId,
    items: mergeAnnotationsForSave(state.annotations, state.staleAnnotations),
  }
  if (annotationsTimer !== null) return
  annotationsTimer = window.setTimeout(() => {
    annotationsTimer = null
    void flushAnnotationsImpl()
  }, ANNOTATIONS_SAVE_MS)
}

/** Send the pending annotation save (if any) and adopt the Host's merged list. */
async function flushAnnotationsImpl(): Promise<void> {
  if (annotationsTimer !== null) {
    window.clearTimeout(annotationsTimer)
    annotationsTimer = null
  }
  const pending = pendingAnnotationsSave
  pendingAnnotationsSave = null
  if (pending === null) return
  const state = useReaderStore.getState()
  if (state.documentId !== pending.documentId) return
  try {
    const result = await getHostClient().call('annotations.save', {
      id: pending.documentId,
      annotations: pending.items,
      baseIds: Array.from(baseIds),
    })
    if (useReaderStore.getState().documentId !== pending.documentId) return
    // Adopt the Host's merged list: a concurrent writer (AI answer / agent tool)
    // may have added annotations we have never rendered.
    useReaderStore.setState({ annotations: [], staleAnnotations: [], annotationsByBlock: new Map() })
    const normalized = normalizeAnnotationsAgainst(result.items, useReaderStore.getState().model)
    applyNormalized(useReaderStore.setState, normalized)
  } catch (error) {
    if (useReaderStore.getState().documentId !== pending.documentId) return
    useReaderStore.setState({
      notice: { key: 'read.error.annotations', tone: 'error' },
    })
    if (!isAbort(error)) {
      // Keep the payload for the next attempt instead of dropping the edit.
      pendingAnnotationsSave = pending
    }
  }
}

/** Queue the translations save (debounced; the whole envelope wins). */
function queueTranslationsSave(documentId: string, envelope: TranslationEnvelope): void {
  pendingTranslationsSave = { documentId, envelope }
  if (translationsTimer !== null) return
  translationsTimer = window.setTimeout(() => {
    translationsTimer = null
    void flushTranslationsImpl()
  }, TRANSLATIONS_SAVE_MS)
}

/** Send the pending translations save (if any). */
async function flushTranslationsImpl(): Promise<void> {
  if (translationsTimer !== null) {
    window.clearTimeout(translationsTimer)
    translationsTimer = null
  }
  const pending = pendingTranslationsSave
  pendingTranslationsSave = null
  if (pending === null) return
  if (useReaderStore.getState().documentId !== pending.documentId) return
  try {
    await getHostClient().call('translations.save', {
      id: pending.documentId,
      targetLanguage: pending.envelope.targetLanguage,
      entries: pending.envelope.entries,
      providers: pending.envelope.providers,
    })
  } catch {
    // Translation persistence is a cache of user intent: never block reading.
  }
}

/** Flush the pending reading position to the host. */
function flushPosition(): void {
  if (positionTimer !== null) {
    window.clearTimeout(positionTimer)
    positionTimer = null
  }
  const value = pendingPosition
  pendingPosition = null
  if (value !== null) void useSettingsStore.getState().patch({ lastBlockKey: value })
}

/** Remember a reading position and persist it (debounced). */
function rememberPosition(blockKey: string): void {
  const documentId = useReaderStore.getState().documentId
  if (documentId === null || blockKey === '') return
  positions.set(documentId, blockKey)
  pendingPosition = blockKey
  if (positionTimer !== null) return
  positionTimer = window.setTimeout(() => {
    positionTimer = null
    flushPosition()
  }, POSITION_SAVE_MS)
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

/** Clear every module-scope timer/payload (document switch, unmount, tests). */
function resetQueues(): void {
  if (annotationsTimer !== null) window.clearTimeout(annotationsTimer)
  if (translationsTimer !== null) window.clearTimeout(translationsTimer)
  if (activeAnnotationTimer !== null) window.clearTimeout(activeAnnotationTimer)
  annotationsTimer = null
  translationsTimer = null
  activeAnnotationTimer = null
  pendingAnnotationsSave = null
  pendingTranslationsSave = null
  translationInflight.clear()
  if (translateAllController !== null) {
    translateAllController.abort()
    translateAllController = null
  }
}

/** The reader store. */
export const useReaderStore = create<ReaderState>((set, get) => ({
  documentId: null,
  document: null,
  phase: 'empty',
  error: null,
  source: null,
  modelKey: null,
  model: emptyModel(),
  documentOrder: new Map(),
  pages: null,
  annotations: [],
  staleAnnotations: [],
  annotationsByBlock: new Map(),
  droppedAnnotations: 0,
  activeAnnotationId: null,
  selectionContext: null,
  translations: { version: 1, targetLanguage: 'zh', entries: {} },
  translationJobs: {},
  translationProviders: {},
  translateAll: null,
  restoreBlockKey: null,
  jumpRequest: null,
  notice: null,

  open: async (document) => {
    const seq = (openSeq += 1)
    const documentId = document.id
    // Session memory first; the host `lastBlockKey` only applies to the
    // document the host thinks we read last (otherwise a switch would jump).
    const remembered = positions.get(documentId) ?? null
    const hostPrefs = prefs()
    const restoreBlockKey =
      remembered ?? (hostPrefs.lastDocumentId === documentId ? hostPrefs.lastBlockKey : null)
    // A graph→source / citation jump may be requested before this open starts;
    // keep it when it targets this document.
    const pendingJump = get().jumpRequest
    const keepJump = pendingJump !== null && pendingJump.documentId === documentId ? pendingJump : null
    set({
      documentId,
      document,
      phase: 'loading',
      error: null,
      source: null,
      modelKey: null,
      model: emptyModel(),
      documentOrder: new Map(),
      pages: document.parse?.pages ?? null,
      annotations: [],
      staleAnnotations: [],
      annotationsByBlock: new Map(),
      droppedAnnotations: 0,
      activeAnnotationId: null,
      selectionContext: null,
      translationJobs: {},
      translationProviders: {},
      translateAll: null,
      restoreBlockKey,
      jumpRequest: keepJump,
      notice: null,
    })
    baseIds = new Set()
    resetQueues()
    // Opening one document aborts a "translate all" run on the previous one.
    if (translateAllController !== null) {
      translateAllController.abort()
      translateAllController = null
    }
    const client = getHostClient()
    try {
      const [parsed, detail] = await Promise.all([
        client.call('document.markdown', { id: documentId }),
        client.call('library.get', { id: documentId }),
      ])
      if (get().documentId !== documentId || seq !== openSeq) return
      const source: ParsedDocument = {
        markdown: parsed.markdown,
        contentList: Array.isArray(parsed.contentList)
          ? (parsed.contentList as ContentListEntry[])
          : null,
        pages: parsed.pages,
      }
      const translations = normalizeTranslations(detail.translations, prefs().targetLanguage)
      // Adopt the fresher identity fields only; the list row's trimmed parse
      // row stays the display contract for the scene.
      const refreshed: DocumentSummary = {
        ...document,
        title: detail.document.title,
        originalName: detail.document.originalName,
        updatedAt: detail.document.updatedAt,
        status: detail.document.status,
      }
      set({
        source,
        pages: parsed.pages ?? document.parse?.pages ?? null,
        document: refreshed,
        translations,
        translationProviders: translations.providers ?? {},
      })
      // Deferred model build: the paper shell (title block, skeleton) is already
      // on screen; parse off the critical path and resolve `open` when ready.
      await new Promise<void>((resolve) => {
        scheduleAfterPaint(() => {
          if (get().documentId !== documentId || seq !== openSeq) {
            resolve()
            return
          }
          const base = getBaseModel(documentId, source.markdown)
          const model = getViewableModel(base, source.contentList, prefs().showPageMarks)
          const documentOrder = buildDocumentOrder(model)
          set({ model, documentOrder, modelKey: documentId })
          const normalized = normalizeAnnotationsAgainst(detail.annotations, model)
          applyNormalized(set, normalized)
          set({ phase: 'ready', error: null })
          resolve()
        })
      })
    } catch (error) {
      if (get().documentId !== documentId || seq !== openSeq) return
      set({ phase: 'error', error: messageOf(error) })
    }
  },

  close: () => {
    openSeq += 1
    flushPosition()
    void get().flushAnnotations()
    void flushTranslationsImpl()
    resetQueues()
    set({
      documentId: null,
      document: null,
      phase: 'empty',
      error: null,
      source: null,
      modelKey: null,
      model: emptyModel(),
      documentOrder: new Map(),
      pages: null,
      annotations: [],
      staleAnnotations: [],
      annotationsByBlock: new Map(),
      droppedAnnotations: 0,
      activeAnnotationId: null,
      selectionContext: null,
      translationJobs: {},
      translationProviders: {},
      translateAll: null,
      restoreBlockKey: null,
      jumpRequest: null,
    })
    baseIds = new Set()
  },

  rebuildModel: () => {
    const state = get()
    if (state.documentId === null || state.source === null || state.phase === 'empty') return
    const base = getBaseModel(state.documentId, state.source.markdown)
    const model = getViewableModel(base, state.source.contentList, prefs().showPageMarks)
    set({ model, documentOrder: buildDocumentOrder(model) })
    renormalize(set, get)
  },

  refreshAnnotations: async () => {
    const documentId = get().documentId
    if (documentId === null || get().phase === 'empty') return
    // Persist pending local edits first so the reload cannot clobber them.
    await get().flushAnnotations()
    if (get().documentId !== documentId) return
    try {
      const detail = await getHostClient().call('library.get', { id: documentId })
      if (get().documentId !== documentId) return
      const normalized = normalizeAnnotationsAgainst(detail.annotations, get().model)
      applyNormalized(set, normalized)
    } catch (error) {
      if (get().documentId !== documentId || isAbort(error)) return
      notify(set, { key: 'read.error.annotations', tone: 'error' })
    }
  },

  flushAnnotations: () => flushAnnotationsImpl(),

  setSelectionContext: (selectionContext) => set({ selectionContext }),

  setActiveAnnotation: (id) => {
    if (activeAnnotationTimer !== null) {
      window.clearTimeout(activeAnnotationTimer)
      activeAnnotationTimer = null
    }
    set({ activeAnnotationId: id })
    if (id !== null) {
      activeAnnotationTimer = window.setTimeout(() => {
        activeAnnotationTimer = null
        set({ activeAnnotationId: null })
      }, 1600)
    }
  },

  addAnnotation: (input) => {
    const documentId = get().documentId
    if (documentId === null) return null
    const block = findBlock(get().model, input.blockKey)
    if (block === null || !isAnnotatableBlock(block)) return null
    const plainLength = typeof block.plainText === 'string' ? block.plainText.length : 0
    const start = Math.min(Math.max(0, Math.trunc(input.start)), plainLength)
    const end = Math.min(Math.max(start, Math.trunc(input.end)), plainLength)
    if (end <= start) return null
    const now = new Date().toISOString()
    const annotation: NormalizedAnnotation = {
      id: newAnnotationId(),
      blockKey: block.key,
      start,
      end,
      quote: String(input.quote ?? '').slice(0, MAX_ANNOTATION_QUOTE),
      color: input.color,
      note: typeof input.note === 'string' ? input.note : '',
      createdAt: now,
      updatedAt: now,
      origin: 'user',
    }
    if (input.aspect !== undefined) annotation.aspect = input.aspect
    const next = [...get().annotations, annotation]
    set({ annotations: next, annotationsByBlock: annotationIndex(next) })
    queueAnnotationsSave(get, documentId)
    get().setActiveAnnotation(annotation.id)
    return annotation
  },

  updateAnnotation: (id, patch) => {
    const documentId = get().documentId
    if (documentId === null) return
    const now = new Date().toISOString()
    const next = get().annotations.map((annotation) => {
      if (annotation.id !== id) return annotation
      const merged: NormalizedAnnotation = { ...annotation, ...patch, updatedAt: now }
      if (typeof merged.note !== 'string') merged.note = annotation.note ?? ''
      return merged
    })
    set({ annotations: next, annotationsByBlock: annotationIndex(next) })
    queueAnnotationsSave(get, documentId)
  },

  deleteAnnotation: (id) => {
    const documentId = get().documentId
    if (documentId === null) return
    const next = get().annotations.filter((annotation) => annotation.id !== id)
    const staleNext = get().staleAnnotations.filter((annotation) => annotation.id !== id)
    set({
      annotations: next,
      staleAnnotations: staleNext,
      annotationsByBlock: annotationIndex(next),
    })
    if (get().activeAnnotationId === id) set({ activeAnnotationId: null })
    queueAnnotationsSave(get, documentId)
  },

  removeAnnotations: (ids) => {
    const documentId = get().documentId
    if (documentId === null) return
    const idSet = new Set(ids)
    if (idSet.size === 0) return
    const next = get().annotations.filter((annotation) => !idSet.has(annotation.id))
    const staleNext = get().staleAnnotations.filter((annotation) => !idSet.has(annotation.id))
    set({
      annotations: next,
      staleAnnotations: staleNext,
      annotationsByBlock: annotationIndex(next),
    })
    if (get().activeAnnotationId !== null && idSet.has(get().activeAnnotationId as string)) {
      set({ activeAnnotationId: null })
    }
    queueAnnotationsSave(get, documentId)
  },

  requestJump: (blockKey, options = {}) => {
    if (blockKey === '') return
    jumpSeq += 1
    set({
      jumpRequest: {
        blockKey,
        flash: options.flash !== false,
        documentId: options.documentId ?? get().documentId,
        seq: jumpSeq,
      },
    })
  },

  recordPosition: (blockKey) => {
    rememberPosition(blockKey)
  },

  translateBlock: async (blockKey, options = {}) => {
    const documentId = get().documentId
    if (documentId === null || get().phase !== 'ready') return
    const block = findBlock(get().model, blockKey)
    if (block === null || !isTextBlock(block)) return
    if (typeof block.plainText !== 'string' || block.plainText.trim() === '') return
    if (translationInflight.has(blockKey)) return
    const existing = get().translations.entries[blockKey]
    if (typeof existing === 'string' && existing !== '' && options.force !== true) return
    if (options.reveal !== false && prefs().readingMode === 'original') {
      void useSettingsStore.getState().patch({ readingMode: 'bilingual' })
    }
    translationInflight.add(blockKey)
    set({
      translationJobs: { ...get().translationJobs, [blockKey]: { state: 'pending' } },
    })
    try {
      const settings = prefs()
      const value = await getHostClient().call('translate', {
        text: block.plainText,
        targetLanguage: settings.targetLanguage,
        provider: settings.translationProvider,
      })
      if (get().documentId !== documentId) return
      const text = typeof value.translation === 'string' ? value.translation : ''
      if (text === '') throw new ApiError('translate-unavailable', 'empty translation')
      const envelope = withTranslation(
        { ...get().translations, targetLanguage: value.targetLanguage || settings.targetLanguage },
        blockKey,
        text,
        value.targetLanguage || settings.targetLanguage,
        value.provider,
      )
      set({
        translations: envelope,
        translationProviders: { ...get().translationProviders, [blockKey]: value.provider },
        translationJobs: withoutKey(get().translationJobs, blockKey),
      })
      queueTranslationsSave(documentId, envelope)
    } catch (error) {
      if (get().documentId !== documentId || isAbort(error)) return
      set({
        translationJobs: {
          ...get().translationJobs,
          [blockKey]: { state: 'error', messageKey: 'read.translation.failed' },
        },
      })
      if (options.quiet !== true) {
        notify(set, { key: 'read.error.translation', tone: 'error' })
      }
    } finally {
      translationInflight.delete(blockKey)
    }
  },

  translateAllBlocks: async () => {
    const state = get()
    if (state.documentId === null || state.phase !== 'ready' || translateAllController !== null) return
    const documentId = state.documentId
    const todo = translatableBlocks(state.model).filter((block) => {
      const entry = state.translations.entries[block.key]
      return typeof entry !== 'string' || entry === ''
    })
    if (todo.length === 0) {
      notify(set, { key: 'read.translation.empty', tone: 'info' })
      return
    }
    const controller = new AbortController()
    translateAllController = controller
    const settings = prefs()
    if (settings.readingMode === 'original') {
      void useSettingsStore.getState().patch({ readingMode: 'bilingual' })
    }
    let cursor = 0
    let done = 0
    let ok = 0
    let failed = 0
    set({ translateAll: { running: true, done: 0, total: todo.length } })
    const worker = async (): Promise<void> => {
      for (;;) {
        if (controller.signal.aborted) return
        const index = cursor
        cursor += 1
        const block = todo[index]
        if (block === undefined) return
        set({
          translationJobs: { ...get().translationJobs, [block.key]: { state: 'pending' } },
        })
        try {
          const value = await getHostClient().call(
            'translate',
            {
              text: block.plainText,
              targetLanguage: settings.targetLanguage,
              provider: settings.translationProvider,
            },
            { signal: controller.signal },
          )
          if (controller.signal.aborted) return
          const text = typeof value.translation === 'string' ? value.translation : ''
          if (text === '') {
            failed += 1
          } else {
            const envelope = withTranslation(
              { ...get().translations, targetLanguage: settings.targetLanguage },
              block.key,
              text,
              value.targetLanguage || settings.targetLanguage,
              value.provider,
            )
            set({ translations: envelope })
            queueTranslationsSave(documentId, envelope)
            ok += 1
          }
          set({ translationJobs: withoutKey(get().translationJobs, block.key) })
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return
          failed += 1
          set({
            translationJobs: {
              ...get().translationJobs,
              [block.key]: { state: 'error', messageKey: 'read.translation.failed' },
            },
          })
        }
        done += 1
        set({ translateAll: { running: true, done, total: todo.length } })
      }
    }
    try {
      await Promise.all(Array.from({ length: TRANSLATE_CONCURRENCY }, () => worker()))
    } finally {
      if (translateAllController === controller) translateAllController = null
      if (get().documentId === documentId) {
        set({ translateAll: null })
        if (controller.signal.aborted) {
          notify(set, { key: 'read.translation.partial', params: { done: ok, failed }, tone: 'info' })
        } else if (failed === 0) {
          notify(set, { key: 'read.translation.done', params: { count: ok }, tone: 'success' })
        } else {
          notify(set, {
            key: 'read.translation.partial',
            params: { done: ok, failed },
            tone: 'error',
          })
        }
      }
    }
  },

  cancelTranslateAll: () => {
    if (translateAllController !== null) {
      translateAllController.abort()
      translateAllController = null
    }
    set({ translateAll: null })
  },

  retryTranslation: async (blockKey) => {
    await get().translateBlock(blockKey, { force: true })
  },

  clearNotice: () => set({ notice: null }),
}))

/** Remove one key from a record without mutating the input. */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) return record
  const next = { ...record }
  delete next[key]
  return next
}

/* -------------------------------------------------------------------------- */
/* Stable module-level exports (used by client-ai and client-graph)           */
/* -------------------------------------------------------------------------- */

/** Document order of one block (`null` when it does not resolve). */
export function orderOf(blockKey: string): number | null {
  const value = useReaderStore.getState().documentOrder.get(blockKey)
  return value === undefined ? null : value
}

/** Scroll+flash one block of the currently open paper. */
export function jumpToBlock(blockKey: string): void {
  useReaderStore.getState().requestJump(blockKey, { flash: true })
}

/**
 * Reload the open paper's annotations from the Host.
 *
 * The AI margin calls this after an answer adopted new AI annotations; the
 * reader merges them into the same margin stream without disturbing local
 * edits (pending saves are flushed first).
 */
export function refreshAnnotations(): Promise<void> {
  return useReaderStore.getState().refreshAnnotations()
}
