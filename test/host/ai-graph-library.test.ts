/**
 * Unit tests for the library scope of the knowledge-graph engine
 * (`src/host/ai/graph.ts`): deterministic aggregation of per-document graphs
 * into paper/topic nodes, mentions and typed relations, clusters, caps,
 * lightweight heading/annotation fallbacks, optional LLM overview polish,
 * cancellation and alias curation.
 */

import { expect, test } from 'vitest'
import {
  createGraphService,
  type GraphLlmApi,
  type GraphStoreApi,
} from '../../src/host/ai/graph.ts'
import type { LlmCompleteRequest } from '../../src/host/ai/llm.ts'
import type {
  DocumentMeta,
  GraphNode,
  KnowledgeGraph,
  LibraryGraphFrame,
  ParsedDocument,
} from '../../src/shared/model.ts'

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** Build a fenced model-output block. */
function fence(tag: string, payload: unknown): string {
  return `\`\`\`${tag}\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

/** Summary model output. */
function summaryFence(payload: Record<string, unknown>): string {
  return fence('litnotes-summary', payload)
}

/** One recorded fake-gateway call. */
interface GatewayCall {
  purpose: string | undefined
  prompt: string
}

/** Script functions accepted by {@link createFakeGateway}. */
interface GatewayScripts {
  available?: boolean
  library?: (input: { request: LlmCompleteRequest }) => string
}

/** Fake model gateway (`completeText` is the only method the library path uses). */
interface FakeGateway extends GraphLlmApi {
  state: GatewayScripts
  calls: GatewayCall[]
}

/** Fake gateway: only `completeText` is used by the library path. */
function createFakeGateway(scripts: GatewayScripts = {}): FakeGateway {
  const state: GatewayScripts = { available: scripts.available !== false, library: scripts.library }
  const calls: GatewayCall[] = []
  return {
    state,
    calls,
    available(): boolean {
      return state.available !== false
    },
    route(): { provider: string; model: string } {
      return { provider: 'fake-provider', model: 'fake-model' }
    },
    async completeText(request: LlmCompleteRequest): Promise<string> {
      const message = request?.messages?.[0]
      const content = message !== undefined && message !== null && typeof message === 'object' ? message.content : undefined
      const prompt = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')).join('')
          : ''
      calls.push({ purpose: request?.purpose, prompt: request?.purpose === 'graph-library-overview' ? prompt : '' })
      if (request?.purpose === 'graph-library-overview') {
        if (typeof state.library !== 'function') throw new Error('fake gateway: no library script')
        return state.library({ request })
      }
      throw new Error(`fake gateway: unexpected purpose ${String(request?.purpose)}`)
    },
  }
}

/** In-memory store exposing the documented aux API. */
interface FakeGraphStore {
  list: () => DocumentMeta[]
  get: (id: string) => DocumentMeta | undefined
  readMarkdown: (id: string) => Promise<ParsedDocument>
  loadAnnotations: (id: string) => Promise<{ version: 1; items: Array<Record<string, unknown>> }>
  readAux: (id: string, name: string) => Promise<unknown>
  writeAux: (id: string, name: string, value: unknown) => Promise<void>
  readLibraryAux: (name: string) => Promise<unknown>
  writeLibraryAux: (name: string, value: unknown) => Promise<void>
}

/** Environment returned by {@link createFakeStore}. */
interface FakeEnv {
  store: FakeGraphStore
  aux: Map<string, unknown>
  libraryAux: Map<string, unknown>
  markdowns: Map<string, string>
}

/** In-memory store exposing the documented aux API. */
function createFakeStore(options: {
  docs?: Array<Record<string, unknown> & { id: string }>
  markdown?: Record<string, string>
  annotations?: Record<string, { version: 1; items: Array<Record<string, unknown>> }>
  graphs?: Record<string, unknown>
  libraryGraph?: unknown
} = {}): FakeEnv {
  const docList = (options.docs ?? []).map((doc) => ({ status: 'parsed', createdAt: '2026-01-01T00:00:00.000Z', ...doc }))
  const docsById = new Map(docList.map((doc) => [doc.id, doc]))
  const markdowns = new Map<string, string>(Object.entries(options.markdown ?? {}))
  const annotationMap = new Map<string, unknown>(Object.entries(options.annotations ?? {}))
  const aux = new Map<string, unknown>()
  const libraryAux = new Map<string, unknown>()
  for (const [id, value] of Object.entries(options.graphs ?? {})) aux.set(`${id}/graph.json`, structuredClone(value))
  if (options.libraryGraph !== undefined) libraryAux.set('library-graph.json', structuredClone(options.libraryGraph))
  const store = {
    list(): DocumentMeta[] {
      return structuredClone(docList) as unknown as DocumentMeta[]
    },
    get(id: string): DocumentMeta | undefined {
      return docsById.has(id) ? (structuredClone(docsById.get(id)) as unknown as DocumentMeta) : undefined
    },
    async readMarkdown(id: string): Promise<ParsedDocument> {
      if (!markdowns.has(id)) {
        const error = new Error('Document has not been parsed yet') as Error & { code: string }
        error.code = 'not-parsed'
        throw error
      }
      return { markdown: markdowns.get(id) ?? '', contentList: null, pages: null }
    },
    async loadAnnotations(id: string): Promise<{ version: 1; items: Array<Record<string, unknown>> }> {
      return structuredClone((annotationMap.get(id) ?? { version: 1, items: [] }) as { version: 1; items: Array<Record<string, unknown>> })
    },
    async readAux(id: string, name: string): Promise<unknown> {
      const key = `${id}/${name}`
      return aux.has(key) ? structuredClone(aux.get(key)) : null
    },
    async writeAux(id: string, name: string, value: unknown): Promise<void> {
      aux.set(`${id}/${name}`, structuredClone(value))
    },
    async readLibraryAux(name: string): Promise<unknown> {
      return libraryAux.has(name) ? structuredClone(libraryAux.get(name)) : null
    },
    async writeLibraryAux(name: string, value: unknown): Promise<void> {
      libraryAux.set(name, structuredClone(value))
    },
  }
  return { store, aux, libraryAux, markdowns }
}

/** Create a graph service over the fake store/gateway. */
function makeService(env: FakeEnv, gateway: FakeGateway, ai: Record<string, unknown> = {}) {
  return createGraphService({
    llm: gateway,
    store: env.store as unknown as GraphStoreApi,
    config: { ai: { maxGraphChunks: 12, maxGraphSourceChars: 160000, graphMaxTokens: 3000, ...ai } },
    logger: { warn(): void {} },
    readMarkdown: (id) => env.store.readMarkdown(id),
  })
}

/** Drain an async generator into an array. */
async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const frames: T[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

/** The graph of the last `graph` frame (fails when absent). */
function graphOfFrames(frames: readonly LibraryGraphFrame[]): KnowledgeGraph {
  const frame = [...frames].reverse().find((candidate) => candidate.type === 'graph')
  expect(frame, 'expected a graph frame').toBeDefined()
  if (frame === undefined || frame.type !== 'graph') throw new Error('missing graph frame')
  return frame.graph
}

/** Stable error code of one library frame (`''` for non-error frames). */
function frameErrorCode(frame: LibraryGraphFrame | undefined): string {
  return frame !== undefined && frame.type === 'error' ? frame.code : ''
}

/** Build one stored document graph. */
function docGraph(documentId: string, nodes: readonly unknown[] = [], edges: readonly unknown[] = []): Record<string, unknown> {
  return {
    version: 1,
    scope: 'document',
    documentId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    model: null,
    overview: '',
    tldr: '',
    glossary: [],
    nodes,
    edges,
    stats: { nodes: nodes.length, edges: edges.length, builtAtSeq: null },
  }
}

/** Timestamp-free structural snapshot for determinism assertions. */
function structural(graph: KnowledgeGraph) {
  return {
    scope: graph.scope,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      weight: node.weight,
      documentIds: node.documentIds ?? null,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      weight: edge.weight,
    })),
    clusters: (graph as KnowledgeGraph & { clusters?: Array<{ id: string; label: string; nodeIds: string[]; size: number }> }).clusters?.map(
      (cluster) => ({ id: cluster.id, label: cluster.label, nodeIds: cluster.nodeIds, size: cluster.size }),
    ),
    overview: graph.overview,
    tldr: graph.tldr,
  }
}

/** Two parsed documents sharing one topic, plus one uploaded document. */
function twoDocEnvironment(): FakeEnv {
  const documents = [
    { id: 'doc-a', title: 'Graph Matching for Retrieval', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'doc-b', title: 'Efficient Inference', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'doc-uploaded', title: 'Not Parsed Yet', status: 'uploaded', createdAt: '2026-01-03T00:00:00.000Z' },
  ]
  const graphs = {
    'doc-a': docGraph('doc-a', [
      { id: 'n-a1', type: 'concept', label: 'Graph Matching', summary: 'Matches graph structures.', blockKeys: ['b1:aaaaaaaa'] },
      { id: 'n-a2', type: 'method', label: 'Neural Retrieval', summary: '', blockKeys: [] },
      { id: 'n-a3', type: 'section', label: 'Introduction', summary: '', blockKeys: [] },
      { id: 'n-a4', type: 'question', label: 'What is the cost?', summary: '', blockKeys: [] },
    ], [{ id: 'e-a1', from: 'n-a1', to: 'n-a2', type: 'uses', source: 'ai-summary', weight: 1 }]),
    'doc-b': docGraph('doc-b', [
      { id: 'n-b1', type: 'concept', label: 'graph matching!', summary: '', blockKeys: [] },
      { id: 'n-b2', type: 'concept', label: 'Efficient Inference', summary: '', blockKeys: [] },
    ]),
  }
  return createFakeStore({ docs: documents, graphs })
}

/** Find a node by label (fails when absent). */
function nodeByLabel(graph: KnowledgeGraph, label: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.label === label)
  expect(node, `expected node with label ${label}`).toBeDefined()
  if (node === undefined) throw new Error(`missing node: ${label}`)
  return node
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

test('rebuildLibraryGraph aggregates papers and topics deterministically from two documents sharing a topic', async () => {
  const env = twoDocEnvironment()
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)

  const empty = await service.libraryGraph()
  expect(empty.scope).toBe('library')
  expect(empty.nodes.length).toBe(0)
  expect(empty.generatedAt).toBeNull()

  const frames = await collect(service.rebuildLibraryGraph())
  const phases = frames.filter((frame) => frame.type === 'progress').map((frame) => (frame.type === 'progress' ? frame.phase : ''))
  expect(phases).toEqual(['reading', 'reading', 'reading', 'merging', 'done'])
  const reading = frames.filter((frame) => frame.type === 'progress' && frame.phase === 'reading')
  const firstReading = reading[0]
  expect(firstReading?.type === 'progress' ? firstReading.total : -1).toBe(0)
  expect(reading.slice(1).map((frame) => (frame.type === 'progress' ? frame.done : -1))).toEqual([1, 2])
  expect(reading.slice(1).every((frame) => frame.type === 'progress' && frame.total === 2)).toBe(true)

  const graph = graphOfFrames(frames)
  expect(graph.scope).toBe('library')
  expect(gateway.calls.length).toBe(0)
  expect(graph.model).toBeNull()

  const papers = graph.nodes.filter((node) => node.type === 'paper')
  expect(papers.length).toBe(2)
  expect(papers.map((paper) => paper.label)).toEqual(['Graph Matching for Retrieval', 'Efficient Inference'])
  expect(papers.every((paper) => /^n-paper-/.test(paper.id))).toBe(true)
  expect(papers.every((paper) => paper.weight === 2)).toBe(true)
  expect(graph.nodes.some((node) => node.documentIds?.includes('doc-uploaded'))).toBe(false)

  const topics = graph.nodes.filter((node) => node.type === 'topic')
  expect(topics.length).toBe(3)
  expect(topics.some((topic) => topic.label === 'Introduction')).toBe(false)
  expect(topics.some((topic) => topic.label === 'What is the cost?')).toBe(false)

  const matching = topics.filter((topic) => /^graph matching$/i.test(topic.label))
  expect(matching.length).toBe(1)
  const matchingTopic = matching[0]
  if (matchingTopic === undefined) throw new Error('missing merged topic')
  expect(matchingTopic.documentIds).toEqual(['doc-a', 'doc-b'])
  expect(matchingTopic.weight).toBeGreaterThanOrEqual(4)
  expect(matchingTopic.label).toBe('Graph Matching')
  expect(/^n-topic-/.test(matchingTopic.id)).toBe(true)

  const neural = topics.find((topic) => topic.label === 'Neural Retrieval')
  const inference = topics.find((topic) => topic.label === 'Efficient Inference')
  expect(neural).toBeDefined()
  expect(inference).toBeDefined()
  if (neural === undefined || inference === undefined) throw new Error('missing topics')
  expect(neural.documentIds).toEqual(['doc-a'])
  expect(inference.documentIds).toEqual(['doc-b'])

  const paperA = papers.find((paper) => paper.documentIds?.[0] === 'doc-a')
  const paperB = papers.find((paper) => paper.documentIds?.[0] === 'doc-b')
  expect(paperA).toBeDefined()
  expect(paperB).toBeDefined()
  if (paperA === undefined || paperB === undefined) throw new Error('missing papers')
  const mentions = graph.edges.filter((edge) => edge.type === 'mentions')
  expect(mentions.length).toBe(4)
  expect(mentions.some((edge) => edge.from === paperA.id && edge.to === matchingTopic.id)).toBe(true)
  expect(mentions.some((edge) => edge.from === paperA.id && edge.to === neural.id)).toBe(true)
  expect(mentions.some((edge) => edge.from === paperB.id && edge.to === matchingTopic.id)).toBe(true)
  expect(mentions.some((edge) => edge.from === paperB.id && edge.to === inference.id)).toBe(true)

  // Real document-graph relations propagate; there are no "everything
  // co-occurs" relates edges (the old hairball behaviour).
  expect(graph.edges.some((edge) => edge.type === 'relates' && [matchingTopic.id, inference.id].includes(edge.from))).toBe(false)
  const uses = graph.edges.filter((edge) => edge.type === 'uses')
  expect(uses.length).toBe(1)
  expect(new Set([uses[0]?.from, uses[0]?.to])).toEqual(new Set([matchingTopic.id, neural.id]))

  const shares = graph.edges.filter((edge) => edge.type === 'shares')
  expect(shares.length).toBe(1)
  expect(new Set([shares[0]?.from, shares[0]?.to])).toEqual(new Set([paperA.id, paperB.id]))
  expect(shares[0]?.weight).toBe(1)

  const clusters = (graph as KnowledgeGraph & { clusters?: Array<{ nodeIds: string[]; size: number; id: string }> }).clusters ?? []
  expect(clusters.length).toBe(2)
  const bigCluster = clusters.find((cluster) => cluster.size === 2)
  expect(bigCluster).toBeDefined()
  expect(new Set(bigCluster?.nodeIds)).toEqual(new Set([matchingTopic.id, neural.id]))
  expect(clusters.find((cluster) => cluster.size === 1)?.nodeIds[0]).toBe(inference.id)
  expect(clusters.every((cluster) => /^c-/.test(cluster.id))).toBe(true)

  expect(graph.overview).toMatch(/Graph Matching/)
  expect(graph.overview).toMatch(/Graph Matching for Retrieval/)
  expect(graph.overview).toMatch(/Efficient Inference/)
  expect(graph.overview).toMatch(/2\*\* papers/)
  expect(graph.tldr?.startsWith('- ')).toBe(true)
  expect(graph.stats.nodes).toBe(graph.nodes.length)
  expect(graph.stats.edges).toBe(graph.edges.length)

  const persisted = env.libraryAux.get('library-graph.json')
  expect(persisted).toEqual(graph)
  expect(await service.libraryGraph()).toEqual(graph)

  // Rebuilding keeps ids, edges and overview stable (timestamps are allowed to move).
  const rebuilt = graphOfFrames(await collect(service.rebuildLibraryGraph()))
  expect(structural(rebuilt)).toEqual(structural(graph))
})

test('library aggregation falls back to headings + annotations when a document graph is missing', async () => {
  const documents = [
    { id: 'doc-fallback', title: 'Fallback Paper', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'doc-graph', title: 'Graph Paper', createdAt: '2026-01-02T00:00:00.000Z' },
  ]
  const env = createFakeStore({
    docs: documents,
    markdown: {
      'doc-fallback': '## Sparse Attention\n\nBody about sparse attention.\n\n## Results\n\nNumbers.',
    },
    annotations: {
      'doc-fallback': {
        version: 1,
        items: [{ id: 'a1', blockKey: 'b2:abcd1234', start: 0, end: 10, quote: 'Sparse attention reduces cost', note: 'Sparse attention reduces cost', color: 'yellow' }],
      },
    },
    graphs: {
      'doc-graph': docGraph('doc-graph', [{ id: 'n-g1', type: 'concept', label: 'Sparse Attention', summary: '', blockKeys: [] }]),
    },
  })
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)
  const frames = await collect(service.rebuildLibraryGraph())
  const graph = graphOfFrames(frames)
  expect(gateway.calls.length).toBe(0)

  const papers = graph.nodes.filter((node) => node.type === 'paper')
  expect(papers.length).toBe(2)
  const topics = graph.nodes.filter((node) => node.type === 'topic')
  expect(topics.some((topic) => topic.label === 'Sparse Attention')).toBe(true)
  const annotationTopic = topics.find((topic) => topic.label === 'Sparse attention reduces cost')
  expect(annotationTopic).toBeDefined()
  expect(annotationTopic?.documentIds).toEqual(['doc-fallback'])
  expect(topics.some((topic) => topic.label === 'Results')).toBe(false)
})

test('library curation keeps a compact representative graph from huge document graphs', async () => {
  const documents: Array<Record<string, unknown> & { id: string }> = []
  const graphs: Record<string, unknown> = {}
  for (let docIndex = 0; docIndex < 6; docIndex += 1) {
    const documentId = `doc-cap-${docIndex}`
    documents.push({ id: documentId, title: `Cap Paper ${docIndex}`, createdAt: `2026-01-0${docIndex + 1}T00:00:00.000Z` })
    const nodes = []
    for (let nodeIndex = 0; nodeIndex < 120; nodeIndex += 1) {
      nodes.push({ id: `n-${docIndex}-${nodeIndex}`, type: 'concept', label: `Paper ${docIndex} Concept ${nodeIndex}`, summary: '', blockKeys: [] })
    }
    graphs[documentId] = docGraph(documentId, nodes)
  }
  const env = createFakeStore({ docs: documents, graphs })
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)
  const graph = graphOfFrames(await collect(service.rebuildLibraryGraph()))

  const papers = graph.nodes.filter((node) => node.type === 'paper')
  const topics = graph.nodes.filter((node) => node.type === 'topic')
  expect(papers.length).toBe(6)
  expect(topics.length).toBeLessThanOrEqual(28 + 6 * 2)
  expect(graph.nodes.length).toBeLessThanOrEqual(6 + 28 + 12)
  expect(graph.edges.length).toBeLessThanOrEqual(6 * 12 + 40)

  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  for (const edge of graph.edges) {
    expect(nodeIds.has(edge.from) && nodeIds.has(edge.to), 'no dangling edges').toBe(true)
  }
  const mentions = graph.edges.filter((edge) => edge.type === 'mentions')
  for (const paper of papers) {
    expect(mentions.filter((edge) => edge.from === paper.id).length).toBeGreaterThanOrEqual(2)
  }
  expect(new Set(mentions.map((edge) => edge.to)).size).toBe(topics.length)
})

/* -------------------------------------------------------------------------- */
/* Optional LLM polish                                                        */
/* -------------------------------------------------------------------------- */

test('rebuildLibraryGraph applies the optional LLM overview polish', async () => {
  const env = twoDocEnvironment()
  const gateway = createFakeGateway({
    library() {
      return summaryFence({
        overview: '## Polished library\n\nTwo directions: retrieval and inference.',
        tldr: ['retrieval', 'inference'],
      })
    },
  })
  const service = makeService(env, gateway)
  const graph = graphOfFrames(await collect(service.rebuildLibraryGraph()))
  expect(gateway.calls.length).toBe(1)
  expect(gateway.calls[0]?.purpose).toBe('graph-library-overview')
  expect(graph.overview).toBe('## Polished library\n\nTwo directions: retrieval and inference.')
  expect(graph.tldr).toBe('- retrieval\n- inference')
  expect(graph.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
})

test('library polish accepts raw Markdown and falls back on model failure', async () => {
  const markdownEnv = twoDocEnvironment()
  const markdownGateway = createFakeGateway({
    library() {
      return '## Custom overview\n\nRaw markdown consolidation.'
    },
  })
  const markdownGraph = graphOfFrames(await collect(makeService(markdownEnv, markdownGateway).rebuildLibraryGraph()))
  expect(markdownGraph.overview).toBe('## Custom overview\n\nRaw markdown consolidation.')

  const failingEnv = twoDocEnvironment()
  const failingGateway = createFakeGateway({
    library() {
      throw new Error('model down')
    },
  })
  const failingGraph = graphOfFrames(await collect(makeService(failingEnv, failingGateway).rebuildLibraryGraph()))
  expect(failingGraph.overview).toMatch(/## Library graph/)
  expect(failingGraph.tldr?.startsWith('- ')).toBe(true)
  expect(failingEnv.libraryAux.get('library-graph.json')).toBeTruthy()
})

/* -------------------------------------------------------------------------- */
/* Empty / cancellation                                                       */
/* -------------------------------------------------------------------------- */

test('empty library rebuild persists a deterministic empty graph', async () => {
  const env = createFakeStore()
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)
  expect(await service.libraryGraph()).toEqual({
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
  })

  const frames = await collect(service.rebuildLibraryGraph())
  const graph = graphOfFrames(frames)
  expect(graph.nodes.length).toBe(0)
  expect(graph.edges.length).toBe(0)
  expect((graph as KnowledgeGraph & { clusters?: unknown[] }).clusters).toEqual([])
  expect(graph.overview).toMatch(/No parsed documents yet/)
  expect(env.libraryAux.get('library-graph.json')).toBeTruthy()
  expect(await service.libraryGraph()).toEqual(graph)
})

test('corrupt library graph reads as an empty graph', async () => {
  const env = createFakeStore({ libraryGraph: { nodes: 'not-an-array', edges: [null] } })
  const service = makeService(env, createFakeGateway({ available: false }))
  const graph = await service.libraryGraph()
  expect(graph.scope).toBe('library')
  expect(graph.nodes).toEqual([])
  expect(graph.edges).toEqual([])
})

test('rebuildLibraryGraph cancellation surfaces an error frame and writes nothing', async () => {
  const env = twoDocEnvironment()
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)
  const controller = new AbortController()
  controller.abort()
  const frames = await collect(service.rebuildLibraryGraph({ signal: controller.signal }))
  expect(frames.at(-1)?.type).toBe('error')
  expect(frameErrorCode(frames.at(-1))).toBe('aborted')
  expect(env.libraryAux.has('library-graph.json')).toBe(false)
})

test('library edges are value-bearing: typed relations propagate and shared concepts link papers', async () => {
  const documents = [
    { id: 'doc-1', title: 'Paper One', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'doc-2', title: 'Paper Two', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'doc-3', title: 'Paper Three', createdAt: '2026-01-03T00:00:00.000Z' },
  ]
  const graphs = {
    'doc-1': docGraph('doc-1', [
      { id: 'n-1a', type: 'method', label: 'Topic A', summary: '', blockKeys: ['b1:aaaaaaaa'] },
      { id: 'n-1b', type: 'concept', label: 'Topic B', summary: '', blockKeys: [] },
    ], [{ id: 'e-1', from: 'n-1a', to: 'n-1b', type: 'supports', weight: 1 }]),
    'doc-2': docGraph('doc-2', [
      { id: 'n-2a', type: 'concept', label: 'Topic A', summary: '', blockKeys: [] },
      { id: 'n-2b', type: 'finding', label: 'Topic B', summary: '', blockKeys: [] },
    ], [{ id: 'e-2', from: 'n-2a', to: 'n-2b', type: 'uses', weight: 1 }]),
    'doc-3': docGraph('doc-3', [
      { id: 'n-3a', type: 'method', label: 'Topic A', summary: '', blockKeys: [] },
      { id: 'n-3c', type: 'concept', label: 'Topic C', summary: '', blockKeys: [] },
    ]),
  }
  const env = createFakeStore({ docs: documents, graphs })
  const service = makeService(env, createFakeGateway({ available: false }))
  const graph = graphOfFrames(await collect(service.rebuildLibraryGraph()))
  const topics = graph.nodes.filter((node) => node.type === 'topic')
  const byLabel = new Map(topics.map((topic) => [topic.label, topic]))
  for (const label of ['Topic A', 'Topic B', 'Topic C']) expect(byLabel.has(label)).toBe(true)
  const papers = graph.nodes.filter((node) => node.type === 'paper')
  expect(papers.length).toBe(3)

  // Representative concepts keep real coverage information.
  expect(nodeByLabel(graph, 'Topic A').documentIds?.length).toBe(3)
  expect(nodeByLabel(graph, 'Topic A').weight).toBeGreaterThanOrEqual(6)
  expect(nodeByLabel(graph, 'Topic B').documentIds?.length).toBe(2)
  expect(nodeByLabel(graph, 'Topic C').documentIds?.length).toBe(1)

  // Typed relations from document graphs survive (both supports and uses),
  // and no synthetic "all pairs" relates edges are produced.
  const typed = graph.edges.filter((edge) => ['supports', 'uses'].includes(edge.type))
  expect(typed.length).toBe(2)
  expect(typed.every((edge) => {
    const ids = new Set([edge.from, edge.to])
    return ids.has(nodeByLabel(graph, 'Topic A').id) && ids.has(nodeByLabel(graph, 'Topic B').id)
  })).toBe(true)
  expect(graph.edges.filter((edge) => edge.type === 'relates').length).toBe(0)

  // Cross-paper links: three papers share Topic A+B, A+C and A+B respectively.
  const shares = graph.edges.filter((edge) => edge.type === 'shares')
  expect(shares.length).toBe(3)
  expect(Math.max(...shares.map((edge) => edge.weight))).toBe(2)

  const clusters = (graph as KnowledgeGraph & { clusters?: Array<{ nodeIds: string[]; size: number }> }).clusters ?? []
  expect(clusters.length).toBe(2)
  const connected = clusters.find((cluster) => cluster.size === 2)
  expect(new Set(connected?.nodeIds)).toEqual(new Set([nodeByLabel(graph, 'Topic A').id, nodeByLabel(graph, 'Topic B').id]))
  expect(graph.overview).toMatch(/Shared concepts/)
  expect(graph.tldr).toMatch(/concepts? appear in two or more papers|concept appear/)
})

test('library curation merges alias labels within and across papers (no duplicate concepts)', async () => {
  const documents = [
    { id: 'doc-alias-1', title: 'Papers One', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'doc-alias-2', title: 'Papers Two', createdAt: '2026-01-02T00:00:00.000Z' },
  ]
  const graphs = {
    'doc-alias-1': docGraph('doc-alias-1', [
      { id: 'n-1a', type: 'concept', label: 'Subgraph Matching', summary: 'matching task', blockKeys: ['b1:aaaaaaaa'] },
      { id: 'n-1b', type: 'method', label: 'Spectral Dominance', summary: '', blockKeys: [] },
    ], [{ id: 'e-1', from: 'n-1b', to: 'n-1a', type: 'uses', weight: 1 }]),
    'doc-alias-2': docGraph('doc-alias-2', [
      { id: 'n-2a', type: 'concept', label: 'exact subgraph matching', summary: '', blockKeys: [] },
      { id: 'n-2b', type: 'method', label: 'Full Spectral Dominance', summary: '', blockKeys: [] },
    ], [{ id: 'e-2', from: 'n-2b', to: 'n-2a', type: 'uses', weight: 1 }]),
  }
  const env = createFakeStore({ docs: documents, graphs })
  const service = makeService(env, createFakeGateway({ available: false }))
  const graph = graphOfFrames(await collect(service.rebuildLibraryGraph()))
  const topics = graph.nodes.filter((node) => node.type === 'topic')
  expect(topics.length).toBe(2)
  const matching = topics.find((topic) => /subgraph matching/i.test(topic.label))
  const dominance = topics.find((topic) => /spectral dominance/i.test(topic.label))
  expect(matching).toBeDefined()
  expect(dominance).toBeDefined()
  expect(matching?.documentIds?.length).toBe(2)
  expect(dominance?.documentIds?.length).toBe(2)
  expect((matching?.blockKeys.length ?? 0)).toBeGreaterThanOrEqual(1)

  const mentions = graph.edges.filter((edge) => edge.type === 'mentions')
  expect(mentions.length).toBe(4)
  const shares = graph.edges.filter((edge) => edge.type === 'shares')
  expect(shares.length).toBe(1)
  expect(shares[0]?.weight).toBe(2)
  const relation = graph.edges.filter((edge) => edge.type === 'uses')
  expect(relation.length).toBe(1)
  expect(relation[0]?.weight).toBe(2)
})
