/**
 * Library store: the document list, aggregate status, import/parse actions and
 * the polling that keeps in-flight parses fresh.
 *
 * The store owns no rendering; scenes subscribe to narrow slices. A parse
 * transition (`parsing` → `parsed`) notifies listeners so the graph auto-build
 * preference can react without the library store importing the graph store.
 */

import { create } from 'zustand'
import { ApiError, getHostClient } from '../api/client.ts'
import type { DocumentMeta, DocumentSummary, ParseStartOptions, StatusValue } from '../../shared/model.ts'
import { useUiStore } from './ui.ts'
import { useSettingsStore } from './settings.ts'

/** Listener invoked when one document finishes parsing successfully. */
export type DocumentParsedListener = (document: DocumentMeta) => void

const parsedListeners = new Set<DocumentParsedListener>()

/** Subscribe to successful parse completions (returns a disposer). */
export function onDocumentParsed(listener: DocumentParsedListener): () => void {
  parsedListeners.add(listener)
  return () => parsedListeners.delete(listener)
}

/** Library store shape. */
export interface LibraryState {
  documents: DocumentSummary[]
  status: StatusValue | null
  loading: boolean
  loaded: boolean
  error: string | null
  /** Incremented on every successful refresh (cheap change detection). */
  revision: number
  load: () => Promise<void>
  refresh: (options?: { quiet?: boolean }) => Promise<void>
  importFiles: (files: ArrayLike<File>) => Promise<void>
  importUrl: (url: string, title?: string) => Promise<DocumentMeta | null>
  startParse: (id: string, options?: ParseStartOptions) => Promise<void>
  cancelParse: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<boolean>
  dispose: () => void
}

let pollTimer: number | null = null

/** Start/stop the parse progress poller based on the current list. */
function syncPolling(get: () => LibraryState): void {
  const parsing = get().documents.some((document) => document.status === 'parsing')
  if (parsing && pollTimer === null) {
    pollTimer = window.setInterval(() => {
      void get().refresh({ quiet: true })
    }, 1500)
  } else if (!parsing && pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

/** Apply one refreshed list, detecting parse transitions. */
function applyDocuments(
  previous: DocumentSummary[],
  next: DocumentSummary[],
  set: (partial: Partial<LibraryState>) => void,
): void {
  set({ documents: next, revision: Date.now() })
  const before = new Map(previous.map((document) => [document.id, document.status]))
  for (const document of next) {
    if (document.status === 'parsed' && before.get(document.id) === 'parsing') {
      for (const listener of parsedListeners) {
        try {
          listener(document as DocumentMeta)
        } catch {
          /* a listener failure must not break refresh */
        }
      }
    }
  }
}

/** The library store. */
export const useLibraryStore = create<LibraryState>((set, get) => ({
  documents: [],
  status: null,
  loading: false,
  loaded: false,
  error: null,
  revision: 0,

  load: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const [status, list] = await Promise.all([
        getHostClient().call('status', {}),
        getHostClient().call('library.list', {}),
      ])
      set({ status, loaded: true })
      applyDocuments(get().documents, list.documents, set)
      useSettingsStore.setState({
        preferences: status.preferences,
        tokenConfigured: status.tokenConfigured,
        tokenPersistent: status.tokenPersistent,
        local: status.local,
        loaded: true,
      })
      useSettingsStore.getState().adopt({
        tokenConfigured: status.tokenConfigured,
        tokenPersistent: status.tokenPersistent,
        preferences: status.preferences,
        providers: useSettingsStore.getState().providers,
        defaults: {
          engine: status.preferences.defaultEngine,
          modelVersion: status.preferences.defaultModelVersion,
          language: status.preferences.defaultLanguage,
          targetLanguage: status.preferences.targetLanguage,
          translationProvider: status.preferences.translationProvider,
          autoAllowAgentFallback: status.preferences.autoAllowAgentFallback,
          localProvider: 'auto',
        },
        local: status.local,
      })
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      set({ error: message })
    } finally {
      set({ loading: false })
      syncPolling(get)
    }
  },

  refresh: async (options = {}) => {
    if (!options.quiet) set({ loading: true })
    try {
      const list = await getHostClient().call('library.list', {})
      applyDocuments(get().documents, list.documents, set)
      set({ error: null, loaded: true })
    } catch (error) {
      if (!options.quiet) {
        const message = error instanceof ApiError ? error.message : String(error)
        set({ error: message })
      }
    } finally {
      if (!options.quiet) set({ loading: false })
      syncPolling(get)
    }
  },

  importFiles: async (files) => {
    const client = getHostClient()
    for (const file of Array.from(files)) {
      try {
        const { document } = await client.upload(file)
        set((state) => ({ documents: [document as DocumentSummary, ...state.documents] }))
        useUiStore.getState().toast(`已导入 ${document.title}`, 'success')
      } catch (error) {
        const message = error instanceof ApiError ? error.message : String(error)
        useUiStore.getState().toast(`导入失败：${message}`, 'error')
      }
    }
    await get().refresh({ quiet: true })
  },

  importUrl: async (url, title) => {
    try {
      const { document } = await getHostClient().call('library.importUrl', { url, title })
      await get().refresh({ quiet: true })
      useUiStore.getState().toast(`已导入 ${document.title}`, 'success')
      return document
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(`导入失败：${message}`, 'error')
      return null
    }
  },

  startParse: async (id, options) => {
    try {
      const { document } = await getHostClient().call('parse.start', { id, options: options ?? {} })
      set((state) => ({
        documents: state.documents.map((entry) =>
          entry.id === document.id ? ({ ...entry, ...document } as DocumentSummary) : entry,
        ),
      }))
      syncPolling(get)
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(`解析失败：${message}`, 'error')
    }
  },

  cancelParse: async (id) => {
    try {
      await getHostClient().call('parse.cancel', { id })
      await get().refresh({ quiet: true })
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(message, 'error')
    }
  },

  rename: async (id, title) => {
    try {
      const { document } = await getHostClient().call('library.update', { id, title })
      set((state) => ({
        documents: state.documents.map((entry) =>
          entry.id === document.id ? ({ ...entry, title: document.title } as DocumentSummary) : entry,
        ),
      }))
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(message, 'error')
    }
  },

  remove: async (id) => {
    try {
      await getHostClient().call('library.remove', { id })
      set((state) => ({ documents: state.documents.filter((document) => document.id !== id) }))
      if (useUiStore.getState().currentDocumentId === id) useUiStore.getState().openDocument(null)
      useUiStore.getState().toast('文献已删除', 'success')
      return true
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error)
      useUiStore.getState().toast(message, 'error')
      return false
    }
  },

  dispose: () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
    parsedListeners.clear()
  },
}))
