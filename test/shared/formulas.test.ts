/**
 * Focused coverage for the 1.0.0 math tokenization (task-3 deliverable):
 * `$…$` / `\(…\)` inline math and `$$…$$` / `\[…\]` display math. The parser
 * only tokenizes — KaTeX renders client-side — but the plain-text offset space
 * must keep the raw delimiters so annotations stay stable.
 */

import { test, expect } from 'vitest'

import { parseInline, parseMarkdown, runsText } from '../../src/shared/markdown/parse.ts'
import { assertModelIntegrity, blockAs, blockAt, firstBlockOfKind } from './helpers.ts'

test('inline math keeps raw source in text and latex in the run', () => {
  const runs = parseInline('keeps $k=2$ active')
  expect(runsText(runs)).toBe('keeps $k=2$ active')
  const math = runs.filter((run) => run.type === 'math')
  expect(math.length).toBe(1)
  expect(math[0]?.type === 'math' ? math[0].latex : '').toBe('k=2')
  expect(math[0]?.type === 'math' ? math[0].text : '').toBe('$k=2$')
})

test('inline math accepts \\( … \\) delimiters', () => {
  const runs = parseInline('and \\(y+1\\) end')
  expect(runsText(runs)).toBe('and \\(y+1\\) end')
  const math = runs.filter((run) => run.type === 'math')
  expect(math.length).toBe(1)
  expect(math[0]?.type === 'math' ? math[0].latex : '').toBe('y+1')
  expect(math[0]?.type === 'math' ? math[0].text : '').toBe('\\(y+1\\)')
})

test('currency heuristics and escaped dollars stay text', () => {
  for (const input of ['it costs $5 and $6 today', 'a \\$5 b', 'trailing $', '$$$$$', '$ x $']) {
    const runs = parseInline(input)
    expect(runs.filter((run) => run.type === 'math').length, input).toBe(0)
  }
})

test('math runs never carry code/link flags and inherit emphasis flags', () => {
  const runs = parseInline('**bold $x_1$ math** and [link $y$](https://example.com)')
  const math = runs.filter((run) => run.type === 'math')
  expect(math.length).toBe(2)
  const bold = math[0]
  expect(bold?.type === 'math' ? bold.latex : '').toBe('x_1')
  expect(bold?.strong).toBe(true)
  expect('code' in (bold ?? {})).toBe(false)
  expect('link' in (bold ?? {})).toBe(false)
})

test('display math: single-line $$…$$ and multi-line latex join', () => {
  const single = parseMarkdown('before\n\n$$E = mc^2$$\n\nafter')
  const formula = firstBlockOfKind(single, 'formula')
  expect(formula.latex).toBe('E = mc^2')
  expect(formula.display).toBe(true)
  expect(formula.plainText).toBe('E = mc^2')

  const multi = parseMarkdown('$$\ny = \\sum_{e=1}^{E} g_e(x) f_e(x)\n$$\n\nafter')
  expect(firstBlockOfKind(multi, 'formula').latex).toBe('y = \\sum_{e=1}^{E} g_e(x) f_e(x)')
  expect(multi.blocks.map((block) => block.kind)).toEqual(['formula', 'paragraph'])
  assertModelIntegrity(multi)
})

test('display math: \\[…\\] on one line and across lines', () => {
  const oneLine = parseMarkdown('\\[ x + y \\]')
  expect(firstBlockOfKind(oneLine, 'formula').latex).toBe('x + y')
  const multiline = parseMarkdown('\\[\nx + y\ny + z\n\\]')
  expect(firstBlockOfKind(multiline, 'formula').latex).toBe('x + y\ny + z')
})

test('math works inside headings, lists, quotes, figures-caption paragraphs and table cells', () => {
  const model = parseMarkdown([
    '# Energy $E=mc^2$',
    '',
    '- item $k=2$',
    '',
    '> quoted $\\alpha$',
    '',
    '<table><tr><td>cell $\\lambda=0.01$</td></tr></table>',
  ].join('\n'))
  assertModelIntegrity(model)
  const heading = blockAs(blockAt(model, 0), 'heading')
  expect(heading.runs.some((run) => run.type === 'math' && run.latex === 'E=mc^2')).toBe(true)
  const list = firstBlockOfKind(model, 'list')
  expect(list.items[0]?.runs.some((run) => run.type === 'math' && run.latex === 'k=2')).toBe(true)
  const quote = firstBlockOfKind(model, 'quote')
  expect(quote.runs.some((run) => run.type === 'math' && run.latex === '\\alpha')).toBe(true)
  const table = firstBlockOfKind(model, 'table')
  expect(table.rows[0]?.[0]?.runs.some((run) => run.type === 'math')).toBe(true)
  // Block keys hash the plain text including the raw delimiters.
  expect(heading.plainText).toBe('Energy $E=mc^2$')
})

test('unclosed display math degrades to prose and ends the document safely', () => {
  const model = parseMarkdown('$$\nnot closed\n\ntrailing paragraph')
  expect(model.blocks.some((block) => block.kind === 'formula')).toBe(false)
  expect(model.blocks[model.blocks.length - 1]?.plainText).toBe('trailing paragraph')
  assertModelIntegrity(model)
})

test('a math-only document renders two display formulas and nothing else', () => {
  const model = parseMarkdown('$$a$$\n\n$$b$$')
  expect(model.blocks.map((block) => block.kind)).toEqual(['formula', 'formula'])
  expect(model.blocks.map((block) => blockAs(block, 'formula').latex)).toEqual(['a', 'b'])
  assertModelIntegrity(model)
})
