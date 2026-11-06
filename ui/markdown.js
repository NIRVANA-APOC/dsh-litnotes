/**
 * Pure markdown → reading-block model used by the dsh-litnotes client.
 *
 * This file is written as a normal ESM module so it can be unit-tested in Node
 * (`node --test test/reader`). `scripts/build-client.mjs` strips the top-level
 * `export ` keywords and inlines the body inside the client factory, so inside
 * the bundle it is plain statements sharing one function scope. Keep every
 * top-level name unique across ui/markdown.js and ui/highlight.js.
 *
 * CONTRACT (docs/UI-SPEC.md §3.5): consumers call
 *   const model = parseMarkdown(markdown)
 *   model.blocks   Block[]
 *   model.outline  [{ key, level, text, blockIndex }]
 *   model.stats    { blocks, headings, chars, words }
 * and may call appendPageMarks(model, contentList) when MinerU's content list is
 * available. Every text-bearing block exposes a stable `key` ("b<index>:<hash>")
 * and a `plainText` cache; annotations are offsets into that plain text.
 *
 * Invariant: for every block with `runs`, `plainText === runsText(runs)`.
 * Annotatable kinds are heading / paragraph / quote / list / table.
 *
 * A Run is flat:
 *   { type:'text', text, strong?, em?, code?, del?, link? }
 *   { type:'math', text, latex }        // text keeps the $…$ / \(…\) source
 *
 * Blocks:
 *   { index, key, kind:'heading', level, runs, plainText }
 *   { index, key, kind:'paragraph', runs, plainText }
 *   { index, key, kind:'list', ordered, start, items:[{ runs, plainText }], runs, plainText }
 *       // block runs/plainText = concatenation of the item run spaces (no
 *       // separator) so client-ui's per-<li> DOM offsets add up exactly
 *   { index, key, kind:'quote', runs, plainText }
 *   { index, key, kind:'code', lang, code, plainText }
 *   { index, key, kind:'formula', latex, display:true }
 *   { index, key, kind:'figure', src, alt, caption }  // caption may come from a caption-like alt
 *   { index, key, kind:'table', head, rows, caption, runs, plainText }
 *       cell = { runs, plainText, colspan, rowspan, header, align? }
 *   { index, key:'page:<page>:<slot>', kind:'page', page }   // 1-based page
 *   { index, key, kind:'rule' }
 *
 * `index` always equals the position in `blocks` for parseMarkdown() output, and
 * `key` hashes the block's canonical text, so keys are deterministic for a given
 * markdown. appendPageMarks() is annotation-stable by contract: the original
 * blocks keep their exact `index`/`key`; each inserted page block gets a
 * synthetic key `page:<page>:<slot>` where <slot> is its insertion position in
 * the marker-free block order. The outline is carried over unchanged, so page
 * marks never invalidate stored annotations or translation keys.
 */

/** 32-bit FNV-1a as 8 lowercase hex characters. Shared by highlight.js. */
export function fnv1a(text) {
  const value = String(text ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Stable annotation anchor for one text-bearing block: `b<index>:<hash>`. */
export function blockKey(index, plainText) {
  return `b${index}:${fnv1a(plainText)}`
}

/** Concatenate a run list into the canonical plain-text offset space. */
export function runsText(runs) {
  if (!Array.isArray(runs)) return ''
  let out = ''
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]
    if (run !== null && typeof run === 'object' && typeof run.text === 'string') out += run.text
  }
  return out
}

function mdEmptyModel() {
  return { blocks: [], outline: [], stats: { blocks: 0, headings: 0, chars: 0, words: 0 } }
}

/** Kinds whose plain text counts toward `stats.chars` / `stats.words`. */
const MD_TEXT_KINDS = Object.freeze({
  heading: true,
  paragraph: true,
  quote: true,
  list: true,
  table: true,
})

/** Compute model statistics from a finished block list. */
export function mdStats(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  let chars = 0
  let words = 0
  let headings = 0
  for (let i = 0; i < list.length; i += 1) {
    const block = list[i]
    if (block === null || typeof block !== 'object') continue
    if (block.kind === 'heading') headings += 1
    if (MD_TEXT_KINDS[block.kind] !== true) continue
    const text = typeof block.plainText === 'string' ? block.plainText : ''
    chars += text.length
    const trimmed = text.trim()
    if (trimmed !== '') words += trimmed.split(/\s+/).length
  }
  return { blocks: list.length, headings, chars, words }
}

const MD_NAMED_ENTITIES = Object.freeze({
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

/** Decode the handful of HTML entities MinerU output actually uses. */
function mdDecodeEntities(text) {
  const value = String(text ?? '')
  if (value.indexOf('&') === -1) return value
  return value.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body.charCodeAt(0) === 35) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch (error) {
        return whole
      }
    }
    const mapped = MD_NAMED_ENTITIES[body.toLowerCase()]
    return mapped === undefined ? whole : mapped
  })
}

const MD_ESCAPABLE = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/

/** Longest run of characters a single inline delimiter may search for a close. */
const MD_INLINE_SCAN_LIMIT = 8192

/** Build a flat text run, copying only the style flags that are set. */
function mdTextRun(text, style) {
  const run = { type: 'text', text }
  if (style !== undefined && style !== null) {
    if (style.strong === true) run.strong = true
    if (style.em === true) run.em = true
    if (style.code === true) run.code = true
    if (style.del === true) run.del = true
    if (typeof style.link === 'string' && style.link !== '') run.link = style.link
  }
  return run
}

/** Build a math run. `text` keeps the raw `$…$` / `\(…\)` source. */
function mdMathRun(text, latex, style) {
  const run = { type: 'math', text, latex }
  if (style !== undefined && style !== null) {
    if (style.strong === true) run.strong = true
    if (style.em === true) run.em = true
    if (style.del === true) run.del = true
  }
  return run
}

/** Push a text run, decoding entities unless `raw` is true (code content). */
function mdPushText(out, value, style, raw) {
  const source = String(value ?? '')
  if (source === '') return
  const text = raw === true ? source : mdDecodeEntities(source)
  if (text === '') return
  out.push(mdTextRun(text, style))
}

function mdSameStyle(left, right) {
  if (left === null || right === null) return false
  return Boolean(left.strong) === Boolean(right.strong)
    && Boolean(left.em) === Boolean(right.em)
    && Boolean(left.code) === Boolean(right.code)
    && Boolean(left.del) === Boolean(right.del)
    && left.link === right.link
}

/** Merge adjacent text runs that carry identical styles (keeps output small). */
function mdMergeRuns(runs) {
  const out = []
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]
    if (run === null || typeof run !== 'object') continue
    if (typeof run.text !== 'string' || run.text === '') continue
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && last.type === 'text' && run.type === 'text' && mdSameStyle(last, run)) {
      last.text += run.text
      continue
    }
    out.push(run)
  }
  return out
}

/** End index (exclusive) of the run of `ch` starting at `index`. */
function mdCharRunEnd(text, index, ch) {
  let end = index
  while (end < text.length && text[end] === ch) end += 1
  return end
}

function mdIsWordChar(ch) {
  return typeof ch === 'string' && ch !== '' && /[A-Za-z0-9_]/.test(ch)
}

/* -------------------------------------------------------------------------- */
/* Inline token readers                                                        */
/* -------------------------------------------------------------------------- */

/** Read a CommonMark-style code span opening at `index` ("`…`"). */
function mdReadCodeSpan(text, index) {
  let end = index
  while (end < text.length && text[end] === '`') end += 1
  const size = end - index
  if (size === 0 || size > 64) return null
  const closing = '`'.repeat(size)
  const close = text.indexOf(closing, end)
  if (close === -1) return null
  let content = text.slice(end, close)
  if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
    content = content.slice(1, -1)
  }
  return { content, end: close + size }
}

/** Read inline math opening with `$` at `index`; avoids currency-like matches. */
function mdReadMath(text, index) {
  if (text[index] !== '$' || text[index + 1] === '$') return null
  const limit = Math.min(text.length, index + MD_INLINE_SCAN_LIMIT)
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
    const following = close + 1 < text.length ? text[close + 1] : ''
    if (latex !== '' && !/^\s/.test(latex) && !/\s$/.test(latex) && !/[0-9]/.test(following)) {
      return { latex, end: close + 1 }
    }
    cursor = close + 1
  }
  return null
}

/** Index of the `]` closing a bracket opened at `index`, or -1. */
function mdFindClosingBracket(text, index) {
  let depth = 0
  const limit = Math.min(text.length, index + MD_INLINE_SCAN_LIMIT)
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
function mdReadLink(text, index) {
  if (text[index] !== '[') return null
  const labelEnd = mdFindClosingBracket(text, index)
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null
  const limit = Math.min(text.length, labelEnd + 2 + MD_INLINE_SCAN_LIMIT)
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

/** Find the closing delimiter of emphasis opening at `from`. */
function mdFindEmphasisClose(text, from, marker, size) {
  const limit = Math.min(text.length, from + MD_INLINE_SCAN_LIMIT)
  for (let i = from; i < limit; i += 1) {
    if (text[i] !== marker) continue
    if (i > 0 && text[i - 1] === '\\') continue
    if (size === 1) {
      if (text[i + 1] === marker || text[i - 1] === marker) continue
    } else {
      const run = mdCharRunEnd(text, i, marker) - i
      if (run < size) continue
      if (run > size) {
        i += run - 1
        continue
      }
    }
    if (i === from) continue
    const content = text.slice(from, i)
    if (content === '' || /\s$/.test(content)) continue
    if (marker === '_' && mdIsWordChar(text[i + size])) continue
    return i
  }
  return -1
}

/** Read `*`, `**`, `***` style emphasis opening at `index`. */
function mdReadEmphasis(text, index) {
  const marker = text[index]
  if (marker !== '*' && marker !== '_') return null
  const run = mdCharRunEnd(text, index, marker) - index
  if (run === 0) return null
  const size = run >= 3 ? 3 : run === 2 ? 2 : 1
  const from = index + size
  if (from >= text.length) return null
  if (/\s/.test(text[from])) return null
  if (marker === '_' && mdIsWordChar(index > 0 ? text[index - 1] : '')) return null
  const close = mdFindEmphasisClose(text, from, marker, size)
  if (close === -1) return null
  return { content: text.slice(from, close), after: close + size, size }
}

/** Read `~~strikethrough~~` opening at `index`. */
function mdReadStrikethrough(text, index) {
  if (text[index] !== '~' || text[index + 1] !== '~') return null
  const limit = Math.min(text.length, index + MD_INLINE_SCAN_LIMIT)
  for (let i = index + 2; i < limit - 1; i += 1) {
    if (text[i] !== '~' || text[i + 1] !== '~') continue
    if (i > 0 && text[i - 1] === '\\') continue
    const content = text.slice(index + 2, i)
    if (content !== '' && !/^\s/.test(content) && !/\s$/.test(content)) {
      return { content, after: i + 2 }
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Inline HTML → runs                                                          */
/* -------------------------------------------------------------------------- */

const MD_HTML_FORMAT = Object.freeze({
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
  mark: 'mark',
})

const MD_HTML_STRIP = Object.freeze({
  span: true,
  sub: true,
  sup: true,
  u: true,
  ins: true,
  small: true,
  big: true,
  font: true,
  cite: true,
  q: true,
  var: true,
  abbr: true,
  time: true,
  label: true,
  p: true,
  div: true,
  center: true,
  section: true,
  article: true,
})

/** Case-insensitive indexOf for a closing tag, bounded by the scan limit. */
function mdFindCloseTag(text, from, closeTag) {
  const limit = Math.min(text.length, from + MD_INLINE_SCAN_LIMIT)
  const index = text.toLowerCase().indexOf(closeTag, from)
  if (index === -1 || index >= limit) return -1
  return index
}

/** Read one HTML attribute (`src`, `href`, `alt`, …); decoded, '' when absent. */
function mdHtmlAttr(attrs, name) {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i')
  const match = pattern.exec(String(attrs ?? ''))
  if (match === null) return ''
  if (match[1] !== undefined) return mdDecodeEntities(match[1])
  if (match[2] !== undefined) return mdDecodeEntities(match[2])
  return mdDecodeEntities(match[3] === undefined ? '' : match[3])
}

/**
 * Handle an inline HTML construct starting at `<`. Pushes runs into `out` and
 * returns the index after the construct, or -1 when the text is not HTML (the
 * caller then emits a literal `<`).
 */
function mdInlineHtml(text, index, base, out) {
  const slice = text.slice(index, index + MD_INLINE_SCAN_LIMIT)
  const autolink = /^<([a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]+)>/.exec(slice)
  if (autolink !== null) {
    out.push(mdTextRun(autolink[1], Object.assign({}, base, { link: autolink[1] })))
    return index + autolink[0].length
  }
  const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(slice)
  if (tag === null) return -1
  const closing = tag[1] === '/'
  const name = tag[2].toLowerCase()
  const afterTag = index + tag[0].length
  if (closing) return afterTag
  if (name === 'br' || name === 'wbr') {
    mdPushText(out, ' ', base, false)
    return afterTag
  }
  if (name === 'img') {
    const alt = mdHtmlAttr(tag[3], 'alt')
    if (alt !== '') mdPushText(out, alt, base, false)
    return afterTag
  }
  const kind = MD_HTML_FORMAT[name]
  if (kind !== undefined) {
    const closeTag = '</' + name + '>'
    const closeAt = mdFindCloseTag(text, afterTag, closeTag)
    // An unpaired opener is more likely literal prose ("a<b and c>d") than
    // markup: leave it for the caller to emit verbatim.
    if (closeAt === -1) return -1
    const inner = text.slice(afterTag, closeAt)
    const style = Object.assign({}, base)
    if (kind === 'strong') {
      style.strong = true
      mdInlineScan(inner, style, out)
    } else if (kind === 'em') {
      style.em = true
      mdInlineScan(inner, style, out)
    } else if (kind === 'code') {
      style.code = true
      mdPushText(out, mdDecodeEntities(inner.replace(/<[^>]*>/g, ' ')), style, true)
    } else if (kind === 'del') {
      style.del = true
      mdInlineScan(inner, style, out)
    } else if (kind === 'link') {
      style.link = mdHtmlAttr(tag[3], 'href')
      mdInlineScan(inner, style, out)
    } else {
      mdInlineScan(inner, style, out)
    }
    return closeAt + closeTag.length
  }
  if (MD_HTML_STRIP[name] === true) {
    if (mdFindCloseTag(text, afterTag, '</' + name + '>') === -1) return -1
    return afterTag
  }
  // Unknown tag: strip it only when a matching closing tag proves it is markup
  // (keeps prose comparisons such as "a<b and c>d" literal).
  if (mdFindCloseTag(text, afterTag, '</' + name + '>') !== -1) return afterTag
  return -1
}

/* -------------------------------------------------------------------------- */
/* Inline scanner                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Scan markdown inline content into flat runs, recursing for nested emphasis,
 * link labels and inline HTML. Style flags from `base` are inherited.
 */
function mdInlineScan(text, base, out) {
  let index = 0
  let buffer = ''
  const flush = () => {
    if (buffer !== '') {
      mdPushText(out, buffer, base, false)
      buffer = ''
    }
  }
  while (index < text.length) {
    const ch = text[index]
    const next = index + 1 < text.length ? text[index + 1] : ''
    if (ch === '\\' && next === '(') {
      const close = text.indexOf('\\)', index + 2)
      if (close !== -1 && close - index < MD_INLINE_SCAN_LIMIT) {
        const latex = text.slice(index + 2, close)
        if (latex.trim() !== '') {
          flush()
          out.push(mdMathRun(text.slice(index, close + 2), latex, base))
          index = close + 2
          continue
        }
      }
    }
    if (ch === '\\') {
      if (next !== '' && MD_ESCAPABLE.test(next)) {
        buffer += next
        index += 2
        continue
      }
      buffer += ch
      index += 1
      continue
    }
    if (ch === '`') {
      const span = mdReadCodeSpan(text, index)
      if (span !== null) {
        flush()
        mdPushText(out, span.content, Object.assign({}, base, { code: true }), true)
        index = span.end
        continue
      }
      const runEnd = mdCharRunEnd(text, index, '`')
      buffer += text.slice(index, runEnd)
      index = runEnd
      continue
    }
    if (ch === '!' && next === '[') {
      const image = mdReadLink(text, index + 1)
      if (image !== null) {
        flush()
        mdInlineScan(image.label, Object.assign({}, base, { link: image.url }), out)
        index = image.end
        continue
      }
      buffer += ch
      index += 1
      continue
    }
    if (ch === '[') {
      const link = mdReadLink(text, index)
      if (link !== null) {
        flush()
        mdInlineScan(link.label, Object.assign({}, base, { link: link.url }), out)
        index = link.end
        continue
      }
      buffer += ch
      index += 1
      continue
    }
    if (ch === '$') {
      const math = mdReadMath(text, index)
      if (math !== null) {
        flush()
        out.push(mdMathRun(text.slice(index, math.end), math.latex, base))
        index = math.end
        continue
      }
      buffer += ch
      index += 1
      continue
    }
    if (ch === '*' || ch === '_') {
      const emphasis = mdReadEmphasis(text, index)
      if (emphasis !== null) {
        flush()
        const style = Object.assign({}, base)
        if (emphasis.size >= 2) style.strong = true
        if (emphasis.size === 1 || emphasis.size === 3) style.em = true
        mdInlineScan(emphasis.content, style, out)
        index = emphasis.after
        continue
      }
      const runEnd = mdCharRunEnd(text, index, ch)
      buffer += text.slice(index, runEnd)
      index = runEnd
      continue
    }
    if (ch === '~' && next === '~') {
      const strike = mdReadStrikethrough(text, index)
      if (strike !== null) {
        flush()
        mdInlineScan(strike.content, Object.assign({}, base, { del: true }), out)
        index = strike.after
        continue
      }
      buffer += '~~'
      index += 2
      continue
    }
    if (ch === '<') {
      flush()
      const afterTag = mdInlineHtml(text, index, base, out)
      if (afterTag > index) {
        index = afterTag
        continue
      }
      buffer += ch
      index += 1
      continue
    }
    buffer += ch
    index += 1
  }
  flush()
}

/**
 * Split inline markdown into flat runs. Never throws and always terminates.
 * @param {string} text
 * @returns {object[]}
 */
export function parseInline(text) {
  const out = []
  if (text === undefined || text === null) return out
  mdInlineScan(String(text), {}, out)
  return mdMergeRuns(out)
}

/* -------------------------------------------------------------------------- */
/* Text block builders                                                         */
/* -------------------------------------------------------------------------- */

/** Canonical text used to hash a block key. */
function mdKeyText(block) {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'quote':
    case 'list':
    case 'table':
      return typeof block.plainText === 'string' ? block.plainText : ''
    case 'code':
      return typeof block.code === 'string' ? block.code : ''
    case 'formula':
      return typeof block.latex === 'string' ? block.latex : ''
    case 'figure':
      return (block.alt === '' ? '' : String(block.alt)) + '|' + String(block.src)
    case 'page':
      return 'page:' + String(block.page)
    default:
      return ''
  }
}

/** Assign index/key/outline entry and append one block to the model arrays. */
function mdAppendBlock(blocks, outline, block) {
  const index = blocks.length
  block.index = index
  block.key = blockKey(index, mdKeyText(block))
  blocks.push(block)
  if (block.kind === 'heading') {
    outline.push({ key: block.key, level: block.level, text: block.plainText, blockIndex: index })
  }
  return block
}

function mdMakeListBlock(ordered, start, items) {
  // The block-level run space is the exact concatenation of the item run spaces
  // (no separator): client-ui renders one <li> per item and maps DOM offsets by
  // the cumulative item lengths, so the block plainText must equal that sum.
  const runs = []
  for (let i = 0; i < items.length; i += 1) {
    const itemRuns = items[i].runs
    for (let j = 0; j < itemRuns.length; j += 1) runs.push(itemRuns[j])
  }
  return {
    kind: 'list',
    ordered,
    start: ordered ? start : null,
    items,
    runs,
    plainText: runsText(runs),
  }
}

function mdMakePipeCell(text, header, align) {
  const runs = parseInline(text)
  return {
    runs,
    plainText: runsText(runs),
    colspan: 1,
    rowspan: 1,
    header,
    align: align === undefined || align === null ? null : align,
  }
}

function mdMakeTableBlock(head, rows, caption) {
  const runs = []
  const pushCellRuns = (cell) => {
    if (runs.length > 0) runs.push({ type: 'text', text: ' ' })
    for (let i = 0; i < cell.runs.length; i += 1) runs.push(cell.runs[i])
  }
  for (let c = 0; c < head.length; c += 1) pushCellRuns(head[c])
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) pushCellRuns(rows[r][c])
  }
  return {
    kind: 'table',
    head,
    rows,
    caption,
    runs,
    plainText: runsText(runs),
  }
}

/* -------------------------------------------------------------------------- */
/* HTML table parsing                                                          */
/* -------------------------------------------------------------------------- */

/** Strip HTML tags to a single-line plain string (entities decoded). */
function mdPlainTextOfHtml(html) {
  const spaced = String(html ?? '').replace(/<[^>]*>/g, ' ')
  return mdDecodeEntities(spaced).replace(/\s+/g, ' ').trim()
}

/** Numeric table attribute (colspan/rowspan), clamped to a sane range. */
function mdSpanAttr(attrs, name) {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"(\\d+)"|\'(\\d+)\'|(\\d+))', 'i')
  const match = pattern.exec(String(attrs ?? ''))
  if (match === null) return 1
  const raw = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]
  const value = parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.min(value, 100)
}

function mdMakeHtmlCell(tagName, attrs, inner) {
  const runs = parseInline(inner)
  return {
    runs,
    plainText: runsText(runs),
    colspan: mdSpanAttr(attrs, 'colspan'),
    rowspan: mdSpanAttr(attrs, 'rowspan'),
    header: tagName.toLowerCase() === 'th',
  }
}

/** Parse the `td`/`th` cells inside one `<tr>` body. */
function mdParseHtmlCells(rowHtml) {
  const cells = []
  const strict = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
  let match = strict.exec(rowHtml)
  while (match !== null) {
    cells.push(mdMakeHtmlCell(match[1], match[2], match[3]))
    match = strict.exec(rowHtml)
  }
  if (cells.length > 0) return cells
  // Tolerate unclosed cells (badly serialised HTML); each cell runs to the next
  // opening cell tag or the end of the row.
  const loose = /<(t[hd])\b([^>]*)>([\s\S]*?)(?=<t[hd]\b|$)/gi
  match = loose.exec(rowHtml)
  while (match !== null) {
    cells.push(mdMakeHtmlCell(match[1], match[2], match[3]))
    match = loose.exec(rowHtml)
  }
  return cells
}

/** Parse every `<tr>` in a table-section fragment into rows of cells. */
function mdParseHtmlRows(html) {
  const rows = []
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let match = rowPattern.exec(html)
  while (match !== null) {
    const cells = mdParseHtmlCells(match[1])
    if (cells.length > 0) rows.push(cells)
    match = rowPattern.exec(html)
  }
  return rows
}

/** Parse one `<table>…</table>` fragment into a table block. */
function mdParseHtmlTable(html) {
  let work = String(html ?? '')
  let caption = ''
  const captionMatch = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(work)
  if (captionMatch !== null) {
    caption = mdPlainTextOfHtml(captionMatch[1])
    work = work.slice(0, captionMatch.index) + ' ' + work.slice(captionMatch.index + captionMatch[0].length)
  }
  let headerRows = []
  let bodyWork = work
  const theadMatch = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(bodyWork)
  if (theadMatch !== null) {
    headerRows = mdParseHtmlRows(theadMatch[1])
    bodyWork = bodyWork.slice(0, theadMatch.index) + ' ' + bodyWork.slice(theadMatch.index + theadMatch[0].length)
  }
  const tbodyMatch = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(bodyWork)
  const bodyRows = mdParseHtmlRows(tbodyMatch === null ? bodyWork : tbodyMatch[1])
  const head = []
  const rows = []
  if (headerRows.length > 0) {
    for (let i = 0; i < headerRows[0].length; i += 1) head.push(headerRows[0][i])
    for (let r = 1; r < headerRows.length; r += 1) rows.push(headerRows[r])
    for (let r = 0; r < bodyRows.length; r += 1) rows.push(bodyRows[r])
  } else if (bodyRows.length > 0 && bodyRows[0].some((cell) => cell.header === true)) {
    for (let i = 0; i < bodyRows[0].length; i += 1) head.push(bodyRows[0][i])
    for (let r = 1; r < bodyRows.length; r += 1) rows.push(bodyRows[r])
  } else {
    for (let r = 0; r < bodyRows.length; r += 1) rows.push(bodyRows[r])
  }
  return mdMakeTableBlock(head, rows, caption)
}

/* -------------------------------------------------------------------------- */
/* Pipe table parsing                                                          */
/* -------------------------------------------------------------------------- */

/** Split one GFM pipe-table row on unescaped `|`; null when there is no pipe. */
function mdSplitPipeRow(line) {
  let value = String(line ?? '').trim()
  if (value.indexOf('|') === -1) return null
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)
  const cells = []
  let current = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '\\' && value[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** Valid GFM delimiter-row cell (`---`, `:--`, `--:`, `:-:`). */
function mdIsDelimiterCell(cell) {
  return /^:?-{1,}:?$/.test(String(cell ?? '').trim())
}

function mdPipeAlignment(cell) {
  const value = String(cell ?? '').trim()
  if (!mdIsDelimiterCell(value)) return null
  const left = value.startsWith(':')
  const right = value.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return null
}

/** Whether lines[index] + lines[index+1] form a GFM pipe-table header pair. */
function mdIsPipeTableStart(lines, index) {
  if (index + 1 >= lines.length) return false
  const headerTexts = mdSplitPipeRow(lines[index])
  if (headerTexts === null || headerTexts.length === 0) return false
  const delimiterTexts = mdSplitPipeRow(lines[index + 1])
  if (delimiterTexts === null || delimiterTexts.length !== headerTexts.length) return false
  for (let i = 0; i < delimiterTexts.length; i += 1) {
    if (!mdIsDelimiterCell(delimiterTexts[i])) return false
  }
  return true
}

function mdTryPipeTable(lines, index) {
  if (!mdIsPipeTableStart(lines, index)) return null
  const headerTexts = mdSplitPipeRow(lines[index])
  const delimiterTexts = mdSplitPipeRow(lines[index + 1])
  const align = delimiterTexts.map((cell) => mdPipeAlignment(cell))
  const head = headerTexts.map((text, column) => mdMakePipeCell(text, true, align[column]))
  const rows = []
  let cursor = index + 2
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.trim() === '') break
    if (line.indexOf('|') === -1) break
    const cellTexts = mdSplitPipeRow(line)
    if (cellTexts === null) break
    const cells = []
    for (let column = 0; column < head.length; column += 1) {
      cells.push(mdMakePipeCell(cellTexts[column] === undefined ? '' : cellTexts[column], false, align[column]))
    }
    rows.push(cells)
    cursor += 1
  }
  return { block: mdMakeTableBlock(head, rows, ''), next: cursor }
}

/* -------------------------------------------------------------------------- */
/* Block construct readers                                                     */
/* -------------------------------------------------------------------------- */

/** Fenced code block (``` or ~~~), tolerating an unclosed fence at EOF. */
function mdTryFence(lines, index) {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index])
  if (match === null) return null
  const fence = match[1]
  const marker = fence[0]
  const size = fence.length
  const info = match[2].trim()
  const firstToken = info === '' ? '' : info.split(/\s+/)[0]
  const lang = firstToken === '' ? 'text' : firstToken
  const body = []
  let cursor = index + 1
  while (cursor < lines.length) {
    const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[cursor])
    if (close !== null && close[1][0] === marker && close[1].length >= size) {
      cursor += 1
      break
    }
    body.push(lines[cursor])
    cursor += 1
  }
  const code = body.join('\n')
  return { block: { kind: 'code', lang, code, plainText: code }, next: cursor }
}

/** Block formula: `$$ … $$` (single or multi-line) or `\[ … \]`. */
function mdTryBlockFormula(lines, index) {
  const trimmed = lines[index].trim()
  if (trimmed.startsWith('$$')) {
    if (trimmed.length > 3 && trimmed.endsWith('$$')) {
      const latex = trimmed.slice(2, trimmed.length - 2).trim()
      if (latex !== '') return { block: { kind: 'formula', latex, display: true }, next: index + 1 }
    }
    const collected = []
    const firstRest = trimmed.slice(2).trim()
    if (firstRest !== '') collected.push(firstRest)
    const limit = Math.min(lines.length, index + 1 + 200)
    for (let cursor = index + 1; cursor < limit; cursor += 1) {
      const part = lines[cursor].trim()
      if (part.endsWith('$$')) {
        const content = part.slice(0, -2).trim()
        if (content !== '') collected.push(content)
        const latex = collected.filter((piece) => piece !== '').join('\n')
        if (latex === '') return null
        return { block: { kind: 'formula', latex, display: true }, next: cursor + 1 }
      }
      collected.push(part)
    }
    return null
  }
  if (trimmed.startsWith('\\[')) {
    const collected = []
    const firstRest = trimmed.slice(2).trim()
    const sameLineEnd = firstRest.indexOf('\\]')
    if (sameLineEnd !== -1) {
      const latex = firstRest.slice(0, sameLineEnd).trim()
      if (latex !== '') return { block: { kind: 'formula', latex, display: true }, next: index + 1 }
    }
    if (firstRest !== '' && sameLineEnd === -1) collected.push(firstRest)
    const limit = Math.min(lines.length, index + 1 + 200)
    for (let cursor = index + 1; cursor < limit; cursor += 1) {
      const part = lines[cursor].trim()
      const endAt = part.indexOf('\\]')
      if (endAt !== -1) {
        const content = part.slice(0, endAt).trim()
        if (content !== '') collected.push(content)
        const latex = collected.filter((piece) => piece !== '').join('\n')
        if (latex === '') return null
        return { block: { kind: 'formula', latex, display: true }, next: cursor + 1 }
      }
      collected.push(part)
    }
    return null
  }
  return null
}

/** ATX heading; levels 5–6 clamp to 4 because the reader styles h1–h4. */
function mdTryHeading(lines, index) {
  const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/.exec(lines[index])
  if (match === null) return null
  const text = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim()
  if (text === '') return { block: null, next: index + 1 }
  const runs = parseInline(text)
  const plainText = runsText(runs)
  return {
    block: { kind: 'heading', level: Math.min(4, match[1].length), runs, plainText },
    next: index + 1,
  }
}

function mdIsHorizontalRule(line) {
  return /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line)
}

function mdTryRule(lines, index) {
  if (!mdIsHorizontalRule(lines[index])) return null
  return { block: { kind: 'rule' }, next: index + 1 }
}

/** HTML table, possibly spanning multiple lines. */
function mdTryHtmlTable(lines, index) {
  if (!/^<table\b/i.test(lines[index].trim())) return null
  let cursor = index
  let html = ''
  let closed = false
  while (cursor < lines.length) {
    html += (cursor === index ? '' : '\n') + lines[cursor]
    if (/<\/table\s*>/i.test(lines[cursor])) {
      closed = true
      cursor += 1
      break
    }
    cursor += 1
  }
  if (!closed) return null
  return { block: mdParseHtmlTable(html), next: cursor }
}

/** Consecutive `>` lines form one quote block. */
function mdTryQuote(lines, index) {
  if (!/^[ \t]{0,3}>/.test(lines[index])) return null
  const parts = []
  let cursor = index
  while (cursor < lines.length && /^[ \t]{0,3}>/.test(lines[cursor])) {
    const content = lines[cursor].replace(/^[ \t]{0,3}(?:>[ \t]?)+/, '').trim()
    if (content !== '') parts.push(content)
    cursor += 1
  }
  if (parts.length === 0) return { block: null, next: cursor }
  const runs = parseInline(parts.join(' '))
  return { block: { kind: 'quote', runs, plainText: runsText(runs) }, next: cursor }
}

/** Parse one list marker; returns null when the line is not a list item. */
function mdListMarker(line) {
  const match = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/.exec(line)
  if (match === null) return null
  const indent = match[1].replace(/\t/g, '    ').length
  const token = match[2]
  const ordered = token.charCodeAt(0) >= 48 && token.charCodeAt(0) <= 57
  return {
    indent,
    ordered,
    number: ordered ? parseInt(token, 10) : null,
    text: match[4] === undefined ? '' : match[4].trim(),
  }
}

/**
 * Unordered/ordered list. Indented continuation lines and deeper (nested) list
 * items are folded into the current top-level item's text, separated by spaces.
 */
function mdTryList(lines, index) {
  const first = mdListMarker(lines[index])
  if (first === null) return null
  const baseIndent = first.indent
  const ordered = first.ordered
  const start = ordered ? first.number : null
  const items = []
  let current = null
  const flushItem = () => {
    if (current === null) return
    const text = current.parts.join(' ').replace(/\s+/g, ' ').trim()
    const runs = text === '' ? [] : parseInline(text)
    items.push({ runs, plainText: runsText(runs) })
    current = null
  }
  let cursor = index
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.trim() === '') break
    const marker = mdListMarker(line)
    if (marker !== null) {
      if (marker.indent > baseIndent) {
        if (current === null) break
        if (marker.text !== '') current.parts.push(marker.text)
        cursor += 1
        continue
      }
      if (marker.ordered !== ordered) break
      flushItem()
      current = { parts: marker.text === '' ? [] : [marker.text] }
      cursor += 1
      continue
    }
    if (/^[ \t]+\S/.test(line)) {
      if (current === null) break
      current.parts.push(line.trim())
      cursor += 1
      continue
    }
    break
  }
  flushItem()
  if (items.length === 0) return null
  return { block: mdMakeListBlock(ordered, start, items), next: cursor }
}

/**
 * MinerU often carries the figure caption in the markdown image's alt text.
 * When the alt reads like a caption (starts with Figure/Table/… or is long
 * prose) mirror it into `caption` so the reader can render a visible figcaption;
 * short descriptive alts stay alt-only.
 */
function mdCaptionFromAlt(alt) {
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
function mdDetectFigure(text) {
  let value = String(text ?? '').trim()
  for (let guard = 0; guard < 4; guard += 1) {
    if (value === '') return null
    let wrapper = /^<center\b[^>]*>([\s\S]*)<\/center\s*>$/i.exec(value)
    if (wrapper === null) wrapper = /^<p\b[^>]*>([\s\S]*)<\/p\s*>$/i.exec(value)
    if (wrapper === null) wrapper = /^<div\b[^>]*>([\s\S]*)<\/div\s*>$/i.exec(value)
    if (wrapper === null) break
    value = wrapper[1].trim()
  }
  if (value === '') return null
  if (value[0] === '!') {
    const image = mdReadLink(value, 1)
    if (image !== null && image.end === value.length && image.url !== '') {
      return { src: image.url, alt: image.label, caption: mdCaptionFromAlt(image.label) }
    }
  }
  if (value[0] === '<') {
    const tag = /^<img\b((?:"[^"]*"|'[^']*'|[^'">])*)\/?>$/i.exec(value)
    if (tag !== null) {
      const src = mdHtmlAttr(tag[1], 'src')
      if (src === '') return null
      const alt = mdHtmlAttr(tag[1], 'alt')
      const title = mdHtmlAttr(tag[1], 'title')
      return { src, alt, caption: title !== '' ? title : mdCaptionFromAlt(alt) }
    }
  }
  return null
}

/** Whether `lines[index]` must interrupt an open paragraph. */
function mdStartsNewBlock(lines, index) {
  const line = lines[index]
  if (line.trim() === '') return true
  if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(line)) return true
  if (/^[ \t]{0,3}#{1,6}[ \t]+/.test(line)) return true
  if (/^[ \t]{0,3}\$\$/.test(line)) return true
  if (/^[ \t]{0,3}\\\[/.test(line)) return true
  if (mdIsHorizontalRule(line)) return true
  if (/^[ \t]{0,3}>/.test(line)) return true
  if (/^<table\b/i.test(line.trim())) return true
  if (mdListMarker(line) !== null) return true
  return mdIsPipeTableStart(lines, index)
}

/* -------------------------------------------------------------------------- */
/* Public parser                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parse MinerU-style markdown into the reading-block model.
 * @param {string} markdown
 * @returns {{blocks: object[], outline: object[], stats: object}}
 */
export function parseMarkdown(markdown) {
  const source = String(markdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const blocks = []
  const outline = []
  let index = 0
  while (index < lines.length) {
    if (lines[index].trim() === '') {
      index += 1
      continue
    }
    let result = mdTryFence(lines, index)
    if (result === null) result = mdTryBlockFormula(lines, index)
    if (result === null) result = mdTryHeading(lines, index)
    if (result === null) result = mdTryRule(lines, index)
    if (result === null) result = mdTryHtmlTable(lines, index)
    if (result === null) result = mdTryPipeTable(lines, index)
    if (result === null) result = mdTryQuote(lines, index)
    if (result === null) result = mdTryList(lines, index)
    if (result !== null) {
      if (result.block !== null) mdAppendBlock(blocks, outline, result.block)
      index = result.next
      continue
    }
    const parts = []
    while (index < lines.length) {
      if (lines[index].trim() === '') break
      if (parts.length > 0 && mdStartsNewBlock(lines, index)) break
      parts.push(lines[index].trim())
      index += 1
    }
    if (parts.length === 0) {
      index += 1
      continue
    }
    const text = parts.join(' ').trim()
    if (text === '') continue
    const figure = mdDetectFigure(text)
    if (figure !== null) {
      mdAppendBlock(blocks, outline, {
        kind: 'figure',
        src: figure.src,
        alt: figure.alt,
        caption: figure.caption,
      })
      continue
    }
    const runs = parseInline(text)
    mdAppendBlock(blocks, outline, { kind: 'paragraph', runs, plainText: runsText(runs) })
  }
  return { blocks, outline, stats: mdStats(blocks) }
}

/* -------------------------------------------------------------------------- */
/* Page marks                                                                  */
/* -------------------------------------------------------------------------- */

const MD_MATCH_WINDOW = 32

function mdNormalizeMatchText(text) {
  return String(text ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

function mdJoinListText(value) {
  if (!Array.isArray(value)) return ''
  const parts = []
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === undefined || value[i] === null) continue
    const text = String(value[i])
    if (text !== '') parts.push(text)
  }
  return parts.join(' ')
}

function mdBaseName(value) {
  const text = String(value ?? '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return cut === -1 ? text : text.slice(cut + 1)
}

function mdEquationMatchText(text) {
  let value = String(text ?? '').trim()
  value = value.replace(/^\$\$?/, '').replace(/\$\$?$/, '')
  value = value.replace(/^\\\[/, '').replace(/\\\]$/, '')
  value = value.replace(/^\\\(/, '').replace(/\\\)$/, '')
  return value.trim()
}

/** Text used to align a content-list entry with a parser block. */
function mdContentEntryText(entry) {
  const type = String(entry.type ?? '')
  if (type === 'equation') return mdEquationMatchText(entry.text ?? entry.latex ?? '')
  if (type === 'list') {
    const joined = mdJoinListText(entry.list_items)
    if (joined !== '') return joined
    return mdJoinListText(entry.text)
  }
  if (type === 'table') {
    const body = mdPlainTextOfHtml(entry.table_body ?? '')
    if (body !== '') return body
    return mdJoinListText(entry.table_caption)
  }
  return String(entry.text ?? entry.latex ?? '')
}

/** Candidate match text for a parser block (cached in `cache`). */
function mdBlockMatchText(block, cache) {
  const cached = cache.get(block)
  if (cached !== undefined) return cached
  let text = mdPlainTextOfBlockSafe(block)
  // Content-list list entries join the item strings with spaces; the block's
  // run space concatenates them without a separator (client-ui offset math).
  if (block.kind === 'list' && Array.isArray(block.items)) {
    const parts = []
    for (let i = 0; i < block.items.length; i += 1) {
      const item = block.items[i]
      if (item !== null && typeof item === 'object' && typeof item.plainText === 'string') parts.push(item.plainText)
    }
    text = parts.join(' ')
  }
  const normalized = mdNormalizeMatchText(text)
  cache.set(block, normalized)
  return normalized
}

function mdPlainTextOfBlockSafe(block) {
  if (block === null || typeof block !== 'object') return ''
  if (typeof block.plainText === 'string') return block.plainText
  if (Array.isArray(block.runs)) return runsText(block.runs)
  if (block.kind === 'code') return typeof block.code === 'string' ? block.code : ''
  if (block.kind === 'formula') return typeof block.latex === 'string' ? block.latex : ''
  return ''
}

function mdKindAllowsMatch(kind, type) {
  if (type === 'title') return kind === 'heading'
  if (type === 'list') return kind === 'list'
  if (type === 'equation') return kind === 'formula'
  if (type === 'table') return kind === 'table'
  return true
}

/** Find the next parser block matching one content-list entry (best effort). */
function mdMatchContentEntry(blocks, entry, from, cache) {
  const type = String(entry.type ?? '')
  const start = from < 0 ? 0 : from
  const end = Math.min(blocks.length, start + MD_MATCH_WINDOW)
  if (type === 'image') {
    const expected = mdBaseName(entry.img_path ?? '')
    const caption = mdNormalizeMatchText(mdJoinListText(entry.image_caption))
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block === null || typeof block !== 'object' || block.kind !== 'figure') continue
      const source = mdBaseName(block.src ?? '')
      if (expected !== '' && source === expected) return i
      if (caption !== '') {
        const alt = mdNormalizeMatchText(block.alt ?? '')
        if (alt !== '' && (alt.startsWith(caption.slice(0, 24)) || caption.startsWith(alt.slice(0, 24)))) return i
      }
    }
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block !== null && typeof block === 'object' && block.kind === 'figure') return i
    }
    return -1
  }
  const matchText = mdNormalizeMatchText(mdContentEntryText(entry))
  if (matchText === '') return -1
  for (let pass = 0; pass < 3; pass += 1) {
    const size = pass === 0 ? 48 : pass === 1 ? 24 : 12
    const needle = matchText.slice(0, size)
    if (needle === '') continue
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block === null || typeof block !== 'object') continue
      if (!mdKindAllowsMatch(block.kind, type)) continue
      const haystack = mdBlockMatchText(block, cache)
      if (haystack !== '' && haystack.startsWith(needle)) return i
    }
  }
  const containsNeedle = matchText.slice(0, 24)
  if (containsNeedle !== '') {
    for (let i = start; i < end; i += 1) {
      const block = blocks[i]
      if (block === null || typeof block !== 'object') continue
      if (!mdKindAllowsMatch(block.kind, type)) continue
      const haystack = mdBlockMatchText(block, cache)
      if (haystack !== '' && haystack.indexOf(containsNeedle) !== -1) return i
    }
  }
  return -1
}

/**
 * Best-effort page marks from MinerU's content list.
 *
 * Walks the content list sequentially, tracks `page_idx` transitions and
 * inserts a `{ kind:'page', page }` block before the parser block matched by the
 * first content entry of each new page (page is a 1-based display number).
 * Entries whose text cannot be matched (`image`/`equation` mismatches, dropped
 * inline markup, …) fall back to the next block after the last matched position.
 *
 * Annotation stability (docs/UI-SPEC.md reader contract): the returned model is
 * a NEW model object, but every original block keeps its exact `index` and `key`
 * (page marks are display-only and never shift annotation/translation anchors).
 * Inserted page blocks carry `index` = their insertion slot in the marker-free
 * block order (an informational number that may repeat an original block's
 * index) and a synthetic key `page:<page>:<slot>`, so React keys/anchor lookups
 * stay unique. `outline` entries are carried over unchanged. The input model is
 * never mutated, and calling it twice with the same content list is idempotent.
 *
 * @param {{blocks: object[], outline: object[], stats: object}} model
 * @param {object[]} contentList MinerU `*_content_list.json`
 * @returns {{blocks: object[], outline: object[], stats: object}} new model
 */
export function appendPageMarks(model, contentList) {
  if (model === null || typeof model !== 'object' || !Array.isArray(model.blocks)) return model
  if (!Array.isArray(contentList) || contentList.length === 0) return model
  const blocks = []
  for (let i = 0; i < model.blocks.length; i += 1) {
    const block = model.blocks[i]
    if (block === null || typeof block !== 'object') continue
    if (block.kind !== 'page') blocks.push(block)
  }
  const cache = new Map()
  const insertions = []
  const insertedPages = new Set()
  let currentPage = null
  let lastMatched = -1
  for (let e = 0; e < contentList.length; e += 1) {
    const entry = contentList[e]
    if (entry === null || typeof entry !== 'object') continue
    const rawPage = Number(entry.page_idx)
    const pageValue = Number.isFinite(rawPage) ? Math.trunc(rawPage) : currentPage
    const pageChanged = pageValue !== null && pageValue !== currentPage
    const match = mdMatchContentEntry(blocks, entry, lastMatched + 1, cache)
    if (match >= 0) lastMatched = match
    if (pageChanged) {
      currentPage = pageValue
      const displayPage = Math.max(1, pageValue + 1)
      if (!insertedPages.has(displayPage)) {
        insertedPages.add(displayPage)
        const before = match >= 0 ? match : Math.min(lastMatched + 1, blocks.length)
        insertions.push({ before, page: displayPage })
      }
    }
  }
  if (insertions.length === 0) return model
  const pageBlock = (page, slot) => ({ index: slot, key: 'page:' + page + ':' + slot, kind: 'page', page })
  insertions.sort((left, right) => left.before - right.before)
  const rebuilt = []
  let next = 0
  for (let position = 0; position <= blocks.length; position += 1) {
    while (next < insertions.length && insertions[next].before === position) {
      rebuilt.push(pageBlock(insertions[next].page, position))
      next += 1
    }
    if (position < blocks.length) rebuilt.push(Object.assign({}, blocks[position]))
  }
  while (next < insertions.length) {
    rebuilt.push(pageBlock(insertions[next].page, blocks.length))
    next += 1
  }
  return {
    blocks: rebuilt,
    outline: Array.isArray(model.outline) ? model.outline.slice() : [],
    stats: mdStats(rebuilt),
  }
}

/** Plain text of one block, cached by the parser. */
export function plainTextOfBlock(block) {
  return mdPlainTextOfBlockSafe(block)
}
