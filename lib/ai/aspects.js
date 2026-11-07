/**
 * Citation aspects and their annotation ink colors for dsh-litnotes.
 *
 * Single source of truth for the AI→highlight color mapping documented in
 * docs/AI-SPEC.md §2. The chat service records an `aspect` on every verified
 * citation, creates one annotation per verified citation and colors it through
 * {@link aspectColor}; the client reuses the same ink names as user
 * annotations, so the margin stays legible when AI and human notes mix.
 *
 * @module lib/ai/aspects
 */

/** Citation aspects, in the order they appear in the documentation. */
export const ASPECTS = Object.freeze(['definition', 'method', 'result', 'limitation', 'context'])

/**
 * Aspect → annotation ink color. Mirrors {@link ASPECTS}; `context` and
 * `definition` share the yellow ink because both mark background material.
 */
export const ASPECT_COLORS = Object.freeze({
  definition: 'yellow',
  method: 'sage',
  result: 'sky',
  limitation: 'rose',
  context: 'yellow',
})

/** The fallback aspect: unknown or missing values become background material. */
export const DEFAULT_ASPECT = 'context'

/** Accepted ink colors (kept in sync with `lib/config.js` / ui/highlight.js). */
export const ASPECT_INKS = Object.freeze(['yellow', 'sage', 'sky', 'rose'])

/**
 * Normalize a model- or client-supplied aspect string.
 *
 * Unknown, missing and non-string values collapse to `context` (never throw:
 * aspect quality must not be able to fail an answer).
 *
 * @param {unknown} value - candidate aspect (`'method'`, `'Method'`, `'  result '`, …).
 * @returns {'definition'|'method'|'result'|'limitation'|'context'} a valid aspect.
 */
export function normalizeAspect(value) {
  if (typeof value !== 'string') return DEFAULT_ASPECT
  const normalized = value.trim().toLowerCase()
  return ASPECTS.includes(normalized) ? normalized : DEFAULT_ASPECT
}

/**
 * Ink color for one aspect.
 *
 * @param {unknown} aspect - candidate aspect (normalized first).
 * @returns {'yellow'|'sage'|'sky'|'rose'} annotation ink color.
 */
export function aspectColor(aspect) {
  return ASPECT_COLORS[normalizeAspect(aspect)]
}

/**
 * Whether a value names one of the known aspects (no normalization).
 * @param {unknown} value - candidate aspect.
 * @returns {boolean} true for an exact known aspect.
 */
export function isAspect(value) {
  return typeof value === 'string' && ASPECTS.includes(value)
}
