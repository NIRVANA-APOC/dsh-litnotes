/**
 * Local parse artifact synthesizer for dsh-litnotes.
 *
 * The local engines (T0 builtin pdf.js / T0.5 `officeToPdf` -> pdf.js) only
 * extract the text layer. This module turns their page blocks into the exact
 * artifact contract the reading desk already consumes:
 *
 *   - `full.md`            Markdown with `#` title / `##`..`####` headings / paragraphs.
 *   - `content_list.json`  A MinerU-compatible pure array (`{page_idx,type,text,text_level?}`)
 *                          used by `appendPageMarks` to place page marks. The `text`
 *                          of every entry is the *plain text* of the matching
 *                          Markdown block (no `#`, no escapes), which is what the
 *                          client matches against (normalized prefix matching).
 *
 * Markdown text is backslash-escaped so that no extracted prose can be
 * reinterpreted as headings/lists/quotes/tables/formulas/quotes by the reader
 * parser. `parseInline` unescapes every ASCII punctuation character, therefore
 * the block plain text stays byte-identical to the source text and page-mark
 * alignment keeps working. Inline escaping is idempotent and deterministic.
 *
 * @module lib/local-synth
 */
import { WireError } from './wire.js'

/** Maximum characters per synthesized paragraph (defensive bound). */
export const DEFAULT_MAX_PARAGRAPH_CHARS = 4000
/** Absolute hard bound for one paragraph (translation API limit is 20000). */
export const HARD_MAX_PARAGRAPH_CHARS = 8000

/**
 * Characters that must always be escaped: they can open/close inline Markdown
 * constructs anywhere in a line (emphasis, code, math, links, raw HTML, tables).
 *
 * `]` and `)` are escaped instead of `[`/`(`: the client scanner treats `\(`
 * and a line starting with `\[` as math openers, while escaping the *closing*
 * delimiters already defangs `[label](url)` / `![alt](src)` and `1)` lists.
 */
const ALWAYS_ESCAPE = new Set(['\\', '`', '*', '_', '~', '$', '<', ']', ')', '|', '&'])
/** Characters that only create block structure at the start of a line. */
const LINE_START_ESCAPE = new Set(['#', '>', '-', '+'])
/** Ordered-list marker such as `1. ` / `12) ` (dot handled per position). */
const ORDERED_MARKER = /^(\d{1,9})([.)])\s/

/**
 * Escape one plain-text value for safe Markdown rendering.
 *
 * Only characters that could actually change the parsed block are escaped:
 * inline construct delimiters anywhere in the line, plus block markers at the
 * line start. The client scanner turns `\x` back into `x`, so the parsed
 * `plainText` equals the input text and content_list page-mark alignment keeps
 * working. Ordinary prose punctuation (`.` `,` `:` `;` `!` `?` `'` `"` `(` `[`
 * `/` `=` `{` `}` `@` `^` `%`) is left untouched, keeping generated Markdown
 * readable for the agent tools / export.
 *
 * @param {string} text - normalized plain text (single line).
 * @returns {string} markdown-safe inline text.
 */
export function escapeMarkdownText(text) {
  const value = String(text ?? '')
  if (value === '') return ''
  const ordered = ORDERED_MARKER.exec(value)
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '\\') {
      out += '\\\\'
      continue
    }
    if (ALWAYS_ESCAPE.has(ch)) {
      out += `\\${ch}`
      continue
    }
    if (i === 0 && LINE_START_ESCAPE.has(ch)) {
      out += `\\${ch}`
      continue
    }
    // `1. text` would parse as an ordered list; escape only that dot.
    if (ordered !== null && i === ordered[1].length && ch === '.') {
      out += `\\${ch}`
      continue
    }
    out += ch
  }
  return out
}
/** Sentence terminators used to split over-long paragraphs (with a trailing space). */
const SENTENCE_END = /[.!?。！？]["'”’)\]]*\s+/g

/** Collapse all whitespace runs to one space and trim. */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, ' ')
    .replace(/[\t\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Clamp a heading level into the reader's supported 1..4 range. */
function headingLevel(value) {
  const level = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 2
  return Math.min(4, Math.max(1, level))
}

/** Split one long paragraph at sentence boundaries (falls back to spaces). */
function splitParagraph(text, maxChars) {
  const limit = Math.max(120, Math.min(HARD_MAX_PARAGRAPH_CHARS, Math.floor(Number(maxChars) || DEFAULT_MAX_PARAGRAPH_CHARS)))
  if (text.length <= limit) return [text]
  const pieces = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1)
    let cut = -1
    SENTENCE_END.lastIndex = 0
    for (let match = SENTENCE_END.exec(window); match !== null; match = SENTENCE_END.exec(window)) {
      cut = match.index + match[0].length
    }
    if (cut <= 0) {
      const spaced = window.lastIndexOf(' ')
      cut = spaced > limit * 0.5 ? spaced + 1 : limit
    }
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces.filter((piece) => piece !== '')
}

/**
 * Normalize one page-block array into `{kind, level?, text}` records.
 *
 * @param {unknown} pages - array of page arrays of blocks.
 * @returns {{pageIndex:number, kind:'heading'|'paragraph', level:number, text:string}[]}
 */
function normalizeBlocks(pages) {
  const out = []
  if (!Array.isArray(pages)) return out
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]
    if (!Array.isArray(page)) continue
    for (const block of page) {
      if (block === null || typeof block !== 'object') continue
      const text = normalizeText(block.text)
      if (text === '') continue
      const kind = block.kind === 'heading' ? 'heading' : 'paragraph'
      out.push({
        pageIndex,
        kind,
        level: kind === 'heading' ? headingLevel(block.level) : 0,
        text,
      })
    }
  }
  return out
}

/**
 * Synthesize the local parse artifacts from extracted page blocks.
 *
 * @param {{
 *   pages?: unknown,
 *   title?: string,
 *   maxParagraphChars?: number,
 *   keepContentList?: boolean,
 * }} [input] - page blocks, optional document title and bounds.
 * @returns {{
 *   markdown: string,
 *   contentList: object[],
 *   pageCount: number,
 *   textChars: number,
 *   warnings: string[],
 *   title: string|null,
 * }} synthesized artifact payload.
 */
export function synthLocalDocument({ pages, title, maxParagraphChars, keepContentList = true } = {}) {
  const blocks = normalizeBlocks(pages)
  const pageCount = Array.isArray(pages) ? pages.length : 0
  const warnings = ['no-structure']

  const docTitle = normalizeText(title).slice(0, 300)
  let titleText = null

  /** @type {string[]} */
  const lines = []
  /** @type {object[]} */
  const contentList = []

  /** Append one block's markdown/CL pair (one entry per rendered markdown block). */
  const emit = (blockText, level, pageIndex) => {
    const clipped = level > 0 ? blockText : splitParagraph(blockText, maxParagraphChars ?? DEFAULT_MAX_PARAGRAPH_CHARS)
    if (level > 0) {
      const prefix = '#'.repeat(level)
      lines.push(`${prefix} ${escapeMarkdownText(clipped)}`)
      if (keepContentList) contentList.push({ type: 'text', text: clipped, page_idx: pageIndex, text_level: level })
      return
    }
    for (let index = 0; index < clipped.length; index += 1) {
      lines.push(escapeMarkdownText(clipped[index]))
      // One Markdown block per chunk: keep blank lines between chunks so the
      // client parser does not merge them back into one block (CL entry ↔ block
      // has to stay 1:1 for page-mark alignment).
      if (index < clipped.length - 1) lines.push('')
      if (keepContentList) contentList.push({ type: 'text', text: clipped[index], page_idx: pageIndex, text_level: 0 })
    }
  }

  // Materialize the title heading. A first-page level-1 heading from the
  // extractor wins; otherwise the caller-provided title is prepended.
  let startIndex = 0
  if (blocks.length > 0 && blocks[0].kind === 'heading' && blocks[0].level === 1) {
    titleText = blocks[0].text
    lines.push(`# ${escapeMarkdownText(blocks[0].text)}`)
    if (keepContentList) contentList.push({ type: 'text', text: blocks[0].text, page_idx: blocks[0].pageIndex, text_level: 1 })
    startIndex = 1
  } else if (docTitle !== '') {
    titleText = docTitle
    lines.push(`# ${escapeMarkdownText(docTitle)}`)
    if (keepContentList) contentList.push({ type: 'text', text: docTitle, page_idx: 0, text_level: 1 })
  }

  // Blank line between blocks keeps the client parser from merging paragraphs;
  // headings are also separated from the previous block.
  const pushSeparator = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  }

  let emitted = 0
  for (let index = startIndex; index < blocks.length; index += 1) {
    const block = blocks[index]
    const normalizedTitle = titleText !== null ? normalizeText(titleText) : ''
    if (normalizedTitle !== '' && block.kind === 'paragraph' && block.pageIndex === 0) {
      if (block.text === normalizedTitle || (normalizedTitle.startsWith(block.text) && block.text.length >= 8)) {
        // The title text was already emitted as `#`; skip its duplicate line.
        continue
      }
    }
    if (normalizedTitle !== '' && block.kind === 'heading' && block.level === 1 && block.text === normalizedTitle) {
      // A first-page title heading that already exists as the synthesized title.
      continue
    }
    pushSeparator()
    emit(block.text, block.kind === 'heading' ? block.level : 0, block.pageIndex)
    emitted += 1
  }

  let markdown = lines.join('\n').trim()
  if (markdown === '') {
    throw new WireError('local-empty-text', '没有从文件中提取到文字（可能是扫描件）（No text extracted; the file may be scanned）', 422)
  }
  markdown += '\n'

  const textChars = blocks.reduce((sum, block) => sum + block.text.length, 0)
  return {
    markdown,
    contentList: keepContentList ? contentList : [],
    pageCount,
    textChars,
    warnings,
    title: titleText,
  }
}
