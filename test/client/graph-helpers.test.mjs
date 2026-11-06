/**
 * Unit tests for the pure knowledge-graph helpers in ui/graph.js:
 * normalizeGraph, visibleGraph, layoutGraph and mruGraphActivePath.
 *
 * Run: node --test test/client/graph-helpers.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeGraph,
  visibleGraph,
  layoutGraph,
  mruGraphActivePath,
  mruGraphAnchoredCardPosition,
  mruGraphNodeSeparation,
  mruGraphLimitRenderEdges,
} from '../../ui/graph.js'

/** Small representative KG covering all provenance shapes. */
function fixture() {
  return {
    version: 1,
    scope: 'document',
    documentId: 'doc-1',
    overview: 'A small graph.',
    nodes: [
      { id: 'a', type: 'concept', label: 'Alpha', summary: 'First concept', blockKeys: ['b1:aa'], weight: 1 },
      { id: 'b', type: 'method', label: 'Beta', summary: 'Second method', blockKeys: ['b2:bb'], weight: 2 },
      { id: 'c', type: 'finding', label: 'Gamma', summary: 'Third finding', documentIds: ['doc-2'] },
      { id: 'd', type: 'method', label: 'Delta', summary: 'Isolated method' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', type: 'uses', label: 'uses', weight: 2 },
      { id: 'e2', from: 'b', to: 'c', type: 'supports' },
      { id: 'e3', from: 'a', to: 'ghost', type: 'relates' },
    ],
  }
}

/** A deterministic 300-node graph for the scale sanity test. */
function largeGraph(nodeCount = 300) {
  const nodes = []
  const edges = []
  for (let i = 0; i < nodeCount; i += 1) {
    nodes.push({
      id: `n${i}`,
      type: i % 5 === 0 ? 'method' : i % 5 === 1 ? 'finding' : 'concept',
      label: `Node ${i}`,
      summary: `Summary ${i}`,
      weight: 1 + (i % 4),
      blockKeys: [`b${i}:k${i}`],
    })
  }
  for (let i = 1; i < nodeCount; i += 1) {
    edges.push({ id: `e${i}`, from: `n${i - 1}`, to: `n${i}`, type: 'relates' })
    if (i % 7 === 0) edges.push({ id: `x${i}`, from: `n${i}`, to: `n${Math.floor(i / 2)}`, type: 'uses' })
  }
  return { version: 1, scope: 'library', nodes, edges }
}

test('normalizeGraph dedupes nodes/links, merges provenance and drops dangling edges', () => {
  const raw = fixture()
  raw.nodes.push({
    ...raw.nodes[0],
    blockKeys: ['b9:zz'],
    documentIds: ['doc-a'],
    weight: 9,
  })
  raw.edges.push({ ...raw.edges[0] })
  raw.edges.push({ id: 'e4', from: 'a', to: 'b', type: 'uses', label: 'uses' })
  raw.edges.push({ id: 'e5', from: 'c', to: 'ghost', type: 'mentions' })
  const snapshot = JSON.stringify(raw)

  const graph = normalizeGraph(raw)
  assert.equal(JSON.stringify(raw), snapshot, 'normalizeGraph must not mutate its input')
  assert.deepEqual(graph.nodes.map((node) => node.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(graph.nodes[0].blockKeys, ['b1:aa', 'b9:zz'])
  assert.deepEqual(graph.nodes[0].documentIds, ['doc-a'])
  assert.equal(graph.nodes[0].weight, 9)
  assert.equal(graph.nodes[0].label, 'Alpha', 'the first label wins')
  assert.equal(graph.edges.length, 2)
  assert.deepEqual(graph.edges.map((edge) => edge.id), ['e1', 'e2'])
  assert.equal(graph.stats.nodes, 4)
  assert.equal(graph.stats.edges, 2)
})

test('normalizeGraph generates deterministic ids and rejects unusable nodes', () => {
  const graph = normalizeGraph({
    nodes: [
      { type: 'concept', label: 'No Id!' },
      { label: '' },
      null,
      { id: 'known', type: 'method', label: 'Known' },
    ],
    edges: [
      { from: 'n:concept:no-id', to: 'n:concept:no-id', type: 'relates' },
      { from: 'n:concept:no-id', to: 'known', type: 'uses' },
    ],
  })
  assert.deepEqual(graph.nodes.map((node) => node.id), ['n:concept:no-id', 'known'])
  assert.equal(graph.edges.length, 1, 'self-links are not navigable in this view')
  assert.equal(graph.edges[0].from, 'n:concept:no-id')
})

test('normalizeGraph accepts object endpoints and keeps distinct edges with colliding ids', () => {
  const graph = normalizeGraph({
    nodes: [{ id: 'a', type: 'concept', label: 'A' }, { id: 'b', type: 'method', label: 'B' }],
    edges: [
      { id: 'e', from: { id: 'a' }, to: { id: 'b' }, type: 'uses' },
      { id: 'e', from: 'a', to: 'b', type: 'supports' },
    ],
  })
  assert.equal(graph.edges.length, 2)
  assert.equal(graph.edges[0].from, 'a')
  assert.notEqual(graph.edges[0].id, graph.edges[1].id)
})

test('normalizeGraph handles empty and malformed graphs', () => {
  for (const value of [null, undefined, {}, [], { nodes: 'nope', edges: 3 }]) {
    const graph = normalizeGraph(value)
    assert.deepEqual(graph.nodes, [])
    assert.deepEqual(graph.edges, [])
    assert.equal(graph.stats.nodes, 0)
    assert.equal(graph.stats.edges, 0)
  }
})

test('visibleGraph filters by type and search query without dangling edges', () => {
  const all = visibleGraph(fixture(), {})
  assert.equal(all.nodes.length, 4)
  assert.equal(all.edges.length, 2)
  assert.equal(all.filteredNodes, 4)
  assert.equal(all.collapsed, false)

  const methods = visibleGraph(fixture(), { types: ['method'] })
  assert.deepEqual(methods.nodes.map((node) => node.id), ['b', 'd'])
  assert.equal(methods.edges.length, 0)
  assert.deepEqual(methods.typeCounts, { concept: 1, method: 2, finding: 1 })

  const setFiltered = visibleGraph(fixture(), { types: new Set(['method', 'finding']) })
  assert.deepEqual(setFiltered.nodes.map((node) => node.id), ['b', 'c', 'd'])
  assert.equal(setFiltered.edges.length, 1)

  const none = visibleGraph(fixture(), { types: [] })
  assert.equal(none.nodes.length, 0)
  assert.equal(none.edges.length, 0)
  assert.equal(none.collapsed, false)
  assert.equal(none.totalNodes, 4)
})

test('visibleGraph search is case-insensitive and covers summary and provenance', () => {
  const bySummary = visibleGraph(fixture(), { query: 'SECOND' })
  assert.deepEqual(bySummary.nodes.map((node) => node.id), ['b'])

  const byLabel = visibleGraph(fixture(), { query: 'alpha' })
  assert.deepEqual(byLabel.nodes.map((node) => node.id), ['a'])

  const byBlockKey = visibleGraph(fixture(), { query: 'b2:' })
  assert.deepEqual(byBlockKey.nodes.map((node) => node.id), ['b'])

  const byDocument = visibleGraph(fixture(), { query: 'doc-2' })
  assert.deepEqual(byDocument.nodes.map((node) => node.id), ['c'])

  const miss = visibleGraph(fixture(), { query: 'nothing-here' })
  assert.equal(miss.nodes.length, 0)
  assert.equal(miss.hiddenNodes, 4)
  for (const graph of [bySummary, byLabel, byBlockKey, byDocument, miss]) {
    const ids = new Set(graph.nodes.map((node) => node.id))
    assert.ok(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)))
  }
})

test('visibleGraph collapse=type groups multi-node types deterministically', () => {
  const first = visibleGraph(fixture(), { collapse: 'type' })
  const second = visibleGraph(fixture(), { collapse: 'type' })
  assert.deepEqual(first, second, 'collapse output must be deterministic')
  assert.equal(first.collapsed, true)
  assert.deepEqual(first.nodes.map((node) => node.id), ['a', 'cluster:type:method', 'c'])
  assert.equal(first.collapsedNodes, 2)

  const cluster = first.nodes.find((node) => node.id === 'cluster:type:method')
  assert.ok(cluster)
  assert.equal(cluster.cluster, true)
  assert.equal(cluster.type, 'method')
  assert.equal(cluster.count, 2)
  assert.deepEqual(cluster.members, ['b', 'd'])
  assert.equal(first.edges.length, 2)
  for (const edge of first.edges) {
    assert.ok(edge.count >= 1)
    assert.ok(first.nodes.some((node) => node.id === edge.from))
    assert.ok(first.nodes.some((node) => node.id === edge.to))
  }
  const toCluster = first.edges.find((edge) => edge.to === 'cluster:type:method')
  assert.ok(toCluster)
  assert.equal(toCluster.count, 1)
  assert.equal(toCluster.label, 'uses')
})

test('visibleGraph collapse=auto only folds at library scale and honours an explicit threshold', () => {
  const small = visibleGraph(fixture(), { collapse: 'auto' })
  assert.equal(small.collapsed, false)
  assert.equal(small.nodes.length, 4)

  const forced = visibleGraph(fixture(), { collapse: 'auto', collapseThreshold: 2 })
  assert.equal(forced.collapsed, true)
  assert.ok(forced.nodes.length < 4)

  const big = largeGraph(180)
  const auto = visibleGraph(big, { collapse: 'auto' })
  assert.equal(auto.collapsed, true)
  assert.ok(auto.nodes.length < auto.filteredNodes)
  assert.ok(auto.collapsedNodes > 0)
  const ids = new Set(auto.nodes.map((node) => node.id))
  assert.ok(auto.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)))
})

test('layoutGraph is deterministic and never emits NaN coordinates', () => {
  const first = layoutGraph(fixture(), { width: 640, height: 420, seed: 11 })
  const second = layoutGraph(fixture(), { width: 640, height: 420, seed: 11 })
  assert.deepEqual(first, second, 'same graph/options/seed must produce identical layouts')
  assert.equal(first.links.length, 2)
  assert.deepEqual(Object.keys(first.positions).sort(), ['a', 'b', 'c', 'd'])

  for (const point of Object.values(first.positions)) {
    assert.ok(Number.isFinite(point.x), `x is finite: ${point.x}`)
    assert.ok(Number.isFinite(point.y), `y is finite: ${point.y}`)
    assert.ok(point.x >= 0 && point.x <= 640)
    assert.ok(point.y >= 0 && point.y <= 420)
  }
  for (const link of first.links) {
    assert.ok(Number.isFinite(link.x1) && Number.isFinite(link.y1))
    assert.ok(Number.isFinite(link.x2) && Number.isFinite(link.y2))
    assert.deepEqual({ x: link.x1, y: link.y1 }, first.positions[link.from])
    assert.deepEqual({ x: link.x2, y: link.y2 }, first.positions[link.to])
  }

  const different = layoutGraph(fixture(), { width: 640, height: 420, seed: 12 })
  assert.notDeepEqual(different.positions, first.positions, 'the seed must influence initial placement')
})

test('layoutGraph places isolated nodes and a single node', () => {
  const isolated = layoutGraph({
    nodes: Array.from({ length: 6 }, (_, index) => ({
      id: `i${index}`,
      type: 'concept',
      label: `Isolated ${index}`,
    })),
    edges: [],
  }, { width: 700, height: 500, seed: 5, iterations: 80 })
  assert.ok(isolated.links.length === 0)
  const points = Object.values(isolated.positions)
  assert.equal(points.length, 6)
  for (const point of points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
    assert.ok(point.x > 0 && point.x < 700 && point.y > 0 && point.y < 500)
  }
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      assert.ok(
        Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) > 1,
        'isolated nodes must not collapse onto the same point',
      )
    }
  }

  const single = layoutGraph({
    nodes: [{ id: 'only', type: 'concept', label: 'Only' }],
    edges: [],
  }, { width: 500, height: 320, seed: 1 })
  assert.deepEqual(single.positions.only, { x: 250, y: 160 })
})

test('layoutGraph keeps previous positions stable and pins dragged nodes', () => {
  const base = layoutGraph(fixture(), { width: 800, height: 520, seed: 21 })
  const nextGraph = fixture()
  nextGraph.nodes.push({ id: 'e', type: 'insight', label: 'Epsilon', blockKeys: ['b9:ee'] })
  const next = layoutGraph(nextGraph, {
    width: 800,
    height: 520,
    seed: 21,
    previous: base.positions,
  })
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.deepEqual(next.positions[id], base.positions[id], `previous node ${id} must stay put`)
  }
  assert.ok(Number.isFinite(next.positions.e.x) && Number.isFinite(next.positions.e.y))

  const pinned = layoutGraph(fixture(), {
    width: 800,
    height: 520,
    seed: 21,
    pinned: { a: { x: 120, y: 140 } },
  })
  assert.deepEqual(pinned.positions.a, { x: 120, y: 140 })
})

test('layoutGraph handles empty/edge-only graphs without NaN', () => {
  assert.deepEqual(layoutGraph(null, { width: 400, height: 300 }), {
    positions: {},
    links: [],
    width: 400,
    height: 300,
    seed: layoutGraph(null, { width: 400, height: 300 }).seed,
    iterations: 0,
  })
  const danglingOnly = layoutGraph({
    nodes: [{ id: 'a', type: 'concept', label: 'A' }],
    edges: [{ id: 'd', from: 'a', to: 'missing', type: 'relates' }],
  }, { width: 400, height: 300 })
  assert.deepEqual(Object.keys(danglingOnly.positions), ['a'])
  assert.equal(danglingOnly.links.length, 0)
})

test('300-node layout sanity: finite, bounded, deterministic and fast', () => {
  const graph = largeGraph(300)
  const started = Date.now()
  const first = layoutGraph(graph, { width: 1000, height: 680, seed: 42 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `300-node layout should not block for seconds (took ${elapsed}ms)`)
  assert.equal(Object.keys(first.positions).length, 300)
  assert.ok(first.links.length > 0)
  assert.ok(first.links.length <= graph.edges.length)
  for (const point of Object.values(first.positions)) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
    assert.ok(point.x >= 0 && point.x <= 1000)
    assert.ok(point.y >= 0 && point.y <= 680)
  }
  for (const link of first.links) {
    assert.ok(Number.isFinite(link.x1) && Number.isFinite(link.y1))
    assert.ok(Number.isFinite(link.x2) && Number.isFinite(link.y2))
  }
  const second = layoutGraph(graph, { width: 1000, height: 680, seed: 42 })
  assert.deepEqual(second, first, '300-node output must stay deterministic')
})

test('mruGraphActivePath highlights a root-to-selection path and neighbourhood', () => {
  const graph = {
    nodes: [
      { id: 'p', type: 'paper', label: 'Paper' },
      { id: 'c', type: 'concept', label: 'Concept' },
      { id: 'm', type: 'method', label: 'Method' },
      { id: 'x', type: 'finding', label: 'Other' },
    ],
    edges: [
      { id: 'e1', from: 'p', to: 'c', type: 'mentions' },
      { id: 'e2', from: 'c', to: 'm', type: 'uses' },
      { id: 'e3', from: 'x', to: 'm', type: 'supports' },
    ],
  }
  const path = mruGraphActivePath(graph, 'm')
  assert.equal(path.rootId, 'p')
  assert.deepEqual(path.nodeIds, ['p', 'c', 'm'])
  assert.deepEqual(path.edgeIds, ['e1', 'e2'])
  assert.deepEqual(path.relatedNodeIds.sort(), ['c', 'x'])
  assert.deepEqual(path.relatedEdgeIds.sort(), ['e2', 'e3'])

  const missing = mruGraphActivePath(graph, 'nope')
  assert.deepEqual(missing, {
    rootId: null,
    nodeIds: [],
    edgeIds: [],
    relatedNodeIds: [],
    relatedEdgeIds: [],
  })
})


// ---------------------------------------------------------------------------
// Anchored node popover placement (polish round: popover next to the node)
// ---------------------------------------------------------------------------

test('mruGraphAnchoredCardPosition places the card next to the node', () => {
  const right = mruGraphAnchoredCardPosition({
    node: { x: 200, y: 300, width: 20, height: 20 },
    container: { width: 900, height: 600 },
    card: { width: 300, height: 240 },
  })
  assert.equal(right.placement, 'right')
  assert.equal(right.left, 220)
  assert.equal(right.top, 180)
  assert.ok(right.left + 300 <= 900)
  assert.ok(right.top + 240 <= 600)

  // Near the right edge the card flips to the left side.
  const left = mruGraphAnchoredCardPosition({
    node: { x: 800, y: 300, width: 20, height: 20 },
    container: { width: 900, height: 600 },
    card: { width: 300, height: 240 },
  })
  assert.equal(left.placement, 'left')
  assert.ok(left.left >= 0)
  assert.ok(left.left + 300 <= 800)
  assert.equal(left.top, 180)
})

test('mruGraphAnchoredCardPosition clamps and never emits NaN', () => {
  const top = mruGraphAnchoredCardPosition({
    node: { x: 400, y: 2, width: 10, height: 10 },
    container: { width: 700, height: 500 },
    card: { width: 300, height: 240 },
    padding: 12,
  })
  assert.equal(top.top, 12)
  assert.ok(Number.isFinite(top.left))

  const bottom = mruGraphAnchoredCardPosition({
    node: { x: 400, y: 498, width: 10, height: 10 },
    container: { width: 700, height: 500 },
    card: { width: 300, height: 240 },
    padding: 12,
  })
  assert.equal(bottom.top, 500 - 240 - 12)
  assert.ok(['right', 'left'].includes(bottom.placement))

  const tiny = mruGraphAnchoredCardPosition({
    node: { x: 0, y: 0 },
    container: { width: 200, height: 160 },
    card: { width: 1000, height: 1000 },
  })
  assert.ok(Number.isFinite(tiny.left) && Number.isFinite(tiny.top))
  assert.ok(tiny.left >= 0 && tiny.top >= 0)
  assert.ok(['right', 'left'].includes(tiny.placement))

  const malformed = mruGraphAnchoredCardPosition({})
  assert.ok(Number.isFinite(malformed.left) && Number.isFinite(malformed.top))
})


// ---------------------------------------------------------------------------
// Even node distribution (user feedback: nodes clumped into one blob)
// ---------------------------------------------------------------------------

/** @returns {{positions: object, nodes: object[]}} laid-out graph + points. */
function distributedLayout(graph, seed = 11) {
  const layout = layoutGraph(graph, { width: 1000, height: 680, seed })
  const points = graph.nodes.map((node) => layout.positions[node.id])
  return { layout, points }
}

/** Min pairwise distance, mean nearest-neighbour distance and its CV. */
function spreadMetrics(points) {
  let minPair = Infinity
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      minPair = Math.min(minPair, Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y))
    }
  }
  const nearest = points.map((point, i) => {
    let best = Infinity
    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue
      best = Math.min(best, Math.hypot(points[j].x - point.x, points[j].y - point.y))
    }
    return best
  })
  const mean = nearest.reduce((sum, value) => sum + value, 0) / nearest.length
  const variance = nearest.reduce((sum, value) => sum + (value - mean) ** 2, 0) / nearest.length
  return { minPair, mean, cv: Math.sqrt(variance) / mean }
}

/** Hub + branches + isolates, the shape that used to collapse into a blob. */
function hubFixture() {
  const nodes = [{ id: 'hub', type: 'method', label: 'Hub', weight: 3 }]
  const edges = []
  for (let branch = 0; branch < 3; branch += 1) {
    let previous = 'hub'
    for (let i = 0; i < 4; i += 1) {
      const id = `b${branch}n${i}`
      nodes.push({ id, type: 'concept', label: `Node ${id}`, weight: 1 })
      edges.push({ id: `e${branch}-${i}`, from: previous, to: id, type: 'uses', weight: 1 })
      previous = id
    }
  }
  for (let i = 0; i < 7; i += 1) nodes.push({ id: `iso${i}`, type: 'finding', label: `Iso ${i}`, weight: 1 })
  return { nodes, edges }
}

test('mruGraphNodeSeparation scales with canvas area and clamps', () => {
  const small = mruGraphNodeSeparation(1000, 680, 400, 56)
  const normal = mruGraphNodeSeparation(1000, 680, 26, 56)
  const dense = mruGraphNodeSeparation(1000, 680, 20, 56)
  assert.ok(small >= 24 && small <= 66)
  assert.ok(normal >= 24 && normal <= 66)
  assert.ok(small <= normal, 'more nodes → smaller separation')
  assert.equal(normal, dense, 'separation clamps out at 66')
  assert.equal(mruGraphNodeSeparation(0, 0, 0, 0), 24)
})

test('layoutGraph spreads a hub graph instead of collapsing it into a blob', () => {
  const graph = hubFixture()
  const { points } = distributedLayout(graph)
  const { minPair, mean, cv } = spreadMetrics(points)
  assert.ok(minPair >= 55, `nodes keep apart (min pair ${minPair.toFixed(1)}px)`)
  assert.ok(mean >= 55, `neighbours are on average spread (${mean.toFixed(1)}px)`)
  assert.ok(cv <= 0.45, `spacing is even (CV ${cv.toFixed(3)})`)
  for (const point of points) {
    assert.ok(point.x >= 0 && point.x <= 1000 && point.y >= 0 && point.y <= 680)
  }
})

test('layoutGraph spreads a 60-node multi-hub graph evenly', () => {
  const nodes = []
  const edges = []
  for (let hub = 0; hub < 10; hub += 1) {
    nodes.push({ id: `h${hub}`, type: 'method', label: `Hub ${hub}`, weight: 2 + (hub % 3) })
    if (hub > 0) edges.push({ id: `hh${hub}`, from: `h${hub - 1}`, to: `h${hub}`, type: 'uses', weight: 1 })
    for (let leaf = 0; leaf < 4; leaf += 1) {
      nodes.push({ id: `h${hub}l${leaf}`, type: 'concept', label: `Leaf ${hub}.${leaf}`, weight: 1 })
      edges.push({ id: `hl${hub}-${leaf}`, from: `h${hub}`, to: `h${hub}l${leaf}`, type: 'uses', weight: 1 })
    }
  }
  for (let i = 0; i < 10; i += 1) nodes.push({ id: `iso${i}`, type: 'finding', label: `Iso ${i}`, weight: 1 })
  const { points } = distributedLayout({ nodes, edges })
  const { minPair, cv } = spreadMetrics(points)
  assert.ok(minPair >= 30, `60-node graph keeps apart (min pair ${minPair.toFixed(1)}px)`)
  assert.ok(cv <= 0.45, `60-node spacing is even (CV ${cv.toFixed(3)})`)
})

test('incremental layout keeps previous nodes and spreads newly added ones', () => {
  const graph = hubFixture()
  const first = layoutGraph(graph, { width: 1000, height: 680, seed: 11 })
  const extra = [...graph.nodes, ...Array.from({ length: 6 }, (_, i) => ({
    id: `new${i}`, type: 'insight', label: `New ${i}`, weight: 1,
  }))]
  const second = layoutGraph({ nodes: extra, edges: graph.edges }, {
    width: 1000,
    height: 680,
    seed: 11,
    previous: first.positions,
  })
  for (const node of extra) assert.ok(second.positions[node.id], `position for ${node.id}`)
  for (const node of graph.nodes) {
    assert.deepEqual(second.positions[node.id], first.positions[node.id], 'previous node stays put')
  }
})


// ---------------------------------------------------------------------------
// Dense library graphs: relation focus + canvas usage
// ---------------------------------------------------------------------------

/** A dense library-like fixture: 2 papers + 28 topics, near-complete topics. */
function denseLibraryFixture() {
  const nodes = [
    { id: 'paper-a', type: 'paper', label: 'Paper A', weight: 2 },
    { id: 'paper-b', type: 'paper', label: 'Paper B', weight: 2 },
  ]
  const edges = []
  for (let i = 0; i < 28; i += 1) {
    nodes.push({ id: `topic-${i}`, type: 'topic', label: `Topic ${i}`, weight: 1 })
    edges.push({ id: `m-a-${i}`, from: 'paper-a', to: `topic-${i}`, type: 'mentions', weight: 1 })
    edges.push({ id: `m-b-${i}`, from: 'paper-b', to: `topic-${i}`, type: 'mentions', weight: 1 })
    for (let j = i + 1; j < 28; j += 1) {
      edges.push({ id: `r-${i}-${j}`, from: `topic-${i}`, to: `topic-${j}`, type: 'relates', weight: 1 })
    }
  }
  return { nodes, edges }
}

test('mruGraphLimitRenderEdges focuses dense relation layers deterministically', () => {
  const graph = denseLibraryFixture()
  const limited = mruGraphLimitRenderEdges(graph.edges, graph.nodes, 'topic-3', 120)
  assert.equal(limited.total, graph.edges.length)
  assert.equal(limited.trimmed, true)
  assert.ok(limited.edges.length <= 120)
  assert.ok(limited.edges.some((edge) => edge.from === 'topic-3' || edge.to === 'topic-3'), 'selected edges stay')
  const again = mruGraphLimitRenderEdges(graph.edges, graph.nodes, 'topic-3', 120)
  assert.deepEqual(again.edges.map((edge) => edge.id), limited.edges.map((edge) => edge.id), 'deterministic')

  const small = graph.edges.slice(0, 20)
  const untouched = mruGraphLimitRenderEdges(small, graph.nodes, null, 120)
  assert.equal(untouched.trimmed, false)
  assert.equal(untouched.edges, small, 'small graphs pass through untouched')
})

test('dense layout uses the wide canvas instead of a central blob', () => {
  const graph = denseLibraryFixture()
  const layout = layoutGraph(graph, { width: 1000, height: 680, seed: 11 })
  const points = graph.nodes.map((node) => layout.positions[node.id])
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  assert.ok(spanX >= 700, `layout fills the canvas width (${spanX.toFixed(0)}px)`)
  assert.ok(spanY >= 420, `layout fills the canvas height (${spanY.toFixed(0)}px)`)
  const { minPair, cv } = spreadMetrics(points)
  assert.ok(minPair >= 30, `dense nodes keep apart (${minPair.toFixed(1)}px)`)
  assert.ok(cv <= 0.45, `dense spacing is even (CV ${cv.toFixed(3)})`)
  for (const point of points) {
    assert.ok(point.x >= 0 && point.x <= 1000 && point.y >= 0 && point.y <= 680)
  }
})
