/**
 * Shared fixtures for the reader tests: a fake Host client (the reader store's
 * only I/O), document/summary builders and the real parsed-paper fixture.
 *
 * The fake client records every call so tests can assert wire-level behaviour
 * (`baseIds` merge baseline, debounced saves, translation batching) without a
 * server. `test/fixtures/paper.md` is the same fixture the Host parser tests
 * use, so the reading scene renders a genuinely parsed paper.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PREFERENCES, mergePreferences } from '../../src/shared/preferences.ts'
import { ApiError } from '../../src/client/api/client.ts'
import type { HostClient } from '../../src/client/api/client.ts'
import type {
  ApiMethod,
  ApiRequests,
  ApiResults,
  StreamMethod,
  StreamMethods,
} from '../../src/shared/protocol.ts'
import type {
  Annotation,
  ContentListEntry,
  DocumentMeta,
  DocumentSummary,
  Preferences,
  SettingsValue,
  StatusValue,
  TranslateValue,
  TranslationEnvelope,
} from '../../src/shared/model.ts'

/** The real parsed-paper markdown fixture (same one the Host parse tests use). */
export const PAPER_MARKDOWN: string = readFileSync(resolve('test/fixtures/paper.md'), 'utf8')

/** MinerU content list matching `PAPER_MARKDOWN` (page marks test data). */
export const PAPER_CONTENT_LIST: ContentListEntry[] = JSON.parse(
  readFileSync(resolve('test/fixtures/content_list.json'), 'utf8'),
) as ContentListEntry[]

/** One recorded wire call. */
export interface FakeCall {
  method: ApiMethod
  payload: unknown
}

/** Options of {@link createFakeHost}. */
export interface FakeHostOptions {
  document?: Partial<DocumentMeta>
  markdown?: string
  contentList?: ContentListEntry[] | null
  pages?: number
  annotations?: Annotation[]
  translations?: TranslationEnvelope
  preferences?: Partial<Preferences>
  /** Translation handler (defaults to a deterministic pseudo-translation). */
  translate?: (text: string) => TranslateValue | Promise<TranslateValue>
  /** Host-side merge used by `annotations.save` (simulates concurrent writers). */
  mergeAnnotations?: (items: Annotation[]) => Annotation[]
}

/** The fake Host client with call recording and mutable state. */
export interface FakeHostClient extends HostClient {
  readonly calls: FakeCall[]
  /** Replace the annotations the next `library.get` returns. */
  setAnnotations: (items: Annotation[]) => void
  /** Replace the preferences the next `settings.update`/`get` returns. */
  setPreferences: (preferences: Preferences) => void
  /** Last recorded call of one method (or `undefined`). */
  lastCall: (method: ApiMethod) => FakeCall | undefined
  /** All recorded calls of one method. */
  callsOf: (method: ApiMethod) => FakeCall[]
}

/** Build one full `DocumentMeta` with the reader-usable defaults. */
export function makeDocument(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    schemaVersion: 1,
    id: 'doc-1',
    title: 'Sparse Expert Routing for Efficient Document Retrieval',
    originalName: 'sparse-route.pdf',
    ext: '.pdf',
    mime: 'application/pdf',
    size: 1024,
    sha256: 'deadbeef',
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-02T09:30:00.000Z',
    status: 'parsed',
    error: null,
    parse: {
      engine: 'standard',
      provider: 'MinerU',
      modelVersion: 'vlm',
      language: 'en',
      options: { engine: 'standard', modelVersion: 'vlm', language: 'en' },
      phase: null,
      remoteState: null,
      taskId: 'task-1',
      batchId: null,
      startedAt: '2026-11-01T08:01:00.000Z',
      finishedAt: '2026-11-01T08:04:00.000Z',
      pages: 6,
      progress: null,
      hasContentList: true,
      local: null,
    },
    ...overrides,
  }
}

/** Build one library-list row (`DocumentSummary`, trimmed parse row). */
export function makeSummary(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  const meta = makeDocument()
  const summary: DocumentSummary = {
    schemaVersion: 1,
    id: meta.id,
    title: meta.title,
    originalName: meta.originalName,
    ext: meta.ext,
    mime: meta.mime,
    size: meta.size,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    status: meta.status,
    error: meta.error,
    parse: {
      engine: meta.parse?.engine ?? null,
      provider: meta.parse?.provider ?? null,
      local: meta.parse?.local ?? null,
      modelVersion: meta.parse?.modelVersion ?? null,
      language: meta.parse?.language ?? null,
      phase: meta.parse?.phase ?? null,
      remoteState: meta.parse?.remoteState ?? null,
      ocr: meta.parse?.options?.isOcr === true,
      pages: meta.parse?.pages ?? null,
      progress: meta.parse?.progress ?? null,
      hasContentList: meta.parse?.hasContentList ?? false,
      startedAt: meta.parse?.startedAt ?? null,
      finishedAt: meta.parse?.finishedAt ?? null,
    },
    ...overrides,
  }
  return summary
}

/** Empty translation envelope for one target language. */
export function emptyTranslations(targetLanguage = 'zh'): TranslationEnvelope {
  return { version: 1, targetLanguage, entries: {} }
}

/** Build one reader preference object from defaults + patch. */
export function makePreferences(overrides: Partial<Preferences> = {}): Preferences {
  return mergePreferences({ ...DEFAULT_PREFERENCES }, overrides)
}

/** Build the settings payload the shell/tests boot with. */
export function makeSettingsValue(preferences: Preferences): SettingsValue {
  return {
    tokenConfigured: false,
    tokenPersistent: true,
    preferences,
    providers: [{ id: 'google', label: 'Google' }],
    defaults: {
      engine: 'auto',
      modelVersion: 'vlm',
      language: 'ch',
      targetLanguage: 'zh',
      translationProvider: 'auto',
      autoAllowAgentFallback: true,
      localProvider: 'auto',
    },
    local: null,
  }
}

/** Build the status payload (used when a test loads the library store). */
export function makeStatusValue(preferences: Preferences): StatusValue {
  return {
    version: '1.0.0',
    hostVersion: '1.0.0+host',
    dataDirDisplay: '~/.dsh/litnotes',
    tokenConfigured: false,
    tokenPersistent: true,
    translatorAvailable: true,
    modelAvailable: true,
    counts: { total: 1, parsed: 1, parsing: 0, failed: 0 },
    preferences,
    local: null,
    ai: { available: true, graph: true, route: { provider: 'deepseek', model: 'deepseek-flash' }, retriever: true },
  }
}

/**
 * Create a fake Host client backed by in-memory state.
 *
 * `document.markdown` + `library.get` + `annotations.save` + `translate` +
 * `translations.save` + `settings.update` are implemented; anything else throws
 * so tests fail loudly on unexpected integration.
 */
export function createFakeHost(options: FakeHostOptions = {}): FakeHostClient {
  const calls: FakeCall[] = []
  const document = makeDocument(options.document)
  const markdown = options.markdown ?? PAPER_MARKDOWN
  const contentList = options.contentList === undefined ? PAPER_CONTENT_LIST : options.contentList
  const pages = options.pages ?? document.parse?.pages ?? null
  let annotations: Annotation[] = options.annotations === undefined ? [] : [...options.annotations]
  let translations = options.translations ?? emptyTranslations()
  let preferences = makePreferences(options.preferences)
  const translate =
    options.translate ??
    ((text: string): TranslateValue => ({
      translation: `译文：${text.slice(0, 40)}`,
      provider: 'google',
      targetLanguage: 'zh',
    }))

  const host: FakeHostClient = {
    base: 'http://localhost/dsh-litnotes/api',
    calls,
    setAnnotations: (items) => {
      annotations = [...items]
    },
    setPreferences: (next) => {
      preferences = next
    },
    lastCall: (method) => calls.filter((call) => call.method === method).pop(),
    callsOf: (method) => calls.filter((call) => call.method === method),
    async call<K extends ApiMethod>(method: K, payload: ApiRequests[K]): Promise<ApiResults[K]> {
      calls.push({ method, payload })
      switch (method) {
        case 'document.markdown': {
          const value = { markdown, contentList, pages }
          // Internal assertion: the fake answers the exact wire shape.
          return value as ApiResults[K]
        }
        case 'library.get': {
          const value = { document, annotations: [...annotations], translations }
          // Internal assertion: the fake answers the exact wire shape.
          return value as ApiResults[K]
        }
        case 'annotations.save': {
          const request = payload as ApiRequests['annotations.save']
          const merged =
            options.mergeAnnotations === undefined
              ? request.annotations
              : options.mergeAnnotations(request.annotations)
          annotations = [...merged]
          // Internal assertion: the fake answers the exact wire shape.
          return { saved: true, items: [...merged] } as ApiResults[K]
        }
        case 'translations.save': {
          const request = payload as ApiRequests['translations.save']
          translations = {
            version: 1,
            targetLanguage: request.targetLanguage,
            entries: { ...request.entries },
            ...(request.providers === undefined ? {} : { providers: { ...request.providers } }),
          }
          // Internal assertion: the fake answers the exact wire shape.
          return { saved: true } as ApiResults[K]
        }
        case 'translate': {
          const request = payload as ApiRequests['translate']
          const value = await translate(request.text)
          // Internal assertion: the fake answers the exact wire shape.
          return value as ApiResults[K]
        }
        case 'settings.update': {
          const request = payload as ApiRequests['settings.update']
          preferences = mergePreferences(preferences, request.preferences)
          // Internal assertion: the fake answers the exact wire shape.
          return { preferences } as ApiResults[K]
        }
        case 'settings.get':
          // Internal assertion: the fake answers the exact wire shape.
          return makeSettingsValue(preferences) as ApiResults[K]
        case 'status':
          // Internal assertion: the fake answers the exact wire shape.
          return makeStatusValue(preferences) as ApiResults[K]
        case 'library.list':
          // Internal assertion: the fake answers the exact wire shape.
          return { documents: [makeSummary()] } as unknown as ApiResults[K]
        case 'chat.history':
          // Internal assertion: the fake answers the exact wire shape.
          return { messages: [] } as unknown as ApiResults[K]
        case 'chat.clear':
          // Internal assertion: the fake answers the exact wire shape.
          return { cleared: true } as unknown as ApiResults[K]
        case 'graph.doc':
        case 'graph.library':
          throw new ApiError('not-found', 'graph not built')
        default:
          throw new Error(`fake host: unexpected method ${String(method)}`)
      }
    },
    async stream<K extends StreamMethod>(
      method: K,
      _request: StreamMethods[K]['request'],
      _handlers: { onFrame: (frame: StreamMethods[K]['frame']) => void; signal?: AbortSignal },
    ): Promise<void> {
      throw new Error(`fake host: unexpected stream ${String(method)}`)
    },
    async upload(): Promise<{ document: DocumentMeta }> {
      throw new Error('fake host: unexpected upload')
    },
    asset: (id, path) => `http://localhost/dsh-litnotes/api/asset?id=${id}&path=${encodeURIComponent(path)}`,
    source: (id, download) => `http://localhost/dsh-litnotes/api/source?id=${id}${download === true ? '&download=1' : ''}`,
    vendor: (path) => `http://localhost/dsh-litnotes/assets/${path}`,
    ping: () => {},
  }
  return host
}
