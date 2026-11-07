/**
 * Client-side annotation helpers.
 *
 * Ports the two frozen 1.0.0 client rules that are NOT shared model logic:
 *
 *  - `mergeAnnotationsForSave` — the whole-list `annotations.save` payload:
 *    normalized (rendered) annotations win by id, while orphan/stale ones are
 *    copied untouched so a reparse can never erase a user's note
 *    (`mruMergeAnnotations` in the 1.0.0 app).
 *  - `normalizeStaleAnnotation` — normalize an annotation whose anchor no longer
 *    resolves so it can still be shown and saved (`mruOrphanAnnotation`).
 *
 * The on-disk shape is owned by `src/shared/model.ts`; normalization against a
 * live block (clamping offsets to `plainText`) is owned by
 * `src/shared/annotate/highlight.ts`. This module only handles the
 * client-specific "keep what we cannot render" policy.
 */

import { ANNOTATION_COLORS } from '../../shared/constants.ts'
import type { AnnotationColor, Aspect } from '../../shared/constants.ts'
import type { NormalizedAnnotation } from '../../shared/annotate/highlight.ts'
import type { Annotation } from '../../shared/model.ts'

/** Maximum selection quote stored on an annotation (frozen 1.0.0 cap). */
export const MAX_ANNOTATION_QUOTE = 2000

/** Deterministic fallback timestamp for annotations missing one. */
const EPOCH = '1970-01-01T00:00:00.000Z'

/** Citation aspects accepted on annotations. */
const ASPECTS: readonly string[] = ['definition', 'method', 'result', 'limitation', 'context']

/** An annotation whose block anchor no longer resolves; always `stale: true`. */
export interface StaleAnnotation extends NormalizedAnnotation {
  stale: true
}

/** Read one plain record from untrusted input. */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Whether `value` is one of the four annotation inks. */
function isInk(value: unknown): value is AnnotationColor {
  return typeof value === 'string' && (ANNOTATION_COLORS as readonly string[]).includes(value)
}

/** Whether `value` is one of the five aspects. */
function isAspect(value: unknown): value is Aspect {
  return typeof value === 'string' && ASPECTS.includes(value)
}

/**
 * Merge the renderable annotations with the orphan/stale ones for one save.
 *
 * Normalized annotations win by id (the rendered version is current); stale
 * annotations that the client has never seen are appended untouched. Entries
 * without a usable id are skipped. Input order is preserved.
 */
export function mergeAnnotationsForSave(
  normalized: readonly Annotation[] | null | undefined,
  stale: readonly Annotation[] | null | undefined,
): Annotation[] {
  const merged = new Map<string, Annotation>()
  for (const annotation of Array.isArray(normalized) ? normalized : []) {
    if (annotation === null || typeof annotation !== 'object') continue
    const id = typeof annotation.id === 'string' ? annotation.id : ''
    if (id === '') continue
    merged.set(id, annotation)
  }
  for (const annotation of Array.isArray(stale) ? stale : []) {
    if (annotation === null || typeof annotation !== 'object') continue
    const id = typeof annotation.id === 'string' ? annotation.id : ''
    if (id === '' || merged.has(id)) continue
    merged.set(id, annotation)
  }
  return Array.from(merged.values())
}

/**
 * Normalize an annotation with no readable block anchor.
 *
 * The result keeps the persisted provenance fields (origin/aspect/chat ids/
 * model) and marks it `stale: true` so the margin can show it without a
 * jump-to-text affordance. Offsets are clamped at 0 but not trimmed to a block
 * length (the block is unknown); the quote is capped at
 * {@link MAX_ANNOTATION_QUOTE}. Returns `null` for unusable input.
 */
export function normalizeStaleAnnotation(annotation: unknown): StaleAnnotation | null {
  const source = recordOf(annotation)
  if (source === null) return null
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (id === '') return null
  const start = Math.max(0, Math.trunc(Number(source.start)) || 0)
  const end = Math.max(0, Math.trunc(Number(source.end)) || 0)
  const createdAt =
    typeof source.createdAt === 'string' && source.createdAt !== '' ? source.createdAt : EPOCH
  const out: StaleAnnotation = {
    id,
    blockKey: typeof source.blockKey === 'string' ? source.blockKey : '',
    start,
    end,
    quote:
      typeof source.quote === 'string' ? source.quote.slice(0, MAX_ANNOTATION_QUOTE) : '',
    color: isInk(source.color) ? source.color : 'yellow',
    note: typeof source.note === 'string' ? source.note : '',
    createdAt,
    updatedAt:
      typeof source.updatedAt === 'string' && source.updatedAt !== '' ? source.updatedAt : createdAt,
    stale: true,
  }
  if (typeof source.staleReason === 'string' && source.staleReason !== '') {
    out.staleReason = source.staleReason
  }
  if (source.reanchored === true) out.reanchored = true
  if (source.origin === 'ai' || source.origin === 'user') out.origin = source.origin
  if (isAspect(source.aspect)) out.aspect = source.aspect
  if (typeof source.chatId === 'string' && source.chatId !== '') out.chatId = source.chatId
  if (typeof source.messageId === 'string' && source.messageId !== '') out.messageId = source.messageId
  const model = recordOf(source.model)
  if (model !== null && typeof model.provider === 'string' && typeof model.model === 'string') {
    out.model = { provider: model.provider, model: model.model }
  }
  return out
}
