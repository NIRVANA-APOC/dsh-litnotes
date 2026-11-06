/**
 * Annotation/highlight helper tests (ui/highlight.js): overlay segmentation,
 * normalization/clamping, grouping, annotatable kinds and id generation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reader } from './helpers.mjs'

const {
  parseMarkdown,
  overlayRuns,
  normalizeAnnotation,
  groupAnnotations,
  isAnnotatableBlock,
  newAnnotationId,
  plainTextOfBlock,
} = reader

const model = parseMarkdown('Hello **world** and more')
const block = model.blocks[0] // "Hello world and more", runs: Hello / world(strong) / " and more"

function segmentSummary(segments) {
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
  assert.deepEqual(segments.map((segment) => segment.text), ['Hello ', 'world', ' and more'])
  assert.deepEqual(segments[1].styles, { strong: true })
  assert.deepEqual(segments[1].annotationIds, [])
  assert.equal(segments[1].color, null)
  assert.equal(segments.length, 3)
})

test('a single annotation splits a run into before/inside/after segments', () => {
  const annotation = { id: 'a1', start: 2, end: 5, color: 'sage' }
  const segments = segmentSummary(overlayRuns(block.runs, [annotation]))
  assert.deepEqual(segments, [
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
  const boundaries = new Set()
  let offset = 0
  for (const segment of segments) {
    boundaries.add(offset)
    offset += segment.text.length
  }
  boundaries.add(offset)
  assert.ok(boundaries.has(0))
  assert.ok(boundaries.has(3))
  assert.ok(boundaries.has(6))
  assert.ok(boundaries.has(8))
  assert.ok(boundaries.has(11))
  assert.ok(boundaries.has(16))
  assert.equal(offset, block.plainText.length)
  // Multi-covered regions list all covering ids with a deterministic order.
  const overlapped = segments.find((segment) => segment.annotationIds.length === 3)
  assert.ok(overlapped)
  assert.deepEqual(overlapped.annotationIds, ['early', 'middle', 'late'])
  assert.equal(overlapped.color, 'yellow') // earliest start wins
  // Strong style survives segmentation.
  const strongSegments = segments.filter((segment) => segment.styles.strong === true)
  assert.ok(strongSegments.length > 0)
  assert.ok(strongSegments.every((segment) => segment.annotationIds.length > 0
    || segment.text.length > 0))
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
  assert.deepEqual(first, second)
})

test('annotations spanning multiple runs and out-of-range bounds are clamped', () => {
  const segments = overlayRuns(block.runs, [
    { id: 'span', start: -20, end: 999, color: 'yellow' },
    { id: 'outside', start: 500, end: 900, color: 'sage' },
  ])
  assert.equal(segments.map((segment) => segment.text).join(''), block.plainText)
  assert.ok(segments.every((segment) => segment.annotationIds.includes('span')))
  assert.ok(!segments.some((segment) => segment.annotationIds.includes('outside')))
  assert.equal(segments[0].color, 'yellow')
})

test('overlayRuns ignores malformed annotations and empty runs', () => {
  assert.deepEqual(overlayRuns([], []), [])
  assert.deepEqual(overlayRuns(null, null), [])
  const segments = overlayRuns(block.runs, [
    null,
    { id: 'bad', start: 'nope', end: 3 },
    { id: 'empty', start: 4, end: 4 },
    { id: 'ok', start: 0, end: 1, color: 'rose' },
  ])
  assert.equal(segments[0].annotationIds.length, 1)
  assert.deepEqual(segments.flatMap((segment) => segment.annotationIds).filter((id) => id !== 'ok'), [])
})

test('math runs and link styles survive overlayRuns', () => {
  const inline = parseMarkdown('text $x^2$ [link](https://example.com) end').blocks[0]
  const segments = overlayRuns(inline.runs, [{ id: 'm', start: 5, end: 10, color: 'sky' }])
  const math = segments.filter((segment) => segment.type === 'math')
  assert.ok(math.length > 0)
  assert.equal(math[0].latex, 'x^2')
  const linked = segments.filter((segment) => segment.styles.link === 'https://example.com')
  assert.ok(linked.length > 0)
})

test('normalizeAnnotation returns a clamped copy with defaults', () => {
  const input = { id: 'n1', blockKey: block.key, start: -4, end: 999, note: 'hi' }
  const snapshot = JSON.stringify(input)
  const normalized = normalizeAnnotation(input, block)
  assert.equal(JSON.stringify(input), snapshot, 'input must not be mutated')
  assert.equal(normalized.start, 0)
  assert.equal(normalized.end, plainTextOfBlock(block).length)
  assert.equal(normalized.quote, block.plainText)
  assert.equal(normalized.color, 'yellow')
  assert.equal(normalized.note, 'hi')
  assert.equal(normalized.blockKey, block.key)
  assert.equal(normalized.id, 'n1')
  assert.equal(normalized.createdAt, '1970-01-01T00:00:00.000Z')
  assert.equal(normalized.updatedAt, normalized.createdAt)
})

test('normalizeAnnotation rejects invalid, empty and mismatched annotations', () => {
  assert.equal(normalizeAnnotation(null, block), null)
  assert.equal(normalizeAnnotation(undefined, block), null)
  assert.equal(normalizeAnnotation('nope', block), null)
  assert.equal(normalizeAnnotation([], block), null)
  assert.equal(normalizeAnnotation({ start: 0, end: 5 }, null), null)
  assert.equal(normalizeAnnotation({ start: 'x', end: 'y' }, block), null)
  assert.equal(normalizeAnnotation({ start: 4, end: 4 }, block), null)
  assert.equal(normalizeAnnotation({ start: 9, end: 3 }, block), null)
  assert.equal(normalizeAnnotation({ blockKey: 'b99:deadbeef', start: 0, end: 2 }, block), null)
  const emptyBlock = { key: 'b0:e0e0e0e0', kind: 'paragraph', plainText: '', runs: [] }
  assert.equal(normalizeAnnotation({ start: 0, end: 1 }, emptyBlock), null)
})

test('normalizeAnnotation keeps valid colors and coerces unknown ones', () => {
  for (const color of ['yellow', 'sage', 'sky', 'rose']) {
    const normalized = normalizeAnnotation({ start: 0, end: 2, color }, block)
    assert.equal(normalized.color, color)
  }
  for (const color of ['red', '', null, 42]) {
    const normalized = normalizeAnnotation({ start: 0, end: 2, color }, block)
    assert.equal(normalized.color, 'yellow')
  }
})

test('normalizeAnnotation defaults missing ids and commits timestamps', () => {
  const normalized = normalizeAnnotation({ start: 1, end: 3, createdAt: '2026-11-06T00:00:00.000Z' }, block)
  assert.match(normalized.id, /^a[0-9a-f]{16}$/)
  assert.equal(normalized.createdAt, '2026-11-06T00:00:00.000Z')
  assert.equal(normalized.updatedAt, '2026-11-06T00:00:00.000Z')
  const withUpdate = normalizeAnnotation({
    start: 1,
    end: 3,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
  }, block)
  assert.equal(withUpdate.updatedAt, '2026-11-07T00:00:00.000Z')
})

test('normalizeAnnotation truncates fractional offsets', () => {
  const normalized = normalizeAnnotation({ start: 1.9, end: 3.2 }, block)
  assert.equal(normalized.start, 1)
  assert.equal(normalized.end, 3)
  assert.equal(normalized.quote, block.plainText.slice(1, 3))
})

test('groupAnnotations groups by blockKey and skips unusable entries', () => {
  const groups = groupAnnotations([
    { id: '1', blockKey: 'b0:aaaa', start: 0, end: 1 },
    { id: '2', blockKey: 'b1:bbbb', start: 0, end: 1 },
    { id: '3', blockKey: 'b0:aaaa', start: 2, end: 3 },
    null,
    { id: '4' },
  ])
  assert.equal(groups instanceof Map, true)
  assert.deepEqual(groups.get('b0:aaaa').map((annotation) => annotation.id), ['1', '3'])
  assert.deepEqual(groups.get('b1:bbbb').map((annotation) => annotation.id), ['2'])
  assert.equal(groupAnnotations(null).size, 0)
})

test('isAnnotatableBlock covers exactly the text block kinds', () => {
  for (const kind of ['heading', 'paragraph', 'quote', 'list', 'table']) {
    assert.equal(isAnnotatableBlock({ kind }), true, kind)
  }
  for (const kind of ['code', 'formula', 'figure', 'page', 'rule', 'unknown']) {
    assert.equal(isAnnotatableBlock({ kind }), false, kind)
  }
  assert.equal(isAnnotatableBlock(null), false)
})

test('newAnnotationId returns unique a-prefixed ids', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i += 1) {
    const id = newAnnotationId()
    assert.match(id, /^a[0-9a-f]{16}$/)
    assert.ok(!ids.has(id))
    ids.add(id)
  }
})
