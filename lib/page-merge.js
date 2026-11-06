/**
 * Page-scoped repair for parsed documents.
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
 * @module lib/page-merge
 */

/** Replacement character emitted by MinerU for glyphs it could not map. */
const REPLACEMENT = '\ufffd'

/** Entry fields that carry searchable text, in preference order. */
const TEXT_FIELDS = ['text', 'table_body', 'code_body', 'latex']

/** Decode the small HTML entity set MinerU emits, then strip tags. */
function stripMarkup(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const value = Number(code)
      return Number.isFinite(value) ? String.fromCodePoint(value) : match
    })
}

/** Normalize text for loose line matching (case/space/punctuation-insensitive). */
function normalizeForMatch(value) {
  return stripMarkup(value)
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[^0-9a-z\u00e0-\u024f\u4e00-\u9fff]+/g, '')
}

/** Searchable text of one content_list entry, or '' when it has none. */
function entryText(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  for (const field of TEXT_FIELDS) {
    const value = entry[field]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const captions = []
  for (const field of ['image_caption', 'table_caption', 'image_footnote', 'table_footnote']) {
    const value = entry[field]
    if (Array.isArray(value)) captions.push(...value.filter((item) => typeof item === 'string'))
    else if (typeof value === 'string') captions.push(value)
  }
  return captions.join(' ')
}

/** Zero-based page index of one content_list entry, or null. */
function entryPage(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const value = Number(entry.page_idx)
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** 1-based display page numbers that contain U+FFFD in their content list text. */
export function problemPages(contentList) {
  if (!Array.isArray(contentList)) return []
  const pages = new Set()
  for (const entry of contentList) {
    const page = entryPage(entry)
    if (page === null) continue
    let haystack = ''
    for (const field of TEXT_FIELDS) {
      if (typeof entry[field] === 'string') haystack += ` ${entry[field]}`
    }
    for (const field of ['image_caption', 'table_caption']) {
      const value = entry[field]
      if (Array.isArray(value)) haystack += ` ${value.join(' ')}`
    }
    if (haystack.indexOf(REPLACEMENT) !== -1) pages.add(page + 1)
  }
  return [...pages].sort((a, b) => a - b)
}

/**
 * Split markdown into ordered page chunks using the content list.
 *
 * @param {string} markdown - full markdown text.
 * @param {object[]} contentList - parsed content_list.json array.
 * @returns {{
 *   lines: string[],
 *   ranges: Map<number, { startLine: number, endLine: number }>,
 *   failedPages: number[],
 *   pageCount: number,
 * }} 1-based page → line range (inclusive), plus pages that could not align.
 */
export function splitMarkdownByPage(markdown, contentList) {
  const lines = String(markdown ?? '').split('\n')
  const entries = []
  if (Array.isArray(contentList)) {
    for (const entry of contentList) {
      const page = entryPage(entry)
      if (page === null) continue
      const needle = normalizeForMatch(entryText(entry)).slice(0, 32)
      if (needle.length < 6) continue
      entries.push({ page: page + 1, needle })
    }
  }
  const pageStarts = new Map()
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
  const pageNumbers = [...pageStarts.keys()].sort((a, b) => pageStarts.get(a) - pageStarts.get(b));
  const ranges = new Map()
  for (let index = 0; index < pageNumbers.length; index += 1) {
    const page = pageNumbers[index]
    const startLine = pageStarts.get(page)
    const nextStart = index + 1 < pageNumbers.length ? pageStarts.get(pageNumbers[index + 1]) : lines.length
    ranges.set(page, { startLine, endLine: Math.max(startLine, nextStart - 1) })
  }
  const pageCount = Array.isArray(contentList)
    ? contentList.reduce((max, entry) => {
      const page = entryPage(entry)
      return page === null ? max : Math.max(max, page + 1)
    }, 0)
    : 0
  const failedPages = []
  for (let page = 1; page <= pageCount; page += 1) {
    if (!ranges.has(page)) failedPages.push(page)
  }
  return { lines, ranges, failedPages, pageCount }
}

/** Group content-list entries by zero-based page index, keeping order. */
function groupByPage(contentList) {
  const groups = new Map()
  const loose = []
  if (Array.isArray(contentList)) {
    for (const entry of contentList) {
      const page = entryPage(entry)
      if (page === null) { loose.push(entry); continue }
      if (!groups.has(page)) groups.set(page, [])
      groups.get(page).push(entry)
    }
  }
  return { groups, loose }
}

/** Map requested 1-based pages to the new archive's page keys (in order). */
function mapNewPages(targets, newPageKeys) {
  const map = new Map()
  if (newPageKeys.length === 0) return map
  if (newPageKeys.length === targets.length) {
    targets.forEach((target, index) => map.set(target, newPageKeys[index]))
    return map
  }
  const asSubset = targets.every((target) => newPageKeys.includes(target))
  if (asSubset) {
    targets.forEach((target) => map.set(target, target))
    return map
  }
  // MinerU normally renumbers the requested pages from 0; pair them in order.
  const count = Math.min(targets.length, newPageKeys.length)
  for (let index = 0; index < count; index += 1) map.set(targets[index], newPageKeys[index])
  return map
}

/**
 * Splice repaired pages into an existing parse.
 *
 * @param {{
 *   oldMarkdown: string,
 *   oldContentList: object[],
 *   newMarkdown: string,
 *   newContentList: object[],
 *   targetPages: number[],
 * }} input
 * @returns {{
 *   markdown: string,
 *   contentList: object[],
 *   replacedPages: number[],
 *   failedPages: number[],
 * }}
 */
export function mergeRepairedPages(input) {
  const oldMarkdown = String(input.oldMarkdown ?? '')
  const newMarkdown = String(input.newMarkdown ?? '')
  const oldContentList = Array.isArray(input.oldContentList) ? input.oldContentList : []
  const newContentList = Array.isArray(input.newContentList) ? input.newContentList : []
  const targets = [...new Set((Array.isArray(input.targetPages) ? input.targetPages : [])
    .map((page) => Math.floor(Number(page)))
    .filter((page) => Number.isInteger(page) && page >= 1))].sort((a, b) => a - b)

  const oldSplit = splitMarkdownByPage(oldMarkdown, oldContentList)
  const newSplit = splitMarkdownByPage(newMarkdown, newContentList)
  const newPageKeys = [...newSplit.ranges.keys()].sort((a, b) => newSplit.ranges.get(a).startLine - newSplit.ranges.get(b).startLine)
  const newPageMap = mapNewPages(targets, newPageKeys)
  const oldRanges = [...oldSplit.ranges.entries()]
    .map(([page, range]) => ({ page, ...range }))
    .sort((a, b) => a.startLine - b.startLine)

  const chunks = []
  let cursor = 0
  for (const range of oldRanges) {
    if (range.startLine > cursor) chunks.push({ page: null, lines: oldSplit.lines.slice(cursor, range.startLine) })
    chunks.push({ page: range.page, lines: oldSplit.lines.slice(range.startLine, range.endLine + 1) })
    cursor = Math.max(cursor, range.endLine + 1)
  }
  if (cursor < oldSplit.lines.length) chunks.push({ page: null, lines: oldSplit.lines.slice(cursor) })

  const replacedPages = []
  const failedPages = []
  const outputChunks = chunks.map((chunk) => {
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

  const outputLines = []
  for (const chunk of outputChunks) {
    if (chunk.lines.length === 0) continue
    if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== '') outputLines.push('')
    outputLines.push(...chunk.lines)
  }
  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === '') outputLines.pop()

  // Merge the content list: untouched pages keep their original entries
  // (including page_idx), repaired pages take the new entries with their
  // page_idx remapped to the original page number.
  const oldGroups = groupByPage(oldContentList)
  const newGroups = groupByPage(newContentList)
  const oldPages = [...oldGroups.groups.keys()].sort((a, b) => a - b)
  const merged = []
  for (const pageIndex of oldPages) {
    const displayPage = pageIndex + 1
    const replaced = replacedPages.includes(displayPage)
    const newPage = newPageMap.get(displayPage)
    if (replaced && newPage !== undefined && newGroups.groups.has(newPage - 1)) {
      for (const entry of newGroups.groups.get(newPage - 1)) {
        merged.push({ ...entry, page_idx: pageIndex })
      }
    } else {
      merged.push(...oldGroups.groups.get(pageIndex))
    }
  }
  // Pages present only in the repaired archive (should not happen) are kept.
  for (const pageIndex of [...newGroups.groups.keys()].sort((a, b) => a - b)) {
    const displayPage = pageIndex + 1
    if (oldGroups.groups.has(pageIndex)) continue
    for (const entry of newGroups.groups.get(pageIndex)) {
      merged.push(replacedPages.includes(displayPage) ? { ...entry, page_idx: pageIndex } : entry)
    }
  }
  merged.push(...oldGroups.loose)

  return { markdown: `${outputLines.join('\n')}\n`, contentList: merged, replacedPages, failedPages }
}

/** Compress 1-based page numbers into a MinerU `page_ranges` string ("2,4-6"). */
export function toPageRanges(pages) {
  const sorted = [...new Set((Array.isArray(pages) ? pages : [])
    .map((page) => Math.floor(Number(page)))
    .filter((page) => Number.isInteger(page) && page >= 1))].sort((a, b) => a - b)
  const parts = []
  let start = null
  let previous = null
  for (const page of sorted) {
    if (start === null) { start = page; previous = page; continue }
    if (page === previous + 1) { previous = page; continue }
    parts.push(start === previous ? String(start) : `${start}-${previous}`)
    start = page
    previous = page
  }
  if (start !== null) parts.push(start === previous ? String(start) : `${start}-${previous}`)
  return parts.join(',')
}
