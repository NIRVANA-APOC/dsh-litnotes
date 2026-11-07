/**
 * Infinite-canvas camera math for the graph scene.
 *
 * `screen = world * k + (x, y)`. The canvas is unbounded (panning has no clamp);
 * zoom is clamped to 0.6×–2.5× and always keeps the point under the cursor /
 * pinch centre fixed. Pure + deterministic so the interaction is unit-testable
 * without a DOM (frozen 1.0.0 camera semantics, `ui/graph.js` §6).
 */

import type { Point } from './model.ts'

/** Minimum/maximum canvas magnification (DESIGN-V2 §5). */
export const MIN_ZOOM = 0.6
export const MAX_ZOOM = 2.5

/** One camera: world → screen transform. */
export interface Camera {
  x: number
  y: number
  k: number
}

/** The canvas viewport in CSS pixels. */
export interface Viewport {
  width: number
  height: number
}

/** Clamp a magnification into the allowed range. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value))
}

/** The identity camera (world == screen). */
export function identityCamera(): Camera {
  return { x: 0, y: 0, k: 1 }
}

/** Map one world point to screen coordinates. */
export function worldToScreen(point: Point, camera: Camera): Point {
  return { x: point.x * camera.k + camera.x, y: point.y * camera.k + camera.y }
}

/** Map one screen point to world coordinates. */
export function screenToWorld(point: Point, camera: Camera): Point {
  const k = camera.k === 0 || !Number.isFinite(camera.k) ? 1 : camera.k
  return { x: (point.x - camera.x) / k, y: (point.y - camera.y) / k }
}

/** Pan the camera by a screen-space delta (unbounded). */
export function panCamera(camera: Camera, deltaX: number, deltaY: number): Camera {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return camera
  return { x: camera.x + deltaX, y: camera.y + deltaY, k: camera.k }
}

/**
 * Zoom to `nextK` keeping the world point under `anchor` (screen px) fixed.
 *
 * This is the wheel/pinch rule: the map grows/shrinks around the cursor, never
 * around the viewport centre.
 */
export function zoomCameraAt(camera: Camera, nextK: number, anchor: Point): Camera {
  const k = clampZoom(nextK)
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return { ...camera, k }
  const world = screenToWorld(anchor, camera)
  return {
    x: anchor.x - world.x * k,
    y: anchor.y - world.y * k,
    k,
  }
}

/** Axis-aligned world bounds of a position map. */
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  count: number
}

/** Compute the bounds of a position map (width/height 0 for one node). */
export function boundsOf(positions: Record<string, Point>): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let count = 0
  for (const id of Object.keys(positions)) {
    const point = positions[id]
    if (point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    count += 1
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  if (count === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, count: 0 }
  return { minX, minY, maxX, maxY, count }
}

/** Options of {@link fitCamera}. */
export interface FitOptions {
  /** Screen padding around the fitted content (default 48px). */
  padding?: number
  /** Never zoom in past this (default 1.4 — fits should not blow a small map up). */
  maxZoom?: number
}

/**
 * Fit every node into the viewport (the `F` / double-click / fit button rule).
 *
 * Centres the content, respects a padding margin and caps magnification so a
 * three-node map does not fill the screen.
 */
export function fitCamera(
  positions: Record<string, Point>,
  viewport: Viewport,
  options: FitOptions = {},
): Camera {
  const padding = options.padding ?? 48
  const maxZoom = options.maxZoom ?? 1.4
  const bounds = boundsOf(positions)
  const width = Math.max(1, viewport.width)
  const height = Math.max(1, viewport.height)
  if (bounds.count === 0) return identityCamera()
  const spanX = Math.max(1, bounds.maxX - bounds.minX)
  const spanY = Math.max(1, bounds.maxY - bounds.minY)
  const available = Math.max(1, Math.min(width - padding * 2, height - padding * 2))
  const k = clampZoom(Math.min(maxZoom, available / Math.max(spanX, spanY)))
  const centerWorldX = (bounds.minX + bounds.maxX) / 2
  const centerWorldY = (bounds.minY + bounds.maxY) / 2
  return {
    x: width / 2 - centerWorldX * k,
    y: height / 2 - centerWorldY * k,
    k,
  }
}

/** Whether any node of `positions` is still inside the viewport (with margin). */
export function cameraShowsAny(positions: Record<string, Point>, camera: Camera, viewport: Viewport, margin = 40): boolean {
  for (const point of Object.values(positions)) {
    const screen = worldToScreen(point, camera)
    if (screen.x >= -margin && screen.x <= viewport.width + margin
      && screen.y >= -margin && screen.y <= viewport.height + margin) return true
  }
  return false
}

/** Zoom one step in/out around the viewport centre (HUD `+`/`−` buttons). */
export function zoomStep(camera: Camera, viewport: Viewport, factor: number): Camera {
  return zoomCameraAt(camera, camera.k * factor, { x: viewport.width / 2, y: viewport.height / 2 })
}
