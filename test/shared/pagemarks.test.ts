/**
 * Page-mark alignment tests (port of
 * `.agents/baseline-1.0.0/test/reader/pagemarks.test.mjs`).
 *
 * `appendPageMarks(model, contentList)` must insert `{kind:'page', page}` blocks
 * on MinerU content-list `page_idx` transitions, best effort, without dropping
 * or reordering parser blocks and without invalidating annotation anchors.
 */

import { test, expect } from 'vitest'

import { appendPageMarks, blockKey, parseMarkdown, runsText } from '../../src/shared/markdown/parse.ts'
import type { PaperModel } from '../../src/shared/markdown/model.ts'
import { MINERU_CONTENT_LIST, MINERU_MARKDOWN } from './fixtures.ts'
import { assertModelIntegrity, blockAt, pageNumbers, pagePositions } from './helpers.ts'

const PAGE_KEY = /^page:\d+:\d+$/

const fixtureModel = parseMarkdown(MINERU_MARKDOWN)

test('three-page content list aligns page marks before the right blocks', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  expect(marked).not.toBe(fixtureModel)
  assertModelIntegrity(marked)
  expect(pageNumbers(marked)).toEqual([1, 2, 3])
  expect(blockAt(marked, 0).kind).toBe('page')
  const firstPage = blockAt(marked, 0)
  if (firstPage.kind === 'page') expect(firstPage.page).toBe(1)

  // Page 2 starts at the equation entry (block 8 in the unmarked model).
  const formulaIndex = marked.blocks.findIndex((block) => block.kind === 'formula')
  const beforeFormula = blockAt(marked, formulaIndex - 1)
  expect(beforeFormula.kind).toBe('page')
  if (beforeFormula.kind === 'page') expect(beforeFormula.page).toBe(2)

  // Page 3 starts at the "3 Results" heading.
  const resultsIndex = marked.blocks.findIndex(
    (block) => block.kind === 'heading' && block.plainText === '3 Results',
  )
  const beforeResults = blockAt(marked, resultsIndex - 1)
  expect(beforeResults.kind).toBe('page')
  if (beforeResults.kind === 'page') expect(beforeResults.page).toBe(3)

  // Page marks are strictly ordered and never duplicated.
  const positions = pagePositions(marked)
  expect(positions).toEqual([...positions].sort((left, right) => left - right))
  expect(new Set(positions).size).toBe(positions.length)
})

test('appendPageMarks keeps every original block in order, index and key', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  const original = fixtureModel.blocks
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  expect(kept.length).toBe(original.length)
  for (let index = 0; index < original.length; index += 1) {
    const before = original[index]
    const after = kept[index]
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    if (before === undefined || after === undefined) continue
    expect(after.kind, `block ${index} kind changed`).toBe(before.kind)
    expect(after.index, `block ${index} index changed (annotation anchors must stay stable)`).toBe(before.index)
    expect(after.key, `block ${index} key changed (annotation anchors must stay stable)`).toBe(before.key)
    if (before.kind === 'figure') expect(after.kind === 'figure' ? after.src : '').toBe(before.src)
    else expect(after.plainText, `block ${index} text changed`).toBe(before.plainText)
  }
})

test('page blocks get synthetic keys and never rekey the originals', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  expect(new Set(marked.blocks.map((block) => block.key)).size).toBe(marked.blocks.length)
  const pages = marked.blocks.filter((block) => block.kind === 'page')
  expect(pages.length).toBe(3)
  for (const page of pages) {
    expect(page.key).toMatch(PAGE_KEY)
    expect(page.kind).toBe('page')
    expect(Number.isInteger(page.index) && page.index >= 0).toBe(true)
    expect(page.plainText).toBe('')
  }
  // Original outline entries are carried over unchanged and still resolve by key.
  expect(marked.outline).toEqual(fixtureModel.outline)
  for (const entry of marked.outline) {
    const block = marked.blocks.find((candidate) => candidate.key === entry.key)
    expect(block).toBeDefined()
    if (block === undefined) continue
    expect(block.kind).toBe('heading')
    expect(block.index).toBe(entry.blockIndex)
    expect(block.plainText).toBe(entry.text)
  }
  // Every text-bearing block keeps the key it had without page marks.
  for (const block of marked.blocks) {
    if (block.kind === 'page') continue
    if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote'
      || block.kind === 'list' || block.kind === 'table') {
      expect(block.key).toBe(blockKey(block.index, block.plainText))
      expect(block.plainText).toBe(runsText(block.runs))
    }
  }
})

test('page marks are annotation-stable across the page-marks preference', () => {
  // Toggling the reader's "show page marks" preference rebuilds the model; a
  // stored annotation/translation blockKey must still resolve afterwards.
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  const annotatedBlock = fixtureModel.blocks.find((block) => block.kind === 'paragraph')
  expect(annotatedBlock).toBeDefined()
  if (annotatedBlock === undefined) return
  const blockWithMarks = marked.blocks.find((block) => block.key === annotatedBlock.key)
  expect(blockWithMarks).toBeDefined()
  if (blockWithMarks === undefined) return
  expect(blockWithMarks.plainText).toBe(annotatedBlock.plainText)
})

test('appendPageMarks never mutates the input model', () => {
  const snapshot = JSON.stringify(fixtureModel)
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  expect(JSON.stringify(fixtureModel)).toBe(snapshot)
  expect(marked).not.toBe(fixtureModel)
})

test('appendPageMarks is idempotent for the same content list', () => {
  const once = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  const twice = appendPageMarks(once, MINERU_CONTENT_LIST)
  expect(twice.blocks).toEqual(once.blocks)
  expect(twice.outline).toEqual(once.outline)
  expect(twice.stats).toEqual(once.stats)
})

test('empty or missing content list returns the model untouched', () => {
  expect(appendPageMarks(fixtureModel, [])).toBe(fixtureModel)
  expect(appendPageMarks(fixtureModel, null)).toBe(fixtureModel)
  expect(appendPageMarks(fixtureModel, undefined)).toBe(fixtureModel)
})

test('content list without page_idx yields no page marks', () => {
  const entries = [
    { type: 'title', text: 'Sparse Routing for Retrieval' },
    { type: 'text', text: 'Ada Lovelace and Grace Hopper' },
  ]
  expect(appendPageMarks(fixtureModel, entries)).toBe(fixtureModel)
})

test('unmatched entry page transition falls back to the next block', () => {
  const model = parseMarkdown('first paragraph\n\nsecond paragraph\n\nthird paragraph')
  const marked = appendPageMarks(model, [
    { type: 'text', text: 'first paragraph', page_idx: 0 },
    { type: 'text', text: 'text that does not exist anywhere', page_idx: 1 },
    { type: 'text', text: 'third paragraph', page_idx: 1 },
  ])
  expect(pageNumbers(marked)).toEqual([1, 2])
  expect(blockAt(marked, 0).kind).toBe('page')
  expect(blockAt(marked, 2).kind).toBe('page')
  expect(blockAt(marked, 3).plainText).toBe('second paragraph')
})

test('image page transition without a matching figure still makes best effort', () => {
  const model = parseMarkdown('first paragraph\n\nsecond paragraph\n\nthird paragraph')
  const marked = appendPageMarks(model, [
    { type: 'text', text: 'first paragraph', page_idx: 0 },
    { type: 'image', img_path: 'images/missing.png', page_idx: 1 },
  ])
  expect(pageNumbers(marked)).toEqual([1, 2])
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  expect(kept.map((block) => block.plainText)).toEqual([
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
  expect(pageNumbers(marked)).toEqual([1, 2])
  const figureIndex = marked.blocks.findIndex((block) => block.kind === 'figure')
  const beforeFigure = blockAt(marked, figureIndex - 1)
  expect(beforeFigure.kind).toBe('page')
  if (beforeFigure.kind === 'page') expect(beforeFigure.page).toBe(2)
})

test('title entries only match headings and list entries only match lists', () => {
  const model = parseMarkdown('## Section A\n\n- item one\n- item two\n\n## Section B')
  const marked = appendPageMarks(model, [
    { type: 'title', text: 'Section A', page_idx: 0 },
    { type: 'list', list_items: ['item one', 'item two'], page_idx: 1 },
    { type: 'title', text: 'Section B', page_idx: 2 },
  ])
  expect(pageNumbers(marked)).toEqual([1, 2, 3])
  const listIndex = marked.blocks.findIndex((block) => block.kind === 'list')
  expect(blockAt(marked, listIndex - 1).kind).toBe('page')
  const sectionBIndex = marked.blocks.findIndex(
    (block) => block.kind === 'heading' && block.plainText === 'Section B',
  )
  const beforeSectionB = blockAt(marked, sectionBIndex - 1)
  expect(beforeSectionB.kind).toBe('page')
  if (beforeSectionB.kind === 'page') expect(beforeSectionB.page).toBe(3)
})

test('page numbers are 1-based display pages', () => {
  const model = parseMarkdown('alpha\n\nbeta\n\ngamma')
  const marked = appendPageMarks(model, [
    { type: 'text', text: 'alpha', page_idx: 0 },
    { type: 'text', text: 'beta', page_idx: 1 },
    { type: 'text', text: 'gamma', page_idx: 2 },
  ])
  expect(pageNumbers(marked)).toEqual([1, 2, 3])
})

test('stats are recomputed after page marks are inserted', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  expect(marked.stats.blocks).toBe(marked.blocks.length)
  expect(marked.stats.blocks).toBe(fixtureModel.stats.blocks + 3)
  expect(marked.stats.headings).toBe(fixtureModel.stats.headings)
  expect(marked.stats.chars).toBe(fixtureModel.stats.chars)
  expect(marked.stats.words).toBe(fixtureModel.stats.words)
})

// ---------------------------------------------------------------------------
// 2.0 extension: page numbers are also filled onto the content blocks.
// ---------------------------------------------------------------------------

test('appendPageMarks fills the display page on every content block', () => {
  const marked = appendPageMarks(fixtureModel, MINERU_CONTENT_LIST)
  let page: number | null = null
  for (const block of marked.blocks) {
    if (block.kind === 'page') {
      page = block.page
      continue
    }
    expect(block.page).toBe(page)
  }
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  expect(kept.every((block) => block.page !== null)).toBe(true)
})

test('the input model keeps page:null blocks (page stays a derived field)', () => {
  const unmarked = parseMarkdown(MINERU_MARKDOWN) as PaperModel
  for (const block of unmarked.blocks) expect(block.page).toBeNull()
})
