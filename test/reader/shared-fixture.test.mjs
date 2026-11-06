/**
 * Integration test against the shared e2e fixtures produced by test-harness
 * (test/fixtures/paper.md + content_list.json). The test is skipped until those
 * files exist, and only asserts structural invariants (not fixture prose), so
 * small fixture edits do not break it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { reader, assertModelIntegrity } from './helpers.mjs'

const markdownUrl = new URL('../fixtures/paper.md', import.meta.url)
const contentListUrl = new URL('../fixtures/content_list.json', import.meta.url)
const fixtureAvailable = existsSync(markdownUrl) && existsSync(contentListUrl)

test('shared fixtures: realistic paper parses into every reader block kind', { skip: fixtureAvailable ? false : 'test/fixtures not available yet' }, () => {
  const model = reader.parseMarkdown(readFileSync(markdownUrl, 'utf8'))
  assertModelIntegrity(assert, model)
  assert.ok(model.blocks.length > 20)
  const kinds = new Set(model.blocks.map((block) => block.kind))
  for (const kind of ['heading', 'paragraph', 'list', 'quote', 'code', 'formula', 'figure', 'table']) {
    assert.ok(kinds.has(kind), `shared fixture should exercise a ${kind} block`)
  }
  assert.ok(model.outline.length >= 8)
  assert.ok(model.stats.words > 300)
  const table = model.blocks.find((block) => block.kind === 'table')
  assert.ok(table.head.length >= 2)
  assert.ok(table.rows.length >= 1)
  const spans = table.head.concat(table.rows.flat())
  assert.ok(spans.some((cell) => cell.colspan > 1), 'fixture table should have a colspan')
  assert.ok(spans.some((cell) => cell.rowspan > 1), 'fixture table should have a rowspan')
  const figure = model.blocks.find((block) => block.kind === 'figure')
  assert.match(figure.src, /images\//)
})

test('shared fixtures: content_list page_idx transitions align page marks', { skip: fixtureAvailable ? false : 'test/fixtures not available yet' }, () => {
  const model = reader.parseMarkdown(readFileSync(markdownUrl, 'utf8'))
  const contentList = JSON.parse(readFileSync(contentListUrl, 'utf8'))
  assert.ok(Array.isArray(contentList) && contentList.length > 0)

  const expectedPages = []
  const seen = new Set()
  for (const entry of contentList) {
    const page = entry === null || typeof entry !== 'object' ? undefined : entry.page_idx
    if (!Number.isFinite(Number(page))) continue
    const display = Math.trunc(Number(page)) + 1
    if (seen.has(display)) continue
    seen.add(display)
    expectedPages.push(display)
  }
  assert.ok(expectedPages.length >= 2, 'fixture should span multiple pages')

  const snapshot = JSON.stringify(model)
  const marked = reader.appendPageMarks(model, contentList)
  assertModelIntegrity(assert, marked)
  assert.equal(JSON.stringify(model), snapshot, 'appendPageMarks must not mutate its input')

  const pages = marked.blocks.filter((block) => block.kind === 'page').map((block) => block.page)
  assert.deepEqual(pages, expectedPages)
  assert.equal(marked.blocks[0].kind, 'page')
  assert.equal(marked.blocks[0].page, expectedPages[0])

  // No parser block was dropped or reordered, and annotation anchors are stable.
  const original = model.blocks
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  assert.equal(kept.length, original.length)
  for (let i = 0; i < original.length; i += 1) {
    assert.equal(kept[i].kind, original[i].kind)
    assert.equal(kept[i].index, original[i].index)
    assert.equal(kept[i].key, original[i].key)
    assert.equal(kept[i].plainText, original[i].plainText)
  }
  // Outline entries are carried over unchanged and resolve by key.
  assert.deepEqual(marked.outline, model.outline)
  for (const entry of marked.outline) {
    const block = marked.blocks.find((candidate) => candidate.key === entry.key)
    assert.ok(block)
    assert.equal(block.kind, 'heading')
    assert.equal(block.index, entry.blockIndex)
  }
})
