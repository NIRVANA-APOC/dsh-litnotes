/**
 * Frozen 1.0.0 parity snapshot.
 *
 * `snapshots/paper-model.snapshot.json` was generated from the frozen
 * `.agents/baseline-1.0.0/ui/markdown.js` parser (the v1.0.0 executable spec)
 * for the two shared fixtures, with and without MinerU page marks. 1.0.0 owns the
 * same contract through @see src/shared/markdown/parse.ts, so block kinds, block
 * keys (the only annotation anchor), outline entries and stats must stay
 * byte-identical: an existing user library's annotations/translations must keep
 * resolving after the upgrade without a migration.
 */

import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { appendPageMarks, parseMarkdown } from '../../src/shared/markdown/parse.ts'
import type { ContentListEntry } from '../../src/shared/model.ts'
import { MINERU_CONTENT_LIST, MINERU_MARKDOWN } from './fixtures.ts'

interface FrozenSnapshot {
  blockKeys: string[]
  pageNumbers?: number[]
  outline: string[]
  stats: { blocks: number; headings: number; chars: number; words: number }
}

interface SnapshotFile {
  fixtures: Record<string, { plain: FrozenSnapshot; pageMarked: FrozenSnapshot }>
}

const snapshot = JSON.parse(
  readFileSync(new URL('./snapshots/paper-model.snapshot.json', import.meta.url), 'utf8'),
) as SnapshotFile

const paperMarkdown = readFileSync(new URL('../fixtures/paper.md', import.meta.url), 'utf8')
const paperContentList = JSON.parse(
  readFileSync(new URL('../fixtures/content_list.json', import.meta.url), 'utf8'),
) as ContentListEntry[]

/** Block kinds whose `plainText` is the annotation offset space (compared verbatim). */
const TEXT_KINDS: ReadonlySet<string> = new Set(['heading', 'paragraph', 'list', 'quote', 'table'])

/** Canonical comparable text: text kinds compare plainText, code compares source, payloads by key. */
function canonicalText(block: { kind: string; plainText: string; code?: string }): string {
  if (TEXT_KINDS.has(block.kind)) return block.plainText
  if (block.kind === 'code') return block.code ?? ''
  return ''
}

/** `kind\0key\0canonicalText` per block (matches the snapshot generator). */
function blockKeyLines(markdown: string, contentList: ContentListEntry[] | null): string[] {
  const model = parseMarkdown(markdown)
  const marked = contentList === null ? model : appendPageMarks(model, contentList)
  return marked.blocks.map((block) => `${block.kind}\u0000${block.key}\u0000${canonicalText(block as { kind: string; plainText: string; code?: string })}`)
}

/** Assert one fixture against its frozen snapshot (plain + page-marked). */
function expectParity(fixtureKey: string, markdown: string, contentList: ContentListEntry[] | null): void {
  const frozen = snapshot.fixtures[fixtureKey]
  expect(frozen, `snapshot has no fixture ${fixtureKey}`).toBeDefined()
  if (frozen === undefined) return

  const model = parseMarkdown(markdown)
  // Plain parse: kind/key/plainText in order.
  expect(blockKeyLines(markdown, null)).toEqual(frozen.plain.blockKeys)
  // Outline entries (keys are the annotation/translation anchors).
  expect(model.outline.map((entry) => `${entry.key}\u0000${entry.level}\u0000${entry.blockIndex}\u0000${entry.text}`))
    .toEqual(frozen.plain.outline)
  expect(model.stats).toEqual(frozen.plain.stats)

  if (contentList === null) return
  // Page-marked parse: page marks are display-only, original anchors unchanged.
  const marked = appendPageMarks(model, contentList)
  expect(blockKeyLines(markdown, contentList)).toEqual(frozen.pageMarked.blockKeys)
  expect(marked.blocks.filter((block) => block.kind === 'page').map((block) => block.page))
    .toEqual(frozen.pageMarked.pageNumbers)
  expect(marked.outline.map((entry) => `${entry.key}\u0000${entry.level}\u0000${entry.blockIndex}\u0000${entry.text}`))
    .toEqual(frozen.pageMarked.outline)
  expect(marked.stats).toEqual(frozen.pageMarked.stats)
}

test('fixture paper: block kinds, keys, outline and stats match frozen 1.0.0 (plain + page marks)', () => {
  expectParity('test/fixtures/paper.md', paperMarkdown, paperContentList)
})

test('MinerU fixture: block kinds, keys, outline and stats match frozen 1.0.0 (plain + page marks)', () => {
  expectParity('MINERU_MARKDOWN', MINERU_MARKDOWN, MINERU_CONTENT_LIST)
})
