/**
 * Annotation re-anchoring after reparse (bug: AI annotations lost their
 * targets when a document was parsed again). Covers the pure locator and the
 * store wrapper used by the parse manager.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_REASON_NO_QUOTE,
  STALE_REASON_NOT_FOUND,
  buildAnchorBlocks,
  locateQuoteInText,
  normalizeAnchorText,
  reanchorAnnotation,
  reanchorAnnotations,
} from '../../lib/reanchor.js'

const markdown = [
  '# BEE',
  '',
  'BEE reduces duplicate backtracking with block-separator decomposition.',
  '',
  'The block reference structure retrieves embeddings whenever redundancies are identified.',
  '',
  'Experiments show large speedups on subgraph matching.',
].join('\n')

const blocks = buildAnchorBlocks(markdown)

function blockByText(text) {
  return blocks.find((block) => block.plainText.includes(text))
}

test('buildAnchorBlocks yields stable keys and plain text for a parse', () => {
  assert.ok(blocks.length >= 4)
  for (const block of blocks) {
    assert.match(block.key, /^b\d+:[0-9a-f]{8}$/)
    assert.equal(typeof block.plainText, 'string')
  }
  const target = blockByText('block reference structure')
  assert.ok(target)
})

test('locateQuoteInText: exact first, then whitespace-insensitive fallback', () => {
  const text = 'The   block\nreference structure retrieves embeddings.'
  assert.deepEqual(locateQuoteInText(text, 'block reference'), { start: 6, end: 21 })
  const loose = locateQuoteInText(text, 'block reference')
  assert.ok(loose)
  const spaced = locateQuoteInText('one   two\nthree', 'two three')
  assert.ok(spaced)
  assert.equal('one   two\nthree'.slice(spaced.start, spaced.end), 'two\nthree')
  assert.equal(locateQuoteInText('abc', 'zzz'), null)
  assert.equal(normalizeAnchorText('  a\n b  '), 'a b')
})

test('reanchorAnnotation keeps a valid annotation untouched', () => {
  const block = blockByText('block reference structure')
  const annotation = {
    id: 'a1',
    blockKey: block.key,
    start: block.plainText.indexOf('block reference'),
    end: block.plainText.indexOf('block reference') + 'block reference'.length,
    quote: 'block reference',
    note: 'n',
    color: 'sage',
    origin: 'ai',
    aspect: 'method',
  }
  const next = reanchorAnnotation(annotation, blocks)
  assert.equal(next, annotation, 'same object when nothing changed')
})

test('reanchorAnnotation moves offsets inside the same block', () => {
  const block = blockByText('block reference structure')
  const annotation = {
    id: 'a2',
    blockKey: block.key,
    start: 0,
    end: 5,
    quote: 'embeddings',
    note: 'n',
    color: 'sky',
  }
  const next = reanchorAnnotation(annotation, blocks)
  assert.equal(next.blockKey, block.key)
  assert.equal(next.stale, false)
  assert.equal(next.reanchored, true)
  assert.equal(block.plainText.slice(next.start, next.end), 'embeddings')
})

test('reanchorAnnotation relocates a quote into a new block (reparse changed keys)', () => {
  const block = blockByText('duplicate backtracking')
  const annotation = {
    id: 'a3',
    blockKey: 'b1:deadbeef', // stale key from the previous parse
    start: 999,
    end: 1004,
    quote: 'duplicate backtracking',
    note: 'AI claim',
    color: 'sage',
    origin: 'ai',
    aspect: 'method',
    chatId: 'doc:abc',
  }
  const next = reanchorAnnotation(annotation, blocks)
  assert.equal(next.stale, false)
  assert.equal(next.reanchored, true)
  assert.equal(next.blockKey, block.key)
  assert.equal(block.plainText.slice(next.start, next.end), 'duplicate backtracking')
  assert.equal(next.origin, 'ai', 'provenance survives')
  assert.equal(next.aspect, 'method')
  assert.equal(next.chatId, 'doc:abc')
})

test('reanchorAnnotation prefers the block nearest the old page for repeated quotes', () => {
  const text = '# T\n\nsame phrase here.\n\nmiddle.\n\nsame phrase here.'
  const list = buildAnchorBlocks(text)
  const second = list[list.length - 1]
  const annotation = { id: 'a4', blockKey: second.key, start: 0, end: 4, quote: 'same phrase', note: '', color: 'yellow' }
  const next = reanchorAnnotation(annotation, list)
  assert.equal(next.blockKey, second.key)
  assert.equal(second.plainText.slice(next.start, next.end), 'same phrase')
})

test('reanchorAnnotation marks an annotation stale when the quote disappeared', () => {
  const annotation = {
    id: 'a5',
    blockKey: 'b2:00000000',
    start: 3,
    end: 9,
    quote: 'text that no longer exists',
    note: 'keep me',
    color: 'rose',
    origin: 'ai',
    aspect: 'limitation',
  }
  const next = reanchorAnnotation(annotation, blocks)
  assert.equal(next.stale, true)
  assert.equal(next.staleReason, STALE_REASON_NOT_FOUND)
  assert.equal(next.note, 'keep me')
  assert.equal(next.blockKey, annotation.blockKey, 'original target is retained for the UI')
  assert.equal(next.reanchored, undefined)

  const noQuote = reanchorAnnotation({ id: 'a6', blockKey: 'b0:11111111', start: 0, end: 3, quote: '' }, blocks)
  assert.equal(noQuote.stale, true)
  assert.equal(noQuote.staleReason, STALE_REASON_NO_QUOTE)
})

test('reanchorAnnotation clears stale flags once the quote is found again', () => {
  const block = blockByText('Experiments show')
  const annotation = {
    id: 'a7',
    blockKey: 'b9:11111111',
    start: 0,
    end: 4,
    quote: 'Experiments show',
    stale: true,
    staleReason: STALE_REASON_NOT_FOUND,
    color: 'sky',
  }
  const next = reanchorAnnotation(annotation, blocks)
  assert.equal(next.stale, false)
  assert.equal(next.blockKey, block.key)
})

/** In-memory store for the wrapper test. */
function fakeStore(markdownText, items) {
  const state = { items: items.map((item) => ({ ...item })), saved: null }
  return {
    state,
    async readMarkdown() { return { markdown: markdownText, contentList: [] } },
    async loadAnnotations() { return { version: 1, items: state.items } },
    async saveAnnotations(_id, payload) {
      state.saved = payload
      state.items = payload.items.map((item) => ({ ...item }))
    },
  }
}

test('reanchorAnnotations persists updates and reports the summary', async () => {
  const block = blockByText('block reference structure')
  const store = fakeStore(markdown, [
    { id: 'ok', blockKey: block.key, start: block.plainText.indexOf('block reference'), end: block.plainText.indexOf('block reference') + 15, quote: 'block reference', color: 'sage', note: '' },
    { id: 'moved', blockKey: 'b1:ffffffff', start: 0, end: 5, quote: 'duplicate backtracking', color: 'sky', note: '' },
    { id: 'lost', blockKey: 'b2:ffffffff', start: 0, end: 5, quote: 'gone forever', color: 'rose', note: 'keep' },
  ])
  const summary = await reanchorAnnotations({ store, documentId: 'doc-1' })
  assert.equal(summary.total, 3)
  assert.equal(summary.reanchored, 1)
  assert.equal(summary.stale, 1)
  assert.ok(store.state.saved, 'save called when something changed')
  const saved = store.state.saved.items
  assert.equal(saved.find((item) => item.id === 'moved').reanchored, true)
  assert.equal(saved.find((item) => item.id === 'lost').stale, true)
  assert.equal(saved.find((item) => item.id === 'lost').note, 'keep')
})

test('reanchorAnnotations is a no-op without annotations or store', async () => {
  const empty = fakeStore(markdown, [])
  const summary = await reanchorAnnotations({ store: empty, documentId: 'doc-1' })
  assert.deepEqual(summary, { total: 0, changed: 0, reanchored: 0, stale: 0 })
  assert.equal(empty.state.saved, null)
  assert.doesNotThrow(() => reanchorAnnotations({}))
})
