/**
 * The graph canvas: SVG infinite canvas with pan/zoom, node drag + pin, hover
 * focus and the zoom/fit HUD.
 *
 * Interaction rules (DESIGN-V2 §5, normative):
 *  - background drag pans; wheel zooms at the cursor (0.6×–2.5×); double-click
 *    background fits; `F` fits; `Esc` clears the selection;
 *  - node pointer-down starts a potential drag; a drag moves the node with the
 *    live d3-force simulation (neighbours follow), release pins it at its world
 *    position; a click selects, a second click jumps to the source block;
 *  - hover focuses a neighbourhood and dims the rest; the focused node's edges
 *    take its aspect ink.
 *
 * The canvas owns only the camera + live drag simulation; the deterministic
 * first layout lives in `GraphScene`/`layout.ts`, so filtering never
 * re-randomises the map.
 */

import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { GraphNode, KnowledgeGraph } from '../../shared/model.ts'
import type { VisibleGraph } from './model.ts'
import { nodeInk, nodeRadius, type GraphScope, type Point } from './model.ts'
import {
  fitCamera,
  identityCamera,
  panCamera,
  screenToWorld,
  zoomCameraAt,
  zoomStep,
  type Camera,
  type Viewport,
} from './camera.ts'
import { createDragSimulation, type DragSimulation } from './layout.ts'
import { useGraphMediaQuery } from './hooks.ts'
import { IconButton, useHotkey } from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'

/** Props of the graph canvas. */
export interface GraphCanvasProps {
  graph: KnowledgeGraph
  visible: VisibleGraph
  scope: GraphScope
  documentId: string | null
  /** Deterministic layout positions of the full graph (world px). */
  layoutPositions: Record<string, Point>
  /** Persisted pins (fixed points). */
  pinned: Record<string, Point>
  selectedId: string | null
  /** `prefers-reduced-motion` (edge/selection transitions become instant). */
  reducedMotion: boolean
  onSelect: (id: string | null) => void
  onJump: (node: GraphNode) => void
  /** Persist a released pin (world position). */
  onPin: (id: string, position: Point) => void
  /** Remember the settled map so re-entry stays stable. */
  onPositions: (positions: Record<string, Point>) => void
}

/** Screen-space viewport fallback when the element has no layout (tests). */
const FALLBACK_VIEWPORT: Viewport = { width: 900, height: 560 }

/** Label truncation on the canvas (full label lives in the margin card). */
function truncateLabel(label: string, max = 26): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

/** Observe the canvas size (ResizeObserver when available). */
function useViewport(ref: { current: HTMLDivElement | null }): Viewport {
  const [viewport, setViewport] = useState<Viewport>(FALLBACK_VIEWPORT)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = (): void => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (width > 0 && height > 0) setViewport({ width, height })
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [ref])
  return viewport
}

/** One pointer click in screen space, used to distinguish click from drag. */
interface PointerRecord {
  x: number
  y: number
  moved: boolean
}

/** Active node drag bookkeeping. */
interface DragState {
  nodeId: string
  simulation: DragSimulation
  frame: number | null
  started: boolean
}

/** The knowledge-map canvas. */
export function GraphCanvas(props: GraphCanvasProps): ReactElement {
  const t = useT()
  const { graph, visible, scope, selectedId, onSelect, onJump, onPin, onPositions } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const viewport = useViewport(wrapRef)
  const [camera, setCamera] = useState<Camera>(identityCamera)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [livePositions, setLivePositions] = useState<Record<string, Point> | null>(null)
  const [labelOverride, setLabelOverride] = useState(false)
  const narrow = useGraphMediaQuery('(max-width: 820px)')
  const [fitted, setFitted] = useState(false)
  const panRef = useRef<{ record: PointerRecord } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const positions = livePositions ?? props.layoutPositions
  const pinned = props.pinned
  const visibleIds = useMemo(() => new Set(visible.nodes.map((node) => node.id)), [visible.nodes])
  const showLabels = labelOverride || (camera.k >= (narrow ? 0.85 : 0.55))

  const focusId = hoverId ?? selectedId
  const focusNode = focusId === null ? null : graph.nodes.find((node) => node.id === focusId) ?? null
  const focusInk = focusNode === null ? null : nodeInk(focusNode)
  const neighbours = useMemo(() => {
    if (focusId === null) return null
    const set = new Set<string>([focusId])
    for (const edge of graph.edges) {
      if (edge.from === focusId) set.add(edge.to)
      else if (edge.to === focusId) set.add(edge.from)
    }
    return set
  }, [focusId, graph.edges])

  const fit = useCallback(
    (positionsToFit: Record<string, Point> = positions): void => {
      if (Object.keys(positionsToFit).length === 0) return
      setCamera(fitCamera(positionsToFit, viewport))
    },
    [positions, viewport],
  )

  // First paint: fit the deterministic layout once it exists.
  useEffect(() => {
    if (fitted || Object.keys(props.layoutPositions).length === 0) return
    setFitted(true)
    setCamera(fitCamera(props.layoutPositions, viewport))
  }, [fitted, props.layoutPositions, viewport])

  // A new graph (scope/document switch) gets a fresh fit and no stale drag map.
  useEffect(() => {
    setFitted(false)
    setLivePositions(null)
    setHoverId(null)
  }, [props.documentId, scope])

  // A re-layout (pin/element change) supersedes any settled drag snapshot.
  useEffect(() => {
    setLivePositions(null)
  }, [props.layoutPositions])

  // Never leave a simulation frame scheduled after the scene unmounts.
  useEffect(() => () => {
    const drag = dragRef.current
    if (drag === null) return
    if (drag.frame !== null) cancelAnimationFrame(drag.frame)
    drag.simulation.stop()
    dragRef.current = null
  }, [])

  // Wheel zoom at the cursor. Native listener: React's wheel is passive.
  useEffect(() => {
    const element = wrapRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const factor = Math.exp(-event.deltaY * 0.0015)
      setCamera((current) => zoomCameraAt(current, current.k * factor, anchor))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // Escape clears the selection; F fits (shell owns 1/2 scene hotkeys).
  useHotkey('escape', () => onSelect(null))
  useHotkey('f', () => fit())

  /** Finish a node drag: stop the loop, remember positions, persist the pin. */
  const finishDrag = useCallback((): void => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    if (drag.frame !== null) cancelAnimationFrame(drag.frame)
    const settled = drag.simulation.positions()
    drag.simulation.stop()
    onPositions(settled)
    setLivePositions(settled)
    const position = settled[drag.nodeId]
    if (drag.started && position !== undefined) onPin(drag.nodeId, position)
  }, [onPin, onPositions])

  /** Step the live simulation from rAF; stops when it damps out. */
  const stepDrag = useCallback((): void => {
    const drag = dragRef.current
    if (drag === null) return
    const alpha = drag.simulation.tick()
    setLivePositions(drag.simulation.positions())
    if (alpha > 0.02 && drag.started) {
      drag.frame = requestAnimationFrame(stepDrag)
    } else {
      finishDrag()
    }
  }, [finishDrag])

  /** Begin the live drag simulation for one node at a world point. */
  const beginDrag = useCallback(
    (nodeId: string, world: Point): void => {
      if (dragRef.current !== null) return
      const simulation = createDragSimulation(graph, positions, { pinned, scope })
      simulation.fix(nodeId, world)
      const drag: DragState = { nodeId, simulation, frame: null, started: true }
      dragRef.current = drag
      drag.frame = requestAnimationFrame(stepDrag)
    },
    [graph, positions, pinned, scope, stepDrag],
  )

  // Window-level pointer tracking for pan and drag (captures leave the SVG).
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag !== null) {
        if (!drag.started || wrapRef.current === null) return
        const rect = wrapRef.current.getBoundingClientRect()
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        drag.simulation.fix(drag.nodeId, screenToWorld(anchor, cameraRef.current))
        return
      }
      const pan = panRef.current
      if (pan === null) return
      const deltaX = event.clientX - pan.record.x
      const deltaY = event.clientY - pan.record.y
      if (!pan.record.moved && Math.hypot(deltaX, deltaY) <= 3) return
      pan.record.moved = true
      pan.record.x = event.clientX
      pan.record.y = event.clientY
      setCamera((current) => panCamera(current, deltaX, deltaY))
    }
    const onUp = (): void => {
      const drag = dragRef.current
      if (drag !== null) {
        if (drag.started) finishDrag()
        return
      }
      const pan = panRef.current
      panRef.current = null
      if (pan !== null && !pan.record.moved) onSelect(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [finishDrag, onSelect])

  /** Start panning on the background (nodes stop propagation). */
  const onBackgroundPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    panRef.current = { record: { x: event.clientX, y: event.clientY, moved: false } }
  }

  /** Node pointer-down: select on click, drag after 3px, pin on release. */
  const onNodePointerDown = (event: ReactPointerEvent<SVGGElement>, node: GraphNode): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    onSelect(node.id)
    const element = wrapRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    let started = false
    let lastX = event.clientX
    let lastY = event.clientY
    const record: PointerRecord = { x: event.clientX, y: event.clientY, moved: false }
    const onMove = (move: PointerEvent): void => {
      const deltaX = move.clientX - lastX
      const deltaY = move.clientY - lastY
      lastX = move.clientX
      lastY = move.clientY
      const total = Math.hypot(move.clientX - record.x, move.clientY - record.y)
      if (!started && total > 3) {
        started = true
        beginDrag(node.id, screenToWorld({ x: record.x - rect.left, y: record.y - rect.top }, cameraRef.current))
      }
      if (started) {
        const anchor = { x: move.clientX - rect.left, y: move.clientY - rect.top }
        dragRef.current?.simulation.fix(node.id, screenToWorld(anchor, cameraRef.current))
      }
      if (!started && Math.hypot(deltaX, deltaY) > 1) record.moved = true
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (started) finishDrag()
      else if (!record.moved && selectedId === node.id) onJump(node)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const zoomBy = (factor: number): void => {
    setCamera((current) => zoomStep(current, viewport, factor))
  }

  const focusInkAttr = focusInk === null || focusInk === 'ink' ? null : focusInk

  return (
    <div
      className="ln-graph__canvas"
      ref={wrapRef}
      data-scope={scope}
      data-reduced-motion={props.reducedMotion}
    >
      <svg
        className="ln-graph__svg"
        role="application"
        aria-label={t('graph.canvas')}
        onPointerDown={onBackgroundPointerDown}
        onDoubleClick={() => fit()}
      >
        <g
          className="ln-graph__world"
          transform={`translate(${camera.x} ${camera.y}) scale(${camera.k})`}
        >
          {visible.edges.map((edge) => {
            const from = positions[edge.from]
            const to = positions[edge.to]
            if (from === undefined || to === undefined) return null
            if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) return null
            const focused = focusId !== null && (edge.from === focusId || edge.to === focusId)
            const dimmed = neighbours !== null && focusId !== null && !focused
            return (
              <line
                key={edge.id}
                className="ln-edge"
                data-type={edge.type}
                data-focused={focused}
                data-dimmed={dimmed}
                data-ink={focused ? focusInkAttr ?? undefined : undefined}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            )
          })}
          {visible.nodes.map((node) => {
            const position = positions[node.id]
            if (position === undefined) return null
            const radius = nodeRadius(node, scope)
            const ink = nodeInk(node)
            const selected = node.id === selectedId
            const hovered = node.id === hoverId
            const dimmed = neighbours !== null && !neighbours.has(node.id)
            const isPinned = pinned[node.id] !== undefined || node.pinned === true
            return (
              <g
                key={node.id}
                className="ln-node"
                data-node-id={node.id}
                data-type={node.type}
                data-aspect={ink === 'ink' ? undefined : ink}
                data-selected={selected}
                data-pinned={isPinned}
                data-dimmed={dimmed}
                data-hovered={hovered}
                transform={`translate(${position.x} ${position.y})`}
                role="button"
                tabIndex={0}
                aria-label={node.label}
                aria-pressed={selected}
                onPointerDown={(event) => onNodePointerDown(event, node)}
                onPointerEnter={() => setHoverId(node.id)}
                onPointerLeave={() => setHoverId((current) => (current === node.id ? null : current))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (selected) onJump(node)
                  else onSelect(node.id)
                }}
              >
                {selected ? <circle className="ln-node__halo" r={radius + 7} /> : null}
                {ink === 'ink' ? null : <circle className="ln-node__ring" r={radius + 3} />}
                <circle className="ln-node__disc" r={radius} />
                {isPinned ? (
                  <path
                    className="ln-node__pin"
                    transform={`translate(${radius * 0.78} ${-radius * 0.78}) scale(${1 / camera.k})`}
                    d="M0 -3.2 L2.6 0 L0 1.2 L0 4.4 L-2.6 0 L0 -3.2 Z"
                  />
                ) : null}
                {showLabels ? (
                  <text
                    className="ln-node__label"
                    y={radius + 13 / camera.k}
                    fontSize={11.5 / camera.k}
                    textAnchor="middle"
                  >
                    {truncateLabel(node.label)}
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>
      <div className="ln-graph__hud ln-graph__hud--br" role="toolbar" aria-label={t('graph.hud.fit')}>
        <IconButton icon="zoomOut" label={t('graph.hud.zoomOut')} size={16} onClick={() => zoomBy(1 / 1.25)} />
        <IconButton icon="zoomIn" label={t('graph.hud.zoomIn')} size={16} onClick={() => zoomBy(1.25)} />
        <IconButton icon="fit" label={t('graph.hud.fit')} size={16} onClick={() => fit()} />
        {narrow ? (
          <button
            type="button"
            className="ln-chip ln-chip--quiet"
            aria-pressed={showLabels}
            onClick={() => setLabelOverride((value) => !value)}
          >
            {t('graph.hud.labels')}
          </button>
        ) : null}
      </div>
      <span className="ln-graph__zoom ln-tabular" aria-hidden="true">
        {Math.round(camera.k * 100)}%
      </span>
      <span className="ln-graph__count ln-tabular" aria-hidden="true">
        {t('graph.counts', { nodes: visible.nodes.length, edges: visible.edges.length })}
      </span>
    </div>
  )
}
