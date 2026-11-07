/**
 * Page-scoped repair for parsed documents (typed 1.0.0 port).
 *
 * MinerU's standard API accepts `page_ranges`, so a document with a few
 * unreadable glyphs (U+FFFD) on some pages can be re-parsed page-by-page. The
 * result archive then contains ONLY the requested pages; this module splices
 * those pages back into the existing parse so every other page (and every
 * annotation anchored to it) stays byte-identical.
 *
 * Alignment strategy: `content_list.json` gives each block's `page_idx` in
 * document order. Walking the markdown line by line and matching each entry's
 * normalized text prefix yields the first markdown line of every page, which is
 * enough to turn both documents into ordered page chunks. Unalignable pages are
 * left untouched and reported as failed rather than risking a wrong splice.
 *
 * Library audit (1.0.0): this is pure domain mapping — page scoping comes from
 * MinerU's `page_idx`, the splice unit is a line range, and the merge is a
 * structural content-list join. A text-diff library (jsdiff) has no semantic
 * hook here (the new archive is a subset with renumbered pages, not an edited
 * text), so the mature-algorithm replacement in `ALGORITHMS.md` does not apply;
 * the frozen behaviour is preserved 1:1.
 *
 * @module host/parse/page-merge
 */

import type { ContentListEntry } from '../../shared/model.ts'

/** Replacement character emitted by MinerU for glyphs it could not map. */
const REPLACEMENT = '\ufffd'

/** Entry fields that carry searchable text, in preference order. */
const TEXT_FIELDS = ['text', 'table_body', 'code_body', 'latex'] as const

/** Caption/footnote fields joined when an entry has no primary text. */
const CAPTION_FIELDS = ['image_caption', 'table_caption', 'image_footnote', 'table_footnote'] as const

/** One page-range of a markdown document: 1-based page → inclusive line range. */
export interface PageLineRange {
  startLine: number
  endLine: number
}

/** Result of {@link splitMarkdownByPage}. */
export interface PageSplit {
  lines: string[]
  ranges: Map<number, PageLineRange>
  failedPages: number[]
  pageCount: number
}

/** Input of {@link mergeRepairedPages}. */
export interface MergeRepairedPagesInput {
  oldMarkdown: string
  oldContentList: unknown
  newMarkdown: string
  newContentList: unknown
  targetPages: unknown
}

/** Result of {@link mergeRepairedPages}. */
export interface MergeRepairedPagesResult {
  markdown: string
  contentList: ContentListEntry[]
  replacedPages: number[]
  failedPages: number[]
}

/** Decode the small HTML entity set MinerU emits, then strip tags. */
function stripMarkup(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (match, code: string) => {
      const value = Number(code)
      return Number.isFinite(value) ? String.fromCodePoint(value) : match
    })
}

/** Normalize text for loose line matching (case/space/punctuation-insensitive). */
function normalizeForMatch(value: unknown): string {
  return stripMarkup(value)
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[^0-9a-z\u00e0-\u024f\u4e00-\u9fff]+/g, '')
}

/** Searchable text of one content-list entry, or '' when it has none. */
function entryText(entry: unknown): string {
  if (entry === null || typeof entry !== 'object') return ''
  const record = entry as Record<string, unknown>
  for (const field of TEXT_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const captions: string[] = []
  for (const field of CAPTION_FIELDS) {
    const value = record[field]
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') captions.push(item)
    } else if (typeof value === 'string') captions.push(value)
  }
  return captions.join(' ')
}

/** Zero-based page index of one content-list entry, or null. */
function entryPage(entry: unknown): number | null {
  if (entry === null || typeof entry !== 'object') return null
  const value = Number((entry as { page_idx?: unknown }).page_idx)
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Coerce an unknown value into a typed content-list entry (only known fields). */
function asContentEntry(entry: unknown): ContentListEntry {
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    return entry as ContentListEntry
  }
  return {}
}

/** 1-based display page numbers that contain U+FFFD in their content-list text. */
export function problemPages(contentList: unknown): number[] {
  if (!Array.isArray(contentList)) return []
  const pages = new Set<number>()
  for (const entry of contentList) {
    const page = entryPage(entry)
    if (page === null) continue
    const record = entry as Record<string, unknown>
    let haystack = ''
    for (const field of TEXT_FIELDS) {
      if (typeof record[field] === 'string') haystack += ` ${String(record[field])}`
    }
    for (const field of ['image_caption', 'table_caption'] as const) {
      const value = record[field]
      if (Array.isArray(value)) haystack += ` ${value.join(' ')}`
    }
    if (haystack.indexOf(REPLACEMENT) !== -1) pages.add(page + 1)
  }
  return [...pages].sort((a, b) => a - b)
}

/**
 * Split markdown into ordered page chunks using the content list.
 *
 * @param markdown - full markdown text.
 * @param contentList - parsed `content_list.json` array.
 * @returns 1-based page → inclusive line range, plus pages that could not align.
 */
export function splitMarkdownByPage(markdown: unknown, contentList: unknown): PageSplit {
  const lines = String(markdown ?? '').split('\n')
  const entries: Array<{ page: number; needle: string }> = []
  if (Array.isArray(contentList)) {
    for (const entry of contentList) {
      const page = entryPage(entry)
      if (page === null) continue
      const needle = normalizeForMatch(entryText(entry)).slice(0, 32)
      if (needle.length < 6) continue
      entries.push({ page: page + 1, needle })
    }
  }
  const pageStarts = new Map<number, number>()
  let cursor = 0
  for (const entry of entries) {
    if (pageStarts.has(entry.page)) continue
    const limit = Math.min(lines.length, cursor + 240)
    let found = -1
    for (let lineIndex = cursor; lineIndex < limit; lineIndex += 1) {
      if (normalizeForMatch(lines[lineIndex]).includes(entry.needle)) {
        found = lineIndex
        break
      }
    }
    if (found === -1) continue
    pageStarts.set(entry.page, found)
    cursor = found + 1
  }
  const pageNumbers = [...pageStarts.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([page]) => page)
  const ranges = new Map<number, PageLineRange>()
  for (let index = 0; index < pageNumbers.length; index += 1) {
    const page = pageNumbers[index]
    if (page === undefined) continue
    const startLine = pageStarts.get(page) ?? 0
    const nextPage = pageNumbers[index + 1]
    const nextStart = nextPage === undefined ? lines.length : (pageStarts.get(nextPage) ?? lines.length)
    ranges.set(page, { startLine, endLine: Math.max(startLine, nextStart - 1) })
  }
  const pageCount = Array.isArray(contentList)
    ? contentList.reduce((max: number, entry: unknown) => {
        const page = entryPage(entry)
        return page === null ? max : Math.max(max, page + 1)
      }, 0)
    : 0
  const failedPages: number[] = []
  for (let page = 1; page <= pageCount; page += 1) {
    if (!ranges.has(page)) failedPages.push(page)
  }
  return { lines, ranges, failedPages, pageCount }
}

/** Group content-list entries by zero-based page index, keeping order. */
function groupByPage(contentList: ContentListEntry[]): {
  groups: Map<number, ContentListEntry[]>
  loose: ContentListEntry[]
} {
  const groups = new Map<number, ContentListEntry[]>()
  const loose: ContentListEntry[] = []
  for (const entry of contentList) {
    const page = entryPage(entry)
    if (page === null) {
      loose.push(entry)
      continue
    }
    const group = groups.get(page)
    if (group === undefined) groups.set(page, [entry])
    else group.push(entry)
  }
  return { groups, loose }
}

/** Map requested 1-based pages to the new archive's page keys (in order). */
function mapNewPages(targets: number[], newPageKeys: number[]): Map<number, number> {
  const map = new Map<number, number>()
  if (newPageKeys.length === 0) return map
  if (newPageKeys.length === targets.length) {
    targets.forEach((target, index) => {
      const key = newPageKeys[index]
      if (key !== undefined) map.set(target, key)
    })
    return map
  }
  const asSubset = targets.every((target) => newPageKeys.includes(target))
  if (asSubset) {
    targets.forEach((target) => map.set(target, target))
    return map
  }
  // MinerU normally renumbers the requested pages from 0; pair them in order.
  const count = Math.min(targets.length, newPageKeys.length)
  for (let index = 0; index < count; index += 1) {
    const target = targets[index]
    const key = newPageKeys[index]
    if (target !== undefined && key !== undefined) map.set(target, key)
  }
  return map
}

/** Normalize a list of page numbers: positive integers, de-duplicated, sorted. */
function sortPages(pages: unknown): number[] {
  const values = Array.isArray(pages) ? pages : []
  const unique = new Set<number>()
  for (const page of values) {
    const value = Math.floor(Number(page))
    if (Number.isInteger(value) && value >= 1) unique.add(value)
  }
  return [...unique].sort((a, b) => a - b)
}

/** One ordered chunk of the old markdown: `page` is null for inter-page lines. */
interface MarkdownChunk {
  page: number | null
  lines: string[]
}

/**
 * Splice repaired pages into an existing parse.
 *
 * @param input - old/new markdown and content lists plus the target page numbers.
 * @returns merged markdown + content list, the replaced pages and the pages that
 *   could not be aligned (left untouched).
 */
export function mergeRepairedPages(input: MergeRepairedPagesInput): MergeRepairedPagesResult {
  const oldMarkdown = String(input.oldMarkdown ?? '')
  const newMarkdown = String(input.newMarkdown ?? '')
  const oldContentList = Array.isArray(input.oldContentList) ? (input.oldContentList as ContentListEntry[]) : []
  const newContentList = Array.isArray(input.newContentList) ? (input.newContentList as ContentListEntry[]) : []
  const targets = sortPages(input.targetPages)

  const oldSplit = splitMarkdownByPage(oldMarkdown, oldContentList)
  const newSplit = splitMarkdownByPage(newMarkdown, newContentList)
  const newPageKeys = [...newSplit.ranges.entries()]
    .sort((left, right) => left[1].startLine - right[1].startLine)
    .map(([page]) => page)
  const newPageMap = mapNewPages(targets, newPageKeys)
  const oldRanges = [...oldSplit.ranges.entries()]
    .map(([page, range]) => ({ page, ...range }))
    .sort((left, right) => left.startLine - right.startLine)

  const chunks: MarkdownChunk[] = []
  let cursor = 0
  for (const range of oldRanges) {
    if (range.startLine > cursor) chunks.push({ page: null, lines: oldSplit.lines.slice(cursor, range.startLine) })
    chunks.push({ page: range.page, lines: oldSplit.lines.slice(range.startLine, range.endLine + 1) })
    cursor = Math.max(cursor, range.endLine + 1)
  }
  if (cursor < oldSplit.lines.length) chunks.push({ page: null, lines: oldSplit.lines.slice(cursor) })

  const replacedPages: number[] = []
  const failedPages: number[] = []
  const outputChunks: MarkdownChunk[] = chunks.map((chunk) => {
    if (chunk.page === null || !targets.includes(chunk.page)) return chunk
    const newPage = newPageMap.get(chunk.page)
    const newRange = newPage === undefined ? undefined : newSplit.ranges.get(newPage)
    if (newRange === undefined) {
      failedPages.push(chunk.page)
      return chunk
    }
    replacedPages.push(chunk.page)
    return { page: chunk.page, lines: newSplit.lines.slice(newRange.startLine, newRange.endLine + 1) }
  })

  const outputLines: string[] = []
  for (const chunk of outputChunks) {
    if (chunk.lines.length === 0) continue
    const last = outputLines[outputLines.length - 1]
    if (outputLines.length > 0 && last !== undefined && last !== '') outputLines.push('')
    outputLines.push(...chunk.lines)
  }
  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === '') outputLines.pop()

  // Merge the content list: untouched pages keep their original entries
  // (including page_idx), repaired pages take the new entries with their
  // page_idx remapped to the original page number.
  const oldGroups = groupByPage(oldContentList)
  const newGroups = groupByPage(newContentList)
  const oldPages = [...oldGroups.groups.keys()].sort((a, b) => a - b)
  const merged: ContentListEntry[] = []
  for (const pageIndex of oldPages) {
    const displayPage = pageIndex + 1
    const replaced = replacedPages.includes(displayPage)
    const newPage = newPageMap.get(displayPage)
    const oldEntries = oldGroups.groups.get(pageIndex) ?? []
    if (replaced && newPage !== undefined && newGroups.groups.has(newPage - 1)) {
      for (const entry of newGroups.groups.get(newPage - 1) ?? []) {
        merged.push({ ...entry, page_idx: pageIndex })
      }
    } else {
      merged.push(...oldEntries)
    }
  }
  // Pages present only in the repaired archive (should not happen) are kept.
  for (const pageIndex of [...newGroups.groups.keys()].sort((a, b) => a - b)) {
    if (oldGroups.groups.has(pageIndex)) continue
    for (const entry of newGroups.groups.get(pageIndex) ?? []) {
      const displayPage = pageIndex + 1
      merged.push(replacedPages.includes(displayPage) ? { ...entry, page_idx: pageIndex } : entry)
    }
  }
  merged.push(...oldGroups.loose)

  return { markdown: `${outputLines.join('\n')}\n`, contentList: merged, replacedPages, failedPages }
}

/**
 * Compress 1-based page numbers into a MinerU `page_ranges` string ("2,4-6").
 *
 * @param pages - page numbers in any order (duplicates allowed).
 * @returns the compressed range string.
 */
export function toPageRanges(pages: unknown): string {
  const sorted = sortPages(pages)
  const parts: string[] = []
  let start: number | null = null
  let previous: number | null = null
  for (const page of sorted) {
    if (start === null || previous === null) {
      start = page
      previous = page
      continue
    }
    if (page === previous + 1) {
      previous = page
      continue
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`)
    start = page
    previous = page
  }
  if (start !== null && previous !== null) parts.push(start === previous ? String(start) : `${start}-${previous}`)
  return parts.join(',')
}

/** Type-level helper: coerce an unknown content-list array to typed entries. */
export function contentListOf(value: unknown): ContentListEntry[] {
  return Array.isArray(value) ? value.map(asContentEntry) : []
}
