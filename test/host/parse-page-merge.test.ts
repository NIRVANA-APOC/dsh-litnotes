/**
 * Unit tests for page-scoped repair (`src/host/parse/page-merge.ts`): page
 * alignment from `content_list.json` and splicing re-parsed pages back into an
 * existing parse without touching the other pages.
 *
 * Ported from the frozen `test/unit/page-merge.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ContentListEntry } from '../../src/shared/model.ts'
import {
  mergeRepairedPages,
  problemPages,
  splitMarkdownByPage,
  toPageRanges,
} from '../../src/host/parse/page-merge.ts'

/** Build a three-page synthetic document: markdown + matching content list. */
function makeDocument(): { markdown: string; contentList: ContentListEntry[] } {
  const markdown = [
    '# A Paper Title',
    '',
    'Authors and affiliations line here.',
    '',
    '## 1 Introduction',
    '',
    'This introduction lives on page one and stays untouched.',
    '',
    '## 2 Method',
    '',
    'The method section is on page two with a broken symbol \ufffd here.',
    '',
    '## 3 Results',
    '',
    'Results are on page three and must survive the repair.',
    '',
  ].join('\n')
  const contentList: ContentListEntry[] = [
    { type: 'text', text: 'A Paper Title', text_level: 1, page_idx: 0 },
    { type: 'text', text: 'Authors and affiliations line here.', page_idx: 0 },
    { type: 'text', text: '1 Introduction', text_level: 2, page_idx: 0 },
    { type: 'text', text: 'This introduction lives on page one and stays untouched.', page_idx: 0 },
    { type: 'text', text: '2 Method', text_level: 2, page_idx: 1 },
    { type: 'text', text: 'The method section is on page two with a broken symbol \ufffd here.', page_idx: 1 },
    { type: 'text', text: '3 Results', text_level: 2, page_idx: 2 },
    { type: 'text', text: 'Results are on page three and must survive the repair.', page_idx: 2 },
  ]
  return { markdown, contentList }
}

/** Simulate MinerU's page-ranged repair archive (page 2 only, renumbered). */
function makeRepairedPageTwo(): { markdown: string; contentList: ContentListEntry[] } {
  const markdown = [
    '## 2 Method',
    '',
    'The method section is on page two with a recovered symbol q here.',
    '',
  ].join('\n')
  const contentList: ContentListEntry[] = [
    { type: 'text', text: '2 Method', text_level: 2, page_idx: 0 },
    { type: 'text', text: 'The method section is on page two with a recovered symbol q here.', page_idx: 0 },
  ]
  return { markdown, contentList }
}

test('problemPages reports the pages whose content list text contains U+FFFD', () => {
  const { contentList } = makeDocument()
  assert.deepEqual(problemPages(contentList), [2])
  assert.deepEqual(problemPages([]), [])
  assert.deepEqual(problemPages(null), [])
})

test('splitMarkdownByPage aligns page chunks from content_list order', () => {
  const { markdown, contentList } = makeDocument()
  const split = splitMarkdownByPage(markdown, contentList)
  assert.equal(split.pageCount, 3)
  assert.deepEqual([...split.ranges.keys()], [1, 2, 3])
  const pageTwo = split.ranges.get(2)
  assert.ok(pageTwo !== undefined)
  assert.equal(split.lines[pageTwo.startLine]?.trim(), '## 2 Method')
  assert.ok(split.failedPages.length === 0)
})

test('mergeRepairedPages replaces only the requested page and keeps the rest', () => {
  const oldDoc = makeDocument()
  const pageTwo = makeRepairedPageTwo()
  const merged = mergeRepairedPages({
    oldMarkdown: oldDoc.markdown,
    oldContentList: oldDoc.contentList,
    newMarkdown: pageTwo.markdown,
    newContentList: pageTwo.contentList,
    targetPages: [2],
  })
  assert.deepEqual(merged.replacedPages, [2])
  assert.deepEqual(merged.failedPages, [])
  // Page 2 is repaired…
  assert.ok(merged.markdown.includes('recovered symbol q'))
  assert.ok(!merged.markdown.includes('\ufffd'))
  // …while page 1 and page 3 are byte-identical.
  assert.ok(merged.markdown.includes('This introduction lives on page one and stays untouched.'))
  assert.ok(merged.markdown.includes('Results are on page three and must survive the repair.'))
  assert.ok(merged.markdown.indexOf('# A Paper Title') < merged.markdown.indexOf('## 2 Method'))
  assert.ok(merged.markdown.indexOf('## 3 Results') > merged.markdown.indexOf('## 2 Method'))
  // The content list is merged with the original page indices.
  for (const entry of merged.contentList) {
    if (typeof entry.text === 'string' && entry.text.includes('recovered symbol q')) {
      assert.equal(entry.page_idx, 1)
    }
  }
  const pageIdx = new Set(merged.contentList.map((entry) => entry.page_idx))
  assert.deepEqual([...pageIdx].sort((a, b) => Number(a) - Number(b)), [0, 1, 2])
})

test('mergeRepairedPages leaves an unalignable page untouched and reports it', () => {
  const oldDoc = makeDocument()
  // The repair archive's content list cannot be aligned with its markdown, so
  // the page must be reported as failed instead of being spliced blindly.
  const merged = mergeRepairedPages({
    oldMarkdown: oldDoc.markdown,
    oldContentList: oldDoc.contentList,
    newMarkdown: '## 2 Method\n\nCompletely different wording.\n',
    newContentList: [{ type: 'text', text: 'text that never appears in the repaired markdown', page_idx: 0 }],
    targetPages: [2],
  })
  assert.deepEqual(merged.replacedPages, [])
  assert.deepEqual(merged.failedPages, [2])
  assert.equal(merged.markdown, oldDoc.markdown)
  assert.equal(merged.contentList.length, oldDoc.contentList.length)
})

test('mergeRepairedPages handles original page indices from the repair archive', () => {
  const oldDoc = makeDocument()
  const repaired = {
    markdown: '## 2 Method\n\nThe method section is on page two with a recovered symbol q here.\n',
    contentList: [
      { type: 'text', text: '2 Method', text_level: 2, page_idx: 1 },
      { type: 'text', text: 'The method section is on page two with a recovered symbol q here.', page_idx: 1 },
    ],
  }
  const merged = mergeRepairedPages({
    oldMarkdown: oldDoc.markdown,
    oldContentList: oldDoc.contentList,
    newMarkdown: repaired.markdown,
    newContentList: repaired.contentList,
    targetPages: [2],
  })
  assert.deepEqual(merged.replacedPages, [2])
  assert.ok(merged.markdown.includes('recovered symbol q'))
})

test('toPageRanges compresses contiguous page lists', () => {
  assert.equal(toPageRanges([2]), '2')
  assert.equal(toPageRanges([2, 4, 5, 6]), '2,4-6')
  assert.equal(toPageRanges([1, 2, 3]), '1-3')
  assert.equal(toPageRanges([]), '')
  assert.equal(toPageRanges([3, 1, 2, 2]), '1-3')
})

test('mergeRepairedPages tolerates missing / malformed input', () => {
  const merged = mergeRepairedPages({
    oldMarkdown: '',
    oldContentList: null,
    newMarkdown: '',
    newContentList: undefined,
    targetPages: 'nope',
  })
  assert.deepEqual(merged.replacedPages, [])
  assert.deepEqual(merged.failedPages, [])
  assert.equal(merged.contentList.length, 0)
})

test('multiple target pages splice in order and keep untouched pages', () => {
  const oldDoc = makeDocument()
  const repaired = {
    markdown: '## 2 Method\n\nRecovered page two body text here.\n\n## 3 Results\n\nRecovered page three body text here.\n',
    contentList: [
      { type: 'text', text: '2 Method', text_level: 2, page_idx: 0 },
      { type: 'text', text: 'Recovered page two body text here.', page_idx: 0 },
      { type: 'text', text: '3 Results', text_level: 2, page_idx: 1 },
      { type: 'text', text: 'Recovered page three body text here.', page_idx: 1 },
    ],
  }
  const merged = mergeRepairedPages({
    oldMarkdown: oldDoc.markdown,
    oldContentList: oldDoc.contentList,
    newMarkdown: repaired.markdown,
    newContentList: repaired.contentList,
    targetPages: [3, 2],
  })
  assert.deepEqual(merged.replacedPages, [2, 3])
  assert.ok(merged.markdown.includes('Recovered page two body text here.'))
  assert.ok(merged.markdown.includes('Recovered page three body text here.'))
  assert.ok(merged.markdown.includes('This introduction lives on page one and stays untouched.'))
  assert.ok(merged.markdown.indexOf('## 2 Method') < merged.markdown.indexOf('## 3 Results'))
})
