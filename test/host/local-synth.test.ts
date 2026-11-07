/**
 * Unit tests for the local artifact synthesizer
 * (`src/host/parse/local/synth.ts`).
 *
 * The synthesizer is the contract bridge between the raw local extractors and
 * the reading desk: `markdown` must parse into exactly one reader block per
 * `content_list.json` entry (otherwise page-mark alignment is lost), and escaped
 * prose must round-trip to its original plain text.
 *
 * Ported from the frozen `test/unit/local-synth.test.mjs`; the reader parser is
 * the 2.0 shared model (`src/shared/markdown/parse.ts`).
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import {
  DEFAULT_MAX_PARAGRAPH_CHARS,
  HARD_MAX_PARAGRAPH_CHARS,
  escapeMarkdownText,
  synthLocalDocument,
} from '../../src/host/parse/local/synth.ts'
import { WireError } from '../../src/host/wire.ts'

/** The canonical page-block input used by several tests. */
const PAGES = [
  [
    { kind: 'heading', level: 1, text: 'Simple Title' },
    { kind: 'paragraph', text: 'Hello world.' },
  ],
  [{ kind: 'heading', level: 2, text: 'Details' }],
  [],
  [{ kind: 'paragraph', text: 'Last page.' }],
]

/** Assert one thunk throws a WireError with `code`/`status`. */
function assertThrowsWire(fn: () => unknown, code: string, status: number): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof WireError)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  })
}

test('markdown golden: title heading, headings and paragraphs', () => {
  const synth = synthLocalDocument({ pages: PAGES })
  assert.equal(synth.markdown, '# Simple Title\n\nHello world.\n\n## Details\n\nLast page.\n')
  assert.equal(synth.title, 'Simple Title')
  assert.equal(synth.pageCount, 4)
  assert.equal(
    synth.textChars,
    'Simple Title'.length + 'Hello world.'.length + 'Details'.length + 'Last page.'.length,
  )
  assert.deepEqual(synth.warnings, ['no-structure'])
})

test('content list is 1:1 with the parsed markdown blocks', () => {
  const synth = synthLocalDocument({ pages: PAGES })
  const model = parseMarkdown(synth.markdown)
  assert.equal(synth.contentList.length, model.blocks.length)
  for (let index = 0; index < synth.contentList.length; index += 1) {
    const entry = synth.contentList[index]
    const block = model.blocks[index]
    assert.ok(entry !== undefined)
    assert.ok(block !== undefined)
    assert.equal(entry.type, 'text')
    assert.equal(entry.text, block.plainText, `contentList[${index}] must match block plainText`)
    assert.equal(entry.text_level, block.kind === 'heading' ? block.level : 0)
  }
  assert.deepEqual(
    synth.contentList.map((entry) => entry.page_idx),
    [0, 0, 1, 3],
  )
})

test('page_idx is monotonic and clamped to real page indices', () => {
  const synth = synthLocalDocument({
    pages: [
      [{ kind: 'paragraph', text: 'page zero' }],
      [],
      [{ kind: 'heading', level: 2, text: 'page two' }, { kind: 'paragraph', text: 'page two body' }],
    ],
  })
  const indices = synth.contentList.map((entry) => entry.page_idx)
  for (let index = 1; index < indices.length; index += 1) {
    const current = indices[index] ?? 0
    const previous = indices[index - 1] ?? 0
    assert.ok(current >= previous, 'page_idx is non-decreasing')
  }
  assert.deepEqual(indices, [0, 2, 2])
})

test('caller-provided title is materialized as the level-1 heading', () => {
  const synth = synthLocalDocument({
    pages: [[{ kind: 'paragraph', text: 'Body text is here.' }]],
    title: 'Metadata Title',
  })
  assert.equal(synth.title, 'Metadata Title')
  assert.equal(synth.markdown, '# Metadata Title\n\nBody text is here.\n')
  assert.deepEqual(synth.contentList[0], { type: 'text', text: 'Metadata Title', page_idx: 0, text_level: 1 })
})

test('a first-page level-1 heading wins over the caller title', () => {
  const synth = synthLocalDocument({
    pages: [
      [{ kind: 'heading', level: 1, text: 'Extracted Title' }],
      [{ kind: 'paragraph', text: 'Body.' }],
    ],
    title: 'Metadata Title',
  })
  assert.equal(synth.title, 'Extracted Title')
  assert.match(synth.markdown, /^# Extracted Title\n/)
  assert.ok(!synth.markdown.includes('Metadata Title'))
})

test('a title duplicate paragraph is not emitted twice', () => {
  const synth = synthLocalDocument({
    pages: [[{ kind: 'paragraph', text: 'Metadata Title' }, { kind: 'paragraph', text: 'Body text.' }]],
    title: 'Metadata Title',
  })
  assert.equal(synth.markdown, '# Metadata Title\n\nBody text.\n')
  assert.equal(synth.contentList.length, 2)
})

test('long paragraphs split at sentence boundaries into independent blocks', () => {
  const sentences = Array.from({ length: 24 }, (_value, index) => `Sentence number ${index}.`)
  const paragraph = sentences.join(' ')
  const synth = synthLocalDocument({
    pages: [[{ kind: 'paragraph', text: paragraph }]],
    maxParagraphChars: 120,
  })
  assert.ok(synth.contentList.length > 1, 'a long paragraph becomes several entries')
  for (const entry of synth.contentList) {
    assert.equal(typeof entry.text, 'string')
    assert.ok((entry.text ?? '').length <= 240, 'each chunk is bounded')
    assert.match(entry.text ?? '', /[.!?]$/, 'chunks end on a sentence boundary when possible')
  }
  assert.equal(synth.contentList.map((entry) => entry.text).join(' '), paragraph, 'chunks preserve the source text')
  // Every chunk is its own block: no blank-line merge and no dropped text.
  const model = parseMarkdown(synth.markdown)
  assert.equal(model.blocks.length, synth.contentList.length)
  assert.deepEqual(
    model.blocks.map((block) => block.plainText),
    synth.contentList.map((entry) => entry.text),
  )
})

test('blank lines separate chunks instead of merging them', () => {
  const sentences = Array.from({ length: 12 }, () => 'This is one test sentence.')
  const synth = synthLocalDocument({
    pages: [[{ kind: 'paragraph', text: sentences.join(' ') }]],
    maxParagraphChars: 120,
  })
  assert.ok(synth.contentList.length >= 2)
  assert.ok(synth.markdown.includes('\n\n'), 'chunks are separated by a blank line')
})

test('maxParagraphChars is clamped to the hard bound', () => {
  const words = Array.from({ length: 3000 }, (_value, index) => `word${index}`).join(' ')
  const synth = synthLocalDocument({
    pages: [[{ kind: 'paragraph', text: words }]],
    maxParagraphChars: 10 ** 9,
  })
  assert.ok(synth.contentList.length > 1)
  for (const entry of synth.contentList) {
    assert.ok((entry.text ?? '').length <= HARD_MAX_PARAGRAPH_CHARS, 'hard bound applies')
  }
  const unbounded = synthLocalDocument({
    pages: [[{ kind: 'paragraph', text: words }]],
    maxParagraphChars: HARD_MAX_PARAGRAPH_CHARS,
  })
  assert.deepEqual(synth.contentList, unbounded.contentList, 'values above the hard bound are clamped to it')
  const defaulted = synthLocalDocument({ pages: [[{ kind: 'paragraph', text: words }]] })
  const explicitDefault = synthLocalDocument({
    pages: [[{ kind: 'paragraph', text: words }]],
    maxParagraphChars: DEFAULT_MAX_PARAGRAPH_CHARS,
  })
  assert.equal(defaulted.contentList.length, explicitDefault.contentList.length, 'the default bound applies')
  assert.deepEqual(
    defaulted.contentList.map((entry) => (entry.text ?? '').length),
    explicitDefault.contentList.map((entry) => (entry.text ?? '').length),
  )
  assert.equal(DEFAULT_MAX_PARAGRAPH_CHARS, 4000)
  assert.equal(HARD_MAX_PARAGRAPH_CHARS, 8000)
})

test('keepContentList=false keeps the markdown but drops the content list', () => {
  const withList = synthLocalDocument({ pages: PAGES })
  const withoutList = synthLocalDocument({ pages: PAGES, keepContentList: false })
  assert.equal(withoutList.markdown, withList.markdown)
  assert.deepEqual(withoutList.contentList, [])
  assert.equal(withoutList.pageCount, withList.pageCount)
  assert.equal(withoutList.textChars, withList.textChars)
})

test('empty or blank pages throw local-empty-text', () => {
  for (const input of [undefined, {}, { pages: [] }, { pages: [[], [{ text: '   ' }, { text: '' }]] }]) {
    assertThrowsWire(() => synthLocalDocument(input), 'local-empty-text', 422)
  }
})

test('synthesis is deterministic', () => {
  const first = synthLocalDocument({ pages: structuredClone(PAGES), title: 'Stable' })
  const second = synthLocalDocument({ pages: structuredClone(PAGES), title: 'Stable' })
  assert.deepEqual(first, second)
  assert.equal(first.markdown, second.markdown)
  assert.deepEqual(first.contentList, second.contentList)
})

test('heading levels are clamped into the reader 1..4 range', () => {
  const synth = synthLocalDocument({
    pages: [[{ kind: 'heading', level: 0, text: 'Level zero' }, { kind: 'heading', level: 9, text: 'Level nine' }]],
  })
  assert.ok(synth.markdown.includes('# Level zero'))
  assert.ok(synth.markdown.includes('#### Level nine'))
  assert.deepEqual(synth.contentList.map((entry) => entry.text_level), [1, 4])
})

test('escapeMarkdownText keeps prose inert for every markup starter', () => {
  const raw = 'a $ b * c _ d \\ e ` f [ g ] h ( i ) j # k > l | m ~ n & o < p > q { r } s ^ t'
  const escaped = escapeMarkdownText(raw)
  assert.ok(escaped.includes('\\$'), 'dollar is escaped')
  assert.ok(escaped.includes('\\*'), 'asterisk is escaped')
  assert.ok(escaped.includes('\\\\'), 'original backslash is doubled')
  const model = parseMarkdown(escaped)
  assert.equal(model.blocks.length, 1)
  const block = model.blocks[0]
  assert.ok(block !== undefined)
  assert.equal(block.kind, 'paragraph')
  assert.equal(block.plainText, raw)
})

test('escapeMarkdownText prevents block-level markdown structure', () => {
  const cases = [
    '# heading like',
    '> quote like',
    '- list like',
    '* list like',
    '+ list like',
    '1. ordered like',
    '```code```',
    '| a | b |',
    '$$x^2$$',
    '[reference]',
    '~strike~',
  ]
  for (const raw of cases) {
    assert.equal(escapeMarkdownText(raw), escapeMarkdownText(raw), 'escaped once, deterministically')
    const model = parseMarkdown(escapeMarkdownText(raw))
    assert.equal(model.blocks.length, 1, `one paragraph for ${JSON.stringify(raw)}`)
    const block = model.blocks[0]
    assert.ok(block !== undefined)
    assert.equal(block.kind, 'paragraph')
    assert.equal(block.plainText, raw, `plain text round-trips for ${JSON.stringify(raw)}`)
  }
})

test('escapeMarkdownText handles empty and non-string input', () => {
  assert.equal(escapeMarkdownText(undefined), '')
  assert.equal(escapeMarkdownText(null), '')
  assert.equal(escapeMarkdownText(42), '42')
  assert.equal(escapeMarkdownText(''), '')
})

test('escapeMarkdownText defangs link/image shaped prose (plainText round-trips)', () => {
  // Regression: `[label](url)` must render as literal prose so the block plain
  // text still equals the content_list text (page-mark alignment depends on it).
  const cases = [
    '[Appendix A](https://example.com/paper) shows the results.',
    '![img](x.png) is a caption-like line',
    'see [1](note) and 1) item',
    'mix [a](b) + (c) + [d] e',
  ]
  for (const raw of cases) {
    const model = parseMarkdown(escapeMarkdownText(raw))
    assert.equal(model.blocks.length, 1, `one paragraph for ${JSON.stringify(raw)}`)
    const block = model.blocks[0]
    assert.ok(block !== undefined)
    assert.equal(block.kind, 'paragraph')
    assert.equal(block.plainText, raw, `plain text round-trips for ${JSON.stringify(raw)}`)
  }
})
