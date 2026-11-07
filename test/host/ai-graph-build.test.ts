/**
 * Unit tests for the document scope of the knowledge-graph engine
 * (`src/host/ai/graph.ts`): section-aware chunking with progress frames,
 * cross-chunk merge/dedupe, caps, cancellation, malformed model JSON, Q&A
 * knowledge merge, user edits/curation and empty fallbacks.
 *
 * The injected LLM gateway is fake (`completeText` only); the store fake keeps
 * aux JSON in memory and exposes the documented aux API.
 */

import { expect, test } from 'vitest'
import {
  createGraphService,
  type GraphLlmApi,
  type GraphStoreApi,
} from '../../src/host/ai/graph.ts'
import type { LlmCompleteRequest } from '../../src/host/ai/llm.ts'
import type { DocumentMeta, GraphBuildFrame, GraphEdge, GraphNode, KnowledgeGraph, ParsedDocument } from '../../src/shared/model.ts'

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** Flatten one completion request into its prompt text. */
function promptOf(request: LlmCompleteRequest): string {
  const parts: string[] = []
  if (typeof request.system === 'string') parts.push(request.system)
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (message === null || typeof message !== 'object') continue
    const content = message.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
      }
    }
  }
  return parts.join('\n\n')
}

/** Build a fenced model-output block. */
function fence(tag: string, payload: unknown): string {
  return `\`\`\`${tag}\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

/** Graph-extraction model output. */
function graphFence(nodes: readonly unknown[] = [], edges: readonly unknown[] = []): string {
  return fence('litnotes-graph', { nodes, edges })
}

/** Summary model output. */
function summaryFence(payload: Record<string, unknown>): string {
  return fence('litnotes-summary', payload)
}

/** One recorded fake-gateway call. */
interface GatewayCall {
  purpose: string | undefined
  prompt: string
  maxTokens: number | undefined
  signal: AbortSignal | undefined
}

/** Script functions accepted by {@link createFakeGateway}. */
interface GatewayScripts {
  available?: boolean
  extract?: (input: { index: number; prompt: string; request: LlmCompleteRequest }) => string
  summary?: (input: { prompt: string; request: LlmCompleteRequest }) => string
  library?: (input: { prompt: string; request: LlmCompleteRequest }) => string
}

/** Fake model gateway (`completeText` is the only method the graph path uses). */
interface FakeGateway extends GraphLlmApi {
  state: GatewayScripts
  calls: GatewayCall[]
}

/**
 * Fake model gateway. `scripts.extract` is a function `({ index, prompt })`
 * returning the extraction text; `scripts.summary` the summary text.
 */
function createFakeGateway(scripts: GatewayScripts = {}): FakeGateway {
  const state: GatewayScripts = {
    available: scripts.available !== false,
    extract: scripts.extract,
    summary: scripts.summary,
    library: scripts.library,
  }
  const calls: GatewayCall[] = []
  const gateway: FakeGateway = {
    state,
    calls,
    available(): boolean {
      return state.available !== false
    },
    route(): { provider: string; model: string } {
      return { provider: 'fake-provider', model: 'fake-model' }
    },
    async completeText(request: LlmCompleteRequest): Promise<string> {
      const prompt = promptOf(request)
      const purpose = request?.purpose
      calls.push({ purpose, prompt, maxTokens: request?.maxTokens, signal: request?.signal })
      if (purpose === 'graph-extract') {
        const index = calls.filter((call) => call.purpose === 'graph-extract').length
        if (typeof state.extract !== 'function') throw new Error('fake gateway: no extraction script')
        return state.extract({ index, prompt, request })
      }
      if (purpose === 'graph-summary') {
        if (typeof state.summary !== 'function') throw new Error('fake gateway: no summary script')
        return state.summary({ prompt, request })
      }
      if (purpose === 'graph-library-overview') {
        if (typeof state.library !== 'function') throw new Error('fake gateway: no library script')
        return state.library({ prompt, request })
      }
      throw new Error(`fake gateway: unexpected purpose ${String(purpose)}`)
    },
  }
  return gateway
}

/** In-memory store exposing the documented aux API. */
interface FakeGraphStore {
  list: () => DocumentMeta[]
  get: (id: string) => DocumentMeta | undefined
  readMarkdown: (id: string) => Promise<ParsedDocument>
  loadAnnotations: (id: string) => Promise<{ version: 1; items: never[] }>
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
  docs?: Array<Partial<DocumentMeta> & { id: string }>
  markdown?: Record<string, string>
  annotations?: Record<string, { version: 1; items: DocumentMeta[] }>
  graphs?: Record<string, unknown>
  libraryGraph?: unknown
} = {}): FakeEnv {
  const docList: DocumentMeta[] = (options.docs ?? []).map((doc) => ({
    status: 'parsed',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...doc,
  } as unknown as DocumentMeta))
  const docsById = new Map(docList.map((doc) => [doc.id, doc]))
  const markdowns = new Map<string, string>(Object.entries(options.markdown ?? {}))
  const annotationMap = new Map<string, unknown>(Object.entries(options.annotations ?? {}))
  const aux = new Map<string, unknown>()
  const libraryAux = new Map<string, unknown>()
  for (const [id, value] of Object.entries(options.graphs ?? {})) aux.set(`${id}/graph.json`, structuredClone(value))
  if (options.libraryGraph !== undefined) libraryAux.set('library-graph.json', structuredClone(options.libraryGraph))
  const store: FakeGraphStore = {
    list(): DocumentMeta[] {
      return docList.map((doc) => structuredClone(doc))
    },
    get(id: string): DocumentMeta | undefined {
      return docsById.has(id) ? structuredClone(docsById.get(id)) : undefined
    },
    async readMarkdown(id: string): Promise<ParsedDocument> {
      if (!markdowns.has(id)) {
        const error = new Error('Document has not been parsed yet') as Error & { code: string }
        error.code = 'not-parsed'
        throw error
      }
      return { markdown: markdowns.get(id) ?? '', contentList: null, pages: null }
    },
    async loadAnnotations(id: string): Promise<{ version: 1; items: never[] }> {
      return structuredClone((annotationMap.get(id) ?? { version: 1, items: [] }) as { version: 1; items: never[] })
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
    // The fake implements exactly the aux subset the graph service consumes.
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
function graphOfFrames(frames: readonly GraphBuildFrame[]): KnowledgeGraph {
  const frame = [...frames].reverse().find((candidate) => candidate.type === 'graph')
  expect(frame, 'expected a graph frame').toBeDefined()
  if (frame === undefined || frame.type !== 'graph') throw new Error('missing graph frame')
  return frame.graph
}

/** Find one persisted document graph (raw aux) or undefined. */
function persistedGraph(env: FakeEnv, documentId: string): unknown {
  return env.aux.get(`${documentId}/graph.json`)
}

/** Stable error code of one build frame (`''` for non-error frames). */
function frameErrorCode(frame: GraphBuildFrame | undefined): string {
  return frame !== undefined && frame.type === 'error' ? frame.code : ''
}

/** Find a node by label (fails when absent). */
function nodeByLabel(graph: KnowledgeGraph, label: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.label === label)
  expect(node, `expected node with label ${label}`).toBeDefined()
  if (node === undefined) throw new Error(`missing node: ${label}`)
  return node
}

/** Find an edge by type (fails when absent). */
function edgeByType(graph: KnowledgeGraph, type: string): GraphEdge {
  const edge = graph.edges.find((candidate) => candidate.type === type)
  expect(edge, `expected edge of type ${type}`).toBeDefined()
  if (edge === undefined) throw new Error(`missing edge: ${type}`)
  return edge
}

/** Two long markdown sections, guaranteed to chunk separately. */
function twoSectionMarkdown(): string {
  return [
    '## Method',
    '',
    'Sparse attention reduces computation cost for long sequences. '.repeat(35),
    '',
    '## Results',
    '',
    'Efficiency improves on retrieval benchmarks with linear memory. '.repeat(35),
  ].join('\n')
}

/** Read the first `[[blockKey]]` markers out of a prompt. */
function keysInPrompt(prompt: string): string[] {
  const keys: string[] = []
  const pattern = /\[\[(b\d+:[0-9a-f]{8})\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt)) !== null) {
    const key = match[1]
    if (key !== undefined && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

test('buildDocGraph chunks by section, emits progress and merges duplicate nodes across chunks', async () => {
  const documentId = 'doc-build-1'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Sparse Attention Paper' }],
    markdown: { [documentId]: twoSectionMarkdown() },
  })
  const gateway = createFakeGateway({
    extract({ index, prompt }) {
      const keys = keysInPrompt(prompt)
      if (index === 1) {
        return graphFence(
          [
            { type: 'method', label: 'Sparse Attention', summary: 'Reduces computation cost', blockKeys: keys.slice(0, 1), aspect: 'method' },
            { type: 'concept', label: 'Long-range Dependency', summary: '', blockKeys: keys.slice(1, 2) },
          ],
          [{ from: 'Sparse Attention', to: 'Long-range Dependency', type: 'uses' }],
        )
      }
      return graphFence(
        [{ type: 'method', label: 'sparse attention!', summary: '', blockKeys: keys.slice(0, 1) }],
        [{ from: 'Sparse Attention', to: 'Efficiency', type: 'supports' }],
      )
    },
    summary() {
      const key = 'b1:594d29c7'
      return summaryFence({
        overview: '## Overview\n\nPolished orientation.',
        tldr: ['First takeaway', 'Second takeaway', 'Third takeaway'],
        glossary: [{ term: 'Sparse Attention', definition: 'Attention restricted to sparse positions.', blockKeys: [key] }],
      })
    },
  })
  const service = makeService(env, gateway)

  const frames = await collect(service.buildDocGraph(documentId))
  const phases = frames.filter((frame) => frame.type === 'progress').map((frame) => (frame.type === 'progress' ? frame.phase : ''))
  expect(frames[0]?.type).toBe('progress')
  expect(frames[0]?.type === 'progress' ? frames[0].phase : '').toBe('reading')
  expect(phases).toEqual(['reading', 'reading', 'extracting', 'extracting', 'merging', 'done'])

  const extracting = frames.filter((frame) => frame.type === 'progress' && frame.phase === 'extracting')
  expect(extracting.length).toBe(2)
  expect(extracting.map((frame) => (frame.type === 'progress' ? frame.chunk : -1))).toEqual([1, 2])
  expect(extracting.map((frame) => (frame.type === 'progress' ? frame.done : -1))).toEqual([1, 2])
  expect(extracting.every((frame) => frame.type === 'progress' && frame.total === 2)).toBe(true)

  expect(gateway.calls.filter((call) => call.purpose === 'graph-extract').length).toBe(2)
  const graph = graphOfFrames(frames)
  expect(graph.scope).toBe('document')
  expect(graph.documentId).toBe(documentId)
  expect(graph.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
  expect(graph.nodes.every((node) => /^n-/.test(node.id))).toBe(true)
  expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length)

  const merged = graph.nodes.filter(
    (node) => node.type === 'method' && node.label.toLowerCase().replace(/[^a-z]+/g, '').startsWith('sparseattention'),
  )
  expect(merged.length).toBe(1)
  const mergedNode = merged[0]
  if (mergedNode === undefined) throw new Error('missing merged method node')
  expect(mergedNode.label).toBe('Sparse Attention')
  expect(mergedNode.blockKeys.length).toBe(2)
  expect(mergedNode.summary).toBe('Reduces computation cost')
  expect(mergedNode.weight).toBe(2)

  // The unresolved "Efficiency" endpoint became a placeholder concept node.
  expect(graph.nodes.some((node) => node.label === 'Efficiency')).toBe(true)
  expect(graph.edges.length).toBe(2)
  const supported = edgeByType(graph, 'supports')
  expect(supported.from).toBe(mergedNode.id)
  expect(graph.nodes.some((node) => node.id === supported.to && node.label === 'Efficiency')).toBe(true)

  expect(graph.overview).toBe('## Overview\n\nPolished orientation.')
  expect(graph.tldr).toBe('- First takeaway\n- Second takeaway\n- Third takeaway')
  expect(graph.glossary?.length).toBe(1)
  expect(graph.glossary?.[0]?.term).toBe('Sparse Attention')
  expect(graph.glossary?.[0]?.blockKeys.every((key) => /^b\d+:[0-9a-f]{8}$/.test(key))).toBe(true)
  expect(graph.stats).toEqual({ nodes: graph.nodes.length, edges: graph.edges.length, builtAtSeq: null })

  expect(persistedGraph(env, documentId)).toEqual(graph)
})

test('buildDocGraph caps nodes and edges, and falls back to a deterministic summary', async () => {
  const documentId = 'doc-caps'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Cap Paper' }],
    markdown: { [documentId]: '## Cap\n\nBody text about many concepts. '.repeat(40) },
  })
  const nodes = Array.from({ length: 130 }, (_, index) => ({
    type: 'concept',
    label: `Concept ${index}`,
    summary: '',
    blockKeys: [],
  }))
  const edges: Array<{ from: string; to: string; type: string }> = []
  outer: for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      edges.push({ from: nodes[left]?.label ?? '', to: nodes[right]?.label ?? '', type: 'relates' })
      if (edges.length >= 450) break outer
    }
  }
  const gateway = createFakeGateway({
    extract() {
      return graphFence(nodes, edges)
    },
    summary() {
      throw new Error('summary model down')
    },
  })
  const service = makeService(env, gateway)
  const frames = await collect(service.buildDocGraph(documentId))
  const graph = graphOfFrames(frames)

  expect(graph.nodes.length).toBe(120)
  expect(graph.edges.length).toBe(400)
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  for (const edge of graph.edges) {
    expect(nodeIds.has(edge.from) && nodeIds.has(edge.to), 'no dangling edges after capping').toBe(true)
  }
  expect(graph.nodes.some((node) => node.label === 'Concept 0')).toBe(true)
  expect(graph.nodes.some((node) => node.label === 'Concept 129')).toBe(false)
  expect(gateway.calls.filter((call) => call.purpose === 'graph-summary').length).toBe(1)
  expect(graph.overview.startsWith('## Cap Paper')).toBe(true)
  expect(graph.tldr?.startsWith('- ')).toBe(true)
})

test('buildDocGraph skips malformed JSON chunks and continues', async () => {
  const documentId = 'doc-malformed'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Tolerant Build' }],
    markdown: { [documentId]: twoSectionMarkdown() },
  })
  const gateway = createFakeGateway({
    extract({ index, prompt }) {
      if (index === 1) return 'I am afraid I cannot return JSON for this chunk.'
      const keys = keysInPrompt(prompt)
      return graphFence([{ type: 'finding', label: 'Linear memory', summary: '', blockKeys: keys.slice(0, 1) }])
    },
    summary() {
      return 'this is not a summary payload'
    },
  })
  const service = makeService(env, gateway)
  const frames = await collect(service.buildDocGraph(documentId))
  expect(frames.filter((frame) => frame.type === 'error').length).toBe(0)
  const graph = graphOfFrames(frames)
  expect(graph.nodes.length).toBe(1)
  expect(graph.nodes[0]?.label).toBe('Linear memory')
  expect(graph.overview.startsWith('## Tolerant Build')).toBe(true)
})

test('buildDocGraph returns an empty graph when every chunk is malformed (no throw)', async () => {
  const documentId = 'doc-all-malformed'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Empty Result' }],
    markdown: { [documentId]: '## Nothing\n\nSome text without extractable JSON.' },
  })
  const gateway = createFakeGateway({
    extract() {
      return 'no json here'
    },
  })
  const service = makeService(env, gateway)
  const frames = await collect(service.buildDocGraph(documentId))
  const graph = graphOfFrames(frames)
  expect(frames.filter((frame) => frame.type === 'error').length).toBe(0)
  expect(graph.nodes.length).toBe(0)
  expect(graph.edges.length).toBe(0)
  expect(graph.overview).toMatch(/No concepts were extracted/)
  expect(gateway.calls.filter((call) => call.purpose === 'graph-summary').length).toBe(0)
  expect(persistedGraph(env, documentId)).toBeTruthy()
})

test('empty documents build without model calls and persist an empty graph', async () => {
  const documentId = 'doc-empty'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Blank' }],
    markdown: { [documentId]: '   \n\n' },
  })
  const gateway = createFakeGateway({
    extract() {
      throw new Error('model must not be called for an empty document')
    },
  })
  const service = makeService(env, gateway)
  expect(await service.docGraph(documentId)).toEqual({
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
  })

  const frames = await collect(service.buildDocGraph(documentId))
  expect(gateway.calls.length).toBe(0)
  const graph = graphOfFrames(frames)
  expect(graph.nodes.length).toBe(0)
  expect(graph.overview).toMatch(/No concepts were extracted/)
  expect(persistedGraph(env, documentId)).toBeTruthy()
})

test('buildDocGraph cancellation before start and between chunks yields an error frame and persists nothing', async () => {
  const documentId = 'doc-cancel'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Cancel Me' }],
    markdown: { [documentId]: twoSectionMarkdown() },
  })

  const before = new AbortController()
  before.abort()
  const gatewayBefore = createFakeGateway({
    extract() {
      throw new Error('model must not be called after abort')
    },
  })
  const serviceBefore = makeService(env, gatewayBefore)
  const beforeFrames = await collect(serviceBefore.buildDocGraph(documentId, { signal: before.signal }))
  expect(gatewayBefore.calls.length).toBe(0)
  expect(beforeFrames.at(-1)?.type).toBe('error')
  expect(frameErrorCode(beforeFrames.at(-1))).toBe('aborted')
  expect(beforeFrames.some((frame) => frame.type === 'graph')).toBe(false)
  expect(persistedGraph(env, documentId)).toBeUndefined()

  const during = new AbortController()
  const gatewayDuring = createFakeGateway({
    extract({ index, prompt }) {
      during.abort()
      return graphFence([{ type: 'concept', label: `Partial ${index}`, summary: '', blockKeys: keysInPrompt(prompt).slice(0, 1) }], [])
    },
  })
  const serviceDuring = makeService(env, gatewayDuring)
  const duringFrames = await collect(serviceDuring.buildDocGraph(documentId, { signal: during.signal }))
  expect(gatewayDuring.calls.filter((call) => call.purpose === 'graph-extract').length).toBe(1)
  expect(duringFrames.at(-1)?.type).toBe('error')
  expect(frameErrorCode(duringFrames.at(-1))).toBe('aborted')
  expect(duringFrames.some((frame) => frame.type === 'graph')).toBe(false)
  expect(persistedGraph(env, documentId)).toBeUndefined()
})

test('buildDocGraph honors a cached graph unless force is set', async () => {
  const documentId = 'doc-cache'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Cache Me' }],
    markdown: { [documentId]: '## Cache\n\nText about caching. ' },
  })
  const firstGateway = createFakeGateway({
    extract() {
      return graphFence([{ type: 'concept', label: 'Cached Concept', summary: '', blockKeys: [] }], [])
    },
    summary() {
      return summaryFence({ overview: 'Cached overview', tldr: ['cached'], glossary: [] })
    },
  })
  const first = makeService(env, firstGateway)
  const firstFrames = await collect(first.buildDocGraph(documentId))
  const built = graphOfFrames(firstFrames)
  expect(built.nodes.length).toBe(1)

  const cacheGateway = createFakeGateway({
    extract() {
      throw new Error('cache hit must not call the model')
    },
  })
  const cachedService = makeService(env, cacheGateway)
  const cachedFrames = await collect(cachedService.buildDocGraph(documentId))
  expect(cacheGateway.calls.length).toBe(0)
  expect(graphOfFrames(cachedFrames)).toEqual(built)

  const forcedGateway = createFakeGateway({
    extract() {
      return graphFence([{ type: 'finding', label: 'Forced Concept', summary: '', blockKeys: [] }], [])
    },
    summary() {
      return summaryFence({ overview: 'Forced overview', tldr: ['forced'], glossary: [] })
    },
  })
  const forcedService = makeService(env, forcedGateway)
  const forcedFrames = await collect(forcedService.buildDocGraph(documentId, { force: true }))
  expect(forcedGateway.calls.filter((call) => call.purpose === 'graph-extract').length).toBeGreaterThanOrEqual(1)
  expect(graphOfFrames(forcedFrames).nodes[0]?.label).toBe('Forced Concept')
})

test('buildDocGraph reports llm-unavailable instead of throwing', async () => {
  const documentId = 'doc-unavailable'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'No Model' }],
    markdown: { [documentId]: '## Intro\n\nText.' },
  })
  const gateway = createFakeGateway({ available: false, extract() { return '' } })
  const service = makeService(env, gateway)
  const frames = await collect(service.buildDocGraph(documentId))
  expect(frames.at(-1)?.type).toBe('error')
  expect(frameErrorCode(frames.at(-1))).toBe('llm-unavailable')
  expect(gateway.calls.length).toBe(0)
})

test('buildDocGraph passes the abort signal to the model gateway', async () => {
  const documentId = 'doc-signal'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Signal' }],
    markdown: { [documentId]: '## S\n\nBody text.' },
  })
  const gateway = createFakeGateway({
    extract() {
      return graphFence([], [])
    },
  })
  const service = makeService(env, gateway)
  const controller = new AbortController()
  await collect(service.buildDocGraph(documentId, { signal: controller.signal }))
  expect(gateway.calls.length).toBeGreaterThan(0)
  expect(gateway.calls.every((call) => call.signal === controller.signal)).toBe(true)
})

/* -------------------------------------------------------------------------- */
/* Merge / update                                                             */
/* -------------------------------------------------------------------------- */

test('mergeDocKnowledge adds Q&A nodes and edges, resolves labels and keeps node ids', async () => {
  const documentId = 'doc-merge'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Merge Paper' }],
    markdown: { [documentId]: '## M\n\nBody text.' },
  })
  const gateway = createFakeGateway({
    extract() {
      return graphFence(
        [
          { type: 'method', label: 'Sparse Attention', summary: 'Original summary', blockKeys: [] },
          { type: 'concept', label: 'Long-range Dependency', summary: '', blockKeys: [] },
        ],
        [{ from: 'Sparse Attention', to: 'Long-range Dependency', type: 'uses' }],
      )
    },
    summary() {
      return summaryFence({ overview: 'Built overview', tldr: ['built'], glossary: [] })
    },
  })
  const service = makeService(env, gateway)
  const built = graphOfFrames(await collect(service.buildDocGraph(documentId)))
  const sparse = nodeByLabel(built, 'Sparse Attention')
  const dependency = nodeByLabel(built, 'Long-range Dependency')

  const merged = await service.mergeDocKnowledge(documentId, {
    nodes: [
      { type: 'insight', label: 'Quadratic cost', summary: 'Cost grows with sequence length.', blockKeys: [] },
      { type: 'question', label: 'How does attention scale?', summary: '', blockKeys: [] },
    ],
    edges: [
      { from: 'Sparse Attention', to: 'Quadratic cost', type: 'leads_to' },
      { from: 'Quadratic cost', to: 'How does attention scale?', type: 'answers' },
    ],
  })
  expect(merged.nodes.find((node) => node.label === 'Sparse Attention')?.id).toBe(sparse.id)
  expect(merged.nodes.find((node) => node.label === 'Long-range Dependency')?.id).toBe(dependency.id)
  const insight = nodeByLabel(merged, 'Quadratic cost')
  expect(insight.source).toBe('qa')
  const leadsTo = edgeByType(merged, 'leads_to')
  expect(leadsTo.from).toBe(sparse.id)
  expect(leadsTo.to).toBe(insight.id)
  expect(merged.edges.every((edge) => merged.nodes.some((node) => node.id === edge.from))).toBe(true)
  expect(persistedGraph(env, documentId)).toEqual(merged)

  const before = structuredClone(merged)
  const unchanged = await service.mergeDocKnowledge(documentId, { nodes: [], edges: [] })
  expect(unchanged).toEqual(before)

  const withPlaceholder = await service.mergeDocKnowledge(documentId, {
    edges: [{ from: 'Sparse Attention', to: 'Efficiency at scale', type: 'supports' }],
  })
  const placeholder = withPlaceholder.nodes.find((node) => node.label === 'Efficiency at scale')
  expect(placeholder).toBeDefined()
  expect(placeholder?.source).toBe('qa')
  expect(withPlaceholder.edges.some((edge) => edge.to === placeholder?.id)).toBe(true)
})

test('updateDocGraph upserts user edits by id, preserves ids and keeps existing data', async () => {
  const documentId = 'doc-update'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Update Paper' }],
    markdown: { [documentId]: '## U\n\nBody text.' },
  })
  const gateway = createFakeGateway({
    extract() {
      return graphFence(
        [
          { type: 'method', label: 'Sparse Attention', summary: 'Original summary', blockKeys: [] },
          { type: 'concept', label: 'Long-range Dependency', summary: '', blockKeys: [] },
        ],
        [{ from: 'Sparse Attention', to: 'Long-range Dependency', type: 'uses' }],
      )
    },
    summary() {
      return summaryFence({ overview: 'Original overview', tldr: ['built'], glossary: [] })
    },
  })
  const service = makeService(env, gateway)
  const built = graphOfFrames(await collect(service.buildDocGraph(documentId)))
  const sparse = nodeByLabel(built, 'Sparse Attention')
  const dependency = nodeByLabel(built, 'Long-range Dependency')

  const updated = await service.updateDocGraph(documentId, {
    nodes: [
      { id: sparse.id, label: 'Linear Attention', summary: 'Curated summary' },
      { type: 'limitation', label: 'Compute bound', summary: 'Memory limits long inputs.' },
    ],
    edges: [{ from: sparse.id, to: dependency.id, type: 'supports', label: 'user edge' }],
  })
  const renamed = updated.nodes.find((node) => node.id === sparse.id)
  expect(renamed?.label).toBe('Linear Attention')
  expect(renamed?.summary).toBe('Curated summary')
  expect(renamed?.source).toBe('ai-summary')
  expect(renamed?.curated).toBe(true)
  expect(updated.nodes.find((node) => node.label === 'Long-range Dependency')?.id).toBe(dependency.id)
  expect(updated.nodes.some((node) => node.label === 'Compute bound' && node.type === 'limitation')).toBe(true)
  expect(updated.edges.some((edge) => edge.type === 'supports' && edge.from === sparse.id)).toBe(true)
  expect(updated.edges.some((edge) => edge.type === 'uses')).toBe(true)
  expect(persistedGraph(env, documentId)).toEqual(updated)

  const unchanged = await service.updateDocGraph(documentId, {})
  expect(unchanged).toEqual(updated)
})

/* -------------------------------------------------------------------------- */
/* Curation (pin / position / merge)                                          */
/* -------------------------------------------------------------------------- */

/** Seed one persisted document graph with fixed timestamps for deterministic tests. */
function seedGraph(env: FakeEnv, documentId: string, nodes: readonly unknown[], edges: readonly unknown[] = []): void {
  env.aux.set(`${documentId}/graph.json`, {
    version: 1,
    scope: 'document',
    documentId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    model: { provider: 'fake-provider', model: 'fake-model' },
    overview: 'Seeded overview',
    tldr: '- seeded',
    glossary: [],
    nodes,
    edges,
    stats: { nodes: nodes.length, edges: edges.length, builtAtSeq: null },
  })
}

/** One fully populated document-scope node for curation tests. */
function seedNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'n-seed',
    type: 'concept',
    label: 'Seed Node',
    summary: '',
    blockKeys: [],
    source: 'ai-summary',
    weight: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A graph service over a seeded graph (the gateway is never called). */
function curationService(documentId: string): { env: FakeEnv; service: ReturnType<typeof createGraphService> } {
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Curation Paper' }],
    markdown: { [documentId]: '## Curation\n\nBody text.' },
  })
  return { env, service: makeService(env, createFakeGateway({})) }
}

test('updateDocGraph patches only provided node fields, never clobbers source and marks curated', async () => {
  const documentId = 'doc-curation-patch'
  const { env, service } = curationService(documentId)
  seedGraph(env, documentId, [seedNode({ id: 'n-alpha', label: 'Alpha', summary: 'AI summary', blockKeys: [] })])

  const patched = await service.updateDocGraph(documentId, { nodes: [{ id: 'n-alpha', label: 'Alpha Curated' }] })
  const node = patched.nodes.find((item) => item.id === 'n-alpha')
  expect(node?.label).toBe('Alpha Curated')
  expect(node?.summary).toBe('AI summary')
  expect(node?.source).toBe('ai-summary')
  expect(node?.curated).toBe(true)
  expect(node?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z')

  // A caller that does send `source` can still set it explicitly.
  const explicit = await service.updateDocGraph(documentId, { nodes: [{ id: 'n-alpha', source: 'user' }] })
  expect(explicit.nodes.find((item) => item.id === 'n-alpha')?.source).toBe('user')
  expect(persistedGraph(env, documentId)).toEqual(explicit)

  // Brand-new nodes created through the curation API are user-sourced + curated.
  const added = await service.updateDocGraph(documentId, {
    nodes: [{ type: 'insight', label: 'Brand New Insight', summary: 'Created by the user.' }],
  })
  const created = added.nodes.find((item) => item.label === 'Brand New Insight')
  expect(created?.source).toBe('user')
  expect(created?.curated).toBe(true)
  expect(typeof created?.updatedAt).toBe('string')
})

test('updateDocGraph validates pinned/position and persists them across writes', async () => {
  const documentId = 'doc-curation-pin'
  const { env, service } = curationService(documentId)
  seedGraph(env, documentId, [seedNode({ id: 'n-pin', label: 'Pinnable' })])

  // Negative and far-out coordinates are valid world pixels on the infinite
  // canvas; only the ±100000 persistence ceiling clamps.
  const pinned = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-pin', pinned: true, position: { x: -20, y: 2500.55 } }],
  })
  let node = pinned.nodes.find((item) => item.id === 'n-pin')
  expect(node?.pinned).toBe(true)
  expect(node?.position).toEqual({ x: -20, y: 2500.6 })
  expect(node?.curated).toBe(true)
  expect((persistedGraph(env, documentId) as { nodes: GraphNode[] }).nodes[0]?.position).toEqual({ x: -20, y: 2500.6 })

  // Invalid values never overwrite valid state: non-boolean pin, non-finite axes.
  const invalid = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-pin', pinned: 'yes', position: { x: 'nope', y: 42 } }],
  })
  node = invalid.nodes.find((item) => item.id === 'n-pin')
  expect(node?.pinned).toBe(true)
  expect(node?.position).toEqual({ x: -20, y: 2500.6 })

  // Positions round to 0.1 (the layout precision).
  const rounded = await service.updateDocGraph(documentId, { nodes: [{ id: 'n-pin', position: { x: 123.456, y: 789.987 } }] })
  node = rounded.nodes.find((item) => item.id === 'n-pin')
  expect(node?.position).toEqual({ x: 123.5, y: 790 })

  // The ±100000 ceiling keeps hostile/huge payloads finite.
  const clamped = await service.updateDocGraph(documentId, { nodes: [{ id: 'n-pin', position: { x: -500000, y: 500000 } }] })
  node = clamped.nodes.find((item) => item.id === 'n-pin')
  expect(node?.position).toEqual({ x: -100000, y: 100000 })

  // `pinned: false` clears the marker but keeps the stored position.
  const unpinned = await service.updateDocGraph(documentId, { nodes: [{ id: 'n-pin', pinned: false }] })
  node = unpinned.nodes.find((item) => item.id === 'n-pin')
  expect(node !== undefined && 'pinned' in node).toBe(false)
  expect(node?.position).toEqual({ x: -100000, y: 100000 })

  // NaN/Infinity positions are rejected too.
  const bad = await service.updateDocGraph(documentId, { nodes: [{ id: 'n-pin', position: { x: NaN, y: Infinity } }] })
  expect(bad.nodes.find((item) => item.id === 'n-pin')?.position).toEqual({ x: -100000, y: 100000 })

  // A new node may be created already pinned.
  const created = await service.updateDocGraph(documentId, {
    nodes: [{ type: 'method', label: 'Pinned New Node', pinned: true, position: { x: 300.04, y: 400 } }],
  })
  const newbie = created.nodes.find((item) => item.label === 'Pinned New Node')
  expect(newbie?.pinned).toBe(true)
  expect(newbie?.position).toEqual({ x: 300, y: 400 })
  expect(newbie?.curated).toBe(true)
})

test('updateDocGraph merge folds nodes, unions evidence, rewires/dedupes edges and drops self-loops', async () => {
  const documentId = 'doc-curation-merge'
  const { env, service } = curationService(documentId)
  seedGraph(
    env,
    documentId,
    [
      seedNode({ id: 'n-a', type: 'method', label: 'Alpha', summary: 'Source summary', blockKeys: ['b0:11111111'], aspect: 'method', weight: 1, pinned: true, position: { x: 10.5, y: 20 } }),
      seedNode({ id: 'n-b', type: 'method', label: 'Beta', summary: 'Target summary', blockKeys: ['b1:22222222'], aspect: 'result', weight: 3, documentIds: ['doc-1'] }),
      seedNode({ id: 'n-c', label: 'Gamma' }),
      seedNode({ id: 'n-d', label: 'Delta' }),
    ],
    [
      { id: 'e-a-c', from: 'n-a', to: 'n-c', type: 'uses', source: 'ai-summary', weight: 3, label: 'strong' },
      { id: 'e-b-c', from: 'n-b', to: 'n-c', type: 'uses', source: 'ai-summary', weight: 1 },
      { id: 'e-d-a', from: 'n-d', to: 'n-a', type: 'supports', source: 'ai-summary', weight: 2 },
      { id: 'e-c-a', from: 'n-c', to: 'n-a', type: 'relates', source: 'ai-summary', weight: 1 },
      { id: 'e-a-b', from: 'n-a', to: 'n-b', type: 'uses', source: 'ai-summary', weight: 5 },
    ],
  )

  const merged = await service.updateDocGraph(documentId, { merge: [{ from: 'n-a', into: 'n-b' }] })
  const beta = merged.nodes.find((item) => item.id === 'n-b')
  expect(beta).toBeDefined()
  expect(merged.nodes.some((item) => item.id === 'n-a')).toBe(false)
  expect(beta?.label).toBe('Beta')
  expect(beta?.summary).toBe('Target summary')
  expect(beta?.aspect).toBe('result')
  expect(beta?.weight).toBe(3)
  expect(beta?.blockKeys).toEqual(['b1:22222222', 'b0:11111111'])
  expect(beta?.documentIds).toEqual(['doc-1'])
  expect(beta?.pinned).toBe(true)
  expect(beta?.position).toEqual({ x: 10.5, y: 20 })
  expect(beta?.curated).toBe(true)

  // Both directions are rewired, duplicates dedupe by from|to|type keeping the
  // highest weight and user provenance, and n-a→n-b becomes a dropped self-loop.
  expect(merged.edges.some((edge) => edge.from === 'n-a' || edge.to === 'n-a')).toBe(false)
  expect(merged.edges.every((edge) => edge.from !== edge.to)).toBe(true)
  const keys = merged.edges.map((edge) => `${edge.from}|${edge.to}|${edge.type}`)
  expect(new Set(keys).size).toBe(keys.length)
  const uses = merged.edges.find((edge) => edge.from === 'n-b' && edge.to === 'n-c' && edge.type === 'uses')
  expect(uses?.weight).toBe(3)
  expect(uses?.label).toBe('strong')
  expect(merged.edges.some((edge) => edge.from === 'n-d' && edge.to === 'n-b' && edge.type === 'supports')).toBe(true)
  expect(merged.edges.some((edge) => edge.from === 'n-c' && edge.to === 'n-b' && edge.type === 'relates')).toBe(true)
  expect(merged.edges.length).toBe(3)
  expect(merged.stats).toEqual({ nodes: 3, edges: 3, builtAtSeq: null })
  expect(persistedGraph(env, documentId)).toEqual(merged)

  // Unknown ids, self-merges and malformed pairs are ignored without throwing.
  const before = structuredClone(merged)
  const noop = await service.updateDocGraph(documentId, {
    merge: [
      { from: 'n-missing', into: 'n-b' },
      { from: 'n-b', into: 'n-missing' },
      { from: 'n-b', into: 'n-b' },
      { from: '', into: 'n-b' },
      { from: 'n-b' },
      'nonsense',
    ] as unknown as Array<{ from: string; into: string }>,
  })
  expect(noop).toEqual(before)

  // Merging a curated node again marks/keeps the surviving target curated.
  const second = await service.updateDocGraph(documentId, { merge: [{ from: 'n-c', into: 'n-b' }] })
  expect(second.nodes.some((item) => item.id === 'n-c')).toBe(false)
  expect(second.nodes.find((item) => item.id === 'n-b')?.curated).toBe(true)
})

test('a forced rebuild preserves curated nodes with their label/position and qa/user knowledge', async () => {
  const documentId = 'doc-curation-rebuild'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Curated Rebuild Paper' }],
    markdown: { [documentId]: '## Rebuild\n\nBody text about rebuilding. ' },
  })
  const firstGateway = createFakeGateway({
    extract() {
      return graphFence(
        [
          { type: 'method', label: 'Sparse Attention', summary: 'AI summary', blockKeys: [] },
          { type: 'concept', label: 'Long-range Dependency', summary: '', blockKeys: [] },
        ],
        [{ from: 'Sparse Attention', to: 'Long-range Dependency', type: 'uses' }],
      )
    },
    summary() {
      return summaryFence({ overview: 'First overview', tldr: ['built'], glossary: [] })
    },
  })
  const service = makeService(env, firstGateway)
  const built = graphOfFrames(await collect(service.buildDocGraph(documentId)))
  const sparse = nodeByLabel(built, 'Sparse Attention')
  const dependency = nodeByLabel(built, 'Long-range Dependency')

  // Curate: rename + pin the first node, pin a position on the second one.
  await service.updateDocGraph(documentId, {
    nodes: [
      { id: sparse.id, label: 'Sparse Attention (curated)', pinned: true, position: { x: 120.5, y: 340 } },
      { id: dependency.id, pinned: true, position: { x: 480, y: 660 } },
    ],
  })
  // Q&A knowledge added while reading must survive the same rebuild too.
  await service.mergeDocKnowledge(documentId, {
    nodes: [{ type: 'insight', label: 'QA Insight', summary: 'From the reading conversation.' }],
  })

  // Simulate a full re-extraction: the model returns the original labels again.
  const rebuildGateway = createFakeGateway({
    extract() {
      return graphFence(
        [
          { type: 'method', label: 'Sparse Attention', summary: 'Re-extracted summary', blockKeys: [] },
          { type: 'concept', label: 'Long-range Dependency', summary: '', blockKeys: [] },
          { type: 'finding', label: 'Fresh Finding', summary: '', blockKeys: [] },
        ],
        [{ from: 'Sparse Attention', to: 'Fresh Finding', type: 'supports' }],
      )
    },
    summary() {
      return summaryFence({ overview: 'Rebuilt overview', tldr: ['rebuilt'], glossary: [] })
    },
  })
  const rebuiltService = makeService(env, rebuildGateway)
  const frames = await collect(rebuiltService.buildDocGraph(documentId, { force: true }))
  const rebuilt = graphOfFrames(frames)

  const curated = rebuilt.nodes.find((node) => node.label === 'Sparse Attention (curated)')
  expect(curated).toBeDefined()
  expect(curated?.pinned).toBe(true)
  expect(curated?.position).toEqual({ x: 120.5, y: 340 })
  expect(curated?.curated).toBe(true)
  expect(curated?.source).toBe('ai-summary')

  const rebuiltDependency = rebuilt.nodes.find((node) => node.label === 'Long-range Dependency')
  expect(rebuiltDependency).toBeDefined()
  expect(rebuiltDependency?.pinned).toBe(true)
  expect(rebuiltDependency?.position).toEqual({ x: 480, y: 660 })
  expect(rebuiltDependency?.curated).toBe(true)

  expect(rebuilt.nodes.some((node) => node.label === 'QA Insight' && node.source === 'qa')).toBe(true)
  expect(rebuilt.nodes.some((node) => node.label === 'Fresh Finding')).toBe(true)
  expect(rebuilt.edges.some((edge) => edge.from === curated?.id && edge.type === 'uses')).toBe(true)
  expect(rebuilt.overview).toBe('Rebuilt overview')
})

test('an empty forced rebuild keeps curated and qa knowledge without model calls', async () => {
  const documentId = 'doc-curation-empty-rebuild'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Empty Curated' }],
    markdown: { [documentId]: '   \n\n' },
  })
  seedGraph(env, documentId, [
    seedNode({ id: 'n-kept', label: 'Curated Kept', curated: true, pinned: true, position: { x: 50, y: 60 } }),
    seedNode({ id: 'n-qa-kept', label: 'QA Kept', source: 'qa' }),
  ])
  const gateway = createFakeGateway({
    extract() {
      throw new Error('an empty document must not call the model')
    },
  })
  const service = makeService(env, gateway)
  const frames = await collect(service.buildDocGraph(documentId, { force: true }))
  expect(gateway.calls.length).toBe(0)
  const graph = graphOfFrames(frames)
  expect(graph.nodes.length).toBe(2)
  const kept = graph.nodes.find((node) => node.id === 'n-kept')
  expect(kept?.label).toBe('Curated Kept')
  expect(kept?.pinned).toBe(true)
  expect(kept?.position).toEqual({ x: 50, y: 60 })
  expect(graph.nodes.some((node) => node.id === 'n-qa-kept' && node.source === 'qa')).toBe(true)
  expect(graph.overview).toMatch(/No concepts were extracted/)
})

test('createGraphService requires the store aux API', () => {
  expect(() =>
    createGraphService({ store: { list: () => [] } as unknown as GraphStoreApi }),
  ).toThrow(/store\.readAux is required/)
})

/* -------------------------------------------------------------------------- */
/* Chunk / source caps                                                        */
/* -------------------------------------------------------------------------- */

test('buildDocGraph respects maxGraphChunks with deterministic even sampling', async () => {
  const documentId = 'doc-chunk-cap'
  const sections: string[] = []
  for (let index = 0; index < 6; index += 1) {
    sections.push(`## Section ${index}\n\n${'content '.repeat(240)}`)
  }
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Chunk Cap Paper' }],
    markdown: { [documentId]: sections.join('\n\n') },
  })
  const gateway = createFakeGateway({
    extract() {
      return graphFence([], [])
    },
  })
  const service = makeService(env, gateway, { maxGraphChunks: 2 })
  const frames = await collect(service.buildDocGraph(documentId))
  const extractionCalls = gateway.calls.filter((call) => call.purpose === 'graph-extract')
  expect(extractionCalls.length).toBe(2)
  expect(extractionCalls[0]?.prompt).toMatch(/Section 0/)
  expect(extractionCalls[1]?.prompt).toMatch(/Section 5/)
  const extracting = frames.filter((frame) => frame.type === 'progress' && frame.phase === 'extracting')
  expect(extracting.map((frame) => (frame.type === 'progress' ? frame.chunk : -1))).toEqual([1, 2])
  expect(extracting.every((frame) => frame.type === 'progress' && frame.total === 2)).toBe(true)
})

test('buildDocGraph truncates over-long sources to maxGraphSourceChars plus headings', async () => {
  const documentId = 'doc-source-cap'
  const parts = ['## Opening', '', 'opening body '.repeat(80)]
  for (let index = 0; index < 8; index += 1) {
    parts.push(`## Later ${index}`, '', `later body ${index} `.repeat(30))
  }
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Source Cap Paper' }],
    markdown: { [documentId]: parts.join('\n\n') },
  })
  const gateway = createFakeGateway({
    extract() {
      return graphFence([], [])
    },
  })
  const service = makeService(env, gateway, { maxGraphSourceChars: 900, maxGraphChunks: 4 })
  await collect(service.buildDocGraph(documentId))
  const calls = gateway.calls.filter((call) => call.purpose === 'graph-extract')
  expect(calls.length).toBeGreaterThanOrEqual(1)
  expect(calls.length).toBeLessThanOrEqual(4)
  const prompts = calls.map((call) => call.prompt).join('\n')
  expect(prompts).toMatch(/Document outline \(truncated source\)/)
  expect(prompts).toMatch(/Later 7/)
  expect(prompts).not.toMatch(/later body 7/)
  for (const call of calls) expect(call.prompt.length).toBeLessThan(6000)
})
