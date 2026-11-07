/**
 * Knowledge-graph engine for dsh-litnotes (`docs/AI-SPEC.md` §2, §3, §5).
 *
 * Two scopes share one KG shape:
 *
 * - **document** (`documents/<docId>/graph.json`): the model reads the parsed
 *   markdown in section-aware chunks (~3500 chars), extracts nodes/edges per
 *   chunk, and the host normalizes, merges by normalized label + type and caps
 *   the result (120 nodes / 400 edges). A final lightweight call writes the
 *   overview / TL;DR / glossary; every failure degrades to a deterministic
 *   summary instead of breaking the graph.
 * - **library** (`library-graph.json`): fully deterministic aggregation of the
 *   per-document graphs. Parsed documents become `paper` nodes, document
 *   knowledge nodes are merged into `topic` nodes by normalized label, and the
 *   graph gets `paper -mentions-> topic` edges, weighted topic relations
 *   propagated from the real document graphs, paper↔paper `shares` edges,
 *   connected-component clusters and a deterministic overview. One optional LLM
 *   call may polish that overview.
 *
 * Design rules honoured here:
 * - the LLM gateway is injected (`completeText` / `streamText`) — this module
 *   never talks to the Host `llm` service directly;
 * - all persistence goes through the injected store aux API
 *   (`readAux`/`writeAux`/`readLibraryAux`/`writeLibraryAux`);
 * - malformed model JSON skips the chunk and continues; cancellation is
 *   checked between every await and forwarded to the model;
 * - ids are stable across merges (existing id wins) and library ids are
 *   content-derived so rebuilding does not reshuffle the graph;
 * - user curation (`graph.update`) never loses data: patched nodes are marked
 *   `curated` and survive a forced rebuild.
 *
 * @module host/ai/graph
 */

import { createHash, randomUUID } from 'node:crypto'
import { isAspect } from './aspects.ts'
import {
  GRAPH_EXTRACTION_SYSTEM,
  GRAPH_FENCE_TAG,
  GRAPH_SUMMARY_PROMPT,
  LIBRARY_CONSOLIDATION_PROMPT,
  SUMMARY_FENCE_TAG,
  graphExtractionPrompt,
  graphSummaryUserPrompt,
  libraryConsolidationUserPrompt,
} from './prompts.ts'
import { parseMarkdown as parsePaperMarkdown } from '../../shared/markdown/parse.ts'
import { plainTextOfBlock as plainTextOfPaperBlock } from '../../shared/markdown/model.ts'
import type { Block, BlockBase } from '../../shared/markdown/model.ts'
import type { Aspect, GraphEdgeType, GraphNodeType } from '../../shared/constants.ts'
import type {
  AnnotationEnvelope,
  DocumentMeta,
  GraphBuildFrame,
  GraphEdge,
  GraphNode,
  GraphPatch,
  KnowledgeGraph,
  LibraryGraphFrame,
  ParsedDocument,
} from '../../shared/model.ts'
import type { AiConfig, DocumentAuxName, GraphServiceApi, LibraryAuxName } from '../contracts.ts'
import type { Logger } from '../host-services.ts'
import type { LlmCompleteRequest, LlmStreamRequest } from './llm.ts'

/** Per-document aux file name (`docs/AI-SPEC.md` §2). */
const GRAPH_FILE: DocumentAuxName = 'graph.json'
/** Library-level aux file name. */
const LIBRARY_GRAPH_FILE: LibraryAuxName = 'library-graph.json'

/** Target characters per extraction chunk (section groups). */
const CHUNK_TARGET_CHARS = 3500
/** Cap on document-graph nodes / edges. */
const DOC_MAX_NODES = 120
const DOC_MAX_EDGES = 400
/** Cap on library-graph nodes / edges. */
const LIB_MAX_NODES = 600
const LIB_MAX_EDGES = 2000
/** Library graph curation: representative topics only, not a full union. */
const LIB_MAX_TOPICS = 28
/** How many topics one paper may contribute before the importance cut. */
const LIB_PER_DOC_TOP = 10
/** Relative value of each doc-node type when ranking representative topics. */
const LIB_TOPIC_TYPE_VALUE: Readonly<Record<string, number>> = {
  method: 2,
  finding: 1.8,
  limitation: 1.8,
  definition: 1.2,
  concept: 1,
  insight: 0.8,
}
/** Per-node / per-edge text caps from the model-output contract. */
const MAX_LABEL_CHARS = 80
const MAX_SUMMARY_CHARS = 600
const MAX_EDGE_LABEL_CHARS = 160
const MAX_BLOCK_KEYS = 30
const MAX_NODE_WEIGHT = 5
/**
 * World-pixel bound for a manually pinned node position: the client canvas is
 * unbounded, so positions may be negative and far outside the seeded layout
 * sheet; ±100000 is a finite persistence ceiling.
 */
const MAX_NODE_POSITION = 100000
/** How many merge pairs one `updateDocGraph` call accepts (defensive bound). */
const MAX_NODE_MERGES = 100
/** Summary / glossary bounds. */
const MAX_TLDR_ITEMS = 5
const MAX_GLOSSARY_ITEMS = 40
const MAX_OUTLINE_HEADINGS = 60
const MAX_OUTLINE_CHARS = 3000

/** Fence tags (`docs/AI-SPEC.md` §5). */
const GRAPH_FENCE = GRAPH_FENCE_TAG
const SUMMARY_FENCE = SUMMARY_FENCE_TAG

/** Node types allowed in a document graph. */
const DOC_NODE_TYPES: ReadonlySet<string> = new Set([
  'concept',
  'method',
  'finding',
  'definition',
  'limitation',
  'section',
  'question',
  'insight',
])
/** Node types allowed in the library graph. */
const LIBRARY_NODE_TYPES: ReadonlySet<string> = new Set(['paper', 'topic'])
/** Edge types allowed by the KG contract. */
const EDGE_TYPES: ReadonlySet<string> = new Set([
  'defines',
  'uses',
  'supports',
  'contradicts',
  'part_of',
  'leads_to',
  'evolves_from',
  'relates',
  'answers',
  'mentions',
  // library graph: two papers sharing representative concepts
  'shares',
])
/** Provenance sources. */
const SOURCES: ReadonlySet<string> = new Set(['ai-summary', 'qa', 'user', 'aggregate'])
/** Document node types that become library topics (headings/questions are noise there). */
const TOPIC_TYPES: ReadonlySet<string> = new Set(['concept', 'method', 'finding', 'definition', 'limitation', 'insight'])

/** One glossary entry of the KG shape. */
interface GlossaryEntry {
  term: string
  definition: string
  blockKeys: string[]
}

/** One library-graph cluster (connected component of the topic relation graph). */
interface GraphCluster {
  id: string
  label: string
  nodeIds: string[]
  size: number
  weight: number
}

/** A normalized graph written to disk / emitted in a frame. */
interface GraphState {
  version: 1
  scope: 'document' | 'library'
  documentId?: string
  generatedAt: string | null
  model: { provider: string; model: string } | null
  overview: string
  tldr: string
  glossary: GlossaryEntry[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  clusters?: GraphCluster[]
  stats: { nodes: number; edges: number; builtAtSeq: number | null }
}

/** A sanitized node candidate; the id is null until the merge assigns one. */
type SanitizedNode = Omit<GraphNode, 'id'> & { id: string | null }
/** A sanitized edge candidate; the id may be supplied by the model/user. */
type SanitizedEdge = Omit<GraphEdge, 'id'> & { id?: string }

/** Options of {@link sanitizeNode}. */
interface SanitizeNodeOptions {
  allowedTypes?: ReadonlySet<string> | undefined
  fallbackType?: GraphNodeType | undefined
  defaultSource?: GraphNode['source'] | undefined
  knownBlockKeys?: ReadonlySet<string> | undefined
  keepId?: boolean | undefined
}

/** Options of {@link sanitizeEdge}. */
interface SanitizeEdgeOptions {
  defaultSource?: GraphEdge['source'] | undefined
  keepId?: boolean | undefined
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Whether a value is a plain non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Clamp a finite integer into range, returning `fallback` for invalid input. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Clamp a finite number into range, returning `fallback` for invalid input. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Trim, collapse whitespace and cap a model/user supplied string. */
function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text
}

/** Clean a node label: collapsed whitespace, max 80 chars, non-empty. */
function cleanLabel(value: unknown): string {
  return boundedText(value, MAX_LABEL_CHARS)
}

/**
 * Normalize a label for merge/dedupe: NFKC, case-folded, punctuation stripped,
 * whitespace collapsed. Keeps CJK characters (no word segmentation needed).
 */
function normalizeLabel(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Merge key for document nodes: normalized label + exact type. */
function nodeKey(node: { type: string; label: string }): string {
  return `${node.type}|${normalizeLabel(node.label)}`
}

/** Current ISO timestamp. */
function nowIso(): string {
  return new Date().toISOString()
}

/** Keep a plausible stored ISO string, otherwise use now. */
function isoOrNow(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : nowIso()
}

/** Deterministic short id fragment for content-derived library ids. */
function hashId(text: string): string {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 12)
}

/** New random graph node id. */
function newNodeId(): string {
  return `n-${randomUUID()}`
}

/** Deterministic edge id from its canonical endpoints + type. */
function makeEdgeId(from: string, to: string, type: string): string {
  return `e-${hashId(`${from}|${to}|${type}`)}`
}

/** Deterministic library paper node id. */
function paperNodeId(documentId: string): string {
  return `n-paper-${hashId(documentId)}`
}

/** Deterministic library topic node id. */
function topicNodeId(normalizedLabelValue: string): string {
  return `n-topic-${hashId(normalizedLabelValue)}`
}

/** Whether a value looks like a graph node id. */
function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^n-[A-Za-z0-9_-]{1,120}$/.test(value.trim())
}

/** Whether a value looks like a graph edge id. */
function isEdgeId(value: unknown): value is string {
  return typeof value === 'string' && /^e-[A-Za-z0-9_-]{1,120}$/.test(value.trim())
}

/** Whether an AbortSignal is aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/** Whether an error represents cancellation. */
function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (isAborted(signal)) return true
  if (error === null || typeof error !== 'object') return false
  const name = 'name' in error && typeof error.name === 'string' ? error.name : ''
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  return name === 'AbortError' || code === 'ABORT_ERR' || code === 'aborted'
}

/** Safely log through the injected logger (never throws, never leaks prompts). */
function logWarn(logger: Logger | undefined, message: string, detail: unknown): void {
  try {
    if (typeof logger?.warn === 'function') logger.warn(`[dsh-litnotes] graph: ${message}`, detail)
  } catch {
    /* logging must never break the graph build */
  }
}

/** Resolved graph-related `ai` config with the documented defaults. */
interface GraphConfig {
  maxGraphChunks: number
  maxGraphSourceChars: number
  graphMaxTokens: number
  graphSummaryChars: number
}

/** Normalize the `ai` config block with the documented defaults. */
function resolveGraphConfig(config: { ai?: Partial<AiConfig> | undefined } | undefined): GraphConfig {
  const ai = isObject(config?.ai) ? config.ai : {}
  return {
    maxGraphChunks: clampInt(ai.maxGraphChunks, 1, 40, 12),
    maxGraphSourceChars: clampInt(ai.maxGraphSourceChars, 1000, 1000000, 160000),
    graphMaxTokens: clampInt(ai.graphMaxTokens, 128, 8192, 3000),
    graphSummaryChars: clampInt(ai.graphSummaryChars, 256, 64000, 4000),
  }
}

/* -------------------------------------------------------------------------- */
/* KG shape helpers                                                           */
/* -------------------------------------------------------------------------- */

/** An empty document-scope KG. */
function emptyDocumentGraph(documentId: string): GraphState {
  return {
    version: 1,
    scope: 'document',
    documentId,
    generatedAt: null,
    model: null,
    overview: '',
    tldr: '',
    glossary: [],
    nodes: [],
    edges: [],
    stats: { nodes: 0, edges: 0, builtAtSeq: null },
  }
}

/** An empty library-scope KG. */
function emptyLibraryGraph(): GraphState {
  return {
    version: 1,
    scope: 'library',
    generatedAt: null,
    model: null,
    overview: '',
    tldr: '',
    glossary: [],
    nodes: [],
    edges: [],
    clusters: [],
    stats: { nodes: 0, edges: 0, builtAtSeq: null },
  }
}

/**
 * Present an internal graph as the frozen `KnowledgeGraph` wire shape.
 *
 * The frozen on-disk format allows `generatedAt: null` (never built) and
 * `model: null` (no model route), which the shared model types model as
 * optionals; this boundary cast keeps the runtime format byte-compatible with
 * 1.0.0 without duplicating the type in the shared model.
 */
function toKnowledgeGraph(graph: GraphState): KnowledgeGraph {
  return graph as unknown as KnowledgeGraph
}

/** Sanitize a stored/generated `model` field. */
function sanitizeModel(raw: unknown): { provider: string; model: string } | null {
  if (!isObject(raw)) return null
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider, model }
}

/** Sanitize block keys, optionally restricted to the keys present in one chunk. */
function sanitizeBlockKeys(raw: unknown, knownBlockKeys?: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const key = value.trim()
    if (key === '' || key.length > 120 || seen.has(key)) continue
    if (knownBlockKeys !== undefined && !knownBlockKeys.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_BLOCK_KEYS) break
  }
  return out
}

/** Sanitize a node weight (default 1, bounded). */
function sanitizeWeight(value: unknown): number {
  return clampNumber(value, 0.1, 1000, 1)
}

/** Round one canvas user-space coordinate to 0.1 precision. */
function roundTenth(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Sanitize a manually pinned node position: finite numbers only, clamped into
 * `[-MAX_NODE_POSITION, MAX_NODE_POSITION]` on both axes and rounded to 0.1
 * (the layout's precision). Anything else is dropped rather than persisted.
 *
 * @param raw - candidate `{ x, y }`.
 * @returns the sanitized position or `null`.
 */
function sanitizePosition(raw: unknown): { x: number; y: number } | null {
  if (!isObject(raw)) return null
  const x = clampNumber(raw.x, -MAX_NODE_POSITION, MAX_NODE_POSITION, NaN)
  const y = clampNumber(raw.y, -MAX_NODE_POSITION, MAX_NODE_POSITION, NaN)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: roundTenth(x), y: roundTenth(y) }
}

/** Sanitize a node from model output or from disk. */
function sanitizeNode(raw: unknown, options: SanitizeNodeOptions = {}): SanitizedNode | null {
  if (!isObject(raw)) return null
  const label = cleanLabel(raw.label)
  if (label === '') return null
  const allowedTypes = options.allowedTypes ?? DOC_NODE_TYPES
  const fallbackType = options.fallbackType ?? 'concept'
  const rawType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  const type = (allowedTypes.has(rawType) ? rawType : fallbackType) as GraphNodeType
  const rawSource = typeof raw.source === 'string' ? raw.source : ''
  const source = (SOURCES.has(rawSource) ? rawSource : (options.defaultSource ?? 'ai-summary')) as GraphNode['source']
  const node: SanitizedNode = {
    id: options.keepId !== false && isNodeId(raw.id) ? raw.id.trim() : null,
    type,
    label,
    summary: boundedText(raw.summary, MAX_SUMMARY_CHARS),
    blockKeys: sanitizeBlockKeys(raw.blockKeys, options.knownBlockKeys),
    source,
    weight: sanitizeWeight(raw.weight),
    createdAt: isoOrNow(raw.createdAt),
    updatedAt: isoOrNow(raw.updatedAt),
  }
  const documentIds = Array.isArray(raw.documentIds)
    ? [...new Set(raw.documentIds.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))].slice(0, 50)
    : []
  if (documentIds.length > 0) node.documentIds = documentIds
  if (typeof raw.aspect === 'string' && isAspect(raw.aspect)) node.aspect = raw.aspect
  // Curation provenance: user-edited AI nodes are marked `curated`; manually
  // pinned nodes keep their canvas position across rebuilds.
  if (raw.curated === true) node.curated = true
  if (raw.pinned === true) node.pinned = true
  const position = sanitizePosition(raw.position)
  if (position !== null) node.position = position
  return node
}

/** Sanitize an edge from model output or from disk. */
function sanitizeEdge(raw: unknown, options: SanitizeEdgeOptions = {}): SanitizedEdge | null {
  if (!isObject(raw)) return null
  const from = typeof raw.from === 'string' ? raw.from.trim() : ''
  const to = typeof raw.to === 'string' ? raw.to.trim() : ''
  if (from === '' || to === '') return null
  const rawType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  const type = (EDGE_TYPES.has(rawType) ? rawType : 'relates') as GraphEdgeType
  const rawSource = typeof raw.source === 'string' ? raw.source : ''
  const edge: SanitizedEdge = {
    from,
    to,
    type,
    source: (SOURCES.has(rawSource) ? rawSource : (options.defaultSource ?? 'ai-summary')) as GraphEdge['source'],
    weight: clampNumber(raw.weight, 0.1, 10000, 1),
  }
  if (options.keepId !== false && isEdgeId(raw.id)) edge.id = raw.id.trim()
  const label = boundedText(raw.label, MAX_EDGE_LABEL_CHARS)
  if (label !== '') edge.label = label
  return edge
}

/** Attach an id to a sanitized node candidate. */
function withNodeId(node: SanitizedNode, id?: string): GraphNode {
  return { ...node, id: id ?? node.id ?? newNodeId() }
}

/** Sort nodes by importance then label (stable, used for summaries). */
function rankNodes(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort(
    (left, right) => (right.weight ?? 1) - (left.weight ?? 1) || String(left.label).localeCompare(String(right.label)),
  )
}

/** Recompute `stats` after any mutation. */
function refreshStats(graph: GraphState): void {
  graph.stats = {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    builtAtSeq: graph.stats?.builtAtSeq ?? null,
  }
}

/**
 * Enforce a node/edge cap: keep the highest-weight nodes (ties keep insertion
 * order), then drop dangling edges and keep the highest-weight edges. Curated
 * nodes outrank weight so a forced rebuild can never silently drop a user edit.
 */
function capGraph(graph: GraphState, maxNodes: number, maxEdges: number): GraphState {
  if (graph.nodes.length > maxNodes) {
    const ranked = graph.nodes.map((node, index) => ({ node, index }))
    ranked.sort((left, right) => {
      const curated = Number(right.node.curated === true) - Number(left.node.curated === true)
      if (curated !== 0) return curated
      return (right.node.weight ?? 1) - (left.node.weight ?? 1) || left.index - right.index
    })
    const keep = new Set(ranked.slice(0, maxNodes).map((entry) => entry.node.id))
    graph.nodes = graph.nodes.filter((node) => keep.has(node.id))
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  let edges = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  if (edges.length > maxEdges) {
    const ranked = edges.map((edge, index) => ({ edge, index }))
    ranked.sort((left, right) => (right.edge.weight ?? 1) - (left.edge.weight ?? 1) || left.index - right.index)
    const keep = new Set(ranked.slice(0, maxEdges).map((entry) => entry.edge.id))
    edges = edges.filter((edge) => keep.has(edge.id))
  }
  graph.edges = edges
  refreshStats(graph)
  return graph
}

/** Sanitize a glossary array (bounded, block-key validated against `knownKeys`). */
function sanitizeGlossary(raw: unknown, knownKeys?: ReadonlySet<string>): GlossaryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: GlossaryEntry[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const term = cleanLabel(item.term)
    const definition = boundedText(item.definition, MAX_SUMMARY_CHARS)
    if (term === '' || definition === '') continue
    out.push({ term, definition, blockKeys: sanitizeBlockKeys(item.blockKeys, knownKeys) })
    if (out.length >= MAX_GLOSSARY_ITEMS) break
  }
  return out
}

/** Build a fresh document graph from the persisted aux JSON. */
function normalizeDocumentGraph(raw: unknown, documentId: string): GraphState {
  const graph = emptyDocumentGraph(documentId)
  if (!isObject(raw)) return graph
  graph.generatedAt = typeof raw.generatedAt === 'string' && raw.generatedAt !== '' ? raw.generatedAt : null
  graph.model = sanitizeModel(raw.model)
  graph.overview = typeof raw.overview === 'string' ? raw.overview : ''
  graph.tldr = typeof raw.tldr === 'string' ? raw.tldr : ''
  graph.glossary = sanitizeGlossary(raw.glossary)
  const seenIds = new Set<string>()
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const node = sanitizeNode(item, {
      allowedTypes: DOC_NODE_TYPES,
      fallbackType: 'concept',
      defaultSource: 'ai-summary',
      keepId: true,
    })
    if (node === null) continue
    const id = node.id !== null && !seenIds.has(node.id) ? node.id : newNodeId()
    seenIds.add(id)
    graph.nodes.push(withNodeId(node, id))
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const seenEdges = new Set<string>()
  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    const edge = sanitizeEdge(item, { defaultSource: 'ai-summary', keepId: true })
    if (edge === null || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    const id = edge.id ?? makeEdgeId(edge.from, edge.to, edge.type)
    graph.edges.push({ ...edge, id })
  }
  refreshStats(graph)
  return graph
}

/** Sanitize stored cluster entries against the surviving topic ids. */
function sanitizeClusters(raw: unknown, topicIds: ReadonlySet<string>): GraphCluster[] {
  if (!Array.isArray(raw)) return []
  const out: GraphCluster[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const nodeIds = Array.isArray(item.nodeIds)
      ? [...new Set(item.nodeIds.filter((id): id is string => typeof id === 'string' && topicIds.has(id)))]
      : []
    if (nodeIds.length === 0) continue
    out.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `c-${hashId(nodeIds.join('|'))}`,
      label: cleanLabel(item.label),
      nodeIds,
      size: nodeIds.length,
      weight: clampNumber(item.weight, 0, 1000000, nodeIds.length),
    })
  }
  return out
}

/** Build a fresh library graph from the persisted aux JSON. */
function normalizeLibraryGraph(raw: unknown): GraphState {
  const graph = emptyLibraryGraph()
  if (!isObject(raw)) return graph
  graph.generatedAt = typeof raw.generatedAt === 'string' && raw.generatedAt !== '' ? raw.generatedAt : null
  graph.model = sanitizeModel(raw.model)
  graph.overview = typeof raw.overview === 'string' ? raw.overview : ''
  graph.tldr = typeof raw.tldr === 'string' ? raw.tldr : ''
  graph.glossary = sanitizeGlossary(raw.glossary)
  const seenIds = new Set<string>()
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const node = sanitizeNode(item, {
      allowedTypes: LIBRARY_NODE_TYPES,
      fallbackType: 'topic',
      defaultSource: 'aggregate',
      keepId: true,
    })
    if (node === null) continue
    const id = node.id !== null && !seenIds.has(node.id) ? node.id : newNodeId()
    seenIds.add(id)
    graph.nodes.push(withNodeId(node, id))
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const seenEdges = new Set<string>()
  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    const edge = sanitizeEdge(item, { defaultSource: 'aggregate', keepId: true })
    if (edge === null || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    const id = edge.id ?? makeEdgeId(edge.from, edge.to, edge.type)
    graph.edges.push({ ...edge, id })
  }
  const topicIds = new Set(graph.nodes.filter((node) => node.type === 'topic').map((node) => node.id))
  graph.clusters = sanitizeClusters(raw.clusters, topicIds)
  refreshStats(graph)
  return graph
}

/* -------------------------------------------------------------------------- */
/* Chunking                                                                   */
/* -------------------------------------------------------------------------- */

/** Kept source text is limited to this many chars beyond the cap. */
function limitSource(markdown: string, maxSourceChars: number): string {
  const source = String(markdown ?? '')
  if (source.length <= maxSourceChars) return source
  const head = source.slice(0, maxSourceChars)
  const tail = source.slice(maxSourceChars)
  const headings = extractHeadingText(tail)
  if (headings.length === 0) return head
  const outline = headings.map((heading) => `- ${heading}`).join('\n')
  return `${head}\n\n# Document outline (truncated source)\n\n${outline}`
}

/** Extract de-duplicated ATX headings from the part of a document we did not read. */
function extractHeadingText(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const pattern = /^[ \t]{0,3}(#{1,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm
  let match: RegExpExecArray | null
  let chars = 0
  while ((match = pattern.exec(text)) !== null) {
    if (out.length >= MAX_OUTLINE_HEADINGS) break
    const value = boundedText(match[2], 200)
    if (value === '') continue
    const key = normalizeLabel(value)
    if (key === '' || seen.has(key)) continue
    if (chars + value.length > MAX_OUTLINE_CHARS) break
    seen.add(key)
    out.push(value)
    chars += value.length + 1
  }
  return out
}

/** One heading-scoped document section. */
interface DocumentSection {
  heading: string
  level: number
  blocks: Block[]
}

/**
 * Split a parser model into heading-scoped sections. Each section keeps the
 * heading block plus its content blocks so the chunk prompt carries provenance.
 */
function buildSections(model: { blocks?: readonly Block[] }): DocumentSection[] {
  const blocks = Array.isArray(model.blocks) ? model.blocks : []
  const sections: DocumentSection[] = []
  let current: DocumentSection = { heading: '', level: 0, blocks: [] }
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.kind === 'page' || block.kind === 'rule' || block.kind === 'figure') continue
    const text = plainTextOfPaperBlock(block).trim()
    if (text === '') continue
    if (block.kind === 'heading') {
      if (current.blocks.length > 0) sections.push(current)
      current = { heading: text, level: block.kind === 'heading' ? block.level : 1, blocks: [block] }
      continue
    }
    current.blocks.push(block)
  }
  if (current.blocks.length > 0) sections.push(current)
  return sections
}

/** Render one block as a `[[key]] text` prompt line. */
function blockLine(block: BlockBase): string {
  const text = plainTextOfPaperBlock(block).trim()
  if (text === '') return ''
  const key = typeof block.key === 'string' ? block.key : ''
  return `[[${key}]] ${text}`
}

/** One section-aware extraction chunk. */
interface GraphChunk {
  lines: string[]
  blockKeys: string[]
  headings: string[]
  chars: number
  index: number
  total: number
  section: string
}

/** A blank chunk accumulator. */
function blankChunk(): GraphChunk {
  return { lines: [], blockKeys: [], headings: [], chars: 0, index: 0, total: 0, section: '' }
}

/** Append one rendered block line to a chunk. */
function appendBlock(chunk: GraphChunk, block: BlockBase): boolean {
  const line = blockLine(block)
  if (line === '') return false
  chunk.lines.push(line)
  chunk.chars += line.length + 1
  if (typeof block.key === 'string' && block.key !== '' && !chunk.blockKeys.includes(block.key)) {
    chunk.blockKeys.push(block.key)
  }
  return true
}

/** Add a section's heading label to the chunk's prompt metadata. */
function rememberHeading(chunk: GraphChunk, heading: string): void {
  if (heading === '') return
  if (chunk.headings.length >= 3) return
  if (!chunk.headings.includes(heading)) chunk.headings.push(heading)
}

/** Build a single chunk holding one whole section. */
function chunkSection(section: DocumentSection): GraphChunk {
  const chunk = blankChunk()
  rememberHeading(chunk, section.heading)
  for (const block of section.blocks) appendBlock(chunk, block)
  return chunk
}

/** Split an oversized section at block boundaries, repeating the heading. */
function splitSection(section: DocumentSection): GraphChunk[] {
  const pieces: GraphChunk[] = []
  const first = section.blocks[0]
  const headingBlock = first !== undefined && first.kind === 'heading' ? first : null
  let chunk: GraphChunk | null = null
  for (const block of section.blocks) {
    if (chunk === null) {
      chunk = blankChunk()
      rememberHeading(chunk, section.heading)
    }
    const line = blockLine(block)
    if (line === '') continue
    if (chunk.lines.length > 0 && chunk.chars + line.length + 1 > CHUNK_TARGET_CHARS) {
      pieces.push(chunk)
      chunk = blankChunk()
      rememberHeading(chunk, section.heading)
      if (headingBlock !== null && headingBlock !== block) appendBlock(chunk, headingBlock)
    }
    appendBlock(chunk, block)
  }
  if (chunk !== null && chunk.lines.length > 0) pieces.push(chunk)
  return pieces
}

/** Greedily pack sections into ~3500-char chunks, splitting oversized sections. */
function groupSections(sections: readonly DocumentSection[]): GraphChunk[] {
  const chunks: GraphChunk[] = []
  let current: GraphChunk | null = null
  for (const section of sections) {
    const sectionChunk = chunkSection(section)
    if (sectionChunk.lines.length === 0) continue
    if (sectionChunk.chars > CHUNK_TARGET_CHARS) {
      if (current !== null) {
        chunks.push(current)
        current = null
      }
      for (const piece of splitSection(section)) chunks.push(piece)
      continue
    }
    if (current !== null && current.chars + sectionChunk.chars > CHUNK_TARGET_CHARS) {
      chunks.push(current)
      current = null
    }
    if (current === null) current = blankChunk()
    rememberHeading(current, section.heading)
    for (const block of section.blocks) appendBlock(current, block)
  }
  if (current !== null && current.lines.length > 0) chunks.push(current)
  return chunks
}

/** Pick up to `max` chunks spread evenly across the document (deterministic). */
function pickEvenly(chunks: readonly GraphChunk[], max: number): GraphChunk[] {
  if (chunks.length <= max) return [...chunks]
  const first = chunks[0]
  if (first === undefined) return []
  if (max <= 1) return [first]
  const picked: GraphChunk[] = []
  for (let index = 0; index < max; index += 1) {
    const position = Math.round((index * (chunks.length - 1)) / (max - 1))
    const chunk = chunks[position]
    if (chunk !== undefined && !picked.includes(chunk)) picked.push(chunk)
  }
  return picked
}

/** The chunking result: extraction chunks plus the document outline headings. */
interface ChunkedDocument {
  chunks: GraphChunk[]
  outline: Array<{ key: string; level: number; text: string }>
}

/**
 * Chunk a document: section-aware groups of ~3500 chars, capped by
 * `maxGraphSourceChars` (first N chars + section headings from the rest) and by
 * `maxGraphChunks` (deterministic even sampling, so each model call stays small).
 */
function chunkDocument(markdown: string, config: GraphConfig): ChunkedDocument {
  const source = limitSource(markdown, config.maxGraphSourceChars)
  if (source.trim() === '') return { chunks: [], outline: [] }
  const model = parsePaperMarkdown(source)
  const outline = (Array.isArray(model.outline) ? model.outline : []).slice(0, 60).map((entry) => ({
    key: typeof entry.key === 'string' ? entry.key : '',
    level: Number.isInteger(entry.level) ? (entry.level as number) : 1,
    text: typeof entry.text === 'string' ? entry.text : '',
  }))
  const sections = buildSections(model)
  let chunks = groupSections(sections)
  if (chunks.length === 0) {
    // Defensive fallback: a parseable non-empty document must still be readable.
    const fallback = blankChunk()
    fallback.lines.push(source.slice(0, CHUNK_TARGET_CHARS))
    fallback.chars = fallback.lines[0]?.length ?? 0
    chunks = [fallback]
  }
  chunks = pickEvenly(chunks, config.maxGraphChunks)
  chunks.forEach((chunk, index) => {
    chunk.index = index + 1
    chunk.total = chunks.length
    chunk.section = chunk.headings.join(' · ')
  })
  return { chunks, outline }
}

/* -------------------------------------------------------------------------- */
/* Fenced JSON parsing                                                        */
/* -------------------------------------------------------------------------- */

/** Extract the payload of the first fenced block with `tag` (or any fence). */
function extractFence(text: unknown, tag: string): string {
  const source = typeof text === 'string' ? text : ''
  if (source === '') return ''
  const tagged = new RegExp('```' + tag + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'i').exec(source)
  if (tagged !== null) return tagged[1] ?? ''
  const anyFence = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/.exec(source)
  if (anyFence !== null) return anyFence[1] ?? ''
  return source
}

/** Parse a JSON object out of loose model text; null when nothing parses. */
function parseLooseJson(text: unknown): Record<string, unknown> | null {
  if (isObject(text)) return text
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return null
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  try {
    const parsed: unknown = JSON.parse(source.slice(first, last + 1))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Parsed graph-extraction payload. */
interface GraphExtractionPayload {
  nodes: unknown[]
  edges: unknown[]
}

/** Parse one graph extraction response into `{ nodes, edges }`. */
function parseGraphPayload(text: unknown): GraphExtractionPayload | null {
  const payload = parseLooseJson(extractFence(text, GRAPH_FENCE))
  if (payload === null) return null
  if (!Array.isArray(payload.nodes) && !Array.isArray(payload.edges)) return null
  return {
    nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
    edges: Array.isArray(payload.edges) ? payload.edges : [],
  }
}

/** Convert a model `tldr` value into the KG's markdown-bullet string shape. */
function tldrToString(value: unknown): string {
  if (Array.isArray(value)) {
    const items: string[] = []
    for (const item of value) {
      const text = boundedText(item, 300)
      if (text !== '') items.push(`- ${text}`)
      if (items.length >= MAX_TLDR_ITEMS) break
    }
    return items.join('\n')
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return ''
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const bullets = lines.map((line) => (line.startsWith('-') || line.startsWith('*') ? line : `- ${line}`))
    return bullets.slice(0, MAX_TLDR_ITEMS).join('\n')
  }
  return ''
}

/** Parsed document summary payload. */
interface ParsedSummaryPayload {
  overview: string
  tldr: string
  glossary: GlossaryEntry[]
}

/** Parse one summary response into `{ overview, tldr, glossary }` or null. */
function parseSummaryPayload(text: unknown, knownKeys?: ReadonlySet<string>): ParsedSummaryPayload | null {
  const payload = parseLooseJson(extractFence(text, SUMMARY_FENCE))
  if (payload === null) return null
  const overview = typeof payload.overview === 'string' ? payload.overview.trim() : ''
  const tldr = tldrToString(payload.tldr)
  const glossary = sanitizeGlossary(payload.glossary, knownKeys)
  if (overview === '' && tldr === '' && glossary.length === 0) return null
  return { overview, tldr, glossary }
}

/** Parse the optional library overview polish (Markdown or a summary fence). */
function parseLibraryPolish(text: unknown): { overview: string; tldr: string } | null {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source === '') return null
  if (source.includes('```') || source.startsWith('{')) {
    const payload = parseLooseJson(extractFence(source, SUMMARY_FENCE))
    if (payload !== null) {
      const overview = typeof payload.overview === 'string' ? payload.overview.trim() : ''
      const tldr = tldrToString(payload.tldr)
      if (overview !== '' || tldr !== '') return { overview, tldr }
    }
  }
  // The library consolidation prompt asks for raw Markdown (not JSON).
  const overview = source.length > 8000 ? `${source.slice(0, 8000)}…` : source
  return { overview, tldr: '' }
}

/* -------------------------------------------------------------------------- */
/* Prompt construction                                                        */
/* -------------------------------------------------------------------------- */

/** User prompt for one extraction chunk (centralized in `prompts.ts`). */
function extractionPrompt(chunk: GraphChunk, meta: { title: string }): string {
  return graphExtractionPrompt(
    { lines: chunk.lines },
    { title: meta.title, sectionTitle: chunk.section, index: chunk.index, total: chunk.total },
  )
}

/** User prompt for the document overview / TL;DR / glossary pass. */
function summaryPrompt(graph: GraphState, meta: { title: string; outline: readonly { key: string; level: number; text: string }[] }): string {
  return graphSummaryUserPrompt({
    title: meta.title,
    outline: meta.outline.map((entry) => ({ key: entry.key, level: entry.level, text: entry.text })),
    nodes: graph.nodes.map((node) => ({
      type: node.type,
      label: node.label,
      summary: node.summary,
      blockKeys: node.blockKeys,
    })),
  })
}

/** User prompt for the optional library overview polish. */
function libraryPolishPrompt(graph: GraphState): string {
  return libraryConsolidationUserPrompt({
    overview: graph.overview,
    papers: graph.nodes
      .filter((node) => node.type === 'paper')
      .slice(0, 120)
      .map((paper) => ({ title: paper.label })),
    topics: rankNodes(graph.nodes.filter((node) => node.type === 'topic')).slice(0, 60),
  })
}

/* -------------------------------------------------------------------------- */
/* Deterministic summaries                                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic document overview; always usable when the model fails. */
function deterministicDocumentOverview(graph: GraphState, title: string): string {
  const heading = title === '' ? '## Knowledge graph' : `## ${title}`
  if (graph.nodes.length === 0) {
    return `${heading}\n\nNo concepts were extracted from this document.`
  }
  const lines = [heading, '', `${graph.nodes.length} concepts · ${graph.edges.length} relationships`, '']
  lines.push('### Key concepts')
  for (const node of rankNodes(graph.nodes).slice(0, 8)) {
    const summary = node.summary === '' ? '' : ` — ${node.summary}`
    lines.push(`- **${node.label}** (${node.type})${summary}`)
  }
  return lines.join('\n')
}

/** Deterministic document TL;DR (markdown bullets). */
function deterministicDocumentTldr(graph: GraphState): string {
  if (graph.nodes.length === 0) return '- No concepts were extracted from this document yet.'
  return rankNodes(graph.nodes)
    .slice(0, MAX_TLDR_ITEMS)
    .map((node) => `- **${node.label}**: ${node.summary === '' ? node.type : node.summary}`)
    .join('\n')
}

/** Deterministic glossary from `definition` nodes. */
function deterministicGlossary(graph: GraphState): GlossaryEntry[] {
  return rankNodes(graph.nodes.filter((node) => node.type === 'definition'))
    .slice(0, MAX_GLOSSARY_ITEMS)
    .map((node) => ({ term: node.label, definition: node.summary, blockKeys: node.blockKeys.slice(0, 4) }))
    .filter((item) => item.definition !== '')
}

/** Deterministic library overview (topics, clusters, papers). */
function deterministicLibraryOverview(graph: GraphState): string {
  const docs = graph.nodes.filter((node) => node.type === 'paper')
  const topics = graph.nodes.filter((node) => node.type === 'topic')
  if (docs.length === 0) {
    return '## Library graph\n\nNo parsed documents yet. Parse a paper to grow the library graph.'
  }
  const topTopics = rankNodes(topics).slice(0, 10)
  const clusters = Array.isArray(graph.clusters) ? graph.clusters : []
  const topicIds = new Set(topics.map((topic) => topic.id))
  const relations = graph.edges.filter((edge) => topicIds.has(edge.from) && topicIds.has(edge.to))
  const shared = rankNodes(topics.filter((topic) => (topic.documentIds?.length ?? 1) >= 2)).slice(0, 8)
  const lines = [
    '## Library graph',
    '',
    `**${docs.length}** papers · **${topics.length}** curated topics · **${relations.length}** relations · **${clusters.length}** clusters`,
  ]
  if (shared.length > 0) {
    lines.push('', '### Shared concepts')
    for (const topic of shared) {
      lines.push(`- **${topic.label}** — shared by ${topic.documentIds?.length ?? 1} papers`)
    }
  }
  if (topTopics.length > 0) {
    lines.push('', '### Representative topics')
    for (const topic of topTopics) {
      const count = Array.isArray(topic.documentIds) ? topic.documentIds.length : 1
      const suffix = count > 1 ? `, ${count} papers` : ''
      lines.push(`- **${topic.label}** — weight ${Math.round(topic.weight ?? 1)}${suffix}`)
    }
  }
  lines.push('', '### Papers')
  for (const paper of docs.slice(0, 40)) lines.push(`- **${paper.label}**`)
  if (docs.length > 40) lines.push(`- … and ${docs.length - 40} more`)
  return lines.join('\n')
}

/** Deterministic library TL;DR (markdown bullets). */
function deterministicLibraryTldr(graph: GraphState): string {
  const docs = graph.nodes.filter((node) => node.type === 'paper')
  const topics = rankNodes(graph.nodes.filter((node) => node.type === 'topic'))
  const clusters = Array.isArray(graph.clusters) ? graph.clusters : []
  if (docs.length === 0) return '- No parsed documents in the library yet.'
  const topicIds = new Set(topics.map((topic) => topic.id))
  const relations = graph.edges.filter((edge) => topicIds.has(edge.from) && topicIds.has(edge.to))
  const shared = topics.filter((topic) => (topic.documentIds?.length ?? 1) >= 2)
  const lines = [
    `- ${docs.length} paper${docs.length === 1 ? '' : 's'}, ${topics.length} curated topics and ${relations.length} relations across ${clusters.length} clusters.`,
  ]
  if (shared.length > 0) {
    lines.push(`- ${shared.length} concept${shared.length === 1 ? '' : 's'} appear in two or more papers.`)
  }
  const firstTopic = topics[0]
  if (firstTopic !== undefined) {
    lines.push(`- Most representative: **${firstTopic.label}** (${firstTopic.documentIds?.length ?? 1} paper(s)).`)
  }
  const strongest = [...relations].sort((left, right) => (right.weight ?? 1) - (left.weight ?? 1))[0]
  if (strongest !== undefined) {
    const labelOf = (id: string): string => topics.find((topic) => topic.id === id)?.label ?? id
    lines.push(`- Strongest link: **${labelOf(strongest.from)}** — **${labelOf(strongest.to)}** (${strongest.type}).`)
  }
  const firstCluster = clusters[0]
  if (clusters.length > 0 && firstCluster !== undefined) {
    lines.push(`- ${clusters.length} topic cluster${clusters.length === 1 ? '' : 's'}; the largest has ${firstCluster.size} topics.`)
  }
  return lines.slice(0, MAX_TLDR_ITEMS).join('\n')
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                      */
/* -------------------------------------------------------------------------- */

/** Union two string arrays without duplicates (left order first). */
function unionStrings(left: readonly string[], right: readonly string[], max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of [...left, ...right]) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

/** Options of {@link mergeNodeFields}. */
interface MergeNodeOptions {
  incrementWeight?: boolean | undefined
  preserveCurated?: boolean | undefined
}

/** Merge a node into an existing node (existing id, provenance and text win). */
function mergeNodeFields(existing: GraphNode, incoming: SanitizedNode, options: MergeNodeOptions = {}): void {
  existing.blockKeys = unionStrings(existing.blockKeys ?? [], incoming.blockKeys ?? [], MAX_BLOCK_KEYS)
  if (incoming.documentIds !== undefined) {
    existing.documentIds = unionStrings(existing.documentIds ?? [], incoming.documentIds, 50)
  }
  if (existing.aspect === undefined && incoming.aspect !== undefined) existing.aspect = incoming.aspect
  if (incoming.source === 'user') existing.source = 'user'
  if (options.preserveCurated === true && incoming.curated === true) {
    // A forced rebuild must keep the curated node's identity and place: the
    // user-edited label/summary/position beat re-extracted values.
    existing.label = incoming.label
    if (incoming.summary !== '') existing.summary = incoming.summary
    existing.curated = true
    if (incoming.aspect !== undefined) existing.aspect = incoming.aspect
    if (incoming.pinned === true) existing.pinned = true
    if (incoming.position !== undefined && incoming.position !== null) existing.position = { ...incoming.position }
  } else if (existing.summary === '' && incoming.summary !== '') {
    existing.summary = incoming.summary
  }
  if (options.incrementWeight === true) {
    existing.weight = Math.min(MAX_NODE_WEIGHT, (existing.weight ?? 1) + 1)
  } else {
    existing.weight = Math.max(existing.weight ?? 1, incoming.weight ?? 1)
  }
  existing.updatedAt = nowIso()
}

/** Options of {@link mergeDeltaIntoGraph}. */
interface MergeDeltaOptions {
  defaultSource?: GraphNode['source'] | undefined
  allowedTypes?: ReadonlySet<string> | undefined
  fallbackType?: GraphNodeType | undefined
  knownBlockKeys?: ReadonlySet<string> | undefined
  incrementWeight?: boolean | undefined
  preserveCurated?: boolean | undefined
}

/**
 * Merge a `{ nodes, edges }` delta into a document graph.
 *
 * - nodes dedupe by id first, then by normalized label + type; the existing id
 *   is preserved and incoming edge references are remapped to it;
 * - edge labels/ids may reference either a node id or a node label; unknown
 *   references create a concept/insight placeholder node first;
 * - edges dedupe by `from|to|type`.
 *
 * @returns ids added (for diagnostics).
 */
function mergeDeltaIntoGraph(
  graph: GraphState,
  delta: { nodes?: unknown; edges?: unknown } | null | undefined,
  options: MergeDeltaOptions = {},
): { nodes: string[]; edges: string[] } {
  const opts = {
    defaultSource: options.defaultSource ?? 'ai-summary',
    allowedTypes: options.allowedTypes ?? DOC_NODE_TYPES,
    fallbackType: options.fallbackType ?? 'concept',
    knownBlockKeys: options.knownBlockKeys,
    incrementWeight: options.incrementWeight === true,
    preserveCurated: options.preserveCurated === true,
  }
  const byId = new Map<string, GraphNode>()
  const byKey = new Map<string, GraphNode>()
  const byLabel = new Map<string, GraphNode>()
  const usedEdgeIds = new Set<string>()
  for (const node of graph.nodes) {
    byId.set(node.id, node)
    const key = nodeKey(node)
    if (!byKey.has(key)) byKey.set(key, node)
    const labelKey = normalizeLabel(node.label)
    if (labelKey !== '' && !byLabel.has(labelKey)) byLabel.set(labelKey, node)
  }
  for (const edge of graph.edges) usedEdgeIds.add(edge.id)

  const remap = new Map<string, string>()
  const addedNodes: string[] = []

  for (const raw of Array.isArray(delta?.nodes) ? delta.nodes : []) {
    const node = sanitizeNode(raw, {
      allowedTypes: opts.allowedTypes,
      fallbackType: opts.fallbackType,
      defaultSource: opts.defaultSource,
      knownBlockKeys: opts.knownBlockKeys,
      keepId: true,
    })
    if (node === null) continue
    let existing = node.id !== null ? byId.get(node.id) : undefined
    if (existing === undefined) existing = byKey.get(nodeKey(node))
    if (existing !== undefined) {
      if (node.id !== null && node.id !== existing.id) remap.set(node.id, existing.id)
      mergeNodeFields(existing, node, {
        incrementWeight: opts.incrementWeight,
        preserveCurated: opts.preserveCurated,
      })
      continue
    }
    let stored: GraphNode
    if (node.id === null || byId.has(node.id)) {
      const generated = newNodeId()
      if (isObject(raw) && typeof raw.id === 'string' && raw.id.trim() !== '') remap.set(raw.id.trim(), generated)
      stored = withNodeId(node, generated)
    } else {
      stored = withNodeId(node, node.id)
    }
    graph.nodes.push(stored)
    byId.set(stored.id, stored)
    const key = nodeKey(stored)
    if (!byKey.has(key)) byKey.set(key, stored)
    const labelKey = normalizeLabel(stored.label)
    if (labelKey !== '' && !byLabel.has(labelKey)) byLabel.set(labelKey, stored)
    addedNodes.push(stored.id)
  }

  /** Resolve an edge endpoint (id or label) to a node id, creating a placeholder. */
  const resolveRef = (ref: unknown): string | null => {
    const text = typeof ref === 'string' ? ref.trim() : ''
    if (text === '') return null
    const remapped = remap.get(text)
    if (remapped !== undefined) return remapped
    const direct = byId.get(text)
    if (direct !== undefined) return direct.id
    const labelKey = normalizeLabel(text)
    if (labelKey === '') return null
    const labelled = byLabel.get(labelKey)
    if (labelled !== undefined) return labelled.id
    const placeholder = sanitizeNode(
      { type: opts.fallbackType, label: text, summary: '', source: opts.defaultSource },
      { allowedTypes: opts.allowedTypes, fallbackType: opts.fallbackType, defaultSource: opts.defaultSource },
    )
    if (placeholder === null) return null
    const stored = withNodeId(placeholder)
    graph.nodes.push(stored)
    byId.set(stored.id, stored)
    const key = nodeKey(stored)
    if (!byKey.has(key)) byKey.set(key, stored)
    byLabel.set(normalizeLabel(stored.label), stored)
    addedNodes.push(stored.id)
    return stored.id
  }

  const edgeByKey = new Map<string, GraphEdge>()
  for (const edge of graph.edges) edgeByKey.set(`${edge.from}|${edge.to}|${edge.type}`, edge)
  const addedEdges: string[] = []

  for (const raw of Array.isArray(delta?.edges) ? delta.edges : []) {
    const route = sanitizeEdge(raw, { defaultSource: opts.defaultSource, keepId: true })
    if (route === null) continue
    const from = resolveRef(route.from)
    const to = resolveRef(route.to)
    if (from === null || to === null || from === to) continue
    const key = `${from}|${to}|${route.type}`
    const existing = edgeByKey.get(key)
    if (existing !== undefined) {
      existing.weight = Math.max(existing.weight ?? 1, route.weight ?? 1)
      if (existing.label === undefined && route.label !== undefined) existing.label = route.label
      if (route.source === 'user') existing.source = 'user'
      continue
    }
    let id = route.id !== undefined && !usedEdgeIds.has(route.id) ? route.id : makeEdgeId(from, to, route.type)
    if (usedEdgeIds.has(id)) id = makeEdgeId(from, to, route.type)
    usedEdgeIds.add(id)
    const stored: GraphEdge = { id, from, to, type: route.type, source: route.source, weight: route.weight }
    if (route.label !== undefined) stored.label = route.label
    graph.edges.push(stored)
    edgeByKey.set(key, stored)
    addedEdges.push(id)
  }

  return { nodes: addedNodes, edges: addedEdges }
}

/** One sanitized curation merge pair. */
interface MergePair {
  from: string
  into: string
}

/** Bound and sanitize the curation `merge` pairs from an update payload. */
function sanitizeMergePairs(raw: unknown): MergePair[] {
  if (!Array.isArray(raw)) return []
  const out: MergePair[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const from = typeof item.from === 'string' ? item.from.trim() : ''
    const into = typeof item.into === 'string' ? item.into.trim() : ''
    // Unknown ids are ignored by the caller (never a throw); malformed pairs are
    // dropped here so a stray value cannot corrupt the graph.
    if (!isNodeId(from) || !isNodeId(into) || from === into) continue
    if (out.some((pair) => pair.from === from && pair.into === into)) continue
    out.push({ from, into })
    if (out.length >= MAX_NODE_MERGES) break
  }
  return out
}

/**
 * Fold one document-graph node (`fromId`) into another (`intoId`) — the graph
 * curation "merge" operation:
 *
 * - evidence is unioned (`blockKeys`, `documentIds`); the target keeps its
 *   label/summary/aspect and gains the higher weight; pinned/position are
 *   inherited when the target has none; the target is marked `curated`;
 * - every edge touching the source is rewired onto the target, self-loops are
 *   dropped and duplicate edges dedupe by `from|to|type` keeping the highest
 *   weight;
 * - the source node is removed and `stats` is refreshed.
 *
 * Unknown/unrelated ids are a no-op (`false`) instead of an error.
 *
 * @returns whether the graph changed.
 */
function mergeGraphNodes(graph: GraphState, fromId: string, intoId: string): boolean {
  if (fromId === intoId) return false
  const from = graph.nodes.find((node) => node.id === fromId)
  const into = graph.nodes.find((node) => node.id === intoId)
  if (from === undefined || into === undefined) return false
  into.blockKeys = unionStrings(into.blockKeys ?? [], from.blockKeys ?? [], MAX_BLOCK_KEYS)
  const documentIds = unionStrings(into.documentIds ?? [], from.documentIds ?? [], 50)
  if (documentIds.length > 0) into.documentIds = documentIds
  if (into.aspect === undefined && from.aspect !== undefined) into.aspect = from.aspect
  into.weight = Math.max(into.weight ?? 1, from.weight ?? 1)
  if (from.pinned === true) into.pinned = true
  if (into.position === undefined && from.position !== undefined && from.position !== null) into.position = { ...from.position }
  into.curated = true
  into.updatedAt = nowIso()
  // Rewire both edge directions onto the target, drop self-loops, then dedupe
  // by from|to|type keeping the strongest (and user-sourced) edge.
  const out: GraphEdge[] = []
  const byKey = new Map<string, GraphEdge>()
  for (const edge of graph.edges) {
    const next: GraphEdge =
      edge.from === fromId || edge.to === fromId
        ? { ...edge, from: edge.from === fromId ? intoId : edge.from, to: edge.to === fromId ? intoId : edge.to }
        : edge
    if (next.from === next.to) continue
    const key = `${next.from}|${next.to}|${next.type}`
    const existing = byKey.get(key)
    if (existing !== undefined) {
      existing.weight = Math.max(existing.weight ?? 1, next.weight ?? 1)
      if (existing.label === undefined && next.label !== undefined) existing.label = next.label
      if (next.source === 'user') existing.source = 'user'
      continue
    }
    byKey.set(key, next)
    out.push(next)
  }
  graph.edges = out
  graph.nodes = graph.nodes.filter((node) => node.id !== fromId)
  refreshStats(graph)
  return true
}

/* -------------------------------------------------------------------------- */
/* Library aggregation                                                        */
/* -------------------------------------------------------------------------- */

/** Parsed documents in deterministic (oldest first, then id) order. */
function listParsedDocs(store: GraphStoreApi): DocumentMeta[] {
  let raw: unknown
  try {
    raw = store.list()
  } catch {
    return []
  }
  const docs: DocumentMeta[] = []
  for (const meta of Array.isArray(raw) ? raw : []) {
    if (!isObject(meta) || typeof meta.id !== 'string' || meta.id.trim() === '') continue
    if (meta.status !== 'parsed') continue
    docs.push(meta as unknown as DocumentMeta)
  }
  docs.sort(
    (left, right) =>
      String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) ||
      String(left.id).localeCompare(String(right.id)),
  )
  return docs
}

/** Dependencies of the library fallback graph builder. */
interface LibraryDeps {
  store: GraphStoreApi
  logger: Logger | undefined
  readMarkdown: ((documentId: string) => Promise<string>) | null
}

/** Build the per-document graph used by library aggregation (never persists). */
async function docGraphForLibrary(doc: DocumentMeta, deps: LibraryDeps): Promise<GraphState> {
  const documentId = doc.id
  try {
    const raw = await deps.store.readAux(documentId, GRAPH_FILE)
    if (isObject(raw) && Array.isArray(raw.nodes) && raw.nodes.length > 0) {
      const stored = normalizeDocumentGraph(raw, documentId)
      if (stored.nodes.length > 0) return stored
    }
  } catch (error) {
    logWarn(deps.logger, `cannot read graph.json for ${documentId}`, (error as Error)?.message ?? error)
  }
  // Lightweight fallback (no LLM): section headings + annotation notes/quotes.
  const graph = emptyDocumentGraph(documentId)
  const now = nowIso()
  if (deps.readMarkdown !== null) {
    try {
      const markdown = await deps.readMarkdown(documentId)
      const model = parsePaperMarkdown(markdown)
      const seen = new Set<string>()
      for (const entry of Array.isArray(model.outline) ? model.outline : []) {
        if (graph.nodes.length >= DOC_MAX_NODES) break
        const label = cleanLabel(entry.text)
        if (label === '') continue
        const key = `section|${normalizeLabel(label)}`
        if (seen.has(key)) continue
        seen.add(key)
        graph.nodes.push({
          id: newNodeId(),
          type: 'section',
          label,
          summary: '',
          blockKeys: typeof entry.key === 'string' ? [entry.key] : [],
          source: 'aggregate',
          weight: 1,
          createdAt: now,
          updatedAt: now,
        })
      }
    } catch {
      /* unparsed/missing markdown: annotations below may still contribute */
    }
  }
  const loadAnnotations = deps.store.loadAnnotations
  if (typeof loadAnnotations === 'function') {
    try {
      const annotations = await loadAnnotations(documentId)
      const items = Array.isArray(annotations?.items) ? annotations.items : []
      const seen = new Set<string>(graph.nodes.map((node) => `${node.type}|${normalizeLabel(node.label)}`))
      for (const item of items) {
        if (!isObject(item)) continue
        if (graph.nodes.length >= DOC_MAX_NODES) break
        const quote = boundedText(item.quote, MAX_SUMMARY_CHARS)
        const note = boundedText(item.note, MAX_LABEL_CHARS)
        const label = note !== '' ? note : cleanLabel(quote)
        if (label === '') continue
        const key = `insight|${normalizeLabel(label)}`
        if (seen.has(key)) continue
        seen.add(key)
        graph.nodes.push({
          id: newNodeId(),
          type: 'insight',
          label,
          summary: quote,
          blockKeys: typeof item.blockKey === 'string' ? [item.blockKey] : [],
          source: 'aggregate',
          weight: 1,
          createdAt: now,
          updatedAt: now,
        })
      }
    } catch {
      /* annotations are optional too */
    }
  }
  return graph
}

/** Connected components of the topic relation graph. */
function buildClusters(topicNodes: readonly GraphNode[], relatesEdges: readonly GraphEdge[]): GraphCluster[] {
  if (topicNodes.length === 0) return []
  const ids = new Set(topicNodes.map((node) => node.id))
  const parent = new Map<string, string>()
  for (const id of ids) parent.set(id, id)
  const find = (start: string): string => {
    let root = start
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    let node = start
    while (parent.get(node) !== node) {
      const next = parent.get(node) ?? root
      parent.set(node, root)
      node = next
    }
    return root
  }
  for (const edge of relatesEdges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    const left = find(edge.from)
    const right = find(edge.to)
    if (left !== right) parent.set(left, right)
  }
  const groups = new Map<string, GraphNode[]>()
  for (const node of topicNodes) {
    const root = find(node.id)
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [node])
    else group.push(node)
  }
  const clusters: GraphCluster[] = []
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) => (right.weight ?? 1) - (left.weight ?? 1) || left.label.localeCompare(right.label),
    )
    const first = ordered[0]
    if (first === undefined) continue
    clusters.push({
      id: `c-${hashId(ordered.map((node) => node.id).join('|'))}`,
      label: first.label,
      nodeIds: ordered.map((node) => node.id),
      size: ordered.length,
      weight: ordered.reduce((total, node) => total + (node.weight ?? 1), 0),
    })
  }
  clusters.sort((left, right) => right.size - left.size || left.label.localeCompare(right.label))
  return clusters
}

/** Stop words ignored when comparing library topic labels. */
const LIB_LABEL_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'via',
  'using', 'based', 'approach', 'method', 'methods', 'framework', 'structure',
  'problem', 'existing', 'new', 'novel', 'towards', 'toward', 'from', 'by',
  'topic', 'topics', 'paper', 'papers', 'concept', 'concepts',
  'section', 'sections', 'figure', 'figures', 'table', 'tables',
  'equation', 'equations', 'algorithm', 'algorithms', 'appendix', 'chapter',
  'lemma', 'theorem', 'proof', 'overview', 'introduction', 'conclusion',
  'results', 'evaluation', 'experiment', 'experiments', 'setup', 'discussion',
  'background', 'related', 'work',
])

/** Lowercase word tokens of a topic label (ASCII words only, stop words out). */
function libraryLabelTokens(label: string): Set<string> {
  const text = String(label ?? '').toLowerCase().normalize('NFKC')
  const tokens = new Set<string>()
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    const token = match[0].replace(/_/g, '-')
    if (token.length < 2 || LIB_LABEL_STOP_WORDS.has(token)) continue
    // "Figure 2" / "Algorithm 1" / "Concept 107" must not merge by counter.
    if (/^\d+$/.test(token)) continue
    tokens.add(token)
  }
  return tokens
}

/** Memoized label-token view for one aggregation pass (alias checks are O(n²)). */
type LabelTokenLookup = (label: unknown) => ReadonlySet<string>

/** Create the per-aggregation label token cache. */
function makeLabelTokenLookup(): LabelTokenLookup {
  const cache = new Map<string, ReadonlySet<string>>()
  return (label: unknown): ReadonlySet<string> => {
    const text = String(label ?? '')
    const cached = cache.get(text)
    if (cached !== undefined) return cached
    const tokens = libraryLabelTokens(text)
    cache.set(text, tokens)
    return tokens
  }
}

/**
 * Whether two topic labels name the same concept closely enough to merge.
 *
 * Word-set containment (with ≥2 shared content words) catches aliases such as
 * "spectral dominance" ⊂ "full spectral dominance" and "block reference" ⊂
 * "block reference structure"; high Jaccard catches reordered wording.
 */
function libraryLabelsSimilar(left: unknown, right: unknown, tokensOf: LabelTokenLookup): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftTokens = tokensOf(left)
  const rightTokens = tokensOf(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) return false
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  if (shared === 0) return false
  const smallest = Math.min(leftTokens.size, rightTokens.size)
  const largest = Math.max(leftTokens.size, rightTokens.size)
  // Very similar wording in a different order (needs ≥2 content words so a
  // single generic word cannot merge unrelated concepts).
  if (largest >= 2 && shared / largest >= 0.85) return true
  // Short alias extended by one qualifier ("block reference" ⊂ "block reference
  // structure", "spectral dominance" ⊂ "full spectral dominance"); longer
  // sentences must share at least three content words.
  if (shared === smallest && (shared >= 3 || (shared === 2 && largest <= 3))) return true
  return false
}

/** Per-document degree map used for topic importance. */
function documentDegrees(docGraph: GraphState): Map<string, number> {
  const degree = new Map<string, number>()
  for (const edge of docGraph.edges ?? []) {
    if (typeof edge.from === 'string') degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    if (typeof edge.to === 'string') degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  return degree
}

/** Importance of one document node as a candidate library topic. */
function documentNodeImportance(node: GraphNode, degree: ReadonlyMap<string, number>): number {
  const weight = Math.max(0.01, Number(node.weight) || 1)
  const degreeValue = Math.max(0, degree.get(node.id) ?? 0)
  const blockBonus = Math.min(4, Array.isArray(node.blockKeys) ? node.blockKeys.length : 0)
  const typeValue = LIB_TOPIC_TYPE_VALUE[node.type] ?? 1
  const sourceBonus = node.source === 'user' ? 1.2 : node.source === 'qa' ? 0.5 : 0
  return weight * 2 + Math.min(12, degreeValue) * 1.1 + blockBonus * 0.35 + typeValue + sourceBonus
}

/** One library topic candidate accumulated across documents. */
interface TopicEntry {
  key: string
  label: string
  summary: string
  blockKeys: string[]
  documentIds: string[]
  score: number
  aspect: Aspect | undefined
  aliases?: number
}

/** Cross-paper value of a candidate topic (coverage first, then importance). */
function libraryTopicScore(entry: TopicEntry): number {
  const coverage = Array.isArray(entry.documentIds) ? entry.documentIds.length : 1
  return coverage * 4 + entry.score + Math.min(4, entry.blockKeys.length) * 0.25
}

/** One document's contribution to library aggregation. */
interface DocumentInfo {
  doc: DocumentMeta
  docGraph: GraphState
  paper: GraphNode
  chosenKeys: Set<string>
  byKey: Map<string, { node: GraphNode; score: number }>
}

/** One cross-paper candidate record. */
interface CrossPaperRecord {
  docs: string[]
  best: { node: GraphNode; score: number }
}

/**
 * Aggregate per-document graphs into a curated library graph.
 *
 * This is deliberately NOT a union of every document node:
 *
 *  - each paper contributes at most its top `LIB_PER_DOC_TOP` nodes by a
 *    type/weight/degree/evidence importance score;
 *  - concepts that occur in two or more papers are always kept;
 *  - near-duplicate labels (aliases) merge into one concept;
 *  - the final set is capped at `LIB_MAX_TOPICS`, with every paper keeping at
 *    least two representatives;
 *  - edges are value-bearing: paper→topic `mentions`, topic→topic relations
 *    propagated from the real document-graph edges, and paper↔paper `shares`
 *    edges weighted by the number of shared concepts.
 */
function aggregateLibraryGraph(docs: readonly DocumentMeta[], docGraphs: readonly GraphState[]): GraphState {
  const graph = emptyLibraryGraph()
  const now = nowIso()
  graph.generatedAt = now

  const papers: GraphNode[] = []
  const entries = new Map<string, TopicEntry>()
  const docInfos: DocumentInfo[] = []

  // Pass 1: per-document candidates + importance cut.
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index]
    if (doc === undefined) continue
    const docGraph = docGraphs[index] ?? emptyDocumentGraph(doc.id)
    const title = cleanLabel(doc.title || doc.originalName || doc.id)
    const paper: GraphNode = {
      id: paperNodeId(doc.id),
      type: 'paper',
      label: title === '' ? doc.id : title,
      summary: '',
      blockKeys: [],
      documentIds: [doc.id],
      source: 'aggregate',
      weight: 2,
      createdAt: isoOrNow(doc.createdAt),
      updatedAt: now,
    }
    papers.push(paper)

    const degree = documentDegrees(docGraph)
    const byKey = new Map<string, { node: GraphNode; score: number }>()
    for (const node of docGraph.nodes ?? []) {
      if (!TOPIC_TYPES.has(node.type)) continue
      const key = normalizeLabel(node.label)
      if (key === '') continue
      const score = documentNodeImportance(node, degree)
      const existing = byKey.get(key)
      if (existing === undefined || score > existing.score) byKey.set(key, { node, score })
    }
    const chosen = [...byKey.entries()]
      .map(([key, info]) => ({ key, node: info.node, score: info.score }))
      .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
      .slice(0, LIB_PER_DOC_TOP)

    for (const item of chosen) {
      let entry = entries.get(item.key)
      if (entry === undefined) {
        entry = {
          key: item.key,
          label: cleanLabel(item.node.label),
          summary: '',
          blockKeys: [],
          documentIds: [],
          score: 0,
          aspect: undefined,
        }
        entries.set(item.key, entry)
      }
      if (!entry.documentIds.includes(doc.id)) entry.documentIds.push(doc.id)
      if (entry.summary === '' && typeof item.node.summary === 'string') {
        entry.summary = boundedText(item.node.summary, 320)
      }
      entry.blockKeys = unionStrings(entry.blockKeys, Array.isArray(item.node.blockKeys) ? item.node.blockKeys : [], 6)
      if (entry.aspect === undefined && typeof item.node.aspect === 'string') entry.aspect = item.node.aspect
      entry.score = Math.max(entry.score, item.score)
    }
    docInfos.push({ doc, docGraph, paper, chosenKeys: new Set(chosen.map((item) => item.key)), byKey })
  }

  // Pass 2: cross-paper shared concepts are valuable even when they missed a
  // paper's top cut; add them with their real coverage.
  const crossPaper = new Map<string, CrossPaperRecord>()
  for (const info of docInfos) {
    for (const [key, item] of info.byKey.entries()) {
      let record = crossPaper.get(key)
      if (record === undefined) {
        record = { docs: [], best: item }
        crossPaper.set(key, record)
      }
      if (!record.docs.includes(info.doc.id)) record.docs.push(info.doc.id)
      if (item.score > record.best.score) record.best = item
    }
  }
  for (const [key, record] of crossPaper) {
    if (record.docs.length < 2 || entries.has(key)) continue
    entries.set(key, {
      key,
      label: cleanLabel(record.best.node.label),
      summary: boundedText(record.best.node.summary, 320),
      blockKeys: unionStrings([], Array.isArray(record.best.node.blockKeys) ? record.best.node.blockKeys : [], 6),
      documentIds: record.docs.slice(),
      score: record.best.score + 2,
      aspect: record.best.node.aspect,
    })
  }

  // Pass 2.5: merge near-duplicate labels (aliases) so the curated set contains
  // concepts rather than wording variants.
  const knownKeys = [...crossPaper.keys()].sort((left, right) => left.localeCompare(right))
  const tokensOf = makeLabelTokenLookup()
  const parent = new Map<string, string>(knownKeys.map((key) => [key, key]))
  const findRoot = (key: string): string => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    let node = key
    while (parent.get(node) !== node) {
      const next = parent.get(node) ?? root
      parent.set(node, root)
      node = next
    }
    return root
  }
  const unionKeys = (left: string, right: string): void => {
    const leftRoot = findRoot(left)
    const rightRoot = findRoot(right)
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot)
  }
  for (let left = 0; left < knownKeys.length; left += 1) {
    const leftKey = knownKeys[left]
    if (leftKey === undefined) continue
    const leftLabel = crossPaper.get(leftKey)?.best?.node?.label
    for (let right = left + 1; right < knownKeys.length; right += 1) {
      const rightKey = knownKeys[right]
      if (rightKey === undefined) continue
      const rightLabel = crossPaper.get(rightKey)?.best?.node?.label
      if (libraryLabelsSimilar(leftLabel, rightLabel, tokensOf)) unionKeys(leftKey, rightKey)
    }
  }
  const aliasGroups = new Map<string, string[]>()
  for (const key of knownKeys) {
    const root = findRoot(key)
    const group = aliasGroups.get(root)
    if (group === undefined) aliasGroups.set(root, [key])
    else group.push(key)
  }
  const canonicalKey = new Map<string, string>()
  const mergedEntries = new Map<string, TopicEntry>()
  for (const members of aliasGroups.values()) {
    let memberEntries = members.map((key) => entries.get(key)).filter((entry): entry is TopicEntry => entry !== undefined)
    const aliasRecords = members
      .map((key) => crossPaper.get(key))
      .filter((record): record is CrossPaperRecord => record !== undefined && Array.isArray(record.docs) && record.docs.length > 0)
    const aliasDocs: string[] = []
    for (const record of aliasRecords) {
      for (const documentId of record.docs) {
        if (!aliasDocs.includes(documentId)) aliasDocs.push(documentId)
      }
    }
    if (memberEntries.length === 0) {
      // Neither wording made a paper's top cut, but the alias still names the
      // same concept in 2+ papers: that cross-paper bridge is what the library
      // graph should surface.
      if (aliasDocs.length < 2) continue
      let bestRecord = aliasRecords[0]
      for (const record of aliasRecords) {
        if (bestRecord !== undefined && record.best.score > bestRecord.best.score) bestRecord = record
      }
      if (bestRecord === undefined) continue
      const bestNode = bestRecord.best.node
      const firstMember = members[0] ?? ''
      memberEntries = [
        {
          key: firstMember,
          label: cleanLabel(bestNode.label),
          summary: boundedText(bestNode.summary, 320),
          blockKeys: unionStrings([], Array.isArray(bestNode.blockKeys) ? bestNode.blockKeys : [], 6),
          documentIds: aliasDocs.slice(),
          score: bestRecord.best.score + 2,
          aspect: bestNode.aspect,
        },
      ]
    }
    memberEntries.sort(
      (left, right) =>
        right.score - left.score ||
        right.documentIds.length - left.documentIds.length ||
        left.label.localeCompare(right.label),
    )
    const representative = memberEntries[0]
    if (representative === undefined) continue
    const merged: TopicEntry = {
      key: representative.key,
      label: representative.label,
      summary: '',
      blockKeys: [],
      documentIds: [],
      score: representative.score,
      aspect: representative.aspect,
      aliases: members.length,
    }
    for (const entry of memberEntries) {
      for (const documentId of entry.documentIds) {
        if (!merged.documentIds.includes(documentId)) merged.documentIds.push(documentId)
      }
      merged.blockKeys = unionStrings(merged.blockKeys, entry.blockKeys, 8)
      if (merged.summary === '' && entry.summary !== '') merged.summary = entry.summary
      if (merged.aspect === undefined && entry.aspect !== undefined) merged.aspect = entry.aspect
      merged.score = Math.max(merged.score, entry.score)
    }
    // Alias occurrences in other papers contribute coverage/evidence even when
    // that paper's own top cut missed the wording.
    for (const documentId of aliasDocs) {
      if (!merged.documentIds.includes(documentId)) merged.documentIds.push(documentId)
    }
    for (const record of aliasRecords) {
      const node = record.best?.node ?? null
      if (node === null) continue
      merged.blockKeys = unionStrings(merged.blockKeys, Array.isArray(node.blockKeys) ? node.blockKeys : [], 8)
      if (merged.summary === '' && typeof node.summary === 'string') merged.summary = boundedText(node.summary, 320)
      if (merged.aspect === undefined && typeof node.aspect === 'string') merged.aspect = node.aspect
      merged.score = Math.max(merged.score, record.best.score)
    }
    mergedEntries.set(representative.key, merged)
    for (const key of members) canonicalKey.set(key, representative.key)
  }

  // Pass 3: global representative selection + per-paper diversity guarantee.
  const rankedEntries = [...mergedEntries.values()].sort(
    (left, right) => libraryTopicScore(right) - libraryTopicScore(left) || left.label.localeCompare(right.label),
  )
  const selected = new Map<string, TopicEntry>()
  for (const entry of rankedEntries) {
    if (selected.size >= LIB_MAX_TOPICS) break
    selected.set(entry.key, entry)
  }
  for (const info of docInfos) {
    let represented = 0
    for (const entry of selected.values()) {
      if (entry.documentIds.includes(info.doc.id)) represented += 1
    }
    for (const key of info.chosenKeys) {
      if (represented >= 2) break
      const canonical = canonicalKey.get(key) ?? key
      if (selected.has(canonical)) continue
      const entry = mergedEntries.get(canonical)
      if (entry === undefined) continue
      selected.set(canonical, entry)
      represented += 1
    }
  }

  // Nodes: papers first, then curated topics.
  graph.nodes.push(...papers)
  const topicByKey = new Map<string, GraphNode>()
  const topics: GraphNode[] = []
  const docOrder = new Map(docs.map((doc, index) => [doc.id, index]))
  for (const entry of selected.values()) {
    const coverage = entry.documentIds.length
    const aliasBonus = Math.min(3, Math.max(0, (entry.aliases ?? 1) - 1))
    const weight = Math.min(12, coverage * 2 + Math.round(Math.min(8, entry.score) / 2) + aliasBonus)
    const topic: GraphNode = {
      id: topicNodeId(entry.key),
      type: 'topic',
      label: entry.label,
      summary: entry.summary,
      blockKeys: entry.blockKeys.slice(),
      documentIds: entry.documentIds
        .slice()
        .sort((left, right) => (docOrder.get(left) ?? 0) - (docOrder.get(right) ?? 0)),
      source: 'aggregate',
      weight,
      createdAt: now,
      updatedAt: now,
    }
    if (typeof entry.aspect === 'string') topic.aspect = entry.aspect
    topics.push(topic)
    topicByKey.set(entry.key, topic)
    graph.nodes.push(topic)
  }

  const edgeByKey = new Map<string, GraphEdge>()
  const putEdge = (edge: GraphEdge): void => {
    edgeByKey.set(`${edge.from}|${edge.to}|${edge.type}`, edge)
  }

  // Value-bearing edges 1: paper → representative topic.
  for (const info of docInfos) {
    for (const entry of selected.values()) {
      if (!entry.documentIds.includes(info.doc.id)) continue
      const topic = topicByKey.get(entry.key)
      if (topic === undefined) continue
      putEdge({
        id: makeEdgeId(info.paper.id, topic.id, 'mentions'),
        from: info.paper.id,
        to: topic.id,
        type: 'mentions',
        source: 'aggregate',
        weight: 2,
      })
    }
  }

  // Value-bearing edges 2: topic↔topic relations propagated from the document
  // graphs. Only relations the AI actually extracted become library edges.
  for (const info of docInfos) {
    const nodeById = new Map((info.docGraph.nodes ?? []).map((node) => [node.id, node]))
    for (const edge of info.docGraph.edges ?? []) {
      const fromNode = nodeById.get(edge.from)
      const toNode = nodeById.get(edge.to)
      if (fromNode === undefined || toNode === undefined) continue
      const fromKey = canonicalKey.get(normalizeLabel(fromNode.label)) ?? normalizeLabel(fromNode.label)
      const toKey = canonicalKey.get(normalizeLabel(toNode.label)) ?? normalizeLabel(toNode.label)
      if (fromKey === '' || toKey === '' || fromKey === toKey) continue
      const fromTopic = topicByKey.get(fromKey)
      const toTopic = topicByKey.get(toKey)
      if (fromTopic === undefined || toTopic === undefined || fromTopic.id === toTopic.id) continue
      const type = (
        EDGE_TYPES.has(edge.type) && edge.type !== 'mentions' && edge.type !== 'shares' ? edge.type : 'relates'
      ) as GraphEdgeType
      const [left, right] = fromTopic.id <= toTopic.id ? [fromTopic.id, toTopic.id] : [toTopic.id, fromTopic.id]
      const key = `${left}|${right}|${type}`
      const existing = edgeByKey.get(key)
      if (existing !== undefined) {
        existing.weight = Math.min(6, (existing.weight ?? 1) + 1)
        continue
      }
      const relation: GraphEdge = {
        id: makeEdgeId(left, right, type),
        from: left,
        to: right,
        type,
        source: 'aggregate',
        weight: 1,
      }
      if (typeof edge.label === 'string' && edge.label !== '') relation.label = boundedText(edge.label, 80)
      edgeByKey.set(key, relation)
    }
  }

  // Value-bearing edges 3: paper ↔ paper "shares concepts" (cross-paper view).
  const shares: Array<{ from: string; to: string; count: number }> = []
  for (let left = 0; left < docInfos.length; left += 1) {
    for (let right = left + 1; right < docInfos.length; right += 1) {
      const leftInfo = docInfos[left]
      const rightInfo = docInfos[right]
      if (leftInfo === undefined || rightInfo === undefined) continue
      const leftId = leftInfo.doc.id
      const rightId = rightInfo.doc.id
      let count = 0
      for (const entry of selected.values()) {
        if (entry.documentIds.includes(leftId) && entry.documentIds.includes(rightId)) count += 1
      }
      if (count > 0) shares.push({ from: leftInfo.paper.id, to: rightInfo.paper.id, count })
    }
  }
  shares.sort((left, right) => right.count - left.count || String(left.from).localeCompare(String(right.from)))
  const maxShares = Math.max(20, docs.length * 3)
  for (const share of shares.slice(0, maxShares)) {
    putEdge({
      id: makeEdgeId(share.from, share.to, 'shares'),
      from: share.from,
      to: share.to,
      type: 'shares',
      source: 'aggregate',
      weight: Math.min(8, share.count),
    })
  }

  graph.edges = [...edgeByKey.values()]
  capGraph(graph, LIB_MAX_NODES, LIB_MAX_EDGES)
  const topicIds = new Set(topics.map((topic) => topic.id))
  graph.clusters = buildClusters(
    topics,
    graph.edges.filter((edge) => topicIds.has(edge.from) && topicIds.has(edge.to)),
  )
  graph.overview = deterministicLibraryOverview(graph)
  graph.tldr = deterministicLibraryTldr(graph)
  return graph
}

/* -------------------------------------------------------------------------- */
/* LLM plumbing                                                               */
/* -------------------------------------------------------------------------- */

/** The injected graph LLM gateway surface (the engine never imports the Host). */
export interface GraphLlmApi {
  available?: (() => boolean) | undefined
  route?: (() => unknown) | undefined
  completeText?: ((request: LlmCompleteRequest) => Promise<unknown>) | undefined
  streamText?: ((request: LlmStreamRequest) => AsyncIterable<unknown>) | undefined
}

/** The store aux surface the graph service consumes (subset of `StoreApi`). */
export interface GraphStoreApi {
  list: () => DocumentMeta[]
  get?: ((documentId: string) => DocumentMeta | undefined) | undefined
  readMarkdown?: ((documentId: string) => Promise<ParsedDocument>) | undefined
  loadAnnotations?: ((documentId: string) => Promise<AnnotationEnvelope>) | undefined
  readAux: (documentId: string, name: DocumentAuxName) => Promise<unknown>
  writeAux: (documentId: string, name: DocumentAuxName, value: unknown) => Promise<void>
  readLibraryAux: (name: LibraryAuxName) => Promise<unknown>
  writeLibraryAux: (name: LibraryAuxName, value: unknown) => Promise<void>
}

/** Dependencies of {@link createGraphService}. */
export interface GraphServiceDeps {
  llm?: GraphLlmApi | undefined
  store: GraphStoreApi
  config?: { ai?: Partial<AiConfig> | undefined } | undefined
  logger?: Logger | undefined
  readMarkdown?: ((documentId: string) => Promise<unknown>) | undefined
}

/** An error carrying a stable engine code. */
interface CodedError extends Error {
  code: string
}

/** Create an Error with a stable `code` property. */
function codedError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  return error
}

/** Extract an error's stable code, if any. */
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  return 'code' in error && typeof error.code === 'string' && error.code !== '' ? error.code : undefined
}

/** Whether the injected gateway reports an available route. */
function gatewayAvailable(llm: GraphLlmApi | undefined): boolean {
  if (llm === null || llm === undefined || typeof llm !== 'object') return false
  if (typeof llm.available === 'function') {
    try {
      return llm.available() === true
    } catch {
      return false
    }
  }
  return typeof llm.completeText === 'function' || typeof llm.streamText === 'function'
}

/** Resolve `{ provider, model }` from the gateway without throwing. */
function routeOf(llm: GraphLlmApi | undefined): { provider: string; model: string } | null {
  if (llm === null || llm === undefined || typeof llm !== 'object' || typeof llm.route !== 'function') return null
  try {
    return sanitizeModel(llm.route())
  } catch {
    return null
  }
}

/**
 * Run one bounded text completion through the injected gateway.
 *
 * `completeText` is preferred; a gateway exposing only `streamText` is
 * supported by collecting its delta frames. No other gateway method is used.
 */
async function completeViaGateway(llm: GraphLlmApi | undefined, request: LlmCompleteRequest): Promise<string> {
  if (llm !== null && llm !== undefined && typeof llm.completeText === 'function') {
    const value = await llm.completeText(request)
    if (typeof value === 'string') return value
    if (isObject(value) && typeof value.text === 'string') return value.text
    return ''
  }
  if (llm !== null && llm !== undefined && typeof llm.streamText === 'function') {
    let text = ''
    const stream = llm.streamText(request)
    for await (const frame of stream) {
      if (!isObject(frame)) continue
      const type = typeof frame.type === 'string' ? frame.type : ''
      if (type === 'error') {
        throw codedError(
          typeof frame.code === 'string' && frame.code !== '' ? frame.code : 'llm-failed',
          typeof frame.message === 'string' ? frame.message : 'LLM stream failed',
        )
      }
      if (type === 'delta' && typeof frame.text === 'string') text += frame.text
    }
    return text
  }
  throw codedError('llm-unavailable', 'LLM gateway unavailable')
}

/* -------------------------------------------------------------------------- */
/* Graph service                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The concrete graph service facade: the frozen contract API with the
 * engine-tolerant parameter shapes used by tests and the composition root
 * (all inputs are re-validated at runtime).
 */
export interface GraphService extends GraphServiceApi {
  buildDocGraph: (
    documentId: string,
    options?: { signal?: AbortSignal | undefined; force?: boolean | undefined },
  ) => AsyncGenerator<GraphBuildFrame>
  mergeDocKnowledge: (documentId: string, delta?: unknown) => Promise<KnowledgeGraph>
  updateDocGraph: (documentId: string, patch?: unknown) => Promise<KnowledgeGraph>
  rebuildLibraryGraph: (input?: { signal?: AbortSignal | undefined }) => AsyncGenerator<LibraryGraphFrame>
}

/**
 * Create the knowledge-graph service (`docs/AI-SPEC.md` §3).
 *
 * @param deps - injected host dependencies. The LLM gateway is optional:
 *   without it reads/updates still work and builds fail with an
 *   `llm-unavailable` frame instead of throwing.
 * @returns the graph service facade.
 */
export function createGraphService(deps: GraphServiceDeps): GraphService {
  const { store } = deps
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createGraphService: an injected store is required')
  }
  for (const method of ['readAux', 'writeAux', 'readLibraryAux', 'writeLibraryAux', 'list'] as const) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createGraphService: store.${method} is required (docs/AI-SPEC.md §2)`)
    }
  }
  const llm = deps.llm
  const graphConfig = resolveGraphConfig(deps.config)
  const log = deps.logger ?? {}
  const readMarkdownImpl =
    typeof deps.readMarkdown === 'function'
      ? deps.readMarkdown
      : typeof store.readMarkdown === 'function'
        ? (documentId: string): Promise<ParsedDocument> => store.readMarkdown!(documentId)
        : null

  /** Serialize read-modify-write mutations per document. */
  const docChains = new Map<string, Promise<void>>()
  function queueDoc<T>(documentId: string, task: () => Promise<T>): Promise<T> {
    const previous = docChains.get(documentId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    docChains.set(documentId, tail)
    void tail.then(() => {
      if (docChains.get(documentId) === tail) docChains.delete(documentId)
    })
    return run
  }

  /** Read parsed markdown through the injected reader (or store.readMarkdown). */
  async function loadMarkdown(documentId: string): Promise<string> {
    if (readMarkdownImpl === null) throw codedError('not-parsed', 'readMarkdown is not available')
    const result = await readMarkdownImpl(documentId)
    if (typeof result === 'string') return result
    if (isObject(result) && typeof result.markdown === 'string') return result.markdown
    return ''
  }

  /** Document title for prompts/overviews; never throws. */
  function documentTitle(documentId: string): string {
    if (typeof store.get !== 'function') return ''
    try {
      const meta = store.get(documentId)
      if (isObject(meta)) return boundedText(meta.title ?? meta.originalName, 300)
    } catch {
      /* invalid id / not found: prompts fall back to an empty title */
    }
    return ''
  }

  /**
   * Merge Q&A/user knowledge and user-curated nodes from the on-disk graph into
   * a freshly built graph. A forced rebuild must never silently drop them.
   *
   * @returns whether any late knowledge was preserved.
   */
  function preserveLateKnowledge(graph: GraphState, current: GraphState): boolean {
    const lateNodes = current.nodes.filter(
      (node) => node.source === 'qa' || node.source === 'user' || node.curated === true,
    )
    if (lateNodes.length === 0) return false
    const lateIds = new Set(lateNodes.map((node) => node.id))
    const labelById = new Map(current.nodes.map((node) => [node.id, node.label]))
    const lateEdges = current.edges
      .filter((edge) => lateIds.has(edge.from) || lateIds.has(edge.to))
      .map((edge) => ({
        ...edge,
        from: labelById.get(edge.from) ?? edge.from,
        to: labelById.get(edge.to) ?? edge.to,
      }))
    mergeDeltaIntoGraph(
      graph,
      { nodes: lateNodes, edges: lateEdges },
      {
        defaultSource: 'qa',
        allowedTypes: DOC_NODE_TYPES,
        fallbackType: 'concept',
        incrementWeight: false,
        preserveCurated: true,
      },
    )
    return true
  }

  /** Read and normalize the persisted document graph. */
  async function readDocGraph(documentId: string): Promise<GraphState> {
    const raw = await store.readAux(documentId, GRAPH_FILE)
    return normalizeDocumentGraph(raw, documentId)
  }

  /** Read and normalize the persisted library graph (empty when never built). */
  async function readLibraryGraph(): Promise<GraphState> {
    const raw = await store.readLibraryAux(LIBRARY_GRAPH_FILE)
    return normalizeLibraryGraph(raw)
  }

  /** Persist one document graph. */
  async function writeDocGraph(documentId: string, graph: GraphState): Promise<GraphState> {
    await store.writeAux(documentId, GRAPH_FILE, toKnowledgeGraph(graph))
    return graph
  }

  /** Fill document summary fields from the model payload, falling back deterministically. */
  function applyDocumentSummary(graph: GraphState, title: string, summary: ParsedSummaryPayload | null): GraphState {
    graph.overview =
      summary !== null && summary.overview !== '' ? summary.overview : deterministicDocumentOverview(graph, title)
    graph.tldr = summary !== null && summary.tldr !== '' ? summary.tldr : deterministicDocumentTldr(graph)
    graph.glossary = summary !== null && summary.glossary.length > 0 ? summary.glossary : deterministicGlossary(graph)
    refreshStats(graph)
    return graph
  }

  /**
   * Read one document graph (no LLM).
   * @param documentId - document id.
   * @returns the normalized KG.
   */
  async function docGraph(documentId: string): Promise<KnowledgeGraph> {
    return toKnowledgeGraph(await readDocGraph(documentId))
  }

  /**
   * Build a document graph with the model.
   *
   * Frames: `progress` (reading → extracting per chunk → merging → done),
   * then one `graph` frame; failures/cancellation yield one `error` frame.
   * A non-forced call returns the cached graph without model calls.
   *
   * @param documentId - document id.
   * @param options - abort signal and force-rebuild flag.
   * @returns frame stream.
   */
  async function* buildDocGraph(
    documentId: string,
    options: { signal?: AbortSignal | undefined; force?: boolean | undefined } = {},
  ): AsyncGenerator<GraphBuildFrame> {
    const signal = options.signal
    try {
      yield { type: 'progress', phase: 'reading', done: 0, total: 1, chunk: 0 }

      const existing = await readDocGraph(documentId)
      if (options.force !== true && existing.nodes.length > 0) {
        yield { type: 'progress', phase: 'reading', done: 1, total: 1, chunk: 0 }
        yield { type: 'progress', phase: 'done', done: 1, total: 1, chunk: 0 }
        yield { type: 'graph', graph: toKnowledgeGraph(existing) }
        return
      }
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      if (!gatewayAvailable(llm)) {
        yield { type: 'error', code: 'llm-unavailable', message: '语言模型服务不可用（LLM service unavailable）' }
        return
      }

      const title = documentTitle(documentId)
      const markdown = await loadMarkdown(documentId)
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      yield { type: 'progress', phase: 'reading', done: 1, total: 1, chunk: 0 }

      const chunked = chunkDocument(markdown, graphConfig)
      const chunks = chunked.chunks
      const model = routeOf(llm)
      if (chunks.length === 0) {
        const empty = emptyDocumentGraph(documentId)
        empty.generatedAt = nowIso()
        empty.model = model
        applyDocumentSummary(empty, title, null)
        const saved = await queueDoc(documentId, async () => {
          // Even an empty re-extraction must not erase curated/Q&A knowledge.
          const current = await readDocGraph(documentId)
          if (preserveLateKnowledge(empty, current)) capGraph(empty, DOC_MAX_NODES, DOC_MAX_EDGES)
          return writeDocGraph(documentId, empty)
        })
        yield { type: 'progress', phase: 'done', done: 1, total: 1, chunk: 0 }
        yield { type: 'graph', graph: toKnowledgeGraph(saved) }
        return
      }

      const graph = emptyDocumentGraph(documentId)
      graph.generatedAt = nowIso()
      graph.model = model
      const total = chunks.length
      const knownBlockKeys = new Set<string>()
      for (const chunk of chunks) {
        for (const key of chunk.blockKeys) knownBlockKeys.add(key)
      }
      let failures = 0
      let malformed = 0

      for (const chunk of chunks) {
        if (isAborted(signal)) {
          yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
          return
        }
        let text = ''
        try {
          text = await completeViaGateway(llm, {
            system: GRAPH_EXTRACTION_SYSTEM,
            messages: [{ role: 'user', content: [{ type: 'text', text: extractionPrompt(chunk, { title }) }] }],
            signal,
            maxTokens: graphConfig.graphMaxTokens,
            temperature: 0.1,
            purpose: 'graph-extract',
          })
        } catch (error) {
          if (isAbortError(error, signal)) {
            yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
            return
          }
          failures += 1
          logWarn(log, `chunk ${chunk.index}/${total} failed`, (error as Error)?.message ?? error)
          yield { type: 'progress', phase: 'extracting', done: chunk.index, total, chunk: chunk.index }
          continue
        }
        const payload = parseGraphPayload(text)
        if (payload === null) {
          malformed += 1
          logWarn(log, `chunk ${chunk.index}/${total} returned no usable graph JSON`, '')
        } else {
          mergeDeltaIntoGraph(graph, payload, {
            defaultSource: 'ai-summary',
            allowedTypes: DOC_NODE_TYPES,
            fallbackType: 'concept',
            knownBlockKeys: new Set(chunk.blockKeys),
            incrementWeight: true,
          })
        }
        yield { type: 'progress', phase: 'extracting', done: chunk.index, total, chunk: chunk.index }
      }

      if (failures === total) {
        yield { type: 'error', code: 'llm-failed', message: '模型调用失败（LLM request failed）' }
        return
      }
      if (malformed === total) {
        logWarn(log, 'every extraction chunk returned malformed JSON; keeping an empty graph', '')
      }
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)

      yield { type: 'progress', phase: 'merging', done: 0, total: 1, chunk: 0 }
      let summary: ParsedSummaryPayload | null = null
      if (graph.nodes.length > 0) {
        try {
          const text = await completeViaGateway(llm, {
            system: GRAPH_SUMMARY_PROMPT,
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: summaryPrompt(graph, { title, outline: chunked.outline }) }],
              },
            ],
            signal,
            maxTokens: Math.min(graphConfig.graphMaxTokens, 1600),
            temperature: 0.2,
            purpose: 'graph-summary',
          })
          summary = parseSummaryPayload(text, knownBlockKeys)
        } catch (error) {
          if (isAbortError(error, signal)) {
            yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
            return
          }
          logWarn(log, 'summary pass failed; using deterministic summary', (error as Error)?.message ?? error)
        }
      }
      applyDocumentSummary(graph, title, summary)
      capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }

      // Preserve Q&A/user knowledge and user-curated nodes added while this
      // build was running (or before it); a forced rebuild must not silently
      // drop them. Old ai-summary nodes are replaced, but `curated` nodes keep
      // their label/position/identity.
      const saved = await queueDoc(documentId, async () => {
        const current = await readDocGraph(documentId)
        if (preserveLateKnowledge(graph, current)) capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)
        graph.generatedAt = nowIso()
        graph.model = graph.model ?? model
        refreshStats(graph)
        return writeDocGraph(documentId, graph)
      })
      yield { type: 'progress', phase: 'done', done: 1, total: 1, chunk: 0 }
      yield { type: 'graph', graph: toKnowledgeGraph(saved) }
    } catch (error) {
      if (isAbortError(error, signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      const code = errorCode(error) ?? 'graph-failed'
      const message = (error as Error)?.message !== undefined && (error as Error).message !== ''
        ? (error as Error).message
        : '图谱构建失败（Graph build failed）'
      logWarn(log, 'build failed', message)
      yield { type: 'error', code, message }
    }
  }

  /**
   * Merge Q&A knowledge (`{ nodes, edges }`) into one document graph.
   * Node ids are preserved when the model supplied one; edges may reference
   * labels, and unknown references create a node first.
   *
   * @param documentId - document id.
   * @param delta - knowledge delta (the `.knowledge` wrapper is also tolerated).
   * @returns the persisted KG.
   */
  async function mergeDocKnowledge(documentId: string, delta?: unknown): Promise<KnowledgeGraph> {
    return queueDoc(documentId, async () => {
      const graph = await readDocGraph(documentId)
      const wrapped = isObject(delta) ? delta : {}
      const source =
        isObject(wrapped.knowledge) && !Array.isArray(wrapped.nodes)
          ? (wrapped.knowledge as { nodes?: unknown; edges?: unknown })
          : (wrapped as { nodes?: unknown; edges?: unknown })
      const nodes = Array.isArray(source?.nodes) ? source.nodes : []
      const edges = Array.isArray(source?.edges) ? source.edges : []
      if (nodes.length === 0 && edges.length === 0) return toKnowledgeGraph(graph)
      mergeDeltaIntoGraph(
        graph,
        { nodes, edges },
        { defaultSource: 'qa', allowedTypes: DOC_NODE_TYPES, fallbackType: 'concept', incrementWeight: false },
      )
      capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)
      if (graph.generatedAt === null) graph.generatedAt = nowIso()
      if (graph.model === null) graph.model = routeOf(llm)
      const title = documentTitle(documentId)
      if (graph.overview === '') graph.overview = deterministicDocumentOverview(graph, title)
      if (graph.tldr === '') graph.tldr = deterministicDocumentTldr(graph)
      if (graph.glossary.length === 0) graph.glossary = deterministicGlossary(graph)
      return toKnowledgeGraph(await writeDocGraph(documentId, graph))
    })
  }

  /**
   * Apply user/AI edits to one document graph (`docs/AI-SPEC.md` §4 graph.update):
   *
   * - nodes upsert by id (or by normalized label + type) inside the document's
   *   atomic queue; existing ids are kept and only the provided fields are
   *   applied (`source` is never clobbered unless the caller sent it), every
   *   user edit marks the node `curated` and bumps `updatedAt`, and the optional
   *   `pinned` / `position` curation fields are persisted;
   * - edges upsert by id (or from/to/type);
   * - `merge: [{ from, into }]` folds one node into another; unknown ids are
   *   ignored without throwing.
   *
   * @param documentId - document id.
   * @param patch - curation payload.
   * @returns the persisted KG.
   */
  async function updateDocGraph(documentId: string, patch?: unknown): Promise<KnowledgeGraph> {
    const payload: GraphPatch = isObject(patch) ? (patch as GraphPatch) : {}
    return queueDoc(documentId, async () => {
      const graph = await readDocGraph(documentId)
      const incomingNodes: unknown[] = Array.isArray(payload.nodes) ? payload.nodes : []
      const incomingEdges: unknown[] = Array.isArray(payload.edges) ? payload.edges : []
      const incomingMerges = sanitizeMergePairs(payload.merge)
      if (incomingNodes.length === 0 && incomingEdges.length === 0 && incomingMerges.length === 0) {
        return toKnowledgeGraph(graph)
      }
      let changed = false
      const byId = new Map(graph.nodes.map((node) => [node.id, node]))
      const byKey = new Map<string, GraphNode>()
      for (const node of graph.nodes) {
        const key = nodeKey(node)
        if (!byKey.has(key)) byKey.set(key, node)
      }
      const stamp = nowIso()

      for (const raw of incomingNodes) {
        if (!isObject(raw)) continue
        // Resolve the target first: an id-addressed payload is a patch and does
        // not need a label (pinning a node sends only `{ id, pinned, position }`).
        const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''
        let target = rawId !== '' && isNodeId(rawId) ? byId.get(rawId) : undefined
        let node: SanitizedNode | null = null
        if (target === undefined) {
          node = sanitizeNode(raw, {
            allowedTypes: DOC_NODE_TYPES,
            fallbackType: 'concept',
            defaultSource: 'user',
            keepId: true,
          })
          if (node === null) continue
          target = byKey.get(nodeKey(node))
        }
        if (target !== undefined) {
          // Field-by-field upsert: a missing field never resets stored data and
          // `source` is only overwritten when the caller explicitly sent one.
          if (typeof raw.label === 'string' && cleanLabel(raw.label) !== '') target.label = cleanLabel(raw.label)
          if (typeof raw.type === 'string') {
            const type = raw.type.trim().toLowerCase()
            if (DOC_NODE_TYPES.has(type)) target.type = type as GraphNodeType
          }
          if (typeof raw.summary === 'string') target.summary = boundedText(raw.summary, MAX_SUMMARY_CHARS)
          if (Array.isArray(raw.blockKeys)) target.blockKeys = sanitizeBlockKeys(raw.blockKeys)
          if (typeof raw.aspect === 'string') {
            if (isAspect(raw.aspect)) target.aspect = raw.aspect
            else delete target.aspect
          }
          if (typeof raw.weight === 'number' || typeof raw.weight === 'string') {
            target.weight = sanitizeWeight(raw.weight)
          }
          if (typeof raw.source === 'string' && SOURCES.has(raw.source.trim())) {
            target.source = raw.source.trim() as GraphNode['source']
          }
          if (raw.pinned === true) target.pinned = true
          else if (raw.pinned === false) delete target.pinned
          const position = sanitizePosition(raw.position)
          if (position !== null) target.position = position
          // Provenance of the curation itself: a user/AI edit of an AI node.
          target.curated = true
          target.updatedAt = stamp
          changed = true
          continue
        }
        if (node === null) continue
        node.source =
          typeof raw.source === 'string' && SOURCES.has(raw.source.trim())
            ? (raw.source.trim() as GraphNode['source'])
            : 'user'
        node.curated = true
        node.updatedAt = stamp
        const id = node.id === null || byId.has(node.id) ? newNodeId() : node.id
        const stored = withNodeId(node, id)
        graph.nodes.push(stored)
        byId.set(stored.id, stored)
        const key = nodeKey(stored)
        if (!byKey.has(key)) byKey.set(key, stored)
        changed = true
      }

      // Re-index labels after possible renames so edge references still resolve.
      const byLabel = new Map<string, GraphNode>()
      for (const node of graph.nodes) {
        const key = normalizeLabel(node.label)
        if (key !== '' && !byLabel.has(key)) byLabel.set(key, node)
      }
      const resolveRef = (ref: unknown): string | null => {
        const text = typeof ref === 'string' ? ref.trim() : ''
        if (text === '') return null
        const direct = byId.get(text)
        if (direct !== undefined) return direct.id
        const labelled = byLabel.get(normalizeLabel(text))
        return labelled === undefined ? null : labelled.id
      }
      const edgeByKey = new Map<string, GraphEdge>()
      for (const edge of graph.edges) edgeByKey.set(`${edge.from}|${edge.to}|${edge.type}`, edge)
      const usedEdgeIds = new Set(graph.edges.map((edge) => edge.id))

      for (const raw of incomingEdges) {
        const edge = sanitizeEdge(raw, { defaultSource: 'user', keepId: true })
        if (edge === null) continue
        const from = resolveRef(edge.from)
        const to = resolveRef(edge.to)
        if (from === null || to === null || from === to) continue
        let target = edge.id !== undefined ? graph.edges.find((item) => item.id === edge.id) : undefined
        if (target === undefined) target = edgeByKey.get(`${from}|${to}|${edge.type}`)
        if (target !== undefined) {
          target.from = from
          target.to = to
          target.type = edge.type
          if (isObject(raw) && typeof raw.source === 'string' && SOURCES.has(raw.source.trim())) {
            target.source = raw.source.trim() as GraphEdge['source']
          }
          target.weight = edge.weight
          if (edge.label !== undefined) target.label = edge.label
          changed = true
          continue
        }
        let id = edge.id !== undefined && !usedEdgeIds.has(edge.id) ? edge.id : makeEdgeId(from, to, edge.type)
        if (usedEdgeIds.has(id)) id = makeEdgeId(from, to, edge.type)
        usedEdgeIds.add(id)
        const stored: GraphEdge = {
          id,
          from,
          to,
          type: edge.type,
          source:
            isObject(raw) && typeof raw.source === 'string' && SOURCES.has(raw.source.trim())
              ? (raw.source.trim() as GraphEdge['source'])
              : 'user',
          weight: edge.weight,
        }
        if (edge.label !== undefined) stored.label = edge.label
        graph.edges.push(stored)
        edgeByKey.set(`${from}|${to}|${edge.type}`, stored)
        changed = true
      }

      // Curation merges run in the same atomic section, after the upserts so a
      // payload may rename/stitch nodes and immediately fold them.
      for (const pair of incomingMerges) {
        if (mergeGraphNodes(graph, pair.from, pair.into)) changed = true
      }

      if (!changed) return toKnowledgeGraph(graph)
      capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)
      if (graph.generatedAt === null) graph.generatedAt = nowIso()
      if (graph.model === null) graph.model = routeOf(llm)
      const title = documentTitle(documentId)
      if (graph.overview === '') graph.overview = deterministicDocumentOverview(graph, title)
      if (graph.tldr === '') graph.tldr = deterministicDocumentTldr(graph)
      if (graph.glossary.length === 0) graph.glossary = deterministicGlossary(graph)
      return toKnowledgeGraph(await writeDocGraph(documentId, graph))
    })
  }

  /**
   * Read the persisted library graph (no LLM, no side effects). Missing or
   * corrupt data reads as an empty library KG.
   *
   * @returns library KG.
   */
  async function libraryGraph(): Promise<KnowledgeGraph> {
    return toKnowledgeGraph(await readLibraryGraph())
  }

  /**
   * Rebuild the library graph from per-document graphs.
   *
   * Deterministic and curated: parsed documents (status `parsed`, oldest first)
   * become paper nodes; each paper contributes only its most representative
   * topics, cross-paper concepts are always kept, near-duplicate labels merge
   * and the library is capped at `LIB_MAX_TOPICS`.
   *
   * Frames: `progress` (reading per document → merging → done), then `graph`;
   * cancellation/failure yields one `error` frame.
   *
   * @param options - abort signal.
   * @returns frame stream.
   */
  async function* rebuildLibraryGraph(
    options: { signal?: AbortSignal | undefined } = {},
  ): AsyncGenerator<LibraryGraphFrame> {
    const signal = options.signal
    try {
      yield { type: 'progress', phase: 'reading', done: 0, total: 0 }
      const docs = listParsedDocs(store)
      const total = docs.length
      const docGraphs: GraphState[] = []
      for (let index = 0; index < docs.length; index += 1) {
        if (isAborted(signal)) {
          yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
          return
        }
        const doc = docs[index]
        if (doc === undefined) continue
        docGraphs.push(await docGraphForLibrary(doc, { store, logger: log, readMarkdown: loadMarkdown }))
        yield { type: 'progress', phase: 'reading', done: index + 1, total }
      }
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }

      yield { type: 'progress', phase: 'merging', done: 0, total: 1 }
      const graph = aggregateLibraryGraph(docs, docGraphs)

      if (docs.length > 0 && gatewayAvailable(llm)) {
        graph.model = routeOf(llm)
        try {
          const text = await completeViaGateway(llm, {
            system: LIBRARY_CONSOLIDATION_PROMPT,
            messages: [{ role: 'user', content: [{ type: 'text', text: libraryPolishPrompt(graph) }] }],
            signal,
            maxTokens: Math.min(graphConfig.graphMaxTokens, 1200),
            temperature: 0.2,
            purpose: 'graph-library-overview',
          })
          const polish = parseLibraryPolish(text)
          if (polish !== null) {
            if (polish.overview !== '') graph.overview = polish.overview
            if (polish.tldr !== '') graph.tldr = polish.tldr
          }
        } catch (error) {
          if (isAbortError(error, signal)) {
            yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
            return
          }
          logWarn(log, 'library overview polish failed; keeping deterministic overview', (error as Error)?.message ?? error)
        }
      }
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      graph.generatedAt = nowIso()
      refreshStats(graph)
      await store.writeLibraryAux(LIBRARY_GRAPH_FILE, toKnowledgeGraph(graph))
      yield { type: 'progress', phase: 'done', done: 1, total: 1 }
      yield { type: 'graph', graph: toKnowledgeGraph(graph) }
    } catch (error) {
      if (isAbortError(error, signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      const code = errorCode(error) ?? 'graph-failed'
      const message = (error as Error)?.message !== undefined && (error as Error).message !== ''
        ? (error as Error).message
        : '图谱构建失败（Graph build failed）'
      logWarn(log, 'library rebuild failed', message)
      yield { type: 'error', code, message }
    }
  }

  return { docGraph, buildDocGraph, mergeDocKnowledge, updateDocGraph, libraryGraph, rebuildLibraryGraph }
}
