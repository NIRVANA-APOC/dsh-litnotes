/**
 * Citation aspects and their annotation ink colors for dsh-litnotes.
 *
 * Single source of truth for the AI → highlight color mapping documented in
 * `docs/AI-SPEC.md` §2. The chat service records an `aspect` on every verified
 * citation, creates one annotation per verified citation and colors it through
 * {@link aspectColor}; the client reuses the same ink names as user
 * annotations, so the margin stays legible when AI and human notes mix.
 *
 * The vocabulary itself lives in `src/shared/constants.ts` (shared with the
 * client bundle); this module only adds the defensive normalization rules the
 * model boundary needs.
 *
 * @module host/ai/aspects
 */

import {
  ASPECT_COLORS,
  ASPECTS,
  type AnnotationColor,
  type Aspect,
} from '../../shared/constants.ts'

export { ASPECTS, ASPECT_COLORS }
export type { AnnotationColor, Aspect }

/** The fallback aspect: unknown or missing values become background material. */
export const DEFAULT_ASPECT: Aspect = 'context'

/** Accepted ink colors, in swatch order (mirrors `ANNOTATION_COLORS`). */
export const ASPECT_INKS: readonly AnnotationColor[] = Object.freeze([
  'yellow',
  'sage',
  'sky',
  'rose',
])

/**
 * Normalize a model- or client-supplied aspect string.
 *
 * Unknown, missing and non-string values collapse to {@link DEFAULT_ASPECT}
 * (never throw: aspect quality must not be able to fail an answer).
 *
 * @param value - candidate aspect (`'method'`, `'Method'`, `'  result '`, …).
 * @returns a valid aspect.
 */
export function normalizeAspect(value: unknown): Aspect {
  if (typeof value !== 'string') return DEFAULT_ASPECT
  const normalized = value.trim().toLowerCase()
  return (ASPECTS as readonly string[]).includes(normalized) ? (normalized as Aspect) : DEFAULT_ASPECT
}

/**
 * Ink color for one aspect.
 *
 * @param aspect - candidate aspect (normalized first).
 * @returns annotation ink color.
 */
export function aspectColor(aspect: unknown): AnnotationColor {
  return ASPECT_COLORS[normalizeAspect(aspect)]
}

/**
 * Whether a value names one of the known aspects (exact match, no folding).
 *
 * @param value - candidate aspect.
 * @returns `true` for an exact known aspect.
 */
export function isAspect(value: unknown): value is Aspect {
  return typeof value === 'string' && (ASPECTS as readonly string[]).includes(value)
}
