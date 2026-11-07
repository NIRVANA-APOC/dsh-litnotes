/**
 * Shared markdown → paper-model parser.
 *
 * 2.0 replaces the 1.0.0 hand-rolled block scanner with **markdown-it** for
 * standard block structure (paragraphs, ATX headings, fenced code, rules, GFM
 * pipe tables) and **htmlparser2** for `<table>` HTML blocks (MinerU emits
 * those for real paper tables, including `colspan`/`rowspan`/`<thead>`).
 *
 * The frozen 1.0.0 contract is the behavioural spec (see `./model.ts`), so this
 * module registers markdown-it plugins for the constructs markdown-it does not
 * own and whose semantics are domain logic:
 *
 *  - `paper_math`: inline `$…$` and `\(…\)` math tokenization. KaTeX renders
 *    client-side; plain-text offsets keep the raw `$…$` source.
 *  - `paper_math_block`: display `$$…$$` / `\[…\]` blocks.
 *  - `paper_html_table`: `<table>…</table>` blocks parsed with htmlparser2.
 *  - `paper_list` / `paper_quote`: MinerU list/quote folding (nested list items
 *    and continuation lines fold into the parent item text; consecutive `>`
 *    lines join into one quote) — markdown-it's CommonMark list/quote structure
 *    differs from the frozen reader contract, so these stay explicit rules.
 *  - `paper_html`: inline HTML degrades to run styles exactly like 1.0.0
 *    (`<b>`, `<i>`, `<a href>`, `<code>`, `<del>` → style flags; unknown tags
 *    strip only when a matching closing tag proves they are markup). Raw HTML
 *    is NEVER emitted or executed: markdown-it runs with `html: false` and this
 *    rule only produces text runs.
 *
 * Everything else — emphasis, code spans, links, images, entities, fenced code,
 * headings, rules and pipe tables — is produced by markdown-it and converted
 * into the flat run model that annotations address by character offset.
 *
 * `appendPageMarks()` is a faithful port of the frozen page-mark aligner: it
 * inserts display-only `page` blocks on MinerU content-list `page_idx`
 * transitions while keeping every original block's `index`/`key` (and therefore
 * every stored annotation/translation anchor) untouched.
 *
 * Environment-neutral: no `node:` imports, no DOM access.
 */

import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItInstance, StateBlock, StateCore, StateInline, Token } from 'markdown-it'
import { parseDocument } from 'htmlparser2'

import {
  appendBlock,
  emptyModel,
  mdStats,
  plainTextOfBlock,
  runsText,
} from './model.ts'
import type {
  Block,
  CellAlign,
  CodeBlock,
  FormulaBlock,
  HeadingBlock,
  ListBlock,
  OutlineEntry,
  PageMark,
  PaperModel,
  ParagraphBlock,
  QuoteBlock,
  RuleBlock,
  Run,
  RunStyle,
  TableBlock,
  TableCell,
} from './model.ts'

// Public helper re-exports: consumers (Host AI engine, reader UI, tests) import
// the model helpers from either module.
export { blockKey, emptyModel, fnv1a, mdStats, plainTextOfBlock, runsText } from './model.ts'

/* -------------------------------------------------------------------------- */
/* Bounds & portable helpers                                                   */
/* -------------------------------------------------------------------------- */

/** Longest inline construct (math / HTML tag / link) a single scan may span. */
const INLINE_SCAN_LIMIT = 8192

/** Block window used to align one content-list entry with parser blocks. */
const MATCH_WINDOW = 32

/** Hard bound of display-formula lines (a runaway `$$` must not eat a paper). */
const FORMULA_SCAN_LINES = 200

/** HTML entities MinerU output actually uses (port of the frozen decoder). */
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  middot: '\u00B7',
  bull: '\u2022',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  laquo: '\u00AB',
  raquo: '\u00BB',
  ldquo: '\u201C',
  rdquo: '\u201D',
  lsquo: '\u2018',
  rsquo: '\u2019',
  times: '\u00D7',
  divide: '\u00F7',
  plusmn: '\u00B1',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  rarr: '\u2192',
  larr: '\u2190',
  deg: '\u00B0',
  micro: '\u00B5',
  sup2: '\u00B2',
  sup3: '\u00B3',
  frac12: '\u00BD',
})

/**
 * Decode the handful of HTML entities MinerU output uses.
 *
 * Text entities are decoded by markdown-it itself; this decoder is used for
 * attribute values (link `href`, image `alt`/`src`) and HTML-table captions,
 * which markdown-it never sees.
 */
function decodeEntities(text: unknown): string {
  const value = String(text ?? '')
  if (value.indexOf('&') === -1) return value
  return value.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const mapped = NAMED_ENTITIES[body.toLowerCase()]
    return mapped === undefined ? whole : mapped
  })
}

/** Strip HTML tags to a single-line plain string (entities decoded). */
function plainTextOfHtml(html: unknown): string {
  const spaced = String(html ?? '').replace(/<[^>]*>/g, ' ')
  return decodeEntities(spaced).replace(/\s+/g, ' ').trim()
}

/** Read one HTML attribute (`src`, `href`, `alt`, …); decoded, '' when absent. */
function htmlAttr(attrs: string, name: string): string {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i')
  const match = pattern.exec(String(attrs ?? ''))
  if (match === null) return ''
  if (match[1] !== undefined) return decodeEntities(match[1])
  if (match[2] !== undefined) return decodeEntities(match[2])
  return decodeEntities(match[3] === undefined ? '' : match[3])
}

/** Case-insensitive indexOf for a closing tag, bounded by the scan limit. */
function findCloseTag(text: string, from: number, closeTag: string): number {
  const limit = Math.min(text.length, from + INLINE_SCAN_LIMIT)
  const index = text.toLowerCase().indexOf(closeTag, from)
  if (index === -1 || index >= limit) return -1
  return index
}

/* -------------------------------------------------------------------------- */
/* Math token readers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read inline math opening with `$` at `index`; avoids currency-like matches.
 *
 * Port of the frozen `mdReadMath`: the closing `$` must not be escaped, must
 * not be part of a `$$` pair, the latex body must not start/end with
 * whitespace and the next character must not be a digit.
 */
function readMath(text: string, index: number): { latex: string; end: number } | null {
  if (text[index] !== '$' || text[index + 1] === '$') return null
  const limit = Math.min(text.length, index + INLINE_SCAN_LIMIT)
  let cursor = index + 1
  while (cursor < limit) {
    const close = text.indexOf('$', cursor)
    if (close === -1 || close >= limit) return null
    if (close > 0 && text[close - 1] === '\\') {
      cursor = close + 1
      continue
    }
    if (text[close + 1] === '$' || text[close - 1] === '$') {
      cursor = close + 1
      continue
    }
    const latex = text.slice(index + 1, close)
    const following = close + 1 < text.length ? text[close + 1] ?? '' : ''
    if (latex !== '' && !/^\s/.test(latex) && !/\s$/.test(latex) && !/[0-9]/.test(following)) {
      return { latex, end: close + 1 }
    }
    cursor = close + 1
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Inline HTML → run styles (markdown-it inline rule)                          */
/* -------------------------------------------------------------------------- */

/** HTML tag names that map to run style flags (frozen `MD_HTML_FORMAT`). */
const HTML_FORMAT: Readonly<Record<string, 'strong' | 'em' | 'code' | 'del' | 'link' | 'plain'>> = Object.freeze({
  a: 'link',
  b: 'strong',
  strong: 'strong',
  i: 'em',
  em: 'em',
  code: 'code',
  tt: 'code',
  kbd: 'code',
  samp: 'code',
  del: 'del',
  s: 'del',
  strike: 'del',
  mark: 'plain',
})

/** Tag pattern for one inline HTML construct (frozen regex). */
const HTML_TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/

/** Autolink pattern (`<scheme:rest>`); emits one link-styled text run. */
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]+)>/

/** Push helper for a text run token (the inline parser flushes pending text). */
function pushTextToken(state: StateInline, text: string): void {
  if (text === '') return
  const token = state.push('text', '', 0)
  token.content = text
}

/**
 * markdown-it inline rule: parse one HTML construct at `<` into run tokens.
 *
 * With `html: false` markdown-it never parses raw HTML; this rule applies the
 * frozen 1.0.0 degradation policy instead (style mapping / tag stripping) and
 * never emits raw HTML. Returns `false` when the text is ordinary prose
 * (`a < b`, an unpaired opener, …) so the normal text scanner handles it.
 */
function paperHtml(state: StateInline, silent: boolean): boolean {
  const text = state.src
  const index = state.pos
  if (text.charCodeAt(index) !== 0x3c) return false
  const slice = text.slice(index, index + INLINE_SCAN_LIMIT)

  const autolink = AUTOLINK_RE.exec(slice)
  if (autolink !== null) {
    const end = index + autolink[0].length
    if (silent) {
      state.pos = end
      return true
    }
    const token = state.push('paper_autolink', '', 0)
    token.content = autolink[1] ?? ''
    state.pos = end
    return true
  }

  const tag = HTML_TAG_RE.exec(slice)
  if (tag === null) return false
  const closing = tag[1] === '/'
  const name = (tag[2] ?? '').toLowerCase()
  const attrs = tag[3] ?? ''
  const afterTag = index + tag[0].length
  if (closing) {
    if (!silent) {
      // Nesting 0 on purpose: unmatched inline HTML never pushes/pops a
      // markdown-it delimiter frame (a stray `</b>` would corrupt parser state).
      const token = state.push('paper_style_close', '', 0)
      token.meta = { tag: name } // internal token metadata
    }
    state.pos = afterTag
    return true
  }
  if (name === 'br' || name === 'wbr') {
    if (!silent) pushTextToken(state, ' ')
    state.pos = afterTag
    return true
  }
  if (name === 'img') {
    if (!silent) pushTextToken(state, htmlAttr(attrs, 'alt'))
    state.pos = afterTag
    return true
  }

  const format = HTML_FORMAT[name]
  const closeTag = '</' + name + '>'
  const closeAt = findCloseTag(text, afterTag, closeTag)
  // An unpaired opener is more likely literal prose ("a<b and c>d") than
  // markup: leave it for the text scanner to emit verbatim.
  if (format === undefined || closeAt === -1) {
    // Known tag without a close (or unknown tag without one): literal prose.
    if (format !== undefined || closeAt === -1) return false
    // Unknown tag: strip it only when a matching closing tag proves it is markup.
    if (!silent) state.pos = afterTag
    else state.pos = afterTag
    return true
  }
  if (format === 'plain') {
    // `<mark>` adds no style flag; strip the tags and keep parsing the content.
    state.pos = afterTag
    return true
  }
  if (format === 'code') {
    const end = closeAt + closeTag.length
    if (!silent) {
      const inner = text.slice(afterTag, closeAt)
      const codeToken = state.push('paper_code', '', 0)
      codeToken.content = decodeEntities(inner.replace(/<[^>]*>/g, ' '))
    }
    state.pos = end
    return true
  }
  if (silent) {
    state.pos = afterTag
    return true
  }
  const token = state.push('paper_style_open', '', 0)
  const style: RunStyle = {}
  if (format === 'strong') style.strong = true
  else if (format === 'em') style.em = true
  else if (format === 'del') style.del = true
  else {
    const href = htmlAttr(attrs, 'href')
    if (href !== '') style.link = href
  }
  token.meta = { tag: name, style } // internal token metadata
  state.pos = afterTag
  return true
}

/**
 * markdown-it inline rule: inline math (`$…$`) and `\(…\)` at the current
 * position. Emits a `paper_math` token carrying both the raw source (plain-text
 * offset space) and the latex body (KaTeX input).
 */
function paperMath(state: StateInline, silent: boolean): boolean {
  const text = state.src
  const index = state.pos
  const code = text.charCodeAt(index)

  if (code === 0x5c /* \ */ && text.charCodeAt(index + 1) === 0x28 /* ( */) {
    const close = text.indexOf('\\)', index + 2)
    if (close !== -1 && close - index < INLINE_SCAN_LIMIT) {
      const latex = text.slice(index + 2, close)
      if (latex.trim() !== '') {
        const end = close + 2
        if (!silent) {
          const token = state.push('paper_math', '', 0)
          token.content = text.slice(index, end)
          token.meta = { latex } // internal token metadata
        }
        state.pos = end
        return true
      }
    }
    return false
  }

  if (code !== 0x24 /* $ */) return false
  const math = readMath(text, index)
  if (math === null) return false
  if (!silent) {
    const token = state.push('paper_math', '', 0)
    token.content = text.slice(index, math.end)
    token.meta = { latex: math.latex } // internal token metadata
  }
  state.pos = math.end
  return true
}

/* -------------------------------------------------------------------------- */
/* Inline run conversion                                                       */
/* -------------------------------------------------------------------------- */

/** Metadata carried by one custom inline token. */
interface InlineTokenMeta {
  latex?: string
  tag?: string
  style?: RunStyle
}

/** Read one custom token's metadata defensively (tokens come from our rules). */
function inlineMeta(token: Token): InlineTokenMeta {
  const value: unknown = token.meta
  // Internal assertion: only our own inline rules create custom token types.
  return value !== null && typeof value === 'object' ? (value as InlineTokenMeta) : {}
}

/** Merge style `delta` over `base`, returning a fresh object. */
function mergeStyle(base: RunStyle, delta: RunStyle): RunStyle {
  const style: RunStyle = {}
  if (base.strong === true || delta.strong === true) style.strong = true
  if (base.em === true || delta.em === true) style.em = true
  if (base.code === true || delta.code === true) style.code = true
  if (base.del === true || delta.del === true) style.del = true
  const link = delta.link !== undefined && delta.link !== '' ? delta.link : base.link
  if (link !== undefined && link !== '') style.link = link
  return style
}

/** Whether two text runs carry identical style flags (frozen `mdSameStyle`). */
function sameStyle(left: RunStyle, right: RunStyle): boolean {
  return Boolean(left.strong) === Boolean(right.strong)
    && Boolean(left.em) === Boolean(right.em)
    && Boolean(left.code) === Boolean(right.code)
    && Boolean(left.del) === Boolean(right.del)
    && left.link === right.link
}

/** Push one run, merging adjacent text runs that share identical styles. */
function pushRun(runs: Run[], run: Run): void {
  if (run.type === 'text' && run.text === '') return
  const last = runs.length > 0 ? runs[runs.length - 1] : undefined
  if (last !== undefined && last.type === 'text' && run.type === 'text' && sameStyle(last, run)) {
    last.text += run.text
    return
  }
  runs.push(run)
}

/** Build one text run from a raw string plus style flags. */
function textRun(text: string, style: RunStyle): Run {
  const run: Run & { type: 'text' } = { type: 'text', text }
  if (style.strong === true) run.strong = true
  if (style.em === true) run.em = true
  if (style.code === true) run.code = true
  if (style.del === true) run.del = true
  if (style.link !== undefined && style.link !== '') run.link = style.link
  return run
}

/** Build one math run; math runs never carry `code`/`link` (frozen contract). */
function mathRun(text: string, latex: string, style: RunStyle): Run {
  const run: Run & { type: 'math' } = { type: 'math', text, latex }
  if (style.strong === true) run.strong = true
  if (style.em === true) run.em = true
  if (style.del === true) run.del = true
  return run
}

/**
 * Convert markdown-it inline children into the flat run model.
 *
 * `base` carries styles inherited from an enclosing context (used for image
 * label recursion: the frozen scanner parses `![label](src)` as label runs
 * with `link = src`).
 */
function convertInlineTokens(tokens: readonly Token[], base: RunStyle): Run[] {
  const runs: Run[] = []
  const custom: Array<{ tag: string; style: RunStyle }> = []
  const builtin = { strong: 0, em: 0, del: 0 }
  const links: string[] = []

  const currentStyle = (): RunStyle => {
    let style: RunStyle = base
    if (builtin.strong > 0) style = mergeStyle(style, { strong: true })
    if (builtin.em > 0) style = mergeStyle(style, { em: true })
    if (builtin.del > 0) style = mergeStyle(style, { del: true })
    const link = links.length > 0 ? links[links.length - 1] : undefined
    if (link !== undefined && link !== '') style = mergeStyle(style, { link })
    for (const frame of custom) style = mergeStyle(style, frame.style)
    return style
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'text_special':
        pushRun(runs, textRun(token.content, currentStyle()))
        break
      case 'softbreak':
      case 'hardbreak':
        pushRun(runs, textRun(' ', currentStyle()))
        break
      case 'strong_open':
        builtin.strong += 1
        break
      case 'strong_close':
        builtin.strong = Math.max(0, builtin.strong - 1)
        break
      case 'em_open':
        builtin.em += 1
        break
      case 'em_close':
        builtin.em = Math.max(0, builtin.em - 1)
        break
      case 's_open':
        builtin.del += 1
        break
      case 's_close':
        builtin.del = Math.max(0, builtin.del - 1)
        break
      case 'code_inline':
        pushRun(runs, textRun(token.content, mergeStyle(currentStyle(), { code: true })))
        break
      case 'link_open': {
        const href = token.attrGet('href')
        links.push(typeof href === 'string' ? href : '')
        break
      }
      case 'link_close':
        links.pop()
        break
      case 'image': {
        const src = token.attrGet('src')
        const srcText = typeof src === 'string' ? src : ''
        const imageStyle = mergeStyle(currentStyle(), srcText !== '' ? { link: srcText } : {})
        const children = token.children ?? []
        for (const run of convertInlineTokens(children, imageStyle)) pushRun(runs, run)
        break
      }
      case 'paper_autolink': {
        const url = token.content
        pushRun(runs, textRun(url, mergeStyle(currentStyle(), { link: url })))
        break
      }
      case 'paper_style_open': {
        const meta = inlineMeta(token)
        custom.push({ tag: meta.tag ?? '', style: meta.style ?? {} })
        break
      }
      case 'paper_style_close': {
        const meta = inlineMeta(token)
        const tag = meta.tag ?? ''
        for (let index = custom.length - 1; index >= 0; index -= 1) {
          if (custom[index]?.tag === tag) {
            custom.splice(index, 1)
            break
          }
        }
        break
      }
      case 'paper_code':
        pushRun(runs, textRun(token.content, mergeStyle(currentStyle(), { code: true })))
        break
      case 'paper_math': {
        const meta = inlineMeta(token)
        pushRun(runs, mathRun(token.content, meta.latex ?? '', currentStyle()))
        break
      }
      default:
        // Other markdown-it tokens (html_inline is disabled, delimiters are
        // post-processed away, …) do not contribute text.
        break
    }
  }
  return runs
}

/**
 * Split inline markdown into flat runs. Never throws and always terminates;
 * tolerates `null`/`undefined` (returns `[]`).
 */
export function parseInline(text: string | null | undefined): Run[] {
  if (text === undefined || text === null || text === '') return []
  const tokens = md.parseInline(String(text), {})
  const inline = tokens.length > 0 ? tokens[0] : undefined
  if (inline === undefined) return []
  return convertInlineTokens(inline.children ?? [], {})
}

/* -------------------------------------------------------------------------- */
/* Figure detection (image + caption heuristic)                                */
/* -------------------------------------------------------------------------- */

/** Index of the `]` closing a bracket opened at `index`, or -1. */
function findClosingBracket(text: string, index: number): number {
  let depth = 0
  const limit = Math.min(text.length, index + INLINE_SCAN_LIMIT)
  for (let i = index; i < limit; i += 1) {
    const ch = text[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Read `[label](destination "title")` starting at `[`; also used for images. */
function readLink(text: string, index: number): { label: string; url: string; end: number } | null {
  if (text[index] !== '[') return null
  const labelEnd = findClosingBracket(text, index)
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null
  const limit = Math.min(text.length, labelEnd + 2 + INLINE_SCAN_LIMIT)
  let depth = 1
  let destEnd = -1
  for (let i = labelEnd + 2; i < limit; i += 1) {
    const ch = text[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        destEnd = i
        break
      }
    }
  }
  if (destEnd === -1) return null
  let destination = text.slice(labelEnd + 2, destEnd).trim()
  if (destination.startsWith('<')) {
    const angle = destination.indexOf('>')
    if (angle !== -1) destination = destination.slice(1, angle).trim()
  }
  const whitespace = destination.search(/\s/)
  if (whitespace !== -1) destination = destination.slice(0, whitespace)
  if (destination === '') return null
  return { label: text.slice(index + 1, labelEnd), url: destination, end: destEnd + 1 }
}

/**
 * MinerU often carries the figure caption in the markdown image's alt text.
 * When the alt reads like a caption (starts with Figure/Table/… or is long
 * prose) mirror it into `caption`; short descriptive alts stay alt-only.
 */
function captionFromAlt(alt: unknown): string {
  const value = String(alt ?? '').trim()
  if (value === '') return ''
  if (/^(?:figure|fig\.?|table|algorithm|listing|scheme|chart)\s*[\dIVXivx]/i.test(value)) return value
  if (value.length >= 64) return value
  return ''
}

/**
 * Detect a standalone image paragraph (plain markdown image, optionally wrapped
 * in `<center>` / `<p>` / `<div>` or expressed as an `<img>` tag).
 */
function detectFigure(text: unknown): { src: string; alt: string; caption: string } | null {
  let value = String(text ?? '').trim()
  for (let guard = 0; guard < 4; guard += 1) {
    if (value === '') return null
    let wrapper = /^<center\b[^>]*>([\s\S]*)<\/center\s*>$/i.exec(value)
    if (wrapper === null) wrapper = /^<p\b[^>]*>([\s\S]*)<\/p\s*>$/i.exec(value)
    if (wrapper === null) wrapper = /^<div\b[^>]*>([\s\S]*)<\/div\s*>$/i.exec(value)
    if (wrapper === null) break
    value = (wrapper[1] ?? '').trim()
  }
  if (value === '') return null
  if (value[0] === '!') {
    const image = readLink(value, 1)
    if (image !== null && image.end === value.length && image.url !== '') {
      return { src: image.url, alt: image.label, caption: captionFromAlt(image.label) }
    }
  }
  if (value[0] === '<') {
    const tag = /^<img\b((?:"[^"]*"|'[^']*'|[^'">])*)\/?>$/i.exec(value)
    if (tag !== null) {
      const src = htmlAttr(tag[1] ?? '', 'src')
      if (src === '') return null
      const alt = htmlAttr(tag[1] ?? '', 'alt')
      const title = htmlAttr(tag[1] ?? '', 'title')
      return { src, alt, caption: title !== '' ? title : captionFromAlt(alt) }
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Custom block rules                                                          */
/* -------------------------------------------------------------------------- */

/** Raw source line `line` of a markdown-it block state (indentation included). */
function rawLine(state: StateBlock, line: number): string {
  const start = state.bMarks[line] ?? 0
  const end = state.eMarks[line] ?? start
  return state.src.slice(start, end)
}

/**
 * Block formula: `$$ … $$` (single or multi-line) or `\[ … \]`.
 *
 * Faithful port of the frozen `mdTryBlockFormula`; returns `false` when the
 * opener is never closed (the text then degrades to ordinary prose).
 */
function parseFormulaLines(
  state: StateBlock,
  index: number,
  endLine: number,
): { latex: string; next: number } | null {
  const trimmed = rawLine(state, index).trim()
  if (trimmed.startsWith('$$')) {
    if (trimmed.length > 3 && trimmed.endsWith('$$')) {
      const latex = trimmed.slice(2, -2).trim()
      if (latex !== '') return { latex, next: index + 1 }
    }
    const collected: string[] = []
    const firstRest = trimmed.slice(2).trim()
    if (firstRest !== '') collected.push(firstRest)
    const limit = Math.min(endLine, index + 1 + FORMULA_SCAN_LINES)
    for (let cursor = index + 1; cursor < limit; cursor += 1) {
      const part = rawLine(state, cursor).trim()
      if (part.endsWith('$$')) {
        const content = part.slice(0, -2).trim()
        if (content !== '') collected.push(content)
        const latex = collected.filter((piece) => piece !== '').join('\n')
        if (latex === '') return null
        return { latex, next: cursor + 1 }
      }
      collected.push(part)
    }
    return null
  }
  if (trimmed.startsWith('\\[')) {
    const collected: string[] = []
    const firstRest = trimmed.slice(2).trim()
    const sameLineEnd = firstRest.indexOf('\\]')
    if (sameLineEnd !== -1) {
      const latex = firstRest.slice(0, sameLineEnd).trim()
      if (latex !== '') return { latex, next: index + 1 }
    }
    if (firstRest !== '' && sameLineEnd === -1) collected.push(firstRest)
    const limit = Math.min(endLine, index + 1 + FORMULA_SCAN_LINES)
    for (let cursor = index + 1; cursor < limit; cursor += 1) {
      const part = rawLine(state, cursor).trim()
      const endAt = part.indexOf('\\]')
      if (endAt !== -1) {
        const content = part.slice(0, endAt).trim()
        if (content !== '') collected.push(content)
        const latex = collected.filter((piece) => piece !== '').join('\n')
        if (latex === '') return null
        return { latex, next: cursor + 1 }
      }
      collected.push(part)
    }
    return null
  }
  return null
}

/** markdown-it block rule: display math blocks (`$$…$$`, `\[…\]`). */
function paperMathBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (silent) return /^[ \t]{0,3}(\$\$|\\\[)/.test(rawLine(state, startLine))
  const parsed = parseFormulaLines(state, startLine, endLine)
  if (parsed === null) return false
  const token = state.push('paper_formula', '', 0)
  token.meta = { latex: parsed.latex } // internal token metadata
  state.line = parsed.next
  return true
}

/* ---- HTML tables (htmlparser2) ------------------------------------------ */

/** One cell of a raw HTML table (inner HTML is parsed into runs later). */
interface RawHtmlCell {
  html: string
  colspan: number
  rowspan: number
  header: boolean
}

/** Raw HTML table structure before run conversion. */
interface RawHtmlTable {
  caption: string
  head: RawHtmlCell[]
  rows: RawHtmlCell[][]
}

/** Structural view of one htmlparser2 DOM node (avoids a domhandler type import). */
interface DomNodeLike {
  type: string
  name?: string
  data?: string
  attribs?: Record<string, string>
  children?: DomNodeLike[]
}

/** HTML void elements (serialized without a closing tag). */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Normalize one htmlparser2 node to the structural view above. */
function asDomNode(value: unknown): DomNodeLike | null {
  if (value === null || typeof value !== 'object') return null
  const node = value as DomNodeLike
  if (typeof node.type !== 'string') return null
  if (!Array.isArray(node.children)) node.children = []
  return node
}

/** Descendant elements with one tag name, depth-first document order. */
function findElements(nodes: readonly DomNodeLike[], name: string): DomNodeLike[] {
  const out: DomNodeLike[] = []
  for (const node of nodes) {
    if (node.type !== 'tag') continue
    if ((node.name ?? '').toLowerCase() === name) out.push(node)
    out.push(...findElements(node.children ?? [], name))
  }
  return out
}

/** Direct child elements named `name`. */
function directChildren(node: DomNodeLike, name: string): DomNodeLike[] {
  const out: DomNodeLike[] = []
  for (const child of node.children ?? []) {
    if (child.type === 'tag' && (child.name ?? '').toLowerCase() === name) out.push(child)
  }
  return out
}

/** Serialize one attribute map back to HTML (values re-decoded by the reader). */
function serializeAttrs(attribs: Record<string, string> | undefined): string {
  if (attribs === undefined) return ''
  let out = ''
  for (const [name, value] of Object.entries(attribs)) {
    out += ' ' + name + '="' + value.replace(/"/g, '&quot;') + '"'
  }
  return out
}

/** Serialize DOM nodes back to an HTML fragment for inline run parsing. */
function serializeNodes(nodes: readonly DomNodeLike[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'cdata') {
      out += node.data ?? ''
      continue
    }
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') continue
    const name = (node.name ?? '').toLowerCase()
    if (name === '') continue
    if (VOID_ELEMENTS.has(name)) {
      out += '<' + name + serializeAttrs(node.attribs) + '>'
      continue
    }
    out += '<' + name + serializeAttrs(node.attribs) + '>' + serializeNodes(node.children ?? []) + '</' + name + '>'
  }
  return out
}

/** Plain text of DOM nodes (each tag reads as a space boundary, then collapsed). */
function domPlainText(nodes: readonly DomNodeLike[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'cdata') out += node.data ?? ''
    else if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
      out += ' ' + domPlainText(node.children ?? []) + ' '
    }
  }
  return decodeEntities(out)
}

/** Clamp a parsed table span attribute to the frozen 1..100 range. */
function spanAttr(attribs: Record<string, string> | undefined, name: string): number {
  const raw = attribs?.[name]
  if (typeof raw !== 'string') return 1
  const value = parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.min(value, 100)
}

/** Build one raw cell from a `<td>`/`<th>` element. */
function rawHtmlCell(node: DomNodeLike): RawHtmlCell {
  return {
    html: serializeNodes(node.children ?? []),
    colspan: spanAttr(node.attribs, 'colspan'),
    rowspan: spanAttr(node.attribs, 'rowspan'),
    header: (node.name ?? '').toLowerCase() === 'th',
  }
}

/** Read the `<tr>` descendants of one table section element. */
function rowsOfSection(section: DomNodeLike): RawHtmlCell[][] {
  const rows: RawHtmlCell[][] = []
  for (const row of findElements(section.children ?? [], 'tr')) {
    const cells: RawHtmlCell[] = []
    for (const cell of directChildren(row, 'td').concat(directChildren(row, 'th'))) {
      cells.push(rawHtmlCell(cell))
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/** Every `<tr>` under a table that is not inside a `<thead>` / `<caption>`. */
function bodyRowsOf(table: DomNodeLike): RawHtmlCell[][] {
  const rows: RawHtmlCell[][] = []
  const visit = (node: DomNodeLike): void => {
    for (const child of node.children ?? []) {
      if (child.type !== 'tag') continue
      const name = (child.name ?? '').toLowerCase()
      if (name === 'thead' || name === 'caption') continue
      if (name === 'tr') {
        const cells: RawHtmlCell[] = []
        for (const cell of directChildren(child, 'td').concat(directChildren(child, 'th'))) {
          cells.push(rawHtmlCell(cell))
        }
        if (cells.length > 0) rows.push(cells)
        continue
      }
      visit(child)
    }
  }
  visit(table)
  return rows
}

/**
 * Parse one `<table>…</table>` fragment into the raw table structure.
 *
 * Faithful port of the frozen head/body classification: explicit `<thead>`
 * rows win; otherwise a first row of `<th>` cells becomes the head; otherwise
 * every row is a body row.
 */
function parseHtmlTable(html: string): RawHtmlTable {
  const document = parseDocument(html, { decodeEntities: false })
  const root = asDomNode(document)
  const tables = findElements(root?.children ?? [], 'table')
  const table = tables[0]
  if (table === undefined) return { caption: '', head: [], rows: [] }
  const captions = findElements(table.children ?? [], 'caption')
  const caption = captions[0] === undefined ? '' : domPlainText(captions[0].children ?? []).replace(/\s+/g, ' ').trim()
  const thead = findElements(table.children ?? [], 'thead')[0]
  const tbody = findElements(table.children ?? [], 'tbody')[0]
  const headerRows = thead === undefined ? [] : rowsOfSection(thead)
  const bodyRows = tbody === undefined ? bodyRowsOf(table) : rowsOfSection(tbody)
  const head: RawHtmlCell[] = []
  const rows: RawHtmlCell[][] = []
  if (headerRows.length > 0) {
    const firstHeader = headerRows[0] ?? []
    for (const cell of firstHeader) head.push(cell)
    for (let r = 1; r < headerRows.length; r += 1) {
      const row = headerRows[r]
      if (row !== undefined) rows.push(row)
    }
    for (const row of bodyRows) rows.push(row)
  } else if (bodyRows.length > 0 && (bodyRows[0] ?? []).some((cell) => cell.header)) {
    const firstBody = bodyRows[0] ?? []
    for (const cell of firstBody) head.push(cell)
    for (let r = 1; r < bodyRows.length; r += 1) {
      const row = bodyRows[r]
      if (row !== undefined) rows.push(row)
    }
  } else {
    for (const row of bodyRows) rows.push(row)
  }
  return { caption, head, rows }
}

/** markdown-it block rule: one `<table>…</table>` HTML block. */
function paperHtmlTableRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (!/^<table\b/i.test(rawLine(state, startLine).trim())) return false
  if (silent) return true
  let cursor = startLine
  let html = ''
  let closed = false
  while (cursor < endLine) {
    const line = rawLine(state, cursor)
    html += (cursor === startLine ? '' : '\n') + line
    if (/<\/table\s*>/i.test(line)) {
      closed = true
      cursor += 1
      break
    }
    cursor += 1
  }
  if (!closed) return false
  const token = state.push('paper_html_table', '', 0)
  token.meta = { table: parseHtmlTable(html) } // internal token metadata
  state.line = cursor
  return true
}

/* ---- Lists & quotes (MinerU folding) ------------------------------------ */

/** Parse one list marker; `null` when the line is not a list item. */
function listMarker(line: string): { indent: number; ordered: boolean; number: number | null; text: string } | null {
  const match = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/.exec(line)
  if (match === null) return null
  const indent = (match[1] ?? '').replace(/\t/g, '    ').length
  const token = match[2] ?? ''
  const ordered = token.charCodeAt(0) >= 48 && token.charCodeAt(0) <= 57
  return {
    indent,
    ordered,
    number: ordered ? parseInt(token, 10) : null,
    text: (match[4] ?? '').trim(),
  }
}

/** One block parsed straight from raw lines (list items / quote body). */
interface RawListBlock {
  ordered: boolean
  start: number | null
  itemTexts: string[]
}

/**
 * Parse one ordered/unordered list block.
 *
 * Indented continuation lines and deeper (nested list) items fold into the
 * current top-level item's text, separated by spaces (frozen contract: the
 * reader renders one `<li>` per top-level item and maps DOM offsets by
 * cumulative item lengths).
 */
function parseListLines(
  state: StateBlock,
  index: number,
  endLine: number,
): { block: RawListBlock; next: number } | null {
  const first = listMarker(rawLine(state, index))
  if (first === null) return null
  const baseIndent = first.indent
  const ordered = first.ordered
  const start = ordered ? first.number : null
  const itemTexts: string[] = []
  let current: string[] | null = null
  const flushItem = (): void => {
    if (current === null) return
    const text = current.join(' ').replace(/\s+/g, ' ').trim()
    itemTexts.push(text)
    current = null
  }
  let cursor = index
  while (cursor < endLine) {
    const line = rawLine(state, cursor)
    if (line.trim() === '') break
    const marker = listMarker(line)
    if (marker !== null) {
      if (marker.indent > baseIndent) {
        if (current === null) break
        if (marker.text !== '') current.push(marker.text)
        cursor += 1
        continue
      }
      if (marker.ordered !== ordered) break
      flushItem()
      current = marker.text === '' ? [] : [marker.text]
      cursor += 1
      continue
    }
    if (/^[ \t]+\S/.test(line)) {
      if (current === null) break
      current.push(line.trim())
      cursor += 1
      continue
    }
    break
  }
  flushItem()
  if (itemTexts.length === 0) return null
  return { block: { ordered, start, itemTexts }, next: cursor }
}

/** markdown-it block rule: MinerU ordered/unordered list with folded nesting. */
function paperListRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (silent) return listMarker(rawLine(state, startLine)) !== null
  const parsed = parseListLines(state, startLine, endLine)
  if (parsed === null) return false
  const token = state.push('paper_list', '', 0)
  token.meta = { list: parsed.block } // internal token metadata
  state.line = parsed.next
  return true
}

/**
 * markdown-it block rule: consecutive `>` lines form one quote block whose
 * content lines join with a single space (frozen contract; markdown-it's
 * CommonMark quote nesting/lazy continuation differs).
 */
function paperQuoteRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (!/^[ \t]{0,3}>/.test(rawLine(state, startLine))) return false
  if (silent) return true
  const parts: string[] = []
  let cursor = startLine
  while (cursor < endLine && /^[ \t]{0,3}>/.test(rawLine(state, cursor))) {
    const content = rawLine(state, cursor).replace(/^[ \t]{0,3}(?:>[ \t]?)+/, '').trim()
    if (content !== '') parts.push(content)
    cursor += 1
  }
  state.line = cursor
  if (parts.length === 0) return true
  const token = state.push('paper_quote', '', 0)
  token.meta = { text: parts.join(' ') } // internal token metadata
  return true
}

/* -------------------------------------------------------------------------- */
/* Parser construction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The shared markdown-it instance.
 *
 * Standard blocks stay with markdown-it; the four paper rules and the two
 * inline rules implement the frozen reader contract. `html: false` guarantees
 * no raw HTML is ever emitted; `linkify`/`typographer` stay off so the plain
 * text is exactly what MinerU wrote.
 */
function createParser(): MarkdownItInstance {
  const parser = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  })
  // Keep the source bytes intact: markdown-it's stock normalize rule replaces
  // NUL with U+FFFD, but the frozen contract hashes the block's verbatim plain
  // text (real MinerU PDF extractions do contain NUL), and block keys must stay
  // annotation-stable across the 2.0 upgrade. Only newline normalization stays.
  parser.core.ruler.at('normalize', (state: StateCore) => {
    state.src = state.src.replace(/\r\n?/g, '\n')
  })
  // Blocks the frozen reader does not have: setext headings, indented code,
  // reference-link definitions, CommonMark blockquotes and lists (replaced).
  parser.disable(['lheading', 'code', 'reference', 'blockquote', 'list'])
  parser.block.ruler.before('paragraph', 'paper_math_block', paperMathBlockRule)
  parser.block.ruler.before('paragraph', 'paper_html_table', paperHtmlTableRule)
  parser.block.ruler.before('paragraph', 'paper_quote', paperQuoteRule)
  parser.block.ruler.before('paragraph', 'paper_list', paperListRule)
  parser.inline.ruler.before('text', 'paper_html', paperHtml)
  parser.inline.ruler.before('text', 'paper_math', paperMath)
  return parser
}

/** Module-level parser: stateless between `parse()` calls, reused by both halves. */
const md = createParser()

/* -------------------------------------------------------------------------- */
/* Block building                                                              */
/* -------------------------------------------------------------------------- */

/** Read one custom block token's metadata defensively. */
function blockMeta<T>(token: Token): T {
  const value: unknown = token.meta
  // Internal assertion: only our own block rules create these token types.
  return (value !== null && typeof value === 'object' ? value : {}) as T
}

/** Convert one pipe-table cell into the frozen cell model. */
function pipeCell(content: string, header: boolean, align: CellAlign | null): TableCell {
  const runs = parseInline(content)
  return {
    runs,
    plainText: runsText(runs),
    colspan: 1,
    rowspan: 1,
    header,
    align,
  }
}

/** Cell alignment from a markdown-it `style="text-align:left"` attribute. */
function cellAlign(token: Token): CellAlign | null {
  const style = token.attrGet('style')
  if (typeof style !== 'string') return null
  if (style.includes('text-align:left')) return 'left'
  if (style.includes('text-align:center')) return 'center'
  if (style.includes('text-align:right')) return 'right'
  return null
}

/** Build one table block from markdown-it pipe-table tokens. */
function buildPipeTable(tokens: readonly Token[], start: number): { block: TableBlock; next: number } {
  const head: TableCell[] = []
  const rows: TableCell[][] = []
  let currentRow: TableCell[] | null = null
  let inHead = false
  let index = start
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) break
    if (token.type === 'table_close') {
      if (currentRow !== null && !inHead) rows.push(currentRow)
      currentRow = null
      break
    }
    if (token.type === 'thead_open') {
      inHead = true
      continue
    }
    if (token.type === 'thead_close') {
      inHead = false
      continue
    }
    if (token.type === 'tr_open') {
      currentRow = []
      continue
    }
    if (token.type === 'tr_close') {
      if (currentRow !== null) {
        if (inHead) for (const cell of currentRow) head.push(cell)
        else rows.push(currentRow)
      }
      currentRow = null
      continue
    }
    if (token.type === 'th_open' || token.type === 'td_open') {
      const header = token.type === 'th_open'
      const align = cellAlign(token)
      const inline = tokens[index + 1]
      const content = inline !== undefined && inline.type === 'inline' ? inline.content : ''
      if (currentRow !== null) currentRow.push(pipeCell(content, header, align))
      continue
    }
  }
  const runs: Run[] = []
  const pushCellRuns = (cell: TableCell): void => {
    if (runs.length > 0) runs.push({ type: 'text', text: ' ' })
    for (const run of cell.runs) runs.push(run)
  }
  for (const cell of head) pushCellRuns(cell)
  for (const row of rows) for (const cell of row) pushCellRuns(cell)
  const block: TableBlock = {
    kind: 'table',
    index: -1,
    key: '',
    page: null,
    head,
    rows,
    caption: '',
    runs,
    plainText: runsText(runs),
  }
  return { block, next: index + 1 }
}

/** Build one HTML table block from a raw htmlparser2 structure. */
function buildHtmlTable(raw: RawHtmlTable): TableBlock {
  const convert = (cell: RawHtmlCell): TableCell => {
    const runs = parseInline(cell.html)
    return {
      runs,
      plainText: runsText(runs),
      colspan: cell.colspan,
      rowspan: cell.rowspan,
      header: cell.header,
    }
  }
  const head = raw.head.map(convert)
  const rows = raw.rows.map((row) => row.map(convert))
  const runs: Run[] = []
  const pushCellRuns = (cell: TableCell): void => {
    if (runs.length > 0) runs.push({ type: 'text', text: ' ' })
    for (const run of cell.runs) runs.push(run)
  }
  for (const cell of head) pushCellRuns(cell)
  for (const row of rows) for (const cell of row) pushCellRuns(cell)
  return {
    kind: 'table',
    index: -1,
    key: '',
    page: null,
    head,
    rows,
    caption: raw.caption,
    runs,
    plainText: runsText(runs),
  }
}

/** Build one list block from the frozen text list representation. */
function buildList(raw: RawListBlock): ListBlock {
  const items = raw.itemTexts.map((text) => {
    const runs = text === '' ? [] : parseInline(text)
    return { runs, plainText: runsText(runs) }
  })
  const runs: Run[] = []
  for (const item of items) for (const run of item.runs) runs.push(run)
  return {
    kind: 'list',
    index: -1,
    key: '',
    page: null,
    ordered: raw.ordered,
    start: raw.ordered ? raw.start : null,
    items,
    runs,
    plainText: runsText(runs),
  }
}

/** Raw paragraph text as the frozen parser saw it (lines trimmed, space-joined). */
function paragraphSourceText(lines: readonly string[], start: number, end: number): string {
  const parts: string[] = []
  for (let line = start; line < end; line += 1) {
    const value = lines[line] ?? ''
    if (value.trim() === '') continue
    parts.push(value.trim())
  }
  return parts.join(' ').trim()
}

/**
 * Build the block model from markdown-it block tokens.
 *
 * The token stream is flat (every container-like rule is replaced by a single
 * leaf token), except for pipe tables, which are assembled from their token
 * sequence.
 */
function buildBlocks(tokens: readonly Token[], lines: readonly string[]): PaperModel {
  const blocks: Block[] = []
  const outline: OutlineEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    switch (token.type) {
      case 'heading_open': {
        const inline = tokens[index + 1]
        const runs = inline !== undefined && inline.children !== null
          ? convertInlineTokens(inline.children ?? [], {})
          : []
        const plainText = runsText(runs)
        const level = Math.min(4, Math.max(1, parseInt(token.tag.slice(1), 10) || 1))
        if (plainText !== '') {
          const block: HeadingBlock = {
            kind: 'heading',
            index: -1,
            key: '',
            page: null,
            level,
            runs,
            plainText,
          }
          appendBlock(blocks, outline, block)
        }
        index += 1
        break
      }
      case 'paragraph_open': {
        const inline = tokens[index + 1]
        const runs = inline !== undefined && inline.children !== null
          ? convertInlineTokens(inline.children ?? [], {})
          : []
        const map = token.map
        const sourceText = map === null ? '' : paragraphSourceText(lines, map[0], map[1])
        const figure = sourceText === '' ? null : detectFigure(sourceText)
        if (figure !== null) {
          const block: Block = {
            kind: 'figure',
            index: -1,
            key: '',
            page: null,
            src: figure.src,
            alt: figure.alt,
            caption: figure.caption,
            plainText: '',
          }
          appendBlock(blocks, outline, block)
        } else if (runsText(runs) !== '') {
          const block: ParagraphBlock = {
            kind: 'paragraph',
            index: -1,
            key: '',
            page: null,
            runs,
            plainText: runsText(runs),
          }
          appendBlock(blocks, outline, block)
        }
        index += 1
        break
      }
      case 'fence': {
        let content = token.content
        if (content.endsWith('\n')) content = content.slice(0, -1)
        const info = token.info.trim()
        const firstToken = info === '' ? '' : (info.split(/\s+/)[0] ?? '')
        const block: CodeBlock = {
          kind: 'code',
          index: -1,
          key: '',
          page: null,
          lang: firstToken === '' ? 'text' : firstToken,
          code: content,
          plainText: content,
        }
        appendBlock(blocks, outline, block)
        index += 1
        break
      }
      case 'hr': {
        const block: RuleBlock = { kind: 'rule', index: -1, key: '', page: null, plainText: '' }
        appendBlock(blocks, outline, block)
        index += 1
        break
      }
      case 'table_open': {
        const built = buildPipeTable(tokens, index)
        appendBlock(blocks, outline, built.block)
        index = built.next
        break
      }
      case 'paper_formula': {
        const latex = blockMeta<{ latex?: unknown }>(token).latex
        const block: FormulaBlock = {
          kind: 'formula',
          index: -1,
          key: '',
          page: null,
          latex: typeof latex === 'string' ? latex : '',
          display: true,
          plainText: typeof latex === 'string' ? latex : '',
        }
        appendBlock(blocks, outline, block)
        index += 1
        break
      }
      case 'paper_quote': {
        const text = blockMeta<{ text?: unknown }>(token).text
        const runs = parseInline(typeof text === 'string' ? text : '')
        const block: QuoteBlock = {
          kind: 'quote',
          index: -1,
          key: '',
          page: null,
          runs,
          plainText: runsText(runs),
        }
        appendBlock(blocks, outline, block)
        index += 1
        break
      }
      case 'paper_list': {
        const raw = blockMeta<{ list?: RawListBlock }>(token).list
        if (raw !== undefined) appendBlock(blocks, outline, buildList(raw))
        index += 1
        break
      }
      case 'paper_html_table': {
        const raw = blockMeta<{ table?: RawHtmlTable }>(token).table
        if (raw !== undefined) appendBlock(blocks, outline, buildHtmlTable(raw))
        index += 1
        break
      }
      default:
        index += 1
        break
    }
  }
  return { blocks, outline, stats: mdStats(blocks) }
}

/* -------------------------------------------------------------------------- */
/* Public parser                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parse MinerU-style markdown into the reading-block model.
 *
 * Tolerates `null`/`undefined` and a leading BOM; normalizes CRLF. Never throws
 * for malformed input: unterminated constructs degrade to prose (a runaway
 * `$$`/fence/table is bounded).
 */
export function parseMarkdown(markdown: string | null | undefined): PaperModel {
  if (markdown === undefined || markdown === null) return emptyModel()
  const source = String(markdown).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (source === '') return emptyModel()
  const lines = source.split('\n')
  const tokens = md.parse(source, {})
  return buildBlocks(tokens, lines)
}

/* -------------------------------------------------------------------------- */
/* Page marks                                                                  */
/* -------------------------------------------------------------------------- */

/** Collapse whitespace for content-list ↔ block alignment. */
function normalizeMatchText(text: unknown): string {
  return String(text ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

/** Join a MinerU string-list field (`*_caption`, `list_items`) with spaces. */
function joinListText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    if (item === undefined || item === null) continue
    const text = String(item)
    if (text !== '') parts.push(text)
  }
  return parts.join(' ')
}

/** Basename of a path (`images/fig1.png` → `fig1.png`). */
function baseName(value: unknown): string {
  const text = String(value ?? '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return cut === -1 ? text : text.slice(cut + 1)
}

/** Strip math delimiters from a content-list equation text. */
function equationMatchText(text: unknown): string {
  let value = String(text ?? '').trim()
  value = value.replace(/^\$\$?/, '').replace(/\$\$?$/, '')
  value = value.replace(/^\\\[/, '').replace(/\\\]$/, '')
  value = value.replace(/^\\\(/, '').replace(/\\\)$/, '')
  return value.trim()
}

/** Text used to align one content-list entry with a parser block. */
function contentEntryText(entry: Record<string, unknown>): string {
  const type = String(entry.type ?? '')
  if (type === 'equation') return equationMatchText(entry.text ?? entry.latex ?? '')
  if (type === 'list') {
    const joined = joinListText(entry.list_items)
    if (joined !== '') return joined
    return joinListText(entry.text)
  }
  if (type === 'table') {
    const body = plainTextOfHtml(entry.table_body ?? '')
    if (body !== '') return body
    return joinListText(entry.table_caption)
  }
  return String(entry.text ?? entry.latex ?? '')
}

/** Candidate match text for one parser block (cached per parse). */
function blockMatchText(block: Block, cache: Map<Block, string>): string {
  const cached = cache.get(block)
  if (cached !== undefined) return cached
  let text = plainTextOfBlock(block)
  // Content-list list entries join the item strings with spaces; the block's
  // run space concatenates them without a separator (client-ui offset math).
  if (block.kind === 'list') {
    const parts: string[] = []
    for (const item of block.items) {
      if (typeof item.plainText === 'string') parts.push(item.plainText)
    }
    text = parts.join(' ')
  }
  const normalized = normalizeMatchText(text)
  cache.set(block, normalized)
  return normalized
}

/** Whether a parser block kind can host the given content-list entry type. */
function kindAllowsMatch(kind: string, type: string): boolean {
  if (type === 'title') return kind === 'heading'
  if (type === 'list') return kind === 'list'
  if (type === 'equation') return kind === 'formula'
  if (type === 'table') return kind === 'table'
  return true
}

/** Find the next parser block matching one content-list entry (best effort). */
function matchContentEntry(
  blocks: readonly Block[],
  entry: Record<string, unknown>,
  from: number,
  cache: Map<Block, string>,
): number {
  const type = String(entry.type ?? '')
  const start = from < 0 ? 0 : from
  const end = Math.min(blocks.length, start + MATCH_WINDOW)
  if (type === 'image') {
    const expected = baseName(entry.img_path ?? '')
    const caption = normalizeMatchText(joinListText(entry.image_caption))
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block === undefined || block.kind !== 'figure') continue
      const source = baseName(block.src ?? '')
      if (expected !== '' && source === expected) return i
      if (caption !== '') {
        const alt = normalizeMatchText(block.alt ?? '')
        if (alt !== '' && (alt.startsWith(caption.slice(0, 24)) || caption.startsWith(alt.slice(0, 24)))) return i
      }
    }
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block !== undefined && block.kind === 'figure') return i
    }
    return -1
  }
  const matchText = normalizeMatchText(contentEntryText(entry))
  if (matchText === '') return -1
  for (let pass = 0; pass < 3; pass += 1) {
    const size = pass === 0 ? 48 : pass === 1 ? 24 : 12
    const needle = matchText.slice(0, size)
    if (needle === '') continue
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block === undefined) continue
      if (!kindAllowsMatch(block.kind, type)) continue
      const haystack = blockMatchText(block, cache)
      if (haystack !== '' && haystack.startsWith(needle)) return i
    }
  }
  const containsNeedle = matchText.slice(0, 24)
  if (containsNeedle !== '') {
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block === undefined) continue
      if (!kindAllowsMatch(block.kind, type)) continue
      const haystack = blockMatchText(block, cache)
      if (haystack !== '' && haystack.indexOf(containsNeedle) !== -1) return i
    }
  }
  return -1
}

/** One pending page-marker insertion (`before` = slot in the marker-free order). */
interface PageInsertion {
  before: number
  page: number
}

/** Build a synthetic page marker block. */
function pageBlock(page: number, slot: number): PageMark {
  return { index: slot, key: `page:${page}:${slot}`, kind: 'page', page, plainText: '' }
}

/**
 * Best-effort page marks from MinerU's content list.
 *
 * Walks the content list sequentially, tracks `page_idx` transitions and
 * inserts a `{ kind:'page', page }` block before the parser block matched by
 * the first content entry of each new page (page is a 1-based display number).
 *
 * Annotation stability (docs/UI-SPEC.md reader contract): the returned model is
 * a NEW model object, but every original block keeps its exact `index` and
 * `key` (page marks are display-only and never shift annotation/translation
 * anchors). Inserted page blocks carry `index` = their insertion slot in the
 * marker-free block order and a synthetic key `page:<page>:<slot>`. Original
 * blocks also receive their display `page` value. The input model is never
 * mutated, and calling this twice with the same content list is idempotent.
 */
export function appendPageMarks(
  model: PaperModel,
  contentList: readonly unknown[] | null | undefined,
): PaperModel {
  if (model === null || typeof model !== 'object' || !Array.isArray(model.blocks)) return model
  if (!Array.isArray(contentList) || contentList.length === 0) return model
  const blocks: Block[] = []
  for (const block of model.blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.kind !== 'page') blocks.push(block)
  }
  const cache = new Map<Block, string>()
  const insertions: PageInsertion[] = []
  const insertedPages = new Set<number>()
  let currentPage: number | null = null
  let lastMatched = -1
  for (const rawEntry of contentList) {
    const entry = rawEntry as unknown
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const rawPage = Number(record.page_idx)
    const pageValue: number | null = Number.isFinite(rawPage) ? Math.trunc(rawPage) : currentPage
    const pageChanged = pageValue !== null && pageValue !== currentPage
    const match = matchContentEntry(blocks, record, lastMatched + 1, cache)
    if (match >= 0) lastMatched = match
    if (pageChanged) {
      currentPage = pageValue
      const displayPage = Math.max(1, (pageValue ?? 0) + 1)
      if (!insertedPages.has(displayPage)) {
        insertedPages.add(displayPage)
        const before = match >= 0 ? match : Math.min(lastMatched + 1, blocks.length)
        insertions.push({ before, page: displayPage })
      }
    }
  }
  if (insertions.length === 0) return model
  insertions.sort((left, right) => left.before - right.before)
  const rebuilt: Block[] = []
  let next = 0
  let runningPage: number | null = null
  for (let position = 0; position <= blocks.length; position += 1) {
    while (next < insertions.length && insertions[next]?.before === position) {
      const insertion = insertions[next]
      next += 1
      if (insertion === undefined) continue
      rebuilt.push(pageBlock(insertion.page, position))
      runningPage = insertion.page
    }
    if (position < blocks.length) {
      const source = blocks[position]
      if (source === undefined) continue
      const clone = { ...source, page: runningPage } as Block
      rebuilt.push(clone)
    }
  }
  while (next < insertions.length) {
    const insertion = insertions[next]
    next += 1
    if (insertion !== undefined) rebuilt.push(pageBlock(insertion.page, blocks.length))
  }
  return {
    blocks: rebuilt,
    outline: Array.isArray(model.outline) ? model.outline.slice() : [],
    stats: mdStats(rebuilt),
  }
}
