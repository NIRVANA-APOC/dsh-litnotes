/**
 * d3-force layout tests: deterministic seeded layout, pins win, cached
 * positions keep the map stable, render caps and the live drag simulation.
 */

import { test, expect } from 'vitest'

import type { KnowledgeGraph } from '../../src/shared/model.ts'
import {
  CACHED_LAYOUT_TICKS,
  MAX_LAYOUT_TICKS,
  createDragSimulation,
  layoutGraph,
  layoutInput,
  tickBudget,
} from '../../src/client/graph/layout.ts'
import { makeDocGraph } from './graph-fixtures.ts'

/** Build one synthetic graph with `count` nodes and a chain of edges. */
function makeBigGraph(count: number, edgeCount = count - 1): KnowledgeGraph {
  const nodes = Array.from({ length: count }, (_value, index) => ({
    id: `n${index}`,
    type: index % 3 === 0 ? ('concept' as const) : ('method' as const),
    label: `Node ${index}`,
    summary: '',
    blockKeys: [],
    source: 'ai-summary' as const,
    weight: 1,
  }))
  const edges = Array.from({ length: edgeCount }, (_value, index) => ({
    id: `e${index}`,
    from: `n${index % count}`,
    to: `n${(index + 1) % count}`,
    type: 'relates' as const,
    source: 'ai-summary' as const,
    weight: 1,
  }))
  return {
    version: 1,
    scope: 'document',
    generatedAt: null,
    overview: '',
    nodes,
    edges,
    stats: { nodes: nodes.length, edges: edges.length },
  }
}

test('layoutGraph is deterministic and never emits NaN coordinates', () => {
  const graph = makeDocGraph()
  const first = layoutGraph(graph, { seed: 'doc-1' })
  const second = layoutGraph(graph, { seed: 'doc-1' })
  expect(first.positions).toEqual(second.positions)
  expect(Object.keys(first.positions).sort()).toEqual(graph.nodes.map((node) => node.id).sort())
  for (const position of Object.values(first.positions)) {
    expect(Number.isFinite(position.x)).toBe(true)
    expect(Number.isFinite(position.y)).toBe(true)
  }
  // A different seed produces a different map.
  const other = layoutGraph(graph, { seed: 'library' })
  expect(other.positions).not.toEqual(first.positions)
})

test('layoutGraph honours pinned positions exactly', () => {
  const graph = makeDocGraph()
  const pinned = { 'n-method': { x: 123.4, y: -56.7 } }
  const layout = layoutGraph(graph, { seed: 'doc-1', pinned })
  expect(layout.positions['n-method']).toEqual({ x: 123.4, y: -56.7 })
})

test('cached positions keep an existing map stable across re-entry', () => {
  const graph = makeDocGraph()
  const first = layoutGraph(graph, { seed: 'doc-1' })
  const second = layoutGraph(graph, { seed: 'doc-1', previous: first.positions })
  expect(second.ticks).toBe(CACHED_LAYOUT_TICKS)
  for (const node of graph.nodes) {
    const before = first.positions[node.id]
    const after = second.positions[node.id]
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    if (before === undefined || after === undefined) continue
    // Re-entry only settles the map; it never re-randomises it.
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(200)
  }
})

test('layout handles empty, single-node and isolated graphs', () => {
  const empty = layoutGraph({ version: 1, scope: 'document', generatedAt: null, overview: '', nodes: [], edges: [], stats: { nodes: 0, edges: 0 } })
  expect(empty.positions).toEqual({})

  const single = makeBigGraph(1, 0)
  const singleLayout = layoutGraph(single)
  expect(Object.keys(singleLayout.positions)).toEqual(['n0'])
  expect(singleLayout.positions.n0).toEqual({ x: expect.any(Number), y: expect.any(Number) })

  const isolated = makeBigGraph(6, 0)
  const isolatedLayout = layoutGraph(isolated)
  expect(Object.keys(isolatedLayout.positions).length).toBe(6)
  for (const position of Object.values(isolatedLayout.positions)) {
    expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true)
  }
})

test('render caps are deterministic: 600 nodes / 2000 edges', () => {
  const graph = makeBigGraph(700, 2600)
  const input = layoutInput(graph)
  expect(input.nodes.length).toBe(600)
  expect(input.edges.length).toBe(2000)
  expect(input.capped).toBe(true)
  const layout = layoutGraph(graph)
  expect(layout.nodeCount).toBe(600)
  expect(layout.edgeCount).toBe(2000)
  expect(layout.capped).toBe(true)
})

test('a 120-node first layout stays inside the 220-tick / 900ms budget', () => {
  const graph = makeBigGraph(120, 180)
  const layout = layoutGraph(graph, { seed: 'perf' })
  expect(layout.ticks).toBe(MAX_LAYOUT_TICKS)
  expect(layout.elapsedMs).toBeLessThan(900)
  expect(Object.keys(layout.positions).length).toBe(120)
  for (const position of Object.values(layout.positions)) {
    expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true)
  }
})

test('tickBudget is deterministic and bounded', () => {
  expect(tickBudget(120, false)).toBe(MAX_LAYOUT_TICKS)
  expect(tickBudget(1, false)).toBe(MAX_LAYOUT_TICKS)
  expect(tickBudget(600, false)).toBe(80)
  expect(tickBudget(120, true)).toBe(CACHED_LAYOUT_TICKS)
  for (const count of [2, 50, 200, 500, 10_000]) {
    const budget = tickBudget(count, false)
    expect(budget).toBeGreaterThanOrEqual(80)
    expect(budget).toBeLessThanOrEqual(MAX_LAYOUT_TICKS)
  }
})

test('drag simulation keeps the dragged node fixed and animates neighbours', () => {
  const graph = makeDocGraph()
  const base = layoutGraph(graph, { seed: 'doc-1' })
  const drag = createDragSimulation(graph, base.positions, {})
  drag.fix('n-concept', { x: 500, y: 400 })
  for (let index = 0; index < 20; index += 1) drag.tick()
  const positions = drag.positions()
  expect(positions['n-concept']).toEqual({ x: 500, y: 400 })
  // A connected neighbour followed the drag (moved from the settled layout).
  const before = base.positions['n-method']
  const after = positions['n-method']
  expect(before).toBeDefined()
  expect(after).toBeDefined()
  if (before !== undefined && after !== undefined) {
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0)
  }
  expect(drag.size()).toEqual({ nodes: graph.nodes.length, links: graph.edges.length })
  drag.stop()
})
