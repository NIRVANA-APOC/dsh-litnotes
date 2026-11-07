/**
 * Shared annotation-anchor tests.
 *
 * The Host validates AI citations and creates annotations with these helpers;
 * the Client renders highlights with the same offsets; the reparse re-anchor
 * pass uses the same normalization. These tests pin the frozen 1.0.0 matching
 * rules (`lib/ai/chat.js`, `lib/reanchor.js`, docs/AI-SPEC.md §2/§3/§5).
 */

import { test, expect } from 'vitest'

import {
  MIN_PREFIX_QUOTE_CHARS,
  annotationsOverlap,
  findDuplicateAnnotation,
  findQuoteRange,
  isDuplicateAnnotation,
  locateQuote,
  locateQuoteRange,
  normalizeAnchorText,
  normalizeQuoteText,
  normalizeWithMap,
  overlaps,
  quoteContained,
  type QuoteMatch,
} from '../../src/shared/annotate/anchors.ts'

test('normalizeQuoteText collapses whitespace and trims', () => {
  expect(normalizeQuoteText('  a\n b\t c  ')).toBe('a b c')
  expect(normalizeQuoteText(null)).toBe('')
  expect(normalizeQuoteText(42)).toBe('42')
  expect(normalizeAnchorText(' x ')).toBe('x')
})

test('normalizeWithMap maps normalized positions back to original offsets', () => {
  const text = 'The   block\nreference'
  const { normalized, offsets } = normalizeWithMap(text)
  expect(normalized).toBe('The block reference')
  expect(offsets.length).toBe(normalized.length)
  // Every mapped offset addresses the same normalized character.
  for (let index = 0; index < normalized.length; index += 1) {
    expect(text[offsets[index] ?? -1]?.replace(/\s/g, ' ')).toBe(normalized[index])
  }
  expect(normalizeWithMap('').normalized).toBe('')
})

test('locateQuote: whitespace-normalized substring with offsets into original text', () => {
  const text = 'The   block\nreference structure retrieves embeddings.'
  const match = locateQuote(text, 'block reference')
  expect(match).toEqual({ start: 6, end: 21, exact: true, matched: 15 })
  expect(text.slice(match?.start, match?.end)).toBe('block\nreference')
  expect(locateQuote(text, 'zzz')).toBeNull()
  expect(locateQuote('', 'anything')).toBeNull()
  expect(locateQuote(text, '   ')).toBeNull()
})

test('locateQuote: >=20-char prefix fallback when the model drifted', () => {
  const text = 'Mixture-of-experts layers compute a weighted sum of expert outputs per token.'
  const longQuote = 'Mixture-of-experts layers compute a weighted sum of expert outputs per token (drifted tail)'
  const match: QuoteMatch | null = locateQuote(text, longQuote)
  expect(match).not.toBeNull()
  if (match === null) return
  expect(match.exact).toBe(false)
  expect(match.matched).toBeGreaterThanOrEqual(MIN_PREFIX_QUOTE_CHARS)
  expect(text.slice(match.start, match.end).startsWith('Mixture-of-experts')).toBe(true)
  // Quotes shorter than the 20-char minimum never get the fallback.
  expect(locateQuote(text, 'Mixture-of zzz')).toBeNull()
  // A drifted quote still matches through its 20-char prefix (frozen rule).
  const drifted = locateQuote(text, 'Mixture-of-experts layers compute zzz')
  expect(drifted?.exact).toBe(false)
  expect(drifted?.matched).toBe(MIN_PREFIX_QUOTE_CHARS)
  // locateQuoteRange is the frozen AI name for the same helper.
  expect(locateQuoteRange(text, longQuote)).toEqual(match)
})

test('findQuoteRange: exact first, then whitespace-insensitive fallback', () => {
  const text = 'one   two\nthree'
  expect(findQuoteRange(text, 'two')).toEqual({ start: 6, end: 9 })
  expect(findQuoteRange(text, 'two three')).toEqual({ start: 6, end: 15 })
  expect(findQuoteRange('abc', 'zzz')).toBeNull()
  expect(findQuoteRange(text, '')).toBeNull()
  expect(quoteContained(text, 'two three')).toBe(true)
  expect(quoteContained(text, 'four')).toBe(false)
})

test('overlaps handles half-open and zero-length ranges (frozen AI dedupe semantics)', () => {
  expect(overlaps({ start: 0, end: 5 }, { start: 4, end: 9 })).toBe(true)
  expect(overlaps({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false)
  expect(overlaps({ start: 5, end: 5 }, { start: 0, end: 9 })).toBe(true)
  expect(overlaps({ start: 0, end: 9 }, { start: 5, end: 5 })).toBe(true)
  expect(overlaps({ start: 5, end: 5 }, { start: 5, end: 5 })).toBe(true)
  expect(overlaps({ start: 5, end: 5 }, { start: 6, end: 6 })).toBe(false)
  expect(overlaps({}, { start: 1, end: 2 })).toBe(false)
})

test('annotationsOverlap requires the same block plus range overlap', () => {
  expect(annotationsOverlap(
    { blockKey: 'b0:aaaaaaaa', start: 0, end: 5 },
    { blockKey: 'b0:aaaaaaaa', start: 4, end: 9 },
  )).toBe(true)
  expect(annotationsOverlap(
    { blockKey: 'b0:aaaaaaaa', start: 0, end: 5 },
    { blockKey: 'b1:bbbbbbbb', start: 4, end: 9 },
  )).toBe(false)
  expect(annotationsOverlap({ start: 0, end: 5 }, { start: 0, end: 5 })).toBe(false)
})

test('findDuplicateAnnotation: same block + overlap + same aspect wins', () => {
  const existing = [
    { id: 'x', blockKey: 'b0:aaaaaaaa', start: 0, end: 10, aspect: 'method' },
    { id: 'y', blockKey: 'b0:aaaaaaaa', start: 20, end: 30, aspect: 'result' },
  ]
  expect(findDuplicateAnnotation(existing, { blockKey: 'b0:aaaaaaaa', start: 5, end: 8, aspect: 'method' })?.id)
    .toBe('x')
  expect(findDuplicateAnnotation(existing, { blockKey: 'b0:aaaaaaaa', start: 5, end: 8, aspect: 'result' }))
    .toBeNull()
  expect(findDuplicateAnnotation(existing, { blockKey: 'b0:aaaaaaaa', start: 5, end: 8, aspect: 'definition' }))
    .toBeNull()
  // Unknown aspect normalizes to `context` on both sides.
  expect(findDuplicateAnnotation(existing, { blockKey: 'b0:aaaaaaaa', start: 1, end: 2, aspect: 'unknown' }))
    .toBeNull()
  const contextExisting = [{ id: 'c', blockKey: 'b0:aaaaaaaa', start: 0, end: 10 }]
  expect(findDuplicateAnnotation(contextExisting, { blockKey: 'b0:aaaaaaaa', start: 1, end: 2, aspect: 'nonsense' })?.id)
    .toBe('c')
  expect(findDuplicateAnnotation(existing, { blockKey: 'b0:aaaaaaaa', start: 40, end: 50, aspect: 'method' }))
    .toBeNull()
  expect(findDuplicateAnnotation(null, { blockKey: 'b0:aaaaaaaa', start: 0, end: 1 })).toBeNull()
  expect(isDuplicateAnnotation(existing, { blockKey: 'b0:aaaaaaaa', start: 5, end: 8, aspect: 'method' })).toBe(true)
})
