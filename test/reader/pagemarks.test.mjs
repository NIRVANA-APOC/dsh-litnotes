/**
 * Page-mark alignment tests: appendPageMarks(model, contentList) must insert
 * `{kind:'page', page}` blocks on MinerU content-list page_idx transitions,
 * best effort, without dropping or reordering parser blocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reader, assertModelIntegrity } from './helpers.mjs'
import { MINERU_MARKDOWN, MINERU_CONTENT_LIST } from './fixtures.mjs'

const { parseMarkdown, appendPageMarks, blockKey, runsText } = reader

const PAGE_KEY = /^page:\d+:\d+$/

const fixtureModel = parseMarkdown(MINERU_MARKDOWN)

function pageNumbers(model) {
  return model.blocks.filter((block) => block.kind === 'page').map((block) => block.page)
}

function pagePositions(model) {
  const positions = []
  for (let i = 0; i < model.blocks.length; i += 1) {
    if (model.blocks[i].kind === 'page') positions.push(i)
  }
  return positions
}

test('three-page content list aligns page marks before the right blocks', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  assert.notEqual(marked, fixtureModel, 'a new model object must be returned')
  assertModelIntegrity(assert, marked)
  assert.deepEqual(pageNumbers(marked), [1, 2, 3])
  assert.equal(marked.blocks[0].kind, 'page')
  assert.equal(marked.blocks[0].page, 1)

  // Page 2 starts at the equation entry (block 8 in the unmarked model).
  const formulaIndex = marked.blocks.findIndex((block) => block.kind === 'formula')
  assert.equal(marked.blocks[formulaIndex - 1].kind, 'page')
  assert.equal(marked.blocks[formulaIndex - 1].page, 2)

  // Page 3 starts at the "3 Results" heading.
  const resultsIndex = marked.blocks.findIndex((block) => block.kind === 'heading' && block.plainText === '3 Results')
  assert.equal(marked.blocks[resultsIndex - 1].kind, 'page')
  assert.equal(marked.blocks[resultsIndex - 1].page, 3)

  // Page marks are strictly ordered and never duplicated.
  const positions = pagePositions(marked)
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right))
  assert.equal(new Set(positions).size, positions.length)
})

test('appendPageMarks keeps every original block in order, index and key', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  const original = fixtureModel.blocks
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  assert.equal(kept.length, original.length)
  for (let i = 0; i < original.length; i += 1) {
    assert.equal(kept[i].kind, original[i].kind, `block ${i} kind changed`)
    assert.equal(kept[i].index, original[i].index, `block ${i} index changed (annotation anchors must stay stable)`)
    assert.equal(kept[i].key, original[i].key, `block ${i} key changed (annotation anchors must stay stable)`)
    if (original[i].kind === 'figure') assert.equal(kept[i].src, original[i].src)
    else assert.equal(kept[i].plainText, original[i].plainText, `block ${i} text changed`)
  }
})

test('page blocks get synthetic keys and never rekey the originals', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  assert.equal(new Set(marked.blocks.map((block) => block.key)).size, marked.blocks.length)
  const pages = marked.blocks.filter((block) => block.kind === 'page')
  assert.equal(pages.length, 3)
  for (const page of pages) {
    assert.match(page.key, PAGE_KEY)
    assert.equal(page.kind, 'page')
    assert.ok(Number.isInteger(page.index) && page.index >= 0)
    assert.equal('plainText' in page, false, 'page blocks carry no plainText')
  }
  // Original outline entries are carried over unchanged and still resolve by key.
  assert.deepEqual(marked.outline, fixtureModel.outline)
  for (const entry of marked.outline) {
    const block = marked.blocks.find((candidate) => candidate.key === entry.key)
    assert.ok(block, 'outline key must still resolve')
    assert.equal(block.kind, 'heading')
    assert.equal(block.index, entry.blockIndex)
    assert.equal(block.plainText, entry.text)
  }
  // Every text-bearing block keeps the key it had without page marks.
  for (const block of marked.blocks) {
    if (block.kind === 'page') continue
    if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote'
      || block.kind === 'list' || block.kind === 'table') {
      assert.equal(block.key, blockKey(block.index, block.plainText))
      assert.equal(block.plainText, runsText(block.runs))
    }
  }
})

test('page marks are annotation-stable across the page-marks preference', () => {
  // Toggling the reader's "show page marks" preference rebuilds the model; a
  // stored annotation/translation blockKey must still resolve afterwards.
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  const annotatedBlock = fixtureModel.blocks.find((block) => block.kind === 'paragraph')
  const blockWithMarks = marked.blocks.find((block) => block.key === annotatedBlock.key)
  assert.ok(blockWithMarks, 'the annotated block key must survive page-mark insertion')
  assert.equal(blockWithMarks.plainText, annotatedBlock.plainText)
})

test('appendPageMarks never mutates the input model', () => {
  const snapshot = JSON.stringify(fixtureModel)
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  assert.equal(JSON.stringify(fixtureModel), snapshot)
  assert.notEqual(marked, fixtureModel)
})

test('appendPageMarks is idempotent for the same content list', () => {
  const once = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  const twice = appendPageMarks(once, MINERU_CONTENT_LIST)
  assert.deepEqual(twice.blocks, once.blocks)
  assert.deepEqual(twice.outline, once.outline)
  assert.deepEqual(twice.stats, once.stats)
})

test('empty or missing content list returns the model untouched', () => {
  assert.equal(appendPageMarks(fixtureModel, []), fixtureModel)
  assert.equal(appendPageMarks(fixtureModel, null), fixtureModel)
  assert.equal(appendPageMarks(fixtureModel, undefined), fixtureModel)
})

test('content list without page_idx yields no page marks', () => {
  const entries = [
    { type: 'title', text: 'Sparse Routing for Retrieval' },
    { type: 'text', text: 'Ada Lovelace and Grace Hopper' },
  ]
  assert.equal(appendPageMarks(fixtureModel, entries), fixtureModel)
})

test('unmatched entry page transition falls back to the next block', () => {
  const model = parseMarkdown('first paragraph\n\nsecond paragraph\n\nthird paragraph')
  const marked = appendPageMarks(model, [
    { type: 'text', text: 'first paragraph', page_idx: 0 },
    { type: 'text', text: 'text that does not exist anywhere', page_idx: 1 },
    { type: 'text', text: 'third paragraph', page_idx: 1 },
  ])
  assert.deepEqual(pageNumbers(marked), [1, 2])
  assert.equal(marked.blocks[0].kind, 'page')
  assert.equal(marked.blocks[2].kind, 'page')
  assert.equal(marked.blocks[3].plainText, 'second paragraph')
})

test('image page transition without a matching figure still makes best effort', () => {
  const model = parseMarkdown('first paragraph\n\nsecond paragraph\n\nthird paragraph')
  const marked = appendPageMarks(model, [
    { type: 'text', text: 'first paragraph', page_idx: 0 },
    { type: 'image', img_path: 'images/missing.png', page_idx: 1 },
  ])
  assert.deepEqual(pageNumbers(marked), [1, 2])
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  assert.deepEqual(kept.map((block) => block.plainText), [
    'first paragraph',
    'second paragraph',
    'third paragraph',
  ])
})

test('image entries align with figure blocks by img_path basename', () => {
  const model = parseMarkdown('intro\n\n![caption](images/fig1.svg)\n\noutro')
  const marked = appendPageMarks(model, [
    { type: 'text', text: 'intro', page_idx: 0 },
    { type: 'image', img_path: 'images/fig1.svg', image_caption: ['caption'], page_idx: 1 },
  ])
  assert.deepEqual(pageNumbers(marked), [1, 2])
  const figureIndex = marked.blocks.findIndex((block) => block.kind === 'figure')
  assert.equal(marked.blocks[figureIndex - 1].kind, 'page')
  assert.equal(marked.blocks[figureIndex - 1].page, 2)
})

test('title entries only match headings and list entries only match lists', () => {
  const model = parseMarkdown('## Section A\n\n- item one\n- item two\n\n## Section B')
  const marked = appendPageMarks(model, [
    { type: 'title', text: 'Section A', page_idx: 0 },
    { type: 'list', list_items: ['item one', 'item two'], page_idx: 1 },
    { type: 'title', text: 'Section B', page_idx: 2 },
  ])
  assert.deepEqual(pageNumbers(marked), [1, 2, 3])
  const listIndex = marked.blocks.findIndex((block) => block.kind === 'list')
  assert.equal(marked.blocks[listIndex - 1].page, 2)
  const sectionBIndex = marked.blocks.findIndex(
    (block) => block.kind === 'heading' && block.plainText === 'Section B',
  )
  assert.equal(marked.blocks[sectionBIndex - 1].page, 3)
})

test('page numbers are 1-based display pages', () => {
  const model = parseMarkdown('alpha\n\nbeta\n\ngamma')
  const marked = appendPageMarks(model, [
    { type: 'text', text: 'alpha', page_idx: 0 },
    { type: 'text', text: 'beta', page_idx: 1 },
    { type: 'text', text: 'gamma', page_idx: 2 },
  ])
  assert.deepEqual(pageNumbers(marked), [1, 2, 3])
})

test('stats are recomputed after page marks are inserted', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  assert.equal(marked.stats.blocks, marked.blocks.length)
  assert.equal(marked.stats.blocks, fixtureModel.stats.blocks + 3)
  assert.equal(marked.stats.headings, fixtureModel.stats.headings)
  assert.equal(marked.stats.chars, fixtureModel.stats.chars)
  assert.equal(marked.stats.words, fixtureModel.stats.words)
})
