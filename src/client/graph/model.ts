/**
 * Knowledge-graph model helpers for the graph scene.
 *
 * Pure, deterministic functions only: normalize the Host's JSON into the render
 * contract, filter by type/aspect, size/colour nodes, validate curation actions
 * into `GraphPatch` payloads and keep the map stable.
 *
 * The 1.0.0 implementation (`ui/graph.js`) kept these in the client bundle; 1.0.0
 * keeps the domain rules (dedupe, patch validation, pinned-position rounding)
 * while the force layout itself moves to d3-force (`./layout.ts`).
 */

import {
  ASPECTS,
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  type Aspect,
  type GraphEdgeType,
  type GraphNodeType,
} from '../../shared/constants.ts'
import type { GraphEdge, GraphNode, GraphPatch, GraphSource, KnowledgeGraph } from '../../shared/model.ts'

/** The two graph scopes: one paper's map, or the whole library. */
export type GraphScope = 'doc' | 'library'

/** A world-space point on the infinite canvas. */
export interface Point {
  x: number
  y: number
}

/** Highest/lowest persisted world coordinate (±100000, 0.1 precision). */
export const MAX_ABSOLUTE_POSITION = 100_000

/** Rename label cap (mirrors the host `GraphPatch` sanitizer). */
export const MAX_NODE_LABEL = 80

/** Render cap for one graph (server graphs are bounded, this is defensive). */
export const MAX_GRAPH_NODES = 600
export const MAX_GRAPH_EDGES = 2000

const ASPECT_SET: ReadonlySet<string> = new Set(ASPECTS)
const NODE_TYPE_SET: ReadonlySet<string> = new Set(GRAPH_NODE_TYPES)
const EDGE_TYPE_SET: ReadonlySet<string> = new Set(GRAPH_EDGE_TYPES)
const SOURCE_SET: ReadonlySet<string> = new Set(['ai-summary', 'qa', 'user', 'aggregate'])

/** 32-bit FNV-1a hex; local copy keeps this module dependency-free. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Read one unknown value as a finite number, or `null`. */
function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
}

/** Trimmed bounded string, or `''`. */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Deduplicated non-empty string list. */
function stringList(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

/** Validate and round one persisted/world position (null when unusable). */
export function curationPosition(value: unknown): Point | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as { x?: unknown; y?: unknown }
  const x = finiteNumber(record.x)
  const y = finiteNumber(record.y)
  if (x === null || y === null) return null
  const round = (number: number): number =>
    Math.round(Math.max(-MAX_ABSOLUTE_POSITION, Math.min(MAX_ABSOLUTE_POSITION, number)) * 10) / 10
  return { x: round(x), y: round(y) }
}

/** Whether a node is pinned (`pinned === true` only; truthy junk is ignored). */
export function nodeIsPinned(node: GraphNode): boolean {
  return node.pinned === true
}

/** Seed the pin map from persisted `pinned` + `position` fields. */
export function storedPins(nodes: readonly GraphNode[]): Record<string, Point> {
  const pins: Record<string, Point> = {}
  for (const node of nodes) {
    if (!nodeIsPinned(node)) continue
    const position = curationPosition(node.position)
    if (position !== null) pins[node.id] = position
  }
  return pins
}

/** Read a node id from a node object or id string. */
export function nodeIdOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value !== null && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' ? id.trim() : ''
  }
  return ''
}

/** One validated curation action turned into a `GraphPatch` (null = refuse). */
export type CurationAction = 'rename' | 'pin' | 'unpin' | 'merge'

/** Input of {@link curationPatch}: a node/id plus the action's fields. */
export interface CurationInput {
  node?: GraphNode | string
  id?: string
  label?: string
  position?: unknown
  from?: GraphNode | string
  into?: GraphNode | string
}

/**
 * Build the `graph.update` payload for one curation action (C1/C2 parity).
 *
 * - `rename` → `{ nodes: [{ id, label }] }` (label trimmed, capped at 80)
 * - `pin`    → `{ nodes: [{ id, pinned: true, position }] }`
 * - `unpin`  → `{ nodes: [{ id, pinned: false }] }`
 * - `merge`  → `{ merge: [{ from, into }] }`
 *
 * Invalid input (missing ids, empty label, same-node merge, unusable position)
 * returns `null`, so the component refuses the action instead of calling the
 * Host with junk.
 */
export function curationPatch(action: CurationAction, input: CurationInput): GraphPatch | null {
  const id = nodeIdOf(input.node) !== '' ? nodeIdOf(input.node) : nodeIdOf(input.id)
  switch (action) {
    case 'rename': {
      if (id === '') return null
      const label = text(input.label, MAX_NODE_LABEL)
      if (label === '') return null
      return { nodes: [{ id, label }] }
    }
    case 'pin': {
      if (id === '') return null
      const position = curationPosition(input.position)
      if (position === null) return null
      return { nodes: [{ id, pinned: true, position }] }
    }
    case 'unpin':
      if (id === '') return null
      return { nodes: [{ id, pinned: false }] }
    case 'merge': {
      const from = nodeIdOf(input.from !== undefined ? input.from : input.node)
      const into = nodeIdOf(input.into !== undefined ? input.into : input.id)
      if (from === '' || into === '' || from === into) return null
      // Shared 1.0.0 GraphPatch contract: `to` is the surviving node (`into`).
      return { merge: [{ from, to: into }] }
    }
    default:
      return null
  }
}

/** Merge targets for `fromId`: every other node, graph order, deduped by id. */
export function mergeCandidates(nodes: readonly GraphNode[], fromId: unknown): GraphNode[] {
  const source = nodeIdOf(fromId)
  const out: GraphNode[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    if (node.id === source || seen.has(node.id)) continue
    seen.add(node.id)
    out.push(node)
  }
  return out
}

/** Convert one unknown value to a render node (or null when unusable). */
function normalizeNode(value: unknown): GraphNode | null {
  if (value === null || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const label = text(source.label, 200)
  const type = typeof source.type === 'string' && NODE_TYPE_SET.has(source.type)
    ? (source.type as GraphNodeType)
    : 'concept'
  const id = typeof source.id === 'string' && source.id.trim() !== ''
    ? source.id.trim()
    : `n${fnv1a(`${type}\u0000${label}`)}`
  const aspect = typeof source.aspect === 'string' && ASPECT_SET.has(source.aspect)
    ? (source.aspect as Aspect)
    : undefined
  const edgeSource = typeof source.source === 'string' && SOURCE_SET.has(source.source)
    ? (source.source as GraphSource)
    : 'ai-summary'
  const weight = finiteNumber(source.weight)
  const position = curationPosition(source.position)
  const node: GraphNode = {
    id,
    type,
    label: label === '' ? id : label,
    summary: text(source.summary, 4000),
    blockKeys: stringList(source.blockKeys),
    source: edgeSource,
    weight: weight === null || weight < 0 ? 1 : Math.min(weight, 100),
  }
  const documentIds = stringList(source.documentIds, 200)
  if (documentIds.length > 0) node.documentIds = documentIds
  if (aspect !== undefined) node.aspect = aspect
  if (source.curated === true) node.curated = true
  if (source.pinned === true) node.pinned = true
  if (position !== null) node.position = position
  if (typeof source.createdAt === 'string' && source.createdAt !== '') node.createdAt = source.createdAt
  if (typeof source.updatedAt === 'string' && source.updatedAt !== '') node.updatedAt = source.updatedAt
  return node
}

/** Convert one unknown value to a render edge (or null when unusable). */
function normalizeEdge(value: unknown, byId: ReadonlyMap<string, GraphNode>): GraphEdge | null {
  if (value === null || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const from = nodeIdOf(source.from)
  const to = nodeIdOf(source.to)
  if (from === '' || to === '' || from === to) return null
  if (!byId.has(from) || !byId.has(to)) return null
  const type = typeof source.type === 'string' && EDGE_TYPE_SET.has(source.type)
    ? (source.type as GraphEdgeType)
    : 'relates'
  const label = text(source.label, 200)
  const weight = finiteNumber(source.weight)
  const id = typeof source.id === 'string' && source.id.trim() !== ''
    ? source.id.trim()
    : `e${fnv1a(`${from}\u0000${to}\u0000${type}\u0000${label}`)}`
  const edge: GraphEdge = {
    id,
    from,
    to,
    type,
    source: 'ai-summary',
    weight: weight === null || weight < 0 ? 1 : Math.min(weight, 100),
  }
  if (label !== '') edge.label = label
  return edge
}

/**
 * Normalize one knowledge graph into the render contract.
 *
 * - nodes dedupe by id (first label/summary wins; provenance arrays merge)
 * - nodes without an id get a deterministic type+label id
 * - edges dedupe by id then by endpoint+type+label; dangling/self edges drop
 * - `stats.nodes` / `stats.edges` are recomputed
 *
 * Pure: the input graph is never mutated. Accepts malformed JSON defensively.
 */
export function normalizeGraph(graph: unknown): KnowledgeGraph {
  const source: Record<string, unknown> = graph !== null && typeof graph === 'object' && !Array.isArray(graph)
    ? (graph as Record<string, unknown>)
    : {}
  const nodes: GraphNode[] = []
  const byId = new Map<string, GraphNode>()
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : []
  for (const candidate of rawNodes) {
    const node = normalizeNode(candidate)
    if (node === null) continue
    const existing = byId.get(node.id)
    if (existing !== undefined) {
      existing.blockKeys = stringList([...existing.blockKeys, ...node.blockKeys])
      existing.documentIds = stringList([...(existing.documentIds ?? []), ...(node.documentIds ?? [])])
      if (node.weight > existing.weight) existing.weight = node.weight
      if (node.pinned === true && existing.pinned !== true) {
        existing.pinned = true
        if (node.position !== undefined) existing.position = node.position
      }
      if (existing.summary === '' && node.summary !== '') existing.summary = node.summary
      continue
    }
    byId.set(node.id, node)
    nodes.push(node)
  }

  const edges: GraphEdge[] = []
  const edgeIds = new Set<string>()
  const edgeKeys = new Set<string>()
  const rawEdges = Array.isArray(source.edges) ? source.edges : []
  for (const candidate of rawEdges) {
    const edge = normalizeEdge(candidate, byId)
    if (edge === null) continue
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}\u0000${edge.label ?? ''}`
    if (edgeIds.has(edge.id) || edgeKeys.has(key)) continue
    edgeIds.add(edge.id)
    edgeKeys.add(key)
    edges.push(edge)
  }

  const scope = source.scope === 'library' ? 'library' : 'document'
  const model = source.model !== null && typeof source.model === 'object'
    ? (source.model as { provider?: unknown; model?: unknown })
    : null
  const graphOut: KnowledgeGraph = {
    version: 1,
    scope,
    generatedAt: typeof source.generatedAt === 'string' ? source.generatedAt : null,
    overview: typeof source.overview === 'string' ? source.overview : '',
    nodes,
    edges,
    stats: { nodes: nodes.length, edges: edges.length },
  }
  if (scope === 'document' && typeof source.documentId === 'string' && source.documentId !== '') {
    graphOut.documentId = source.documentId
  }
  if (model !== null && typeof model.provider === 'string' && typeof model.model === 'string') {
    graphOut.model = { provider: model.provider, model: model.model }
  }
  if (typeof source.tldr === 'string' && source.tldr !== '') graphOut.tldr = source.tldr
  if (Array.isArray(source.glossary)) {
    const glossary: Array<{ term: string; definition: string; blockKeys: string[] }> = []
    for (const entry of source.glossary) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const term = text(record.term, 120)
      if (term === '') continue
      glossary.push({ term, definition: text(record.definition, 2000), blockKeys: stringList(record.blockKeys) })
    }
    if (glossary.length > 0) graphOut.glossary = glossary
  }
  const builtAtSeq = source.stats !== null && typeof source.stats === 'object'
    ? finiteNumber((source.stats as { builtAtSeq?: unknown }).builtAtSeq)
    : null
  if (builtAtSeq !== null) graphOut.stats.builtAtSeq = Math.trunc(builtAtSeq)
  return graphOut
}

/** Options of {@link visibleGraph}. */
export interface VisibleGraphOptions {
  /** Node types to keep (`null`/empty = all). */
  types: readonly GraphNodeType[] | null
  /** Aspect filter from the shared UI store (`null` = all). */
  aspect: string | null
  /**
   * Keep structural nodes (library paper nodes) that connect to a matching
   * node, so an aspect filter never makes the library map empty.
   */
  keepStructural?: boolean
  /** Hard node cap (default {@link MAX_GRAPH_NODES}). */
  maxNodes?: number
}

/** Filtered nodes + edges (edges only between visible nodes). */
export interface VisibleGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Filter a normalized graph by type + aspect, dropping dangling edges.
 *
 * Deterministic (graph order preserved) and pure. Never re-lays-out: the map
 * animates from the positions it already has.
 */
export function visibleGraph(graph: KnowledgeGraph, options: VisibleGraphOptions): VisibleGraph {
  const typeSet = options.types !== null && options.types.length > 0 ? new Set<string>(options.types) : null
  const aspect = options.aspect !== null && ASPECT_SET.has(options.aspect) ? options.aspect : null
  const kept: GraphNode[] = []
  const keptIds = new Set<string>()
  const structural: GraphNode[] = []
  for (const node of graph.nodes) {
    if (typeSet !== null && !typeSet.has(node.type)) continue
    if (aspect !== null && node.aspect !== aspect) {
      if (options.keepStructural === true && (node.type === 'paper' || node.type === 'section')) structural.push(node)
      continue
    }
    if (kept.length >= (options.maxNodes ?? MAX_GRAPH_NODES)) break
    kept.push(node)
    keptIds.add(node.id)
  }
  // Keep structural nodes that actually connect to a matching node.
  if (structural.length > 0) {
    const linked = new Set<string>()
    for (const edge of graph.edges) {
      if (keptIds.has(edge.from) && structural.some((node) => node.id === edge.to)) linked.add(edge.to)
      if (keptIds.has(edge.to) && structural.some((node) => node.id === edge.from)) linked.add(edge.from)
    }
    for (const node of structural) {
      if (linked.has(node.id) && !keptIds.has(node.id) && kept.length < (options.maxNodes ?? MAX_GRAPH_NODES)) {
        kept.push(node)
        keptIds.add(node.id)
      }
    }
  }
  const edges: GraphEdge[] = []
  for (const edge of graph.edges) {
    if (!keptIds.has(edge.from) || !keptIds.has(edge.to)) continue
    edges.push(edge)
    if (edges.length >= MAX_GRAPH_EDGES) break
  }
  return { nodes: kept, edges }
}

/**
 * Cap the rendered edge count while keeping the focused node's edges visible.
 *
 * Dense relation layers stay legible: the selected node keeps every incident
 * edge (up to `max`), then document order fills the remaining budget.
 */
export function limitEdges(
  edges: readonly GraphEdge[],
  max: number = MAX_GRAPH_EDGES,
  focusId: string | null = null,
): GraphEdge[] {
  if (edges.length <= max) return edges.slice()
  if (focusId === null || focusId === '') return edges.slice(0, max)
  const focused: GraphEdge[] = []
  const rest: GraphEdge[] = []
  for (const edge of edges) {
    if (edge.from === focusId || edge.to === focusId) focused.push(edge)
    else rest.push(edge)
  }
  return focused.slice(0, max).concat(rest.slice(0, Math.max(0, max - Math.min(focused.length, max))))
}

/** Radius of one node on the canvas (screen px at zoom 1). */
export function nodeRadius(node: GraphNode, scope: GraphScope): number {
  if (node.type === 'paper') return scope === 'library' ? 16 : 12
  if (node.type === 'topic') return 11
  if (node.type === 'section') return 7
  if (node.type === 'question') return 8
  if (node.type === 'concept' || node.type === 'insight') return 10
  return 9
}

/** Ink token name for one node: paper nodes are ink, aspect nodes their aspect. */
export function nodeInk(node: GraphNode): 'ink' | Aspect {
  if (node.type === 'paper' || node.type === 'section') return 'ink'
  if (node.aspect !== undefined && ASPECT_SET.has(node.aspect)) return node.aspect
  return 'ink'
}

/** Edge stroke distance used by the force layout (shorter = tighter cluster). */
export function linkDistance(type: GraphEdgeType): number {
  if (type === 'mentions' || type === 'shares') return 100
  if (type === 'part_of') return 60
  if (type === 'defines') return 70
  if (type === 'contradicts') return 110
  return 85
}

/** Node type order used by filters/legends (constants order, only present types). */
export function presentNodeTypes(nodes: readonly GraphNode[]): GraphNodeType[] {
  const present = new Set<string>(nodes.map((node) => node.type))
  return GRAPH_NODE_TYPES.filter((type) => present.has(type))
}

/** Node counts per type (context-bar chip badges). */
export function nodeTypeCounts(nodes: readonly GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of nodes) counts[node.type] = (counts[node.type] ?? 0) + 1
  return counts
}

/** Aspect counts of aspect-bearing nodes (legend badges). */
export function nodeAspectCounts(nodes: readonly GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of nodes) {
    if (node.aspect !== undefined) counts[node.aspect] = (counts[node.aspect] ?? 0) + 1
  }
  return counts
}
