/**
 * Shared annotation/highlight helpers.
 *
 * The 0.3.0 client kept these in `ui/highlight.js`; 1.0.0 moves them under
 * `src/shared/annotate/**` so the Host (AI annotation creation, quote
 * normalization, stale flags) and the Client (highlight rendering, margin
 * notes) agree byte-for-byte on annotation shapes, clamping and overlay
 * segmentation.
 *
 * Persisted annotation (per document):
 *   { id, blockKey, start, end, quote, color, note?, createdAt, updatedAt,
 *     origin?, aspect?, chatId?, messageId?, model?, stale?, staleReason?,
 *     reanchored? }
 *
 * `start`/`end` are offsets into the block's `plainText`, `end` exclusive.
 * Environment-neutral: no DOM access beyond the optional `crypto` API.
 */

import { ANNOTATION_COLORS } from '../constants.ts'
import type { AnnotationColor, Aspect } from '../constants.ts'
import { plainTextOfBlock, runsText } from '../markdown/model.ts'
import type { Run, RunStyle } from '../markdown/model.ts'
import type { Annotation } from '../model.ts'

/** Ink colors accepted by the reader (docs/UI-SPEC.md). */
const COLORS: readonly string[] = ANNOTATION_COLORS

/** Default ink color for unknown/missing values. */
const DEFAULT_COLOR: AnnotationColor = 'yellow'

/** Citation aspects accepted on annotations (mirrors docs/AI-SPEC.md §2). */
const ASPECTS: readonly string[] = ['definition', 'method', 'result', 'limitation', 'context']

/** Deterministic fallback timestamp for annotations missing one. */
const EPOCH = '1970-01-01T00:00:00.000Z'

/**
 * The normalized on-disk annotation shape produced by
 * {@link normalizeAnnotation} (frozen 1.0.0 contract).
 *
 * Extends the shared persisted {@link Annotation} contract: normalization makes
 * `note`/`createdAt`/`updatedAt` required defaults and validates provenance.
 */
export interface NormalizedAnnotation extends Annotation {
  note: string
  createdAt: string
  updatedAt: string
}

/** One rendered highlight segment: a run sliced at annotation boundaries. */
export interface OverlaySegment {
  type: 'text' | 'math'
  text: string
  styles: RunStyle
  /** Every annotation covering the segment (overlaps keep all ids). */
  annotationIds: string[]
  /** Ink color of the first covering annotation, or `null` for plain text. */
  color: AnnotationColor | null
  /** LaTeX body for math segments. */
  latex?: string
}

/** Whether a value is a valid annotation ink color. */
function isValidColor(color: unknown): color is AnnotationColor {
  return typeof color === 'string' && COLORS.includes(color)
}

/** Copy a run's inline style flags into a render-friendly object. */
function runStyles(run: Run): RunStyle {
  // Math runs share the text-run style subset; reading the full style view is safe.
  const source: RunStyle = run
  const styles: RunStyle = {}
  if (source.strong === true) styles.strong = true
  if (source.em === true) styles.em = true
  if (source.code === true) styles.code = true
  if (source.del === true) styles.del = true
  if (typeof source.link === 'string' && source.link !== '') styles.link = source.link
  return styles
}

/** Integer annotation bounds, or null when the annotation is unusable. */
function boundsOf(annotation: unknown): { start: number; end: number } | null {
  if (annotation === null || typeof annotation !== 'object') return null
  const source = annotation as { start?: unknown; end?: unknown }
  const start = Number(source.start)
  const end = Number(source.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start: Math.trunc(start), end: Math.trunc(end) }
}

/**
 * Split runs into segments carrying the annotations that cover them.
 *
 * The output is split at every annotation boundary inside each run, so two
 * overlapping highlights produce segments whose `annotationIds` holds every
 * covering id (overlaps keep both). `color` is the first covering annotation's
 * ink color (earliest start, then id) or `null` for plain text. Run styles
 * (strong/em/code/del/link) are preserved on every segment of the run.
 *
 * Tolerates untrusted input (`null`, malformed annotations) and never throws.
 */
export function overlayRuns(runs: unknown, annotations: unknown): OverlaySegment[] {
  const segments: OverlaySegment[] = []
  const runList = Array.isArray(runs) ? (runs as Run[]) : []
  const annotationList = Array.isArray(annotations) ? (annotations as unknown[]) : []
  let offset = 0
  for (const run of runList) {
    if (run === null || typeof run !== 'object') continue
    const text = typeof run.text === 'string' ? run.text : ''
    const runStart = offset
    const runEnd = offset + text.length
    offset = runEnd
    if (text === '') continue
    const boundaries = [runStart, runEnd]
    for (const annotation of annotationList) {
      const bounds = boundsOf(annotation)
      if (bounds === null) continue
      if (bounds.end <= runStart || bounds.start >= runEnd) continue
      boundaries.push(Math.max(runStart, bounds.start))
      boundaries.push(Math.min(runEnd, bounds.end))
    }
    boundaries.sort((left, right) => left - right)
    const styles = runStyles(run)
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      const from = boundaries[index]
      const to = boundaries[index + 1]
      if (from === undefined || to === undefined || to <= from) continue
      const covering: unknown[] = []
      for (const annotation of annotationList) {
        const bounds = boundsOf(annotation)
        if (bounds === null) continue
        if (bounds.start < to && bounds.end > from) covering.push(annotation)
      }
      covering.sort((left, right) => {
        const leftBounds = boundsOf(left)
        const rightBounds = boundsOf(right)
        const startDelta = (leftBounds?.start ?? 0) - (rightBounds?.start ?? 0)
        if (startDelta !== 0) return startDelta
        const leftId = String((left as { id?: unknown }).id ?? '')
        const rightId = String((right as { id?: unknown }).id ?? '')
        return leftId.localeCompare(rightId)
      })
      const annotationIds = covering.map((annotation) => String((annotation as { id?: unknown }).id ?? ''))
      const firstCovering = covering[0] as { color?: unknown } | undefined
      const segment: OverlaySegment = {
        type: run.type === 'math' ? 'math' : 'text',
        text: text.slice(from - runStart, to - runStart),
        styles: { ...styles },
        annotationIds,
        color: firstCovering === undefined
          ? null
          : (isValidColor(firstCovering.color) ? firstCovering.color : DEFAULT_COLOR),
      }
      if (segment.type === 'math') {
        const latex = (run as { latex?: unknown }).latex
        if (typeof latex === 'string') segment.latex = latex
      }
      segments.push(segment)
    }
  }
  return segments
}

/** Read one normalized annotation's property map (untrusted input). */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Clamp/normalize one persisted annotation against a block's plain text.
 *
 * Returns `null` when the annotation is unusable: wrong shape, offsets that
 * don't describe at least one character after clamping, a mismatched
 * `blockKey`, or an empty/untextable block. Never mutates the input.
 */
export function normalizeAnnotation(annotation: unknown, block: unknown): NormalizedAnnotation | null {
  const source = recordOf(annotation)
  if (source === null) return null
  const blockRecord = recordOf(block)
  if (blockRecord === null) return null
  const plain = plainTextOfBlock(block)
  if (plain === '') return null
  const blockKeyValue = typeof blockRecord.key === 'string' ? blockRecord.key : ''
  const annotationKey = typeof source.blockKey === 'string' ? source.blockKey : ''
  if (annotationKey !== '' && blockKeyValue !== '' && annotationKey !== blockKeyValue) return null
  const start = Math.max(0, Math.min(Math.trunc(Number(source.start)), plain.length))
  const end = Math.max(0, Math.min(Math.trunc(Number(source.end)), plain.length))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (end <= start) return null
  const providedQuote = typeof source.quote === 'string' ? source.quote : ''
  const id = typeof source.id === 'string' && source.id !== '' ? source.id : newAnnotationId()
  const color = isValidColor(source.color) ? source.color : DEFAULT_COLOR
  const createdAt = typeof source.createdAt === 'string' && source.createdAt !== '' ? source.createdAt : EPOCH
  const updatedAt = typeof source.updatedAt === 'string' && source.updatedAt !== ''
    ? source.updatedAt
    : (typeof source.createdAt === 'string' && source.createdAt !== '' ? source.createdAt : EPOCH)
  const out: NormalizedAnnotation = {
    id,
    blockKey: blockKeyValue !== '' ? blockKeyValue : annotationKey,
    start,
    end,
    quote: providedQuote !== '' ? providedQuote : plain.slice(start, end),
    color,
    note: typeof source.note === 'string' ? source.note : '',
    createdAt,
    updatedAt,
  }
  // AI provenance survives client normalization and the whole-list save path
  // (docs/AI-SPEC.md §2): the margin spark, the "AI 批注" filter and the chat
  // provenance depend on these fields.
  if (source.origin === 'ai' || source.origin === 'user') out.origin = source.origin
  if (typeof source.aspect === 'string' && ASPECTS.includes(source.aspect)) {
    out.aspect = source.aspect as Aspect
  }
  if (typeof source.chatId === 'string' && source.chatId !== '') out.chatId = source.chatId
  if (typeof source.messageId === 'string' && source.messageId !== '') out.messageId = source.messageId
  const model = recordOf(source.model)
  if (model !== null && typeof model.provider === 'string' && typeof model.model === 'string') {
    out.model = { provider: model.provider, model: model.model }
  }
  if (source.stale === true) {
    out.stale = true
    if (typeof source.staleReason === 'string' && source.staleReason !== '') out.staleReason = source.staleReason
  }
  if (source.reanchored === true) out.reanchored = true
  return out
}

/**
 * Group annotations by `blockKey` for fast per-block rendering.
 *
 * Unusable entries (missing/empty `blockKey`) are skipped; input order is kept.
 */
export function groupAnnotations<T>(
  annotations: readonly (T | null | undefined)[] | null | undefined,
): Map<string, T[]> {
  const map = new Map<string, T[]>()
  if (!Array.isArray(annotations)) return map
  for (const annotation of annotations) {
    if (annotation === null || typeof annotation !== 'object') continue
    const key = (annotation as { blockKey?: unknown }).blockKey
    if (typeof key !== 'string' || key === '') continue
    const list = map.get(key)
    if (list === undefined) map.set(key, [annotation as T])
    else list.push(annotation as T)
  }
  return map
}

/** Whether a block kind can carry annotations (UI-SPEC reader text blocks). */
export function isAnnotatableBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return false
  const kind = (block as { kind?: unknown }).kind
  return kind === 'heading'
    || kind === 'paragraph'
    || kind === 'quote'
    || kind === 'list'
    || kind === 'table'
}

/**
 * Create the annotation id shared by the store and the DOM.
 *
 * Format: `a` + 16 lowercase hex characters (8 random bytes). Uses the Web
 * Crypto API when available, falling back to `Math.random` (tests, old hosts).
 */
export function newAnnotationId(): string {
  const bytes = new Uint8Array(8)
  const cryptoApi = typeof globalThis === 'object'
    ? (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto
    : undefined
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  let id = 'a'
  for (const byte of bytes) id += byte.toString(16).padStart(2, '0')
  return id
}

/** Re-exported for consumers that only import the highlight module. */
export { plainTextOfBlock, runsText }
