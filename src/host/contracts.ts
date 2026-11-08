/**
 * Host-side module contracts in TypeScript.
 *
 * These are the seams between the independently built Host modules. The
 * composition root (`src/host/index.ts`) wires the concrete factories; each
 * module only knows the interfaces it consumes. Keeping the contracts here —
 * instead of importing runtime code across folders — lets the library store,
 * the parse pipeline, the AI engine and the shared service be ported and
 * tested independently while staying type-checked against one shape.
 *
 * Data formats behind these interfaces are the frozen 1.0.0 on-disk JSON
 * contract (`meta.json`, `annotations.json`, `chat.json`, `graph.json`,
 * `library-graph.json`, `preferences.json`); existing user libraries must keep
 * working without migration.
 */

import type {
  AiStatus,
  AnnotationEnvelope,
  Annotation,
  ChatFrame,
  ChatMessage,
  ChatRequest,
  Citation,
  DeepReadFrame,
  DeepReadRecord,
  DeepReadRequest,
  DocumentMeta,
  DocumentSummary,
  GraphBuildFrame,
  GraphPatch,
  KnowledgeGraph,
  KnowledgeDelta,
  LibraryGraphFrame,
  LocalCapabilities,
  ModelRoute,
  ParseOptions,
  ParseStartOptions,
  ParseState,
  ParsedDocument,
  Preferences,
  SettingsValue,
  StatusValue,
  TranslateValue,
  TranslationEnvelope,
} from '../shared/model.ts'
import type { LocalProvider, ModelVersion, ParseEngine } from '../shared/constants.ts'
import type { ConnectionService, Logger, ModelSelection, ToolsService, WebServerService } from './host-services.ts'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Local parse engine limits (raw row config `local:` block). */
export interface LocalConfig {
  enabled: boolean
  maxPages: number
  maxPdfBytes: number
  maxTextBytes: number
  minCharsPerPage: number
  maxParagraphChars: number
  keepContentList: boolean
  timeoutMs: number
  maxOfficePdfBytes: number
}

/** Grounded-AI limits (raw row config `ai:` block). */
export interface AiConfig {
  provider: string
  model: string
  maxContextChars: number
  historyTurns: number
  answerMaxTokens: number
  graphMaxTokens: number
  graphSummaryChars: number
  maxAnnotationsPerAnswer: number
  reasoningEffort: string
  maxGraphChunks: number
  maxGraphSourceChars: number
  entailmentCheck: boolean
  entailmentMaxTokens: number
  /* AI 精读 (deep read) limits (`docs/AI-SPEC.md` §7). */
  deepReadMaxChunks: number
  deepReadMaxSourceChars: number
  deepReadMaxAnnotations: number
  deepReadMaxTokens: number
  deepReadSynthesisChars: number
  deepReadCoveragePass: boolean
  deepReadJudge: boolean
}

/** Resolved Host configuration (defaults applied, paths absolute). */
export interface ResolvedConfig {
  dataDir: string
  apiBase: string
  maxUploadBytes: number
  maxConcurrentParses: number
  pollIntervalMs: number
  parseTimeoutMs: number
  toolMaxChars: number
  ai: AiConfig
  local: LocalConfig
  hostVersion: string
}

// ---------------------------------------------------------------------------
// Store (on-disk library)
// ---------------------------------------------------------------------------

/** Auxiliary JSON documents stored beside a document (`chat.json`, `graph.json`, `deepread.json`). */
export type DocumentAuxName = 'chat.json' | 'graph.json' | 'deepread.json'
/** Auxiliary JSON documents stored at the library root (`library-graph.json`). */
export type LibraryAuxName = 'library-graph.json'

/** Per-document write queue (serializes read-modify-write cycles). */
export interface DocumentQueue {
  run: <T>(id: string, task: () => Promise<T>) => Promise<T>
  pending: () => Promise<unknown>[]
  size: () => number
}

/** Persistence for the whole library. Every method is safe before `init()`. */
export interface StoreApi {
  init: () => Promise<void>
  list: () => DocumentMeta[]
  get: (id: string) => DocumentMeta | undefined
  has: (id: string) => boolean
  docDir: (id: string) => string
  sourcePath: (id: string) => Promise<string>
  parsedDir: (id: string) => string
  newTempPath: (id: string) => string
  createFromFile: (input: {
    id: string
    tempPath: string
    originalName: string
    title?: string
  }) => Promise<DocumentMeta>
  update: (
    id: string,
    patch: Partial<Omit<DocumentMeta, 'parse'>> & { parse?: Partial<ParseState> | null },
  ) => Promise<DocumentMeta>
  remove: (id: string) => Promise<void>
  readMarkdown: (id: string) => Promise<ParsedDocument>
  loadAnnotations: (id: string) => Promise<AnnotationEnvelope>
  saveAnnotations: (id: string, data: { items?: Annotation[]; baseIds?: string[] }) => Promise<AnnotationEnvelope>
  mutateAnnotations: (id: string, mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>) => Promise<AnnotationEnvelope>
  loadTranslations: (id: string) => Promise<TranslationEnvelope>
  saveTranslations: (id: string, data: Partial<TranslationEnvelope>) => Promise<TranslationEnvelope>
  readAux: <T>(id: string, name: DocumentAuxName) => Promise<T | undefined>
  writeAux: (id: string, name: DocumentAuxName, value: unknown) => Promise<void>
  mutateAux: <T>(id: string, name: DocumentAuxName, mutate: (current: T | undefined) => T | Promise<T>) => Promise<T>
  readLibraryAux: <T>(name: LibraryAuxName) => Promise<T | undefined>
  writeLibraryAux: (name: LibraryAuxName, value: unknown) => Promise<void>
  readPreferences: () => Promise<Preferences>
  writePreferences: (preferences: Preferences) => Promise<void>
  appendDiagnostic: (entry: Record<string, unknown>) => Promise<void>
  stats: () => { total: number; parsed: number; parsing: number; failed: number }
  dispose: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * One MinerU client failure is the canonical class exported by
 * `src/host/parse/mineru.ts` (`MineruError` with a structured detail payload);
 * the service layer imports it from there.
 */

/** Normalized parse plan produced by `normalizeParseOptions`. */
export interface ParsePlan {
  engine: ParseEngine
  params: Record<string, unknown>
}

/** Context passed to the parse-option normalizer. */
export interface ParseOptionContext {
  hasToken: boolean
  maxUploadBytes: number
  localSupported: boolean
  localReason?: string
  localMaxBytes: number
  autoAllowAgentFallback: boolean
}

/** Options resolved for a local extraction. */
export interface LocalPlan {
  provider: string
  params: Record<string, unknown>
}

/** Result of one local extraction. */
export interface LocalExtractResult {
  markdown: string
  contentList: unknown[] | null
  pages: number
  provider: string
  title: string | null
  warnings: string[]
  stats: {
    pageCount: number
    textChars: number
    extractMs: number
    toolVersion: string
    provider: string
  }
}

/** Local (T0/T0.5) parsing engine facade. */
export interface LocalEngineApi {
  readonly config: LocalConfig
  readonly providers: { builtin: string; office: string }
  snapshot: () => LocalCapabilities & { configuration: LocalConfig }
  supports: (meta: DocumentMeta) => { supported: boolean; provider: string | null; reason?: string }
  plan: (meta: DocumentMeta, options?: { localProvider?: LocalProvider }) => LocalPlan
  extract: (input: {
    id: string
    meta: DocumentMeta
    sourcePath: string
    params: Record<string, unknown>
    signal: AbortSignal
    onProgress?: (progress: { extracted: number; total: number }) => void
  }) => Promise<LocalExtractResult>
}

/** A page-scoped repair request (merge a repaired subset of pages into the parsed document). */
export interface ParseRepairRequest {
  merge: true
  pages?: number[]
  modelVersion?: ModelVersion
  language?: string
  isOcr?: boolean
  enableFormula?: boolean
  enableTable?: boolean
}

/** One start request: a normalized fresh-parse plan or a page-scoped repair. */
export type ParseStartRequest = ParsePlan | ParseRepairRequest

/** Re-anchor document annotations after a successful (re)parse. */
export type ReanchorHook = (input: {
  documentId: string
  annotations: Annotation[]
  markdown: string
  contentList: unknown[] | null
}) => Promise<Annotation[]> | Annotation[]

/** Async parse-task queue with resume-after-restart support. */
export interface ParseManagerApi {
  start: (id: string, request: ParseStartRequest) => Promise<DocumentMeta>
  cancel: (id: string) => Promise<DocumentMeta>
  resume: () => void
  dispose: () => Promise<void>
}

/** MinerU HTTP client (cloud engines). */
export interface MineruClientApi {
  standardCreateBatch: (input: {
    fileName: string
    dataId: string
    options: Record<string, unknown>
  }) => Promise<{ batchId: string; uploadUrl: string }>
  putBytes: (uploadUrl: string, bytes: Uint8Array) => Promise<{ status: number }>
  standardBatchResult: (batchId: string) => Promise<{
    results: Array<{
      dataId: string
      fileName: string
      state: string
      fullZipUrl?: string
      errMsg?: string
      progress?: { extractedPages?: number; totalPages?: number } | unknown
    }>
  }>
  agentCreateTask: (input: { fileName: string; options: Record<string, unknown> }) => Promise<{
    taskId: string
    uploadUrl: string
  }>
  agentTaskResult: (taskId: string) => Promise<{
    state: string
    markdownUrl?: string
    errMsg?: string
    errCode?: string
    progress?: { extractedPages?: number; totalPages?: number } | unknown
  }>
  downloadBytes: (url: string, options?: { maxBytes?: number }) => Promise<Buffer>
}

// ---------------------------------------------------------------------------
// AI engine
// ---------------------------------------------------------------------------

/** One message of the model gateway. */
export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** One ordered paper block exposed by the retriever for citation validation. */
export interface RetrieverBlock {
  key: string
  index: number
  kind: string
  page: number | null
  section: string | null
  /** Plain text of the block, the annotation/citation offset space. */
  text: string
}

/** One context block selected by retrieval. */
export interface RetrievedBlock {
  key: string
  page: number | null
  index: number
  text: string
  kind: string
  score: number
  section: string | null
}

/** Result of building one grounded context. */
export interface RetrievedContext {
  blocks: RetrievedBlock[]
  outline: Array<{ key: string; level: number; text: string }>
  sections: string[]
  usedChars: number
  totalBlocks: number
}

/** Lexical retriever over parsed blocks. */
export interface RetrieverApi {
  buildIndex: (input: {
    documentId: string
    markdown: string
    contentList: unknown[] | null
    outline: Array<{ key: string; level: number; text: string }>
  }) => void
  context: (input: {
    documentId: string
    markdown: string
    contentList: unknown[] | null
    question: string
    focusBlockKey?: string
    selection?: string
    topK?: number
    budgetChars?: number
  }) => RetrievedContext
  search: (input: {
    documentId: string
    markdown: string
    contentList: unknown[] | null
    query: string
    limit?: number
  }) => RetrievedBlock[]
  /** Ordered blocks of one indexed document (citation/anchor validation). */
  blocks: (input: {
    documentId: string
    markdown: string
    contentList: unknown[] | null
  }) => RetrieverBlock[]
  invalidate: (documentId: string) => void
}

/** Normalized model-gateway stream chunks. */
export type AiStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'finish'; reason: { kind: string } }

/** Model gateway over the Host `llm` service. */
export interface LlmGatewayApi {
  available: () => boolean
  route: () => ModelSelection | null
  streamText: (request: {
    system?: string
    messages: AiChatMessage[]
    signal?: AbortSignal
    maxTokens?: number
    temperature?: number
    purpose?: string
    reasoningEffort?: string
  }) => AsyncGenerator<AiStreamChunk>
  completeText: (request: {
    system?: string
    messages: AiChatMessage[]
    signal?: AbortSignal
    maxTokens?: number
    purpose?: string
    maxChars?: number
  }) => Promise<string>
}

/** Grounded reading conversation. */
export interface ChatServiceApi {
  history: (documentId: string) => Promise<ChatMessage[]>
  clear: (documentId: string) => Promise<{ cleared: true }>
  stream: (request: ChatRequest, signal: AbortSignal) => AsyncGenerator<ChatFrame>
}

/** Knowledge graph service (per document + library aggregation). */
export interface GraphServiceApi {
  docGraph: (documentId: string) => Promise<KnowledgeGraph>
  buildDocGraph: (documentId: string, options: {
    signal: AbortSignal
    force?: boolean
  }) => AsyncGenerator<GraphBuildFrame>
  mergeDocKnowledge: (documentId: string, delta: KnowledgeDelta) => Promise<KnowledgeGraph>
  updateDocGraph: (documentId: string, patch: GraphPatch) => Promise<KnowledgeGraph>
  libraryGraph: () => Promise<KnowledgeGraph>
  rebuildLibraryGraph: (input: { signal: AbortSignal }) => AsyncGenerator<LibraryGraphFrame>
}

/** Close-reading (AI 精读) service. */
export interface DeepReadServiceApi {
  /** Persisted record, or null when the document has never been deep-read. */
  get: (documentId: string) => Promise<DeepReadRecord | null>
  /** Run (or replay) the workflow; frames follow `docs/AI-SPEC.md` §5.3. */
  run: (
    documentId: string,
    options: { signal: AbortSignal; force?: boolean; language?: string },
  ) => AsyncGenerator<DeepReadFrame>
}

/** Lazily-created AI engine bundle. */
export interface AiServicesApi {
  readonly llm: LlmGatewayApi
  readonly retriever: RetrieverApi
  readonly chat: ChatServiceApi
  readonly graph: GraphServiceApi
  readonly deepread: DeepReadServiceApi
  readonly available: boolean
  readonly version: string
}

// ---------------------------------------------------------------------------
// Service facade (shared by routes and agent tools)
// ---------------------------------------------------------------------------

/** Compact document row returned by `toolList`. */
export interface ToolDocumentRow {
  documentId: string
  title: string
  status: string
  pages: number | null
  engine: string | null
  provider: string | null
  remoteState: string | null
  progress: { extracted: number; total: number } | null
  createdAt: string
  error: string | null
}

/** One search hit (block coordinate + snippet). */
export interface SearchHit {
  documentId: string
  title: string
  blockKey: string
  page: number | null
  kind: string
  score: number
  snippet: string
}

/** Aggregated search result. */
export interface SearchResult {
  query: string
  scope: 'library' | 'document'
  matches: SearchHit[]
  scanned: { documents: number; blocks: number }
  truncated: boolean
}

/** A document plus its parsed block model. */
export interface DocumentModel {
  document: {
    id: string
    title: string
    status: string
    pages: number | null
    parse: DocumentMeta['parse'] | null
  }
  markdown: string
  blocks: Array<{ key: string; page: number | null; kind: string; plainText: string }>
  outline: Array<{ key: string; level: number; text: string }>
  stats: { blocks: number; headings: number; chars: number; words: number }
}

/** One requested block text. */
export interface BlockText {
  blockKey: string
  found: boolean
  page: number | null
  kind: string | null
  text: string
}

/** The operations layer every surface (HTTP, agent tools) calls. */
export interface ServiceApi {
  readonly ASPECT_COLORS: Readonly<Record<string, string>>
  healthPing: (payload: Record<string, unknown>) => Promise<{ ok: true; hostVersion: string; receivedAt: string }>
  getStatus: () => Promise<StatusValue>
  listDocuments: () => Promise<{ documents: DocumentSummary[] }>
  getDocument: (id: string) => Promise<{
    document: DocumentMeta
    annotations: Annotation[]
    translations: TranslationEnvelope
  }>
  updateDocument: (id: string, patch: { title?: string }) => Promise<{ document: DocumentMeta }>
  removeDocument: (id: string) => Promise<{ removed: true }>
  importUrl: (input: { url: string; title?: string }) => Promise<{ document: DocumentMeta }>
  startParse: (id: string, options: ParseStartOptions) => Promise<{ document: DocumentMeta }>
  cancelParse: (id: string) => Promise<{ document: DocumentMeta }>
  readMarkdown: (id: string) => Promise<ParsedDocument>
  saveAnnotations: (id: string, annotations: Annotation[], baseIds?: string[]) => Promise<{ saved: true; items: Annotation[] }>
  saveTranslations: (id: string, targetLanguage: string, entries: Record<string, string>) => Promise<{ saved: true }>
  translate: (input: {
    text: string
    targetLanguage?: string
    sourceLanguage?: string
    provider?: string
  }) => Promise<TranslateValue>
  getSettings: () => Promise<SettingsValue>
  setToken: (token: string) => Promise<{ tokenConfigured: true; tokenPersistent: boolean }>
  clearToken: () => Promise<{ tokenConfigured: false; tokenPersistent: boolean }>
  updatePreferences: (patch: Partial<Preferences>) => Promise<{ preferences: Preferences }>
  aiStatus: () => Promise<AiStatus>
  chatHistory: (documentId: string) => Promise<{ messages: ChatMessage[] }>
  chatClear: (documentId: string) => Promise<{ cleared: true }>
  chatFrames: (request: ChatRequest, signal: AbortSignal) => AsyncGenerator<ChatFrame>
  deepReadRecord: (documentId: string) => Promise<{ record: DeepReadRecord | null }>
  deepReadFrames: (request: DeepReadRequest, signal: AbortSignal) => AsyncGenerator<DeepReadFrame>
  graphBuildFrames: (request: { documentId: string; force?: boolean }, signal: AbortSignal) => AsyncGenerator<GraphBuildFrame>
  libraryGraphBuildFrames: (signal: AbortSignal) => AsyncGenerator<LibraryGraphFrame>
  docGraph: (documentId: string) => Promise<{ graph: KnowledgeGraph }>
  updateDocGraph: (documentId: string, patch: GraphPatch) => Promise<{ graph: KnowledgeGraph }>
  libraryGraph: () => Promise<{ graph: KnowledgeGraph }>
  askDocument: (input: {
    documentId: string
    question: string
    focusBlockKey?: string
  }) => Promise<{
    documentId: string
    title: string
    answer: string
    citations: Citation[]
    unverified: Citation[]
    followups: string[]
    annotationIds: string[]
    graph: KnowledgeDelta | null
    model: ModelRoute | null
    messageId: string
  }>
  searchDocuments: (input: {
    query: string
    scope?: string
    documentId?: string
    limit?: number
  }) => Promise<SearchResult>
  documentModel: (documentId: string) => Promise<DocumentModel>
  blockTexts: (documentId: string, blockKeys: string[]) => Promise<BlockText[]>
  toolList: () => Promise<{ documents: ToolDocumentRow[] }>
  toolGet: (id: string) => Promise<{
    document: DocumentMeta
    annotations: Annotation[]
    translations: TranslationEnvelope
  }>
  toolRead: (id: string, input: { offset?: number; maxChars?: number }) => Promise<{
    documentId: string
    title: string
    offset: number
    markdown: string
    nextOffset: number | null
    totalChars: number
    truncated: boolean
  }>
  toolAnnotations: (id: string) => Promise<{ documentId: string; annotations: Annotation[] }>
  toolAnnotate: (id: string, annotation: {
    /** Optional: a quote-only annotation is located by the Host quote locator. */
    blockKey?: string
    start?: number
    end?: number
    quote?: string
    color?: string
    aspect?: string
    note?: string
  }) => Promise<{ annotation: Annotation; created: boolean }>
  toolUnannotate: (id: string, annotationId: string) => Promise<{ removed: boolean }>
}

// ---------------------------------------------------------------------------
// Parsing-option normalizer (owned by the parse module, consumed by service)
// ---------------------------------------------------------------------------

/** Resolve the effective engine + API parameters for one parse request. */
export type NormalizeParseOptions = (
  options: ParseOptions | undefined,
  meta: DocumentMeta,
  context: ParseOptionContext,
) => ParsePlan

/** Map a MinerU/AI failure to a human-facing message (never leaks the token). */
export type DescribeMineruError = (error: unknown) => string

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

/** Dependencies every module factory shares. */
export interface ModuleContext {
  config: ResolvedConfig
  logger: Logger
}

/** The Host plugin context with the services this plugin consumes. */
export interface HostServices {
  webServer: WebServerService
  connection: ConnectionService
  tools?: ToolsService
}

/** Model version helpers shared with the UI options. */
export type MineruModelVersion = ModelVersion
