/**
 * Annotation re-anchoring after reparse tests (port of
 * `.agents/baseline-1.0.0/test/unit/reanchor.test.mjs`).
 *
 * Covers the pure locator, the single-annotation re-anchor, the pure
 * `ReanchorHook` document pass and the frozen store wrapper.
 */

import { test, expect } from 'vitest'

import {
  STALE_REASON_NO_QUOTE,
  STALE_REASON_NOT_FOUND,
  buildAnchorBlocks,
  locateQuoteInText,
  normalizeAnchorText,
  reanchorAnnotation,
  reanchorAnnotations,
  reanchorDocumentAnnotations,
  type AnchorBlock,
  type ReanchorStore,
} from '../../src/shared/annotate/reanchor.ts'
import type { Annotation } from '../../src/shared/model.ts'

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

/** Block whose plain text includes `text` (fails when absent). */
function blockByText(text: string): AnchorBlock {
  const block = blocks.find((candidate) => candidate.plainText.includes(text))
  if (block === undefined) throw new Error(`no block contains ${JSON.stringify(text)}`)
  return block
}

/** Annotations are persisted JSON; tests build minimal records. */
function annotationOf(input: Record<string, unknown>): Annotation {
  return {
    id: String(input.id ?? 'a0'),
    blockKey: String(input.blockKey ?? ''),
    start: Number(input.start ?? 0),
    end: Number(input.end ?? 0),
    quote: String(input.quote ?? ''),
    color: 'yellow',
    ...input,
  } as Annotation
}

test('buildAnchorBlocks yields stable keys and plain text for a parse', () => {
  expect(blocks.length).toBeGreaterThanOrEqual(4)
  for (const block of blocks) {
    expect(block.key).toMatch(/^b\d+:[0-9a-f]{8}$/)
    expect(typeof block.plainText).toBe('string')
    expect(block.index).toBe(blocks.indexOf(block))
  }
  const target = blockByText('block reference structure')
  expect(target).toBeDefined()
})

test('locateQuoteInText: exact first, then whitespace-insensitive fallback', () => {
  const text = 'The   block\nreference structure retrieves embeddings.'
  expect(locateQuoteInText(text, 'block reference')).toEqual({ start: 6, end: 21 })
  const loose = locateQuoteInText(text, 'block reference')
  expect(loose).not.toBeNull()
  const spaced = locateQuoteInText('one   two\nthree', 'two three')
  expect(spaced).not.toBeNull()
  if (spaced === null) return
  expect('one   two\nthree'.slice(spaced.start, spaced.end)).toBe('two\nthree')
  expect(locateQuoteInText('abc', 'zzz')).toBeNull()
  expect(normalizeAnchorText('  a\n b  ')).toBe('a b')
})

test('reanchorAnnotation keeps a valid annotation untouched', () => {
  const block = blockByText('block reference structure')
  const start = block.plainText.indexOf('block reference')
  const annotation = annotationOf({
    id: 'a1',
    blockKey: block.key,
    start,
    end: start + 'block reference'.length,
    quote: 'block reference',
    note: 'n',
    color: 'sage',
    origin: 'ai',
    aspect: 'method',
  })
  const next = reanchorAnnotation(annotation, blocks)
  expect(next).toBe(annotation) // same object when nothing changed
})

test('reanchorAnnotation moves offsets inside the same block', () => {
  const block = blockByText('block reference structure')
  const annotation = annotationOf({
    id: 'a2',
    blockKey: block.key,
    start: 0,
    end: 5,
    quote: 'embeddings',
    note: 'n',
    color: 'sky',
  })
  const next = reanchorAnnotation(annotation, blocks)
  expect(next.blockKey).toBe(block.key)
  expect(next.stale).toBe(false)
  expect(next.reanchored).toBe(true)
  expect(block.plainText.slice(next.start, next.end)).toBe('embeddings')
})

test('reanchorAnnotation relocates a quote into a new block (reparse changed keys)', () => {
  const block = blockByText('duplicate backtracking')
  const annotation = annotationOf({
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
  })
  const next = reanchorAnnotation(annotation, blocks)
  expect(next.stale).toBe(false)
  expect(next.reanchored).toBe(true)
  expect(next.blockKey).toBe(block.key)
  expect(block.plainText.slice(next.start, next.end)).toBe('duplicate backtracking')
  expect(next.origin).toBe('ai')
  expect(next.aspect).toBe('method')
  expect(next.chatId).toBe('doc:abc')
})

test('reanchorAnnotation prefers the block nearest the old page for repeated quotes', () => {
  const text = '# T\n\nsame phrase here.\n\nmiddle.\n\nsame phrase here.'
  const list = buildAnchorBlocks(text)
  const second = list[list.length - 1]
  expect(second).toBeDefined()
  if (second === undefined) return
  const annotation = annotationOf({ id: 'a4', blockKey: second.key, start: 0, end: 4, quote: 'same phrase' })
  const next = reanchorAnnotation(annotation, list)
  expect(next.blockKey).toBe(second.key)
  expect(second.plainText.slice(next.start, next.end)).toBe('same phrase')
})

test('reanchorAnnotation marks an annotation stale when the quote disappeared', () => {
  const annotation = annotationOf({
    id: 'a5',
    blockKey: 'b2:00000000',
    start: 3,
    end: 9,
    quote: 'text that no longer exists',
    note: 'keep me',
    color: 'rose',
    origin: 'ai',
    aspect: 'limitation',
  })
  const next = reanchorAnnotation(annotation, blocks)
  expect(next.stale).toBe(true)
  expect(next.staleReason).toBe(STALE_REASON_NOT_FOUND)
  expect(next.note).toBe('keep me')
  expect(next.blockKey).toBe(annotation.blockKey) // original target retained for the UI
  expect(next.reanchored).toBeUndefined()

  const noQuote = reanchorAnnotation(annotationOf({ id: 'a6', blockKey: 'b0:11111111', start: 0, end: 3, quote: '' }), blocks)
  expect(noQuote.stale).toBe(true)
  expect(noQuote.staleReason).toBe(STALE_REASON_NO_QUOTE)
})

test('reanchorAnnotation clears stale flags once the quote is found again', () => {
  const block = blockByText('Experiments show')
  const annotation = annotationOf({
    id: 'a7',
    blockKey: 'b9:11111111',
    start: 0,
    end: 4,
    quote: 'Experiments show',
    stale: true,
    staleReason: STALE_REASON_NOT_FOUND,
    color: 'sky',
  })
  const next = reanchorAnnotation(annotation, blocks)
  expect(next.stale).toBe(false)
  expect(next.blockKey).toBe(block.key)
})

/** In-memory store for the wrapper test. */
function fakeStore(markdownText: string, items: Annotation[]): ReanchorStore & {
  state: { items: Annotation[]; saved: { version: 1; items: readonly unknown[] } | null }
} {
  const state: { items: Annotation[]; saved: { version: 1; items: readonly unknown[] } | null } = {
    items: items.map((item) => ({ ...item })),
    saved: null,
  }
  return {
    state,
    async readMarkdown() {
      return { markdown: markdownText, contentList: [] }
    },
    async loadAnnotations() {
      return { items: state.items }
    },
    async saveAnnotations(_documentId, payload) {
      state.saved = payload
      state.items = payload.items.map((item) => ({ ...(item as Annotation) }))
    },
  }
}

test('reanchorAnnotations persists updates and reports the summary', async () => {
  const block = blockByText('block reference structure')
  const start = block.plainText.indexOf('block reference')
  const store = fakeStore(markdown, [
    annotationOf({ id: 'ok', blockKey: block.key, start, end: start + 15, quote: 'block reference', color: 'sage', note: '' }),
    annotationOf({ id: 'moved', blockKey: 'b1:ffffffff', start: 0, end: 5, quote: 'duplicate backtracking', color: 'sky', note: '' }),
    annotationOf({ id: 'lost', blockKey: 'b2:ffffffff', start: 0, end: 5, quote: 'gone forever', color: 'rose', note: 'keep' }),
  ])
  const summary = await reanchorAnnotations({ store, documentId: 'doc-1' })
  expect(summary.total).toBe(3)
  expect(summary.reanchored).toBe(1)
  expect(summary.stale).toBe(1)
  expect(store.state.saved).not.toBeNull()
  const saved = (store.state.saved?.items ?? []) as Annotation[]
  expect(saved.find((item) => item.id === 'moved')?.reanchored).toBe(true)
  expect(saved.find((item) => item.id === 'lost')?.stale).toBe(true)
  expect(saved.find((item) => item.id === 'lost')?.note).toBe('keep')
})

test('reanchorAnnotations is a no-op without annotations or store', async () => {
  const empty = fakeStore(markdown, [])
  const summary = await reanchorAnnotations({ store: empty, documentId: 'doc-1' })
  expect(summary).toEqual({ total: 0, changed: 0, reanchored: 0, stale: 0 })
  expect(empty.state.saved).toBeNull()
  await expect(reanchorAnnotations({})).resolves.toEqual({ total: 0, changed: 0, reanchored: 0, stale: 0 })
})

// ---------------------------------------------------------------------------
// 1.0.0 extension: the pure hook the parse manager wires into contracts.ReanchorHook.
// ---------------------------------------------------------------------------

test('reanchorDocumentAnnotations is the pure ReanchorHook-shaped entry point', () => {
  const block = blockByText('block reference structure')
  const start = block.plainText.indexOf('block reference')
  const annotations = [
    annotationOf({ id: 'keep', blockKey: block.key, start, end: start + 15, quote: 'block reference' }),
    annotationOf({ id: 'move', blockKey: 'b9:deadbeef', start: 0, end: 5, quote: 'duplicate backtracking' }),
    annotationOf({ id: 'lost', blockKey: 'b9:deadbeef', start: 0, end: 5, quote: 'gone forever' }),
  ]
  const next = reanchorDocumentAnnotations({ documentId: 'doc-1', annotations, markdown, contentList: null })
  expect(next.length).toBe(3)
  expect(next[0]).toBe(annotations[0]) // unchanged annotations keep identity
  expect(next[1]?.blockKey).toBe(blockByText('duplicate backtracking').key)
  expect(next[1]?.reanchored).toBe(true)
  expect(next[2]?.stale).toBe(true)
  expect(next[2]?.staleReason).toBe(STALE_REASON_NOT_FOUND)
  // Pure: the input list/objects are not mutated.
  expect(annotations[1]?.reanchored).toBeUndefined()
  expect(annotations[2]?.stale).toBeUndefined()
})

test('reanchorDocumentAnnotations uses page marks when a content list is available', () => {
  const next = reanchorDocumentAnnotations({
    annotations: [],
    markdown: 'page one text\n\npage two text',
    contentList: [
      { type: 'text', text: 'page one text', page_idx: 0 },
      { type: 'text', text: 'page two text', page_idx: 1 },
    ],
  })
  expect(next).toEqual([])
  const marked = buildAnchorBlocks('page one text\n\npage two text', [
    { type: 'text', text: 'page one text', page_idx: 0 },
    { type: 'text', text: 'page two text', page_idx: 1 },
  ])
  expect(marked.map((block) => block.page)).toEqual([1, 2])
})
