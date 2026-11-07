/**
 * Integration test against the shared e2e fixtures (`test/fixtures/paper.md` +
 * `test/fixtures/content_list.json`) — port of
 * `.agents/baseline-1.0.0/test/reader/shared-fixture.test.mjs`.
 *
 * Only structural invariants are asserted (not fixture prose), so small fixture
 * edits do not break it.
 */

import { test, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

import { appendPageMarks, parseMarkdown } from '../../src/shared/markdown/parse.ts'
import type { ContentListEntry } from '../../src/shared/model.ts'
import { assertModelIntegrity } from './helpers.ts'

const markdownUrl = new URL('../fixtures/paper.md', import.meta.url)
const contentListUrl = new URL('../fixtures/content_list.json', import.meta.url)
const fixtureAvailable = existsSync(markdownUrl) && existsSync(contentListUrl)

test('shared fixtures: realistic paper parses into every reader block kind', () => {
  expect(fixtureAvailable).toBe(true)
  const model = parseMarkdown(readFileSync(markdownUrl, 'utf8'))
  assertModelIntegrity(model)
  expect(model.blocks.length).toBeGreaterThan(20)
  const kinds = new Set<string>(model.blocks.map((block) => block.kind))
  for (const kind of ['heading', 'paragraph', 'list', 'quote', 'code', 'formula', 'figure', 'table']) {
    expect(kinds.has(kind), `shared fixture should exercise a ${kind} block`).toBe(true)
  }
  expect(model.outline.length).toBeGreaterThanOrEqual(8)
  expect(model.stats.words).toBeGreaterThan(300)
  const table = model.blocks.find((block) => block.kind === 'table')
  expect(table).toBeDefined()
  if (table === undefined || table.kind !== 'table') return
  expect(table.head.length).toBeGreaterThanOrEqual(2)
  expect(table.rows.length).toBeGreaterThanOrEqual(1)
  const spans = table.head.concat(table.rows.flat())
  expect(spans.some((cell) => cell.colspan > 1), 'fixture table should have a colspan').toBe(true)
  expect(spans.some((cell) => cell.rowspan > 1), 'fixture table should have a rowspan').toBe(true)
  const figure = model.blocks.find((block) => block.kind === 'figure')
  expect(figure).toBeDefined()
  if (figure !== undefined && figure.kind === 'figure') expect(figure.src).toMatch(/images\//)
})

test('shared fixtures: content_list page_idx transitions align page marks', () => {
  expect(fixtureAvailable).toBe(true)
  const model = parseMarkdown(readFileSync(markdownUrl, 'utf8'))
  const contentList = JSON.parse(readFileSync(contentListUrl, 'utf8')) as ContentListEntry[]
  expect(Array.isArray(contentList) && contentList.length > 0).toBe(true)

  const expectedPages: number[] = []
  const seen = new Set<number>()
  for (const entry of contentList) {
    const page = entry === null || typeof entry !== 'object' ? undefined : entry.page_idx
    if (!Number.isFinite(Number(page))) continue
    const display = Math.trunc(Number(page)) + 1
    if (seen.has(display)) continue
    seen.add(display)
    expectedPages.push(display)
  }
  expect(expectedPages.length, 'fixture should span multiple pages').toBeGreaterThanOrEqual(2)

  const snapshot = JSON.stringify(model)
  const marked = appendPageMarks(model, contentList)
  assertModelIntegrity(marked)
  expect(JSON.stringify(model), 'appendPageMarks must not mutate its input').toBe(snapshot)

  const pages = marked.blocks.filter((block) => block.kind === 'page').map((block) => block.page)
  expect(pages).toEqual(expectedPages)
  expect(marked.blocks[0]?.kind).toBe('page')
  expect(marked.blocks[0]?.page).toBe(expectedPages[0])

  // No parser block was dropped or reordered, and annotation anchors are stable.
  const original = model.blocks
  const kept = marked.blocks.filter((block) => block.kind !== 'page')
  expect(kept.length).toBe(original.length)
  for (let index = 0; index < original.length; index += 1) {
    expect(kept[index]?.kind).toBe(original[index]?.kind)
    expect(kept[index]?.index).toBe(original[index]?.index)
    expect(kept[index]?.key).toBe(original[index]?.key)
    expect(kept[index]?.plainText).toBe(original[index]?.plainText)
  }
  // Outline entries are carried over unchanged and resolve by key.
  expect(marked.outline).toEqual(model.outline)
  for (const entry of marked.outline) {
    const block = marked.blocks.find((candidate) => candidate.key === entry.key)
    expect(block).toBeDefined()
    if (block === undefined) continue
    expect(block.kind).toBe('heading')
    expect(block.index).toBe(entry.blockIndex)
  }
})
