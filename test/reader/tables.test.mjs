/**
 * Table parsing tests: MinerU HTML tables (colspan/rowspan, inline HTML) and
 * GFM pipe tables (alignment, escaped pipes).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reader, assertModelIntegrity } from './helpers.mjs'

const { parseMarkdown, runsText } = reader

function tableOf(markdown) {
  const block = parseMarkdown(markdown).blocks.find((candidate) => candidate.kind === 'table')
  assert.ok(block, 'expected a table block')
  return block
}

function cellTexts(row) {
  return row.map((cell) => cell.plainText)
}

test('MinerU HTML table: thead/tbody, th header row, colspan and rowspan', () => {
  const table = tableOf([
    '<table><thead>',
    '<tr><th rowspan="2">Model</th><th colspan="2">Recall@20</th><th colspan=2>GFLOPs</th></tr>',
    '<tr><th>10k</th><th>1M</th><th>short</th><th>long</th></tr>',
    '</thead><tbody>',
    '<tr><td>Dense baseline</td><td>72.1</td><td>64.8</td><td>4.2</td><td>4.2</td></tr>',
    '<tr><td>SparseRoute ($k=2$)</td><td>71.9</td><td>64.5</td><td>2.6</td><td>2.6</td></tr>',
    '</tbody></table>',
  ].join('\n'))
  assert.equal(table.head.length, 3)
  assert.deepEqual(table.head.map((cell) => cell.plainText), ['Model', 'Recall@20', 'GFLOPs'])
  assert.deepEqual(table.head.map((cell) => cell.header), [true, true, true])
  assert.deepEqual(table.head.map((cell) => cell.colspan), [1, 2, 2])
  assert.deepEqual(table.head.map((cell) => cell.rowspan), [2, 1, 1])
  assert.equal(table.rows.length, 3)
  assert.deepEqual(cellTexts(table.rows[0]), ['10k', '1M', 'short', 'long'])
  assert.deepEqual(cellTexts(table.rows[2]), ['SparseRoute ($k=2$)', '71.9', '64.5', '2.6', '2.6'])
  // Header cells from the second thead row keep their header flag.
  assert.ok(table.rows[0].every((cell) => cell.header === true))
  assert.ok(table.rows[1].every((cell) => cell.header === false))
  assert.ok(table.plainText.includes('SparseRoute ($k=2$)'))
  assert.equal(table.plainText, runsText(table.runs))
})

test('HTML table without thead: a first row of th cells becomes the head', () => {
  const table = tableOf('<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>')
  assert.deepEqual(table.head.map((cell) => cell.plainText), ['Name', 'Value'])
  assert.equal(table.rows.length, 1)
  assert.deepEqual(cellTexts(table.rows[0]), ['a', '1'])
})

test('HTML table without any header cells uses rows only', () => {
  const table = tableOf('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')
  assert.deepEqual(table.head, [])
  assert.equal(table.rows.length, 2)
  assert.deepEqual(table.rows.map(cellTexts), [['a', 'b'], ['c', 'd']])
})

test('HTML table cells: <br> becomes a space, entities decode, inline tags map to styles', () => {
  const table = tableOf(
    '<table><tr><td>line one<br>line two</td>'
      + '<td><strong>bold</strong> and <em>italic</em></td>'
      + '<td>AT&amp;T &lt;5&gt; &#39;q&#39;</td></tr></table>',
  )
  const row = table.rows[0]
  assert.equal(row[0].plainText, 'line one line two')
  assert.equal(row[1].plainText, 'bold and italic')
  assert.ok(row[1].runs.some((run) => run.strong === true && run.text === 'bold'))
  assert.ok(row[1].runs.some((run) => run.em === true && run.text === 'italic'))
  assert.equal(row[2].plainText, "AT&T <5> 'q'")
})

test('HTML table strips unknown tags while keeping their text', () => {
  const table = tableOf('<table><tr><td><span class="x">kept</span> <unknown-tag>also kept</unknown-tag></td></tr></table>')
  assert.equal(table.rows[0][0].plainText, 'kept also kept')
})

test('HTML table caption is decoded and stripped of tags', () => {
  const table = tableOf('<table><caption>Table 1: <b>Recall</b> &amp; cost</caption><tr><td>1</td></tr></table>')
  assert.equal(table.caption, 'Table 1: Recall & cost')
})

test('table spans are clamped to sane values', () => {
  const table = tableOf('<table><tr><td colspan="0" rowspan="-1">a</td><td colspan="999999">b</td></tr></table>')
  assert.equal(table.rows[0][0].colspan, 1)
  assert.equal(table.rows[0][0].rowspan, 1)
  assert.equal(table.rows[0][1].colspan, 100)
})

test('table cell inline math becomes math runs', () => {
  const table = tableOf('<table><tr><td>SparseRoute ($k=2$)</td><td>$\\lambda=0.01$</td></tr></table>')
  const cell = table.rows[0][0]
  assert.ok(cell.runs.some((run) => run.type === 'math' && run.latex === 'k=2'))
  assert.equal(cell.plainText, 'SparseRoute ($k=2$)')
})

test('unclosed td tags fall back to loose cell parsing', () => {
  const table = tableOf('<table><tr><td>a<td>b<td>c</tr></table>')
  assert.equal(table.rows.length, 1)
  assert.deepEqual(cellTexts(table.rows[0]), ['a', 'b', 'c'])
})

test('GFM pipe table with alignment row', () => {
  const table = tableOf([
    '| Left | Center | Right |',
    '|:-----|:------:|------:|',
    '| a | b | c |',
    '| d | e | f |',
  ].join('\n'))
  assert.deepEqual(table.head.map((cell) => cell.plainText), ['Left', 'Center', 'Right'])
  assert.deepEqual(table.head.map((cell) => cell.align), ['left', 'center', 'right'])
  assert.deepEqual(table.head.map((cell) => cell.header), [true, true, true])
  assert.equal(table.rows.length, 2)
  assert.deepEqual(table.rows.map(cellTexts), [['a', 'b', 'c'], ['d', 'e', 'f']])
  assert.ok(table.rows[0].every((cell) => cell.header === false))
  assert.equal(table.caption, '')
})

test('pipe table rows pad missing cells and drop extra ones', () => {
  const table = tableOf('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')
  assert.deepEqual(table.rows.map(cellTexts), [['1', ''], ['1', '2']])
})

test('pipe tables support escaped pipes and inline markup in cells', () => {
  const table = tableOf('| a | b |\n| --- | --- |\n| x \\| y | **bold** |')
  assert.deepEqual(table.rows[0].map((cell) => cell.plainText), ['x | y', 'bold'])
  assert.ok(table.rows[0][1].runs.some((run) => run.strong === true))
})

test('a header-looking line without a valid delimiter row stays a paragraph', () => {
  const model = parseMarkdown('a | b\n---')
  assert.equal(model.blocks.filter((block) => block.kind === 'table').length, 0)
  assert.equal(model.blocks.filter((block) => block.kind === 'rule').length, 1)
  assertModelIntegrity(assert, model)
})

test('pipe table embedded after a paragraph is parsed as its own block', () => {
  const model = parseMarkdown('intro text\n\n| h |\n| --- |\n| v |')
  assert.equal(model.blocks[0].kind, 'paragraph')
  assert.equal(model.blocks[1].kind, 'table')
  assertModelIntegrity(assert, model)
})

test('a table-only document round-trips the plain text invariant', () => {
  const model = parseMarkdown([
    '## Results',
    '',
    '<table><thead><tr><th>Model</th><th>Score</th></tr></thead>',
    '<tbody><tr><td>&lt;dense&gt;</td><td>0.5</td></tr></tbody></table>',
    '',
    'after',
  ].join('\n'))
  assertModelIntegrity(assert, model)
  assert.equal(model.blocks[0].kind, 'heading')
  assert.equal(model.blocks[1].kind, 'table')
  assert.equal(model.blocks[2].plainText, 'after')
})
