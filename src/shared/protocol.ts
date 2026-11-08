/**
 * The JSON wire contract between the two halves of the plugin.
 *
 * Transport: `POST <API_PREFIX>/<method>` with one JSON object body, answered
 * with `{ ok:true, value }` or `{ ok:false, error }`; three streaming methods
 * answer raw NDJSON frames; uploads are a raw byte stream with header metadata.
 * The Client derives every URL relative to `document.baseURI`, so the plugin
 * keeps working behind a reverse proxy.
 */

import { API_BASE_FALLBACK } from './urls.ts'
import { API_PREFIX, ASSETS_PREFIX } from './constants.ts'
import type {
  Annotation,
  ChatFrame,
  ChatHistoryValue,
  ChatRequest,
  DeepReadFrame,
  DeepReadRecord,
  DeepReadRequest,
  DocumentMeta,
  DocumentSummary,
  GraphBuildFrame,
  GraphPatch,
  KnowledgeGraph,
  LibraryGraphFrame,
  ParseStartOptions,
  ParsedDocument,
  Preferences,
  SettingsValue,
  StatusValue,
  TranslateValue,
  TranslationEnvelope,
} from './model.ts'
import type { WireErrorCode } from './constants.ts'

/** JSON API request payloads, keyed by method. */
export interface ApiRequests {
  'health.ping': { clientVersion?: string; event?: string; detail?: unknown }
  status: Record<string, never>
  'library.list': Record<string, never>
  'library.get': { id: string }
  'library.update': { id: string; title?: string }
  'library.remove': { id: string }
  'library.importUrl': { url: string; title?: string }
  'parse.start': { id: string; options?: ParseStartOptions }
  'parse.cancel': { id: string }
  'document.markdown': { id: string }
  'annotations.save': { id: string; annotations: Annotation[]; baseIds?: string[] }
  'translations.save': {
    id: string
    targetLanguage: string
    entries: Record<string, string>
    providers?: Record<string, string>
  }
  translate: { text: string; targetLanguage?: string; sourceLanguage?: string; provider?: string }
  'settings.get': Record<string, never>
  'settings.setToken': { token: string }
  'settings.clearToken': Record<string, never>
  'settings.update': { preferences: Partial<Preferences> }
  'chat.history': { documentId: string }
  'chat.clear': { documentId: string }
  'deepread.get': { documentId: string }
  'graph.doc': { documentId: string }
  'graph.update': { documentId: string } & GraphPatch
  'graph.library': Record<string, never>
}

/** JSON API response values, keyed by method. */
export interface ApiResults {
  'health.ping': { ok: true; hostVersion: string; receivedAt: string }
  status: StatusValue
  'library.list': { documents: DocumentSummary[] }
  'library.get': {
    document: DocumentMeta
    annotations: Annotation[]
    translations: TranslationEnvelope
  }
  'library.update': { document: DocumentMeta }
  'library.remove': { removed: true }
  'library.importUrl': { document: DocumentMeta }
  'parse.start': { document: DocumentMeta }
  'parse.cancel': { document: DocumentMeta }
  'document.markdown': ParsedDocument
  'annotations.save': { saved: true; items: Annotation[] }
  'translations.save': { saved: true }
  translate: TranslateValue
  'settings.get': SettingsValue
  'settings.setToken': { tokenConfigured: true; tokenPersistent: boolean }
  'settings.clearToken': { tokenConfigured: false; tokenPersistent: boolean }
  'settings.update': { preferences: Preferences }
  'chat.history': ChatHistoryValue
  'chat.clear': { cleared: true }
  'deepread.get': { record: DeepReadRecord | null }
  'graph.doc': { graph: KnowledgeGraph }
  'graph.update': { graph: KnowledgeGraph }
  'graph.library': { graph: KnowledgeGraph }
}

export type ApiMethod = keyof ApiRequests

/** NDJSON streaming methods and their frames. */
export interface StreamMethods {
  chat: { request: ChatRequest; frame: ChatFrame }
  deepread: { request: DeepReadRequest; frame: DeepReadFrame }
  'graph.build': { request: { documentId: string; force?: boolean }; frame: GraphBuildFrame }
  'graph.library.rebuild': { request: Record<string, never>; frame: LibraryGraphFrame }
}

export type StreamMethod = keyof StreamMethods

/** One JSON envelope. */
export type ApiEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: WireErrorCode | string; message: string } }

/** Response of the raw upload route. */
export interface UploadResult {
  document: DocumentMeta
}

/** Asset route query: `?id=<docId>&path=<parsedRelativePath>`. */
export interface AssetQuery {
  id: string
  path: string
}

/** Source route query: `?id=<docId>&download=0|1`. */
export interface SourceQuery {
  id: string
  download?: boolean
}

/** The default API base used when `document.baseURI` is unavailable (tests, SSR). */
export { API_BASE_FALLBACK }

/** Re-export the mount prefixes for callers that build paths by hand. */
export const ROUTES = { api: API_PREFIX, assets: ASSETS_PREFIX } as const
