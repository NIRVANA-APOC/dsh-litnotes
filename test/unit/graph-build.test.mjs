/**
 * Unit tests for the document scope of the knowledge-graph engine
 * (`lib/ai/graph.js`): section-aware chunking with progress frames,
 * cross-chunk merge/dedupe, caps, cancellation, malformed model JSON,
 * Q&A knowledge merge, user edits and empty fallbacks.
 *
 * The injected LLM gateway is fake (`completeText` only); the store fake keeps
 * aux JSON in memory and exposes the documented aux API.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraphService } from '../../lib/ai/graph.js'

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** Flatten one completion request into its prompt text. */
function promptOf(request) {
  const parts = []
  if (typeof request?.system === 'string') parts.push(request.system)
  for (const message of Array.isArray(request?.messages) ? request.messages : []) {
    if (typeof message?.content === 'string') parts.push(message.content)
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
      }
    }
  }
  return parts.join('\n\n')
}

/** Build a fenced model-output block. */
function fence(tag, payload) {
  return `\`\`\`${tag}\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

/** Graph-extraction model output. */
function graphFence(nodes = [], edges = []) {
  return fence('litnotes-graph', { nodes, edges })
}

/** Summary model output. */
function summaryFence(payload) {
  return fence('litnotes-summary', payload)
}

/**
 * Fake model gateway. `scripts.extract` is a function `({ index, prompt })`
 * returning the extraction text; `scripts.summary` the summary text.
 */
function createFakeGateway(scripts = {}) {
  const state = {
    available: scripts.available !== false,
    extract: scripts.extract,
    summary: scripts.summary,
    library: scripts.library,
  }
  const calls = []
  function flatten(request) {
    return promptOf(request)
  }
  const gateway = {
    state,
    calls,
    available() {
      return state.available
    },
    route() {
      return { provider: 'fake-provider', model: 'fake-model' }
    },
    async completeText(request) {
      const prompt = flatten(request)
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
      throw new Error(`fake gateway: unexpected purpose ${purpose}`)
    },
  }
  return gateway
}

/** In-memory store exposing the documented aux API. */
function createFakeStore({ docs = [], markdown = {}, annotations = {}, graphs = {}, libraryGraph = null } = {}) {
  const docList = docs.map((doc) => ({ status: 'parsed', createdAt: '2026-01-01T00:00:00.000Z', ...doc }))
  const docsById = new Map(docList.map((doc) => [doc.id, doc]))
  const markdowns = new Map(Object.entries(markdown))
  const annotationMap = new Map(Object.entries(annotations))
  const aux = new Map()
  const libraryAux = new Map()
  for (const [id, value] of Object.entries(graphs)) aux.set(`${id}/graph.json`, structuredClone(value))
  if (libraryGraph !== null) libraryAux.set('library-graph.json', structuredClone(libraryGraph))
  const store = {
    list() {
      return docList.map((doc) => structuredClone(doc))
    },
    get(id) {
      return docsById.has(id) ? structuredClone(docsById.get(id)) : undefined
    },
    async readMarkdown(id) {
      if (!markdowns.has(id)) {
        const error = new Error('Document has not been parsed yet')
        error.code = 'not-parsed'
        throw error
      }
      return { markdown: markdowns.get(id), contentList: null, pages: null }
    },
    async loadAnnotations(id) {
      return structuredClone(annotationMap.get(id) ?? { version: 1, items: [] })
    },
    async readAux(id, name) {
      const key = `${id}/${name}`
      return aux.has(key) ? structuredClone(aux.get(key)) : null
    },
    async writeAux(id, name, value) {
      aux.set(`${id}/${name}`, structuredClone(value))
    },
    async readLibraryAux(name) {
      return libraryAux.has(name) ? structuredClone(libraryAux.get(name)) : null
    },
    async writeLibraryAux(name, value) {
      libraryAux.set(name, structuredClone(value))
    },
  }
  return { store, aux, libraryAux, markdowns }
}

/** Create a graph service over the fake store/gateway. */
function makeService(env, gateway, ai = {}) {
  return createGraphService({
    llm: gateway,
    store: env.store,
    config: { ai: { maxGraphChunks: 12, maxGraphSourceChars: 160000, graphMaxTokens: 3000, ...ai } },
    logger: { warn() {} },
    readMarkdown: (id) => env.store.readMarkdown(id),
  })
}

/** Drain an async generator into an array. */
async function collect(stream) {
  const frames = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

/** Two long markdown sections, guaranteed to chunk separately. */
function twoSectionMarkdown() {
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
function keysInPrompt(prompt) {
  const keys = []
  const pattern = /\[\[(b\d+:[0-9a-f]{8})\]\]/g
  let match
  while ((match = pattern.exec(prompt)) !== null) {
    if (!keys.includes(match[1])) keys.push(match[1])
  }
  return keys
}

/** The graph persisted for one document, if any. */
function persistedGraph(env, documentId) {
  return env.aux.get(`${documentId}/graph.json`)
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
  const phases = frames.filter((frame) => frame.type === 'progress').map((frame) => frame.phase)
  assert.equal(frames[0].type, 'progress')
  assert.equal(frames[0].phase, 'reading')
  assert.deepEqual(phases, ['reading', 'reading', 'extracting', 'extracting', 'merging', 'done'])

  const extracting = frames.filter((frame) => frame.phase === 'extracting')
  assert.equal(extracting.length, 2)
  assert.deepEqual(extracting.map((frame) => frame.chunk), [1, 2])
  assert.deepEqual(extracting.map((frame) => frame.done), [1, 2])
  assert.ok(extracting.every((frame) => frame.total === 2))

  assert.equal(gateway.calls.filter((call) => call.purpose === 'graph-extract').length, 2)
  const graphFrame = frames.at(-1)
  assert.equal(graphFrame.type, 'graph')
  const graph = graphFrame.graph
  assert.equal(graph.scope, 'document')
  assert.equal(graph.documentId, documentId)
  assert.deepEqual(graph.model, { provider: 'fake-provider', model: 'fake-model' })
  assert.ok(graph.nodes.every((node) => /^n-/.test(node.id)))
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length)

  const merged = graph.nodes.filter(
    (node) => node.type === 'method' && node.label.toLowerCase().replace(/[^a-z]+/g, '').startsWith('sparseattention'),
  )
  assert.equal(merged.length, 1, 'label+type dedupe keeps one node')
  assert.equal(merged[0].label, 'Sparse Attention', 'first label wins')
  assert.equal(merged[0].blockKeys.length, 2, 'provenance is unioned across chunks')
  assert.equal(merged[0].summary, 'Reduces computation cost')
  assert.equal(merged[0].weight, 2, 'repeated extraction raises importance')

  // The unresolved "Efficiency" endpoint became a placeholder concept node.
  assert.ok(graph.nodes.some((node) => node.label === 'Efficiency'))
  assert.equal(graph.edges.length, 2)
  const sparse = merged[0]
  const supported = graph.edges.find((edge) => edge.type === 'supports')
  assert.equal(supported.from, sparse.id)
  assert.ok(graph.nodes.some((node) => node.id === supported.to && node.label === 'Efficiency'))

  assert.equal(graph.overview, '## Overview\n\nPolished orientation.')
  assert.equal(graph.tldr, '- First takeaway\n- Second takeaway\n- Third takeaway')
  assert.equal(graph.glossary.length, 1)
  assert.equal(graph.glossary[0].term, 'Sparse Attention')
  assert.ok(graph.glossary[0].blockKeys.every((key) => /^b\d+:[0-9a-f]{8}$/.test(key)))
  assert.deepEqual(graph.stats, { nodes: graph.nodes.length, edges: graph.edges.length, builtAtSeq: null })

  assert.deepEqual(persistedGraph(env, documentId), graph, 'the emitted graph is persisted')
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
  const edges = []
  outer: for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      edges.push({ from: nodes[left].label, to: nodes[right].label, type: 'relates' })
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
  const graph = frames.at(-1).graph

  assert.equal(graph.nodes.length, 120)
  assert.equal(graph.edges.length, 400)
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.from) && nodeIds.has(edge.to), 'no dangling edges after capping')
  }
  assert.ok(graph.nodes.some((node) => node.label === 'Concept 0'))
  assert.ok(!graph.nodes.some((node) => node.label === 'Concept 129'), 'lowest-weight/late nodes are dropped')
  assert.equal(gateway.calls.filter((call) => call.purpose === 'graph-summary').length, 1)
  assert.ok(graph.overview.startsWith('## Cap Paper'))
  assert.ok(graph.tldr.startsWith('- '))
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
  assert.equal(frames.filter((frame) => frame.type === 'error').length, 0)
  const graph = frames.at(-1).graph
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0].label, 'Linear memory')
  assert.ok(graph.overview.startsWith('## Tolerant Build'), 'summary parse failure falls back deterministically')
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
  const graph = frames.at(-1).graph
  assert.equal(frames.filter((frame) => frame.type === 'error').length, 0)
  assert.equal(graph.nodes.length, 0)
  assert.equal(graph.edges.length, 0)
  assert.match(graph.overview, /No concepts were extracted/)
  assert.equal(gateway.calls.filter((call) => call.purpose === 'graph-summary').length, 0)
  assert.ok(persistedGraph(env, documentId))
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
  assert.deepEqual(await service.docGraph(documentId), {
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
  assert.equal(gateway.calls.length, 0)
  const graph = frames.at(-1).graph
  assert.equal(graph.nodes.length, 0)
  assert.match(graph.overview, /No concepts were extracted/)
  assert.ok(persistedGraph(env, documentId))
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
  assert.equal(gatewayBefore.calls.length, 0)
  assert.equal(beforeFrames.at(-1).type, 'error')
  assert.equal(beforeFrames.at(-1).code, 'aborted')
  assert.equal(beforeFrames.some((frame) => frame.type === 'graph'), false)
  assert.equal(persistedGraph(env, documentId), undefined)

  const during = new AbortController()
  const gatewayDuring = createFakeGateway({
    extract({ index, prompt }) {
      during.abort()
      return graphFence([{ type: 'concept', label: `Partial ${index}`, summary: '', blockKeys: keysInPrompt(prompt).slice(0, 1) }], [])
    },
  })
  const serviceDuring = makeService(env, gatewayDuring)
  const duringFrames = await collect(serviceDuring.buildDocGraph(documentId, { signal: during.signal }))
  assert.equal(gatewayDuring.calls.filter((call) => call.purpose === 'graph-extract').length, 1)
  assert.equal(duringFrames.at(-1).type, 'error')
  assert.equal(duringFrames.at(-1).code, 'aborted')
  assert.equal(duringFrames.some((frame) => frame.type === 'graph'), false)
  assert.equal(persistedGraph(env, documentId), undefined)
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
  const built = firstFrames.at(-1).graph
  assert.equal(built.nodes.length, 1)

  const cacheGateway = createFakeGateway({
    extract() {
      throw new Error('cache hit must not call the model')
    },
  })
  const cachedService = makeService(env, cacheGateway)
  const cachedFrames = await collect(cachedService.buildDocGraph(documentId))
  assert.equal(cacheGateway.calls.length, 0)
  assert.deepEqual(cachedFrames.at(-1).graph, built)

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
  assert.ok(forcedGateway.calls.filter((call) => call.purpose === 'graph-extract').length >= 1)
  assert.equal(forcedFrames.at(-1).graph.nodes[0].label, 'Forced Concept')
})

test('buildDocGraph reports llm-unavailable instead of throwing', async () => {
  const documentId = 'doc-unavailable'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'No Model' }],
    markdown: { [documentId]: '## Intro\n\nText.' },
  })
  const gateway = createFakeGateway({ available: false, extract() {} })
  const service = makeService(env, gateway)
  const frames = await collect(service.buildDocGraph(documentId))
  assert.equal(frames.at(-1).type, 'error')
  assert.equal(frames.at(-1).code, 'llm-unavailable')
  assert.equal(gateway.calls.length, 0)
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
  assert.ok(gateway.calls.length > 0)
  assert.ok(gateway.calls.every((call) => call.signal === controller.signal))
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
  const built = (await collect(service.buildDocGraph(documentId))).at(-1).graph
  const sparse = built.nodes.find((node) => node.label === 'Sparse Attention')
  const dependency = built.nodes.find((node) => node.label === 'Long-range Dependency')

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
  assert.equal(merged.nodes.find((node) => node.label === 'Sparse Attention').id, sparse.id, 'existing id is preserved')
  assert.equal(merged.nodes.find((node) => node.label === 'Long-range Dependency').id, dependency.id)
  const insight = merged.nodes.find((node) => node.label === 'Quadratic cost')
  assert.equal(insight.source, 'qa')
  const leadsTo = merged.edges.find((edge) => edge.type === 'leads_to')
  assert.equal(leadsTo.from, sparse.id, 'edge label resolved to the existing node id')
  assert.equal(leadsTo.to, insight.id)
  assert.ok(merged.edges.every((edge) => merged.nodes.some((node) => node.id === edge.from)))
  assert.deepEqual(persistedGraph(env, documentId), merged)

  const before = structuredClone(merged)
  const unchanged = await service.mergeDocKnowledge(documentId, { nodes: [], edges: [] })
  assert.deepEqual(unchanged, before, 'empty delta is a no-op')

  const withPlaceholder = await service.mergeDocKnowledge(documentId, {
    edges: [{ from: 'Sparse Attention', to: 'Efficiency at scale', type: 'supports' }],
  })
  const placeholder = withPlaceholder.nodes.find((node) => node.label === 'Efficiency at scale')
  assert.ok(placeholder, 'unknown edge references create a node first')
  assert.equal(placeholder.source, 'qa')
  assert.ok(withPlaceholder.edges.some((edge) => edge.to === placeholder.id))
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
  const built = (await collect(service.buildDocGraph(documentId))).at(-1).graph
  const sparse = built.nodes.find((node) => node.label === 'Sparse Attention')
  const dependency = built.nodes.find((node) => node.label === 'Long-range Dependency')

  const updated = await service.updateDocGraph(documentId, {
    nodes: [
      { id: sparse.id, label: 'Linear Attention', summary: 'Curated summary' },
      { type: 'limitation', label: 'Compute bound', summary: 'Memory limits long inputs.' },
    ],
    edges: [{ from: sparse.id, to: dependency.id, type: 'supports', label: 'user edge' }],
  })
  const renamed = updated.nodes.find((node) => node.id === sparse.id)
  assert.equal(renamed.label, 'Linear Attention')
  assert.equal(renamed.summary, 'Curated summary')
  assert.equal(renamed.source, 'ai-summary', 'a patch without source never clobbers the provenance')
  assert.equal(renamed.curated, true, 'a user edit marks the node curated')
  assert.equal(updated.nodes.find((node) => node.label === 'Long-range Dependency').id, dependency.id)
  assert.ok(updated.nodes.some((node) => node.label === 'Compute bound' && node.type === 'limitation'))
  assert.ok(updated.edges.some((edge) => edge.type === 'supports' && edge.from === sparse.id))
  assert.ok(updated.edges.some((edge) => edge.type === 'uses'), 'existing edges are kept')
  assert.deepEqual(persistedGraph(env, documentId), updated)

  const unchanged = await service.updateDocGraph(documentId, {})
  assert.deepEqual(unchanged, updated)
})

/* -------------------------------------------------------------------------- */
/* Curation (pin / position / merge)                                          */
/* -------------------------------------------------------------------------- */

/** Seed one persisted document graph with fixed timestamps for deterministic tests. */
function seedGraph(env, documentId, nodes, edges = []) {
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
function seedNode(overrides = {}) {
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
function curationService(documentId) {
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Curation Paper' }],
    markdown: { [documentId]: '## Curation\n\nBody text.' },
  })
  return { env, service: makeService(env, createFakeGateway({})) }
}

test('updateDocGraph patches only provided node fields, never clobbers source and marks curated', async () => {
  const documentId = 'doc-curation-patch'
  const { env, service } = curationService(documentId)
  seedGraph(env, documentId, [
    seedNode({ id: 'n-alpha', label: 'Alpha', summary: 'AI summary', blockKeys: [] }),
  ])

  const patched = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-alpha', label: 'Alpha Curated' }],
  })
  const node = patched.nodes.find((item) => item.id === 'n-alpha')
  assert.equal(node.label, 'Alpha Curated')
  assert.equal(node.summary, 'AI summary', 'missing fields keep their stored value')
  assert.equal(node.source, 'ai-summary', 'source is untouched unless provided')
  assert.equal(node.curated, true)
  assert.notEqual(node.updatedAt, '2020-01-01T00:00:00.000Z', 'a user edit bumps updatedAt')

  // A caller that does send `source` can still set it explicitly.
  const explicit = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-alpha', source: 'user' }],
  })
  assert.equal(explicit.nodes.find((item) => item.id === 'n-alpha').source, 'user')
  assert.deepEqual(persistedGraph(env, documentId), explicit)

  // Brand-new nodes created through the curation API are user-sourced + curated.
  const added = await service.updateDocGraph(documentId, {
    nodes: [{ type: 'insight', label: 'Brand New Insight', summary: 'Created by the user.' }],
  })
  const created = added.nodes.find((item) => item.label === 'Brand New Insight')
  assert.equal(created.source, 'user')
  assert.equal(created.curated, true)
  assert.equal(typeof created.updatedAt, 'string')
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
  assert.equal(node.pinned, true)
  assert.deepEqual(node.position, { x: -20, y: 2500.6 })
  assert.equal(node.curated, true)
  assert.deepEqual(persistedGraph(env, documentId).nodes[0].position, { x: -20, y: 2500.6 })

  // Invalid values never overwrite valid state: non-boolean pin, non-finite axes.
  const invalid = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-pin', pinned: 'yes', position: { x: 'nope', y: 42 } }],
  })
  node = invalid.nodes.find((item) => item.id === 'n-pin')
  assert.equal(node.pinned, true, 'a non-boolean pinned value is ignored')
  assert.deepEqual(node.position, { x: -20, y: 2500.6 }, 'an invalid position is ignored')

  // Positions round to 0.1 (the layout precision).
  const rounded = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-pin', position: { x: 123.456, y: 789.987 } }],
  })
  node = rounded.nodes.find((item) => item.id === 'n-pin')
  assert.deepEqual(node.position, { x: 123.5, y: 790 })

  // The ±100000 ceiling keeps hostile/huge payloads finite.
  const clamped = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-pin', position: { x: -500000, y: 500000 } }],
  })
  node = clamped.nodes.find((item) => item.id === 'n-pin')
  assert.deepEqual(node.position, { x: -100000, y: 100000 })

  // `pinned: false` clears the marker but keeps the stored position.
  const unpinned = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-pin', pinned: false }],
  })
  node = unpinned.nodes.find((item) => item.id === 'n-pin')
  assert.equal('pinned' in node, false)
  assert.deepEqual(node.position, { x: -100000, y: 100000 })

  // NaN/Infinity positions are rejected too.
  const bad = await service.updateDocGraph(documentId, {
    nodes: [{ id: 'n-pin', position: { x: NaN, y: Infinity } }],
  })
  assert.deepEqual(bad.nodes.find((item) => item.id === 'n-pin').position, { x: -100000, y: 100000 })

  // A new node may be created already pinned.
  const created = await service.updateDocGraph(documentId, {
    nodes: [{ type: 'method', label: 'Pinned New Node', pinned: true, position: { x: 300.04, y: 400 } }],
  })
  const newbie = created.nodes.find((item) => item.label === 'Pinned New Node')
  assert.equal(newbie.pinned, true)
  assert.deepEqual(newbie.position, { x: 300, y: 400 })
  assert.equal(newbie.curated, true)
})

test('updateDocGraph merge folds nodes, unions evidence, rewires/dedupes edges and drops self-loops', async () => {
  const documentId = 'doc-curation-merge'
  const { env, service } = curationService(documentId)
  seedGraph(
    env,
    documentId,
    [
      seedNode({
        id: 'n-a',
        type: 'method',
        label: 'Alpha',
        summary: 'Source summary',
        blockKeys: ['b0:11111111'],
        aspect: 'method',
        weight: 1,
        pinned: true,
        position: { x: 10.5, y: 20 },
      }),
      seedNode({
        id: 'n-b',
        type: 'method',
        label: 'Beta',
        summary: 'Target summary',
        blockKeys: ['b1:22222222'],
        aspect: 'result',
        weight: 3,
        documentIds: ['doc-1'],
      }),
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

  const merged = await service.updateDocGraph(documentId, {
    merge: [{ from: 'n-a', into: 'n-b' }],
  })
  const beta = merged.nodes.find((item) => item.id === 'n-b')
  assert.ok(beta, 'the target node survives')
  assert.equal(merged.nodes.some((item) => item.id === 'n-a'), false, 'the source node is removed')
  assert.equal(beta.label, 'Beta', 'the target label wins')
  assert.equal(beta.summary, 'Target summary', 'the target summary wins')
  assert.equal(beta.aspect, 'result', 'the target aspect wins')
  assert.equal(beta.weight, 3, 'weight = max(target, source)')
  assert.deepEqual(beta.blockKeys, ['b1:22222222', 'b0:11111111'], 'evidence is unioned')
  assert.deepEqual(beta.documentIds, ['doc-1'], 'documentIds are unioned and kept')
  assert.equal(beta.pinned, true, 'a pinned source pins the target')
  assert.deepEqual(beta.position, { x: 10.5, y: 20 }, 'the target inherits a missing position')
  assert.equal(beta.curated, true, 'the merge target is marked curated')

  // Both directions are rewired, duplicates dedupe by from|to|type keeping the
  // highest weight and user provenance, and n-a→n-b becomes a dropped self-loop.
  assert.equal(merged.edges.some((edge) => edge.from === 'n-a' || edge.to === 'n-a'), false)
  assert.equal(merged.edges.every((edge) => edge.from !== edge.to), true, 'no self-loops')
  const keys = merged.edges.map((edge) => `${edge.from}|${edge.to}|${edge.type}`)
  assert.equal(new Set(keys).size, keys.length, 'edges are deduped')
  const uses = merged.edges.find((edge) => edge.from === 'n-b' && edge.to === 'n-c' && edge.type === 'uses')
  assert.equal(uses.weight, 3, 'duplicate edges keep the max weight')
  assert.equal(uses.label, 'strong', 'the strongest edge keeps its label')
  assert.ok(merged.edges.some((edge) => edge.from === 'n-d' && edge.to === 'n-b' && edge.type === 'supports'))
  assert.ok(merged.edges.some((edge) => edge.from === 'n-c' && edge.to === 'n-b' && edge.type === 'relates'))
  assert.equal(merged.edges.length, 3, 'the A→B self-loop and one duplicate are dropped')
  assert.deepEqual(merged.stats, { nodes: 3, edges: 3, builtAtSeq: null })
  assert.deepEqual(persistedGraph(env, documentId), merged)

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
    ],
  })
  assert.deepEqual(noop, before, 'unknown/invalid merge pairs are a no-op')

  // Merging a curated node again marks/keeps the surviving target curated.
  const second = await service.updateDocGraph(documentId, { merge: [{ from: 'n-c', into: 'n-b' }] })
  assert.equal(second.nodes.some((item) => item.id === 'n-c'), false)
  assert.equal(second.nodes.find((item) => item.id === 'n-b').curated, true)
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
  const built = (await collect(service.buildDocGraph(documentId))).at(-1).graph
  const sparse = built.nodes.find((node) => node.label === 'Sparse Attention')
  const dependency = built.nodes.find((node) => node.label === 'Long-range Dependency')

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
  const rebuilt = frames.at(-1).graph

  const curated = rebuilt.nodes.find((node) => node.label === 'Sparse Attention (curated)')
  assert.ok(curated, 'the renamed curated node is preserved')
  assert.equal(curated.pinned, true)
  assert.deepEqual(curated.position, { x: 120.5, y: 340 })
  assert.equal(curated.curated, true)
  assert.equal(curated.source, 'ai-summary', 'curation does not rewrite provenance')

  const rebuiltDependency = rebuilt.nodes.find((node) => node.label === 'Long-range Dependency')
  assert.ok(rebuiltDependency, 'the pinned node with a matching re-extraction survives as one node')
  assert.equal(rebuiltDependency.pinned, true)
  assert.deepEqual(rebuiltDependency.position, { x: 480, y: 660 })
  assert.equal(rebuiltDependency.curated, true)

  assert.ok(rebuilt.nodes.some((node) => node.label === 'QA Insight' && node.source === 'qa'))
  assert.ok(rebuilt.nodes.some((node) => node.label === 'Fresh Finding'), 'new extraction results are kept')
  assert.ok(
    rebuilt.edges.some((edge) => edge.from === curated.id && edge.type === 'uses'),
    'curated-node edges are rewired onto the preserved node',
  )
  assert.equal(rebuilt.overview, 'Rebuilt overview')
})

test('an empty forced rebuild keeps curated and qa knowledge without model calls', async () => {
  const documentId = 'doc-curation-empty-rebuild'
  const env = createFakeStore({
    docs: [{ id: documentId, title: 'Empty Curated' }],
    markdown: { [documentId]: '   \n\n' },
  })
  seedGraph(env, documentId, [
    seedNode({
      id: 'n-kept',
      label: 'Curated Kept',
      curated: true,
      pinned: true,
      position: { x: 50, y: 60 },
    }),
    seedNode({ id: 'n-qa-kept', label: 'QA Kept', source: 'qa' }),
  ])
  const gateway = createFakeGateway({
    extract() {
      throw new Error('an empty document must not call the model')
    },
  })
  const service = makeService(env, gateway)
  const frames = await collect(service.buildDocGraph(documentId, { force: true }))
  assert.equal(gateway.calls.length, 0)
  const graph = frames.at(-1).graph
  assert.equal(graph.nodes.length, 2, 'curated + qa nodes survive an empty re-extraction')
  const kept = graph.nodes.find((node) => node.id === 'n-kept')
  assert.equal(kept.label, 'Curated Kept')
  assert.equal(kept.pinned, true)
  assert.deepEqual(kept.position, { x: 50, y: 60 })
  assert.ok(graph.nodes.some((node) => node.id === 'n-qa-kept' && node.source === 'qa'))
  assert.match(graph.overview, /No concepts were extracted/)
})

test('createGraphService requires the store aux API', () => {
  assert.throws(
    () => createGraphService({ store: { list: () => [] } }),
    /store\.readAux is required/,
  )
})

/* -------------------------------------------------------------------------- */
/* Chunk / source caps                                                        */
/* -------------------------------------------------------------------------- */

test('buildDocGraph respects maxGraphChunks with deterministic even sampling', async () => {
  const documentId = 'doc-chunk-cap'
  const sections = []
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
  assert.equal(extractionCalls.length, 2, 'never exceeds config.ai.maxGraphChunks')
  assert.match(extractionCalls[0].prompt, /Section 0/, 'the first chunk is always sampled')
  assert.match(extractionCalls[1].prompt, /Section 5/, 'the last chunk is always sampled')
  const extracting = frames.filter((frame) => frame.phase === 'extracting')
  assert.deepEqual(extracting.map((frame) => frame.chunk), [1, 2])
  assert.ok(extracting.every((frame) => frame.total === 2))
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
  assert.ok(calls.length >= 1 && calls.length <= 4)
  const prompts = calls.map((call) => call.prompt).join('\n')
  assert.match(prompts, /Document outline \(truncated source\)/, 'headings from the unread tail are supplied')
  assert.match(prompts, /Later 7/, 'a heading from beyond the cap is present')
  assert.doesNotMatch(prompts, /later body 7/, 'body text beyond the cap is not sent to the model')
  for (const call of calls) assert.ok(call.prompt.length < 6000)
})
