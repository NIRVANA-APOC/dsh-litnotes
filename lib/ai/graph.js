/**
 * Knowledge-graph engine for dsh-litnotes (docs/AI-SPEC.md §2, §3, §5).
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
 *   graph gets `paper -mentions-> topic` edges, weighted topic co-occurrence
 *   `relates` edges, connected-component clusters and a deterministic overview.
 *   One optional LLM call may polish that overview.
 *
 * Design rules honoured here:
 * - plain ESM, `node:` builtins + `ui/markdown.js` only, no npm dependencies;
 * - the LLM gateway is injected (`completeText` / `streamText`) — this module
 *   never imports another `lib/ai/*` module and never talks to the Host `llm`
 *   service directly;
 * - all persistence goes through the store aux API
 *   (`readAux`/`writeAux`/`readLibraryAux`/`writeLibraryAux`);
 * - malformed model JSON skips the chunk and continues; cancellation is
 *   checked between every await and forwarded to the model;
 * - ids are stable across merges (existing id wins) and library ids are
 *   content-derived so rebuilding does not reshuffle the graph.
 *
 * @module lib/ai/graph
 */
import { createHash, randomUUID } from 'node:crypto'
import { parseMarkdown, plainTextOfBlock } from '../../ui/markdown.js'

/** Per-document aux file name (docs/AI-SPEC.md §2). */
const GRAPH_FILE = 'graph.json'
/** Library-level aux file name. */
const LIBRARY_GRAPH_FILE = 'library-graph.json'

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
const LIB_TOPIC_TYPE_VALUE = {
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
 * World-pixel bound for a manually pinned node position (docs/AI-SPEC.md §4):
 * the client canvas is unbounded, so positions may be negative and far outside
 * the seeded layout sheet; ±100000 is a finite persistence ceiling.
 */
const MAX_NODE_POSITION = 100000
/** How many merge pairs one `updateDocGraph` call accepts (defensive bound). */
const MAX_NODE_MERGES = 100
/** Summary / glossary bounds. */
const MAX_TLDR_ITEMS = 5
const MAX_GLOSSARY_ITEMS = 40
const MAX_OUTLINE_HEADINGS = 60
const MAX_OUTLINE_CHARS = 3000
/** Fence tags (docs/AI-SPEC.md §5). */
const GRAPH_FENCE = 'litnotes-graph'
const SUMMARY_FENCE = 'litnotes-summary'

/** Node types allowed in a document graph. */
const DOC_NODE_TYPES = new Set([
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
const LIBRARY_NODE_TYPES = new Set(['paper', 'topic'])
/** Edge types allowed by the KG contract. */
const EDGE_TYPES = new Set([
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
/** Aspects accepted on nodes (mirrors lib/ai/aspects.js, injected-by-contract). */
const ASPECTS = new Set(['definition', 'method', 'result', 'limitation', 'context'])
/** Provenance sources. */
const SOURCES = new Set(['ai-summary', 'qa', 'user', 'aggregate'])
/** Document node types that become library topics (headings/questions are noise there). */
const TOPIC_TYPES = new Set(['concept', 'method', 'finding', 'definition', 'limitation', 'insight'])

/** Extraction system prompt (local: graph.js may not import lib/ai/prompts.js). */
const GRAPH_EXTRACTION_SYSTEM = [
  'You build the knowledge graph of an academic paper for a literature reading desk.',
  'You receive one chunk of the paper (a few sections or paragraphs). Extract the concepts,',
  'methods, findings, definitions, limitations and section structure that matter for understanding',
  'the paper, and the relations between them.',
  '',
  'Output ONLY one fenced block with tag litnotes-graph containing JSON:',
  '',
  '```litnotes-graph',
  '{',
  '  "nodes": [',
  '    { "type": "method", "label": "sparse attention", "summary": "1-2 sentences",',
  '      "blockKeys": ["b12:ab12cd34"], "aspect": "method" }',
  '  ],',
  '  "edges": [ { "from": "sparse attention", "to": "long-range dependency", "type": "supports" } ]',
  '}',
  '```',
  '',
  'Rules:',
  '- Only extract knowledge explicitly present in this chunk; never use outside knowledge.',
  '- "blockKeys" must be copied exactly from [[…]] markers in the chunk (0-3 per node).',
  '- Node types: concept, method, finding, definition, limitation, section, question, insight.',
  '- Edge types: defines, uses, supports, contradicts, part_of, leads_to, evolves_from, relates.',
  '- Labels are short (<= 80 characters), concrete and deduplicated (reuse the same wording).',
  '- "summary" is 1-2 sentences explaining the concept in the context of this paper.',
  '- "aspect" is optional: definition, method, result, limitation or context.',
  '- At most 20 nodes and 30 edges. If the chunk has no meaningful knowledge, return empty arrays.',
  '- No markdown, no explanation, no text outside the fenced JSON block.',
].join('\n')

/** Document summary system prompt. */
const GRAPH_SUMMARY_SYSTEM = [
  'You summarize the knowledge graph of one academic paper for a literature reading desk.',
  'You receive the paper title, the extracted graph nodes (labels, types, summaries, block keys)',
  'and the edge list. Write a compact orientation for the reader.',
  '',
  'Output ONLY one fenced block with tag litnotes-summary containing JSON:',
  '',
  '```litnotes-summary',
  '{',
  '  "overview": "2-4 short paragraphs of Markdown about the paper, its approach and its result.",',
  '  "tldr": ["3-5 one-sentence bullets with the most important takeaways"],',
  '  "glossary": [ { "term": "exact term", "definition": "1-2 sentences",',
  '                  "blockKeys": ["b12:ab12cd34"] } ]',
  '}',
  '```',
  '',
  'Rules:',
  '- Ground every statement in the supplied nodes and edges; never add outside facts.',
  '- "overview" is Markdown, at most ~250 words, in the language of the paper.',
  '- "tldr" has 3-5 single-sentence bullets.',
  '- "glossary" lists 4-10 key technical terms; reuse the supplied block keys when available.',
  '- No text outside the fenced JSON block.',
].join('\n')

/** Optional library overview polish prompt (deterministic aggregate is supplied). */
const LIBRARY_SUMMARY_SYSTEM = [
  'You summarize a local literature library for a reading desk. You receive deterministic',
  'aggregates: the paper titles, the dominant topics with their paper counts, and the topic',
  'clusters. Write a short orientation of what this library is about.',
  '',
  'Rules:',
  '- Output ONLY Markdown: one short paragraph plus 3-6 bullet points naming the main directions',
  '  of the library and the papers that exemplify them.',
  '- Ground every statement in the supplied aggregates. Never invent papers, authors, years,',
  '  venues or topics that are not in the input.',
  '- Keep it under ~200 words. Use the language of the supplied paper titles/topics.',
  '- No fence, no JSON, no preamble such as "Here is".',
].join('\n')

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Whether a value is a plain non-array object. */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Clamp a finite integer into range, returning `fallback` for invalid input. */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Clamp a finite number into range, returning `fallback` for invalid input. */
function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Trim, collapse whitespace and cap a model/user supplied string. */
function boundedText(value, maxChars) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text
}

/** Clean a node label: collapsed whitespace, max 80 chars, non-empty. */
function cleanLabel(value) {
  return boundedText(value, MAX_LABEL_CHARS)
}

/**
 * Normalize a label for merge/dedupe: NFKC, case-folded, punctuation stripped,
 * whitespace collapsed. Keeps CJK characters (no word segmentation needed).
 */
function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Merge key for document nodes: normalized label + exact type. */
function nodeKey(node) {
  return `${node.type}|${normalizeLabel(node.label)}`
}

/** Current ISO timestamp. */
function nowIso() {
  return new Date().toISOString()
}

/** Keep a plausible stored ISO string, otherwise use now. */
function isoOrNow(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : nowIso()
}

/** Deterministic short id fragment for content-derived library ids. */
function hashId(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 12)
}

/** New random graph node id. */
function newNodeId() {
  return `n-${randomUUID()}`
}

/** Deterministic edge id from its canonical endpoints + type. */
function makeEdgeId(from, to, type) {
  return `e-${hashId(`${from}|${to}|${type}`)}`
}

/** Deterministic library paper node id. */
function paperNodeId(documentId) {
  return `n-paper-${hashId(documentId)}`
}

/** Deterministic library topic node id. */
function topicNodeId(normalizedLabelValue) {
  return `n-topic-${hashId(normalizedLabelValue)}`
}

/** Whether a value looks like a graph node id. */
function isNodeId(value) {
  return typeof value === 'string' && /^n-[A-Za-z0-9_-]{1,120}$/.test(value.trim())
}

/** Whether a value looks like a graph edge id. */
function isEdgeId(value) {
  return typeof value === 'string' && /^e-[A-Za-z0-9_-]{1,120}$/.test(value.trim())
}

/** Whether an AbortSignal is aborted. */
function isAborted(signal) {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/** Whether an error represents cancellation. */
function isAbortError(error, signal) {
  if (isAborted(signal)) return true
  const name = typeof error?.name === 'string' ? error.name : ''
  const code = typeof error?.code === 'string' ? error.code : ''
  return name === 'AbortError' || code === 'ABORT_ERR' || code === 'aborted'
}

/** Safely log through the injected logger (never throws, never leaks prompts). */
function logWarn(logger, message, detail) {
  try {
    if (typeof logger?.warn === 'function') logger.warn(`[dsh-litnotes] graph: ${message}`, detail)
  } catch {
    /* logging must never break the graph build */
  }
}

/** Normalize the `ai` config block with the documented defaults. */
function resolveGraphConfig(config) {
  const ai = isObject(config?.ai) ? config.ai : {}
  return {
    maxGraphChunks: clampInt(ai.maxGraphChunks, 1, 40, 12),
    maxGraphSourceChars: clampInt(ai.maxGraphSourceChars, 1000, 1000000, 160000),
    graphMaxTokens: clampInt(ai.graphMaxTokens, 128, 8192, 3000),
    graphSummaryChars: clampInt(ai.graphSummaryChars, 256, 64000, 4000),
  }
}

/* -------------------------------------------------------------------------- */
/* KG shape helpers                                                            */
/* -------------------------------------------------------------------------- */

/** An empty document-scope KG. */
function emptyDocumentGraph(documentId) {
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
function emptyLibraryGraph() {
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

/** Sanitize a stored/generated `model` field. */
function sanitizeModel(raw) {
  if (!isObject(raw)) return null
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider, model }
}

/** Sanitize block keys, optionally restricted to the keys present in one chunk. */
function sanitizeBlockKeys(raw, knownBlockKeys) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const key = value.trim()
    if (key === '' || key.length > 120 || seen.has(key)) continue
    if (knownBlockKeys instanceof Set && !knownBlockKeys.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_BLOCK_KEYS) break
  }
  return out
}

/** Sanitize a node weight (default 1, bounded). */
function sanitizeWeight(value) {
  return clampNumber(value, 0.1, 1000, 1)
}

/** Round one SVG user-space coordinate to 0.1 precision. */
function roundTenth(value) {
  return Math.round(value * 10) / 10
}

/**
 * Sanitize a manually pinned node position: finite numbers only, clamped into
 * `[-MAX_NODE_POSITION, MAX_NODE_POSITION]` on both axes and rounded to 0.1
 * (the layout's precision). Anything else is dropped rather than persisted.
 *
 * @param {unknown} raw - candidate `{ x, y }`.
 * @returns {{ x: number, y: number } | null} the sanitized position or null.
 */
function sanitizePosition(raw) {
  if (!isObject(raw)) return null
  const x = clampNumber(raw.x, -MAX_NODE_POSITION, MAX_NODE_POSITION, NaN)
  const y = clampNumber(raw.y, -MAX_NODE_POSITION, MAX_NODE_POSITION, NaN)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: roundTenth(x), y: roundTenth(y) }
}

/** Sanitize a node from model output or from disk. */
function sanitizeNode(raw, options = {}) {
  if (!isObject(raw)) return null
  const label = cleanLabel(raw.label)
  if (label === '') return null
  const allowedTypes = options.allowedTypes instanceof Set ? options.allowedTypes : DOC_NODE_TYPES
  const fallbackType = typeof options.fallbackType === 'string' ? options.fallbackType : 'concept'
  const rawType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  const type = allowedTypes.has(rawType) ? rawType : fallbackType
  const source = SOURCES.has(raw.source) ? raw.source : options.defaultSource ?? 'ai-summary'
  const node = {
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
    ? [...new Set(raw.documentIds.filter((value) => typeof value === 'string' && value.trim() !== ''))]
        .slice(0, 50)
    : []
  if (documentIds.length > 0) node.documentIds = documentIds
  if (typeof raw.aspect === 'string' && ASPECTS.has(raw.aspect)) node.aspect = raw.aspect
  // Curation provenance (docs/AI-SPEC.md §4 C1): user-edited AI nodes are marked
  // `curated`; manually pinned nodes keep their SVG position across rebuilds.
  if (raw.curated === true) node.curated = true
  if (raw.pinned === true) node.pinned = true
  const position = sanitizePosition(raw.position)
  if (position !== null) node.position = position
  return node
}

/** Sanitize an edge from model output or from disk. */
function sanitizeEdge(raw, options = {}) {
  if (!isObject(raw)) return null
  const from = typeof raw.from === 'string' ? raw.from.trim() : ''
  const to = typeof raw.to === 'string' ? raw.to.trim() : ''
  if (from === '' || to === '') return null
  const rawType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  const type = EDGE_TYPES.has(rawType) ? rawType : 'relates'
  const edge = {
    from,
    to,
    type,
    source: SOURCES.has(raw.source) ? raw.source : options.defaultSource ?? 'ai-summary',
    weight: clampNumber(raw.weight, 0.1, 10000, 1),
  }
  if (options.keepId !== false && isEdgeId(raw.id)) edge.id = raw.id.trim()
  const label = boundedText(raw.label, MAX_EDGE_LABEL_CHARS)
  if (label !== '') edge.label = label
  return edge
}

/** Sort nodes by importance then label (stable, used for summaries). */
function rankNodes(nodes) {
  return [...nodes].sort(
    (left, right) => (right.weight ?? 1) - (left.weight ?? 1) || String(left.label).localeCompare(String(right.label)),
  )
}

/** Recompute `stats` after any mutation. */
function refreshStats(graph) {
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
function capGraph(graph, maxNodes, maxEdges) {
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

/** Dedupe edges by canonical from/to/type key (first id wins). */
function dedupeEdges(edges) {
  const seen = new Set()
  const out = []
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}

/** Sanitize a glossary array (bounded, block-key validated against `knownKeys`). */
function sanitizeGlossary(raw, knownKeys) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const term = cleanLabel(item.term)
    const definition = boundedText(item.definition, MAX_SUMMARY_CHARS)
    if (term === '' || definition === '') continue
    out.push({
      term,
      definition,
      blockKeys: sanitizeBlockKeys(item.blockKeys, knownKeys),
    })
    if (out.length >= MAX_GLOSSARY_ITEMS) break
  }
  return out
}

/** Build a fresh document graph from the persisted aux JSON. */
function normalizeDocumentGraph(raw, documentId) {
  const graph = emptyDocumentGraph(documentId)
  if (!isObject(raw)) return graph
  graph.generatedAt = typeof raw.generatedAt === 'string' && raw.generatedAt !== '' ? raw.generatedAt : null
  graph.model = sanitizeModel(raw.model)
  graph.overview = typeof raw.overview === 'string' ? raw.overview : ''
  graph.tldr = typeof raw.tldr === 'string' ? raw.tldr : ''
  graph.glossary = sanitizeGlossary(raw.glossary)
  const seenIds = new Set()
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const node = sanitizeNode(item, {
      allowedTypes: DOC_NODE_TYPES,
      fallbackType: 'concept',
      defaultSource: 'ai-summary',
      keepId: true,
    })
    if (node === null) continue
    if (node.id === null || seenIds.has(node.id)) node.id = newNodeId()
    seenIds.add(node.id)
    graph.nodes.push(node)
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const seenEdges = new Set()
  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    const edge = sanitizeEdge(item, { defaultSource: 'ai-summary', keepId: true })
    if (edge === null || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    if (!edge.id) edge.id = makeEdgeId(edge.from, edge.to, edge.type)
    graph.edges.push(edge)
  }
  refreshStats(graph)
  return graph
}

/** Sanitize stored cluster entries against the surviving topic ids. */
function sanitizeClusters(raw, topicIds) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const nodeIds = Array.isArray(item.nodeIds)
      ? [...new Set(item.nodeIds.filter((id) => typeof id === 'string' && topicIds.has(id)))]
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
function normalizeLibraryGraph(raw) {
  const graph = emptyLibraryGraph()
  if (!isObject(raw)) return graph
  graph.generatedAt = typeof raw.generatedAt === 'string' && raw.generatedAt !== '' ? raw.generatedAt : null
  graph.model = sanitizeModel(raw.model)
  graph.overview = typeof raw.overview === 'string' ? raw.overview : ''
  graph.tldr = typeof raw.tldr === 'string' ? raw.tldr : ''
  graph.glossary = sanitizeGlossary(raw.glossary)
  const seenIds = new Set()
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const node = sanitizeNode(item, {
      allowedTypes: LIBRARY_NODE_TYPES,
      fallbackType: 'topic',
      defaultSource: 'aggregate',
      keepId: true,
    })
    if (node === null) continue
    if (node.id === null || seenIds.has(node.id)) node.id = newNodeId()
    seenIds.add(node.id)
    graph.nodes.push(node)
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const seenEdges = new Set()
  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    const edge = sanitizeEdge(item, { defaultSource: 'aggregate', keepId: true })
    if (edge === null || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    if (!edge.id) edge.id = makeEdgeId(edge.from, edge.to, edge.type)
    graph.edges.push(edge)
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
function limitSource(markdown, maxSourceChars) {
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
function extractHeadingText(text) {
  const out = []
  const seen = new Set()
  const pattern = /^[ \t]{0,3}(#{1,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm
  let match
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

/**
 * Split a parser model into heading-scoped sections. Each section keeps the
 * heading block plus its content blocks so the chunk prompt carries provenance.
 */
function buildSections(model) {
  const blocks = Array.isArray(model?.blocks) ? model.blocks : []
  const sections = []
  let current = { heading: '', level: 0, blocks: [] }
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.kind === 'page' || block.kind === 'rule' || block.kind === 'figure') continue
    const text = plainTextOfBlock(block).trim()
    if (text === '') continue
    if (block.kind === 'heading') {
      if (current.blocks.length > 0) sections.push(current)
      current = { heading: text, level: block.level ?? 1, blocks: [block] }
      continue
    }
    current.blocks.push(block)
  }
  if (current.blocks.length > 0) sections.push(current)
  return sections
}

/** Render one block as a `[[key]] text` prompt line. */
function blockLine(block) {
  const text = plainTextOfBlock(block).trim()
  if (text === '') return ''
  const key = typeof block.key === 'string' ? block.key : ''
  return `[[${key}]] ${text}`
}

/** A blank chunk accumulator. */
function blankChunk() {
  return { lines: [], blockKeys: [], headings: [], chars: 0 }
}

/** Append one rendered block line to a chunk. */
function appendBlock(chunk, block) {
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
function rememberHeading(chunk, heading) {
  if (heading === '') return
  if (chunk.headings.length >= 3) return
  if (!chunk.headings.includes(heading)) chunk.headings.push(heading)
}

/** Build a single chunk holding one whole section. */
function chunkSection(section) {
  const chunk = blankChunk()
  rememberHeading(chunk, section.heading)
  for (const block of section.blocks) appendBlock(chunk, block)
  return chunk
}

/** Split an oversized section at block boundaries, repeating the heading. */
function splitSection(section) {
  const pieces = []
  const headingBlock = section.blocks[0] !== undefined && section.blocks[0].kind === 'heading' ? section.blocks[0] : null
  let chunk = null
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
function groupSections(sections) {
  const chunks = []
  let current = null
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
function pickEvenly(chunks, max) {
  if (chunks.length <= max) return chunks
  if (max <= 1) return [chunks[0]]
  const picked = []
  for (let index = 0; index < max; index += 1) {
    const position = Math.round((index * (chunks.length - 1)) / (max - 1))
    if (!picked.includes(chunks[position])) picked.push(chunks[position])
  }
  return picked
}

/**
 * Chunk a document: section-aware groups of ~3500 chars, capped by
 * `maxGraphSourceChars` (first N chars + section headings from the rest) and by
 * `maxGraphChunks` (deterministic even sampling, so each model call stays small).
 */
function chunkDocument(markdown, config) {
  const source = limitSource(markdown, config.maxGraphSourceChars)
  if (source.trim() === '') return []
  const model = parseMarkdown(source)
  const sections = buildSections(model)
  let chunks = groupSections(sections)
  if (chunks.length === 0) {
    // Defensive fallback: a parseable non-empty document must still be readable.
    const fallback = blankChunk()
    fallback.lines.push(source.slice(0, CHUNK_TARGET_CHARS))
    fallback.chars = fallback.lines[0].length
    chunks = [fallback]
  }
  chunks = pickEvenly(chunks, config.maxGraphChunks)
  chunks.forEach((chunk, index) => {
    chunk.index = index + 1
    chunk.total = chunks.length
    chunk.section = chunk.headings.join(' · ')
  })
  return chunks
}

/* -------------------------------------------------------------------------- */
/* Fenced JSON parsing                                                        */
/* -------------------------------------------------------------------------- */

/** Extract the payload of the first fenced block with `tag` (or any fence). */
function extractFence(text, tag) {
  const source = typeof text === 'string' ? text : ''
  if (source === '') return ''
  const tagged = new RegExp('```' + tag + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'i').exec(source)
  if (tagged !== null) return tagged[1]
  const anyFence = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/.exec(source)
  if (anyFence !== null) return anyFence[1]
  return source
}

/** Parse a JSON object out of loose model text; null when nothing parses. */
function parseLooseJson(text) {
  if (isObject(text)) return text
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return null
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  try {
    const parsed = JSON.parse(source.slice(first, last + 1))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Parse one graph extraction response into `{ nodes, edges }`. */
function parseGraphPayload(text) {
  const payload = parseLooseJson(extractFence(text, GRAPH_FENCE))
  if (payload === null) return null
  if (!Array.isArray(payload.nodes) && !Array.isArray(payload.edges)) return null
  return {
    nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
    edges: Array.isArray(payload.edges) ? payload.edges : [],
  }
}

/** Convert a model `tldr` value into the KG's markdown-bullet string shape. */
function tldrToString(value) {
  if (Array.isArray(value)) {
    const items = []
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

/** Parse one summary response into `{ overview, tldr, glossary }` or null. */
function parseSummaryPayload(text, knownKeys) {
  const payload = parseLooseJson(extractFence(text, SUMMARY_FENCE))
  if (payload === null) return null
  const overview = typeof payload.overview === 'string' ? payload.overview.trim() : ''
  const tldr = tldrToString(payload.tldr)
  const glossary = sanitizeGlossary(payload.glossary, knownKeys)
  if (overview === '' && tldr === '' && glossary.length === 0) return null
  return { overview, tldr, glossary }
}

/** Parse the optional library overview polish (Markdown or a summary fence). */
function parseLibraryPolish(text) {
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

/** User prompt for one extraction chunk. */
function extractionPrompt(chunk, meta) {
  const title = boundedText(meta.title, 300)
  const section = boundedText(chunk.section, 200)
  const lines = []
  if (title !== '') lines.push(`Paper: ${title}`)
  if (section !== '') lines.push(`Section: ${section}`)
  lines.push(`Chunk: ${chunk.index} of ${chunk.total}`)
  lines.push('', 'Chunk text (citation keys are the [[…]] markers):')
  lines.push(...chunk.lines)
  lines.push('', 'Extract the knowledge graph for this chunk and return only the fenced litnotes-graph JSON block.')
  return lines.join('\n')
}

/** Compact, bounded graph rendering used by the summary prompt. */
function compactGraph(graph, maxChars) {
  const lines = []
  let used = 0
  const push = (line) => {
    if (used + line.length + 1 > maxChars) return false
    lines.push(line)
    used += line.length + 1
    return true
  }
  const nodes = rankNodes(graph.nodes)
  const labels = new Map()
  for (const node of nodes) labels.set(node.id, node.label)
  for (const node of nodes) {
    const summary = node.summary === '' ? '' : `: ${node.summary}`
    const keys = node.blockKeys.length === 0 ? '' : ` (${node.blockKeys.join(' ')})`
    if (!push(`- [${node.type}] ${node.label}${summary}${keys}`)) break
  }
  for (const edge of graph.edges) {
    const from = labels.get(edge.from) ?? edge.from
    const to = labels.get(edge.to) ?? edge.to
    if (!push(`- ${from} -[${edge.type}]-> ${to}`)) break
  }
  return lines.join('\n')
}

/** User prompt for the document overview / TL;DR / glossary pass. */
function summaryPrompt(graph, meta, config) {
  const title = boundedText(meta.title, 300)
  const lines = []
  if (title !== '') lines.push(`Paper: ${title}`)
  lines.push('', 'Extracted graph (bounded):')
  lines.push(compactGraph(graph, config.graphSummaryChars))
  lines.push('', 'Write the document summary as the fenced litnotes-summary JSON block.')
  return lines.join('\n')
}

/** User prompt for the optional library overview polish. */
function libraryPolishPrompt(graph, config) {
  const papers = graph.nodes.filter((node) => node.type === 'paper')
  const topics = rankNodes(graph.nodes.filter((node) => node.type === 'topic')).slice(0, 40)
  const lines = ['Deterministic overview (baseline):', graph.overview, '', 'Papers:']
  for (const paper of papers.slice(0, 60)) lines.push(`- ${paper.label}`)
  lines.push('', 'Topics (label — paper count):')
  for (const topic of topics) {
    const count = Array.isArray(topic.documentIds) ? topic.documentIds.length : 1
    lines.push(`- ${topic.label} — ${count} paper(s)`)
  }
  lines.push('', 'Write the Markdown library overview.')
  const prompt = lines.join('\n')
  return prompt.length > config.graphSummaryChars ? `${prompt.slice(0, config.graphSummaryChars)}…` : prompt
}

/* -------------------------------------------------------------------------- */
/* Deterministic summaries                                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic document overview; always usable when the model fails. */
function deterministicDocumentOverview(graph, title) {
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
function deterministicDocumentTldr(graph) {
  if (graph.nodes.length === 0) return '- No concepts were extracted from this document yet.'
  return rankNodes(graph.nodes)
    .slice(0, MAX_TLDR_ITEMS)
    .map((node) => `- **${node.label}**: ${node.summary === '' ? node.type : node.summary}`)
    .join('\n')
}

/** Deterministic glossary from `definition` nodes. */
function deterministicGlossary(graph) {
  return rankNodes(graph.nodes.filter((node) => node.type === 'definition'))
    .slice(0, MAX_GLOSSARY_ITEMS)
    .map((node) => ({ term: node.label, definition: node.summary, blockKeys: node.blockKeys.slice(0, 4) }))
    .filter((item) => item.definition !== '')
}

/** Deterministic library overview (topics, clusters, papers). */
function deterministicLibraryOverview(graph) {
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
      lines.push(`- **${topic.label}** — shared by ${topic.documentIds.length} papers`)
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
function deterministicLibraryTldr(graph) {
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
  if (topics.length > 0) {
    lines.push(`- Most representative: **${topics[0].label}** (${topics[0].documentIds?.length ?? 1} paper(s)).`)
  }
  const strongest = [...relations].sort((left, right) => (right.weight ?? 1) - (left.weight ?? 1))[0]
  if (strongest !== undefined) {
    const labelOf = (id) => topics.find((topic) => topic.id === id)?.label ?? id
    lines.push(`- Strongest link: **${labelOf(strongest.from)}** — **${labelOf(strongest.to)}** (${strongest.type}).`)
  }
  if (clusters.length > 0) {
    lines.push(`- ${clusters.length} topic cluster${clusters.length === 1 ? '' : 's'}; the largest has ${clusters[0].size} topics.`)
  }
  return lines.slice(0, MAX_TLDR_ITEMS).join('\n')
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                      */
/* -------------------------------------------------------------------------- */

/** Union two string arrays without duplicates (left order first). */
function unionStrings(left, right, max) {
  const out = []
  const seen = new Set()
  for (const value of [...left, ...right]) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

/** Merge a node into an existing node (existing id, provenance and text win). */
function mergeNodeFields(existing, incoming, options = {}) {
  existing.blockKeys = unionStrings(existing.blockKeys ?? [], incoming.blockKeys ?? [], MAX_BLOCK_KEYS)
  if (incoming.documentIds !== undefined) {
    existing.documentIds = unionStrings(existing.documentIds ?? [], incoming.documentIds, 50)
  }
  if (existing.aspect === undefined && incoming.aspect !== undefined) existing.aspect = incoming.aspect
  if (incoming.source === 'user') existing.source = 'user'
  if (options.preserveCurated === true && incoming.curated === true) {
    // A forced rebuild must keep the curated node's identity and place: the
    // user-edited label/summary/position beat re-extracted values (docs/AI-SPEC §4).
    existing.label = incoming.label
    if (incoming.summary !== '') existing.summary = incoming.summary
    existing.curated = true
    if (incoming.aspect !== undefined) existing.aspect = incoming.aspect
    if (incoming.pinned === true) existing.pinned = true
    if (incoming.position !== undefined) existing.position = { ...incoming.position }
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

/**
 * Merge a `{ nodes, edges }` delta into a document graph.
 *
 * - nodes dedupe by id first, then by normalized label + type; the existing id
 *   is preserved and incoming edge references are remapped to it;
 * - edge labels/ids may reference either a node id or a node label; unknown
 *   references create a concept/insight placeholder node first (AI-SPEC §5);
 * - edges dedupe by `from|to|type`.
 *
 * @returns {{ nodes: string[], edges: string[] }} ids added (for diagnostics).
 */
function mergeDeltaIntoGraph(graph, delta, options = {}) {
  const opts = {
    defaultSource: options.defaultSource ?? 'ai-summary',
    allowedTypes: options.allowedTypes ?? DOC_NODE_TYPES,
    fallbackType: options.fallbackType ?? 'concept',
    knownBlockKeys: options.knownBlockKeys,
    incrementWeight: options.incrementWeight === true,
    preserveCurated: options.preserveCurated === true,
  }
  const byId = new Map()
  const byKey = new Map()
  const byLabel = new Map()
  const usedEdgeIds = new Set()
  for (const node of graph.nodes) {
    byId.set(node.id, node)
    const key = nodeKey(node)
    if (!byKey.has(key)) byKey.set(key, node)
    const labelKey = normalizeLabel(node.label)
    if (labelKey !== '' && !byLabel.has(labelKey)) byLabel.set(labelKey, node)
  }
  for (const edge of graph.edges) usedEdgeIds.add(edge.id)

  const remap = new Map()
  const addedNodes = []

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
    if (node.id === null || byId.has(node.id)) {
      const generated = newNodeId()
      if (isObject(raw) && typeof raw.id === 'string' && raw.id.trim() !== '') remap.set(raw.id.trim(), generated)
      node.id = generated
    }
    graph.nodes.push(node)
    byId.set(node.id, node)
    const key = nodeKey(node)
    if (!byKey.has(key)) byKey.set(key, node)
    const labelKey = normalizeLabel(node.label)
    if (labelKey !== '' && !byLabel.has(labelKey)) byLabel.set(labelKey, node)
    addedNodes.push(node.id)
  }

  /** Resolve an edge endpoint (id or label) to a node id, creating a placeholder. */
  const resolveRef = (ref) => {
    const text = typeof ref === 'string' ? ref.trim() : ''
    if (text === '') return null
    if (remap.has(text)) return remap.get(text)
    const direct = byId.get(text)
    if (direct !== undefined) return direct.id
    const labelKey = normalizeLabel(text)
    if (labelKey === '') return null
    const labelled = byLabel.get(labelKey)
    if (labelled !== undefined) return labelled.id
    const placeholder = sanitizeNode(
      { type: opts.fallbackType, label: text, summary: '', source: opts.defaultSource },
      {
        allowedTypes: opts.allowedTypes,
        fallbackType: opts.fallbackType,
        defaultSource: opts.defaultSource,
      },
    )
    if (placeholder === null) return null
    placeholder.id = newNodeId()
    graph.nodes.push(placeholder)
    byId.set(placeholder.id, placeholder)
    const key = nodeKey(placeholder)
    if (!byKey.has(key)) byKey.set(key, placeholder)
    byLabel.set(normalizeLabel(placeholder.label), placeholder)
    addedNodes.push(placeholder.id)
    return placeholder.id
  }

  const edgeByKey = new Map()
  for (const edge of graph.edges) edgeByKey.set(`${edge.from}|${edge.to}|${edge.type}`, edge)
  const addedEdges = []

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
    const stored = { id, from, to, type: route.type, source: route.source, weight: route.weight }
    if (route.label !== undefined) stored.label = route.label
    graph.edges.push(stored)
    edgeByKey.set(key, stored)
    addedEdges.push(id)
  }

  return { nodes: addedNodes, edges: addedEdges }
}

/** Bound and sanitize the curation `merge` pairs from an update payload. */
function sanitizeMergePairs(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
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
 * curation "merge" operation (docs/AI-SPEC.md §4 C1):
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
 * @returns {boolean} whether the graph changed.
 */
function mergeGraphNodes(graph, fromId, intoId) {
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
  if (into.position === undefined && from.position !== undefined) into.position = { ...from.position }
  into.curated = true
  into.updatedAt = nowIso()
  // Rewire both edge directions onto the target, drop self-loops, then dedupe
  // by from|to|type keeping the strongest (and user-sourced) edge.
  const out = []
  const byKey = new Map()
  for (const edge of graph.edges) {
    const next = edge.from === fromId || edge.to === fromId
      ? {
          ...edge,
          from: edge.from === fromId ? intoId : edge.from,
          to: edge.to === fromId ? intoId : edge.to,
        }
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
function listParsedDocs(store) {
  let raw
  try {
    raw = store.list()
  } catch {
    return []
  }
  const docs = []
  for (const meta of Array.isArray(raw) ? raw : []) {
    if (!isObject(meta) || typeof meta.id !== 'string' || meta.id.trim() === '') continue
    if (meta.status !== 'parsed') continue
    docs.push(meta)
  }
  docs.sort(
    (left, right) =>
      String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) ||
      String(left.id).localeCompare(String(right.id)),
  )
  return docs
}

/** Build the per-document graph used by library aggregation (never persists). */
async function docGraphForLibrary(doc, deps) {
  const documentId = doc.id
  try {
    const raw = await deps.store.readAux(documentId, GRAPH_FILE)
    if (isObject(raw) && Array.isArray(raw.nodes) && raw.nodes.length > 0) {
      const stored = normalizeDocumentGraph(raw, documentId)
      if (stored.nodes.length > 0) return stored
    }
  } catch (error) {
    logWarn(deps.logger, `cannot read graph.json for ${documentId}`, error?.message ?? error)
  }
  // Lightweight fallback (no LLM): section headings + annotation notes/quotes.
  const graph = emptyDocumentGraph(documentId)
  const now = nowIso()
  try {
    const markdown = await deps.readMarkdown(documentId)
    const model = parseMarkdown(markdown)
    const seen = new Set()
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
  try {
    const annotations = await deps.store.loadAnnotations(documentId)
    const items = Array.isArray(annotations?.items) ? annotations.items : []
    const seen = new Set(graph.nodes.map((node) => `${node.type}|${normalizeLabel(node.label)}`))
    for (const item of items) {
      if (graph.nodes.length >= DOC_MAX_NODES) break
      if (!isObject(item)) continue
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
  return graph
}

/** Connected components of the topic `relates` graph. */
function buildClusters(topicNodes, relatesEdges) {
  if (topicNodes.length === 0) return []
  const ids = new Set(topicNodes.map((node) => node.id))
  const parent = new Map()
  for (const id of ids) parent.set(id, id)
  const find = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    while (parent.get(id) !== id) {
      const next = parent.get(id)
      parent.set(id, root)
      id = next
    }
    return root
  }
  for (const edge of relatesEdges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    const left = find(edge.from)
    const right = find(edge.to)
    if (left !== right) parent.set(left, right)
  }
  const groups = new Map()
  for (const node of topicNodes) {
    const root = find(node.id)
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [node])
    else group.push(node)
  }
  const clusters = []
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) => (right.weight ?? 1) - (left.weight ?? 1) || left.label.localeCompare(right.label),
    )
    clusters.push({
      id: `c-${hashId(ordered.map((node) => node.id).join('|'))}`,
      label: ordered[0].label,
      nodeIds: ordered.map((node) => node.id),
      size: ordered.length,
      weight: ordered.reduce((total, node) => total + (node.weight ?? 1), 0),
    })
  }
  clusters.sort((left, right) => right.size - left.size || left.label.localeCompare(right.label))
  return clusters
}

/** Stop words ignored when comparing library topic labels. */
const LIB_LABEL_STOP_WORDS = new Set([
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
function libraryLabelTokens(label) {
  const text = String(label ?? '').toLowerCase().normalize('NFKC')
  const tokens = new Set()
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    const token = match[0].replace(/_/g, '-')
    if (token.length < 2 || LIB_LABEL_STOP_WORDS.has(token)) continue
    // "Figure 2" / "Algorithm 1" / "Concept 107" must not merge by counter.
    if (/^\d+$/.test(token)) continue
    tokens.add(token)
  }
  return tokens
}

/**
 * Whether two topic labels name the same concept closely enough to merge.
 *
 * Word-set containment (with ≥2 shared content words) catches aliases such as
 * "spectral dominance" ⊂ "full spectral dominance" and "block reference" ⊂
 * "block reference structure"; high Jaccard catches reordered wording. This is
 * what lets cross-paper concepts merge and keeps the curated library free of
 * near-duplicate nodes.
 */
function libraryLabelsSimilar(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftTokens = libraryLabelTokens(left)
  const rightTokens = libraryLabelTokens(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) return false
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  if (shared === 0) return false
  const smallest = Math.min(leftTokens.size, rightTokens.size)
  const largest = Math.max(leftTokens.size, rightTokens.size)
  // Very similar wording in a different order (needs ≥2 content words so a
  // single generic word cannot merge unrelated concepts).
  if (largest >= 2 && shared / largest >= 0.85) return true
  // Short alias extended by one qualifier ("block reference" ⊃ "block reference
  // structure", "spectral dominance" ⊃ "full spectral dominance"); longer
  // sentences must share at least three content words.
  if (shared === smallest && (shared >= 3 || (shared === 2 && largest <= 3))) return true
  return false
}

/** Per-document degree map used for topic importance. */
function documentDegrees(docGraph) {
  const degree = new Map()
  for (const edge of docGraph.edges ?? []) {
    if (typeof edge.from === 'string') degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    if (typeof edge.to === 'string') degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  return degree
}

/** Importance of one document node as a candidate library topic. */
function documentNodeImportance(node, degree) {
  const weight = Math.max(0.01, Number(node.weight) || 1)
  const degreeValue = Math.max(0, degree.get(node.id) ?? 0)
  const blockBonus = Math.min(4, Array.isArray(node.blockKeys) ? node.blockKeys.length : 0)
  const typeValue = LIB_TOPIC_TYPE_VALUE[node.type] ?? 1
  const sourceBonus = node.source === 'user' ? 1.2 : node.source === 'qa' ? 0.5 : 0
  return (weight * 2)
    + (Math.min(12, degreeValue) * 1.1)
    + (blockBonus * 0.35)
    + typeValue
    + sourceBonus
}

/** Cross-paper value of a candidate topic (coverage first, then importance). */
function libraryTopicScore(entry) {
  const coverage = Array.isArray(entry.documentIds) ? entry.documentIds.length : 1
  return (coverage * 4) + entry.score + (Math.min(4, entry.blockKeys.length) * 0.25)
}

/**
 * Aggregate per-document graphs into a curated library graph.
 *
 * This is deliberately NOT a union of every document node:
 *
 *  - each paper contributes at most its top `LIB_PER_DOC_TOP` nodes by a
 *    type/weight/degree/evidence importance score;
 *  - concepts that occur in two or more papers are always kept (they are the
 *    cross-paper value);
 *  - the final set is capped at `LIB_MAX_TOPICS`, with every paper keeping at
 *    least two representatives;
 *  - edges are value-bearing: paper→topic `mentions`, topic→topic relations
 *    propagated from the real document-graph edges (typed uses/supports/…),
 *    and paper↔paper `shares` edges weighted by the number of shared concepts.
 *    There are no "every topic co-occurs with every other topic" edges.
 */
function aggregateLibraryGraph(docs, docGraphs) {
  const graph = emptyLibraryGraph()
  const now = nowIso()
  graph.generatedAt = now

  const papers = []
  const entries = new Map()
  const docInfos = []

  // Pass 1: per-document candidates + importance cut.
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index]
    const docGraph = docGraphs[index] ?? emptyDocumentGraph(doc.id)
    const title = cleanLabel(doc.title || doc.originalName || doc.id)
    const paper = {
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
    const byKey = new Map()
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
      .sort((left, right) => (right.score - left.score) || left.key.localeCompare(right.key))
      .slice(0, LIB_PER_DOC_TOP);

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
  const crossPaper = new Map()
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
  // concepts rather than wording variants. Every candidate label from every
  // document participates, so cross-paper concepts can merge even when one
  // paper's wording is longer.
  const knownKeys = [...crossPaper.keys()].sort((left, right) => left.localeCompare(right))
  const parent = new Map(knownKeys.map((key) => [key, key]))
  const findRoot = (key) => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root)
    let node = key
    while (parent.get(node) !== node) {
      const next = parent.get(node)
      parent.set(node, root)
      node = next
    }
    return root
  }
  const unionKeys = (left, right) => {
    const leftRoot = findRoot(left)
    const rightRoot = findRoot(right)
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot)
  }
  for (let left = 0; left < knownKeys.length; left += 1) {
    const leftKey = knownKeys[left]
    const leftLabel = crossPaper.get(leftKey)?.best?.node?.label
    for (let right = left + 1; right < knownKeys.length; right += 1) {
      const rightKey = knownKeys[right]
      const rightLabel = crossPaper.get(rightKey)?.best?.node?.label
      if (libraryLabelsSimilar(leftLabel, rightLabel)) unionKeys(leftKey, rightKey)
    }
  }
  const aliasGroups = new Map()
  for (const key of knownKeys) {
    const root = findRoot(key)
    const group = aliasGroups.get(root)
    if (group === undefined) aliasGroups.set(root, [key])
    else group.push(key)
  }
  const canonicalKey = new Map()
  const mergedEntries = new Map()
  for (const members of aliasGroups.values()) {
    let memberEntries = members.map((key) => entries.get(key)).filter((entry) => entry !== undefined)
    const aliasRecords = members
      .map((key) => crossPaper.get(key))
      .filter((record) => record !== undefined && Array.isArray(record.docs) && record.docs.length > 0)
    const aliasDocs = []
    for (const record of aliasRecords) {
      for (const documentId of record.docs) {
        if (!aliasDocs.includes(documentId)) aliasDocs.push(documentId)
      }
    }
    if (memberEntries.length === 0) {
      // Neither wording made a paper's top cut, but the alias still names the
      // same concept in 2+ papers: that cross-paper bridge is exactly what the
      // library graph should surface.
      if (aliasDocs.length < 2) continue
      const bestRecord = aliasRecords.reduce((left, right) => (
        right.best.score > left.best.score ? right : left
      ))
      const bestNode = bestRecord.best.node
      memberEntries = [{
        key: members[0],
        label: cleanLabel(bestNode.label),
        summary: boundedText(bestNode.summary, 320),
        blockKeys: unionStrings([], Array.isArray(bestNode.blockKeys) ? bestNode.blockKeys : [], 6),
        documentIds: aliasDocs.slice(),
        score: bestRecord.best.score + 2,
        aspect: bestNode.aspect,
      }]
    }
    memberEntries.sort((left, right) => (
      (right.score - left.score)
      || (right.documentIds.length - left.documentIds.length)
      || left.label.localeCompare(right.label)
    ))
    const representative = memberEntries[0]
    const merged = {
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
    (left, right) => (libraryTopicScore(right) - libraryTopicScore(left))
      || left.label.localeCompare(right.label),
  )
  const selected = new Map()
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
  const topicByKey = new Map()
  const topics = []
  const docOrder = new Map(docs.map((doc, index) => [doc.id, index]))
  for (const entry of selected.values()) {
    const coverage = entry.documentIds.length
    const aliasBonus = Math.min(3, Math.max(0, (entry.aliases ?? 1) - 1))
    const weight = Math.min(12, (coverage * 2) + Math.round(Math.min(8, entry.score) / 2) + aliasBonus)
    const topic = {
      id: topicNodeId(entry.key),
      type: 'topic',
      label: entry.label,
      summary: entry.summary,
      blockKeys: entry.blockKeys.slice(),
      documentIds: entry.documentIds.slice().sort((left, right) => (docOrder.get(left) ?? 0) - (docOrder.get(right) ?? 0)),
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

  const edgeByKey = new Map()
  const putEdge = (edge) => {
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
      const type = EDGE_TYPES.has(edge.type) && edge.type !== 'mentions' && edge.type !== 'shares'
        ? edge.type
        : 'relates'
      const [left, right] = fromTopic.id <= toTopic.id ? [fromTopic.id, toTopic.id] : [toTopic.id, fromTopic.id]
      const key = `${left}|${right}|${type}`
      const existing = edgeByKey.get(key)
      if (existing !== undefined) {
        existing.weight = Math.min(6, (existing.weight ?? 1) + 1)
        continue
      }
      const relation = {
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
  const shares = []
  for (let left = 0; left < docInfos.length; left += 1) {
    for (let right = left + 1; right < docInfos.length; right += 1) {
      const leftId = docInfos[left].doc.id
      const rightId = docInfos[right].doc.id
      let count = 0
      for (const entry of selected.values()) {
        if (entry.documentIds.includes(leftId) && entry.documentIds.includes(rightId)) count += 1
      }
      if (count > 0) {
        shares.push({ from: docInfos[left].paper.id, to: docInfos[right].paper.id, count })
      }
    }
  }
  shares.sort((left, right) => (right.count - left.count) || String(left.from).localeCompare(String(right.from)))
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

/** Whether the injected gateway reports an available route. */
function gatewayAvailable(llm) {
  if (llm === null || typeof llm !== 'object') return false
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
function routeOf(llm) {
  if (llm === null || typeof llm !== 'object' || typeof llm.route !== 'function') return null
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
async function completeViaGateway(llm, request) {
  if (llm !== null && typeof llm === 'object' && typeof llm.completeText === 'function') {
    const value = await llm.completeText(request)
    if (typeof value === 'string') return value
    if (isObject(value) && typeof value.text === 'string') return value.text
    return ''
  }
  if (llm !== null && typeof llm === 'object' && typeof llm.streamText === 'function') {
    let text = ''
    const stream = llm.streamText(request)
    for await (const frame of stream) {
      if (frame?.type === 'error') {
        const error = new Error(typeof frame.message === 'string' ? frame.message : 'LLM stream failed')
        error.code = typeof frame.code === 'string' ? frame.code : 'llm-failed'
        throw error
      }
      if (frame?.type === 'delta' && typeof frame.text === 'string') text += frame.text
    }
    return text
  }
  const error = new Error('LLM gateway unavailable')
  error.code = 'llm-unavailable'
  throw error
}

/* -------------------------------------------------------------------------- */
/* Graph service                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Create the knowledge-graph service (docs/AI-SPEC.md §3).
 *
 * @param {{
 *   llm?: { available?: Function, route?: Function, completeText?: Function, streamText?: Function },
 *   store: {
 *     list: Function, get?: Function,
 *     readAux: Function, writeAux: Function,
 *     readLibraryAux: Function, writeLibraryAux: Function,
 *     loadAnnotations?: Function, readMarkdown?: Function,
 *   },
 *   config?: { ai?: {
 *     maxGraphChunks?: number, maxGraphSourceChars?: number,
 *     graphMaxTokens?: number, graphSummaryChars?: number,
 *   } },
 *   logger?: { warn?: Function },
 *   readMarkdown?: (documentId: string) => Promise<string | { markdown?: string }>,
 * }} deps - injected host dependencies. The LLM gateway is optional: without
 *   it, reads/updates still work and builds fail with an `llm-unavailable`
 *   frame instead of throwing.
 * @returns {{
 *   docGraph(documentId: string): Promise<object>,
 *   buildDocGraph(documentId: string, options?: { signal?: AbortSignal, force?: boolean }): AsyncGenerator<object>,
 *   mergeDocKnowledge(documentId: string, delta?: object): Promise<object>,
 *   updateDocGraph(documentId: string, payload?: object): Promise<object>,
 *   libraryGraph(): Promise<object>,
 *   rebuildLibraryGraph(options?: { signal?: AbortSignal }): AsyncGenerator<object>,
 * }} the graph service facade.
 */
export function createGraphService({ llm, store, config, logger, readMarkdown } = {}) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createGraphService: an injected store is required')
  }
  for (const method of ['readAux', 'writeAux', 'readLibraryAux', 'writeLibraryAux', 'list']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createGraphService: store.${method} is required (docs/AI-SPEC.md §2)`)
    }
  }
  const graphConfig = resolveGraphConfig(config)
  const log = logger ?? {}
  const readMarkdownImpl =
    typeof readMarkdown === 'function'
      ? readMarkdown
      : typeof store.readMarkdown === 'function'
        ? (documentId) => store.readMarkdown(documentId)
        : null

  /** Serialize read-modify-write mutations per document. */
  const docChains = new Map()
  function queueDoc(documentId, task) {
    const previous = docChains.get(documentId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    docChains.set(documentId, tail)
    tail.then(() => {
      if (docChains.get(documentId) === tail) docChains.delete(documentId)
    })
    return run
  }

  /** Read parsed markdown through the injected reader (or store.readMarkdown). */
  async function loadMarkdown(documentId) {
    if (readMarkdownImpl === null) {
      const error = new Error('readMarkdown is not available')
      error.code = 'not-parsed'
      throw error
    }
    const result = await readMarkdownImpl(documentId)
    if (typeof result === 'string') return result
    if (isObject(result) && typeof result.markdown === 'string') return result.markdown
    return ''
  }

  /** Document title for prompts/overviews; never throws. */
  function documentTitle(documentId) {
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
   * a freshly built graph. A forced rebuild must never silently drop them:
   * `qa`/`user` provenance is carried over as before, and `curated` nodes keep
   * their label/position/identity via `preserveCurated` (docs/AI-SPEC.md §2).
   *
   * @param {object} graph - the freshly built graph to merge into.
   * @param {object} current - the normalized graph currently on disk.
   * @returns {boolean} whether any late knowledge was preserved.
   */
  function preserveLateKnowledge(graph, current) {
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
  async function readDocGraph(documentId) {
    const raw = await store.readAux(documentId, GRAPH_FILE)
    return normalizeDocumentGraph(raw, documentId)
  }

  /** Read and normalize the persisted library graph (empty when never built). */
  async function readLibraryGraph() {
    const raw = await store.readLibraryAux(LIBRARY_GRAPH_FILE)
    return normalizeLibraryGraph(raw)
  }

  /** Persist one document graph. */
  async function writeDocGraph(documentId, graph) {
    await store.writeAux(documentId, GRAPH_FILE, graph)
    return graph
  }

  /** Fill document summary fields from the model payload, falling back deterministically. */
  function applyDocumentSummary(graph, title, summary) {
    graph.overview =
      summary !== null && summary.overview !== '' ? summary.overview : deterministicDocumentOverview(graph, title)
    graph.tldr = summary !== null && summary.tldr !== '' ? summary.tldr : deterministicDocumentTldr(graph)
    graph.glossary = summary !== null && summary.glossary.length > 0 ? summary.glossary : deterministicGlossary(graph)
    refreshStats(graph)
    return graph
  }

  /**
   * Read one document graph (no LLM).
   * @param {string} documentId
   * @returns {Promise<object>} KG
   */
  async function docGraph(documentId) {
    return readDocGraph(documentId)
  }

  /**
   * Build a document graph with the model.
   *
   * Frames: `progress` (reading → extracting per chunk → merging → done),
   * then one `graph` frame; failures/cancellation yield one `error` frame.
   * A non-forced call returns the cached graph without model calls.
   *
   * @param {string} documentId
   * @param {{ signal?: AbortSignal, force?: boolean }} [options]
   * @returns {AsyncGenerator<object>} frame stream
   */
  async function* buildDocGraph(documentId, options = {}) {
    const signal = options?.signal
    try {
      yield { type: 'progress', phase: 'reading', done: 0, total: 1, chunk: 0 }

      const existing = await readDocGraph(documentId)
      if (options?.force !== true && existing.nodes.length > 0) {
        yield { type: 'progress', phase: 'reading', done: 1, total: 1, chunk: 0 }
        yield { type: 'progress', phase: 'done', done: 1, total: 1, chunk: 0 }
        yield { type: 'graph', graph: existing }
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

      const chunks = chunkDocument(markdown, graphConfig)
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
        yield { type: 'graph', graph: saved }
        return
      }

      const graph = emptyDocumentGraph(documentId)
      graph.generatedAt = nowIso()
      graph.model = model
      const total = chunks.length
      const knownBlockKeys = new Set()
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
            messages: [{ role: 'user', content: extractionPrompt(chunk, { title }) }],
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
          logWarn(log, `chunk ${chunk.index}/${total} failed`, error?.message ?? error)
          yield { type: 'progress', phase: 'extracting', done: chunk.index, total, chunk: chunk.index }
          continue
        }
        const payload = parseGraphPayload(text)
        if (payload === null) {
          malformed += 1
          logWarn(log, `chunk ${chunk.index}/${total} returned no usable graph JSON`)
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
        logWarn(log, 'every extraction chunk returned malformed JSON; keeping an empty graph')
      }
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)

      yield { type: 'progress', phase: 'merging', done: 0, total: 1, chunk: 0 }
      let summary = null
      if (graph.nodes.length > 0) {
        try {
          const text = await completeViaGateway(llm, {
            system: GRAPH_SUMMARY_SYSTEM,
            messages: [{ role: 'user', content: summaryPrompt(graph, { title }, graphConfig) }],
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
          logWarn(log, 'summary pass failed; using deterministic summary', error?.message ?? error)
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
      yield { type: 'graph', graph: saved }
    } catch (error) {
      if (isAbortError(error, signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'graph-failed'
      const message = typeof error?.message === 'string' && error.message !== '' ? error.message : '图谱构建失败（Graph build failed）'
      logWarn(log, 'build failed', message)
      yield { type: 'error', code, message }
    }
  }

  /**
   * Merge Q&A knowledge (`{ nodes, edges }`) into one document graph.
   * Node ids are preserved when the model supplied one; edges may reference
   * labels, and unknown references create a node first.
   *
   * @param {string} documentId
   * @param {{ nodes?: object[], edges?: object[] }} [delta]
   * @returns {Promise<object>} the persisted KG
   */
  async function mergeDocKnowledge(documentId, delta) {
    return queueDoc(documentId, async () => {
      const graph = await readDocGraph(documentId)
      const source = isObject(delta?.knowledge) && !Array.isArray(delta?.nodes) ? delta.knowledge : delta
      const nodes = Array.isArray(source?.nodes) ? source.nodes : []
      const edges = Array.isArray(source?.edges) ? source.edges : []
      if (nodes.length === 0 && edges.length === 0) return graph
      mergeDeltaIntoGraph(
        graph,
        { nodes, edges },
        {
          defaultSource: 'qa',
          allowedTypes: DOC_NODE_TYPES,
          fallbackType: 'concept',
          incrementWeight: false,
        },
      )
      capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)
      if (graph.generatedAt === null) graph.generatedAt = nowIso()
      if (graph.model === null) graph.model = routeOf(llm)
      const title = documentTitle(documentId)
      if (graph.overview === '') graph.overview = deterministicDocumentOverview(graph, title)
      if (graph.tldr === '') graph.tldr = deterministicDocumentTldr(graph)
      if (graph.glossary.length === 0) graph.glossary = deterministicGlossary(graph)
      return writeDocGraph(documentId, graph)
    })
  }

  /**
   * Apply user/AI edits to one document graph (docs/AI-SPEC.md §4 graph.update):
   *
   * - nodes upsert by id (or by normalized label + type) inside the document's
   *   atomic queue; existing ids are kept and only the provided fields are
   *   applied (`source` is never clobbered unless the caller sent it), every
   *   user edit marks the node `curated` and bumps `updatedAt`, and the optional
   *   `pinned` / `position` curation fields are persisted;
   * - edges upsert by id (or from/to/type), as before;
   * - `merge: [{ from, into }]` folds one node into another (see
   *   {@link mergeGraphNodes}); unknown ids are ignored without throwing.
   *
   * @param {string} documentId
   * @param {{ nodes?: object[], edges?: object[],
   *           merge?: Array<{ from: string, into: string }> }} [payload]
   * @returns {Promise<object>} the persisted KG
   */
  async function updateDocGraph(documentId, payload) {
    return queueDoc(documentId, async () => {
      const graph = await readDocGraph(documentId)
      const incomingNodes = Array.isArray(payload?.nodes) ? payload.nodes : []
      const incomingEdges = Array.isArray(payload?.edges) ? payload.edges : []
      const incomingMerges = sanitizeMergePairs(payload?.merge)
      if (incomingNodes.length === 0 && incomingEdges.length === 0 && incomingMerges.length === 0) return graph
      let changed = false
      const byId = new Map(graph.nodes.map((node) => [node.id, node]))
      const byKey = new Map()
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
        let node = null
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
            if (DOC_NODE_TYPES.has(type)) target.type = type
          }
          if (typeof raw.summary === 'string') target.summary = boundedText(raw.summary, MAX_SUMMARY_CHARS)
          if (Array.isArray(raw.blockKeys)) target.blockKeys = sanitizeBlockKeys(raw.blockKeys)
          if (typeof raw.aspect === 'string') {
            if (ASPECTS.has(raw.aspect)) target.aspect = raw.aspect
            else delete target.aspect
          }
          if (typeof raw.weight === 'number' || typeof raw.weight === 'string') {
            target.weight = sanitizeWeight(raw.weight)
          }
          if (typeof raw.source === 'string' && SOURCES.has(raw.source.trim())) target.source = raw.source.trim()
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
        node.source = typeof raw.source === 'string' && SOURCES.has(raw.source.trim())
          ? raw.source.trim()
          : 'user'
        node.curated = true
        node.updatedAt = stamp
        if (node.id === null || byId.has(node.id)) node.id = newNodeId()
        graph.nodes.push(node)
        byId.set(node.id, node)
        const key = nodeKey(node)
        if (!byKey.has(key)) byKey.set(key, node)
        changed = true
      }

      // Re-index labels after possible renames so edge references still resolve.
      const byLabel = new Map()
      for (const node of graph.nodes) {
        const key = normalizeLabel(node.label)
        if (key !== '' && !byLabel.has(key)) byLabel.set(key, node)
      }
      const resolveRef = (ref) => {
        const text = typeof ref === 'string' ? ref.trim() : ''
        if (text === '') return null
        const direct = byId.get(text)
        if (direct !== undefined) return direct.id
        const labelled = byLabel.get(normalizeLabel(text))
        return labelled === undefined ? null : labelled.id
      }
      const edgeByKey = new Map()
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
          if (typeof raw.source === 'string' && SOURCES.has(raw.source.trim())) target.source = raw.source.trim()
          target.weight = edge.weight
          if (edge.label !== undefined) target.label = edge.label
          changed = true
          continue
        }
        let id = edge.id !== undefined && !usedEdgeIds.has(edge.id) ? edge.id : makeEdgeId(from, to, edge.type)
        if (usedEdgeIds.has(id)) id = makeEdgeId(from, to, edge.type)
        usedEdgeIds.add(id)
        const stored = {
          id,
          from,
          to,
          type: edge.type,
          source: typeof raw.source === 'string' && SOURCES.has(raw.source.trim()) ? raw.source.trim() : 'user',
          weight: edge.weight,
        }
        if (edge.label !== undefined) stored.label = edge.label
        graph.edges.push(stored)
        edgeByKey.set(`${from}|${to}|${edge.type}`, stored)
        changed = true
      }

      // Curation merges run in the same atomic section, after the upserts so a
      // payload may rename/stitch nodes and immediately fold them. Unknown ids
      // and malformed pairs are ignored (never an error).
      for (const pair of incomingMerges) {
        if (mergeGraphNodes(graph, pair.from, pair.into)) changed = true
      }

      if (!changed) return graph
      capGraph(graph, DOC_MAX_NODES, DOC_MAX_EDGES)
      if (graph.generatedAt === null) graph.generatedAt = nowIso()
      if (graph.model === null) graph.model = routeOf(llm)
      const title = documentTitle(documentId)
      if (graph.overview === '') graph.overview = deterministicDocumentOverview(graph, title)
      if (graph.tldr === '') graph.tldr = deterministicDocumentTldr(graph)
      if (graph.glossary.length === 0) graph.glossary = deterministicGlossary(graph)
      return writeDocGraph(documentId, graph)
    })
  }

  /**
   * Read the persisted library graph (no LLM, no side effects). Missing or
   * corrupt data reads as an empty library KG.
   *
   * @returns {Promise<object>} library KG
   */
  async function libraryGraph() {
    return readLibraryGraph()
  }

  /**
   * Rebuild the library graph from per-document graphs.
   *
   * Deterministic and curated: parsed documents (status `parsed`, oldest
   * first) become paper nodes; each paper contributes only its most
   * representative topics (importance = type/weight/degree/evidence), cross-
   * paper concepts are always kept, and the library is capped at
   * `LIB_MAX_TOPICS`. Edges are paper→topic `mentions`, typed topic relations
   * propagated from real document graphs, and paper↔paper `shares` edges.
   * One optional LLM call polishes the overview; failures keep the
   * deterministic text.
   *
   * Frames: `progress` (reading per document → merging → done), then `graph`;
   * cancellation/failure yields one `error` frame.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {AsyncGenerator<object>} frame stream
   */
  async function* rebuildLibraryGraph(options = {}) {
    const signal = options?.signal
    try {
      yield { type: 'progress', phase: 'reading', done: 0, total: 0, chunk: 0 }
      const docs = listParsedDocs(store)
      const total = docs.length
      const docGraphs = []
      for (let index = 0; index < docs.length; index += 1) {
        if (isAborted(signal)) {
          yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
          return
        }
        docGraphs.push(await docGraphForLibrary(docs[index], { store, logger: log, readMarkdown: loadMarkdown }))
        yield { type: 'progress', phase: 'reading', done: index + 1, total, chunk: index + 1 }
      }
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }

      yield { type: 'progress', phase: 'merging', done: 0, total: 1, chunk: 0 }
      const graph = aggregateLibraryGraph(docs, docGraphs)

      if (docs.length > 0 && gatewayAvailable(llm)) {
        graph.model = routeOf(llm)
        try {
          const text = await completeViaGateway(llm, {
            system: LIBRARY_SUMMARY_SYSTEM,
            messages: [{ role: 'user', content: libraryPolishPrompt(graph, graphConfig) }],
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
          logWarn(log, 'library overview polish failed; keeping deterministic overview', error?.message ?? error)
        }
      }
      if (isAborted(signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      graph.generatedAt = nowIso()
      refreshStats(graph)
      await store.writeLibraryAux(LIBRARY_GRAPH_FILE, graph)
      yield { type: 'progress', phase: 'done', done: 1, total: 1, chunk: 0 }
      yield { type: 'graph', graph }
    } catch (error) {
      if (isAbortError(error, signal)) {
        yield { type: 'error', code: 'aborted', message: '已停止（Aborted）' }
        return
      }
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'graph-failed'
      const message = typeof error?.message === 'string' && error.message !== '' ? error.message : '图谱构建失败（Graph build failed）'
      logWarn(log, 'library rebuild failed', message)
      yield { type: 'error', code, message }
    }
  }

  return { docGraph, buildDocGraph, mergeDocKnowledge, updateDocGraph, libraryGraph, rebuildLibraryGraph }
}
