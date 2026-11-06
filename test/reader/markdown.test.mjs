/**
 * Unit tests for the pure markdown → reading-block parser (ui/markdown.js).
 * Run with: node --test test/reader
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reader, assertModelIntegrity } from './helpers.mjs'
import { MINERU_MARKDOWN } from './fixtures.mjs'

const {
  fnv1a,
  blockKey,
  runsText,
  parseInline,
  parseMarkdown,
  mdStats,
  plainTextOfBlock,
} = reader

/** First block of the given kind. */
function blockOfKind(model, kind) {
  return model.blocks.find((block) => block.kind === kind)
}

test('empty input yields an empty, well-formed model', () => {
  for (const input of ['', '   ', '\n\n\n', '\r\n \r\n', undefined, null]) {
    const model = parseMarkdown(input)
    assert.deepEqual(model.blocks, [])
    assert.deepEqual(model.outline, [])
    assert.deepEqual(model.stats, { blocks: 0, headings: 0, chars: 0, words: 0 })
  }
})

test('stable block keys use b<index>:<fnv1a(plainText)>', () => {
  assert.equal(fnv1a(''), '811c9dc5')
  assert.equal(fnv1a('hello'), '4f9f2cab')
  assert.equal(blockKey(3, 'hello'), 'b3:4f9f2cab')
  const model = parseMarkdown('alpha\n\nbeta')
  assert.equal(model.blocks[0].key, `b0:${fnv1a('alpha')}`)
  assert.equal(model.blocks[1].key, `b1:${fnv1a('beta')}`)
  // Deterministic across parses.
  assert.deepEqual(parseMarkdown('alpha\n\nbeta'), model)
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
  const headings = model.blocks.filter((block) => block.kind === 'heading')
  assert.deepEqual(headings.map((block) => block.level), [1, 2, 3, 4, 4])
  assert.deepEqual(headings.map((block) => block.plainText), [
    '1 Introduction',
    '2.1 Background',
    'No Numbering Here',
    'Fourth Level',
    'Clamped Fifth',
  ])
  assert.equal(model.outline.length, 5)
  for (const entry of model.outline) {
    const block = model.blocks[entry.blockIndex]
    assert.equal(entry.key, block.key)
    assert.equal(entry.level, block.level)
    assert.equal(entry.text, block.plainText)
  }
})

test('paragraphs join soft-wrapped lines with a space', () => {
  const model = parseMarkdown('first line\nsecond line\nthird\n\nnext paragraph')
  assert.equal(model.blocks.length, 2)
  assert.equal(model.blocks[0].kind, 'paragraph')
  assert.equal(model.blocks[0].plainText, 'first line second line third')
  assert.equal(model.blocks[1].plainText, 'next paragraph')
})

test('unordered lists fold nested items and continuation lines into one item', () => {
  const model = parseMarkdown([
    '- parent one',
    '  - nested child',
    '  continuation line',
    '- parent two',
  ].join('\n'))
  const list = blockOfKind(model, 'list')
  assert.ok(list)
  assert.equal(list.ordered, false)
  assert.equal(list.start, null)
  assert.equal(list.items.length, 2)
  assert.equal(list.items[0].plainText, 'parent one nested child continuation line')
  assert.equal(list.items[1].plainText, 'parent two')
  // The block run space is the concatenation of the item run spaces: client-ui
  // renders one <li> per item and maps DOM offsets by cumulative item lengths.
  assert.equal(list.plainText, list.items.map((item) => item.plainText).join(''))
  assert.equal(list.plainText, runsText(list.runs))
  let cumulative = 0
  for (const item of list.items) {
    assert.equal(list.plainText.slice(cumulative, cumulative + item.plainText.length), item.plainText)
    cumulative += item.plainText.length
  }
  for (const item of list.items) assert.equal(item.plainText, runsText(item.runs))
})

test('ordered lists preserve the starting number and item count', () => {
  const model = parseMarkdown('3. three\n4. four\n5) five')
  const list = blockOfKind(model, 'list')
  assert.equal(list.ordered, true)
  assert.equal(list.start, 3)
  assert.deepEqual(list.items.map((item) => item.plainText), ['three', 'four', 'five'])
})

test('adjacent lists of different marker types become separate blocks', () => {
  const model = parseMarkdown('- bullet one\n- bullet two\n1. numbered one\n2. numbered two')
  const lists = model.blocks.filter((block) => block.kind === 'list')
  assert.equal(lists.length, 2)
  assert.equal(lists[0].ordered, false)
  assert.equal(lists[1].ordered, true)
  assert.deepEqual(lists[1].items.map((item) => item.plainText), ['numbered one', 'numbered two'])
})

test('list items keep inline runs and math', () => {
  const model = parseMarkdown('- keeps $k=2$ **experts** active\n- plain')
  const list = blockOfKind(model, 'list')
  assert.equal(list.items[0].plainText, 'keeps $k=2$ experts active')
  assert.ok(list.items[0].runs.some((run) => run.type === 'math'))
  assert.ok(list.items[0].runs.some((run) => run.strong === true))
})

test('consecutive blockquote lines form one quote block', () => {
  const model = parseMarkdown('> quoted line one\n> quoted line two\n\n> separate quote')
  const quotes = model.blocks.filter((block) => block.kind === 'quote')
  assert.equal(quotes.length, 2)
  assert.equal(quotes[0].plainText, 'quoted line one quoted line two')
  assert.equal(quotes[1].plainText, 'separate quote')
})

test('fenced code blocks preserve language and body; unclosed fences terminate', () => {
  const model = parseMarkdown('```js\nconst answer = 42\n  indented\n```\n\ntext')
  const code = blockOfKind(model, 'code')
  assert.equal(code.lang, 'js')
  assert.equal(code.code, 'const answer = 42\n  indented')
  assert.equal(code.plainText, code.code)
  const unclosed = parseMarkdown('```python\nprint(1)\nprint(2)')
  assert.equal(unclosed.blocks.length, 1)
  assert.equal(unclosed.blocks[0].kind, 'code')
  assert.equal(unclosed.blocks[0].lang, 'python')
  assert.equal(unclosed.blocks[0].plainText, 'print(1)\nprint(2)')
  assertModelIntegrity(assert, unclosed)
})

test('block formulas: single-line, multi-line and \\[ … \\] wrappers', () => {
  const single = parseMarkdown('before\n\n$$E = mc^2$$\n\nafter')
  const formula = blockOfKind(single, 'formula')
  assert.equal(formula.latex, 'E = mc^2')
  assert.equal(formula.display, true)

  const multi = parseMarkdown('$$\ny = \\sum_{e=1}^{E} g_e(x)\n$$\n\nafter')
  const multiFormula = blockOfKind(multi, 'formula')
  assert.equal(multiFormula.latex, 'y = \\sum_{e=1}^{E} g_e(x)')
  assert.equal(multi.blocks[1].kind, 'paragraph')

  const bracket = parseMarkdown('\\[ x + y \\]')
  assert.equal(blockOfKind(bracket, 'formula').latex, 'x + y')
})

test('an unclosed $$ marker does not swallow the document', () => {
  const model = parseMarkdown('$$\nnot closed\n\ntrailing paragraph')
  assert.equal(model.blocks.filter((block) => block.kind === 'formula').length, 0)
  assert.equal(model.blocks[model.blocks.length - 1].plainText, 'trailing paragraph')
  assertModelIntegrity(assert, model)
})

test('standalone images become figure blocks (plain and wrapped)', () => {
  const plain = parseMarkdown('![A cat](images/cat.png)')
  assert.deepEqual(
    { kind: plain.blocks[0].kind, src: plain.blocks[0].src, alt: plain.blocks[0].alt },
    { kind: 'figure', src: 'images/cat.png', alt: 'A cat' },
  )

  const emptyAlt = parseMarkdown('![](images/empty.png)')
  assert.equal(emptyAlt.blocks[0].kind, 'figure')
  assert.equal(emptyAlt.blocks[0].src, 'images/empty.png')
  assert.equal(emptyAlt.blocks[0].alt, '')

  const centered = parseMarkdown('<center>![Caption](images/fig1.png)</center>')
  assert.equal(centered.blocks[0].kind, 'figure')
  assert.equal(centered.blocks[0].src, 'images/fig1.png')

  const multiLine = parseMarkdown('<p align="center">\n![Caption](images/fig2.png)\n</p>')
  assert.equal(multiLine.blocks[0].kind, 'figure')
  assert.equal(multiLine.blocks[0].src, 'images/fig2.png')

  const htmlImg = parseMarkdown('<img src="images/fig3.png" alt="Alt text">')
  assert.equal(htmlImg.blocks[0].kind, 'figure')
  assert.equal(htmlImg.blocks[0].src, 'images/fig3.png')
  assert.equal(htmlImg.blocks[0].alt, 'Alt text')

  // Caption-like alt text is mirrored into `caption` so the reader can render a
  // visible figcaption (MinerU puts captions in the image alt).
  const captioned = parseMarkdown('![Figure 2: Recall grows with routed experts.](images/fig2.png)')
  assert.equal(captioned.blocks[0].alt, 'Figure 2: Recall grows with routed experts.')
  assert.equal(captioned.blocks[0].caption, 'Figure 2: Recall grows with routed experts.')
  assert.equal(plain.blocks[0].caption, '', 'short descriptive alt stays alt-only')
  const titled = parseMarkdown('<img src="images/fig4.png" alt="Alt" title="Figure 4: Caption">')
  assert.equal(titled.blocks[0].caption, 'Figure 4: Caption')
})

test('horizontal rules are recognised in all three styles', () => {
  const model = parseMarkdown('---\n\n***\n\n___\n\n- - -')
  assert.equal(model.blocks.filter((block) => block.kind === 'rule').length, 4)
  assertModelIntegrity(assert, model)
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
    code: run.code === true,
    del: run.del === true,
    link: run.link,
    type: run.type,
  }))
  assert.deepEqual(flags.filter((run) => run.strong), [{ text: 'bold', strong: true, em: false, code: false, del: false, link: undefined, type: 'text' }])
  assert.ok(flags.some((run) => run.em && run.text === 'italic'))
  assert.ok(flags.some((run) => run.code && run.text === 'code'))
  assert.ok(flags.some((run) => run.del && run.text === 'gone'))
  assert.ok(flags.some((run) => run.link === 'https://example.com/a(b)' && run.text === 'site'))
  const math = runs.filter((run) => run.type === 'math')
  assert.deepEqual(math.map((run) => run.latex), ['x_1', 'y+1'])
  assert.equal(runsText(runs), 'plain bold italic code gone site $x_1$ and \\(y+1\\) end')
})

test('inline run offsets address the block plain text', () => {
  const model = parseMarkdown('one **two** three *four* five')
  const block = model.blocks[0]
  let offset = 0
  const spans = new Map()
  for (const run of block.runs) {
    spans.set(run.text, offset)
    offset += run.text.length
  }
  assert.equal(offset, block.plainText.length)
  assert.equal(block.plainText.slice(spans.get('two'), spans.get('two') + 3), 'two')
  assert.equal(block.plainText.slice(spans.get('four'), spans.get('four') + 4), 'four')
  assert.equal(block.plainText.indexOf('three'), block.plainText.indexOf('three'))
})

test('inline HTML degrades to styles and strips unknown tags', () => {
  const runs = parseInline('an <b>inline</b> <i>html</i> <a href="https://q.example">label</a> tag')
  assert.ok(runs.some((run) => run.strong === true && run.text === 'inline'))
  assert.ok(runs.some((run) => run.em === true && run.text === 'html'))
  assert.ok(runs.some((run) => run.link === 'https://q.example' && run.text === 'label'))
  const stripped = parseInline('keep <span class="x">this</span> text')
  assert.equal(runsText(stripped), 'keep this text')
})

test('escaped characters stay literal and intraword underscores survive', () => {
  const runs = parseInline('\\*not em\\* \\_not em\\_ \\\\ \\$5 field_name_here')
  assert.equal(runsText(runs), '*not em* _not em_ \\ $5 field_name_here')
  assert.equal(parseInline('a < b and c > d').length, 1)
})

test('currency-like dollar signs are not parsed as math', () => {
  const runs = parseInline('it costs $5 and $6 today')
  assert.equal(runs.filter((run) => run.type === 'math').length, 0)
  assert.equal(runsText(runs), 'it costs $5 and $6 today')
})

test('entities decode in text runs but not the block source text', () => {
  const model = parseMarkdown('AT&amp;T spent &lt;5&gt; minutes &quot;here&quot; &#39;x&#39; &nbsp;.')
  assert.equal(model.blocks[0].plainText, 'AT&T spent <5> minutes "here" \'x\' \u00A0.')
})

test('plainTextOfBlock falls back to code/latex and tolerates junk', () => {
  assert.equal(plainTextOfBlock({ kind: 'code', code: 'x = 1' }), 'x = 1')
  assert.equal(plainTextOfBlock({ kind: 'formula', latex: 'x^2' }), 'x^2')
  assert.equal(plainTextOfBlock({ kind: 'paragraph', plainText: 'hi' }), 'hi')
  assert.equal(plainTextOfBlock(null), '')
  assert.equal(plainTextOfBlock({}), '')
})

test('stats count prose characters and words but not code or formulas', () => {
  const model = parseMarkdown('```\ncode not prose\n```\n\nhello beautiful world\n\n$$x^2$$')
  assert.equal(model.stats.blocks, 3)
  assert.equal(model.stats.headings, 0)
  assert.equal(model.stats.chars, 'hello beautiful world'.length)
  assert.equal(model.stats.words, 3)
  const fixture = parseMarkdown(MINERU_MARKDOWN)
  assert.equal(fixture.stats.headings, fixture.outline.length)
  assert.ok(fixture.stats.words > 100)
  assert.equal(fixture.stats.blocks, fixture.blocks.length)
  assert.deepEqual(mdStats(fixture.blocks), fixture.stats)
})

test('the realistic fixture exposes every block kind with sane structure', () => {
  const model = parseMarkdown(MINERU_MARKDOWN)
  assertModelIntegrity(assert, model)
  const kinds = new Set(model.blocks.map((block) => block.kind))
  for (const kind of ['heading', 'paragraph', 'list', 'quote', 'code', 'formula', 'figure', 'table', 'rule']) {
    assert.ok(kinds.has(kind), `missing block kind: ${kind}`)
  }
  const lists = model.blocks.filter((block) => block.kind === 'list')
  assert.equal(lists[0].items.length, 2)
  assert.match(lists[0].items[0].plainText, /Nested details are folded/)
  assert.match(lists[0].items[0].plainText, /continued line also belongs/)
  assert.equal(lists[1].ordered, true)
  const code = blockOfKind(model, 'code')
  assert.equal(code.lang, 'python')
  assert.match(code.code, /def route/)
  const formula = blockOfKind(model, 'formula')
  assert.match(formula.latex, /\\sum_\{e=1\}\^\{E\}/)
  const figure = blockOfKind(model, 'figure')
  assert.equal(figure.src, 'images/fig1.png')
  assert.match(figure.alt, /^Figure 1:/)
  const quote = blockOfKind(model, 'quote')
  assert.equal(quote.plainText, 'Routing should be interpretable, not merely cheap.')
  // Soft-wrapped motivation paragraph collapsed into one block.
  const motivationIndex = model.blocks.findIndex((block) => block.kind === 'heading' && block.plainText === '1.1 Motivation')
  const motivation = model.blocks[motivationIndex + 1]
  assert.equal(motivation.kind, 'paragraph')
  assert.match(motivation.plainText, /Mixture-of-experts layers compute/)
})

test('markdown parses CRLF and strips a leading BOM', () => {
  const model = parseMarkdown('\uFEFF# Title\r\n\r\nBody line\r\nsecond line\r\n')
  assert.equal(model.blocks[0].plainText, 'Title')
  assert.equal(model.blocks[1].plainText, 'Body line second line')
})
