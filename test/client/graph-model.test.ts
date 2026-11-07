/**
 * Graph domain-helper tests: normalize, filter, curation patch validation and
 * camera math. Ports the client-facing frozen 1.0.0 assertions from
 * `.agents/baseline-1.0.0/test/client/graph-helpers.test.mjs` that still apply
 * to the d3-force rewrite.
 */

import { test, expect } from 'vitest'

import {
  MAX_NODE_LABEL,
  curationPatch,
  limitEdges,
  mergeCandidates,
  nodeAspectCounts,
  nodeInk,
  nodeIsPinned,
  nodeRadius,
  nodeTypeCounts,
  normalizeGraph,
  presentNodeTypes,
  storedPins,
  visibleGraph,
} from '../../src/client/graph/model.ts'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  fitCamera,
  panCamera,
  screenToWorld,
  worldToScreen,
  zoomCameraAt,
} from '../../src/client/graph/camera.ts'
import { makeDocGraph, makeLibraryGraph } from './graph-fixtures.ts'

test('normalizeGraph dedupes nodes/links, merges provenance and drops dangling edges', () => {
  const graph = normalizeGraph({
    scope: 'document',
    documentId: 'doc-1',
    nodes: [
      { id: 'a', type: 'concept', label: 'A', blockKeys: ['b0:11111111'] },
      { id: 'a', type: 'concept', label: 'A duplicate', blockKeys: ['b1:22222222'] },
      { id: 'b', type: 'method', label: 'B' },
      { type: 'concept', label: 'No id' },
    ],
    edges: [
      { from: 'a', to: 'b', type: 'uses' },
      { from: 'a', to: 'b', type: 'uses' },
      { from: 'a', to: 'missing', type: 'uses' },
      { from: 'a', to: 'a', type: 'relates' },
    ],
  })
  expect(graph.nodes.map((node) => node.id)).toEqual(['a', 'b', expect.stringMatching(/^n[0-9a-f]{8}$/)])
  expect(graph.nodes[0]?.blockKeys).toEqual(['b0:11111111', 'b1:22222222'])
  expect(graph.nodes[0]?.label).toBe('A') // first label wins
  expect(graph.edges.length).toBe(1)
  expect(graph.edges[0]?.type).toBe('uses')
  expect(graph.stats).toEqual({ nodes: 3, edges: 1 })
  expect(graph.version).toBe(1)
  expect(graph.scope).toBe('document')
})

test('normalizeGraph handles empty and malformed graphs', () => {
  for (const input of [null, undefined, 42, 'nope', {}, { nodes: 'x', edges: 3 }]) {
    const graph = normalizeGraph(input)
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
    expect(graph.stats).toEqual({ nodes: 0, edges: 0 })
    expect(graph.generatedAt).toBeNull()
  }
})

test('normalizeGraph keeps valid aspect/type/source and clamps weight', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'nonsense', label: 'A', aspect: 'method', source: 'user', weight: -5 },
      { id: 'b', type: 'concept', label: 'B', aspect: 'nonsense', source: 'nonsense', weight: 999 },
    ],
    edges: [{ from: 'a', to: 'b', type: 'nonsense' }],
  })
  expect(graph.nodes[0]?.type).toBe('concept')
  expect(graph.nodes[0]?.aspect).toBe('method')
  expect(graph.nodes[0]?.source).toBe('user')
  expect(graph.nodes[0]?.weight).toBe(1)
  expect(graph.nodes[1]?.aspect).toBeUndefined()
  expect(graph.nodes[1]?.source).toBe('ai-summary')
  expect(graph.nodes[1]?.weight).toBe(100)
  expect(graph.edges[0]?.type).toBe('relates')
})

test('visibleGraph filters by type and aspect without dangling edges', () => {
  const graph = normalizeGraph(makeDocGraph())
  const methods = visibleGraph(graph, { types: ['method'], aspect: null })
  expect(methods.nodes.map((node) => node.id)).toEqual(['n-method'])
  expect(methods.edges).toEqual([])

  const limited = visibleGraph(graph, { types: null, aspect: 'limitation' })
  expect(limited.nodes.map((node) => node.id)).toEqual(['n-limitation'])
  expect(limited.edges).toEqual([])
})

test('visibleGraph keepStructural keeps library paper nodes attached to a matching topic', () => {
  const graph = normalizeGraph(makeLibraryGraph())
  const filtered = visibleGraph(graph, { types: null, aspect: 'method', keepStructural: true })
  expect(filtered.nodes.map((node) => node.id).sort()).toEqual(['paper:doc-1', 'paper:doc-2', 'topic:routing'])
  expect(filtered.edges.length).toBe(2)
})

test('limitEdges focuses the selected node and keeps the cap', () => {
  const edges = Array.from({ length: 10 }, (_value, index) => ({
    id: `e${index}`,
    from: index === 9 ? 'focus' : `a${index}`,
    to: `b${index}`,
    type: 'mentions' as const,
    source: 'aggregate' as const,
    weight: 1,
  }))
  const limited = limitEdges(edges, 3, 'focus')
  expect(limited.length).toBe(3)
  expect(limited[0]?.id).toBe('e9')
  expect(limitEdges(edges, 3).map((edge) => edge.id)).toEqual(['e0', 'e1', 'e2'])
})

test('curationPatch builds rename/pin/unpin/merge patches', () => {
  expect(curationPatch('rename', { id: 'n1', label: '  New name  ' })).toEqual({ nodes: [{ id: 'n1', label: 'New name' }] })
  expect(curationPatch('rename', { node: { id: 'n1' } as never, label: 'x' })).toEqual({ nodes: [{ id: 'n1', label: 'x' }] })
  expect(curationPatch('pin', { id: 'n1', position: { x: 10.04, y: -3.06 } }))
    .toEqual({ nodes: [{ id: 'n1', pinned: true, position: { x: 10, y: -3.1 } }] })
  expect(curationPatch('unpin', { id: 'n1' })).toEqual({ nodes: [{ id: 'n1', pinned: false }] })
  expect(curationPatch('merge', { from: 'a', into: 'b' })).toEqual({ merge: [{ from: 'a', to: 'b' }] })
})

test('curationPatch caps rename labels and refuses invalid input', () => {
  const patch = curationPatch('rename', { id: 'n1', label: 'x'.repeat(200) })
  expect(patch?.nodes?.[0]?.label?.length).toBe(MAX_NODE_LABEL)
  expect(curationPatch('rename', { id: 'n1', label: '   ' })).toBeNull()
  expect(curationPatch('rename', { label: 'no id' })).toBeNull()
  expect(curationPatch('pin', { id: 'n1', position: { x: Number.NaN, y: 0 } })).toBeNull()
  expect(curationPatch('pin', { id: 'n1' })).toBeNull()
  expect(curationPatch('merge', { from: 'a', into: 'a' })).toBeNull()
  expect(curationPatch('merge', { from: 'a' })).toBeNull()
  expect(curationPatch('nope' as never, { id: 'a' })).toBeNull()
})

test('curation positions clamp to ±100000 and stay JSON-safe', () => {
  const patch = curationPatch('pin', { id: 'n1', position: { x: 9_999_999, y: -9_999_999 } })
  expect(patch).not.toBeNull()
  expect(JSON.parse(JSON.stringify(patch))).toEqual(patch)
  expect(patch?.nodes?.[0]?.position).toEqual({ x: 100_000, y: -100_000 })
})

test('storedPins seeds only pinned nodes with a valid position', () => {
  const pins = storedPins([
    { id: 'a', pinned: true, position: { x: 1, y: 2 } } as never,
    { id: 'b', pinned: true } as never,
    { id: 'c', pinned: 'yes' } as never,
    { id: 'd', pinned: true, position: { x: 500_000, y: 0 } } as never,
  ])
  expect(pins).toEqual({ a: { x: 1, y: 2 }, d: { x: 100_000, y: 0 } })
  expect(nodeIsPinned({ pinned: true } as never)).toBe(true)
  expect(nodeIsPinned({ pinned: 1 } as never)).toBe(false)
})

test('mergeCandidates excludes the source, keeps order and dedupes', () => {
  const nodes = normalizeGraph(makeDocGraph()).nodes
  const candidates = mergeCandidates(nodes, 'n-method')
  expect(candidates.map((node) => node.id)).toEqual(['n-concept', 'n-finding', 'n-limitation'])
  expect(mergeCandidates(nodes, 'missing').length).toBe(nodes.length)
})

test('node helpers: radius, ink, type order and counts', () => {
  const graph = normalizeGraph(makeDocGraph())
  const concept = graph.nodes[0]
  expect(concept).toBeDefined()
  if (concept === undefined) return
  expect(nodeRadius(concept, 'doc')).toBeGreaterThan(8)
  expect(nodeInk(concept)).toBe('definition')
  expect(presentNodeTypes(graph.nodes)).toEqual(['concept', 'method', 'finding', 'limitation'])
  expect(nodeTypeCounts(graph.nodes)).toEqual({ concept: 1, method: 1, finding: 1, limitation: 1 })
  expect(nodeAspectCounts(graph.nodes)).toEqual({ definition: 1, method: 1, result: 1, limitation: 1 })
  const paper = normalizeGraph(makeLibraryGraph()).nodes[0]
  expect(paper === undefined ? '' : nodeInk(paper)).toBe('ink')
  expect(paper === undefined ? 0 : nodeRadius(paper, 'library')).toBe(16)
})

// ---------------------------------------------------------------------------
// Camera (DESIGN-V2 §5: wheel zooms at the cursor 0.6×–2.5×)
// ---------------------------------------------------------------------------

test('zoomCameraAt keeps the world point under the cursor fixed and clamps zoom', () => {
  const camera = { x: 30, y: -20, k: 1 }
  const anchor = { x: 400, y: 300 }
  const before = screenToWorld(anchor, camera)
  const zoomed = zoomCameraAt(camera, 1.8, anchor)
  const after = screenToWorld(anchor, zoomed)
  expect(after.x).toBeCloseTo(before.x, 10)
  expect(after.y).toBeCloseTo(before.y, 10)
  expect(zoomed.k).toBe(1.8)
  expect(zoomCameraAt(camera, 10, anchor).k).toBe(MAX_ZOOM)
  expect(zoomCameraAt(camera, 0.01, anchor).k).toBe(MIN_ZOOM)
  expect(clampZoom(Number.NaN)).toBe(1)
})

test('worldToScreen and screenToWorld round-trip; pan is unbounded', () => {
  const camera = { x: 12, y: 34, k: 1.5 }
  const world = { x: -500.5, y: 800.25 }
  const screen = worldToScreen(world, camera)
  const back = screenToWorld(screen, camera)
  expect(back.x).toBeCloseTo(world.x, 10)
  expect(back.y).toBeCloseTo(world.y, 10)
  const panned = panCamera(camera, 1_000_000, -1_000_000)
  expect(panned.x).toBe(1_000_012)
  expect(panned.y).toBe(34 - 1_000_000)
})

test('fitCamera centres a cloud, caps magnification and tolerates empties', () => {
  const positions = { a: { x: -100, y: -50 }, b: { x: 100, y: 50 } }
  const camera = fitCamera(positions, { width: 800, height: 600 }, { padding: 40, maxZoom: 1.4 })
  expect(camera.x).toBeCloseTo(400, 6)
  expect(camera.y).toBeCloseTo(300, 6)
  expect(camera.k).toBeGreaterThan(0.6)
  expect(camera.k).toBeLessThanOrEqual(1.4)
  const single = fitCamera({ a: { x: 5, y: 5 } }, { width: 800, height: 600 })
  expect(single.k).toBe(1.4)
  expect(fitCamera({}, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, k: 1 })
  const nan = fitCamera({ a: { x: Number.NaN, y: 0 } }, { width: 0, height: 0 })
  expect(Number.isFinite(nan.k)).toBe(true)
})
