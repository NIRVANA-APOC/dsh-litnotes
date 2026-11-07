/**
 * AI knowledge-graph end-to-end tests (docs/AI-SPEC.md §2/§4).
 *
 * Drives the REAL index.js + fake Cordis context (fake Host `llm`) through:
 *
 *   POST /dsh-litnotes/api/graph.doc             -> { graph: KG }
 *   POST /dsh-litnotes/api/graph.build           -> NDJSON: progress frames then graph/error
 *   POST /dsh-litnotes/api/graph.update          -> { graph: KG }
 *   POST /dsh-litnotes/api/graph.library         -> { graph: KG (scope library) }
 *   POST /dsh-litnotes/api/graph.library.rebuild -> NDJSON: progress frames then graph
 *
 * Covered: empty-state read, streamed extraction progress + final graph, model
 * JSON fence parsing, doc-graph persistence, user node merge, deterministic
 * library aggregation (paper + topic nodes, mentions edges), library rebuild
 * streaming/persistence, not-found envelopes and clean model-failure frames.
 *
 * Graph-engine-dependent tests skip with a clear reason while lib/ai/graph.js is
 * still landing (the wire/shape tests above still run); they execute for real
 * once the engine is importable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  AI_ROUTES,
  createAiHarness,
  envelopeValue,
  findCitationTarget,
  frameOfType,
  framesOfType,
  readDocGraphFile,
  readLibraryGraphFile,
  settleStream,
} from './ai-harness.mjs'
import { createFakeLlm, graphExtractionText, summaryText } from '../helpers/fake-llm.mjs'

const QUOTE = 'Mixture-of-experts (MoE) layers replace a single feed-forward network'

/** Skip only the engine-dependent graph tests while the engine is landing. */
async function requireGraphEngine(t, harness) {
  if (!(await harness.isWired())) {
    t.skip('AI routes are not wired yet')
    return false
  }
  if (!(await harness.isGraphReady())) {
    t.skip('knowledge-graph engine is not importable yet (lib/ai/graph.js)')
    return false
  }
  return true
}

/**
 * Script the fake model for a graph build: every graph-extraction call gets the
 * same small KG (merged/deduped by the host), the summary call gets overview/
 * tldr/glossary.
 */
function scriptGraphLlm(harness) {
  const target = findCitationTarget(harness.markdown, QUOTE)
  const extraction = {
    nodes: [
      {
        type: 'method',
        label: 'Sparse Expert Routing',
        summary: 'Routes each token through a small subset of expert feed-forward blocks.',
        blockKeys: [target.blockKey],
        aspect: 'method',
      },
      {
        type: 'concept',
        label: 'Mixture-of-Experts',
        summary: 'A layer that chooses among many expert sub-networks.',
        blockKeys: [],
        aspect: 'method',
      },
      {
        type: 'finding',
        label: 'Fewer Floating-Point Operations',
        summary: 'The sparse encoder matches the dense baseline at lower cost.',
        blockKeys: [],
        aspect: 'result',
      },
    ],
    edges: [
      { from: 'Sparse Expert Routing', to: 'Mixture-of-Experts', type: 'uses' },
      { from: 'Sparse Expert Routing', to: 'Fewer Floating-Point Operations', type: 'supports' },
    ],
  }
  const summary = {
    overview: 'The paper presents SparseRoute, a sparse mixture-of-experts retrieval encoder.',
    tldr: [
      'SparseRoute routes tokens through a subset of experts.',
      'It matches a dense baseline at lower compute.',
    ],
    glossary: [
      { term: 'SparseRoute', definition: 'A sparse retrieval encoder.', blockKeys: [target.blockKey] },
    ],
  }
  harness.llm.setDefault((_request, flat) => {
    // The prompt contract names the exact fenced blocks the model must emit.
    if (flat.prompt.includes('litnotes-summary')) return { text: summaryText(summary) }
    if (flat.prompt.includes('litnotes-graph')) return { text: graphExtractionText(extraction) }
    // Tolerant fallback for prompt wording variations during integration:
    if (/tldr|glossary|overview/i.test(flat.prompt)) return { text: summaryText(summary) }
    return { text: graphExtractionText(extraction) }
  })
  return { extraction, summary, target }
}

test('graph.doc returns a readable graph shape before anything is built', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await harness.isWired())) {
    t.skip('AI routes are not wired yet')
    return
  }
  const response = await harness.invokeJson(AI_ROUTES.graphDoc, {
    method: 'POST',
    payload: { documentId: harness.documentId },
  })
  // With the graph engine not loaded this is a clean 503 envelope; with it loaded
  // an empty KG (nodes/edges arrays) is returned. Both are valid contracts here.
  if (response.status === 503) {
    assert.equal(response.body.ok, false)
    assert.match(String(response.body.error.code), /ai-unavailable/)
    return
  }
  assert.equal(response.status, 200)
  const { graph } = envelopeValue(response, 'graph.doc')
  if (graph !== null) {
    assert.equal(graph.version, 1)
    assert.equal(graph.scope, 'document')
    assert.equal(graph.documentId, harness.documentId)
    assert.ok(Array.isArray(graph.nodes))
    assert.ok(Array.isArray(graph.edges))
  }
})

test('graph.build streams progress frames and a final graph, then persists it', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireGraphEngine(t, harness))) return
  const { extraction } = scriptGraphLlm(harness)

  const stream = harness.startStream(AI_ROUTES.graphBuild, {
    documentId: harness.documentId,
    force: true,
  })
  await settleStream(stream.settled, { label: 'graph build stream' })
  const frames = stream.frames

  // --- transport + frame contract ----------------------------------------
  assert.equal(stream.res.state.statusCode, 200)
  assert.match(String(stream.res.state.headers['content-type']), /^application\/x-ndjson/)
  assert.equal(stream.res.state.writableEnded, true)
  assert.equal(frameOfType(frames, 'error'), undefined, `unexpected error frame: ${JSON.stringify(frameOfType(frames, 'error'))}`)

  const progress = framesOfType(frames, 'progress')
  assert.ok(progress.length >= 1, 'progress frames narrate the build')
  for (const frame of progress) {
    assert.match(String(frame.phase), /reading|extracting|merging|summar|done/i)
  }
  assert.ok(
    progress.some((frame) => typeof frame.done === 'number' && typeof frame.total === 'number'),
    'at least one progress frame reports done/total',
  )

  const graphFrame = framesOfType(frames, 'graph').at(-1)
  assert.ok(graphFrame !== undefined, 'the build ends with a graph frame')
  assert.equal(typeof graphFrame.graph, 'object')
  const kg = graphFrame.graph
  assert.equal(kg.version, 1)
  assert.equal(kg.scope, 'document')
  assert.equal(kg.documentId, harness.documentId)
  assert.ok(kg.nodes.length >= 2, `expected merged nodes, got ${JSON.stringify(kg.nodes)}`)
  assert.ok(kg.edges.length >= 1)
  assert.ok(kg.nodes.every((node) => typeof node.id === 'string' && typeof node.label === 'string'))
  assert.ok(kg.edges.every((edge) => typeof edge.from === 'string' && typeof edge.to === 'string'))
  // Merged by normalized label: the three model labels appear once each.
  const labels = kg.nodes.map((node) => node.label)
  assert.equal(new Set(labels).size, labels.length, 'labels are deduped during merge')
  assert.ok(labels.some((label) => /Sparse Expert Routing/i.test(label)))
  assert.ok(labels.some((label) => /Mixture-of-Experts/i.test(label)))
  assert.ok(extraction.nodes.length > 0)
  assert.equal(typeof (kg.overview ?? ''), 'string')
  assert.equal(kg.stats?.nodes ?? kg.nodes.length, kg.nodes.length)

  // --- persisted + readable back through graph.doc -----------------------
  const saved = await readDocGraphFile(harness)
  assert.ok(saved !== null, 'graph.json was persisted through the store aux API')
  assert.equal(saved.scope, 'document')
  assert.equal(saved.nodes.length, kg.nodes.length)

  const readBack = await harness.invokeJson(AI_ROUTES.graphDoc, {
    method: 'POST',
    payload: { documentId: harness.documentId },
  })
  assert.equal(readBack.status, 200)
  const persisted = envelopeValue(readBack, 'graph.doc').graph
  assert.ok(persisted.nodes.length >= 2)
  assert.equal(persisted.documentId, harness.documentId)
})

test('graph.update merges user nodes and edges into the document graph', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireGraphEngine(t, harness))) return
  scriptGraphLlm(harness)
  const build = harness.startStream(AI_ROUTES.graphBuild, { documentId: harness.documentId, force: true })
  await settleStream(build.settled)
  assert.equal(frameOfType(build.frames, 'error'), undefined)

  const before = envelopeValue(
    await harness.invokeJson(AI_ROUTES.graphDoc, { method: 'POST', payload: { documentId: harness.documentId } }),
    'graph.doc',
  ).graph
  const userNode = {
    id: 'n-user-insight-1',
    type: 'insight',
    label: 'Margin Note Insight',
    summary: 'A user-curated knowledge node.',
    blockKeys: [],
    source: 'user',
  }
  const updated = await harness.invokeJson(AI_ROUTES.graphUpdate, {
    method: 'POST',
    payload: {
      documentId: harness.documentId,
      nodes: [userNode],
      edges: [{ id: 'e-user-1', from: 'n-user-insight-1', to: before.nodes[0].id, type: 'relates' }],
    },
  })
  assert.equal(updated.status, 200)
  const graph = envelopeValue(updated, 'graph.update').graph
  assert.ok(graph.nodes.some((node) => node.label === 'Margin Note Insight'))
  assert.ok(graph.edges.some((edge) => edge.from === 'n-user-insight-1' || edge.label === 'n-user-insight-1' || edge.id === 'e-user-1'))

  const readBack = envelopeValue(
    await harness.invokeJson(AI_ROUTES.graphDoc, { method: 'POST', payload: { documentId: harness.documentId } }),
    'graph.doc',
  ).graph
  assert.ok(readBack.nodes.some((node) => node.label === 'Margin Note Insight'), 'update was persisted')
})

test('graph.library reads the persisted library graph (empty before the first rebuild)', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireGraphEngine(t, harness))) return
  const response = await harness.invokeJson(AI_ROUTES.graphLibrary, { method: 'POST', payload: {} })
  assert.equal(response.status, 200)
  const { graph } = envelopeValue(response, 'graph.library')
  assert.equal(graph.version, 1)
  assert.equal(graph.scope, 'library')
  assert.ok(Array.isArray(graph.nodes))
  assert.ok(Array.isArray(graph.edges))
  assert.equal(graph.nodes.length, 0, 'nothing is aggregated until graph.library.rebuild runs')
})

test('graph.library.rebuild streams progress and the rebuilt library graph', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireGraphEngine(t, harness))) return
  scriptGraphLlm(harness)
  const build = harness.startStream(AI_ROUTES.graphBuild, { documentId: harness.documentId, force: true })
  await settleStream(build.settled)

  const stream = harness.startStream(AI_ROUTES.graphLibraryRebuild, {})
  await settleStream(stream.settled, { label: 'library graph rebuild stream' })
  const frames = stream.frames

  assert.equal(stream.res.state.statusCode, 200)
  assert.match(String(stream.res.state.headers['content-type']), /^application\/x-ndjson/)
  assert.equal(frameOfType(frames, 'error'), undefined)
  assert.ok(framesOfType(frames, 'progress').length >= 1, 'rebuild narrates progress')
  const graphFrame = framesOfType(frames, 'graph').at(-1)
  assert.ok(graphFrame !== undefined, 'rebuild ends with a graph frame')
  assert.equal(graphFrame.graph.scope, 'library')

  assert.equal(graphFrame.graph.scope, 'library')

  // --- aggregation: paper nodes + topic nodes + mentions edges ------------
  const library = graphFrame.graph
  assert.ok(library.nodes.length >= 2, 'expected paper + topic nodes')
  assert.ok(
    library.nodes.some((node) => node.type === 'paper'),
    `expected a paper node, got ${JSON.stringify(library.nodes.map((node) => [node.type, node.label]))}`,
  )
  assert.ok(
    library.nodes.some((node) => node.type === 'paper' && /Sparse Expert Routing/i.test(node.label)),
    'the paper node carries the document title',
  )
  assert.ok(library.nodes.some((node) => node.type === 'topic'), 'topic nodes aggregated from the doc graph')
  assert.ok(library.edges.some((edge) => edge.type === 'mentions'), 'paper→topic mentions edges are present')
  assert.ok(Array.isArray(library.clusters), 'connected components are reported')

  // --- persisted + readable through graph.library -------------------------
  const saved = await readLibraryGraphFile(harness)
  assert.ok(saved !== null, 'library-graph.json was persisted')
  assert.equal(saved.scope, 'library')
  assert.equal(saved.nodes.length, library.nodes.length)

  const readBack = await harness.invokeJson(AI_ROUTES.graphLibrary, { method: 'POST', payload: {} })
  assert.equal(readBack.status, 200)
  const persisted = envelopeValue(readBack, 'graph.library').graph
  assert.equal(persisted.scope, 'library')
  assert.equal(persisted.nodes.length, library.nodes.length)
})

test('graph.build reports a model failure as an error frame, not a crash', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await harness.isWired())) {
    t.skip('AI routes are not wired yet')
    return
  }
  if (!harness.hasRoute(AI_ROUTES.graphBuild)) {
    t.skip('graph streaming route is not wired yet')
    return
  }
  harness.llm.queue({ error: new Error('fake graph extraction failure') })
  const stream = harness.startStream(AI_ROUTES.graphBuild, { documentId: harness.documentId, force: true })
  await settleStream(stream.settled, { label: 'failing graph build stream' })
  assert.equal(stream.res.state.writableEnded, true)
  const frames = stream.frames
  if (frames.length > 0) {
    const error = frameOfType(frames, 'error')
    assert.ok(error !== undefined, `expected an error frame, got ${JSON.stringify(frames)}`)
    assert.match(String(error.code), /failed|unavailable|ai-|network|bad-response/i)
    assert.equal(typeof error.message, 'string')
  } else {
    assert.ok(stream.res.state.statusCode >= 400)
  }
})

test('graph.doc rejects unknown documents with a not-found envelope', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await harness.isWired())) {
    t.skip('AI routes are not wired yet')
    return
  }
  const response = await harness.invokeJson(AI_ROUTES.graphDoc, {
    method: 'POST',
    payload: { documentId: randomUUID() },
  })
  assert.equal(response.status, 404)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.error.code, 'not-found')
})

test('graph.update applies a curation payload (rename/pin/merge) and persists it', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireGraphEngine(t, harness))) return
  scriptGraphLlm(harness)
  const build = harness.startStream(AI_ROUTES.graphBuild, { documentId: harness.documentId, force: true })
  await settleStream(build.settled)
  assert.equal(frameOfType(build.frames, 'error'), undefined)

  const before = envelopeValue(
    await harness.invokeJson(AI_ROUTES.graphDoc, {
      method: 'POST',
      payload: { documentId: harness.documentId },
    }),
    'graph.doc',
  ).graph
  assert.ok(before.nodes.length >= 3, 'the scripted build yields at least three nodes')
  const [first, second, third] = before.nodes

  const updated = await harness.invokeJson(AI_ROUTES.graphUpdate, {
    method: 'POST',
    payload: {
      documentId: harness.documentId,
      nodes: [
        { id: first.id, label: 'Curated Label', pinned: true, position: { x: 420.51, y: 860.23 } },
        { id: second.id, pinned: true, position: { x: 120, y: 240 } },
      ],
      merge: [{ from: third.id, into: second.id }],
    },
  })
  assert.equal(updated.status, 200)
  const graph = envelopeValue(updated, 'graph.update').graph

  const curated = graph.nodes.find((node) => node.id === first.id)
  assert.ok(curated, 'the renamed node keeps its id')
  assert.equal(curated.label, 'Curated Label')
  assert.equal(curated.source, first.source, 'a node edit without source never clobbers provenance')
  assert.equal(curated.curated, true)
  assert.equal(curated.pinned, true)
  assert.deepEqual(curated.position, { x: 420.5, y: 860.2 }, 'the pinned position is clamped/rounded')

  const target = graph.nodes.find((node) => node.id === second.id)
  assert.equal(target.pinned, true)
  assert.deepEqual(target.position, { x: 120, y: 240 })

  assert.equal(graph.nodes.some((node) => node.id === third.id), false, 'the merged source node is removed')
  assert.equal(graph.nodes.length, before.nodes.length - 1)
  assert.equal(graph.stats.nodes, graph.nodes.length)
  assert.equal(graph.stats.edges, graph.edges.length)
  assert.ok(graph.edges.every((edge) => edge.from !== edge.to), 'merge drops self-loops')
  assert.ok(
    graph.edges.every(
      (edge) => graph.nodes.some((node) => node.id === edge.from)
        && graph.nodes.some((node) => node.id === edge.to),
    ),
    'merge leaves no dangling edges',
  )

  const readBack = envelopeValue(
    await harness.invokeJson(AI_ROUTES.graphDoc, {
      method: 'POST',
      payload: { documentId: harness.documentId },
    }),
    'graph.doc',
  ).graph
  const persisted = readBack.nodes.find((node) => node.id === first.id)
  assert.equal(persisted.label, 'Curated Label')
  assert.equal(persisted.pinned, true)
  assert.deepEqual(persisted.position, { x: 420.5, y: 860.2 })
  assert.equal(readBack.nodes.some((node) => node.id === third.id), false, 'the merge is persisted')
})
