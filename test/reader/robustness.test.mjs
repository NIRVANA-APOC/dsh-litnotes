/**
 * Robustness / fuzz-ish tests: pathological MinerU markdown and content lists
 * must terminate quickly, never throw, and always produce structurally sane
 * blocks. Also covers helper paths that must tolerate junk input.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reader, assertModelIntegrity } from './helpers.mjs'

const {
  parseMarkdown,
  appendPageMarks,
  mdStats,
  parseInline,
  fnv1a,
  runsText,
  overlayRuns,
  groupAnnotations,
  isAnnotatableBlock,
  plainTextOfBlock,
} = reader

const BLOCK_KINDS = new Set(['heading', 'paragraph', 'list', 'quote', 'code', 'formula', 'figure', 'page', 'table', 'rule'])

function parseSane(input, budgetMs = 4000) {
  const started = Date.now()
  const model = parseMarkdown(input)
  const elapsed = Date.now() - started
  assert.ok(elapsed < budgetMs, `parse took ${elapsed}ms (budget ${budgetMs}ms)`)
  assertModelIntegrity(assert, model)
  for (const block of model.blocks) assert.ok(BLOCK_KINDS.has(block.kind), `unexpected kind ${block.kind}`)
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
    assert.ok(Array.isArray(model.blocks))
    // Unclosed fenced code is safely consumed as a code block to EOF.
    if (input.startsWith('```js')) assert.equal(model.blocks[0].kind, 'code')
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
  assert.equal(parseInline('a * b * c * d').length, 1)
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
  assert.equal(model.blocks.length, 1)
  assert.equal(model.blocks[0].kind, 'paragraph')
  assert.ok(model.blocks[0].plainText.length >= 100000)
  assert.ok(model.stats.words >= 20000)
})

test('a table with 2000 rows parses completely and quickly', () => {
  const rows = []
  for (let i = 0; i < 2000; i += 1) {
    rows.push(`<tr><td>row ${i}</td><td>${i}</td><td>v${i}</td><td>x</td><td>y</td></tr>`)
  }
  const html = '<table><thead><tr><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table>'
  const model = parseSane(html)
  const table = model.blocks.find((block) => block.kind === 'table')
  assert.ok(table)
  assert.equal(table.rows.length, 2000)
  assert.equal(table.head.length, 5)
  assert.ok(table.plainText.includes('row 1999'))
})

test('a pipe table with 1000 rows parses completely', () => {
  const lines = ['| a | b | c |', '| --- | --- | --- |']
  for (let i = 0; i < 1000; i += 1) lines.push(`| ${i} | v${i} | w${i} |`)
  const model = parseSane(lines.join('\n'))
  const table = model.blocks.find((block) => block.kind === 'table')
  assert.ok(table)
  assert.equal(table.rows.length, 1000)
})

test('deeply nested list markers flatten into a single item', () => {
  const lines = []
  for (let i = 0; i < 200; i += 1) lines.push('  '.repeat(i) + `- item ${i}`)
  const model = parseSane(lines.join('\n'))
  const list = model.blocks.find((block) => block.kind === 'list')
  assert.ok(list)
  assert.equal(list.items.length, 1)
  assert.match(list.items[0].plainText, /item 0/)
  assert.match(list.items[0].plainText, /item 199/)
})

test('deeply nested blockquote markers flatten to a quote', () => {
  const model = parseSane('> '.repeat(500) + 'deep quote')
  assert.equal(model.blocks[0].kind, 'quote')
  assert.equal(model.blocks[0].plainText, 'deep quote')
})

test('very long headings and lines terminate', () => {
  parseSane('# ' + 'heading '.repeat(5000))
  parseSane('- ' + 'item '.repeat(5000))
  parseSane('| ' + 'cell '.repeat(3000) + ' |')
})

test('seeded fuzz: random markdown-ish inputs always yield sane models', () => {
  const alphabet = '#*_-`$~[]()<>!|\\/ \nabcdefghij0123456789.:;,\'"=+'
  let seed = 0x5eed1234
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const started = Date.now()
  for (let run = 0; run < 200; run += 1) {
    const length = 10 + Math.floor(random() * 180)
    let input = ''
    for (let i = 0; i < length; i += 1) input += alphabet[Math.floor(random() * alphabet.length)]
    const model = parseMarkdown(input)
    assertModelIntegrity(assert, model)
    for (const block of model.blocks) assert.ok(BLOCK_KINDS.has(block.kind))
  }
  assert.ok(Date.now() - started < 8000, 'fuzz corpus should stay fast')
})

test('appendPageMarks tolerates junk content lists and many entries', () => {
  const model = parseSane(Array.from({ length: 60 }, (_, i) => `paragraph number ${i}`).join('\n\n'))
  const contentList = [null, undefined, 42, 'nope', {}, { type: 'image' }]
  for (let i = 0; i < 60; i += 1) {
    contentList.push({
      type: 'text',
      text: `paragraph number ${i}`,
      page_idx: Math.floor(i / 10),
    })
  }
  contentList.push({ type: 'text', text: 'nonexistent text', page_idx: 99 })
  const marked = appendPageMarks(model, contentList)
  assertModelIntegrity(assert, marked)
  assert.equal(marked.blocks.filter((block) => block.kind !== 'page').length, model.blocks.length)
  const pages = marked.blocks.filter((block) => block.kind === 'page')
  assert.ok(pages.length >= 6)
  for (const block of pages) {
    assert.ok(Number.isInteger(block.page) && block.page >= 1)
  }
})

test('helper functions tolerate junk input', () => {
  assert.equal(fnv1a(null), fnv1a(''))
  assert.equal(runsText([null, undefined, 3, { text: 'ab' }]), 'ab')
  assert.equal(runsText('not-an-array'), '')
  assert.deepEqual(mdStats([null, {}, { kind: 'heading' }]), { blocks: 3, headings: 1, chars: 0, words: 0 })
  assert.deepEqual(overlayRuns([], null), [])
  assert.equal(groupAnnotations(undefined).size, 0)
  assert.equal(isAnnotatableBlock('nope'), false)
  assert.equal(plainTextOfBlock(undefined), '')
  assert.deepEqual(parseInline(null), [])
  assert.deepEqual(parseInline(undefined), [])
})
