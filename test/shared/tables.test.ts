/**
 * Table parsing tests (port of
 * `.agents/baseline-1.0.0/test/reader/tables.test.mjs`): MinerU HTML tables
 * (colspan/rowspan, inline HTML) and GFM pipe tables (alignment, escaped pipes).
 */

import { test, expect } from 'vitest'

import { parseMarkdown, runsText } from '../../src/shared/markdown/parse.ts'
import type { TableBlock, TableCell } from '../../src/shared/markdown/model.ts'
import { assertModelIntegrity, blockAs, firstBlockOfKind } from './helpers.ts'

/** First table block of a document. */
function tableOf(markdown: string): TableBlock {
  return firstBlockOfKind(parseMarkdown(markdown), 'table')
}

/** Plain texts of one row's cells. */
function cellTexts(row: readonly TableCell[]): string[] {
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
  expect(table.head.length).toBe(3)
  expect(table.head.map((cell) => cell.plainText)).toEqual(['Model', 'Recall@20', 'GFLOPs'])
  expect(table.head.map((cell) => cell.header)).toEqual([true, true, true])
  expect(table.head.map((cell) => cell.colspan)).toEqual([1, 2, 2])
  expect(table.head.map((cell) => cell.rowspan)).toEqual([2, 1, 1])
  expect(table.rows.length).toBe(3)
  expect(cellTexts(table.rows[0] ?? [])).toEqual(['10k', '1M', 'short', 'long'])
  expect(cellTexts(table.rows[2] ?? [])).toEqual(['SparseRoute ($k=2$)', '71.9', '64.5', '2.6', '2.6'])
  // Header cells from the second thead row keep their header flag.
  expect((table.rows[0] ?? []).every((cell) => cell.header === true)).toBe(true)
  expect((table.rows[1] ?? []).every((cell) => cell.header === false)).toBe(true)
  expect(table.plainText).toContain('SparseRoute ($k=2$)')
  expect(table.plainText).toBe(runsText(table.runs))
})

test('HTML table without thead: a first row of th cells becomes the head', () => {
  const table = tableOf('<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>')
  expect(table.head.map((cell) => cell.plainText)).toEqual(['Name', 'Value'])
  expect(table.rows.length).toBe(1)
  expect(cellTexts(table.rows[0] ?? [])).toEqual(['a', '1'])
})

test('HTML table without any header cells uses rows only', () => {
  const table = tableOf('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')
  expect(table.head).toEqual([])
  expect(table.rows.length).toBe(2)
  expect(table.rows.map((row) => cellTexts(row))).toEqual([['a', 'b'], ['c', 'd']])
})

test('HTML table cells: <br> becomes a space, entities decode, inline tags map to styles', () => {
  const table = tableOf(
    '<table><tr><td>line one<br>line two</td>'
      + '<td><strong>bold</strong> and <em>italic</em></td>'
      + '<td>AT&amp;T &lt;5&gt; &#39;q&#39;</td></tr></table>',
  )
  const row = table.rows[0] ?? []
  expect(row[0]?.plainText).toBe('line one line two')
  expect(row[1]?.plainText).toBe('bold and italic')
  const bold = row[1]
  const italic = row[1]
  expect(bold?.runs.some((run) => run.type === 'text' && run.strong === true && run.text === 'bold')).toBe(true)
  expect(italic?.runs.some((run) => run.type === 'text' && run.em === true && run.text === 'italic')).toBe(true)
  expect(row[2]?.plainText).toBe("AT&T <5> 'q'")
})

test('HTML table strips unknown tags while keeping their text', () => {
  const table = tableOf('<table><tr><td><span class="x">kept</span> <unknown-tag>also kept</unknown-tag></td></tr></table>')
  expect(table.rows[0]?.[0]?.plainText).toBe('kept also kept')
})

test('HTML table caption is decoded and stripped of tags', () => {
  const table = tableOf('<table><caption>Table 1: <b>Recall</b> &amp; cost</caption><tr><td>1</td></tr></table>')
  expect(table.caption).toBe('Table 1: Recall & cost')
})

test('table spans are clamped to sane values', () => {
  const table = tableOf('<table><tr><td colspan="0" rowspan="-1">a</td><td colspan="999999">b</td></tr></table>')
  expect(table.rows[0]?.[0]?.colspan).toBe(1)
  expect(table.rows[0]?.[0]?.rowspan).toBe(1)
  expect(table.rows[0]?.[1]?.colspan).toBe(100)
})

test('table cell inline math becomes math runs', () => {
  const table = tableOf('<table><tr><td>SparseRoute ($k=2$)</td><td>$\\lambda=0.01$</td></tr></table>')
  const cell = table.rows[0]?.[0]
  expect(cell?.runs.some((run) => run.type === 'math' && run.latex === 'k=2')).toBe(true)
  expect(cell?.plainText).toBe('SparseRoute ($k=2$)')
})

test('unclosed td tags fall back to loose cell parsing', () => {
  const table = tableOf('<table><tr><td>a<td>b<td>c</tr></table>')
  expect(table.rows.length).toBe(1)
  expect(cellTexts(table.rows[0] ?? [])).toEqual(['a', 'b', 'c'])
})

test('GFM pipe table with alignment row', () => {
  const table = tableOf([
    '| Left | Center | Right |',
    '|:-----|:------:|------:|',
    '| a | b | c |',
    '| d | e | f |',
  ].join('\n'))
  expect(table.head.map((cell) => cell.plainText)).toEqual(['Left', 'Center', 'Right'])
  expect(table.head.map((cell) => cell.align)).toEqual(['left', 'center', 'right'])
  expect(table.head.map((cell) => cell.header)).toEqual([true, true, true])
  expect(table.rows.length).toBe(2)
  expect(table.rows.map((row) => cellTexts(row))).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']])
  expect((table.rows[0] ?? []).every((cell) => cell.header === false)).toBe(true)
  expect(table.caption).toBe('')
})

test('pipe table rows pad missing cells and drop extra ones', () => {
  const table = tableOf('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')
  expect(table.rows.map((row) => cellTexts(row))).toEqual([['1', ''], ['1', '2']])
})

test('pipe tables support escaped pipes and inline markup in cells', () => {
  const table = tableOf('| a | b |\n| --- | --- |\n| x \\| y | **bold** |')
  expect((table.rows[0] ?? []).map((cell) => cell.plainText)).toEqual(['x | y', 'bold'])
  expect(table.rows[0]?.[1]?.runs.some((run) => run.type === 'text' && run.strong === true)).toBe(true)
})

test('a header-looking line without a valid delimiter row stays a paragraph', () => {
  const model = parseMarkdown('a | b\n---')
  expect(model.blocks.filter((block) => block.kind === 'table').length).toBe(0)
  expect(model.blocks.filter((block) => block.kind === 'rule').length).toBe(1)
  assertModelIntegrity(model)
})

test('pipe table embedded after a paragraph is parsed as its own block', () => {
  const model = parseMarkdown('intro text\n\n| h |\n| --- |\n| v |')
  expect(model.blocks[0]?.kind).toBe('paragraph')
  expect(model.blocks[1]?.kind).toBe('table')
  assertModelIntegrity(model)
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
  assertModelIntegrity(model)
  expect(model.blocks[0]?.kind).toBe('heading')
  expect(model.blocks[1]?.kind).toBe('table')
  expect(model.blocks[2]?.plainText).toBe('after')
})

// ---------------------------------------------------------------------------
// 1.0.0 focused coverage: htmlparser2 structural edge cases.
// ---------------------------------------------------------------------------

test('HTML table rows outside thead/tbody are kept as body rows', () => {
  const table = tableOf([
    '<table>',
    '<caption>Results</caption>',
    '<tr><th>h1</th><th>h2</th></tr>',
    '<tr><td>a</td><td>b</td></tr>',
    '</table>',
  ].join('\n'))
  expect(table.caption).toBe('Results')
  expect(table.head.map((cell) => cell.plainText)).toEqual(['h1', 'h2'])
  expect(table.rows.map((row) => cellTexts(row))).toEqual([['a', 'b']])
})

test('a multi-line HTML table is one block with no prose leaking out', () => {
  const model = parseMarkdown(
    'before\n\n<table><tr><th>a</th></tr>\n<tr><td>1</td></tr></table>\n\nafter',
  )
  assertModelIntegrity(model)
  expect(model.blocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'paragraph'])
  expect(blockAs(model.blocks[2] ?? model.blocks[0] as never, 'paragraph').plainText).toBe('after')
})

test('an unclosed HTML table degrades to prose and never throws', () => {
  const model = parseMarkdown('<table><tr><td>unclosed table')
  assertModelIntegrity(model)
  expect(model.blocks.length).toBe(1)
  expect(model.blocks[0]?.kind).toBe('paragraph')
  expect(model.blocks[0]?.plainText).toContain('unclosed table')
})
