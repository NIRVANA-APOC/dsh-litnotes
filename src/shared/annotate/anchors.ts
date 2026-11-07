/**
 * Shared annotation anchoring helpers.
 *
 * Host and Client MUST agree byte-for-byte on where a quote lands inside a
 * block's plain text: the Host validates AI citations and creates AI
 * annotations with these offsets, the Client renders highlights with them, and
 * the reparse re-anchor pass relocates them. This module owns the two locator
 * families the frozen 1.0.0 implementation used:
 *
 *  1. {@link locateQuote} — AI citation validation (`docs/AI-SPEC.md §3/§5`):
 *     whitespace-normalized substring first; for quotes of at least 20
 *     characters a 40-character (then 20-character) prefix is accepted when the
 *     model drifted. The returned offsets always address the ORIGINAL block
 *     plain text.
 *  2. {@link findQuoteRange} — reparse re-anchoring (`lib/reanchor.js`): exact
 *     substring first, then a whitespace-insensitive fallback mapped back to
 *     original offsets.
 *
 * It also owns the annotation overlap/dedupe rule (`docs/AI-SPEC.md §2`): an
 * existing annotation on the same block covering an overlapping range with the
 * same aspect wins; the new AI annotation is skipped.
 *
 * Environment-neutral and dependency-free.
 */

import type { Aspect } from '../constants.ts'

/** Minimum quote length that may verify / re-anchor via prefix fallback. */
export const MIN_PREFIX_QUOTE_CHARS = 20

/** Prefix length tried first for the citation fallback (`docs/AI-SPEC.md §3`). */
export const PREFIX_QUOTE_CHARS = 40

/** The fallback aspect for unknown/missing values (mirrors AI aspect rules). */
const DEFAULT_ASPECT: Aspect = 'context'

/** Aspects accepted on citations/annotations. */
const ASPECTS: readonly string[] = ['definition', 'method', 'result', 'limitation', 'context']

/** Half-open character range `[start, end)` in a block's plain text. */
export interface QuoteRange {
  start: number
  end: number
}

/** Result of {@link locateQuote}: the range plus the match quality. */
export interface QuoteMatch extends QuoteRange {
  /** `true` when the whole normalized quote matched; `false` for prefix fallback. */
  exact: boolean
  /** Number of normalized characters that matched. */
  matched: number
}

/** A block's plain text with a map from normalized positions to original offsets. */
export interface NormalizedText {
  normalized: string
  /** `offsets[i]` is the original plain-text offset of `normalized[i]`. */
  offsets: number[]
}

/** Range-bearing value used for overlap checks (annotations, citations, quotes). */
export interface RangeLike {
  start?: unknown
  end?: unknown
}

/** Annotation-like value used for the AI dedupe rule. */
export interface AnnotationAnchorLike extends RangeLike {
  blockKey?: unknown
  aspect?: unknown
}

/**
 * Collapse every whitespace run to one space and trim.
 *
 * Single shared implementation of the quote comparison normal form used by
 * citation validation, re-anchoring and the Host retrieval layer.
 */
export function normalizeQuoteText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Frozen `lib/reanchor.js` name for {@link normalizeQuoteText}. */
export const normalizeAnchorText: (value: unknown) => string = normalizeQuoteText

/**
 * Build the whitespace-normalized text of a block plus the mapping from each
 * normalized character position back to the block's original offsets.
 *
 * Consecutive whitespace collapses to one space anchored at the first
 * whitespace character; leading/trailing whitespace is trimmed.
 */
export function normalizeWithMap(plainText: string): NormalizedText {
  const chars: string[] = []
  const offsets: number[] = []
  let lastWasSpace = false
  for (let index = 0; index < plainText.length; index += 1) {
    const char = plainText[index] ?? ''
    if (/\s/.test(char)) {
      if (lastWasSpace) continue
      chars.push(' ')
      offsets.push(index)
      lastWasSpace = true
    } else {
      chars.push(char)
      offsets.push(index)
      lastWasSpace = false
    }
  }
  let start = 0
  while (start < chars.length && chars[start] === ' ') start += 1
  let end = chars.length
  while (end > start && chars[end - 1] === ' ') end -= 1
  return {
    normalized: chars.slice(start, end).join(''),
    offsets: offsets.slice(start, end),
  }
}

/**
 * Locate a model-provided quote inside one block's plain text (AI citation
 * validation, `docs/AI-SPEC.md §3/§5`).
 *
 * Matching rules: whitespace-normalized substring first; if that fails and the
 * quote is at least 20 characters long, a prefix of up to 40 characters is
 * accepted (models drift on long quotes). The returned offsets always address
 * the ORIGINAL `plainText`, never the normalized copy, so the Client can
 * highlight the exact span.
 */
export function locateQuote(plainText: unknown, quote: unknown): QuoteMatch | null {
  const plain = typeof plainText === 'string' ? plainText : ''
  const needle = normalizeQuoteText(quote)
  if (plain === '' || needle === '') return null
  const { normalized, offsets } = normalizeWithMap(plain)
  if (normalized === '') return null
  const found = normalized.indexOf(needle)
  if (found !== -1) {
    const last = found + needle.length - 1
    const start = offsets[found]
    const end = offsets[last]
    if (start === undefined || end === undefined) return null
    return { start, end: end + 1, exact: true, matched: needle.length }
  }
  if (needle.length < MIN_PREFIX_QUOTE_CHARS) return null
  const prefixLength = Math.min(needle.length, PREFIX_QUOTE_CHARS)
  const candidates = [needle.slice(0, prefixLength)]
  if (prefixLength > MIN_PREFIX_QUOTE_CHARS) candidates.push(needle.slice(0, MIN_PREFIX_QUOTE_CHARS))
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed.length < MIN_PREFIX_QUOTE_CHARS) continue
    const at = normalized.indexOf(trimmed)
    if (at === -1) continue
    const last = at + trimmed.length - 1
    const start = offsets[at]
    const end = offsets[last]
    if (start === undefined || end === undefined) continue
    return { start, end: end + 1, exact: false, matched: trimmed.length }
  }
  return null
}

/** Frozen name of {@link locateQuote} (AI citation validation). */
export const locateQuoteRange: (plainText: unknown, quote: unknown) => QuoteMatch | null = locateQuote

/**
 * Locate a quote for re-anchoring after a reparse (`lib/reanchor.js`).
 *
 * Exact substring first (case-sensitive, preserves original whitespace); when
 * that misses, a whitespace-insensitive match is mapped back to the original
 * block offsets. Returns `null` when the quote is not present at all.
 */
export function findQuoteRange(blockText: unknown, quote: unknown): QuoteRange | null {
  const haystack = typeof blockText === 'string' ? blockText : ''
  const needle = typeof quote === 'string' ? quote : ''
  if (haystack === '' || needle.trim() === '') return null
  const exact = haystack.indexOf(needle)
  if (exact !== -1) return { start: exact, end: exact + needle.length }
  const collapsedHaystack = normalizeWithMap(haystack)
  const collapsedNeedle = normalizeQuoteText(needle)
  if (collapsedNeedle === '') return null
  const at = collapsedHaystack.normalized.indexOf(collapsedNeedle)
  if (at === -1) return null
  const start = collapsedHaystack.offsets[at]
  const last = collapsedHaystack.offsets[at + collapsedNeedle.length - 1]
  if (!Number.isInteger(start) || !Number.isInteger(last)) return null
  return { start: start as number, end: (last as number) + 1 }
}

/** Frozen `lib/reanchor.js` name for {@link findQuoteRange}. */
export const locateQuoteInText: (blockText: unknown, quote: unknown) => QuoteRange | null = findQuoteRange

/** Whether a block's plain text contains a quote (exact or normalized). */
export function quoteContained(blockText: unknown, quote: unknown): boolean {
  return findQuoteRange(blockText, quote) !== null
}

/** Read a finite, non-negative annotation bound (missing/invalid values count as 0). */
function boundOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/**
 * Whether two half-open ranges overlap.
 *
 * Zero-length ranges (collapsed selections, missing offsets) behave like
 * points: a point overlaps a range when it lies inside it, and two points
 * overlap when they are equal (frozen AI dedupe semantics).
 */
export function overlaps(left: RangeLike, right: RangeLike): boolean {
  const leftStart = boundOf(left.start)
  const leftEnd = boundOf(left.end)
  const rightStart = boundOf(right.start)
  const rightEnd = boundOf(right.end)
  if (leftStart === leftEnd) return rightStart <= leftStart && rightEnd >= leftStart
  if (rightStart === rightEnd) return leftStart <= rightStart && leftEnd >= rightStart
  return leftStart < rightEnd && rightStart < leftEnd
}

/** Normalize an aspect for comparison: unknown/missing values become `context`. */
function aspectKey(value: unknown): Aspect {
  if (typeof value !== 'string') return DEFAULT_ASPECT
  const normalized = value.trim().toLowerCase()
  return (ASPECTS.includes(normalized) ? normalized : DEFAULT_ASPECT) as Aspect
}

/** Whether two annotations target the same block and overlap. */
export function annotationsOverlap(left: AnnotationAnchorLike, right: AnnotationAnchorLike): boolean {
  const leftKey = typeof left.blockKey === 'string' ? left.blockKey : ''
  const rightKey = typeof right.blockKey === 'string' ? right.blockKey : ''
  if (leftKey === '' || leftKey !== rightKey) return false
  return overlaps(left, right)
}

/**
 * Find an existing annotation that makes `candidate` a duplicate.
 *
 * Dedupe rule (`docs/AI-SPEC.md §2`): same block, overlapping range and the same
 * (normalized) aspect — the existing annotation wins and the new one is
 * skipped, so repeated answers never stack identical AI highlights.
 */
export function findDuplicateAnnotation<T extends AnnotationAnchorLike>(
  existing: readonly T[] | null | undefined,
  candidate: AnnotationAnchorLike,
): T | null {
  if (!Array.isArray(existing)) return null
  const candidateAspect = aspectKey(candidate.aspect)
  const candidateKey = typeof candidate.blockKey === 'string' ? candidate.blockKey : ''
  if (candidateKey === '') return null
  for (const item of existing) {
    if (item === null || typeof item !== 'object') continue
    if (annotationsOverlap(item, candidate) && aspectKey(item.aspect) === candidateAspect) return item
  }
  return null
}

/** Whether `candidate` is a duplicate of an existing annotation (see above). */
export function isDuplicateAnnotation(
  existing: readonly AnnotationAnchorLike[] | null | undefined,
  candidate: AnnotationAnchorLike,
): boolean {
  return findDuplicateAnnotation(existing, candidate) !== null
}
