/**
 * Graph store: per-document + library knowledge graphs, streaming builds,
 * curation and the scene's transient selection.
 *
 * Responsibilities (task-9):
 *  - load `graph.doc` / `graph.library`, build/rebuild through the streaming
 *    methods (`graph.build`, `graph.library.rebuild`) with progress frames and
 *    cancellation;
 *  - curation through `graph.update` (rename/pin/unpin/merge) adopting the
 *    returned graph;
 *  - auto-build once after a parse when `preferences.graphAutoBuild` is on, and
 *    a quiet refresh after an AI answer emitted a knowledge delta;
 *  - cache node positions per scope so re-entering the scene keeps the map
 *    stable, and keep selection/filters.
 *
 * The store never imports scene components and never touches the DOM.
 */

import { create } from 'zustand'

import { ApiError, getHostClient } from '../api/client.ts'
import type { GraphBuildFrame, GraphPatch, KnowledgeGraph, LibraryGraphFrame } from '../../shared/model.ts'
import type { GraphNodeType } from '../../shared/constants.ts'
import { onDocumentParsed, useLibraryStore } from '../state/library.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { onAiKnowledge } from '../ai/store.ts'
import {
  curationPatch,
  normalizeGraph,
  type CurationAction,
  type CurationInput,
  type GraphScope,
  type Point,
} from './model.ts'

/** One graph load/build state. */
export type GraphStatus = 'idle' | 'loading' | 'building' | 'ready' | 'error'

/** Build progress frame surfaced by the Host stream. */
export interface GraphProgress {
  phase: string
  done: number
  total: number
}

/** The state of one loaded graph (document or library). */
export interface GraphEntry {
  /** Document the loaded graph belongs to (`null` = library scope). */
  documentId: string | null
  status: GraphStatus
  graph: KnowledgeGraph | null
  progress: GraphProgress | null
  error: string | null
}

/** Empty entry factory. */
export function emptyGraphEntry(documentId: string | null = null): GraphEntry {
  return { documentId, status: 'idle', graph: null, progress: null, error: null }
}

/** Position cache key (`doc:<id>` / `library`). */
export function positionsKey(scope: GraphScope, documentId: string | null): string {
  return scope === 'library' ? 'library' : `doc:${documentId ?? ''}`
}

/** Cached position maps kept in memory (recent scopes only). */
const MAX_POSITION_CACHES = 8

/** Largest background build stream we keep alive at once. */
const aborted = new Set<AbortController>()

/** Active build controller (one build at a time). */
let activeBuild: AbortController | null = null

/** Normalize one thrown value into a user-facing message. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** Whether an error means "no graph stored yet" (empty state, not failure). */
function isAbsent(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'not-found' || error.status === 404)
}

/** Current graph of whichever scope is active. */
export function activeEntry(state: Pick<GraphState, 'scope' | 'doc' | 'library'>): GraphEntry {
  return state.scope === 'library' ? state.library : state.doc
}

/** Currently selected node, if the active graph still has it. */
export function selectedNode(state: Pick<GraphState, 'scope' | 'doc' | 'library' | 'selectedId'>): KnowledgeGraph['nodes'][number] | null {
  const graph = activeEntry(state).graph
  if (graph === null || state.selectedId === null) return null
  return graph.nodes.find((node) => node.id === state.selectedId) ?? null
}

/** Graph store shape. */
export interface GraphState {
  scope: GraphScope
  /** Document the `doc` entry belongs to (set by load/build). */
  docId: string | null
  doc: GraphEntry
  library: GraphEntry
  selectedId: string | null
  /** `null` = every type; otherwise the whitelist (canonical order). */
  typeFilters: GraphNodeType[] | null
  /** Cached world positions per scope/document (stable re-entry). */
  positions: Record<string, Record<string, Point>>

  setScope: (scope: GraphScope) => void
  /** Load whatever the active scope needs (scene mount / scope switch). */
  loadActive: (documentId: string | null) => Promise<void>
  loadDoc: (documentId: string, options?: { force?: boolean; quiet?: boolean }) => Promise<void>
  buildDoc: (documentId: string, options?: { force?: boolean }) => Promise<void>
  loadLibrary: (options?: { force?: boolean; quiet?: boolean }) => Promise<void>
  rebuildLibrary: () => Promise<void>
  cancelBuild: () => void
  /** Apply one curation action (`graph.update`), adopting the returned graph. */
  curate: (action: CurationAction, input: CurationInput) => Promise<boolean>
  selectNode: (id: string | null) => void
  toggleType: (type: GraphNodeType) => void
  clearTypeFilters: () => void
  rememberPositions: (scope: GraphScope, documentId: string | null, positions: Record<string, Point>) => void
  cachedPositions: (scope: GraphScope, documentId: string | null) => Record<string, Point> | undefined
  reset: () => void
}

/** Adopt a normalized graph for one scope, clearing a selection that vanished. */
function adoptGraph(
  set: (partial: Partial<GraphState>) => void,
  entry: GraphEntry,
  graph: KnowledgeGraph,
): void {
  const next: GraphEntry = {
    documentId: entry.documentId,
    status: 'ready',
    graph: normalizeGraph(graph),
    progress: null,
    error: null,
  }
  set(entry.documentId === null ? { library: next } : { doc: next })
  const state = useGraphStore.getState()
  if (state.selectedId !== null) {
    const active = activeEntry(state)
    const exists = active.graph?.nodes.some((node) => node.id === state.selectedId) ?? false
    if (!exists) set({ selectedId: null })
  }
}

/** Empty positions cache entry removal (bounded memory). */
function remember(
  cache: Record<string, Record<string, Point>>,
  key: string,
  positions: Record<string, Point>,
): Record<string, Record<string, Point>> {
  const next = { ...cache, [key]: positions }
  const keys = Object.keys(next)
  while (keys.length > MAX_POSITION_CACHES) {
    const oldest = keys.shift()
    if (oldest === undefined) break
    delete next[oldest]
  }
  return next
}

/** The graph store. */
export const useGraphStore = create<GraphState>((set, get) => ({
  scope: 'doc',
  docId: null,
  doc: emptyGraphEntry(null),
  library: emptyGraphEntry(null),
  selectedId: null,
  typeFilters: null,
  positions: {},

  setScope: (scope) => {
    if (get().scope === scope) return
    set({ scope, selectedId: null })
    if (scope === 'library') {
      const entry = get().library
      if (entry.graph === null && entry.status !== 'loading' && entry.status !== 'building') {
        void get().loadLibrary()
      }
    } else {
      const documentId = get().docId ?? useUiStore.getState().currentDocumentId
      if (documentId !== null) {
        const entry = get().doc
        if ((entry.graph === null || entry.documentId !== documentId)
          && entry.status !== 'loading' && entry.status !== 'building') {
          void get().loadDoc(documentId)
        }
      }
    }
  },

  loadActive: async (documentId) => {
    if (get().scope === 'library') {
      const entry = get().library
      if (entry.graph === null && entry.status !== 'loading' && entry.status !== 'building') {
        await get().loadLibrary()
      }
      return
    }
    if (documentId !== null) await get().loadDoc(documentId)
  },

  loadDoc: async (documentId, options = {}) => {
    const current = get().doc
    if (!options.force && current.documentId === documentId
      && (current.status === 'ready' || current.status === 'loading' || current.status === 'building')) {
      return
    }
    if (current.status === 'building') get().cancelBuild()
    set({ docId: documentId, doc: { ...emptyGraphEntry(documentId), status: 'loading' } })
    try {
      const value = await getHostClient().call('graph.doc', { documentId })
      adoptGraph(set, { ...emptyGraphEntry(documentId) }, value.graph)
      // A graph loaded from disk activates the cached map immediately.
    } catch (error) {
      if (isAbsent(error)) {
        set({ doc: { ...emptyGraphEntry(documentId), status: 'ready' } })
        return
      }
      set({ doc: { documentId, status: 'error', graph: null, progress: null, error: errorMessage(error) } })
      if (options.quiet !== true) useUiStore.getState().toast(errorMessage(error), 'error')
    }
  },

  buildDoc: async (documentId, options = {}) => {
    get().cancelBuild()
    const controller = new AbortController()
    activeBuild = controller
    aborted.add(controller)
    set({
      docId: documentId,
      doc: { ...emptyGraphEntry(documentId), status: 'building' },
      selectedId: null,
    })
    try {
      await getHostClient().stream('graph.build', { documentId, force: options.force === true }, {
        signal: controller.signal,
        onFrame: (frame: GraphBuildFrame) => {
          if (controller.signal.aborted) return
          if (frame.type === 'progress') {
            set({ doc: { ...get().doc, status: 'building', progress: { phase: frame.phase, done: frame.done, total: frame.total } } })
          } else if (frame.type === 'graph') {
            adoptGraph(set, emptyGraphEntry(documentId), frame.graph)
          } else {
            set({ doc: { documentId, status: 'error', graph: get().doc.graph, progress: null, error: frame.message } })
            useUiStore.getState().toast(frame.message, 'error')
          }
        },
      })
      const entry = get().doc
      if (entry.documentId === documentId && entry.status === 'building') {
        set({ doc: { ...entry, status: entry.graph === null ? 'idle' : 'ready', progress: null } })
      }
    } catch (error) {
      if (controller.signal.aborted) {
        set({ doc: { ...get().doc, status: get().doc.graph === null ? 'idle' : 'ready', progress: null } })
        return
      }
      const message = errorMessage(error)
      set({ doc: { documentId, status: 'error', graph: get().doc.graph, progress: null, error: message } })
      useUiStore.getState().toast(message, 'error')
    } finally {
      aborted.delete(controller)
      if (activeBuild === controller) activeBuild = null
    }
  },

  loadLibrary: async (options = {}) => {
    const current = get().library
    if (!options.force && (current.status === 'loading' || current.status === 'building')) return
    if (current.status === 'building') get().cancelBuild()
    set({ library: { ...emptyGraphEntry(null), status: 'loading' } })
    try {
      const value = await getHostClient().call('graph.library', {})
      adoptGraph(set, emptyGraphEntry(null), value.graph)
    } catch (error) {
      if (isAbsent(error)) {
        set({ library: { ...emptyGraphEntry(null), status: 'ready' } })
        return
      }
      set({ library: { documentId: null, status: 'error', graph: null, progress: null, error: errorMessage(error) } })
      if (options.quiet !== true) useUiStore.getState().toast(errorMessage(error), 'error')
    }
  },

  rebuildLibrary: async () => {
    get().cancelBuild()
    const controller = new AbortController()
    activeBuild = controller
    aborted.add(controller)
    set({ library: { ...emptyGraphEntry(null), status: 'building' }, selectedId: null })
    try {
      await getHostClient().stream('graph.library.rebuild', {}, {
        signal: controller.signal,
        onFrame: (frame: LibraryGraphFrame) => {
          if (controller.signal.aborted) return
          if (frame.type === 'progress') {
            set({ library: { ...get().library, status: 'building', progress: { phase: frame.phase, done: frame.done, total: frame.total } } })
          } else if (frame.type === 'graph') {
            adoptGraph(set, emptyGraphEntry(null), frame.graph)
          } else {
            set({ library: { documentId: null, status: 'error', graph: get().library.graph, progress: null, error: frame.message } })
            useUiStore.getState().toast(frame.message, 'error')
          }
        },
      })
      const entry = get().library
      if (entry.status === 'building') {
        set({ library: { ...entry, status: entry.graph === null ? 'idle' : 'ready', progress: null } })
      }
    } catch (error) {
      if (controller.signal.aborted) {
        set({ library: { ...get().library, status: get().library.graph === null ? 'idle' : 'ready', progress: null } })
        return
      }
      const message = errorMessage(error)
      set({ library: { documentId: null, status: 'error', graph: get().library.graph, progress: null, error: message } })
      useUiStore.getState().toast(message, 'error')
    } finally {
      aborted.delete(controller)
      if (activeBuild === controller) activeBuild = null
    }
  },

  cancelBuild: () => {
    const controller = activeBuild
    activeBuild = null
    if (controller !== null) {
      controller.abort()
      aborted.delete(controller)
    }
    const state = get()
    if (state.doc.status === 'building') {
      set({ doc: { ...state.doc, status: state.doc.graph === null ? 'idle' : 'ready', progress: null } })
    }
    if (state.library.status === 'building') {
      set({ library: { ...state.library, status: state.library.graph === null ? 'idle' : 'ready', progress: null } })
    }
  },

  curate: async (action, input) => {
    const documentId = get().docId ?? useUiStore.getState().currentDocumentId
    if (documentId === null) return false
    const patch: GraphPatch | null = curationPatch(action, input)
    if (patch === null) {
      useUiStore.getState().toast('图谱操作无效', 'error')
      return false
    }
    try {
      const value = await getHostClient().call('graph.update', { documentId, ...patch })
      adoptGraph(set, emptyGraphEntry(documentId), value.graph)
      // Merge moves the selection to the surviving node.
      const merge = patch.merge?.[0]
      if (merge !== undefined) set({ selectedId: merge.to })
      useUiStore.getState().toast('已保存', 'success')
      return true
    } catch (error) {
      useUiStore.getState().toast(errorMessage(error), 'error')
      return false
    }
  },

  selectNode: (id) => {
    set({ selectedId: id })
    if (id !== null) useUiStore.getState().setMarginOpen(true)
  },

  toggleType: (type) => {
    const current = get().typeFilters
    if (current === null) {
      set({ typeFilters: [type] })
      return
    }
    const next = current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type]
    set({ typeFilters: next.length === 0 ? null : next })
  },

  clearTypeFilters: () => set({ typeFilters: null }),

  rememberPositions: (scope, documentId, positions) => {
    const key = positionsKey(scope, documentId)
    set((state) => ({ positions: remember(state.positions, key, positions) }))
  },

  cachedPositions: (scope, documentId) => get().positions[positionsKey(scope, documentId)],

  reset: () => {
    get().cancelBuild()
    set({
      scope: 'doc',
      docId: null,
      doc: emptyGraphEntry(null),
      library: emptyGraphEntry(null),
      selectedId: null,
      typeFilters: null,
      positions: {},
    })
  },
}))

/** The state changes of a selected graph entry (convenience selectors). */
export function useActiveGraph(): GraphEntry {
  return useGraphStore((state) => (state.scope === 'library' ? state.library : state.doc))
}

/* -------------------------------------------------------------------------- */
/* Host seams: parse-complete auto build + AI knowledge refresh               */
/* -------------------------------------------------------------------------- */

let seamsInstalled = false

/**
 * Install the graph store's Host seams once.
 *
 *  - `onDocumentParsed`: when `preferences.graphAutoBuild` is on, build the
 *    parsed paper's graph once. The active document builds in the store; any
 *    other paper is warmed in the background so opening it later is instant.
 *  - `onAiKnowledge`: an answer merged knowledge into `graph.json` host-side;
 *    reload the active paper's graph quietly.
 *
 * Idempotent and safe without the AI half mounted.
 */
export function installGraphSeams(): void {
  if (seamsInstalled) return
  seamsInstalled = true
  onDocumentParsed((document) => {
    if (useSettingsStore.getState().preferences.graphAutoBuild !== true) return
    const state = useGraphStore.getState()
    const activeDocumentId = state.docId ?? useUiStore.getState().currentDocumentId
    if (document.id === activeDocumentId && state.doc.status !== 'building') {
      void state.buildDoc(document.id)
      return
    }
    // Warm the host-side graph for a non-active paper (open-later latency).
    const controller = new AbortController()
    aborted.add(controller)
    void getHostClient()
      .stream('graph.build', { documentId: document.id }, { signal: controller.signal, onFrame: () => {} })
      .catch(() => {})
      .finally(() => aborted.delete(controller))
  })
  onAiKnowledge((_delta, documentId) => {
    const state = useGraphStore.getState()
    const activeDocumentId = state.docId ?? useUiStore.getState().currentDocumentId
    if (documentId !== activeDocumentId) return
    if (useLibraryStore.getState().documents.length === 0) return
    void state.loadDoc(documentId, { force: true, quiet: true })
  })
}

/** Whether the Host AI engine can build graphs (context-bar hints/empty state). */
export function graphAiAvailable(): boolean {
  const status = useLibraryStore.getState().status
  return status?.ai?.graph === true
}
