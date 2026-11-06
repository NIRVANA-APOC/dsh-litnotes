/**
 * Unit tests for the library scope of the knowledge-graph engine
 * (`lib/ai/graph.js`): deterministic aggregation of per-document graphs into
 * paper/topic nodes, mentions and co-occurrence edges, clusters, caps,
 * lightweight heading/annotation fallbacks, optional LLM overview polish and
 * cancellation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraphService } from '../../lib/ai/graph.js'

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** Build a fenced model-output block. */
function fence(tag, payload) {
  return `\`\`\`${tag}\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

/** Summary model output. */
function summaryFence(payload) {
  return fence('litnotes-summary', payload)
}

/** Fake gateway: only `completeText` is used by the library path. */
function createFakeGateway(scripts = {}) {
  const state = {
    available: scripts.available !== false,
    library: scripts.library,
  }
  const calls = []
  return {
    state,
    calls,
    available() {
      return state.available
    },
    route() {
      return { provider: 'fake-provider', model: 'fake-model' }
    },
    async completeText(request) {
      calls.push({ purpose: request?.purpose, prompt: request?.purpose === 'graph-library-overview' ? String(request?.messages?.[0]?.content ?? '') : '' })
      if (request?.purpose === 'graph-library-overview') {
        if (typeof state.library !== 'function') throw new Error('fake gateway: no library script')
        return state.library({ request })
      }
      throw new Error(`fake gateway: unexpected purpose ${request?.purpose}`)
    },
  }
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

/** Build one stored document graph. */
function docGraph(documentId, nodes = [], edges = []) {
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
function structural(graph) {
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
    clusters: graph.clusters.map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      nodeIds: cluster.nodeIds,
      size: cluster.size,
    })),
    overview: graph.overview,
    tldr: graph.tldr,
  }
}

/** Two parsed documents sharing one topic, plus one uploaded document. */
function twoDocEnvironment() {
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

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

test('rebuildLibraryGraph aggregates papers and topics deterministically from two documents sharing a topic', async () => {
  const env = twoDocEnvironment()
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)

  const empty = await service.libraryGraph()
  assert.equal(empty.scope, 'library')
  assert.equal(empty.nodes.length, 0)
  assert.equal(empty.generatedAt, null)

  const frames = await collect(service.rebuildLibraryGraph())
  const phases = frames.filter((frame) => frame.type === 'progress').map((frame) => frame.phase)
  assert.deepEqual(phases, ['reading', 'reading', 'reading', 'merging', 'done'])
  const reading = frames.filter((frame) => frame.phase === 'reading')
  assert.equal(reading[0].total, 0, 'initial reading frame has no total yet')
  assert.deepEqual(reading.slice(1).map((frame) => frame.done), [1, 2])
  assert.ok(reading.slice(1).every((frame) => frame.total === 2))

  const graph = frames.at(-1).graph
  assert.equal(graph.scope, 'library')
  assert.equal(gateway.calls.length, 0, 'deterministic aggregation never calls the model')
  assert.deepEqual(graph.model, null)

  const papers = graph.nodes.filter((node) => node.type === 'paper')
  assert.equal(papers.length, 2, 'only parsed documents become paper nodes')
  assert.deepEqual(papers.map((paper) => paper.label), ['Graph Matching for Retrieval', 'Efficient Inference'])
  assert.ok(papers.every((paper) => /^n-paper-/.test(paper.id)))
  assert.ok(papers.every((paper) => paper.weight === 2))
  assert.ok(!graph.nodes.some((node) => node.documentIds?.includes('doc-uploaded')))

  const topics = graph.nodes.filter((node) => node.type === 'topic')
  assert.equal(topics.length, 3, 'section and question nodes do not become library topics')
  assert.ok(!topics.some((topic) => topic.label === 'Introduction'))
  assert.ok(!topics.some((topic) => topic.label === 'What is the cost?'))

  const matching = topics.filter((topic) => /^graph matching$/i.test(topic.label))
  assert.equal(matching.length, 1, 'one merged topic node for normalized labels across documents')
  assert.deepEqual(matching[0].documentIds, ['doc-a', 'doc-b'])
  assert.equal(matching[0].weight, 2)
  assert.equal(matching[0].label, 'Graph Matching', 'first-seen display label wins')
  assert.ok(/^n-topic-/.test(matching[0].id))

  const neural = topics.find((topic) => topic.label === 'Neural Retrieval')
  const inference = topics.find((topic) => topic.label === 'Efficient Inference')
  assert.deepEqual(neural.documentIds, ['doc-a'])
  assert.deepEqual(inference.documentIds, ['doc-b'])

  const paperA = papers.find((paper) => paper.documentIds[0] === 'doc-a')
  const paperB = papers.find((paper) => paper.documentIds[0] === 'doc-b')
  const mentions = graph.edges.filter((edge) => edge.type === 'mentions')
  assert.equal(mentions.length, 4)
  assert.ok(mentions.some((edge) => edge.from === paperA.id && edge.to === matching[0].id))
  assert.ok(mentions.some((edge) => edge.from === paperA.id && edge.to === neural.id))
  assert.ok(mentions.some((edge) => edge.from === paperB.id && edge.to === matching[0].id))
  assert.ok(mentions.some((edge) => edge.from === paperB.id && edge.to === inference.id))

  const relates = graph.edges.filter((edge) => edge.type === 'relates')
  assert.equal(relates.length, 2)
  for (const edge of relates) {
    assert.equal(edge.weight, 1)
    assert.ok(edge.from < edge.to, 'co-occurrence orientation is canonical')
    assert.ok([matching[0].id, neural.id, inference.id].includes(edge.from))
    assert.ok([matching[0].id, neural.id, inference.id].includes(edge.to))
  }
  assert.equal(
    relates.filter((edge) => [edge.from, edge.to].includes(matching[0].id)).length,
    2,
    'the shared topic co-occurs with one topic in each paper',
  )

  assert.equal(graph.clusters.length, 1, 'all three topics are one connected component')
  assert.equal(graph.clusters[0].size, 3)
  assert.deepEqual(new Set(graph.clusters[0].nodeIds), new Set(topics.map((topic) => topic.id)))
  assert.equal(graph.clusters[0].label, 'Graph Matching')
  assert.ok(/^c-/.test(graph.clusters[0].id))

  assert.match(graph.overview, /Graph Matching/)
  assert.match(graph.overview, /Graph Matching for Retrieval/)
  assert.match(graph.overview, /Efficient Inference/)
  assert.match(graph.overview, /2\*\* papers/)
  assert.ok(graph.tldr.startsWith('- '))
  assert.equal(graph.stats.nodes, graph.nodes.length)
  assert.equal(graph.stats.edges, graph.edges.length)

  const persisted = env.libraryAux.get('library-graph.json')
  assert.deepEqual(persisted, graph)
  assert.deepEqual(await service.libraryGraph(), graph)

  // Rebuilding keeps ids, edges and overview stable (timestamps are allowed to move).
  const rebuilt = (await collect(service.rebuildLibraryGraph())).at(-1).graph
  assert.deepEqual(structural(rebuilt), structural(graph))
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
  const graph = frames.at(-1).graph
  assert.equal(gateway.calls.length, 0)

  const papers = graph.nodes.filter((node) => node.type === 'paper')
  assert.equal(papers.length, 2)
  const topics = graph.nodes.filter((node) => node.type === 'topic')
  assert.ok(topics.some((topic) => topic.label === 'Sparse Attention'), 'stored graph topic is present')
  const annotationTopic = topics.find((topic) => topic.label === 'Sparse attention reduces cost')
  assert.ok(annotationTopic, 'annotation note becomes an insight topic in the fallback graph')
  assert.deepEqual(annotationTopic.documentIds, ['doc-fallback'])
  assert.ok(!topics.some((topic) => topic.label === 'Results'), 'section headings are not library topics')
})

test('library cap keeps 600 nodes and 2000 edges without dangling edges', async () => {
  const documents = []
  const graphs = {}
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
  const graph = (await collect(service.rebuildLibraryGraph())).at(-1).graph
  assert.equal(graph.nodes.length, 600)
  assert.equal(graph.edges.length, 2000)
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  for (const edge of graph.edges) {
    assert.ok(nodeIds.has(edge.from) && nodeIds.has(edge.to))
  }
  assert.equal(graph.nodes.filter((node) => node.type === 'paper').length, 6, 'paper nodes survive the cap')
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
  const graph = (await collect(service.rebuildLibraryGraph())).at(-1).graph
  assert.equal(gateway.calls.length, 1)
  assert.equal(gateway.calls[0].purpose, 'graph-library-overview')
  assert.equal(graph.overview, '## Polished library\n\nTwo directions: retrieval and inference.')
  assert.equal(graph.tldr, '- retrieval\n- inference')
  assert.deepEqual(graph.model, { provider: 'fake-provider', model: 'fake-model' })
})

test('library polish accepts raw Markdown and falls back on model failure', async () => {
  const markdownEnv = twoDocEnvironment()
  const markdownGateway = createFakeGateway({
    library() {
      return '## Custom overview\n\nRaw markdown consolidation.'
    },
  })
  const markdownGraph = (await collect(makeService(markdownEnv, markdownGateway).rebuildLibraryGraph())).at(-1).graph
  assert.equal(markdownGraph.overview, '## Custom overview\n\nRaw markdown consolidation.')

  const failingEnv = twoDocEnvironment()
  const failingGateway = createFakeGateway({
    library() {
      throw new Error('model down')
    },
  })
  const failingGraph = (await collect(makeService(failingEnv, failingGateway).rebuildLibraryGraph())).at(-1).graph
  assert.match(failingGraph.overview, /## Library graph/)
  assert.ok(failingGraph.tldr.startsWith('- '))
  assert.ok(failingEnv.libraryAux.get('library-graph.json'))
})

/* -------------------------------------------------------------------------- */
/* Empty / cancellation                                                       */
/* -------------------------------------------------------------------------- */

test('empty library rebuild persists a deterministic empty graph', async () => {
  const env = createFakeStore()
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)
  assert.deepEqual(await service.libraryGraph(), {
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
  const graph = frames.at(-1).graph
  assert.equal(graph.nodes.length, 0)
  assert.equal(graph.edges.length, 0)
  assert.deepEqual(graph.clusters, [])
  assert.match(graph.overview, /No parsed documents yet/)
  assert.ok(env.libraryAux.get('library-graph.json'))
  assert.deepEqual(await service.libraryGraph(), graph)
})

test('corrupt library graph reads as an empty graph', async () => {
  const env = createFakeStore({ libraryGraph: { nodes: 'not-an-array', edges: [null] } })
  const service = makeService(env, createFakeGateway({ available: false }))
  const graph = await service.libraryGraph()
  assert.equal(graph.scope, 'library')
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.edges, [])
})

test('rebuildLibraryGraph cancellation surfaces an error frame and writes nothing', async () => {
  const env = twoDocEnvironment()
  const gateway = createFakeGateway({ available: false })
  const service = makeService(env, gateway)
  const controller = new AbortController()
  controller.abort()
  const frames = await collect(service.rebuildLibraryGraph({ signal: controller.signal }))
  assert.equal(frames.at(-1).type, 'error')
  assert.equal(frames.at(-1).code, 'aborted')
  assert.equal(env.libraryAux.has('library-graph.json'), false)
})

test('library relates edges use document co-occurrence counts as weights', async () => {
  const documents = [
    { id: 'doc-1', title: 'Paper One', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'doc-2', title: 'Paper Two', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'doc-3', title: 'Paper Three', createdAt: '2026-01-03T00:00:00.000Z' },
  ]
  const graphs = {
    'doc-1': docGraph('doc-1', [
      { id: 'n-1a', type: 'concept', label: 'Topic A', summary: '', blockKeys: [] },
      { id: 'n-1b', type: 'concept', label: 'Topic B', summary: '', blockKeys: [] },
    ]),
    'doc-2': docGraph('doc-2', [
      { id: 'n-2a', type: 'concept', label: 'Topic A', summary: '', blockKeys: [] },
      { id: 'n-2b', type: 'concept', label: 'Topic B', summary: '', blockKeys: [] },
    ]),
    'doc-3': docGraph('doc-3', [
      { id: 'n-3a', type: 'method', label: 'Topic A', summary: '', blockKeys: [] },
      { id: 'n-3c', type: 'concept', label: 'Topic C', summary: '', blockKeys: [] },
    ]),
  }
  const env = createFakeStore({ docs: documents, graphs })
  const service = makeService(env, createFakeGateway({ available: false }))
  const graph = (await collect(service.rebuildLibraryGraph())).at(-1).graph
  const topics = graph.nodes.filter((node) => node.type === 'topic')
  const byLabel = new Map(topics.map((topic) => [topic.label, topic]))
  for (const label of ['Topic A', 'Topic B', 'Topic C']) assert.ok(byLabel.has(label))
  assert.equal(byLabel.get('Topic A').weight, 3, 'topic weight is the number of papers mentioning it')
  assert.equal(byLabel.get('Topic A').documentIds.length, 3)
  assert.equal(byLabel.get('Topic B').weight, 2)
  assert.equal(byLabel.get('Topic C').weight, 1)

  const relates = graph.edges.filter((edge) => edge.type === 'relates')
  const pair = (left, right) => relates.find((edge) => {
    const ids = new Set([edge.from, edge.to])
    return ids.has(byLabel.get(left).id) && ids.has(byLabel.get(right).id)
  })
  assert.equal(pair('Topic A', 'Topic B').weight, 2, 'two papers contain both topics')
  assert.equal(pair('Topic A', 'Topic C').weight, 1)
  assert.equal(pair('Topic B', 'Topic C'), undefined)
  assert.equal(graph.clusters.length, 1, 'A connects B and C through co-occurrence')
  assert.equal(graph.clusters[0].size, 3)
})
