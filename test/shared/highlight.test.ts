/**
 * Annotation/highlight helper tests (port of
 * `.agents/baseline-1.0.0/test/reader/highlight.test.mjs`): overlay
 * segmentation, normalization/clamping, grouping, annotatable kinds and id
 * generation for the shared `src/shared/annotate/highlight.ts` helpers.
 */

import { test, expect } from 'vitest'

import {
  groupAnnotations,
  isAnnotatableBlock,
  newAnnotationId,
  normalizeAnnotation,
  plainTextOfBlock,
  overlayRuns,
  type NormalizedAnnotation,
} from '../../src/shared/annotate/highlight.ts'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import type { ParagraphBlock, TextualBlock } from '../../src/shared/markdown/model.ts'
import { blockAs, blockAt } from './helpers.ts'

const model = parseMarkdown('Hello **world** and more')
const block = blockAs(blockAt(model, 0), 'paragraph')

/** Normalize and fail the test when the annotation is unusable. */
function norm(annotation: unknown, target: unknown): NormalizedAnnotation {
  const normalized = normalizeAnnotation(annotation, target)
  if (normalized === null) throw new Error('expected a normalized annotation')
  return normalized
}

function segmentSummary(segments: ReturnType<typeof overlayRuns>): Array<Record<string, unknown>> {
  return segments.map((segment) => ({
    text: segment.text,
    styles: segment.styles,
    ids: segment.annotationIds,
    color: segment.color,
    type: segment.type,
  }))
}

test('overlayRuns with no annotations keeps styles and produces plain segments', () => {
  const segments = overlayRuns(block.runs, [])
  expect(segments.map((segment) => segment.text)).toEqual(['Hello ', 'world', ' and more'])
  expect(segments[1]?.styles).toEqual({ strong: true })
  expect(segments[1]?.annotationIds).toEqual([])
  expect(segments[1]?.color).toBeNull()
  expect(segments.length).toBe(3)
})

test('a single annotation splits a run into before/inside/after segments', () => {
  const annotation = { id: 'a1', start: 2, end: 5, color: 'sage' }
  expect(segmentSummary(overlayRuns(block.runs, [annotation]))).toEqual([
    { text: 'He', styles: {}, ids: [], color: null, type: 'text' },
    { text: 'llo', styles: {}, ids: ['a1'], color: 'sage', type: 'text' },
    { text: ' ', styles: {}, ids: [], color: null, type: 'text' },
    { text: 'world', styles: { strong: true }, ids: [], color: null, type: 'text' },
    { text: ' and more', styles: {}, ids: [], color: null, type: 'text' },
  ])
})

test('overlapping annotations split at every boundary and keep every id', () => {
  const annotations = [
    { id: 'late', start: 6, end: 16, color: 'sky' },
    { id: 'early', start: 0, end: 11, color: 'yellow' },
    { id: 'middle', start: 3, end: 8, color: 'rose' },
  ]
  const segments = overlayRuns(block.runs, annotations)
  // Every annotation boundary appears as a segment boundary.
  const boundaries = new Set<number>()
  let offset = 0
  for (const segment of segments) {
    boundaries.add(offset)
    offset += segment.text.length
  }
  boundaries.add(offset)
  expect(boundaries.has(0)).toBe(true)
  expect(boundaries.has(3)).toBe(true)
  expect(boundaries.has(6)).toBe(true)
  expect(boundaries.has(8)).toBe(true)
  expect(boundaries.has(11)).toBe(true)
  expect(boundaries.has(16)).toBe(true)
  expect(offset).toBe(block.plainText.length)
  // Multi-covered regions list all covering ids with a deterministic order.
  const overlapped = segments.find((segment) => segment.annotationIds.length === 3)
  expect(overlapped).toBeDefined()
  expect(overlapped?.annotationIds).toEqual(['early', 'middle', 'late'])
  expect(overlapped?.color).toBe('yellow') // earliest start wins
  // Strong style survives segmentation.
  const strongSegments = segments.filter((segment) => segment.styles.strong === true)
  expect(strongSegments.length).toBeGreaterThan(0)
  expect(strongSegments.every((segment) => segment.annotationIds.length > 0 || segment.text.length > 0)).toBe(true)
})

test('annotation order in the array does not change segmentation or color', () => {
  const first = overlayRuns(block.runs, [
    { id: 'b', start: 6, end: 10, color: 'rose' },
    { id: 'a', start: 0, end: 6, color: 'yellow' },
  ])
  const second = overlayRuns(block.runs, [
    { id: 'a', start: 0, end: 6, color: 'yellow' },
    { id: 'b', start: 6, end: 10, color: 'rose' },
  ])
  expect(first).toEqual(second)
})

test('annotations spanning multiple runs and out-of-range bounds are clamped', () => {
  const segments = overlayRuns(block.runs, [
    { id: 'span', start: -20, end: 999, color: 'yellow' },
    { id: 'outside', start: 500, end: 900, color: 'sage' },
  ])
  expect(segments.map((segment) => segment.text).join('')).toBe(block.plainText)
  expect(segments.every((segment) => segment.annotationIds.includes('span'))).toBe(true)
  expect(segments.some((segment) => segment.annotationIds.includes('outside'))).toBe(false)
  expect(segments[0]?.color).toBe('yellow')
})

test('overlayRuns ignores malformed annotations and empty runs', () => {
  expect(overlayRuns([], [])).toEqual([])
  expect(overlayRuns(null, null)).toEqual([])
  const segments = overlayRuns(block.runs, [
    null,
    { id: 'bad', start: 'nope', end: 3 },
    { id: 'empty', start: 4, end: 4 },
    { id: 'ok', start: 0, end: 1, color: 'rose' },
  ])
  expect(segments[0]?.annotationIds.length).toBe(1)
  expect(segments.flatMap((segment) => segment.annotationIds).filter((id) => id !== 'ok')).toEqual([])
})

test('math runs and link styles survive overlayRuns', () => {
  const inline = blockAs(blockAt(parseMarkdown('text $x^2$ [link](https://example.com) end'), 0), 'paragraph')
  const segments = overlayRuns(inline.runs, [{ id: 'm', start: 5, end: 10, color: 'sky' }])
  const math = segments.filter((segment) => segment.type === 'math')
  expect(math.length).toBeGreaterThan(0)
  expect(math[0]?.latex).toBe('x^2')
  const linked = segments.filter((segment) => segment.styles.link === 'https://example.com')
  expect(linked.length).toBeGreaterThan(0)
})

test('normalizeAnnotation returns a clamped copy with defaults', () => {
  const input = { id: 'n1', blockKey: block.key, start: -4, end: 999, note: 'hi' }
  const snapshot = JSON.stringify(input)
  const normalized = norm(input, block)
  expect(JSON.stringify(input)).toBe(snapshot) // input must not be mutated
  expect(normalized.start).toBe(0)
  expect(normalized.end).toBe(plainTextOfBlock(block).length)
  expect(normalized.quote).toBe(block.plainText)
  expect(normalized.color).toBe('yellow')
  expect(normalized.note).toBe('hi')
  expect(normalized.blockKey).toBe(block.key)
  expect(normalized.id).toBe('n1')
  expect(normalized.createdAt).toBe('1970-01-01T00:00:00.000Z')
  expect(normalized.updatedAt).toBe(normalized.createdAt)
})

test('normalizeAnnotation rejects invalid, empty and mismatched annotations', () => {
  expect(normalizeAnnotation(null, block)).toBeNull()
  expect(normalizeAnnotation(undefined, block)).toBeNull()
  expect(normalizeAnnotation('nope', block)).toBeNull()
  expect(normalizeAnnotation([], block)).toBeNull()
  expect(normalizeAnnotation({ start: 0, end: 5 }, null)).toBeNull()
  expect(normalizeAnnotation({ start: 'x', end: 'y' }, block)).toBeNull()
  expect(normalizeAnnotation({ start: 4, end: 4 }, block)).toBeNull()
  expect(normalizeAnnotation({ start: 9, end: 3 }, block)).toBeNull()
  expect(normalizeAnnotation({ blockKey: 'b99:deadbeef', start: 0, end: 2 }, block)).toBeNull()
  const emptyBlock = { key: 'b0:e0e0e0e0', kind: 'paragraph', plainText: '', runs: [] }
  expect(normalizeAnnotation({ start: 0, end: 1 }, emptyBlock)).toBeNull()
})

test('normalizeAnnotation keeps valid colors and coerces unknown ones', () => {
  for (const color of ['yellow', 'sage', 'sky', 'rose']) {
    expect(norm({ start: 0, end: 2, color }, block).color).toBe(color)
  }
  for (const color of ['red', '', null, 42]) {
    expect(norm({ start: 0, end: 2, color }, block).color).toBe('yellow')
  }
})

test('normalizeAnnotation defaults missing ids and commits timestamps', () => {
  const normalized = norm({ start: 1, end: 3, createdAt: '2026-11-06T00:00:00.000Z' }, block)
  expect(normalized.id).toMatch(/^a[0-9a-f]{16}$/)
  expect(normalized.createdAt).toBe('2026-11-06T00:00:00.000Z')
  expect(normalized.updatedAt).toBe('2026-11-06T00:00:00.000Z')
  const withUpdate = norm({
    start: 1,
    end: 3,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
  }, block)
  expect(withUpdate.updatedAt).toBe('2026-11-07T00:00:00.000Z')
})

test('normalizeAnnotation truncates fractional offsets', () => {
  const normalized = norm({ start: 1.9, end: 3.2 }, block)
  expect(normalized.start).toBe(1)
  expect(normalized.end).toBe(3)
  expect(normalized.quote).toBe(block.plainText.slice(1, 3))
})

test('groupAnnotations groups by blockKey and skips unusable entries', () => {
  const groups = groupAnnotations([
    { id: '1', blockKey: 'b0:aaaa', start: 0, end: 1 },
    { id: '2', blockKey: 'b1:bbbb', start: 0, end: 1 },
    { id: '3', blockKey: 'b0:aaaa', start: 2, end: 3 },
    null,
    { id: '4' },
  ])
  expect(groups instanceof Map).toBe(true)
  expect((groups.get('b0:aaaa') ?? []).map((annotation) => annotation.id)).toEqual(['1', '3'])
  expect((groups.get('b1:bbbb') ?? []).map((annotation) => annotation.id)).toEqual(['2'])
  expect(groupAnnotations(null).size).toBe(0)
})

test('isAnnotatableBlock covers exactly the text block kinds', () => {
  for (const kind of ['heading', 'paragraph', 'quote', 'list', 'table']) {
    expect(isAnnotatableBlock({ kind }), kind).toBe(true)
  }
  for (const kind of ['code', 'formula', 'figure', 'page', 'rule', 'unknown']) {
    expect(isAnnotatableBlock({ kind }), kind).toBe(false)
  }
  expect(isAnnotatableBlock(null)).toBe(false)
})

test('newAnnotationId returns unique a-prefixed ids', () => {
  const ids = new Set<string>()
  for (let index = 0; index < 200; index += 1) {
    const id = newAnnotationId()
    expect(id).toMatch(/^a[0-9a-f]{16}$/)
    expect(ids.has(id)).toBe(false)
    ids.add(id)
  }
})

// ---------------------------------------------------------------------------
// AI provenance must survive client normalization (docs/AI-SPEC.md §2)
// ---------------------------------------------------------------------------

test('normalizeAnnotation preserves AI provenance fields', () => {
  const target = {
    key: 'b7:abcd1234',
    kind: 'paragraph',
    plainText: 'The BEE method reduces duplicate backtracking.',
  }
  const normalized = norm({
    id: 'ai-1',
    blockKey: 'b7:abcd1234',
    start: 4,
    end: 7,
    quote: 'BEE',
    color: 'sage',
    note: '核心方法',
    origin: 'ai',
    aspect: 'method',
    chatId: 'doc:abc',
    messageId: 'msg-9',
    model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, target)
  expect(normalized.origin).toBe('ai')
  expect(normalized.aspect).toBe('method')
  expect(normalized.chatId).toBe('doc:abc')
  expect(normalized.messageId).toBe('msg-9')
  expect(normalized.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })

  const legacy = norm({
    id: 'u-1', blockKey: 'b7:abcd1234', start: 0, end: 3, quote: 'The', color: 'yellow', note: '',
  }, target)
  expect(legacy.origin).toBeUndefined()
  expect(legacy.aspect).toBeUndefined()

  const invalid = norm({
    id: 'x-1', blockKey: 'b7:abcd1234', start: 0, end: 3, quote: 'The',
    origin: 'robot', aspect: 'nonsense', chatId: 42,
  }, target)
  expect(invalid.origin).toBeUndefined() // unknown origin is dropped
  expect(invalid.aspect).toBeUndefined() // unknown aspect is dropped
  expect(invalid.chatId).toBeUndefined() // non-string chatId is dropped
})

test('normalizeAnnotation preserves stale/reanchored markers (reanchor round-trip)', () => {
  const target: TextualBlock = block
  const normalized = norm({
    id: 'r-1',
    blockKey: target.key,
    start: 0,
    end: 5,
    quote: 'Hello',
    stale: true,
    staleReason: 'quote-not-found',
    reanchored: true,
    color: 'sky',
  }, target)
  expect(normalized.stale).toBe(true)
  expect(normalized.staleReason).toBe('quote-not-found')
  expect(normalized.reanchored).toBe(true)
})

test('typography of the parsed block feeds normalization', () => {
  const parsed: ParagraphBlock = block
  const normalized = norm({ start: 6, end: 11 }, parsed)
  expect(normalized.quote).toBe('world')
  expect(normalized.blockKey).toBe(parsed.key)
})
