/**
 * Shared data model for the dsh-litnotes plugin.
 *
 * These types describe the on-disk JSON contract (`meta.json`, `annotations.json`,
 * `translations.json`, `chat.json`, `graph.json`, `library-graph.json`,
 * `preferences.json`) and the JSON values that cross the Host/Client wire.
 * They are deliberately dependency-free and environment-neutral.
 */

import type {
  AnnotationColor,
  Aspect,
  GraphEdgeType,
  GraphNodeType,
  LocalProvider,
  ModelVersion,
  ParseEngine,
  ReadingMode,
} from './constants.ts'

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentStatus = 'uploaded' | 'parsing' | 'parsed' | 'failed'

/** Remote task states surfaced by the two MinerU APIs. */
export type RemoteParseState = 'waiting-file' | 'uploading' | 'pending' | 'running' | 'converting' | null

/** Local parse phase while the Host extracts text on-device. */
export type ParsePhase = 'extracting' | 'submitting' | 'uploading' | 'polling'

/** Page progress of an in-flight parse (`null` until at least one page is known). */
export interface ParseProgress {
  extracted: number
  total: number
}

/** Stats recorded by a local (T0/T0.5) parse. */
export interface LocalParseStats {
  pageCount: number
  textChars: number
  extractMs: number
  toolVersion: string
  provider: string
  warnings: string[]
}

/** `meta.parse` — everything known about the current/last parse attempt. */
export interface ParseState {
  engine: ParseEngine | null
  provider: LocalProvider | string | null
  modelVersion: ModelVersion | null
  language: string | null
  options: ParseOptions | null
  phase: ParsePhase | null
  remoteState: RemoteParseState
  taskId: string | null
  batchId: string | null
  startedAt: string | null
  finishedAt: string | null
  pages: number | null
  progress: ParseProgress | null
  hasContentList: boolean
  local: LocalParseStats | null
  /** Page-scoped repair state persisted while a repair runs (1.0.0 format). */
  repairPages?: number[] | null
  repairRestore?: Record<string, unknown> | null
  repairPreviousPages?: number | null
  repairError?: string | null
  /** Terminal outcome of the last page-scoped repair. */
  repair?: { pages: number[]; failedPages: number[] } | null
}

/** Options of a `parse.start` request: fresh parse options or a page-scoped repair. */
export interface ParseStartOptions extends ParseOptions {
  /** Page-scoped repair: merge the repaired pages into the existing parse. */
  merge?: true
  /** 1-based pages to repair (0-based page indices are the content-list convention; the Host normalizes). */
  pages?: number[]
}

/** Optional parameters of a parse request. */
export interface ParseOptions {
  engine?: ParseEngine
  localProvider?: LocalProvider
  modelVersion?: ModelVersion
  language?: string
  isOcr?: boolean
  enableFormula?: boolean
  enableTable?: boolean
  pageRanges?: string
  extraFormats?: string[]
}

/** Document metadata persisted as `documents/<id>/meta.json`. */
export interface DocumentMeta {
  schemaVersion: 1
  id: string
  title: string
  originalName: string
  ext: string
  mime: string
  size: number
  sha256: string
  createdAt: string
  updatedAt: string
  status: DocumentStatus
  error: string | null
  /** `null` until the first parse starts (frozen 1.0.0 on-disk shape). */
  parse: ParseState | null
}

/** Trimmed parse row returned by `library.list` (frozen 1.0.0 wire shape). */
export interface DocumentSummaryParse {
  engine: ParseEngine | null
  provider: string | null
  local: LocalParseStats | null
  modelVersion: ModelVersion | null
  language: string | null
  phase: ParsePhase | null
  remoteState: RemoteParseState
  /** Convenience mirror of `parse.options.isOcr` for list rows. */
  ocr: boolean
  pages: number | null
  progress: ParseProgress | null
  hasContentList: boolean
  startedAt: string | null
  finishedAt: string | null
}

/** A library-list row: meta without the source hash and with the trimmed parse row. */
export interface DocumentSummary {
  schemaVersion: 1
  id: string
  title: string
  originalName: string
  ext: string
  mime: string
  size: number
  createdAt: string
  updatedAt: string
  status: DocumentStatus
  error: string | null
  parse: DocumentSummaryParse | null
  wordCount?: number | null
  pageCount?: number | null
}

/** `document.markdown` payload: the parsed document model source. */
export interface ParsedDocument {
  markdown: string
  contentList: ContentListEntry[] | null
  pages: number | null
}

/** MinerU content-list entry (cloud standard parses and local synthesis). */
export interface ContentListEntry {
  page_idx?: number
  type?: string
  text?: string
  text_level?: number
  img_path?: string
  image_path?: string
  table_body?: string
  table_caption?: string[]
  table_footnote?: string[]
  img_caption?: string[]
  img_footnote?: string[]
  latex?: string
  bbox?: number[]
  url?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Annotations & translations
// ---------------------------------------------------------------------------

/** One highlight/annotation on a document block. */
export interface Annotation {
  id: string
  /** Stable block anchor (`b<index>:<hash>`); empty for whole-document notes. */
  blockKey: string
  /** Offsets into the block plain text. */
  start: number
  end: number
  /** Verbatim quoted text the annotation was created from. */
  quote: string
  color: AnnotationColor
  aspect?: Aspect
  note?: string
  /** Who created it; `ai` annotations carry provenance. */
  origin?: 'user' | 'ai'
  chatId?: string
  messageId?: string
  /** Model provenance recorded for AI annotations (1.0.0 on-disk shape). */
  model?: { provider: string; model: string }
  createdAt?: string
  updatedAt?: string
  /** Re-anchoring outcome after a reparse. */
  stale?: boolean
  staleReason?: string
  reanchored?: boolean
}

/** `annotations.json` */
export interface AnnotationEnvelope {
  version: 1
  items: Annotation[]
}

/** `translations.json` */
export interface TranslationEnvelope {
  version: 1
  targetLanguage: string
  entries: Record<string, string>
  providers?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Preferences & capabilities
// ---------------------------------------------------------------------------

/** Client-owned preferences, persisted host-side in `preferences.json`. */
export interface Preferences {
  targetLanguage: string
  translationProvider: string
  readingMode: ReadingMode
  readingScale: number
  showPageMarks: boolean
  defaultEngine: ParseEngine
  autoAllowAgentFallback: boolean
  defaultModelVersion: ModelVersion
  defaultLanguage: string
  defaultIsOcr: boolean
  defaultEnableFormula: boolean
  defaultEnableTable: boolean
  /* View state (host-persisted so a reload returns to the same place). */
  aiPanelOpen: boolean
  libraryView: 'library' | 'graph'
  docView: 'read' | 'graph'
  graphAutoBuild: boolean
  /** Show the quiet "unsupported citation" notice row in AI answers. */
  entailmentNotice: boolean
  notesFilter: 'all' | 'ai' | 'user'
  lastDocumentId: string | null
  lastBlockKey: string | null
  readingMeasure: number
  docWidth: number
  railWidth: number
  marginWidth: number
  railOpen: boolean
  marginOpen: boolean
}

/** Local parse engine capabilities (Host → Client). */
export interface LocalCapabilities {
  enabled: boolean
  available: boolean
  /** Recommended provider id when local parsing is possible, else `null`. */
  recommended: string | null
  providers: Array<{ id: string; available: boolean; version: string | null; reason?: string }>
  capabilities: { textLayerPdf: boolean; office: boolean; images: boolean; html: boolean }
}

/** One resolved model route reported by the Host. */
export interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Grounded-AI availability snapshot. */
export interface AiStatus {
  available: boolean
  graph: boolean
  route: ModelRoute | null
  retriever: boolean
  reason?: string
}

/** `status` payload. */
export interface StatusValue {
  hostVersion: string
  version: string
  dataDirDisplay: string
  tokenConfigured: boolean
  tokenPersistent: boolean
  translatorAvailable: boolean
  modelAvailable: boolean
  counts: { total: number; parsed: number; parsing: number; failed: number }
  preferences: Preferences
  local: LocalCapabilities | null
  ai: AiStatus
}

/** `settings.get` payload. */
export interface SettingsValue {
  tokenConfigured: boolean
  tokenPersistent: boolean
  preferences: Preferences
  providers: Array<{ id: string; label: string }>
  defaults: {
    engine: ParseEngine
    modelVersion: ModelVersion
    language: string
    targetLanguage: string
    translationProvider: string
    autoAllowAgentFallback: boolean
    localProvider: LocalProvider
  }
  local: LocalCapabilities | null
}

/** `translate` payload. */
export interface TranslateValue {
  translation: string
  provider: string
  targetLanguage: string
  /** Model id when the translation came from the LLM fallback. */
  model?: string
}

// ---------------------------------------------------------------------------
// AI conversation
// ---------------------------------------------------------------------------

/** A citation in an AI answer. */
export interface Citation {
  index: number
  blockKey: string
  quote: string
  /** Character offsets into the block plain text (Host-computed; absent while unverified). */
  start?: number
  end?: number
  /** Page number when the citation is anchored (absent while unverified). */
  page?: number | null
  aspect: Aspect
  note: string
  verified: boolean
  /** Why the citation is unverified when `verified` is false. */
  reason?: string
  /** Entailment verdict of the quote-vs-claim check. */
  entailment?: 'supported' | 'partial' | 'unsupported' | 'unchecked'
  /** One-line reason of that verdict (persisted for unverified/partial citations). */
  entailmentReason?: string
}

/** Citation/claim entailment summary for one answer. */
export interface EntailmentSummary {
  checked: boolean
  supported: number
  partial: number
  unsupported: number
}

/** Knowledge delta extracted from one answer. */
export interface KnowledgeDelta {
  nodes?: GraphNodeInput[]
  edges?: GraphEdgeInput[]
}

/** A persisted conversation message (user question or assistant answer). */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** Assistant messages keep the question that produced them. */
  question?: string
  answer?: string
  citations: Citation[]
  unverified: Citation[]
  followups?: string[]
  model?: { provider: string; model: string }
  usage?: { inputTokens?: number; outputTokens?: number }
  annotationIds?: string[]
  knowledge?: { nodeIds: string[]; edgeIds: string[] }
  entailment?: EntailmentSummary
  /** Prompt contract version that produced the answer (1.0.0 chat.json field). */
  promptVersion?: number
  createdAt: string
}

/** `chat.history` payload. */
export interface ChatHistoryValue {
  messages: ChatMessage[]
}

// ---------------------------------------------------------------------------
// Knowledge graph
// ---------------------------------------------------------------------------

export type GraphSource = 'ai-summary' | 'qa' | 'user' | 'aggregate'

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  summary: string
  blockKeys: string[]
  documentIds?: string[]
  aspect?: Aspect
  source: GraphSource
  weight: number
  curated?: boolean
  pinned?: boolean
  position?: { x: number; y: number } | null
  createdAt?: string
  updatedAt?: string
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  type: GraphEdgeType
  label?: string
  source: GraphSource
  weight: number
}

/** Node upsert used by AI deltas and user curation. */
export interface GraphNodeInput {
  id?: string
  type?: GraphNodeType
  label: string
  summary?: string
  blockKeys?: string[]
  aspect?: Aspect
  weight?: number
  pinned?: boolean
  position?: { x: number; y: number } | null
}

/** Edge upsert used by AI deltas and user curation. */
export interface GraphEdgeInput {
  id?: string
  from: string
  to: string
  type?: GraphEdgeType
  label?: string
  weight?: number
}

export interface KnowledgeGraph {
  version: 1
  scope: 'document' | 'library'
  documentId?: string
  /** `null` for a never-built placeholder graph (frozen on-disk shape). */
  generatedAt: string | null
  model?: { provider: string; model: string } | null
  overview: string
  tldr?: string
  glossary?: Array<{ term: string; definition: string; blockKeys: string[] }>
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Library scope only: deterministic topic clusters computed at aggregation. */
  clusters?: GraphCluster[]
  stats: { nodes: number; edges: number; builtAtSeq?: number | null }
}

/** One library-graph cluster (runtime field on library `graph` values). */
export interface GraphCluster {
  id: string
  label: string
  nodeIds: string[]
  size: number
  weight: number
}

/** `graph.update` patch (document scope curation). */
export interface GraphPatch {
  nodes?: Array<{
    /** Omitted when the patch creates a node; set when updating one. */
    id?: string
    label?: string
    summary?: string
    aspect?: Aspect
    weight?: number
    pinned?: boolean
    position?: { x: number; y: number } | null
    type?: GraphNodeType
  }>
  edges?: GraphEdgeInput[]
  merge?: Array<{ from: string; to: string }>
}

// ---------------------------------------------------------------------------
// Streaming frames
// ---------------------------------------------------------------------------

export type ChatFrame =
  | { type: 'start'; messageId: string; model: { provider: string; model: string } }
  | { type: 'delta'; text: string }
  | { type: 'phase'; phase: 'entailment' }
  | {
      type: 'answer'
      messageId: string
      markdown: string
      citations: Citation[]
      unverified: Citation[]
      followups: string[]
      annotationIds: string[]
      entailment: EntailmentSummary
    }
  | { type: 'graph'; delta: KnowledgeDelta }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string }

export type GraphBuildFrame =
  | { type: 'progress'; phase: 'reading' | 'extracting' | 'merging' | 'done'; done: number; total: number; chunk: number }
  | { type: 'graph'; graph: KnowledgeGraph }
  | { type: 'error'; code: string; message: string }

export type LibraryGraphFrame =
  | { type: 'progress'; phase: string; done: number; total: number }
  | { type: 'graph'; graph: KnowledgeGraph }
  | { type: 'error'; code: string; message: string }

/** `chat` streaming request. */
export interface ChatRequest {
  documentId: string
  question: string
  focus?: { blockKey?: string; selectionQuote?: string }
  mode?: 'doc'
  regenerateOf?: string
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticEntry {
  at: string
  clientVersion?: string
  event: string
  detail?: unknown
}
