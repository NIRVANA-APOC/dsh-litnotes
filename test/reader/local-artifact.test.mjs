/**
 * Reader integration for local-engine artifacts (`lib/local-synth.js`).
 *
 * The local engines only extract a text layer; the synthesizer turns it into
 * `full.md` + `content_list.json`. This test proves the reading desk consumes
 * those artifacts exactly like MinerU ones: 1:1 block alignment, 1..N page
 * marks, stable annotation keys and idempotent page marking.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { synthLocalDocument } from '../../lib/local-synth.js'
import { assertModelIntegrity, reader } from './helpers.mjs'

/** A synthetic multi-page document (no real paper fixture). */
function syntheticPages() {
  return [
    [
      { kind: 'heading', level: 1, text: 'A Synthetic Local Paper' },
      { kind: 'paragraph', text: 'Page one body text with a formula $E=mc^2$ and *emphasis*.' },
    ],
    [
      { kind: 'heading', level: 2, text: '2. Method' },
      { kind: 'paragraph', text: 'Page two explains the method in ordinary prose.' },
    ],
    [
      { kind: 'heading', level: 2, text: '3. Results' },
      { kind: 'paragraph', text: 'Page three reports the results.' },
    ],
  ]
}

/** Display page numbers of the inserted page marks. */
function pageNumbers(model) {
  return model.blocks.filter((block) => block.kind === 'page').map((block) => block.page)
}

test('local artifacts parse into a complete reader model', () => {
  const synth = synthLocalDocument({ pages: syntheticPages() })
  const model = reader.parseMarkdown(synth.markdown)
  assertModelIntegrity(assert, model)
  assert.equal(model.blocks.length, synth.contentList.length, 'one reader block per content-list entry')
  assert.equal(model.outline.length, 3)
  assert.equal(model.stats.headings, 3)
  for (let index = 0; index < synth.contentList.length; index += 1) {
    assert.equal(model.blocks[index].plainText, synth.contentList[index].text)
  }
})

test('appendPageMarks places 1..N page marks from local content lists', () => {
  const synth = synthLocalDocument({ pages: syntheticPages() })
  const model = reader.parseMarkdown(synth.markdown)
  const snapshot = JSON.stringify(model)
  const marked = reader.appendPageMarks(model, synth.contentList)

  assert.equal(JSON.stringify(model), snapshot, 'the parsed model is not mutated')
  assertModelIntegrity(assert, marked)
  assert.deepEqual(pageNumbers(marked), [1, 2, 3])
  assert.equal(marked.blocks[0].kind, 'page')
  assert.equal(marked.blocks[0].page, 1)

  // Every parser block keeps its exact anchor (annotation/translation stability).
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  assert.equal(kept.length, model.blocks.length)
  for (let index = 0; index < model.blocks.length; index += 1) {
    assert.equal(kept[index].key, model.blocks[index].key)
    assert.equal(kept[index].index, model.blocks[index].index)
    assert.equal(kept[index].kind, model.blocks[index].kind)
    assert.equal(kept[index].plainText, model.blocks[index].plainText)
  }
  assert.deepEqual(marked.outline, model.outline)
})

test('page marking is idempotent for local artifacts', () => {
  const synth = synthLocalDocument({ pages: syntheticPages() })
  const model = reader.parseMarkdown(synth.markdown)
  const once = reader.appendPageMarks(model, synth.contentList)
  const twice = reader.appendPageMarks(once, synth.contentList)
  assert.deepEqual(twice.blocks, once.blocks)
  assert.deepEqual(twice.outline, once.outline)
  assert.deepEqual(twice.stats, once.stats)
  assert.deepEqual(pageNumbers(twice), [1, 2, 3])
})

test('split long paragraphs still align to their source page', () => {
  const sentences = Array.from({ length: 30 }, (_, index) => `Sentence ${index} belongs to page two.`)
  const synth = synthLocalDocument({
    pages: [
      [{ kind: 'heading', level: 1, text: 'Split Paragraph Paper' }],
      [{ kind: 'paragraph', text: sentences.join(' ') }],
    ],
    maxParagraphChars: 120,
  })
  assert.ok(synth.contentList.length > 3, 'the long paragraph splits into multiple entries')
  const model = reader.parseMarkdown(synth.markdown)
  assert.equal(model.blocks.length, synth.contentList.length)
  const marked = reader.appendPageMarks(model, synth.contentList)
  assertModelIntegrity(assert, marked)
  assert.deepEqual(pageNumbers(marked), [1, 2], 'every split chunk stays on page 2')
  for (const entry of synth.contentList) assert.ok(entry.page_idx === 0 || entry.page_idx === 1)
})

test('empty content lists and keepContentList=false leave the model untouched', () => {
  const synth = synthLocalDocument({ pages: syntheticPages(), keepContentList: false })
  assert.deepEqual(synth.contentList, [])
  const model = reader.parseMarkdown(synth.markdown)
  assert.equal(reader.appendPageMarks(model, synth.contentList), model)
})
