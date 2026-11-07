/**
 * Robustness / fuzz-ish tests (port of
 * `.agents/baseline-1.0.0/test/reader/robustness.test.mjs`): pathological
 * MinerU markdown and content lists must terminate quickly, never throw, and
 * always produce structurally sane blocks. Also covers helper paths that must
 * tolerate junk input.
 */

import { test, expect } from 'vitest'

import {
  appendPageMarks,
  blockKey,
  fnv1a,
  mdStats,
  parseInline,
  parseMarkdown,
  plainTextOfBlock,
  runsText,
} from '../../src/shared/markdown/parse.ts'
import { groupAnnotations, isAnnotatableBlock, overlayRuns } from '../../src/shared/annotate/highlight.ts'
import type { Block, PaperModel } from '../../src/shared/markdown/model.ts'
import { assertModelIntegrity } from './helpers.ts'

const BLOCK_KINDS = new Set<string>([
  'heading', 'paragraph', 'list', 'quote', 'code', 'formula', 'figure', 'page', 'table', 'rule',
])

/** Parse and assert the model is structurally sane and fast enough. */
function parseSane(input: string | null | undefined, budgetMs = 4000): PaperModel {
  const started = Date.now()
  const model = parseMarkdown(input)
  const elapsed = Date.now() - started
  expect(elapsed, `parse took ${elapsed}ms (budget ${budgetMs}ms)`).toBeLessThan(budgetMs)
  assertModelIntegrity(model)
  for (const block of model.blocks) {
    expect(BLOCK_KINDS.has(block.kind), `unexpected kind ${block.kind}`).toBe(true)
  }
  return model
}

test('unclosed fences, quotes and formulas terminate without throwing', () => {
  const cases = [
    '```',
    '```js\nconst a = 1',
    '~~~\nunclosed tilde fence',
    '>',
    '> quoted forever',
    '$$',
    '$$\nunclosed formula',
    '\\[',
    '<table><tr><td>unclosed table',
    '| header |\n| --- |\n| row',
  ]
  for (const input of cases) {
    const model = parseSane(input)
    expect(Array.isArray(model.blocks)).toBe(true)
    // Unclosed fenced code is safely consumed as a code block to EOF.
    if (input.startsWith('```js')) expect(model.blocks[0]?.kind).toBe('code')
  }
})

test('lone and repeated inline markers do not hang or corrupt output', () => {
  const cases = [
    '*******',
    '~~~~~',
    '`````',
    '$$$$$',
    '\\\\\\\\\\\\',
    '((((()))))',
    '[[[[[[[[',
    ']]]]]]]]',
    '![](  )',
    '![](',
    '~~`~~`',
    '*_*_*_*_',
    '<b><i><em></b>',
    '<a href="unclosed',
    '<img src=',
    '&amp;&lt;&gt;&quot;&#39;&nbsp;&#xZZ;',
    'text with \u0000 null and \uFEFF BOM in the middle',
  ]
  for (const input of cases) parseSane(input)
})

test('pathological emphasis runs are bounded', () => {
  parseSane('*a '.repeat(2000))
  parseSane('**a '.repeat(2000))
  parseSane('_a '.repeat(2000))
  parseSane(('*'.repeat(60)) + 'x' + ('*'.repeat(60)))
  expect(parseInline('a * b * c * d').length).toBe(1)
})

test('long bracket/backtick runs are bounded', () => {
  parseSane('['.repeat(4000))
  parseSane(']('.repeat(2000))
  parseSane('!['.repeat(2000))
  parseSane('`'.repeat(5000))
  parseSane(('`'.repeat(5000)) + 'text')
})

test('a 100k-character paragraph parses as one block', () => {
  const paragraph = 'lorem ipsum dolor sit amet '.repeat(4000)
  const model = parseSane(paragraph)
  expect(model.blocks.length).toBe(1)
  expect(model.blocks[0]?.kind).toBe('paragraph')
  expect(model.blocks[0]?.plainText.length).toBeGreaterThanOrEqual(100000)
  expect(model.stats.words).toBeGreaterThanOrEqual(20000)
})

test('a table with 2000 rows parses completely and quickly', () => {
  const rows: string[] = []
  for (let index = 0; index < 2000; index += 1) {
    rows.push(`<tr><td>row ${index}</td><td>${index}</td><td>v${index}</td><td>x</td><td>y</td></tr>`)
  }
  const html = '<table><thead><tr><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table>'
  const model = parseSane(html)
  const table = model.blocks.find((block) => block.kind === 'table')
  expect(table).toBeDefined()
  if (table === undefined || table.kind !== 'table') return
  expect(table.rows.length).toBe(2000)
  expect(table.head.length).toBe(5)
  expect(table.plainText).toContain('row 1999')
})

test('a pipe table with 1000 rows parses completely', () => {
  const lines = ['| a | b | c |', '| --- | --- | --- |']
  for (let index = 0; index < 1000; index += 1) lines.push(`| ${index} | v${index} | w${index} |`)
  const model = parseSane(lines.join('\n'))
  const table = model.blocks.find((block) => block.kind === 'table')
  expect(table).toBeDefined()
  if (table === undefined || table.kind !== 'table') return
  expect(table.rows.length).toBe(1000)
})

test('deeply nested list markers flatten into a single item', () => {
  const lines: string[] = []
  for (let index = 0; index < 200; index += 1) lines.push('  '.repeat(index) + `- item ${index}`)
  const model = parseSane(lines.join('\n'))
  const list = model.blocks.find((block) => block.kind === 'list')
  expect(list).toBeDefined()
  if (list === undefined || list.kind !== 'list') return
  expect(list.items.length).toBe(1)
  expect(list.items[0]?.plainText).toMatch(/item 0/)
  expect(list.items[0]?.plainText).toMatch(/item 199/)
})

test('deeply nested blockquote markers flatten to a quote', () => {
  const model = parseSane('> '.repeat(500) + 'deep quote')
  expect(model.blocks[0]?.kind).toBe('quote')
  expect(model.blocks[0]?.plainText).toBe('deep quote')
})

test('very long headings and lines terminate', () => {
  parseSane('# ' + 'heading '.repeat(5000))
  parseSane('- ' + 'item '.repeat(5000))
  parseSane('| ' + 'cell '.repeat(3000) + ' |')
})

test('seeded fuzz: random markdown-ish inputs always yield sane models', () => {
  const alphabet = '#*_-`$~[]()<>!|\\/ \nabcdefghij0123456789.:;,\'"=+'
  let seed = 0x5eed1234
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const started = Date.now()
  for (let run = 0; run < 200; run += 1) {
    const length = 10 + Math.floor(random() * 180)
    let input = ''
    for (let index = 0; index < length; index += 1) {
      input += alphabet[Math.floor(random() * alphabet.length)] ?? ''
    }
    const model = parseMarkdown(input)
    assertModelIntegrity(model)
    for (const block of model.blocks) expect(BLOCK_KINDS.has(block.kind)).toBe(true)
  }
  expect(Date.now() - started, 'fuzz corpus should stay fast').toBeLessThan(8000)
})

test('appendPageMarks tolerates junk content lists and many entries', () => {
  const model = parseSane(Array.from({ length: 60 }, (_value, index) => `paragraph number ${index}`).join('\n\n'))
  const contentList: unknown[] = [null, undefined, 42, 'nope', {}, { type: 'image' }]
  for (let index = 0; index < 60; index += 1) {
    contentList.push({
      type: 'text',
      text: `paragraph number ${index}`,
      page_idx: Math.floor(index / 10),
    })
  }
  contentList.push({ type: 'text', text: 'nonexistent text', page_idx: 99 })
  const marked = appendPageMarks(model, contentList)
  assertModelIntegrity(marked)
  expect(marked.blocks.filter((block) => block.kind !== 'page').length).toBe(model.blocks.length)
  const pages = marked.blocks.filter((block) => block.kind === 'page')
  expect(pages.length).toBeGreaterThanOrEqual(6)
  for (const block of pages) expect(Number.isInteger(block.page) && block.page >= 1).toBe(true)
})

test('helper functions tolerate junk input', () => {
  expect(fnv1a(null)).toBe(fnv1a(''))
  expect(fnv1a(undefined)).toBe(fnv1a(''))
  expect(runsText([null, undefined, 3, { text: 'ab' }] as never)).toBe('ab')
  expect(runsText('not-an-array' as never)).toBe('')
  expect(mdStats([null, {}, { kind: 'heading' }] as never)).toEqual({ blocks: 3, headings: 1, chars: 0, words: 0 })
  expect(overlayRuns([], null)).toEqual([])
  expect(groupAnnotations(undefined).size).toBe(0)
  expect(isAnnotatableBlock('nope')).toBe(false)
  expect(plainTextOfBlock(undefined)).toBe('')
  expect(parseInline(null)).toEqual([])
  expect(parseInline(undefined)).toEqual([])
})

test('block helpers tolerate junk (blockKey/runsText/mdStats)', () => {
  expect(blockKey(0, '')).toMatch(/^b0:[0-9a-f]{8}$/)
  const junk: Block[] = []
  expect(mdStats(junk)).toEqual({ blocks: 0, headings: 0, chars: 0, words: 0 })
  expect(runsText([])).toBe('')
})

test('NUL bytes are preserved verbatim in block plain text (real MinerU PDF extractions contain them)', () => {
  // markdown-it's stock normalize rule replaces NUL with U+FFFD; the parser
  // overrides it because block keys hash the verbatim plain text (annotations
  // from 1.0.0 must keep resolving on real libraries).
  const model = parseMarkdown('L(G2[S]) \u0000 L(H)')
  expect(model.blocks[0]?.plainText).toBe('L(G2[S]) \u0000 L(H)')
  expect(model.blocks[0]?.key).toBe(`b0:${fnv1a('L(G2[S]) \u0000 L(H)')}`)
})
