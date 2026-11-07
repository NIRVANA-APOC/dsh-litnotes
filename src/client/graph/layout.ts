/**
 * d3-force layout for the knowledge map (ALGORITHMS.md #5).
 *
 * The hand-rolled 1.0.0 force loop is replaced by d3-force: Barnes–Hut
 * `forceManyBody`, `forceLink`, `forceCollide`, `forceCenter` and gentle
 * `forceX`/`forceY` cluster anchors. Domain rules stay ours:
 *
 *  - a **deterministic seeded** initial placement (golden-angle spiral with a
 *    seeded jitter), so the same graph always produces the same map;
 *  - persisted **pins win**: `graph.json` positions are fixed points;
 *  - **cached prior positions** (per scope) are reused, so re-entering the
 *    scene does not re-randomise the map;
 *  - a **fixed tick budget** (≤220 ticks) with no wall-clock-dependent output:
 *    the first layout of 120 nodes stays well inside the 900ms budget while
 *    remaining reproducible;
 *  - bounded render caps (600 nodes / 2000 edges).
 *
 * `createDragSimulation()` is the only live simulation: the scene steps it from
 * `requestAnimationFrame` while the user drags, and stops it on release.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

import { GRAPH_NODE_TYPES, type Aspect, type GraphEdgeType, type GraphNodeType } from '../../shared/constants.ts'
import type { GraphEdge, GraphNode, KnowledgeGraph } from '../../shared/model.ts'
import {
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  linkDistance,
  nodeRadius,
  storedPins,
  type GraphScope,
  type Point,
} from './model.ts'

/** Fixed first-layout budget (spec: ≤220 ticks / 900ms for 120 nodes). */
export const MAX_LAYOUT_TICKS = 220

/** Re-entry with cached positions only needs a gentle settle pass. */
export const CACHED_LAYOUT_TICKS = 40

/** A layout position map keyed by node id (world px, 0.1 precision). */
export type PositionMap = Record<string, Point>

/** One node handed to d3-force. */
export interface LayoutNode extends SimulationNodeDatum {
  id: string
  type: GraphNodeType
  aspect: Aspect | null
  radius: number
  anchor: Point
}

/** One link handed to d3-force (source/target are ids until initialised). */
export interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  id: string
  type: GraphEdgeType
}

/** Result of one deterministic first/incremental layout. */
export interface GraphLayout {
  positions: PositionMap
  ticks: number
  elapsedMs: number
  nodeCount: number
  edgeCount: number
  /** True when the render caps dropped nodes or edges. */
  capped: boolean
}

/** Options of {@link layoutGraph}. */
export interface LayoutOptions {
  /** Seed string/number: same seed + same graph → same map (default scope key). */
  seed?: string | number
  /** Persisted pin positions (see `storedPins`). */
  pinned?: PositionMap
  /** Cached positions from an earlier visit; reused when finite. */
  previous?: PositionMap
  scope?: GraphScope
  /** Override the deterministic tick budget (tests). */
  ticks?: number
}

/** 32-bit FNV-1a hex, used to seed the deterministic placement. */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** Mulberry32 PRNG: tiny, deterministic, dependency-free. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Rounded world coordinate (0.1 precision, like the host sanitizer). */
function roundPosition(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10) / 10
}

/** Deterministic cluster anchor for one node type (forceX/forceY target). */
function clusterAnchor(type: GraphNodeType, scope: GraphScope): Point {
  const index = Math.max(0, GRAPH_NODE_TYPES.indexOf(type))
  const count = GRAPH_NODE_TYPES.length
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2
  const radius = scope === 'library' ? 320 : 200
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

/** Deterministic golden-angle spiral placement with a seeded jitter. */
function seedPositions(
  nodes: readonly GraphNode[],
  scope: GraphScope,
  seed: string,
  pinned: PositionMap,
  previous: PositionMap | undefined,
): Map<string, Point> {
  const random = createRandom(hashSeed(seed))
  const out = new Map<string, Point>()
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === undefined) continue
    const pin = pinned[node.id]
    if (pin !== undefined) {
      out.set(node.id, { x: pin.x, y: pin.y })
      continue
    }
    const cached = previous?.[node.id]
    if (cached !== undefined && Number.isFinite(cached.x) && Number.isFinite(cached.y)) {
      out.set(node.id, { x: cached.x, y: cached.y })
      continue
    }
    const angle = index * 2.399963229728653 + (random() - 0.5) * 0.35
    const radius = 26 + 18 * Math.sqrt(index) + (random() - 0.5) * 10
    out.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  }
  return out
}

/** Bounded render graph handed to d3-force. */
interface LayoutInput {
  nodes: GraphNode[]
  edges: GraphEdge[]
  capped: boolean
}

/** Apply the deterministic render caps (graph order). */
export function layoutInput(graph: KnowledgeGraph): LayoutInput {
  const nodes = graph.nodes.slice(0, MAX_GRAPH_NODES)
  const ids = new Set(nodes.map((node) => node.id))
  const edges: GraphEdge[] = []
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    edges.push(edge)
    if (edges.length >= MAX_GRAPH_EDGES) break
  }
  return { nodes, edges, capped: nodes.length < graph.nodes.length || edges.length < graph.edges.length }
}

/** Deterministic tick budget: 220 for ≤120 nodes, floored at 80 for big maps. */
export function tickBudget(nodeCount: number, hasPrevious: boolean): number {
  if (hasPrevious) return CACHED_LAYOUT_TICKS
  return Math.max(80, Math.min(MAX_LAYOUT_TICKS, Math.round(MAX_LAYOUT_TICKS * Math.min(1, 120 / Math.max(1, nodeCount)))))
}

/** Build the d3 simulation shared by the first layout and live dragging. */
function buildSimulation(
  input: LayoutInput,
  scope: GraphScope,
  positions: Map<string, Point>,
  pinned: PositionMap,
): { nodes: LayoutNode[]; links: LayoutLink[]; simulation: Simulation<LayoutNode, undefined> } {
  const nodes: LayoutNode[] = input.nodes.map((node) => {
    const point = positions.get(node.id) ?? { x: 0, y: 0 }
    const layoutNode: LayoutNode = {
      id: node.id,
      type: node.type,
      aspect: node.aspect ?? null,
      radius: nodeRadius(node, scope),
      anchor: clusterAnchor(node.type, scope),
      x: point.x,
      y: point.y,
    }
    const pin = pinned[node.id]
    if (pin !== undefined) {
      layoutNode.fx = pin.x
      layoutNode.fy = pin.y
    }
    return layoutNode
  })
  const links: LayoutLink[] = input.edges.map((edge) => ({
    id: edge.id,
    type: edge.type,
    source: edge.from,
    target: edge.to,
  }))
  const simulation = forceSimulation<LayoutNode>(nodes)
    .force('link', forceLink<LayoutNode, LayoutLink>(links)
      .id((node) => node.id)
      .distance((link) => linkDistance(link.type))
      .strength(0.6))
    .force('charge', forceManyBody<LayoutNode>().strength(-80).theta(0.9))
    .force('collide', forceCollide<LayoutNode>((node) => node.radius + 4).iterations(1))
    .force('center', forceCenter<LayoutNode>(0, 0))
    .force('x', forceX<LayoutNode>((node) => node.anchor.x).strength(0.02))
    .force('y', forceY<LayoutNode>((node) => node.anchor.y).strength(0.02))
    .stop()
  return { nodes, links, simulation }
}

/** Extract a rounded position map from simulation nodes. */
function snapshotPositions(nodes: readonly LayoutNode[]): PositionMap {
  const out: PositionMap = {}
  for (const node of nodes) {
    out[node.id] = { x: roundPosition(node.x ?? 0), y: roundPosition(node.y ?? 0) }
  }
  return out
}

/**
 * Compute one deterministic force layout for a graph.
 *
 * Pins are honoured (fixed points), cached positions are reused, new nodes are
 * seeded deterministically. No wall-clock dependency: the same inputs always
 * produce the same positions.
 */
export function layoutGraph(graph: KnowledgeGraph, options: LayoutOptions = {}): GraphLayout {
  const scope = options.scope ?? (graph.scope === 'library' ? 'library' : 'doc')
  const input = layoutInput(graph)
  const pinned = options.pinned ?? storedPins(input.nodes)
  const seed = String(options.seed ?? (graph.documentId ?? graph.scope))
  const positions = seedPositions(input.nodes, scope, seed, pinned, options.previous)
  const { nodes, simulation } = buildSimulation(input, scope, positions, pinned)
  const hasPrevious = options.previous !== undefined && Object.keys(options.previous).length > 0
  const ticks = Math.max(0, Math.trunc(options.ticks ?? tickBudget(input.nodes.length, hasPrevious)))
  const started = Date.now()
  if (ticks > 0) simulation.tick(ticks)
  simulation.stop()
  return {
    positions: snapshotPositions(nodes),
    ticks,
    elapsedMs: Date.now() - started,
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    capped: input.capped,
  }
}

/** One live drag simulation (created on drag start, stopped on release). */
export interface DragSimulation {
  /** Step the simulation one tick; returns the current alpha. */
  tick: () => number
  /** Fix one node at a world point (finger/cursor position). */
  fix: (id: string, point: Point) => void
  /** Current alpha (the scene stops the rAF loop once it is below ~0.02). */
  alpha: () => number
  /** Give the simulation energy (drag start / node moves). */
  reheat: () => void
  /** Remove internal forces and stop rAF driving. */
  stop: () => void
  /** Snapshot positions (rounded) for render/persist. */
  positions: () => PositionMap
  /** Number of simulation nodes/links. */
  size: () => { nodes: number; links: number }
}

/**
 * Create the live simulation used while dragging a node.
 *
 * The scene calls {@link DragSimulation.tick} from `requestAnimationFrame`; the
 * simulation has no timer of its own, so a hidden scene can never burn frames.
 */
export function createDragSimulation(
  graph: KnowledgeGraph,
  positions: PositionMap,
  options: { pinned?: PositionMap; scope?: GraphScope } = {},
): DragSimulation {
  const scope = options.scope ?? (graph.scope === 'library' ? 'library' : 'doc')
  const input = layoutInput(graph)
  const pinned = options.pinned ?? storedPins(input.nodes)
  const seeded = new Map<string, Point>()
  for (const node of input.nodes) {
    const position = positions[node.id] ?? { x: 0, y: 0 }
    seeded.set(node.id, { x: position.x, y: position.y })
  }
  const { nodes, simulation } = buildSimulation(input, scope, seeded, pinned)
  simulation.alpha(1)
  return {
    tick: () => {
      simulation.tick()
      return simulation.alpha()
    },
    fix: (id, point) => {
      const node = nodes.find((candidate) => candidate.id === id)
      if (node === undefined) return
      node.fx = point.x
      node.fy = point.y
      simulation.alpha(Math.max(simulation.alpha(), 0.5))
    },
    alpha: () => simulation.alpha(),
    reheat: () => simulation.alpha(Math.max(simulation.alpha(), 0.6)),
    stop: () => simulation.stop(),
    positions: () => snapshotPositions(nodes),
    size: () => ({ nodes: nodes.length, links: simulation.force('link') === undefined ? 0 : input.edges.length }),
  }
}
