/**
 * dsh-litnotes client: the right-margin grounded AI reading panel.
 *
 * `MruAiPanel` is the complete per-document chat UI described by
 * docs/AI-SPEC.md §6. It is plain ES2022 + React.createElement (`h`); it has no
 * imports and no JSX, and every top-level declaration is prefixed with
 * `mruAi`/`MruAi` so the concatenated factory scope (markdown.js → highlight.js
 * → chat.js → graph.js → app.js) stays collision-free. The build strips the
 * leading `export ` keyword, so the exported declarations below double as the
 * bundle-scope declarations.
 *
 * Public exports (pure helpers are unit-tested directly from this file):
 *   mruAiParseAnswer(text)        -> { answer, data, hasFence }
 *   mruAiCitationMarkers(text)    -> [{ type:'text'|'citation', text, start, end, index? }]
 *   mruAiCitationFlags(citation, verified) -> { partial, unsupported }
 *   mruAiUnverifiedBreakdown(unverified)   -> { unsupported, generic, total }
 *   mruAiExportMarkdown(messages, meta)    -> { filename, markdown } | null
 *   mruAiNormalizeMessages(raw)   -> ChatMessage[] (docs/AI-SPEC.md §2 shape)
 *   MruAiPanel(props)             -> React component
 *
 * Props consumed (exactly docs/AI-SPEC.md §6):
 *   { t, documentId, documentTitle, modelLabel, available, katexReady, context,
 *     onJump, onAnnotationsChanged, onGraphDelta, onOpenGraph, post, streamChat,
 *     onNotify, onExportConversation(markdown, filename) }
 * All callbacks are optional at runtime (the panel degrades to a read-only /
 * retry state rather than throwing when the host is not wired yet). `post` is
 * `mruPost`-shaped; `streamChat(request, { onFrame, signal })` is the NDJSON
 * helper from app.js and the request body follows §3 (`documentId`, `question`,
 * `focus`, `mode:'doc'`, `regenerateOf?`).
 *
 * Class contract: all panel-owned classes are exactly docs/AI-SPEC.md §8
 * `.mru-ai*`. The only extra modifier classes used here (design may style or
 * ignore them) are:
 *   .mru-ai__msg--streaming     assistant message currently receiving frames
 *   .mru-ai__chip--selection    context chip for the current text selection
 *   .mru-ai__chip--visible      context chip for the current visible paragraph
 *   .mru-ai__citation--missing  an inline [n] with no citation data in the message
 *   .mru-ai__citation--partial  verified citation whose quote only partly supports
 *                               its claim (docs/RESEARCH.md entailment pass)
 *   .mru-ai__claim              claim-check meta row inside the citation card
 *   .mru-ai__claim--partial     part-of-claim-check row for a partial verdict
 *   .mru-ai__claim--unsupported claim-check row for an unsupported verdict
 *   .mru-ai__notice--entailment answer notice for entailment-unsupported citations
 *   .mru-ai__action--compact    small icon-only action (chip clear, dismiss)
 * State is otherwise expressed through `data-available`, `data-busy`,
 * `data-state`, `data-streaming`, `data-index`, `data-verified` and
 * `data-message-id`. Rich answer text reuses the existing `.mru-rich`,
 * `.mru-code`, `.mru-inline-code`, `.mru-formula` and `.mru-link` classes so the
 * reader typography applies unchanged.
 *
 * Locale: every string goes through `props.t` / `mruAiT(t,key,params)` with the
 * `ai.*` keys registered in the app dictionaries (ui/app.js ZH/EN); the wrapper
 * does `{param}` interpolation and falls back to the key, so this module keeps
 * no copy of its own. Aspect labels reuse the reader keys
 * `aspect.definition|context|method|result|limitation`. The panel never writes
 * the document body or browser storage; the citation card is a fixed-position
 * overlay rendered inside the component tree.
 */

/** Quick prompts shown in the empty state (docs/AI-SPEC.md §6). */
const mruAiQuickPrompts = [
  'ai.quickSummary',
  'ai.quickSolved',
  'ai.quickMethod',
  'ai.quickLimits',
  'ai.quickConcept',
]

/** Aspect values accepted from the host (mirrors lib/ai/aspects.js). */
const mruAiAspects = ['definition', 'method', 'result', 'limitation', 'context']

/** Entailment verdicts the host may attach to a citation (docs/RESEARCH.md). */
const mruAiEntailmentValues = ['supported', 'partial', 'unsupported', 'unchecked']

/** Unverified reason for a verified quote that does not support its claim. */
const mruAiEntailmentUnsupportedReason = 'entailment-unsupported'

/**
 * Translate through the app dictionaries (ui/app.js ZH/EN): `{param}`
 * interpolation plus key-as-fallback. This module carries no copy of its own
 * (docs/AI-SPEC.md §6 — all copy lives in the app dictionaries).
 */
function mruAiT(t, key, params) {
  let value = ''
  if (typeof t === 'function') {
    try {
      value = t(key)
    } catch {
      value = ''
    }
  }
  if (typeof value !== 'string' || value === '') value = String(key)
  if (params !== undefined && params !== null) {
    value = value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* Pure helpers: answer split, citation markers, history normalization         */
/* -------------------------------------------------------------------------- */

/** Trim only trailing whitespace so leading markdown indentation survives. */
function mruAiTrimEnd(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+$/, '')
}

/** Recognize an opening code fence. Returns null for ordinary lines. */
function mruAiFenceOpen(line) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/.exec(String(line))
  if (match === null) return null
  return {
    char: match[1].charAt(0),
    length: match[1].length,
    info: match[2].toLowerCase(),
  }
}

/** Whether `line` closes `fence` (same character, at least as long). */
function mruAiFenceClose(line, fence) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(String(line))
  if (match === null) return null
  if (match[1].charAt(0) !== fence.char) return null
  if (match[1].length < fence.length) return null
  return true
}

/** Parse a JSON object, recovering one surrounded by prose or trailing commas. */
function mruAiTryJson(body) {
  const text = String(body === undefined || body === null ? '' : body).trim()
  if (text === '') return null
  const candidates = [text]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* try a lenient pass below */
    }
    try {
      const parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* not JSON */
    }
  }
  return null
}

/**
 * Split one assistant answer into display markdown and the trailing structured
 * `litnotes-json` payload (docs/AI-SPEC.md §5).
 *
 * Robustness rules:
 *  - only a *trailing* fenced block is consumed (nothing but whitespace after the
 *    closing fence); an unclosed trailing fence is consumed too, so a partially
 *    streamed answer never shows raw JSON;
 *  - ``` or ~~~ fences with 0–3 leading spaces are accepted; info string is
 *    case-insensitive; the body may contain prose/trailing commas (best effort);
 *  - JSON that is not a plain object yields `data: null` but is still stripped;
 *  - earlier code fences in the answer are preserved untouched.
 *
 * @param {string} text
 * @returns {{answer:string, data:object|null, hasFence:boolean}}
 */
export function mruAiParseAnswer(text) {
  const normalized = String(text === undefined || text === null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  let openLine = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const fence = mruAiFenceOpen(lines[i])
    if (fence !== null && fence.info === 'litnotes-json') {
      openLine = i
      break
    }
  }
  if (openLine === -1) {
    return { answer: mruAiTrimEnd(normalized), data: null, hasFence: false }
  }
  const open = mruAiFenceOpen(lines[openLine])
  let closeLine = -1
  for (let i = openLine + 1; i < lines.length; i += 1) {
    if (mruAiFenceClose(lines[i], open) !== null) {
      closeLine = i
      break
    }
  }
  const trailing = closeLine === -1
    ? true
    : lines.slice(closeLine + 1).every((line) => line.trim() === '')
  if (!trailing) {
    return { answer: mruAiTrimEnd(normalized), data: null, hasFence: false }
  }
  const answer = mruAiTrimEnd(lines.slice(0, openLine).join('\n'))
  const bodyLines = closeLine === -1
    ? lines.slice(openLine + 1)
    : lines.slice(openLine + 1, closeLine)
  return {
    answer,
    data: mruAiTryJson(bodyLines.join('\n')),
    hasFence: true,
  }
}

/** Find the closing backtick run of exactly `length` characters, or -1. */
function mruAiFindBacktickClose(line, from, length) {
  let index = from
  while (index < line.length) {
    if (line.charAt(index) === '`') {
      let run = 1
      while (index + run < line.length && line.charAt(index + run) === '`') run += 1
      if (run === length) return index
      index += run
    } else {
      index += 1
    }
  }
  return -1
}

/** Append a literal span to the pending text buffer. */
function mruAiPushText(parts, buffer, span) {
  if (span.text === '') return buffer
  if (buffer.text === '') buffer.start = span.start
  buffer.text += span.text
  return buffer
}

/** Flush the pending literal buffer as one text part. */
function mruAiFlushText(parts, buffer) {
  if (buffer.text === '') return
  parts.push({
    type: 'text',
    text: buffer.text,
    start: buffer.start,
    end: buffer.start + buffer.text.length,
  })
  buffer.text = ''
}

/** Scan one non-fenced line for inline code spans and `[n]` markers. */
function mruAiScanCitationLine(line, lineOffset, parts, buffer) {
  let index = 0
  while (index < line.length) {
    const character = line.charAt(index)
    if (character === '\\') {
      const end = Math.min(line.length, index + 2)
      mruAiPushText(parts, buffer, {
        text: line.slice(index, end),
        start: lineOffset + index,
      })
      index = end
      continue
    }
    if (character === '`') {
      let run = 1
      while (index + run < line.length && line.charAt(index + run) === '`') run += 1
      const close = mruAiFindBacktickClose(line, index + run, run)
      const end = close === -1 ? index + run : close + run
      mruAiPushText(parts, buffer, {
        text: line.slice(index, end),
        start: lineOffset + index,
      })
      index = end
      continue
    }
    if (character === '[') {
      const match = /^\[([1-9]\d{0,2})\]/.exec(line.slice(index))
      if (match !== null) {
        const next = line.charAt(index + match[0].length)
        // `[1](…)` is an inline link and `[1]:` a link definition, not a citation.
        if (next !== '(' && next !== ':') {
          mruAiFlushText(parts, buffer)
          const start = lineOffset + index
          parts.push({
            type: 'citation',
            index: Number(match[1]),
            text: match[0],
            start,
            end: start + match[0].length,
          })
          index += match[0].length
          continue
        }
      }
    }
    let next = index + 1
    while (next < line.length && '\\`['.indexOf(line.charAt(next)) === -1) {
      next += 1
    }
    mruAiPushText(parts, buffer, {
      text: line.slice(index, next),
      start: lineOffset + index,
    })
    index = next
  }
}

/**
 * Split text into literal and inline citation-marker parts.
 *
 * Recognized markers are `[n]` with n in 1…999. Markers inside fenced code
 * blocks, inline code spans and escaped brackets (`\[1]`) are literal; `[1](url)`
 * and `[1]:` keep their Markdown meaning instead of becoming chips. Adjacent
 * markers (`[1][2]`) are both citations.
 *
 * @param {string} text
 * @returns {{type:'text'|'citation', text:string, start:number, end:number, index?:number}[]}
 */
export function mruAiCitationMarkers(text) {
  const source = String(text === undefined || text === null ? '' : text)
  const parts = []
  if (source === '') return parts
  const buffer = { text: '', start: 0 }
  const lines = source.split('\n')
  let fence = null
  let offset = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const lineOffset = offset
    const newline = lineIndex < lines.length - 1 ? '\n' : ''
    if (fence !== null) {
      mruAiPushText(parts, buffer, { text: line + newline, start: lineOffset })
      if (mruAiFenceClose(line, fence) !== null) fence = null
    } else {
      const open = mruAiFenceOpen(line)
      if (open !== null) {
        fence = open
        mruAiPushText(parts, buffer, { text: line + newline, start: lineOffset })
      } else {
        mruAiScanCitationLine(line, lineOffset, parts, buffer)
        mruAiPushText(parts, buffer, { text: newline, start: lineOffset + line.length })
      }
    }
    offset += line.length + newline.length
  }
  mruAiFlushText(parts, buffer)
  return parts
}

/** One string, or '' for anything else. */
function mruAiString(value) {
  return typeof value === 'string' ? value : ''
}

/** Finite integer, or null. */
function mruAiInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

/** Non-empty trimmed strings from a raw array. */
function mruAiStringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string') continue
    const text = value[i].trim()
    if (text !== '') out.push(text)
  }
  return out
}

/** Normalize one aspect value; unknown values become 'context'. */
function mruAiAspect(value) {
  return mruAiAspects.indexOf(value) === -1 ? 'context' : value
}

/** Normalize one entailment verdict; unknown/absent values become ''. */
function mruAiNormalizeEntailment(value) {
  return mruAiEntailmentValues.indexOf(value) === -1 ? '' : value
}

/** Normalize model route objects (`{provider, model}`). */
function mruAiNormalizeModel(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const provider = mruAiString(value.provider)
  const model = mruAiString(value.model)
  if (provider === '' && model === '') return null
  return { provider, model }
}

/** Normalize token usage; null only when the object carries no numbers. */
function mruAiNormalizeUsage(value) {
  const input = mruAiInteger(value && value.inputTokens)
  const output = mruAiInteger(value && value.outputTokens)
  if (input === null && output === null) return { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: input !== null && input > 0 ? input : 0,
    outputTokens: output !== null && output > 0 ? output : 0,
  }
}

/** Normalize a knowledge delta reference list. */
function mruAiNormalizeKnowledge(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { nodeIds: [], edgeIds: [] }
  }
  return {
    nodeIds: mruAiStringList(value.nodeIds),
    edgeIds: mruAiStringList(value.edgeIds),
  }
}

/**
 * Normalize one citations array. Entries need a usable index (falling back to
 * their array position) and at least a blockKey or a quote.
 */
function mruAiNormalizeCitationList(raw, forceUnverified) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const rawIndex = mruAiInteger(item.index)
    const index = rawIndex !== null && rawIndex >= 1 ? rawIndex : i + 1
    const blockKey = mruAiString(item.blockKey).trim()
    const quote = mruAiString(item.quote)
    if (blockKey === '' && quote === '') continue
    const start = mruAiInteger(item.start)
    const end = mruAiInteger(item.end)
    const page = mruAiInteger(item.page)
    out.push({
      index,
      blockKey,
      quote,
      start: start !== null && start >= 0 ? start : null,
      end: end !== null && end >= 0 ? end : null,
      page: page !== null && page > 0 ? page : null,
      aspect: mruAiAspect(item.aspect),
      note: mruAiString(item.note),
      verified: forceUnverified === true ? false : item.verified !== false,
      // Entailment pass (docs/RESEARCH.md line 177): a verified quote can still
      // be partial/unsupported for the claim it is attached to; unsupported
      // entries arrive here in `unverified` with reason 'entailment-unsupported'.
      entailment: mruAiNormalizeEntailment(item.entailment),
      entailmentReason: mruAiString(item.entailmentReason),
      reason: mruAiString(item.reason),
    })
  }
  return out
}

/**
 * Entailment flags for one citation chip/card.
 *
 * `partial` — the quote only partly supports the claim (verified, warned, still
 * jumpable). `unsupported` — the quote does not support the claim: the host
 * moved it to `unverified` (reason `entailment-unsupported`); the UI keeps it
 * dimmed and must not jump from it.
 *
 * @param {object|null} citation normalized citation
 * @param {boolean} verified whether the host validated the quote
 * @returns {{partial:boolean, unsupported:boolean}}
 */
export function mruAiCitationFlags(citation, verified) {
  const item = citation !== null && typeof citation === 'object' ? citation : {}
  const entailment = mruAiString(item.entailment)
  const reason = mruAiString(item.reason)
  return {
    partial: entailment === 'partial',
    unsupported: verified === false
      && (reason === mruAiEntailmentUnsupportedReason || entailment === 'unsupported'),
  }
}

/**
 * Split the unverified citations into entailment-unsupported entries and every
 * other failure reason, so the answer footer can pick the right notice.
 *
 * @param {object[]} unverified normalized unverified citations
 * @returns {{unsupported:number, generic:number, total:number}}
 */
export function mruAiUnverifiedBreakdown(unverified) {
  const list = Array.isArray(unverified) ? unverified : []
  let unsupported = 0
  for (let i = 0; i < list.length; i += 1) {
    if (mruAiCitationFlags(list[i], false).unsupported) unsupported += 1
  }
  return { unsupported, generic: list.length - unsupported, total: list.length }
}

/** Normalize one history payload (array, `{messages}`, or `{value:{messages}}`). */
export function mruAiNormalizeMessages(raw) {
  let list = null
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw !== null && typeof raw === 'object') {
    if (Array.isArray(raw.messages)) list = raw.messages
    else if (Array.isArray(raw.items)) list = raw.items
    else if (raw.value !== null && typeof raw.value === 'object' && Array.isArray(raw.value.messages)) {
      list = raw.value.messages
    }
  }
  if (list === null) return []
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    let role = item.role === 'assistant' || item.role === 'user' ? item.role : ''
    if (role === '') {
      role = typeof item.answer === 'string' && item.answer !== '' ? 'assistant' : 'user'
    }
    let question = mruAiString(item.question)
    if (question === '') question = mruAiString(item.content)
    if (role === 'user' && question.trim() === '') continue
    let answer = mruAiString(item.answer)
    let fenced = null
    if (role === 'assistant' && answer.indexOf('litnotes-json') !== -1) {
      const parsed = mruAiParseAnswer(answer)
      if (parsed.hasFence) {
        answer = parsed.answer
        fenced = parsed.data
      }
    }
    const citations = mruAiNormalizeCitationList(
      Array.isArray(item.citations) ? item.citations : (fenced && fenced.citations),
      false,
    )
    const unverified = mruAiNormalizeCitationList(
      Array.isArray(item.unverified) ? item.unverified : (fenced && fenced.unverified),
      true,
    )
    const followups = mruAiStringList(
      Array.isArray(item.followups) ? item.followups : (fenced && fenced.followups),
    )
    let id = mruAiString(item.id).trim()
    if (id === '') id = `history-${i}`
    for (let duplicate = 0; duplicate < out.length; duplicate += 1) {
      if (out[duplicate].id === id) {
        id = `${id}-${i}`
        break
      }
    }
    out.push({
      id,
      role,
      question,
      answer,
      citations,
      unverified,
      followups,
      model: mruAiNormalizeModel(item.model),
      usage: mruAiNormalizeUsage(item.usage),
      annotationIds: mruAiStringList(item.annotationIds),
      knowledge: mruAiNormalizeKnowledge(Array.isArray(item.knowledge) ? null : item.knowledge),
      createdAt: mruAiString(item.createdAt),
    })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Conversation export (docs/AI-SPEC.md §6 / PLAN C5)                         */
/* -------------------------------------------------------------------------- */

/** Format an export timestamp as `YYYY-MM-DD HH:mm` in local time. */
function mruAiExportStamp(value) {
  const text = mruAiString(value).trim()
  if (text === '') return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Sanitize a conversation title into a portable Markdown download filename. */
function mruAiExportFilename(title) {
  let base = mruAiString(title)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s-]+$/, '')
  if (base.length > 80) base = base.slice(0, 80).replace(/[.\s-]+$/, '')
  if (base === '') base = 'ai-conversation'
  return `${base}.md`
}

/** Split normalized messages into question -> answers turns for export. */
function mruAiExportTurns(messages) {
  const list = Array.isArray(messages) ? messages : []
  const turns = []
  for (let i = 0; i < list.length; i += 1) {
    const message = list[i]
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'user') {
      turns.push({ question: mruAiString(message.question), answers: [] })
      continue
    }
    let turn = turns.length > 0 ? turns[turns.length - 1] : null
    if (turn === null || turn.answers.length > 0) {
      turn = { question: mruAiString(message.question), answers: [] }
      turns.push(turn)
    }
    turn.answers.push(message)
  }
  return turns
}

/** One exported citation line: `[n] · p.page · aspect · quote · note`. */
function mruAiExportCitationLine(citation, verified, t) {
  const item = citation !== null && typeof citation === 'object' ? citation : {}
  const parts = [`[${Number(item.index) || 0}]`]
  if (item.page !== null && Number(item.page) > 0) parts.push(`p.${Number(item.page)}`)
  parts.push(mruAiT(t, 'aspect.' + mruAiAspect(item.aspect)))
  const quote = mruAiString(item.quote).replace(/\s+/g, ' ').trim()
  if (quote !== '') parts.push(quote)
  const note = mruAiString(item.note).replace(/\s+/g, ' ').trim()
  if (note !== '') parts.push(note)
  if (verified !== true) parts.push(mruAiT(t, 'ai.exportUnverified'))
  return parts.join(' · ')
}

/** Export lines for one answer's verified citations followed by unverified ones. */
function mruAiExportCitationLines(citations, unverified, t) {
  const lines = []
  const verifiedList = Array.isArray(citations) ? citations : []
  const unverifiedList = Array.isArray(unverified) ? unverified : []
  for (let i = 0; i < verifiedList.length; i += 1) {
    lines.push(mruAiExportCitationLine(verifiedList[i], true, t))
  }
  for (let i = 0; i < unverifiedList.length; i += 1) {
    lines.push(mruAiExportCitationLine(unverifiedList[i], false, t))
  }
  return lines
}

/**
 * Render one conversation as a portable Markdown document (docs/AI-SPEC.md §6,
 * PLAN C5). Localized through `meta.t` with the reserved `ai.export*` keys; the
 * answer markdown is embedded verbatim and each answer's citations become a
 * `[n] · p.page · aspect · quote · note` list (unverified entries are marked).
 *
 * @param {object[]|object} messages ChatMessage[] (or a `{messages}` history payload)
 * @param {{title?:string, modelLabel?:string, exportedAt?:string,
 *          t?:((key:string, params?:object)=>string)|null}} [meta]
 * @returns {{filename:string, markdown:string}|null} null for an empty conversation
 */
export function mruAiExportMarkdown(messages, meta) {
  const source = meta !== null && typeof meta === 'object' ? meta : {}
  const t = typeof source.t === 'function' ? source.t : null
  const list = mruAiNormalizeMessages(messages)
  const turns = mruAiExportTurns(list)
  if (turns.length === 0) return null
  const title = mruAiString(source.title).trim()
  const head = [title !== '' ? `# ${title} — ${mruAiT(t, 'ai.exportTitle')}` : `# ${mruAiT(t, 'ai.exportTitle')}`, '']
  const modelLabel = mruAiString(source.modelLabel).trim()
  if (modelLabel !== '') head.push(`- ${mruAiT(t, 'ai.exportModel')}: ${modelLabel}`)
  const exportedAt = mruAiString(source.exportedAt).trim()
  head.push(`- ${mruAiT(t, 'ai.exportTime')}: ${mruAiExportStamp(exportedAt !== '' ? exportedAt : new Date().toISOString())}`)
  const blocks = []
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]
    const ordinal = i + 1
    const block = [`## ${mruAiT(t, 'ai.exportQuestion', { index: ordinal })}`]
    const question = mruAiString(turn.question).trim()
    if (question !== '') block.push(question)
    block.push('', `## ${mruAiT(t, 'ai.exportAnswer', { index: ordinal })}`)
    const answers = []
    const citations = []
    const unverified = []
    for (let a = 0; a < turn.answers.length; a += 1) {
      const message = turn.answers[a]
      const answer = mruAiString(message.answer).trim()
      if (answer !== '') answers.push(answer)
      if (Array.isArray(message.citations)) citations.push(...message.citations)
      if (Array.isArray(message.unverified)) unverified.push(...message.unverified)
    }
    if (answers.length > 0) block.push(answers.join('\n\n'))
    const citationLines = mruAiExportCitationLines(citations, unverified, t)
    if (citationLines.length > 0) {
      block.push('', `### ${mruAiT(t, 'ai.exportCitation')}`)
      for (let c = 0; c < citationLines.length; c += 1) block.push(`- ${citationLines[c]}`)
    }
    blocks.push(block.join('\n'))
  }
  return {
    filename: mruAiExportFilename(title),
    markdown: `${head.join('\n')}\n\n${blocks.join('\n\n')}\n`,
  }
}

/* -------------------------------------------------------------------------- */
/* Small runtime wrappers (the bundle provides these app.js helpers)           */
/* -------------------------------------------------------------------------- */

/** Safe display text wrapper around mruDisplayText. */
function mruAiDisplayText(value) {
  if (typeof mruDisplayText === 'function') {
    try {
      return mruDisplayText(value)
    } catch {
      /* fall through */
    }
  }
  return String(value === undefined || value === null ? '' : value).replace(/\ufffd/g, '□')
}

/** Safe locale number wrapper around mruFormatCount. */
function mruAiFormatCount(value) {
  if (typeof mruFormatCount === 'function') {
    try {
      return mruFormatCount(value)
    } catch {
      /* fall through */
    }
  }
  const number = Number(value) || 0
  try {
    return new Intl.NumberFormat().format(number)
  } catch {
    return String(number)
  }
}

/** Safe overlay position wrapper around mruOverlayPos. */
function mruAiOverlayPosition(rect, width, height) {
  if (typeof mruOverlayPos === 'function') {
    try {
      return mruOverlayPos(rect, width, height)
    } catch {
      /* fall through */
    }
  }
  const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1280
  const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
  let left = rect ? rect.left + rect.width / 2 - width / 2 : 12
  left = clamp(left, 12, Math.max(12, viewportWidth - width - 12))
  let top = rect ? rect.top - height - 10 : 12
  if (rect && top < 12) top = rect.bottom + 10
  top = clamp(top, 12, Math.max(12, viewportHeight - height - 12))
  return { left: Math.round(left), top: Math.round(top) }
}

/** Turn host/stream failures into reader-facing copy. */
function mruAiErrorText(t, error) {
  if (typeof error === 'string') return error
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'llm-unavailable') return mruAiT(t, 'ai.errModel')
  if (code === 'llm-failed') return mruAiT(t, 'ai.errFailed')
  if (code === 'context-too-large') return mruAiT(t, 'ai.errContext')
  if (code === 'aborted') return mruAiT(t, 'ai.errAborted')
  if (code === 'ai-unavailable' || code === 'host-unavailable') return mruAiT(t, 'ai.errHost')
  if (code === 'network') return mruAiT(t, 'ai.errNetwork')
  if (typeof mruErrorText === 'function') {
    try {
      const text = mruErrorText(t, error)
      if (typeof text === 'string' && text !== '') return text
    } catch {
      /* fall through */
    }
  }
  if (error && typeof error.message === 'string' && error.message.trim() !== '') {
    return error.message
  }
  return mruAiT(t, 'ai.errGeneric')
}

/** Call an optional callback without letting a host bug break rendering. */
function mruAiSafeCall(callback, ...args) {
  if (typeof callback !== 'function') return undefined
  try {
    return callback(...args)
  } catch {
    return undefined
  }
}

/** Notify through the app toast helper when it exists. */
function mruAiNotify(api, text) {
  if (api && typeof api.onNotify === 'function' && typeof text === 'string' && text !== '') {
    mruAiSafeCall(api.onNotify, text)
  }
}

/** Lazily load KaTeX for citation-aware answers (MruRichText does this normally). */
function mruAiEnsureKatex() {
  try {
    if (typeof MRU_KATEX !== 'undefined' && MRU_KATEX
      && typeof MRU_KATEX.ensure === 'function') {
      MRU_KATEX.ensure()
    }
  } catch {
    /* KaTeX is optional; formulas fall back to raw text */
  }
}

/** Copy text without touching the DOM (clipboard API only). */
function mruAiCopyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard
    && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(String(text ?? ''))
  }
  return Promise.reject(new Error('clipboard-unavailable'))
}

/** Short single-line excerpt used by context chips and card titles. */
function mruAiExcerpt(value, limit) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
  const max = Number(limit) || 40
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

/** Build an index -> { citation, verified } map for one answer. */
function mruAiCitationLookup(citations, unverified) {
  const map = new Map()
  const verifiedList = Array.isArray(citations) ? citations : []
  const unverifiedList = Array.isArray(unverified) ? unverified : []
  for (let i = 0; i < verifiedList.length; i += 1) {
    const citation = verifiedList[i]
    if (citation && !map.has(citation.index)) {
      map.set(citation.index, { citation, verified: citation.verified !== false })
    }
  }
  for (let i = 0; i < unverifiedList.length; i += 1) {
    const citation = unverifiedList[i]
    if (citation && !map.has(citation.index)) map.set(citation.index, { citation, verified: false })
  }
  return map
}

/** Replace one message in a list without mutating it. */
function mruAiPatchMessage(messages, id, update) {
  if (!Array.isArray(messages)) return []
  let changed = false
  const next = messages.map((message) => {
    if (!message || message.id !== id) return message
    changed = true
    return update(message)
  })
  return changed ? next : messages
}

/** Find the user question preceding one assistant message (fallback for regenerate). */
function mruAiPreviousQuestion(messages, messageId) {
  if (!Array.isArray(messages)) return ''
  const index = messages.findIndex((message) => message && message.id === messageId)
  if (index < 0) return ''
  for (let i = index - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message) continue
    if (message.role === 'user' && typeof message.question === 'string' && message.question.trim() !== '') {
      return message.question
    }
    if (message.role === 'assistant' && typeof message.question === 'string' && message.question.trim() !== '') {
      return message.question
    }
  }
  return ''
}

/** A fresh local message (kept stable while the server id is still unknown). */
function mruAiLocalMessage(id, role, question) {
  return {
    id,
    role,
    question,
    answer: '',
    citations: [],
    unverified: [],
    followups: [],
    model: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    annotationIds: [],
    knowledge: { nodeIds: [], edgeIds: [] },
    phase: '',
    createdAt: new Date().toISOString(),
    local: true,
  }
}

/** Extract messages' current context chips, minus the ones the reader cleared. */
function mruAiContextChips(context, cleared, t) {
  const chips = []
  const source = context !== null && typeof context === 'object' ? context : {}
  const selection = source.selection
  if (!cleared.selection && selection !== null && typeof selection === 'object') {
    const quote = mruAiString(selection.quote).trim()
    if (quote !== '') {
      chips.push({
        kind: 'selection',
        blockKey: mruAiString(selection.blockKey),
        quote,
        label: mruAiT(t, 'ai.selection') + ' · ' + mruAiExcerpt(quote, 36),
      })
    }
  }
  if (!cleared.visible && mruAiString(source.visibleBlockKey) !== '') {
    const quote = mruAiString(source.visibleText).trim()
    chips.push({
      kind: 'visible',
      visible: true,
      blockKey: mruAiString(source.visibleBlockKey),
      quote,
      label: mruAiT(t, 'ai.visible') + ' · ' + mruAiExcerpt(quote || source.visibleBlockKey, 36),
    })
  }
  return chips
}

/** React nodes for literal/citation parts when the markdown model is unavailable. */
function mruAiRenderPlainParts(parts, options) {
  const nodes = []
  const list = Array.isArray(parts) ? parts : []
  for (let i = 0; i < list.length; i += 1) {
    const part = list[i]
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'citation') {
      nodes.push(mruAiCitationNode(part.index, options, `plain-cite-${i}`))
    } else {
      const text = mruAiDisplayText(part.text)
      if (text !== '') nodes.push(text)
    }
  }
  return nodes
}

/** One inline citation chip. */
function MruAiCitationChip(props) {
  const citation = props.citation || null
  const index = Number(props.index) || 0
  const verified = Boolean(props.verified) && citation !== null
  const flags = mruAiCitationFlags(citation, verified)
  const className = 'mru-ai__citation'
    + (verified ? '' : ' mru-ai__citation--unverified')
    + (citation === null ? ' mru-ai__citation--missing' : '')
    + (flags.partial ? ' mru-ai__citation--partial' : '')
  const entailment = citation !== null ? mruAiString(citation.entailment) : ''
  const quote = citation !== null && citation.quote !== '' ? mruAiDisplayText(citation.quote) : ''
  return h('button', {
    type: 'button',
    className,
    'data-index': index,
    'data-verified': verified ? 'true' : 'false',
    'data-entailment': entailment !== '' ? entailment : undefined,
    'aria-label': props.label || `[${index}]`,
    title: props.title !== undefined && props.title !== '' ? props.title : quote,
    onMouseEnter: (event) => {
      if (typeof props.onHover === 'function') {
        props.onHover(event, { index, citation, verified })
      }
    },
    onMouseLeave: () => {
      if (typeof props.onLeave === 'function') props.onLeave()
    },
    onFocus: (event) => {
      if (typeof props.onHover === 'function') {
        props.onHover(event, { index, citation, verified })
      }
    },
    onBlur: () => {
      if (typeof props.onLeave === 'function') props.onLeave()
    },
    onClick: (event) => {
      if (typeof props.onClick === 'function') {
        props.onClick(event, { index, citation, verified })
      }
    },
  }, `[${index}]`)
}

/** Build one chip node for a known citation (or a missing marker). */
function mruAiCitationChipFor(citation, index, verified, options, key) {
  const t = options.t
  const page = citation && citation.page !== null && citation.page > 0 ? citation.page : 0
  const isVerified = Boolean(verified) && citation !== null
  const flags = mruAiCitationFlags(citation, isVerified)
  let label
  if (citation === null) {
    label = mruAiT(t, 'ai.missingCitation', { index: mruAiFormatCount(index) })
  } else if (page > 0) {
    label = mruAiT(t, 'ai.citationLabelPage', {
      index: mruAiFormatCount(index),
      page: mruAiFormatCount(page),
    })
  } else {
    label = mruAiT(t, 'ai.citationLabel', { index: mruAiFormatCount(index) })
  }
  // Short entailment labels for accessible text + tooltips; the host styles the
  // visual marker through `.mru-ai__citation--partial` / `--unverified`.
  const marks = []
  if (flags.partial) marks.push(mruAiT(t, 'ai.entailmentPartialShort'))
  if (flags.unsupported) marks.push(mruAiT(t, 'ai.entailmentUnsupportedShort'))
  let title = citation === null ? label : ''
  if (marks.length > 0) {
    const suffix = marks.join(' · ')
    label += ' · ' + suffix
    const quote = citation !== null && citation.quote !== '' ? mruAiDisplayText(citation.quote) : ''
    title = quote !== '' ? `${suffix} · ${quote}` : suffix
  }
  return h(MruAiCitationChip, {
    key,
    index,
    citation,
    verified: isVerified,
    label,
    title,
    onHover: options.onCitationHover,
    onLeave: options.onCitationLeave,
    onClick: options.onCitationClick,
  })
}

/** Build one chip node for a citation index, using a keyed wrapper. */
function mruAiCitationNode(index, options, key) {
  const lookup = options.lookup instanceof Map ? options.lookup : new Map()
  const entry = lookup.get(index) || null
  return mruAiCitationChipFor(
    entry ? entry.citation : null,
    index,
    entry ? entry.verified : false,
    options,
    key,
  )
}

/** Render run text, splitting citation markers while preserving run styles. */
function mruAiRenderRunText(run, runIndex, text, options) {
  const nodes = []
  const parts = mruAiCitationMarkers(text)
  let segment = 0
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'citation') {
      nodes.push(mruAiCitationNode(part.index, options, `cite-${runIndex}-${i}`))
      continue
    }
    const literal = mruAiDisplayText(part.text)
    if (literal === '') continue
    const key = `run-${runIndex}-${segment}`
    let node = literal
    if (run.code === true) node = h('code', { key, className: 'mru-inline-code' }, node)
    if (run.del === true) node = h('del', { key }, node)
    if (run.em === true) node = h('em', { key }, node)
    if (run.strong === true) node = h('strong', { key }, node)
    if (typeof run.link === 'string' && run.link !== '') {
      node = h('a', {
        key,
        className: 'mru-link',
        href: run.link,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, node)
    }
    nodes.push(node)
    segment += 1
  }
  return nodes
}

/** Render inline runs (flat markdown runs) with citation chips. */
function mruAiRenderInline(runs, options) {
  const nodes = []
  const list = Array.isArray(runs) ? runs : []
  for (let i = 0; i < list.length; i += 1) {
    const run = list[i]
    if (run === null || typeof run !== 'object') continue
    if (run.type === 'math') {
      nodes.push(h(MruFormula, {
        key: `math-${i}`,
        latex: mruAiRunLatex(run),
        inline: true,
        katexReady: Boolean(options.katexReady),
      }))
      continue
    }
    const text = mruAiString(run.text)
    if (text === '') continue
    // A code run has lost its backticks in the markdown model; `[1]` inside it
    // is source code, never a citation chip.
    if (run.code === true) {
      nodes.push(h('code', { key: `code-${i}`, className: 'mru-inline-code' }, mruAiDisplayText(text)))
      continue
    }
    const rendered = mruAiRenderRunText(run, i, text, options)
    for (let j = 0; j < rendered.length; j += 1) nodes.push(rendered[j])
  }
  return nodes
}

/** LaTeX source of one math run, tolerating either markdown.js shape. */
function mruAiRunLatex(run) {
  if (run === null || run === undefined) return ''
  if (typeof run.latex === 'string') return run.latex
  const text = mruAiString(run.text)
  if (text.startsWith('$$') && text.endsWith('$$')) return text.slice(2, -2)
  if (text.startsWith('$') && text.endsWith('$')) return text.slice(1, -1)
  return text
}

/** Render one parsed markdown block of an answer. */
function mruAiRenderAnswerBlock(block, index, options) {
  if (block === null || typeof block !== 'object') return null
  const key = `block-${index}`
  if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote') {
    return h('p', { key, className: 'mru-rich__paragraph' },
      mruAiRenderInline(block.runs, options))
  }
  if (block.kind === 'list') {
    const items = Array.isArray(block.items) ? block.items : []
    const nodes = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      nodes.push(h('p', { key: `${key}-item-${i}`, className: 'mru-rich__item' },
        h('span', { className: 'mru-rich__bullet', 'aria-hidden': 'true' }, '·'),
        mruAiRenderInline(item && item.runs, options)))
    }
    return h('div', { key }, nodes)
  }
  if (block.kind === 'formula') {
    return h(MruFormula, {
      key,
      latex: block.latex !== undefined ? block.latex : (block.plainText || ''),
      display: true,
      katexReady: Boolean(options.katexReady),
    })
  }
  if (block.kind === 'code') {
    return h('pre', { key, className: 'mru-code' },
      h('code', null, mruAiString(block.code)))
  }
  if (block.kind === 'table') {
    const head = Array.isArray(block.head) ? block.head : []
    const rows = Array.isArray(block.rows) ? block.rows : []
    const all = (head.length > 0 ? [head] : []).concat(rows)
    const nodes = []
    for (let i = 0; i < all.length; i += 1) {
      const row = Array.isArray(all[i]) ? all[i] : []
      const children = []
      for (let c = 0; c < row.length; c += 1) {
        const cell = row[c]
        if (cell === null || typeof cell !== 'object') continue
        if (c > 0) children.push('  ')
        const runs = Array.isArray(cell.runs) ? cell.runs : null
        if (runs !== null) children.push(mruAiRenderInline(runs, options))
        else children.push(mruAiDisplayText(cell.plainText))
      }
      nodes.push(h('p', { key: `${key}-row-${i}`, className: 'mru-rich__paragraph' }, children))
    }
    return h('div', { key }, nodes)
  }
  if (block.kind === 'figure') {
    const caption = mruAiString(block.caption) || mruAiString(block.alt)
    if (caption === '') return null
    return h('p', { key, className: 'mru-rich__paragraph' }, mruAiDisplayText(caption))
  }
  return null
}

/**
 * Assistant answer renderer.
 *
 * Citation-free answers go through the app's `MruRichText` verbatim. Answers
 * containing `[n]` markers are parsed with the shared markdown engine
 * (parseMarkdown/parseInline) so chips can sit inside paragraphs, list items and
 * tables without breaking bold/links/formulas — the same model MruRichText
 * renders, with the same `.mru-rich*` classes.
 */
function MruAiAnswer(props) {
  const text = String(props && props.text !== undefined && props.text !== null ? props.text : '')
  const katexReady = Boolean(props && props.katexReady)
  const containsMath = text.indexOf('$') !== -1
  React.useEffect(() => {
    if (!katexReady && containsMath) mruAiEnsureKatex()
  }, [katexReady, containsMath])
  const parts = mruAiCitationMarkers(text)
  let hasCitation = false
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] && parts[i].type === 'citation') {
      hasCitation = true
      break
    }
  }
  if (!hasCitation) {
    return h(MruRichText, { text, katexReady })
  }
  const options = {
    t: props.t,
    katexReady,
    lookup: props.citationLookup,
    onCitationHover: props.onCitationHover,
    onCitationLeave: props.onCitationLeave,
    onCitationClick: props.onCitationClick,
  }
  let model = null
  if (typeof parseMarkdown === 'function') {
    try {
      model = parseMarkdown(text)
    } catch {
      model = null
    }
  }
  if (model === null || !Array.isArray(model.blocks) || model.blocks.length === 0) {
    return h('div', { className: 'mru-rich' }, mruAiRenderPlainParts(parts, options))
  }
  const nodes = []
  for (let i = 0; i < model.blocks.length; i += 1) {
    const node = mruAiRenderAnswerBlock(model.blocks[i], i, options)
    if (node !== null) nodes.push(node)
  }
  if (nodes.length === 0) {
    return h('div', { className: 'mru-rich' }, mruAiRenderPlainParts(parts, options))
  }
  return h('div', { className: 'mru-rich' }, nodes)
}

/** Verified / unverified citation footer for one message. */
function MruAiEvidenceFooter(props) {
  const citations = Array.isArray(props.citations) ? props.citations : []
  const unverified = Array.isArray(props.unverified) ? props.unverified : []
  if (citations.length === 0 && unverified.length === 0) return null
  const t = props.t
  const nodes = []
  nodes.push(h('span', {
    key: 'evidence-summary',
  }, mruAiT(t, 'ai.citationsCount', {
    count: mruAiFormatCount(citations.length + unverified.length),
  })))
  const handlers = {
    t,
    onCitationHover: props.onCitationHover,
    onCitationLeave: props.onCitationLeave,
    onCitationClick: props.onCitationClick,
  }
  for (let i = 0; i < citations.length; i += 1) {
    const citation = citations[i]
    nodes.push(mruAiCitationChipFor(
      citation,
      citation.index,
      citation.verified !== false,
      handlers,
      `footer-cite-${citation.index}-${i}`,
    ))
  }
  for (let i = 0; i < unverified.length; i += 1) {
    const citation = unverified[i]
    nodes.push(mruAiCitationChipFor(
      citation,
      citation.index,
      false,
      handlers,
      `footer-unverified-${citation.index}-${i}`,
    ))
  }
  const breakdown = mruAiUnverifiedBreakdown(unverified)
  const notices = []
  if (breakdown.unsupported > 0) {
    notices.push(h('div', {
      key: 'entailment',
      className: 'mru-ai__notice mru-ai__notice--entailment',
    },
      h('span', { className: 'mru-ai__spark', 'aria-hidden': 'true' }, '✦'),
      h('span', null, mruAiT(t, 'ai.entailmentNotice', {
        count: mruAiFormatCount(breakdown.unsupported),
      }))))
  }
  if (breakdown.generic > 0) {
    notices.push(h('div', { key: 'unverified', className: 'mru-ai__notice' },
      h('span', { className: 'mru-ai__spark', 'aria-hidden': 'true' }, '✦'),
      h('span', null, mruAiT(t, 'ai.unverifiedNotice', {
        count: mruAiFormatCount(breakdown.generic),
      }))))
  }
  return h(React.Fragment, null,
    h('div', { className: 'mru-ai__citations' }, nodes),
    notices.length > 0 ? notices : null)
}

/** One chat message row (user question or assistant answer). */
function MruAiMessage(props) {
  const { t, message, katexReady, busy, flash } = props
  if (message === null || typeof message !== 'object') return null
  const flashClass = flash ? ' mru-ai__msg--flash' : ''
  const question = mruAiDisplayText(message.question)
  if (message.role === 'user') {
    return h('article', {
      className: 'mru-ai__msg mru-ai__msg--user' + flashClass,
      'data-message-id': message.id,
    },
      h('div', { className: 'mru-ai__bubble' },
        h('div', { className: 'mru-ai__question' }, question)))
  }
  const answer = mruAiString(message.answer)
  const streaming = Boolean(message.streaming)
  const phase = mruAiString(message.phase)
  const checkingClaims = streaming && phase === 'entailment'
  const showThinking = streaming && answer.trim() === ''
  const annotationCount = Array.isArray(message.annotationIds) ? message.annotationIds.length : 0
  const followups = Array.isArray(message.followups) ? message.followups : []
  const lookup = mruAiCitationLookup(message.citations, message.unverified)
  const className = 'mru-ai__msg mru-ai__msg--assistant'
    + (streaming ? ' mru-ai__msg--streaming' : '')
    + flashClass
  const answerChildren = []
  if (answer !== '') {
    answerChildren.push(h(MruAiAnswer, {
      key: 'answer-body',
      text: answer,
      t,
      katexReady,
      citationLookup: lookup,
      onCitationHover: props.onCitationHover,
      onCitationLeave: props.onCitationLeave,
      onCitationClick: props.onCitationClick,
    }))
    if (streaming) {
      answerChildren.push(h('span', {
        key: 'caret',
        className: 'mru-ai__streaming',
        'aria-hidden': 'true',
      }, '▍'))
    }
  }
  const bubble = []
  if (showThinking) {
    bubble.push(h('div', { key: 'thinking', className: 'mru-ai__streaming' },
      h(MruSpinner),
      h('span', null, mruAiT(t, checkingClaims ? 'ai.checkingClaims' : 'ai.thinking'))))
  } else if (answerChildren.length > 0) {
    bubble.push(h('div', { key: 'answer', className: 'mru-ai__answer' }, answerChildren))
    // Entailment pass (docs/RESEARCH.md): the answer text is already streamed,
    // show that the host is now checking every citation against its claim.
    if (checkingClaims) {
      bubble.push(h('div', { key: 'claim-check', className: 'mru-ai__streaming' },
        h(MruSpinner),
        h('span', null, mruAiT(t, 'ai.checkingClaims'))))
    }
  }
  if (message.stopped) {
    bubble.push(h('div', { key: 'stopped', className: 'mru-ai__notice' },
      mruAiT(t, 'ai.stopped')))
  }
  if (!streaming && answer !== '') {
    bubble.push(h(MruAiEvidenceFooter, {
      key: 'evidence',
      t,
      citations: message.citations,
      unverified: message.unverified,
      onCitationHover: props.onCitationHover,
      onCitationLeave: props.onCitationLeave,
      onCitationClick: props.onCitationClick,
    }))
  }
  if (annotationCount > 0) {
    const noticeChildren = [
      h('span', { key: 'spark', className: 'mru-ai__spark', 'aria-hidden': 'true' }, '✦'),
      h('span', { key: 'text' }, mruAiT(t, 'ai.annotationsNotice', {
        count: mruAiFormatCount(annotationCount),
      })),
    ]
    if (typeof props.onOpenGraph === 'function') {
      noticeChildren.push(h('button', {
        key: 'graph',
        type: 'button',
        className: 'mru-ai__action mru-ai__action--compact',
        onClick: () => props.onOpenGraph(),
      }, mruAiT(t, 'ai.openGraph')))
    }
    bubble.push(h('div', { key: 'annotations', className: 'mru-ai__notice' }, noticeChildren))
  }
  if (!streaming) {
    const actions = []
    if (answer !== '') {
      actions.push(h('button', {
        key: 'copy',
        type: 'button',
        className: 'mru-ai__action',
        onClick: () => props.onCopy(message),
      }, h(MruGlyph, { name: 'copy', size: 13 }), h('span', null, mruAiT(t, 'ai.copy'))))
    }
    if (question !== '' && typeof props.onRegenerate === 'function') {
      actions.push(h('button', {
        key: 'regenerate',
        type: 'button',
        className: 'mru-ai__action',
        disabled: busy,
        onClick: () => props.onRegenerate(message),
      }, h(MruGlyph, { name: 'refresh', size: 13 }), h('span', null, mruAiT(t, 'ai.regenerate'))))
    }
    if (actions.length > 0) {
      bubble.push(h('div', { key: 'actions', className: 'mru-ai__actions' }, actions))
    }
  }
  if (!streaming && props.isLatestAssistant && followups.length > 0) {
    bubble.push(h('div', {
      key: 'followups',
      className: 'mru-ai__followups',
      'aria-label': mruAiT(t, 'ai.followups'),
    }, followups.slice(0, 3).map((followup, index) => h('button', {
      key: `followup-${index}`,
      type: 'button',
      className: 'mru-ai__followup',
      disabled: busy,
      onClick: () => props.onFollowup(followup),
    }, mruAiDisplayText(followup)))))
  }
  return h('article', {
    className,
    'data-message-id': message.serverId || message.id,
    'data-streaming': streaming ? 'true' : 'false',
  },
    h('div', { className: 'mru-ai__bubble' }, bubble))
}

/** Hover preview card for one citation (fixed overlay inside the tree). */
function MruAiCitationCard(props) {
  const card = props.card
  if (card === null || card.citation === null || typeof card.citation !== 'object') return null
  const citation = card.citation
  const index = card.index
  const verified = Boolean(card.verified)
  const flags = mruAiCitationFlags(citation, verified)
  const t = props.t
  const position = mruAiOverlayPosition(card.rect, 340, 190)
  const meta = []
  meta.push(h('span', {
    key: 'chip',
    className: 'mru-ai__citation'
      + (verified ? '' : ' mru-ai__citation--unverified')
      + (flags.partial ? ' mru-ai__citation--partial' : ''),
    'data-index': index,
  }, `[${index}]`))
  if (citation.page !== null && citation.page > 0) {
    meta.push(h('span', { key: 'page' }, ' · ' + mruAiT(t, 'ai.citationLabelPage', {
      index: mruAiFormatCount(index),
      page: mruAiFormatCount(citation.page),
    })))
  } else {
    meta.push(h('span', { key: 'label' }, ' · ' + mruAiT(t, 'ai.citationLabel', {
      index: mruAiFormatCount(index),
    })))
  }
  meta.push(h('span', { key: 'aspect' }, ' · ' + mruAiT(t, 'aspect.' + mruAiAspect(citation.aspect))))
  const entailmentReason = mruAiString(citation.entailmentReason)
  if (flags.partial) {
    meta.push(h('span', {
      key: 'claim',
      className: 'mru-ai__claim mru-ai__claim--partial',
      title: entailmentReason !== '' ? mruAiDisplayText(entailmentReason) : undefined,
    }, ' · ' + mruAiT(t, 'ai.claimCheck') + ': ' + mruAiT(t, 'ai.entailmentPartial')))
  }
  if (!verified) {
    if (flags.unsupported) {
      meta.push(h('span', {
        key: 'claim',
        className: 'mru-ai__claim mru-ai__claim--unsupported',
        title: entailmentReason !== '' ? mruAiDisplayText(entailmentReason) : undefined,
      }, ' · ' + mruAiT(t, 'ai.claimCheck') + ': ' + mruAiT(t, 'ai.entailmentUnsupported')))
    } else {
      meta.push(h('span', { key: 'unverified' }, ' · ' + mruAiT(t, 'ai.unverifiedShort')))
    }
  }
  const children = [
    h('div', { key: 'meta' }, meta),
    citation.quote !== ''
      ? h('blockquote', { key: 'quote' }, mruAiDisplayText(citation.quote))
      : null,
    citation.note !== ''
      ? h('p', { key: 'note' }, mruAiDisplayText(citation.note))
      : null,
    h('div', { key: 'actions', className: 'mru-ai__actions' },
      // An entailment-unsupported citation stays dimmed with no jump action
      // (PLAN C4): the quote is real but does not support the claim, so the
      // reader is not sent to the text as if it were evidence.
      citation.blockKey !== '' && !flags.unsupported
        ? h('button', {
            key: 'jump',
            type: 'button',
            className: 'mru-ai__action',
            onClick: () => props.onJump(citation.blockKey),
          }, mruAiT(t, 'ai.jump'))
        : null,
      h('button', {
        key: 'close',
        type: 'button',
        className: 'mru-ai__action mru-ai__action--compact',
        'aria-label': mruAiT(t, 'ai.dismiss'),
        title: mruAiT(t, 'ai.dismiss'),
        onClick: () => props.onClose(),
      }, h(MruGlyph, { name: 'close', size: 12 }))),
  ]
  return h('div', {
    className: 'mru-ai__citation-card',
    role: 'dialog',
    'aria-label': mruAiT(t, 'ai.citationLabel', { index: mruAiFormatCount(index) }),
    'data-index': index,
    'data-verified': verified ? 'true' : 'false',
    style: {
      position: 'fixed',
      left: `${position.left}px`,
      top: `${position.top}px`,
      zIndex: 40,
    },
    onMouseEnter: () => props.onKeep(),
    onMouseLeave: () => props.onLeave(),
    onFocus: () => props.onKeep(),
    onBlur: () => props.onLeave(),
    onKeyDown: (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
      }
    },
  }, children)
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Right-margin grounded AI chat for one document.
 * @param {object} props see the file header for the exact contract
 */
/* -------------------------------------------------------------------------- */
/* Question navigator helpers (docs/UI-POLISH-SPEC.md §3)                     */
/* -------------------------------------------------------------------------- */

/**
 * One navigator mark per user question of the conversation, in order.
 * @param {object[]} messages normalized chat messages
 * @returns {{id:string,messageId:string,ordinal:number,question:string}[]}
 */
export function mruAiQuestionMarks(messages) {
  const list = Array.isArray(messages) ? messages : []
  const marks = []
  for (const message of list) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    const id = mruAiString(message.id)
    if (id === '') continue
    marks.push({
      id,
      messageId: id,
      ordinal: marks.length + 1,
      question: mruAiDisplayText(message.question),
    })
  }
  return marks
}

/**
 * Index of the current navigator mark: the last question whose measured top is
 * at or above the anchor line. `offsets` entries are `{ messageId, top }` in
 * container-relative px. Returns -1 when nothing can be resolved.
 */
export function mruAiNavCurrentMark(marks, offsets, anchorY) {
  const list = Array.isArray(marks) ? marks : []
  if (list.length === 0) return -1
  const anchor = Number(anchorY)
  if (!Number.isFinite(anchor)) return -1
  const tops = new Map()
  for (const offset of Array.isArray(offsets) ? offsets : []) {
    if (offset === null || typeof offset !== 'object') continue
    const messageId = mruAiString(offset.messageId)
    const top = Number(offset.top)
    if (messageId !== '' && Number.isFinite(top)) tops.set(messageId, top)
  }
  let current = -1
  for (let index = 0; index < list.length; index += 1) {
    const top = tops.get(list[index].messageId)
    if (Number.isFinite(top) && top <= anchor) current = index
  }
  return current
}

/** Whether the conversation list is scrolled away from its newest message. */
export function mruAiNavAwayFromLatest(scrollTop, scrollHeight, clientHeight, threshold = 120) {
  const top = Number(scrollTop)
  const height = Number(scrollHeight)
  const view = Number(clientHeight)
  const gap = Number(threshold)
  if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(view)) return false
  const limit = Number.isFinite(gap) ? gap : 120
  return height - top - view > limit
}

/** Target scrollTop that brings `messageTop` to `padding` below the container top. */
export function mruAiNavTargetScrollTop(scrollTop, messageTop, containerTop, padding = 12) {
  const base = Number(scrollTop) || 0
  const message = Number(messageTop)
  const container = Number(containerTop)
  const pad = Number(padding)
  if (!Number.isFinite(message) || !Number.isFinite(container)) return Math.max(0, Math.round(base))
  return Math.max(0, Math.round(base + (message - container) - (Number.isFinite(pad) ? pad : 12)))
}

/** Aspect colour legend entries (reader `aspect.*` labels from the app dictionaries). */
const mruAiAspectLegendRows = [
  ['definition', 'aspect.definition'],
  ['context', 'aspect.context'],
  ['method', 'aspect.method'],
  ['result', 'aspect.result'],
  ['limitation', 'aspect.limitation'],
]

/**
 * Legend rows for the AI panel: dot + always-visible text label.
 * @param {((key: string, params?: object) => string) | null} t
 * @returns {{aspect:string,label:string}[]}
 */
export function mruAiAspectLegendItems(t) {
  return mruAiAspectLegendRows.map(([aspect, key]) => ({ aspect, label: mruAiT(t, key) }))
}

export function MruAiPanel(props) {
  const source = props !== null && typeof props === 'object' ? props : {}
  const t = typeof source.t === 'function' ? source.t : null
  const documentId = mruAiString(source.documentId)
  const documentTitle = mruAiString(source.documentTitle)
  const modelLabel = mruAiString(source.modelLabel)
  const available = source.available !== false
  const katexReady = Boolean(source.katexReady)
  const context = source.context !== null && typeof source.context === 'object'
    ? source.context
    : {}
  const propsRef = React.useRef(source)
  propsRef.current = source

  const [messages, setMessages] = React.useState([])
  const [historyState, setHistoryState] = React.useState('loading')
  const [historyError, setHistoryError] = React.useState('')
  const [historyNonce, setHistoryNonce] = React.useState(0)
  const [input, setInput] = React.useState('')
  const [streaming, setStreaming] = React.useState(null)
  const [streamError, setStreamError] = React.useState(null)
  const [card, setCard] = React.useState(null)
  const [clearedChips, setClearedChips] = React.useState({ selection: false, visible: false })
  const [navActiveId, setNavActiveId] = React.useState(null)
  const [navCurrentId, setNavCurrentId] = React.useState(null)
  const [flashMessageId, setFlashMessageId] = React.useState(null)
  const [awayFromLatest, setAwayFromLatest] = React.useState(false)

  const messagesRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const abortRef = React.useRef(null)
  const runRef = React.useRef(null)
  const seqRef = React.useRef(0)
  const stickRef = React.useRef(true)
  const hideTimerRef = React.useRef(null)
  const navFlashTimerRef = React.useRef(null)

  const tr = (key, params) => mruAiT(t, key, params)
  const busy = streaming !== null
  const questionMarks = mruAiQuestionMarks(messages)

  /* -- history ------------------------------------------------------------ */

  React.useEffect(() => {
    let cancelled = false
    const api = propsRef.current
    const previous = runRef.current
    if (previous) {
      previous.cancelled = true
      previous.finalized = true
      runRef.current = null
    }
    if (abortRef.current) {
      try {
        abortRef.current.abort()
      } catch {
        /* already closed */
      }
      abortRef.current = null
    }
    setStreaming(null)
    setStreamError(null)
    setCard(null)
    setMessages([])
    setHistoryError('')
    setHistoryState('loading')
    if (documentId === '') {
      setHistoryState('ready')
      return () => {
        cancelled = true
      }
    }
    if (typeof api.post !== 'function') {
      setHistoryError(mruAiT(propsRef.current.t, 'ai.errHost'))
      setHistoryState('error')
      return () => {
        cancelled = true
      }
    }
    const load = async () => {
      try {
        const raw = await api.post('chat.history', { documentId })
        if (cancelled) return
        setMessages(mruAiNormalizeMessages(raw))
        setHistoryState('ready')
        stickRef.current = true
      } catch (error) {
        if (cancelled) return
        setHistoryError(mruAiErrorText(propsRef.current.t, error))
        setHistoryState('error')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [documentId, historyNonce])

  React.useEffect(() => () => {
    const run = runRef.current
    if (run) {
      run.cancelled = true
      run.finalized = true
      runRef.current = null
    }
    if (abortRef.current) {
      try {
        abortRef.current.abort()
      } catch {
        /* ignore */
      }
      abortRef.current = null
    }
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    if (navFlashTimerRef.current !== null) {
      clearTimeout(navFlashTimerRef.current)
      navFlashTimerRef.current = null
    }
  }, [])

  /* -- reset cleared context when the reader moves ------------------------ */

  const selection = context.selection !== null && typeof context.selection === 'object'
    ? context.selection
    : null
  const selectionSignature = selection !== null
    ? `${mruAiString(selection.blockKey)}|${mruAiString(selection.quote)}`
    : ''
  const visibleKey = mruAiString(context.visibleBlockKey)
  React.useEffect(() => {
    setClearedChips((current) => (current.selection ? { ...current, selection: false } : current))
  }, [selectionSignature])
  React.useEffect(() => {
    setClearedChips((current) => (current.visible ? { ...current, visible: false } : current))
  }, [visibleKey])

  /* -- auto-scroll -------------------------------------------------------- */

  React.useEffect(() => {
    const element = messagesRef.current
    if (element === null || typeof element.scrollTop !== 'number') return
    if (stickRef.current) element.scrollTop = element.scrollHeight
  }, [messages, streaming, historyState])

  // Question navigator: seed the current mark after history/answers render.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const element = messagesRef.current
      if (element !== null) {
        setAwayFromLatest(mruAiNavAwayFromLatest(element.scrollTop, element.scrollHeight, element.clientHeight))
      }
      refreshNavPosition()
    }, 0)
    return () => clearTimeout(timer)
  }, [messages, historyState])

  /* -- citation card ------------------------------------------------------ */

  const cancelCardHide = () => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  const scheduleCardHide = () => {
    cancelCardHide()
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null
      setCard(null)
    }, 160)
  }

  const showCitationCard = (event, payload) => {
    cancelCardHide()
    let rect = null
    try {
      const target = event && event.currentTarget
      rect = target && typeof target.getBoundingClientRect === 'function'
        ? target.getBoundingClientRect()
        : null
    } catch {
      rect = null
    }
    setCard({
      index: payload && payload.index ? payload.index : 0,
      citation: payload && payload.citation ? payload.citation : null,
      verified: Boolean(payload && payload.verified),
      rect,
    })
  }

  const hideCitationCard = () => {
    setCard(null)
  }

  const jumpToBlock = (blockKey) => {
    setCard(null)
    if (typeof blockKey === 'string' && blockKey !== '') {
      mruAiSafeCall(propsRef.current.onJump, blockKey)
    }
  }

  const handleCitationClick = (event, payload) => {
    const citation = payload && payload.citation ? payload.citation : null
    if (citation === null) return
    // An entailment-unsupported citation has a real blockKey but must not be
    // presented as evidence: open the card (which explains the claim check and
    // hides the jump action) instead of scrolling the paper.
    if (mruAiCitationFlags(citation, Boolean(payload && payload.verified)).unsupported) {
      showCitationCard(event, payload)
      return
    }
    if (citation.blockKey !== '') {
      jumpToBlock(citation.blockKey)
      return
    }
    showCitationCard(event, payload)
  }

  const mruAiReducedMotion = () => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  }

  /** Measure question positions and refresh the navigator's current mark. */
  const refreshNavPosition = () => {
    const element = messagesRef.current
    if (element === null || typeof element !== 'object') return
    const marks = mruAiQuestionMarks(messages)
    if (marks.length < 2) return
    let containerRect = { top: 0 }
    try {
      containerRect = element.getBoundingClientRect ? element.getBoundingClientRect() : containerRect
    } catch {
      containerRect = { top: 0 }
    }
    const offsets = []
    const nodes = typeof element.querySelectorAll === 'function' ? element.querySelectorAll('[data-message-id]') : []
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      const messageId = mruAiString(node.getAttribute('data-message-id'))
      if (messageId === '') continue
      let top = 0
      try {
        const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null
        top = rect ? Number(rect.top) - Number(containerRect.top) : 0
      } catch {
        top = 0
      }
      offsets.push({ messageId, top })
    }
    const currentIndex = mruAiNavCurrentMark(marks, offsets, 72)
    const currentId = currentIndex >= 0 ? marks[currentIndex].id : null
    setNavCurrentId((previous) => (previous === currentId ? previous : currentId))
  }

  const scrollToLatest = () => {
    const element = messagesRef.current
    if (element === null) return
    stickRef.current = true
    const top = Number(element.scrollHeight) || 0
    try {
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top, behavior: mruAiReducedMotion() ? 'auto' : 'smooth' })
      } else {
        element.scrollTop = top
      }
    } catch {
      element.scrollTop = top
    }
    setAwayFromLatest(false)
  }

  /** Jump to one user question, flash it and sync the navigator. */
  const jumpToQuestion = (mark) => {
    const element = messagesRef.current
    if (element === null || !mark || mruAiString(mark.messageId) === '') return
    let target = null
    const nodes = typeof element.querySelectorAll === 'function' ? element.querySelectorAll('[data-message-id]') : []
    for (let index = 0; index < nodes.length; index += 1) {
      if (mruAiString(nodes[index].getAttribute('data-message-id')) === mruAiString(mark.messageId)) {
        target = nodes[index]
        break
      }
    }
    if (target === null) return
    let containerRect = { top: 0 }
    let targetRect = { top: 0 }
    try {
      containerRect = element.getBoundingClientRect ? element.getBoundingClientRect() : containerRect
      targetRect = target.getBoundingClientRect ? target.getBoundingClientRect() : targetRect
    } catch {
      /* fall back to offset math below */
    }
    const nextTop = mruAiNavTargetScrollTop(element.scrollTop, targetRect.top, containerRect.top, 12)
    stickRef.current = false
    try {
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top: nextTop, behavior: mruAiReducedMotion() ? 'auto' : 'smooth' })
      } else {
        element.scrollTop = nextTop
      }
    } catch {
      element.scrollTop = nextTop
    }
    setNavCurrentId(mruAiString(mark.id))
    setFlashMessageId(mruAiString(mark.messageId))
    if (navFlashTimerRef.current !== null) clearTimeout(navFlashTimerRef.current)
    navFlashTimerRef.current = setTimeout(() => {
      navFlashTimerRef.current = null
      setFlashMessageId(null)
    }, 1200)
  }

  const handleMessagesScroll = () => {
    const element = messagesRef.current
    if (element !== null) {
      stickRef.current = (element.scrollHeight - element.scrollTop - element.clientHeight) < 56
      setAwayFromLatest(mruAiNavAwayFromLatest(element.scrollTop, element.scrollHeight, element.clientHeight))
      if (questionMarks.length >= 2) refreshNavPosition()
    }
    if (card !== null) setCard(null)
  }

  /* -- context ------------------------------------------------------------ */

  const chips = mruAiContextChips(context, clearedChips, t)

  const currentFocus = () => {
    if (!clearedChips.selection && selection !== null) {
      const quote = mruAiString(selection.quote).trim()
      if (quote !== '') {
        return {
          blockKey: mruAiString(selection.blockKey),
          selectionQuote: quote,
        }
      }
    }
    if (!clearedChips.visible && visibleKey !== '') {
      return { blockKey: visibleKey, selectionQuote: '' }
    }
    return null
  }

  /* -- streaming ---------------------------------------------------------- */

  const handleStreamFrame = (run, frame, api) => {
    if (run.finalized || runRef.current !== run) return
    if (frame === null || typeof frame !== 'object') return
    const type = mruAiString(frame.type)
    if (type === 'start') {
      const serverId = mruAiString(frame.messageId)
      const model = mruAiNormalizeModel(frame.model)
      if (serverId !== '' || model !== null) {
        setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
          ...message,
          serverId: serverId !== '' ? serverId : message.serverId,
          model: model !== null ? model : message.model,
        })))
      }
      return
    }
    if (type === 'delta') {
      if (run.answered) return
      const text = mruAiString(frame.text)
      if (text === '') return
      run.draft += text
      const parsed = mruAiParseAnswer(run.draft)
      const shown = parsed.answer
      setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
        ...message,
        answer: shown,
        streaming: true,
      })))
      return
    }
    if (type === 'phase') {
      // New frame from the entailment pass (PLAN C4): the answer text has been
      // streamed and the host is now checking citations against their claims.
      // Unknown phase values are ignored so older hosts/frames stay harmless.
      if (mruAiString(frame.phase) === 'entailment') {
        setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
          ...message,
          phase: 'entailment',
        })))
      }
      return
    }
    if (type === 'answer') {
      const markdown = mruAiString(frame.markdown)
      const parsed = mruAiParseAnswer(markdown !== '' ? markdown : run.draft)
      const fenced = parsed.data
      const answer = parsed.answer !== '' ? parsed.answer : (markdown !== '' ? markdown : run.draft)
      const citations = mruAiNormalizeCitationList(
        Array.isArray(frame.citations) ? frame.citations : (fenced && fenced.citations),
        false,
      )
      const unverified = mruAiNormalizeCitationList(
        Array.isArray(frame.unverified) ? frame.unverified : [],
        true,
      )
      const followups = mruAiStringList(
        Array.isArray(frame.followups) ? frame.followups : (fenced && fenced.followups),
      )
      const annotationIds = mruAiStringList(frame.annotationIds)
      const serverId = mruAiString(frame.messageId)
      const model = mruAiNormalizeModel(frame.model)
      run.answered = true
      setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
        ...message,
        answer,
        citations,
        unverified,
        followups,
        annotationIds: annotationIds.length > 0 ? annotationIds : message.annotationIds,
        serverId: serverId !== '' ? serverId : message.serverId,
        model: model !== null ? model : message.model,
        phase: '',
        streaming: true,
      })))
      if (annotationIds.length > 0 && !run.announced) {
        run.announced = true
        mruAiSafeCall(api.onAnnotationsChanged)
        mruAiNotify(api, mruAiT(api.t, 'ai.annotationsNotice', {
          count: mruAiFormatCount(annotationIds.length),
        }))
      }
      return
    }
    if (type === 'graph') {
      if (frame.delta !== null && typeof frame.delta === 'object') {
        mruAiSafeCall(api.onGraphDelta, frame.delta)
      }
      return
    }
    if (type === 'done') {
      run.done = true
      finishRun(run, null)
      return
    }
    if (type === 'error') {
      run.failedError = {
        code: mruAiString(frame.code) || 'llm-failed',
        message: mruAiString(frame.message),
      }
      const controller = run.controller
      if (controller) {
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
      }
      finishRun(run, run.failedError)
    }
    // 'usage' and unknown frames carry nothing the panel renders.
  }

  const finishRun = (run, error) => {
    if (run === null || typeof run !== 'object' || run.finalized) return
    run.finalized = true
    const current = runRef.current === run
    if (current) runRef.current = null
    if (abortRef.current === run.controller) abortRef.current = null
    if (run.cancelled) return
    if (current) setStreaming(null)
    const failure = run.failedError || error
    if (failure) {
      const hasPartial = run.draft.trim() !== ''
      if (hasPartial) {
        setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
          ...message,
          streaming: false,
          error: true,
        })))
      } else {
        setMessages((previous) => previous.filter((message) => message.id !== run.id))
      }
      setStreamError({
        message: mruAiErrorText(propsRef.current.t, failure),
        question: run.question,
        dropFromId: hasPartial ? run.id : '',
        regenerateOf: run.regenerateOf,
        focus: run.focus,
        retryable: true,
      })
      return
    }
    if (!run.answered) {
      if (run.draft.trim() !== '') {
        const parsed = mruAiParseAnswer(run.draft)
        const fenced = parsed.data
        const citations = mruAiNormalizeCitationList(fenced && fenced.citations, false)
        const followups = mruAiStringList(fenced && fenced.followups)
        setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
          ...message,
          answer: parsed.answer !== '' ? parsed.answer : run.draft,
          citations,
          followups,
          streaming: false,
        })))
      } else {
        setMessages((previous) => previous.filter((message) => message.id !== run.id))
        setStreamError({
          message: mruAiT(propsRef.current.t, 'ai.answerEmpty'),
          question: run.question,
          dropFromId: '',
          regenerateOf: run.regenerateOf,
          focus: run.focus,
          retryable: true,
        })
      }
      return
    }
    setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
      ...message,
      streaming: false,
    })))
  }

  const runChat = (rawQuestion, options) => {
    const api = propsRef.current
    const opts = options !== null && typeof options === 'object' ? options : {}
    const question = mruAiString(rawQuestion).trim()
    if (question === '' || runRef.current !== null) return
    if (documentId === '') {
      setStreamError({ message: mruAiT(api.t, 'ai.noDocument'), retryable: false })
      return
    }
    const sequence = seqRef.current + 1
    seqRef.current = sequence
    const assistantId = `local-assistant-${sequence}`
    const userMessage = opts.appendUser === false
      ? null
      : mruAiLocalMessage(`local-user-${sequence}`, 'user', question)
    const assistantMessage = {
      ...mruAiLocalMessage(assistantId, 'assistant', question),
      streaming: true,
    }
    const focus = opts.focus !== undefined ? opts.focus : currentFocus()
    const regenerateOf = mruAiString(opts.regenerateOf)
    const run = {
      id: assistantId,
      question,
      draft: '',
      answered: false,
      stopped: false,
      cancelled: false,
      finalized: false,
      announced: false,
      failedError: null,
      focus,
      regenerateOf,
      controller: null,
    }
    runRef.current = run
    setMessages((previous) => {
      let next = Array.isArray(previous) ? previous.slice() : []
      if (mruAiString(opts.dropFromId) !== '') {
        const index = next.findIndex((message) => message && message.id === opts.dropFromId)
        if (index !== -1) next = next.slice(0, index)
      }
      if (userMessage !== null) next.push(userMessage)
      next.push(assistantMessage)
      return next
    })
    setStreamError(null)
    setCard(null)
    setStreaming({ id: assistantId, question })
    stickRef.current = true
    let controller = null
    try {
      if (typeof AbortController === 'function') controller = new AbortController()
    } catch {
      controller = null
    }
    run.controller = controller
    abortRef.current = controller
    const request = { documentId, question, mode: 'doc' }
    if (focus !== null && typeof focus === 'object'
      && (mruAiString(focus.blockKey) !== '' || mruAiString(focus.selectionQuote) !== '')) {
      request.focus = focus
    }
    if (regenerateOf !== '') request.regenerateOf = regenerateOf
    const onFrame = (frame) => {
      try {
        handleStreamFrame(run, frame, api)
      } catch {
        /* one malformed frame must not tear down the panel */
      }
    }
    if (typeof api.streamChat !== 'function') {
      finishRun(run, { code: 'ai-unavailable', message: mruAiT(api.t, 'ai.errHost') })
      return
    }
    let pending
    try {
      pending = api.streamChat(request, {
        onFrame,
        signal: controller !== null ? controller.signal : undefined,
      })
    } catch (error) {
      finishRun(run, error)
      return
    }
    Promise.resolve(pending).then(
      () => finishRun(run, null),
      (error) => finishRun(run, error || null),
    )
  }

  const stopStreaming = () => {
    const run = runRef.current
    if (run === null) return
    run.cancelled = true
    run.finalized = true
    run.stopped = true
    runRef.current = null
    const controller = run.controller || abortRef.current
    if (abortRef.current === controller) abortRef.current = null
    if (controller) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    setStreaming(null)
    setMessages((previous) => mruAiPatchMessage(previous, run.id, (message) => ({
      ...message,
      streaming: false,
      stopped: true,
    })))
  }

  /* -- message actions ---------------------------------------------------- */

  const submitComposer = () => {
    if (runRef.current !== null || historyState === 'loading') return
    if (!available || documentId === '' || typeof propsRef.current.streamChat !== 'function') return
    const question = input.trim()
    if (question === '') return
    setInput('')
    runChat(question, { appendUser: true })
  }

  const askPrompt = (prompt) => {
    if (runRef.current !== null || historyState === 'loading') return
    if (!available || documentId === '' || typeof propsRef.current.streamChat !== 'function') return
    setInput('')
    runChat(prompt, { appendUser: true })
  }

  const handleInputKeyDown = (event) => {
    if (event.isComposing === true || event.keyCode === 229) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submitComposer()
    }
  }

  const copyMessage = (message) => {
    const api = propsRef.current
    const answer = message && mruAiString(message.answer)
    if (answer === '') return
    mruAiCopyText(answer).then(
      () => mruAiNotify(api, mruAiT(api.t, 'ai.copied')),
      () => mruAiNotify(api, mruAiT(api.t, 'ai.copyFailed')),
    )
  }

  /**
   * Export the whole conversation as Markdown (PLAN C5).
   *
   * Toast ownership is ours on both paths: `props.onExportConversation` returns
   * `false` only when the browser download could not be triggered (the app never
   * notifies); any other return value means the file was saved. Without a host
   * exporter the Markdown is copied through the clipboard helper instead.
   */
  const exportConversation = () => {
    const api = propsRef.current
    if (!Array.isArray(messages) || messages.length === 0) return
    const notifyExported = () => mruAiNotify(api, mruAiT(api.t, 'ai.exported'))
    const notifyFailed = () => mruAiNotify(api, mruAiT(api.t, 'ai.exportFailed'))
    let result = null
    try {
      result = mruAiExportMarkdown(messages, {
        title: mruAiString(api.documentTitle) || documentTitle,
        modelLabel: mruAiString(api.modelLabel) || modelLabel,
        exportedAt: new Date().toISOString(),
        t: api.t,
      })
    } catch {
      result = null
    }
    if (result === null) {
      notifyFailed()
      return
    }
    if (typeof api.onExportConversation === 'function') {
      let outcome
      try {
        outcome = api.onExportConversation(result.markdown, result.filename)
      } catch {
        notifyFailed()
        return
      }
      if (outcome === false) notifyFailed()
      else notifyExported()
      return
    }
    mruAiCopyText(result.markdown).then(notifyExported, notifyFailed)
  }

  const regenerateMessage = (message) => {
    if (message === null || typeof message !== 'object' || message.role !== 'assistant') return
    if (runRef.current !== null) return
    const question = mruAiString(message.question).trim() !== ''
      ? message.question
      : mruAiPreviousQuestion(messages, message.id)
    if (mruAiString(question).trim() === '') return
    const candidate = mruAiString(message.serverId)
      || (message.local === true ? '' : mruAiString(message.id))
    setStreamError(null)
    runChat(question, {
      appendUser: false,
      dropFromId: message.id,
      regenerateOf: candidate,
      focus: currentFocus(),
    })
  }

  const retryStream = () => {
    if (streamError === null || runRef.current !== null) return
    const retryQuestion = streamError.question
    const retryFocus = streamError.focus
    setStreamError(null)
    runChat(retryQuestion, {
      appendUser: false,
      dropFromId: streamError.dropFromId,
      regenerateOf: streamError.regenerateOf,
      focus: retryFocus,
    })
  }

  const retryHistory = () => {
    if (historyState === 'loading') return
    setHistoryNonce((value) => value + 1)
  }

  const dismissStreamError = () => setStreamError(null)

  const handlePanelKeyDown = (event) => {
    if (event === null || typeof event !== 'object' || event.key !== 'Escape') return
    if (event.isComposing === true) return
    if (card !== null) {
      event.stopPropagation()
      setCard(null)
      return
    }
    if (runRef.current !== null) {
      event.stopPropagation()
      stopStreaming()
      return
    }
    if (streamError !== null) {
      event.stopPropagation()
      setStreamError(null)
    }
  }

  /* -- render ------------------------------------------------------------- */

  const hasDocument = documentId !== ''
  const canChat = hasDocument && available && typeof source.streamChat === 'function'
  const modelText = !available
    ? tr('ai.modelUnavailable')
    : (modelLabel !== '' ? modelLabel : tr('ai.modelDefault'))
  let lastAssistantId = ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'assistant') {
      lastAssistantId = messages[i].id
      break
    }
  }
  const canSend = canChat && historyState !== 'loading' && input.trim() !== '' && !busy

  const messageNodes = []
  if (historyState === 'loading') {
    messageNodes.push(h('div', { key: 'history-loading', className: 'mru-ai__empty' },
      h('div', { className: 'mru-ai__empty-title' },
        h(MruSpinner),
        h('span', null, tr('ai.loadingHistory')))))
  } else if (historyState === 'error') {
    messageNodes.push(h('div', { key: 'history-error', className: 'mru-ai__error', role: 'alert' },
      h('p', null, historyError !== '' ? historyError : tr('ai.historyError')),
      h('div', { className: 'mru-ai__actions' },
        h('button', {
          type: 'button',
          className: 'mru-ai__action',
          onClick: retryHistory,
        }, tr('ai.retry')))))
  } else if (messages.length === 0 && !busy) {
    const emptyTitle = !hasDocument
      ? tr('ai.noDocument')
      : (!available ? tr('ai.unavailableTitle') : tr('ai.emptyTitle'))
    const emptyText = !hasDocument
      ? ''
      : (!available ? tr('ai.unavailableText') : tr('ai.emptyText'))
    messageNodes.push(h('div', { key: 'empty', className: 'mru-ai__empty' },
      h('div', { className: 'mru-ai__empty-title' },
        h('span', { className: 'mru-ai__spark', 'aria-hidden': 'true' }, '✦'),
        h('span', null, emptyTitle)),
      emptyText !== '' ? h('div', { className: 'mru-ai__empty-text' }, emptyText) : null,
      canChat
        ? h('div', { className: 'mru-ai__prompts' },
            mruAiQuickPrompts.map((key) => h('button', {
              key,
              type: 'button',
              className: 'mru-ai__prompt',
              onClick: () => askPrompt(tr(key)),
            }, tr(key))))
        : null))
  } else {
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i]
      messageNodes.push(h(MruAiMessage, {
        key: `${message && message.id ? message.id : 'message'}-${i}`,
        t,
        message,
        katexReady,
        busy,
        flash: flashMessageId !== null && mruAiString(message && message.id) === mruAiString(flashMessageId),
        isLatestAssistant: Boolean(message) && message.id === lastAssistantId,
        onCitationHover: showCitationCard,
        onCitationLeave: scheduleCardHide,
        onCitationClick: handleCitationClick,
        onCopy: copyMessage,
        onRegenerate: regenerateMessage,
        onFollowup: askPrompt,
        onOpenGraph: source.onOpenGraph,
      }))
    }
  }

  const errorNode = streamError !== null
    ? h('div', { className: 'mru-ai__error', role: 'alert' },
        h('span', null, streamError.message),
        h('div', { className: 'mru-ai__actions' },
          streamError.retryable
            ? h('button', {
                type: 'button',
                className: 'mru-ai__action',
                onClick: retryStream,
              }, tr('ai.retry'))
            : null,
          h('button', {
            type: 'button',
            className: 'mru-ai__action mru-ai__action--compact',
            onClick: dismissStreamError,
            'aria-label': tr('ai.dismiss'),
            title: tr('ai.dismiss'),
          }, h(MruGlyph, { name: 'close', size: 12 }))))
    : null

  const contextNode = chips.length > 0
    ? h('div', { className: 'mru-ai__context' }, chips.map((chip) => h('div', {
        key: chip.kind,
        className: `mru-ai__chip mru-ai__chip--${chip.kind}`,
        'data-kind': chip.kind,
      },
        h('button', {
          type: 'button',
          className: 'mru-ai__chip-label',
          title: chip.quote !== '' ? chip.quote : chip.blockKey,
          onClick: () => jumpToBlock(chip.blockKey),
        }, chip.label),
        h('button', {
          type: 'button',
          className: 'mru-ai__action mru-ai__action--compact',
          'aria-label': tr('ai.clearContext'),
          title: tr('ai.clearContext'),
          onClick: () => setClearedChips((current) => ({ ...current, [chip.kind]: true })),
        }, h(MruGlyph, { name: 'close', size: 12 })))))
    : null

  let setupNotice = ''
  if (hasDocument && !available && messages.length > 0) {
    setupNotice = tr('ai.unavailableText')
  } else if (hasDocument && available && typeof source.streamChat !== 'function') {
    setupNotice = tr('ai.errHost')
  }
  const setupNode = setupNotice !== ''
    ? h('div', { className: 'mru-ai__notice' },
        h('span', { className: 'mru-ai__spark', 'aria-hidden': 'true' }, '✦'),
        h('span', null, setupNotice))
    : null

  const legendNode = historyState === 'ready' && messages.length > 0
    ? h('div', { className: 'mru-ai__legend', 'aria-label': tr('ai.legendTitle') },
        h('div', { className: 'mru-ai__legend-head' },
          h('span', { className: 'mru-ai__legend-title' }, tr('ai.legendTitle'))),
        h('div', { className: 'mru-aspect-legend' },
          mruAiAspectLegendItems(t).map((item) => h('span', {
            key: item.aspect,
            className: 'mru-aspect-legend__item',
            title: item.label,
          },
            h('span', {
              className: 'mru-aspect-legend__dot mru-aspect-legend__dot--' + item.aspect,
              'aria-hidden': 'true',
            }),
            h('span', { className: 'mru-aspect-legend__label' }, item.label)))))
    : null

  const previewMark = navActiveId === null
    ? null
    : questionMarks.find((mark) => mark.id === navActiveId) || null

  const navNode = questionMarks.length >= 2
    ? h('div', {
        className: 'mru-ai__nav',
        role: 'navigation',
        'aria-label': tr('ai.navLabel'),
        'data-count': String(questionMarks.length),
      },
        questionMarks.map((mark) => h('button', {
          key: mark.id,
          type: 'button',
          className: 'mru-ai__nav-mark'
            + (navCurrentId !== null && navCurrentId === mark.id ? ' is-current' : '')
            + (navActiveId !== null && navActiveId === mark.id ? ' is-active' : ''),
          'aria-label': tr('ai.navJump', { index: mark.ordinal }),
          'aria-current': navCurrentId !== null && navCurrentId === mark.id ? 'true' : undefined,
          onMouseEnter: () => setNavActiveId(mark.id),
          onMouseLeave: () => setNavActiveId((current) => (current === mark.id ? null : current)),
          onFocus: () => setNavActiveId(mark.id),
          onBlur: () => setNavActiveId((current) => (current === mark.id ? null : current)),
          onClick: () => jumpToQuestion(mark),
        })),
        previewMark !== null
          ? h('div', { className: 'mru-ai__nav-preview', role: 'tooltip' },
              h('span', { className: 'mru-ai__nav-preview-index' },
                tr('ai.navQuestion', { index: previewMark.ordinal })),
              h('span', { className: 'mru-ai__nav-preview-text' },
                previewMark.question !== '' ? previewMark.question : tr('ai.navQuestion', { index: previewMark.ordinal })))
          : null)
    : null

  const toLatestNode = awayFromLatest && messages.length > 0
    ? h('button', {
        type: 'button',
        className: 'mru-ai__toLatest',
        onClick: scrollToLatest,
      },
        h(MruGlyph, { name: 'chevronDown', size: 13 }),
        h('span', null, tr('ai.toLatest')))
    : null

  const composerNode = (hasDocument && available) || busy
    ? h('div', {
        className: 'mru-ai__composer',
        'data-busy': busy ? 'true' : 'false',
      },
        h('textarea', {
          ref: inputRef,
          className: 'mru-ai__input',
          value: input,
          rows: 3,
          placeholder: tr('ai.placeholder'),
          'aria-label': tr('ai.placeholder'),
          disabled: !hasDocument || historyState === 'loading',
          spellCheck: false,
          onChange: (event) => setInput(event.target.value),
          onKeyDown: handleInputKeyDown,
        }),
        h('div', { className: 'mru-ai__actions' },
          h('span', { className: 'mru-ai__hint' }, busy ? tr('ai.busyHint') : tr('ai.hint')),
          busy
            ? h('button', {
                type: 'button',
                className: 'mru-ai__stop',
                onClick: stopStreaming,
                'aria-label': tr('ai.stop'),
              }, tr('ai.stop'))
            : h('button', {
                type: 'button',
                className: 'mru-ai__send',
                onClick: submitComposer,
                disabled: !canSend,
              }, tr('ai.send'))))
    : null

  const cardNode = card !== null
    ? h(MruAiCitationCard, {
        card,
        t,
        onKeep: cancelCardHide,
        onLeave: scheduleCardHide,
        onClose: hideCitationCard,
        onJump: jumpToBlock,
      })
    : null

  const stateName = !hasDocument
    ? 'no-document'
    : (!available ? 'unavailable' : historyState === 'loading'
      ? 'loading'
      : (historyState === 'error' ? 'error' : (busy ? 'streaming' : (messages.length > 0 ? 'ready' : 'empty'))))

  return h('section', {
    className: 'mru-ai',
    'data-available': available ? 'true' : 'false',
    'data-busy': busy ? 'true' : 'false',
    'data-state': stateName,
    'aria-label': documentTitle !== '' ? `${tr('ai.title')} · ${documentTitle}` : tr('ai.title'),
    onKeyDown: handlePanelKeyDown,
  },
    h('header', { className: 'mru-ai__head' },
      h('div', {
        className: 'mru-ai__title',
        title: documentTitle !== '' ? documentTitle : undefined,
      },
        h('span', { className: 'mru-ai__spark', 'aria-hidden': 'true' }, '✦'),
        h('span', null, tr('ai.title'))),
      h('span', {
        className: 'mru-ai__model',
        title: modelText,
        'data-available': available ? 'true' : 'false',
      }, modelText),
      h('div', { className: 'mru-ai__actions' },
        h('button', {
          key: 'export',
          type: 'button',
          className: 'mru-ai__action',
          title: tr('ai.export'),
          'aria-label': tr('ai.export'),
          disabled: messages.length === 0,
          onClick: exportConversation,
        }, h(MruGlyph, { name: 'export', size: 13 }), h('span', null, tr('ai.export'))),
        typeof source.onOpenGraph === 'function'
          ? h('button', {
              key: 'graph',
              type: 'button',
              className: 'mru-ai__action',
              title: tr('ai.openGraph'),
              'aria-label': tr('ai.openGraph'),
              onClick: () => mruAiSafeCall(source.onOpenGraph),
            }, h(MruGlyph, { name: 'link', size: 13 }), h('span', null, tr('ai.openGraph')))
          : null)),
    h('div', {
      className: 'mru-ai__messages',
      ref: messagesRef,
      role: 'log',
      'aria-live': busy ? 'off' : 'polite',
      'aria-relevant': 'additions text',
      onScroll: handleMessagesScroll,
    }, messageNodes),
    navNode,
    toLatestNode,
    errorNode,
    contextNode,
    setupNode,
    legendNode,
    composerNode,
    cardNode)
}
