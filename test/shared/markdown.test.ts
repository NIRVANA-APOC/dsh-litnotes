/**
 * Unit tests for the shared markdown → paper-model parser.
 *
 * Port of `.agents/baseline-1.0.0/test/reader/markdown.test.mjs` (the frozen
 * 1.0.0 executable spec) to vitest/TypeScript, plus focused assertions for the
 * 1.0.0 markdown-it implementation where the frozen contract needs it.
 */

import { test, expect } from 'vitest'

import {
  blockKey,
  fnv1a,
  mdStats,
  parseInline,
  parseMarkdown,
  plainTextOfBlock,
  runsText,
} from '../../src/shared/markdown/parse.ts'
import type { Block } from '../../src/shared/markdown/model.ts'
import { MINERU_MARKDOWN } from './fixtures.ts'
import { assertModelIntegrity, blockAs, blockAt, blocksOfKind, firstBlockOfKind } from './helpers.ts'

test('empty input yields an empty, well-formed model', () => {
  for (const input of ['', '   ', '\n\n\n', '\r\n \r\n', undefined, null]) {
    const model = parseMarkdown(input)
    expect(model.blocks).toEqual([])
    expect(model.outline).toEqual([])
    expect(model.stats).toEqual({ blocks: 0, headings: 0, chars: 0, words: 0 })
  }
})

test('stable block keys use b<index>:<fnv1a(plainText)>', () => {
  expect(fnv1a('')).toBe('811c9dc5')
  expect(fnv1a('hello')).toBe('4f9f2cab')
  expect(blockKey(3, 'hello')).toBe('b3:4f9f2cab')
  const model = parseMarkdown('alpha\n\nbeta')
  expect(blockAt(model, 0).key).toBe(`b0:${fnv1a('alpha')}`)
  expect(blockAt(model, 1).key).toBe(`b1:${fnv1a('beta')}`)
  // Deterministic across parses.
  expect(parseMarkdown('alpha\n\nbeta')).toEqual(model)
})

test('ATX headings h1–h4 keep numbering and text verbatim', () => {
  const model = parseMarkdown([
    '# 1 Introduction',
    '',
    '## 2.1 Background ##',
    '',
    '### No Numbering Here',
    '',
    '#### Fourth Level',
    '',
    '##### Clamped Fifth',
  ].join('\n'))
  const headings = blocksOfKind(model, 'heading')
  expect(headings.map((block) => block.level)).toEqual([1, 2, 3, 4, 4])
  expect(headings.map((block) => block.plainText)).toEqual([
    '1 Introduction',
    '2.1 Background',
    'No Numbering Here',
    'Fourth Level',
    'Clamped Fifth',
  ])
  expect(model.outline.length).toBe(5)
  for (const entry of model.outline) {
    const block = model.blocks.find((candidate) => candidate.key === entry.key)
    expect(block).toBeDefined()
    if (block === undefined) continue
    expect(entry.key).toBe(block.key)
    expect(block.kind).toBe('heading')
    if (block.kind === 'heading') expect(entry.level).toBe(block.level)
    expect(entry.text).toBe(block.plainText)
    expect(block.index).toBe(entry.blockIndex)
  }
})

test('paragraphs join soft-wrapped lines with a space', () => {
  const model = parseMarkdown('first line\nsecond line\nthird\n\nnext paragraph')
  expect(model.blocks.length).toBe(2)
  expect(blockAt(model, 0).kind).toBe('paragraph')
  expect(blockAt(model, 0).plainText).toBe('first line second line third')
  expect(blockAt(model, 1).plainText).toBe('next paragraph')
})

test('unordered lists fold nested items and continuation lines into one item', () => {
  const model = parseMarkdown([
    '- parent one',
    '  - nested child',
    '  continuation line',
    '- parent two',
  ].join('\n'))
  const list = firstBlockOfKind(model, 'list')
  expect(list.ordered).toBe(false)
  expect(list.start).toBeNull()
  expect(list.items.length).toBe(2)
  expect(list.items[0]?.plainText).toBe('parent one nested child continuation line')
  expect(list.items[1]?.plainText).toBe('parent two')
  // The block run space is the concatenation of the item run spaces: the client
  // renders one <li> per item and maps DOM offsets by cumulative item lengths.
  expect(list.plainText).toBe(list.items.map((item) => item.plainText).join(''))
  expect(list.plainText).toBe(runsText(list.runs))
  let cumulative = 0
  for (const item of list.items) {
    expect(list.plainText.slice(cumulative, cumulative + item.plainText.length)).toBe(item.plainText)
    cumulative += item.plainText.length
  }
  for (const item of list.items) expect(item.plainText).toBe(runsText(item.runs))
})

test('ordered lists preserve the starting number and item count', () => {
  const model = parseMarkdown('3. three\n4. four\n5) five')
  const list = firstBlockOfKind(model, 'list')
  expect(list.ordered).toBe(true)
  expect(list.start).toBe(3)
  expect(list.items.map((item) => item.plainText)).toEqual(['three', 'four', 'five'])
})

test('adjacent lists of different marker types become separate blocks', () => {
  const model = parseMarkdown('- bullet one\n- bullet two\n1. numbered one\n2. numbered two')
  const lists = blocksOfKind(model, 'list')
  expect(lists.length).toBe(2)
  expect(lists[0]?.ordered).toBe(false)
  expect(lists[1]?.ordered).toBe(true)
  expect(lists[1]?.items.map((item) => item.plainText)).toEqual(['numbered one', 'numbered two'])
})

test('list items keep inline runs and math', () => {
  const model = parseMarkdown('- keeps $k=2$ **experts** active\n- plain')
  const list = firstBlockOfKind(model, 'list')
  const first = list.items[0]
  expect(first).toBeDefined()
  if (first === undefined) return
  expect(first.plainText).toBe('keeps $k=2$ experts active')
  expect(first.runs.some((run) => run.type === 'math')).toBe(true)
  expect(first.runs.some((run) => run.type === 'text' && run.strong === true)).toBe(true)
})

test('consecutive blockquote lines form one quote block', () => {
  const model = parseMarkdown('> quoted line one\n> quoted line two\n\n> separate quote')
  const quotes = blocksOfKind(model, 'quote')
  expect(quotes.length).toBe(2)
  expect(quotes[0]?.plainText).toBe('quoted line one quoted line two')
  expect(quotes[1]?.plainText).toBe('separate quote')
})

test('fenced code blocks preserve language and body; unclosed fences terminate', () => {
  const model = parseMarkdown('```js\nconst answer = 42\n  indented\n```\n\ntext')
  const code = firstBlockOfKind(model, 'code')
  expect(code.lang).toBe('js')
  expect(code.code).toBe('const answer = 42\n  indented')
  expect(code.plainText).toBe(code.code)
  const unclosed = parseMarkdown('```python\nprint(1)\nprint(2)')
  expect(unclosed.blocks.length).toBe(1)
  expect(blockAt(unclosed, 0).kind).toBe('code')
  const unclosedCode = blockAs(blockAt(unclosed, 0), 'code')
  expect(unclosedCode.lang).toBe('python')
  expect(unclosedCode.plainText).toBe('print(1)\nprint(2)')
  assertModelIntegrity(unclosed)
})

test('block formulas: single-line, multi-line and \\[ … \\] wrappers', () => {
  const single = parseMarkdown('before\n\n$$E = mc^2$$\n\nafter')
  const formula = firstBlockOfKind(single, 'formula')
  expect(formula.latex).toBe('E = mc^2')
  expect(formula.display).toBe(true)

  const multi = parseMarkdown('$$\ny = \\sum_{e=1}^{E} g_e(x)\n$$\n\nafter')
  expect(firstBlockOfKind(multi, 'formula').latex).toBe('y = \\sum_{e=1}^{E} g_e(x)')
  expect(blockAt(multi, 1).kind).toBe('paragraph')

  const bracket = parseMarkdown('\\[ x + y \\]')
  expect(firstBlockOfKind(bracket, 'formula').latex).toBe('x + y')
})

test('an unclosed $$ marker does not swallow the document', () => {
  const model = parseMarkdown('$$\nnot closed\n\ntrailing paragraph')
  expect(model.blocks.filter((block) => block.kind === 'formula').length).toBe(0)
  expect(blockAt(model, model.blocks.length - 1).plainText).toBe('trailing paragraph')
  assertModelIntegrity(model)
})

test('standalone images become figure blocks (plain and wrapped)', () => {
  const plain = parseMarkdown('![A cat](images/cat.png)')
  const plainFigure = blockAs(blockAt(plain, 0), 'figure')
  expect({ kind: plainFigure.kind, src: plainFigure.src, alt: plainFigure.alt })
    .toEqual({ kind: 'figure', src: 'images/cat.png', alt: 'A cat' })

  const emptyAlt = parseMarkdown('![](images/empty.png)')
  const emptyFigure = blockAs(blockAt(emptyAlt, 0), 'figure')
  expect(emptyFigure.src).toBe('images/empty.png')
  expect(emptyFigure.alt).toBe('')

  const centered = parseMarkdown('<center>![Caption](images/fig1.png)</center>')
  expect(blockAs(blockAt(centered, 0), 'figure').src).toBe('images/fig1.png')

  const multiLine = parseMarkdown('<p align="center">\n![Caption](images/fig2.png)\n</p>')
  expect(blockAs(blockAt(multiLine, 0), 'figure').src).toBe('images/fig2.png')

  const htmlImg = parseMarkdown('<img src="images/fig3.png" alt="Alt text">')
  const imgFigure = blockAs(blockAt(htmlImg, 0), 'figure')
  expect(imgFigure.src).toBe('images/fig3.png')
  expect(imgFigure.alt).toBe('Alt text')

  // Caption-like alt text is mirrored into `caption` so the reader can render a
  // visible figcaption (MinerU puts captions in the image alt).
  const captioned = parseMarkdown('![Figure 2: Recall grows with routed experts.](images/fig2.png)')
  const captionedFigure = blockAs(blockAt(captioned, 0), 'figure')
  expect(captionedFigure.alt).toBe('Figure 2: Recall grows with routed experts.')
  expect(captionedFigure.caption).toBe('Figure 2: Recall grows with routed experts.')
  expect(plainFigure.caption).toBe('')
  const titled = parseMarkdown('<img src="images/fig4.png" alt="Alt" title="Figure 4: Caption">')
  expect(blockAs(blockAt(titled, 0), 'figure').caption).toBe('Figure 4: Caption')
})

test('horizontal rules are recognised in all three styles', () => {
  const model = parseMarkdown('---\n\n***\n\n___\n\n- - -')
  expect(model.blocks.filter((block) => block.kind === 'rule').length).toBe(4)
  assertModelIntegrity(model)
})

test('inline runs: strong, em, code, del, links and math', () => {
  const runs = parseInline(
    'plain **bold** *italic* `code` ~~gone~~ [site](https://example.com/a(b)) '
      + '$x_1$ and \\(y+1\\) end',
  )
  const flags = runs.map((run) => ({
    text: run.text,
    strong: run.strong === true,
    em: run.em === true,
    code: run.type === 'text' ? run.code === true : false,
    del: run.del === true,
    link: run.type === 'text' ? run.link : undefined,
    type: run.type,
  }))
  expect(flags.filter((run) => run.strong)).toEqual([
    { text: 'bold', strong: true, em: false, code: false, del: false, link: undefined, type: 'text' },
  ])
  expect(flags.some((run) => run.em && run.text === 'italic')).toBe(true)
  expect(flags.some((run) => run.code && run.text === 'code')).toBe(true)
  expect(flags.some((run) => run.del && run.text === 'gone')).toBe(true)
  expect(flags.some((run) => run.link === 'https://example.com/a(b)' && run.text === 'site')).toBe(true)
  const math = runs.filter((run) => run.type === 'math')
  expect(math.map((run) => (run.type === 'math' ? run.latex : ''))).toEqual(['x_1', 'y+1'])
  expect(runsText(runs)).toBe('plain bold italic code gone site $x_1$ and \\(y+1\\) end')
})

test('inline run offsets address the block plain text', () => {
  const model = parseMarkdown('one **two** three *four* five')
  const block = blockAt(model, 0)
  expect(block.kind).toBe('paragraph')
  if (!('runs' in block)) throw new Error('paragraph block has runs')
  let offset = 0
  const spans = new Map<string, number>()
  for (const run of block.runs) {
    spans.set(run.text, offset)
    offset += run.text.length
  }
  expect(offset).toBe(block.plainText.length)
  const two = spans.get('two') ?? -1
  const four = spans.get('four') ?? -1
  expect(block.plainText.slice(two, two + 3)).toBe('two')
  expect(block.plainText.slice(four, four + 4)).toBe('four')
  expect(block.plainText.indexOf('three')).toBe(block.plainText.indexOf('three'))
})

test('inline HTML degrades to styles and strips unknown tags', () => {
  const runs = parseInline('an <b>inline</b> <i>html</i> <a href="https://q.example">label</a> tag')
  expect(runs.some((run) => run.type === 'text' && run.strong === true && run.text === 'inline')).toBe(true)
  expect(runs.some((run) => run.type === 'text' && run.em === true && run.text === 'html')).toBe(true)
  expect(runs.some((run) => run.type === 'text' && run.link === 'https://q.example' && run.text === 'label')).toBe(true)
  const stripped = parseInline('keep <span class="x">this</span> text')
  expect(runsText(stripped)).toBe('keep this text')
})

test('escaped characters stay literal and intraword underscores survive', () => {
  const runs = parseInline('\\*not em\\* \\_not em\\_ \\\\ \\$5 field_name_here')
  expect(runsText(runs)).toBe('*not em* _not em_ \\ $5 field_name_here')
  expect(parseInline('a < b and c > d').length).toBe(1)
})

test('currency-like dollar signs are not parsed as math', () => {
  const runs = parseInline('it costs $5 and $6 today')
  expect(runs.filter((run) => run.type === 'math').length).toBe(0)
  expect(runsText(runs)).toBe('it costs $5 and $6 today')
})

test('entities decode in text runs but not the block source text', () => {
  const model = parseMarkdown('AT&amp;T spent &lt;5&gt; minutes &quot;here&quot; &#39;x&#39; &nbsp;.')
  expect(blockAt(model, 0).plainText).toBe('AT&T spent <5> minutes "here" \'x\' \u00A0.')
})

test('plainTextOfBlock falls back to code/latex and tolerates junk', () => {
  expect(plainTextOfBlock({ kind: 'code', code: 'x = 1' })).toBe('x = 1')
  expect(plainTextOfBlock({ kind: 'formula', latex: 'x^2' })).toBe('x^2')
  expect(plainTextOfBlock({ kind: 'paragraph', plainText: 'hi' })).toBe('hi')
  expect(plainTextOfBlock(null)).toBe('')
  expect(plainTextOfBlock({})).toBe('')
})

test('stats count prose characters and words but not code or formulas', () => {
  const model = parseMarkdown('```\ncode not prose\n```\n\nhello beautiful world\n\n$$x^2$$')
  expect(model.stats.blocks).toBe(3)
  expect(model.stats.headings).toBe(0)
  expect(model.stats.chars).toBe('hello beautiful world'.length)
  expect(model.stats.words).toBe(3)
  const fixture = parseMarkdown(MINERU_MARKDOWN)
  expect(fixture.stats.headings).toBe(fixture.outline.length)
  expect(fixture.stats.words).toBeGreaterThan(100)
  expect(fixture.stats.blocks).toBe(fixture.blocks.length)
  expect(mdStats(fixture.blocks)).toEqual(fixture.stats)
})

test('the realistic fixture exposes every block kind with sane structure', () => {
  const model = parseMarkdown(MINERU_MARKDOWN)
  assertModelIntegrity(model)
  const kinds = new Set<string>(model.blocks.map((block) => block.kind))
  for (const kind of ['heading', 'paragraph', 'list', 'quote', 'code', 'formula', 'figure', 'table', 'rule']) {
    expect(kinds.has(kind), `missing block kind: ${kind}`).toBe(true)
  }
  const lists = blocksOfKind(model, 'list')
  const firstList = lists[0]
  const secondList = lists[1]
  expect(firstList).toBeDefined()
  expect(secondList).toBeDefined()
  if (firstList === undefined || secondList === undefined) return
  expect(firstList.items.length).toBe(2)
  expect(firstList.items[0]?.plainText).toMatch(/Nested details are folded/)
  expect(firstList.items[0]?.plainText).toMatch(/continued line also belongs/)
  expect(secondList.ordered).toBe(true)
  const code = firstBlockOfKind(model, 'code')
  expect(code.lang).toBe('python')
  expect(code.code).toMatch(/def route/)
  const formula = firstBlockOfKind(model, 'formula')
  expect(formula.latex).toMatch(/\\sum_\{e=1\}\^\{E\}/)
  const figure = firstBlockOfKind(model, 'figure')
  expect(figure.src).toBe('images/fig1.png')
  expect(figure.alt).toMatch(/^Figure 1:/)
  const quote = firstBlockOfKind(model, 'quote')
  expect(quote.plainText).toBe('Routing should be interpretable, not merely cheap.')
  // Soft-wrapped motivation paragraph collapsed into one block.
  const motivationIndex = model.blocks.findIndex(
    (block) => block.kind === 'heading' && block.plainText === '1.1 Motivation',
  )
  const motivation = blockAt(model, motivationIndex + 1)
  expect(motivation.kind).toBe('paragraph')
  expect(motivation.plainText).toMatch(/Mixture-of-experts layers compute/)
})

test('markdown parses CRLF and strips a leading BOM', () => {
  const model = parseMarkdown('\uFEFF# Title\r\n\r\nBody line\r\nsecond line\r\n')
  expect(blockAt(model, 0).plainText).toBe('Title')
  expect(blockAt(model, 1).plainText).toBe('Body line second line')
})

// ---------------------------------------------------------------------------
// 1.0.0 focused coverage: markdown-it delegates standard constructs; the paper
// rules keep the frozen contract for the non-standard ones.
// ---------------------------------------------------------------------------

test('markdown-it owns standard inline constructs in blocks (links, emphasis, code, strikethrough)', () => {
  const model = parseMarkdown(
    'A [link](https://example.com/x) with **strong**, *em*, `code`, ~~gone~~ and a footnote[^1].',
  )
  const block = firstBlockOfKind(model, 'paragraph')
  const runs = block.runs
  expect(runs.some((run) => run.type === 'text' && run.link === 'https://example.com/x' && run.text === 'link')).toBe(true)
  expect(runs.some((run) => run.type === 'text' && run.strong === true && run.text === 'strong')).toBe(true)
  expect(runs.some((run) => run.type === 'text' && run.em === true && run.text === 'em')).toBe(true)
  expect(runs.some((run) => run.type === 'text' && run.code === true && run.text === 'code')).toBe(true)
  expect(runs.some((run) => run.type === 'text' && run.del === true && run.text === 'gone')).toBe(true)
  // Reference definitions are not part of the frozen reader contract: the
  // marker stays literal text instead of being resolved/stripped.
  expect(block.plainText).toContain('footnote[^1]')
})

test('setext-looking input stays a paragraph plus a rule (no setext heading)', () => {
  const model = parseMarkdown('a | b\n---')
  expect(model.blocks.filter((block) => block.kind === 'table').length).toBe(0)
  expect(model.blocks.filter((block) => block.kind === 'rule').length).toBe(1)
  assertModelIntegrity(model)
})

test('every non-page block carries the uniform base fields', () => {
  const model = parseMarkdown(MINERU_MARKDOWN)
  for (const block of model.blocks) {
    expect(typeof block.index).toBe('number')
    expect(typeof block.key).toBe('string')
    expect(typeof block.kind).toBe('string')
    expect(block.page === null || Number.isInteger(block.page)).toBe(true)
    expect(typeof block.plainText).toBe('string')
    if (block.kind !== 'page') expect(block.page).toBeNull()
  }
})

test('the same markdown always produces identical block keys (deterministic)', () => {
  const first = parseMarkdown(MINERU_MARKDOWN)
  const second = parseMarkdown(MINERU_MARKDOWN)
  const keys = (model: typeof first): string[] => model.blocks.map((block: Block) => block.key)
  expect(keys(first)).toEqual(keys(second))
})
