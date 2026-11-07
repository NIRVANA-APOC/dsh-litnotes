/**
 * Shared plumbing for the client-shell render tests: a scriptable fake Host
 * client, a tiny render harness with the shell locale context, and store resets.
 *
 * The identity translate function returns keys verbatim (plus params dropped),
 * so assertions can target dictionary keys instead of human copy.
 */

import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LocaleContext, type LitnotesTranslate } from '../../src/client/shell/locale-context.ts'
import { ApiError, setHostClient, type HostClient } from '../../src/client/api/client.ts'
import type { ApiMethod, ApiRequests, ApiResults, StreamMethod, StreamMethods } from '../../src/shared/protocol.ts'
import type { DocumentMeta, DocumentSummary, SettingsValue, StatusValue } from '../../src/shared/model.ts'
import { DEFAULT_PREFERENCES } from '../../src/shared/preferences.ts'
import { useLibraryStore } from '../../src/client/state/library.ts'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import { useImportController } from '../../src/client/shell/library/import-controller.ts'

/** Identity translate function (returns dictionary keys). */
export const tIdentity = ((key: string) => key) as unknown as LitnotesTranslate

/** One recorded Host call. */
export interface RecordedCall {
  method: string
  payload: unknown
}

/** Options of {@link createShellClient}. */
export interface ShellClientOptions {
  documents?: DocumentSummary[]
  settings?: SettingsValue
  status?: StatusValue
  /** Full detail returned by `library.get` (falls back to a summary-derived meta). */
  detail?: DocumentMeta
  /** Extra JSON responses by method (overrides the defaults). */
  results?: Partial<{ [K in ApiMethod]: ApiResults[K] }>
  /** Methods that reject with a wire-style failure. */
  failures?: Partial<Record<ApiMethod, { code: string; message: string }>>
  /** Uploaded document metadata returned by `upload` (`null` = reject). */
  upload?: DocumentMeta | null
}

/** The fake client plus its call log. */
export interface ShellClient extends HostClient {
  calls: RecordedCall[]
  /** Calls of one method. */
  callsOf: (method: ApiMethod) => unknown[]
}

/** Build a status payload with sensible defaults. */
export function makeStatus(overrides: Partial<StatusValue> = {}): StatusValue {
  return {
    hostVersion: '2.0.0-test',
    version: '2.0.0',
    dataDirDisplay: '~/.dsh/litnotes',
    tokenConfigured: false,
    tokenPersistent: true,
    translatorAvailable: true,
    modelAvailable: true,
    counts: { total: 0, parsed: 0, parsing: 0, failed: 0 },
    preferences: { ...DEFAULT_PREFERENCES },
    local: {
      enabled: true,
      available: true,
      recommended: 'builtin',
      providers: [{ id: 'builtin', available: true, version: 'pdfjs-dist/5.4.449' }],
      capabilities: { textLayerPdf: true, office: false, images: false, html: false },
    },
    ai: {
      available: true,
      graph: true,
      route: { provider: 'deepseek', model: 'deepseek-flash' },
      retriever: true,
    },
    ...overrides,
  }
}

/** Build a settings payload with sensible defaults. */
export function makeSettings(overrides: Partial<SettingsValue> = {}): SettingsValue {
  return {
    tokenConfigured: false,
    tokenPersistent: true,
    preferences: { ...DEFAULT_PREFERENCES },
    providers: [
      { id: 'builtin', label: 'Built-in' },
      { id: 'llm', label: 'LLM' },
    ],
    defaults: {
      engine: 'auto',
      modelVersion: 'vlm',
      language: 'ch',
      targetLanguage: 'zh',
      translationProvider: 'auto',
      autoAllowAgentFallback: true,
      localProvider: 'auto',
    },
    local: makeStatus().local,
    ...overrides,
  }
}

/** Build one library-list row. */
export function makeDocument(
  id: string,
  overrides: Partial<DocumentSummary> = {},
): DocumentSummary {
  const title = overrides.title ?? `Paper ${id}`
  return {
    schemaVersion: 1,
    id,
    title,
    originalName: `${title}.pdf`,
    ext: '.pdf',
    mime: 'application/pdf',
    size: 1024,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    status: 'parsed',
    error: null,
    parse: {
      engine: 'standard',
      provider: null,
      local: null,
      modelVersion: 'vlm',
      language: 'ch',
      phase: null,
      remoteState: null,
      ocr: false,
      pages: 12,
      progress: null,
      hasContentList: false,
      startedAt: null,
      finishedAt: null,
    },
    ...overrides,
  }
}

/** Build a full document metadata payload from a summary row. */
export function makeDocumentMeta(summary: DocumentSummary): DocumentMeta {
  return {
    ...summary,
    sha256: 'a'.repeat(64),
    parse:
      summary.parse === null
        ? null
        : {
            engine: summary.parse.engine,
            provider: summary.parse.provider,
            modelVersion: summary.parse.modelVersion,
            language: summary.parse.language,
            options: null,
            phase: summary.parse.phase,
            remoteState: summary.parse.remoteState,
            taskId: null,
            batchId: null,
            startedAt: summary.parse.startedAt,
            finishedAt: summary.parse.finishedAt,
            pages: summary.parse.pages,
            progress: summary.parse.progress,
            hasContentList: summary.parse.hasContentList,
            local: summary.parse.local,
            repair: null,
          },
  }
}

/**
 * Create a fake Host client answering the shell's boot + action methods and
 * recording every call.
 *
 * @param options - documents/settings/status fixtures and failure injection.
 * @returns the fake client.
 */
export function createShellClient(options: ShellClientOptions = {}): ShellClient {
  const calls: RecordedCall[] = []
  const documents = options.documents ?? []
  const settings = options.settings ?? makeSettings()
  const status = options.status ?? makeStatus()
  const detailFor = (id: string): DocumentMeta => {
    if (options.detail !== undefined) return options.detail
    const summary = documents.find((document) => document.id === id) ?? makeDocument(id)
    return makeDocumentMeta(summary)
  }
  const client: ShellClient = {
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.payload),
    base: 'http://localhost/dsh-litnotes/api',
    async call<K extends ApiMethod>(method: K, payload: ApiRequests[K]): Promise<ApiResults[K]> {
      calls.push({ method, payload })
      const failure = options.failures?.[method]
      if (failure !== undefined) throw new ApiError(failure.code, failure.message)
      const override = options.results?.[method]
      if (override !== undefined) return override as ApiResults[K]
      // The fake mirrors only the methods the shell calls; casts are test-local.
      if (method === 'library.list') return { documents } as unknown as ApiResults[K]
      if (method === 'status') return status as unknown as ApiResults[K]
      if (method === 'settings.get') return settings as unknown as ApiResults[K]
      if (method === 'settings.update') {
        const patch = (payload as ApiRequests['settings.update']).preferences
        settings.preferences = { ...settings.preferences, ...patch }
        return { preferences: settings.preferences } as unknown as ApiResults[K]
      }
      if (method === 'settings.setToken') {
        settings.tokenConfigured = true
        return { tokenConfigured: true, tokenPersistent: true } as unknown as ApiResults[K]
      }
      if (method === 'settings.clearToken') {
        settings.tokenConfigured = false
        return { tokenConfigured: false, tokenPersistent: true } as unknown as ApiResults[K]
      }
      if (method === 'parse.start') {
        const id = (payload as ApiRequests['parse.start']).id
        const summary = documents.find((document) => document.id === id) ?? makeDocument(id)
        return { document: makeDocumentMeta({ ...summary, status: 'parsing' }) } as unknown as ApiResults[K]
      }
      if (method === 'parse.cancel') {
        const id = (payload as ApiRequests['parse.cancel']).id
        const summary = documents.find((document) => document.id === id) ?? makeDocument(id)
        return { document: makeDocumentMeta({ ...summary, status: 'parsed' }) } as unknown as ApiResults[K]
      }
      if (method === 'library.get') {
        const id = (payload as ApiRequests['library.get']).id
        return {
          document: detailFor(id),
          annotations: [],
          translations: { version: 1, targetLanguage: 'zh', entries: {} },
        } as unknown as ApiResults[K]
      }
      if (method === 'library.importUrl') {
        return { document: detailFor('imported-url') } as unknown as ApiResults[K]
      }
      if (method === 'library.update') {
        const request = payload as ApiRequests['library.update']
        const summary = documents.find((document) => document.id === request.id) ?? makeDocument(request.id)
        return {
          document: makeDocumentMeta({ ...summary, title: request.title ?? summary.title }),
        } as unknown as ApiResults[K]
      }
      if (method === 'library.remove') return { removed: true } as unknown as ApiResults[K]
      if (method === 'annotations.save') return { saved: true, items: [] } as unknown as ApiResults[K]
      if (method === 'translations.save') return { saved: true } as unknown as ApiResults[K]
      if (method === 'chat.history') return { messages: [] } as unknown as ApiResults[K]
      if (method === 'graph.doc') {
        return {
          graph: { version: 1, scope: 'document', generatedAt: null, overview: '', nodes: [], edges: [], stats: { nodes: 0, edges: 0 } },
        } as unknown as ApiResults[K]
      }
      throw new Error(`fake Host: unexpected method ${String(method)}`)
    },
    async stream<K extends StreamMethod>(_method: K, _request: StreamMethods[K]['request']): Promise<void> {
      throw new Error('fake Host: stream not expected')
    },
    async upload(file: File) {
      calls.push({ method: 'upload', payload: file.name })
      if (options.upload === null) throw new Error('upload rejected')
      const document = options.upload ?? makeDocumentMeta(makeDocument('uploaded', { title: file.name }))
      return { document }
    },
    asset: (id, path) => `http://localhost/asset/${id}/${path}`,
    source: (id) => `http://localhost/source/${id}`,
    vendor: (path) => `http://localhost/vendor/${path}`,
    ping: () => {},
  }
  return client
}

/** Install a fake client for the current test. */
export function installShellClient(options: ShellClientOptions = {}): ShellClient {
  const client = createShellClient(options)
  setHostClient(client)
  return client
}

/** Reset every client store the shell touches. */
export function resetShellStores(documents: DocumentSummary[] = []): void {
  useLibraryStore.setState({
    documents,
    status: null,
    loading: false,
    loaded: true,
    error: null,
    revision: 0,
  })
  useSettingsStore.setState({
    loaded: true,
    loading: false,
    error: null,
    preferences: { ...DEFAULT_PREFERENCES },
    tokenConfigured: false,
    tokenPersistent: true,
    providers: makeSettings().providers,
    local: makeStatus().local,
  })
  useUiStore.setState({
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
  })
  useImportController.setState({ uploads: [] })
}

/** A mounted React root with the shell locale context. */
export interface ShellRender {
  container: HTMLDivElement
  root: Root
  unmount: () => void
}

/** Mount one element inside the shell locale context. */
export function renderShell(element: ReactElement): ShellRender {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<LocaleContext.Provider value={tIdentity}>{element}</LocaleContext.Provider>)
  })
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

/** Flush pending microtasks/timers inside `act`. */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Set a React-controlled input value and fire the change event React listens to. */
export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter !== undefined) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Click one element inside `act`. */
export function click(element: Element | null | undefined): void {
  if (element === null || element === undefined) throw new Error('click target missing')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** Find a button by its visible text (identity translate = dictionary key). */
export function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.textContent ?? '').includes(text),
    ) ?? null
  )
}
