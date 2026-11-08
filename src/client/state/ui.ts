/**
 * Transient UI state: scene, layout toggles, overlays, toasts, search.
 *
 * Persisted view preferences (scene, rail/margin visibility, widths) live in
 * the settings store; this store is the in-memory view and mirrors the ones
 * that must survive a reload through `useSettingsStore.patch`.
 */

import { create } from 'zustand'
import type { Aspect } from '../../shared/constants.ts'
import { useSettingsStore } from './settings.ts'

/** The two scenes: the paper or its knowledge map. */
export type Scene = 'read' | 'graph'

/** Modals owned by the shell. */
export type DialogKind = 'none' | 'import' | 'settings' | 'reparse' | 'rename' | 'delete'

/** Tone of one toast. */
export type ToastTone = 'info' | 'success' | 'warn' | 'error'

/**
 * Margin stream filter: everything, conversation only, notes by origin, or the
 * AI close-reading (`精读`) view.
 *
 * `chat` and `deepread` are session-only views: they are never persisted to the
 * host preferences (only the origin filters `all`/`ai`/`user` round-trip).
 */
export type MarginFilter = 'all' | 'chat' | 'ai' | 'user' | 'deepread'

/** One transient notice. */
export interface ToastItem {
  id: string
  text: string
  tone: ToastTone
}

/** UI store shape. */
export interface UiState {
  scene: Scene
  currentDocumentId: string | null
  railCollapsed: boolean
  marginOpen: boolean
  dialog: DialogKind
  /** Document the current dialog acts on (rename/delete/reparse). */
  dialogTarget: string | null
  /** Files dropped onto the desk, waiting for the import dialog to consume them. */
  pendingImportFiles: File[] | null
  /** Active aspect filter shared by the context-bar legend and the margin chips. */
  activeAspect: Aspect | null
  /** Active margin-stream filter shared by the AI chips and the reader notes. */
  marginFilter: MarginFilter
  searchQuery: string
  searchFocusTick: number
  toasts: ToastItem[]
  setScene: (scene: Scene) => void
  openDocument: (documentId: string | null) => void
  setRailCollapsed: (collapsed: boolean) => void
  setMarginOpen: (open: boolean) => void
  openDialog: (dialog: DialogKind, target?: string | null) => void
  closeDialog: () => void
  /** Queue dropped files for the import dialog and open it. */
  queueImportFiles: (files: File[]) => void
  /** Take (and clear) the queued dropped files. */
  takeImportFiles: () => File[] | null
  /** Toggle one aspect filter on/off (null clears). */
  toggleAspect: (aspect: Aspect) => void
  /**
   * Set the margin stream filter; origin filters persist to preferences while
   * the session-only views (`chat`, `deepread`) do not.
   */
  setMarginFilter: (filter: MarginFilter) => void
  setSearchQuery: (query: string) => void
  focusSearch: () => void
  toast: (text: string, tone?: ToastTone) => void
  dismissToast: (id: string) => void
}

let toastSeq = 0

/** Create-and-own the UI store. */
export const useUiStore = create<UiState>((set, get) => ({
  scene: 'read',
  currentDocumentId: null,
  railCollapsed: false,
  marginOpen: true,
  dialog: 'none',
  dialogTarget: null,
  pendingImportFiles: null,
  activeAspect: null,
  marginFilter: 'all',
  searchQuery: '',
  searchFocusTick: 0,

  toasts: [],

  setScene: (scene) => {
    if (get().scene === scene) return
    set({ scene })
    // View switches are remembered host-side.
    void useSettingsStore.getState().patch({ docView: scene })
  },

  openDocument: (documentId) => {
    set({ currentDocumentId: documentId })
    if (documentId !== null) set({ marginOpen: true })
  },

  setRailCollapsed: (collapsed) => {
    set({ railCollapsed: collapsed })
    void useSettingsStore.getState().patch({ railOpen: !collapsed })
  },

  setMarginOpen: (open) => {
    set({ marginOpen: open })
    void useSettingsStore.getState().patch({ marginOpen: open, aiPanelOpen: open })
  },

  openDialog: (dialog, target = null) => set({ dialog, dialogTarget: target }),
  closeDialog: () => set({ dialog: 'none', dialogTarget: null }),

  queueImportFiles: (files) => set({ pendingImportFiles: files, dialog: 'import' }),

  takeImportFiles: () => {
    const files = get().pendingImportFiles
    if (files !== null) set({ pendingImportFiles: null })
    return files
  },

  toggleAspect: (aspect) => set((state) => ({ activeAspect: state.activeAspect === aspect ? null : aspect })),

  setMarginFilter: (filter) => {
    set({ marginFilter: filter })
    // 对话 / 精读 are view modes inside the margin, not saved origin filters.
    if (filter === 'chat' || filter === 'deepread') return
    void useSettingsStore.getState().patch({ notesFilter: filter })
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  focusSearch: () => set((state) => ({ searchFocusTick: state.searchFocusTick + 1 })),

  toast: (text, tone = 'info') => {
    toastSeq += 1
    const id = `t${toastSeq}`
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, text, tone }] }))
    window.setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : 3200)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))

/** Adopt persisted view preferences after the settings store loads. */
export function adoptPersistedView(prefs: {
  docView: 'read' | 'graph'
  railOpen: boolean
  marginOpen: boolean
  notesFilter: 'all' | 'ai' | 'user'
}): void {
  useUiStore.setState({
    scene: prefs.docView,
    railCollapsed: !prefs.railOpen,
    marginOpen: prefs.marginOpen,
    marginFilter: prefs.notesFilter,
  })
}
