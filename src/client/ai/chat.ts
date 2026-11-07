/**
 * Pure helpers for the AI margin: answer/fence splitting, inline citation
 * marker scanning, history normalization, citation entailment flags, margin
 * turn building and the conversation Markdown export.
 *
 * This module is the TypeScript port of the frozen 1.0.0 `ui/chat.js` helper
 * contract (`.agents/baseline-1.0.0/ui/chat.js`, pinned by
 * `test/client/chat-helpers.test.mjs` + `chat-nav.test.mjs` there): the
 * robustness rules for model output are product behaviour, not presentation, so
 * they are kept byte-compatible. Rendering lives in `AiMarginEntries.tsx` /
 * `markdown.tsx`; this file has no React and no DOM access.
 */

import { ASPECTS, type Aspect } from '../../shared/constants.ts'
import type { EntailmentSummary } from '../../shared/model.ts'

/** Translate function the helpers localize through (key + `{param}` templates). */
export type AiTranslate = (key: string, params?: Record<string, unknown>) => string

/* -------------------------------------------------------------------------- */
/* Locale helper                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Translate through the app dictionaries with `{param}` interpolation and
 * key-as-fallback. All margin copy is looked up through this one wrapper so a
 * missing key never renders empty.
 *
 * @param t - translate callback (may be null in pure-unit paths).
 * @param key - dictionary key (for example `ai.citationLabel`).
 * @param params - template parameters.
 * @returns the localized string (never empty).
 */
export function aiT(
  t: AiTranslate | null | undefined,
  key: string,
  params?: Record<string, unknown>,
): string {
  let value = ''
  if (typeof t === 'function') {
    try {
      value = t(key, params)
    } catch {
      value = ''
    }
  }
  if (typeof value !== 'string' || value === '') value = key
  if (params === undefined) return value
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/* -------------------------------------------------------------------------- */
/* Text / display helpers                                                     */
/* -------------------------------------------------------------------------- */

/** Safe display text: never throws, replaces replacement characters. */
export function displayText(value: unknown): string {
  return String(value === undefined || value === null ? '' : value).replace(/\ufffd/g, '□')
}

/** Locale-aware count formatting with a deterministic fallback. */
export function formatCount(value: unknown): string {
  const number = Number(value) || 0
  try {
    return new Intl.NumberFormat().format(number)
  } catch {
    return String(number)
  }
}

/** Short single-line excerpt used by context chips and citation titles. */
export function excerpt(value: unknown, limit = 40): string {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
  const max = Number(limit) || 40
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/* -------------------------------------------------------------------------- */
/* Citation / message types                                                   */
/* -------------------------------------------------------------------------- */

/** Entailment verdict a citation can carry (`''` when the pass did not run). */
export type EntailmentVerdict = 'supported' | 'partial' | 'unsupported' | 'unchecked' | ''

/** One citation normalized for the margin (tolerant of the frozen wire shape). */
export interface AiCitation {
  index: number
  blockKey: string
  quote: string
  /** Offsets into the block plain text; `null` on unverified/unanchored entries. */
  start: number | null
  end: number | null
  page: number | null
  aspect: Aspect
  note: string
  verified: boolean
  entailment: EntailmentVerdict
  entailmentReason: string
  /** Why an unverified citation failed (`quote-not-found`, `entailment-unsupported`, …). */
  reason: string
}

/** One normalized conversation message (question or answer) rendered in the margin. */
export interface ChatEntry {
  id: string
  /** Host id once the `start` frame arrives; empty for local drafts. */
  serverId: string
  role: 'user' | 'assistant'
  question: string
  answer: string
  citations: AiCitation[]
  unverified: AiCitation[]
  followups: string[]
  model: { provider: string; model: string } | null
  usage: { inputTokens: number; outputTokens: number }
  annotationIds: string[]
  knowledge: { nodeIds: string[]; edgeIds: string[] }
  /** Citation–claim summary when the host sent one. */
  entailment: EntailmentSummary | null
  createdAt: string
  /* Transient render state (never persisted). */
  streaming: boolean
  phase: '' | 'entailment'
  stopped: boolean
  failed: boolean
  /** Local-only entry (not yet acknowledged/persisted by the host). */
  local: boolean
}

/** One question/answer pair as the margin renders it. */
export interface ChatTurn {
  /** Stable render key (assistant id when present, otherwise the question id). */
  id: string
  questionId: string | null
  question: string
  assistant: ChatEntry | null
  createdAt: string
  /** First citation block key the turn is anchored to (`null` sorts last). */
  anchorBlockKey: string | null
}

/** One literal or citation-marker part of an answer line. */
export type CitationMarkerPart =
  | { type: 'text'; text: string; start: number; end: number }
  | { type: 'citation'; index: number; text: string; start: number; end: number }

/* -------------------------------------------------------------------------- */
/* Answer / structured-fence splitting (frozen AI-SPEC §5)                    */
/* -------------------------------------------------------------------------- */

/** Trim only trailing whitespace so leading markdown indentation survives. */
function trimEnd(value: string): string {
  return value.replace(/\s+$/, '')
}

/** One recognized opening fence. */
interface Fence {
  char: string
  length: number
  info: string
}

/** Recognize an opening code fence; null for ordinary lines. */
function fenceOpen(line: unknown): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/.exec(String(line))
  if (match === null) return null
  const marker = match[1] ?? ''
  return { char: marker.charAt(0), length: marker.length, info: (match[2] ?? '').toLowerCase() }
}

/** Whether `line` closes `fence` (same character, at least as long). */
function fenceClose(line: unknown, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(String(line))
  if (match === null) return false
  const marker = match[1] ?? ''
  return marker.charAt(0) === fence.char && marker.length >= fence.length
}

/** Parse a JSON object, recovering one surrounded by prose or trailing commas. */
function tryJson(body: string): Record<string, unknown> | null {
  const text = body.trim()
  if (text === '') return null
  const candidates = [text]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    const parsed = parseObject(candidate)
    if (parsed !== null) return parsed
    const relaxed = parseObject(candidate.replace(/,\s*([}\]])/g, '$1'))
    if (relaxed !== null) return relaxed
  }
  return null
}

/** JSON.parse a plain object or return null. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* not JSON */
  }
  return null
}

/** Result of {@link parseAnswer}. */
export interface ParsedAnswer {
  answer: string
  data: Record<string, unknown> | null
  hasFence: boolean
}

/**
 * Split one assistant answer into display markdown and the trailing structured
 * `litnotes-json` payload (frozen AI-SPEC §5).
 *
 * Robustness rules kept from 1.0.0:
 *  - only a *trailing* fenced block is consumed (nothing but whitespace after the
 *    closing fence); an unclosed trailing fence is consumed too, so a partially
 *    streamed answer never shows raw JSON;
 *  - ``` or ~~~ fences with 0–3 leading spaces are accepted; the info string is
 *    case-insensitive; the body may contain prose/trailing commas (best effort);
 *  - JSON that is not a plain object yields `data: null` but is still stripped;
 *  - earlier code fences in the answer are preserved untouched.
 *
 * @param text - raw model output (any value; non-strings become '').
 * @returns display markdown, fenced payload and whether a fence was found.
 */
export function parseAnswer(text: unknown): ParsedAnswer {
  const normalized = String(text === undefined || text === null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  let openLine = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const fence = fenceOpen(lines[index])
    if (fence !== null && fence.info === 'litnotes-json') {
      openLine = index
      break
    }
  }
  if (openLine === -1) return { answer: trimEnd(normalized), data: null, hasFence: false }
  const open = fenceOpen(lines[openLine])
  if (open === null) return { answer: trimEnd(normalized), data: null, hasFence: false }
  let closeLine = -1
  for (let index = openLine + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== undefined && fenceClose(line, open)) {
      closeLine = index
      break
    }
  }
  const trailing = closeLine === -1 ? true : lines.slice(closeLine + 1).every((line) => line.trim() === '')
  if (!trailing) return { answer: trimEnd(normalized), data: null, hasFence: false }
  const answer = trimEnd(lines.slice(0, openLine).join('\n'))
  const bodyLines = closeLine === -1 ? lines.slice(openLine + 1) : lines.slice(openLine + 1, closeLine)
  return { answer, data: tryJson(bodyLines.join('\n')), hasFence: true }
}

/* -------------------------------------------------------------------------- */
/* Inline citation markers                                                    */
/* -------------------------------------------------------------------------- */

/** Find the closing backtick run of exactly `length` characters, or -1. */
function findBacktickClose(line: string, from: number, length: number): number {
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

/** Pending literal buffer while scanning one answer. */
interface TextBuffer {
  text: string
  start: number
}

/** Append a literal span to the pending text buffer. */
function pushText(buffer: TextBuffer, text: string, start: number): void {
  if (text === '') return
  if (buffer.text === '') buffer.start = start
  buffer.text += text
}

/** Flush the pending literal buffer as one text part. */
function flushText(parts: CitationMarkerPart[], buffer: TextBuffer): void {
  if (buffer.text === '') return
  parts.push({ type: 'text', text: buffer.text, start: buffer.start, end: buffer.start + buffer.text.length })
  buffer.text = ''
}

/** Scan one non-fenced line for inline code spans and `[n]` markers. */
function scanCitationLine(
  line: string,
  lineOffset: number,
  parts: CitationMarkerPart[],
  buffer: TextBuffer,
): void {
  let index = 0
  while (index < line.length) {
    const character = line.charAt(index)
    if (character === '\\') {
      const end = Math.min(line.length, index + 2)
      pushText(buffer, line.slice(index, end), lineOffset + index)
      index = end
      continue
    }
    if (character === '`') {
      let run = 1
      while (index + run < line.length && line.charAt(index + run) === '`') run += 1
      const close = findBacktickClose(line, index + run, run)
      const end = close === -1 ? index + run : close + run
      pushText(buffer, line.slice(index, end), lineOffset + index)
      index = end
      continue
    }
    if (character === '[') {
      const match = /^\[([1-9]\d{0,2})\]/.exec(line.slice(index))
      if (match !== null) {
        const next = line.charAt(index + match[0].length)
        // `[1](…)` is an inline link and `[1]:` a link definition, not a citation.
        if (next !== '(' && next !== ':') {
          flushText(parts, buffer)
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
    while (next < line.length && '\\`['.indexOf(line.charAt(next)) === -1) next += 1
    pushText(buffer, line.slice(index, next), lineOffset + index)
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
 * @param text - answer markdown (any value; non-strings become '').
 * @returns ordered literal/citation parts with offsets into the source string.
 */
export function citationMarkers(text: unknown): CitationMarkerPart[] {
  const source = String(text === undefined || text === null ? '' : text)
  const parts: CitationMarkerPart[] = []
  if (source === '') return parts
  const buffer: TextBuffer = { text: '', start: 0 }
  const lines = source.split('\n')
  let fence: Fence | null = null
  let offset = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const lineOffset = offset
    const newline = lineIndex < lines.length - 1 ? '\n' : ''
    if (fence !== null) {
      pushText(buffer, line + newline, lineOffset)
      if (fenceClose(line, fence)) fence = null
    } else {
      const open = fenceOpen(line)
      if (open !== null) {
        fence = open
        pushText(buffer, line + newline, lineOffset)
      } else {
        scanCitationLine(line, lineOffset, parts, buffer)
        pushText(buffer, newline, lineOffset + line.length)
      }
    }
    offset += line.length + newline.length
  }
  flushText(parts, buffer)
  return parts
}

/* -------------------------------------------------------------------------- */
/* Tolerant normalization of history / wire values                            */
/* -------------------------------------------------------------------------- */

/** One string, or '' for anything else. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Finite truncated number, or null. */
function asInteger(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

/** Non-empty trimmed strings from a raw array. */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text !== '') out.push(text)
  }
  return out
}

/** Coerce to a plain record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Normalize one aspect value; unknown values become `context`. */
export function normalizeAspect(value: unknown): Aspect {
  if (typeof value === 'string' && (ASPECTS as readonly string[]).includes(value)) return value as Aspect
  return 'context'
}

/** Normalize one entailment verdict; unknown/absent values become ''. */
export function normalizeEntailment(value: unknown): EntailmentVerdict {
  return value === 'supported' || value === 'partial' || value === 'unsupported' || value === 'unchecked'
    ? value
    : ''
}

/** Normalize model routes (`{provider, model}`); null when both are empty. */
function normalizeModel(value: unknown): { provider: string; model: string } | null {
  const record = asRecord(value)
  if (record === null) return null
  const provider = asString(record['provider'])
  const model = asString(record['model'])
  if (provider === '' && model === '') return null
  return { provider, model }
}

/** Normalize token usage; zeroed when the object carries no numbers. */
function normalizeUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  const record = asRecord(value)
  const input = asInteger(record?.['inputTokens'])
  const output = asInteger(record?.['outputTokens'])
  return {
    inputTokens: input !== null && input > 0 ? input : 0,
    outputTokens: output !== null && output > 0 ? output : 0,
  }
}

/** Normalize a knowledge-delta reference list. */
function normalizeKnowledge(value: unknown): { nodeIds: string[]; edgeIds: string[] } {
  const record = asRecord(value)
  if (record === null) return { nodeIds: [], edgeIds: [] }
  return { nodeIds: asStringList(record['nodeIds']), edgeIds: asStringList(record['edgeIds']) }
}

/** Normalize one citation–claim summary. */
function normalizeEntailmentSummary(value: unknown): EntailmentSummary | null {
  const record = asRecord(value)
  if (record === null) return null
  const count = (key: string): number => {
    const number = asInteger(record[key])
    return number !== null && number > 0 ? number : 0
  }
  return {
    checked: record['checked'] === true,
    supported: count('supported'),
    partial: count('partial'),
    unsupported: count('unsupported'),
  }
}

/**
 * Normalize one citations array.
 *
 * Entries need a usable index (falling back to their array position) and at
 * least a blockKey or a quote. Entailment fields are preserved; unverified
 * entries keep their failure `reason` and are forced `verified:false`.
 *
 * @param raw - wire value (usually `Citation[]` or the frozen unverified shape).
 * @param forceUnverified - true when the host already rejected every entry.
 * @returns normalized citations for rendering.
 */
export function normalizeCitationList(raw: unknown, forceUnverified: boolean): AiCitation[] {
  if (!Array.isArray(raw)) return []
  const out: AiCitation[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const item = asRecord(raw[index])
    if (item === null) continue
    const rawIndex = asInteger(item['index'])
    const citationIndex = rawIndex !== null && rawIndex >= 1 ? rawIndex : index + 1
    const blockKey = asString(item['blockKey']).trim()
    const quote = asString(item['quote'])
    if (blockKey === '' && quote === '') continue
    const start = asInteger(item['start'])
    const end = asInteger(item['end'])
    const page = asInteger(item['page'])
    out.push({
      index: citationIndex,
      blockKey,
      quote,
      start: start !== null && start >= 0 ? start : null,
      end: end !== null && end >= 0 ? end : null,
      page: page !== null && page > 0 ? page : null,
      aspect: normalizeAspect(item['aspect']),
      note: asString(item['note']),
      verified: forceUnverified ? false : item['verified'] !== false,
      entailment: normalizeEntailment(item['entailment']),
      entailmentReason: asString(item['entailmentReason']),
      reason: asString(item['reason']),
    })
  }
  return out
}

/** Unwrap the tolerant history payload shapes into a message array. */
function historyList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const record = asRecord(raw)
  if (record === null) return []
  if (Array.isArray(record['messages'])) return record['messages']
  if (Array.isArray(record['items'])) return record['items']
  const value = asRecord(record['value'])
  if (value !== null && Array.isArray(value['messages'])) return value['messages']
  return []
}

/**
 * Normalize one history payload (array, `{messages}`, `{items}` or
 * `{value:{messages}}`) into render entries.
 *
 * Roles, ids, defaults, fenced-answer stripping, citation fields and duplicate
 * ids follow the frozen `mruAiNormalizeMessages` contract; the input is never
 * mutated.
 *
 * @param raw - `chat.history` value or any tolerant wrapper.
 * @returns normalized entries (empty for unusable input).
 */
export function normalizeMessages(raw: unknown): ChatEntry[] {
  const list = historyList(raw)
  const out: ChatEntry[] = []
  for (let index = 0; index < list.length; index += 1) {
    const item = asRecord(list[index])
    if (item === null) continue
    let role: 'user' | 'assistant' | '' =
      item['role'] === 'assistant' || item['role'] === 'user' ? item['role'] : ''
    if (role === '') role = typeof item['answer'] === 'string' && item['answer'] !== '' ? 'assistant' : 'user'
    let question = asString(item['question'])
    if (question === '') question = asString(item['content'])
    if (role === 'user' && question.trim() === '') continue
    let answer = asString(item['answer'])
    let fenced: Record<string, unknown> | null = null
    if (role === 'assistant' && answer.indexOf('litnotes-json') !== -1) {
      const parsed = parseAnswer(answer)
      if (parsed.hasFence) {
        answer = parsed.answer
        fenced = parsed.data
      }
    }
    const citations = normalizeCitationList(
      Array.isArray(item['citations']) ? item['citations'] : fenced?.['citations'],
      false,
    )
    const unverified = normalizeCitationList(
      Array.isArray(item['unverified']) ? item['unverified'] : fenced?.['unverified'],
      true,
    )
    const followups = asStringList(Array.isArray(item['followups']) ? item['followups'] : fenced?.['followups'])
    const serverId = asString(item['id']).trim()
    let id = serverId
    if (id === '') id = `history-${index}`
    for (const existing of out) {
      if (existing.id === id) {
        id = `${id}-${index}`
        break
      }
    }
    out.push({
      id,
      serverId,
      role,
      question,
      answer,
      citations,
      unverified,
      followups,
      model: normalizeModel(item['model']),
      usage: normalizeUsage(item['usage']),
      annotationIds: asStringList(item['annotationIds']),
      knowledge: normalizeKnowledge(item['knowledge']),
      entailment: normalizeEntailmentSummary(item['entailment']),
      createdAt: asString(item['createdAt']),
      streaming: false,
      phase: '',
      stopped: false,
      failed: false,
      local: false,
    })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Entailment flags                                                           */
/* -------------------------------------------------------------------------- */

/** Unverified reason the host assigns to citations the entailment pass rejects. */
export const ENTAILMENT_UNSUPPORTED_REASON = 'entailment-unsupported'

/** Entailment flags for one citation chip/card. */
export interface CitationFlags {
  /** The quote only partly supports the claim (verified, warned, still jumpable). */
  partial: boolean
  /** The quote does not support the claim (moved to unverified, never jumpable). */
  unsupported: boolean
}

/**
 * Entailment flags for one citation chip/card.
 *
 * `partial` — the quote only partly supports the claim (verified, warned, still
 * jumpable). `unsupported` — the quote does not support the claim: the host
 * moved it to `unverified` (reason `entailment-unsupported`); the UI keeps it
 * dimmed and must not jump from it.
 *
 * @param citation - normalized citation (or null for a marker without data).
 * @param verified - whether the host validated the quote.
 * @returns the two display flags.
 */
export function citationFlags(citation: AiCitation | null | undefined, verified: boolean): CitationFlags {
  const entailment = citation?.entailment ?? ''
  const reason = citation?.reason ?? ''
  return {
    partial: entailment === 'partial',
    unsupported:
      verified === false && (reason === ENTAILMENT_UNSUPPORTED_REASON || entailment === 'unsupported'),
  }
}

/** Breakdown of unverified citations into entailment rejections and other reasons. */
export interface UnverifiedBreakdown {
  unsupported: number
  generic: number
  total: number
}

/**
 * Split unverified citations into entailment-unsupported entries and every
 * other failure reason, so the answer footer picks the right notice (and never
 * double-counts).
 *
 * @param unverified - normalized unverified citations.
 * @returns counts for the notices.
 */
export function unverifiedBreakdown(unverified: readonly AiCitation[] | null | undefined): UnverifiedBreakdown {
  const list = Array.isArray(unverified) ? unverified : []
  let unsupported = 0
  for (const citation of list) {
    if (citationFlags(citation, false).unsupported) unsupported += 1
  }
  return { unsupported, generic: list.length - unsupported, total: list.length }
}

/* -------------------------------------------------------------------------- */
/* Citation lookup / turn building                                            */
/* -------------------------------------------------------------------------- */

/** One citation lookup entry: the citation plus whether it was verified. */
export interface CitationLookupEntry {
  citation: AiCitation
  verified: boolean
}

/** Build an index → citation map for one answer (verified entries win). */
export function citationLookup(
  citations: readonly AiCitation[] | null | undefined,
  unverified: readonly AiCitation[] | null | undefined,
): Map<number, CitationLookupEntry> {
  const map = new Map<number, CitationLookupEntry>()
  for (const citation of citations ?? []) {
    if (!map.has(citation.index)) map.set(citation.index, { citation, verified: citation.verified !== false })
  }
  for (const citation of unverified ?? []) {
    if (!map.has(citation.index)) map.set(citation.index, { citation, verified: false })
  }
  return map
}

/** Replace one entry in a list without mutating it. */
export function patchEntry(
  entries: readonly ChatEntry[],
  id: string,
  update: (entry: ChatEntry) => ChatEntry,
): ChatEntry[] {
  let changed = false
  const next = entries.map((entry) => {
    if (entry.id !== id) return entry
    changed = true
    return update(entry)
  })
  return changed ? next : [...entries]
}

/** Find the user question preceding one assistant entry (regenerate fallback). */
export function previousQuestion(entries: readonly ChatEntry[], messageId: string): string {
  const index = entries.findIndex((entry) => entry.id === messageId)
  if (index < 0) return ''
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor]
    if (entry === undefined) continue
    if (entry.question.trim() !== '') return entry.question
  }
  return ''
}

/** A fresh local entry kept stable while the host id is unknown. */
export function localEntry(id: string, role: 'user' | 'assistant', question: string): ChatEntry {
  return {
    id,
    serverId: '',
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
    entailment: null,
    createdAt: new Date().toISOString(),
    streaming: role === 'assistant',
    phase: '',
    stopped: false,
    failed: false,
    local: true,
  }
}

/** First citation block key an answer anchors to (verified entries first). */
export function entryAnchor(entry: ChatEntry | null | undefined): string | null {
  if (entry === null || entry === undefined) return null
  for (const citation of entry.citations) {
    if (citation.blockKey !== '') return citation.blockKey
  }
  for (const citation of entry.unverified) {
    if (citation.blockKey !== '') return citation.blockKey
  }
  return null
}

/**
 * Build question → answer turns from normalized entries.
 *
 * A user entry opens a turn; the next assistant entry answers it. Consecutive
 * assistant answers keep the same question and open a new turn (frozen export
 * semantics), so history is always renderable even when it is malformed.
 *
 * @param entries - normalized conversation entries.
 * @returns ordered turns (at least the entries needed to render).
 */
export function chatTurns(entries: readonly ChatEntry[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const entry of entries) {
    if (entry.role === 'user') {
      turns.push({
        id: entry.id,
        questionId: entry.id,
        question: entry.question,
        assistant: null,
        createdAt: entry.createdAt,
        anchorBlockKey: null,
      })
      continue
    }
    const last = turns.length > 0 ? turns[turns.length - 1] : undefined
    const turn: ChatTurn =
      last === undefined || last.assistant !== null
        ? {
            id: entry.id,
            questionId: null,
            question: entry.question,
            assistant: entry,
            createdAt: entry.createdAt,
            anchorBlockKey: entryAnchor(entry),
          }
        : {
            ...last,
            id: entry.id,
            assistant: entry,
            anchorBlockKey: entryAnchor(entry),
          }
    if (last === undefined || last.assistant !== null) turns.push(turn)
    else turns[turns.length - 1] = turn
  }
  return turns
}

/** Number of user messages that have a non-empty question. */
export function countQuestions(entries: readonly ChatEntry[] | null | undefined): number {
  return questionMarks(entries ?? []).length
}

/**
 * Sort turns into document order: by the anchor block's position, then by
 * creation time; entries without an anchor keep creation order at the end.
 *
 * @param turns - turns to sort (not mutated).
 * @param orderOf - reader document order of a block key (`null` = unknown).
 * @returns a sorted copy.
 */
export function sortTurns(
  turns: readonly ChatTurn[],
  orderOf: (blockKey: string) => number | null,
): ChatTurn[] {
  const decorated = turns.map((turn, index) => {
    const anchor = turn.anchorBlockKey === null ? null : orderOf(turn.anchorBlockKey)
    return { turn, index, order: anchor, createdAt: turn.createdAt }
  })
  decorated.sort((left, right) => {
    const leftAnchored = left.order
    const rightAnchored = right.order
    if (leftAnchored === null && rightAnchored !== null) return 1
    if (leftAnchored !== null && rightAnchored === null) return -1
    if (leftAnchored !== null && rightAnchored !== null && leftAnchored !== rightAnchored) {
      return leftAnchored - rightAnchored
    }
    const leftTime = left.createdAt
    const rightTime = right.createdAt
    if (leftTime !== rightTime) {
      if (leftTime === '') return 1
      if (rightTime === '') return -1
      const leftDate = Date.parse(leftTime)
      const rightDate = Date.parse(rightTime)
      if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
        return leftDate - rightDate
      }
    }
    return left.index - right.index
  })
  return decorated.map((item) => item.turn)
}

/** Count turns whose citations include one aspect (aspect filter seam). */
export function turnHasAspect(turn: ChatTurn, aspect: string): boolean {
  const assistant = turn.assistant
  if (assistant === null) return false
  return (
    assistant.citations.some((citation) => citation.aspect === aspect) ||
    assistant.unverified.some((citation) => citation.aspect === aspect)
  )
}

/* -------------------------------------------------------------------------- */
/* Conversation export (frozen 1.0.0 format)                                  */
/* -------------------------------------------------------------------------- */

/** Metadata of one Markdown conversation export. */
export interface ExportMeta {
  title?: string
  modelLabel?: string
  exportedAt?: string
  t?: AiTranslate | null
}

/** One exported conversation file. */
export interface ExportResult {
  filename: string
  markdown: string
}

/** Format an export timestamp as `YYYY-MM-DD HH:mm` in local time. */
function exportStamp(value: unknown): string {
  const text = asString(value).trim()
  if (text === '') return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  const pad = (number: number): string => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** Sanitize a conversation title into a portable Markdown download filename. */
function exportFilename(title: unknown): string {
  let base = asString(title)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s-]+$/, '')
  if (base.length > 80) base = base.slice(0, 80).replace(/[.\s-]+$/, '')
  if (base === '') base = 'ai-conversation'
  return `${base}.md`
}

/** One exported citation line: `[n] · p.page · aspect · quote · note`. */
function exportCitationLine(citation: AiCitation, verified: boolean, t: AiTranslate | null): string {
  const parts = [`[${citation.index}]`]
  if (citation.page !== null && citation.page > 0) parts.push(`p.${citation.page}`)
  parts.push(aiT(t, `aspect.${citation.aspect}`))
  const quote = citation.quote.replace(/\s+/g, ' ').trim()
  if (quote !== '') parts.push(quote)
  const note = citation.note.replace(/\s+/g, ' ').trim()
  if (note !== '') parts.push(note)
  if (!verified) parts.push(aiT(t, 'ai.exportUnverified'))
  return parts.join(' · ')
}

/**
 * Render one conversation as a portable Markdown document (frozen AI-SPEC §6).
 *
 * The answer markdown is embedded verbatim and each answer's citations become a
 * `[n] · p.page · aspect · quote · note` list (unverified entries marked). The
 * framing copy is localized through `meta.t` with the reserved `ai.export*`
 * keys.
 *
 * @param messages - normalized entries or a raw `{messages}` history payload.
 * @param meta - title/model/export time + translate callback.
 * @returns the downloadable file, or null for an empty conversation.
 */
export function exportMarkdown(messages: unknown, meta?: ExportMeta | null): ExportResult | null {
  const source = meta ?? {}
  const t = typeof source.t === 'function' ? source.t : null
  const entries = normalizeMessages(messages)
  const turns = chatTurns(entries)
  if (turns.length === 0) return null
  const title = asString(source.title).trim()
  const head = [
    title !== '' ? `# ${title} — ${aiT(t, 'ai.exportTitle')}` : `# ${aiT(t, 'ai.exportTitle')}`,
    '',
  ]
  const modelLabel = asString(source.modelLabel).trim()
  if (modelLabel !== '') head.push(`- ${aiT(t, 'ai.exportModel')}: ${modelLabel}`)
  const exportedAt = asString(source.exportedAt).trim()
  head.push(
    `- ${aiT(t, 'ai.exportTime')}: ${exportStamp(exportedAt !== '' ? exportedAt : new Date().toISOString())}`,
  )
  const blocks: string[] = []
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    if (turn === undefined) continue
    const ordinal = index + 1
    const block: string[] = [`## ${aiT(t, 'ai.exportQuestion', { index: ordinal })}`]
    const question = turn.question.trim()
    if (question !== '') block.push(question)
    block.push('', `## ${aiT(t, 'ai.exportAnswer', { index: ordinal })}`)
    const answer = turn.assistant === null ? '' : turn.assistant.answer.trim()
    if (answer !== '') block.push(answer)
    const citations = turn.assistant?.citations ?? []
    const unverified = turn.assistant?.unverified ?? []
    const citationLines = [
      ...citations.map((citation) => exportCitationLine(citation, true, t)),
      ...unverified.map((citation) => exportCitationLine(citation, false, t)),
    ]
    if (citationLines.length > 0) {
      block.push('', `### ${aiT(t, 'ai.exportCitation')}`)
      for (const line of citationLines) block.push(`- ${line}`)
    }
    blocks.push(block.join('\n'))
  }
  return { filename: exportFilename(title), markdown: `${head.join('\n')}\n\n${blocks.join('\n\n')}\n` }
}

/* -------------------------------------------------------------------------- */
/* Question navigator (frozen UI-POLISH §3)                                   */
/* -------------------------------------------------------------------------- */

/** One navigator mark per user question of the conversation. */
export interface QuestionMark {
  id: string
  messageId: string
  ordinal: number
  question: string
}

/** One measured message offset inside the scroll container. */
export interface QuestionOffset {
  messageId: string
  top: number
}

/**
 * One navigator mark per user question of the conversation, in order.
 *
 * @param entries - normalized chat entries.
 * @returns marks with ordinals and display-safe question text.
 */
export function questionMarks(entries: readonly ChatEntry[] | null | undefined): QuestionMark[] {
  const marks: QuestionMark[] = []
  for (const entry of entries ?? []) {
    if (entry.role !== 'user') continue
    if (entry.id === '') continue
    marks.push({
      id: entry.id,
      messageId: entry.id,
      ordinal: marks.length + 1,
      question: displayText(entry.question),
    })
  }
  return marks
}

/**
 * Index of the current navigator mark: the last question whose measured top is
 * at or above the anchor line. `offsets` entries are `{messageId, top}` in
 * container-relative px. Returns -1 when nothing can be resolved.
 *
 * @param marks - navigator marks.
 * @param offsets - measured message positions.
 * @param anchorY - anchor line in container space.
 * @returns the current mark index, or -1.
 */
export function navCurrentMark(
  marks: readonly QuestionMark[],
  offsets: readonly QuestionOffset[],
  anchorY: number,
): number {
  if (marks.length === 0) return -1
  const anchor = Number(anchorY)
  if (!Number.isFinite(anchor)) return -1
  const tops = new Map<string, number>()
  for (const offset of offsets) {
    const top = Number(offset.top)
    if (offset.messageId !== '' && Number.isFinite(top)) tops.set(offset.messageId, top)
  }
  let current = -1
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]
    if (mark === undefined) continue
    const top = tops.get(mark.messageId)
    if (top !== undefined && Number.isFinite(top) && top <= anchor) current = index
  }
  return current
}

/** Whether the conversation list is scrolled away from its newest message. */
export function navAwayFromLatest(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 120,
): boolean {
  const top = Number(scrollTop)
  const height = Number(scrollHeight)
  const view = Number(clientHeight)
  const gap = Number(threshold)
  if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(view)) return false
  const limit = Number.isFinite(gap) ? gap : 120
  return height - top - view > limit
}

/** Target scrollTop that brings `messageTop` to `padding` below the container top. */
export function navTargetScrollTop(
  scrollTop: number,
  messageTop: number,
  containerTop: number,
  padding = 12,
): number {
  const base = Number(scrollTop) || 0
  const message = Number(messageTop)
  const container = Number(containerTop)
  const pad = Number(padding)
  if (!Number.isFinite(message) || !Number.isFinite(container)) return Math.max(0, Math.round(base))
  return Math.max(0, Math.round(base + (message - container) - (Number.isFinite(pad) ? pad : 12)))
}

/** Fixed aspect legend order (reader `aspect.*` labels from the app dictionaries). */
const ASPECT_LEGEND_ROWS: ReadonlyArray<readonly [Aspect, string]> = [
  ['definition', 'aspect.definition'],
  ['context', 'aspect.context'],
  ['method', 'aspect.method'],
  ['result', 'aspect.result'],
  ['limitation', 'aspect.limitation'],
]

/** One aspect legend row (dot + always-visible text label). */
export interface AspectLegendItem {
  aspect: Aspect
  label: string
}

/**
 * Legend rows for the margin: dot + always-visible text label resolved through
 * the reader `aspect.*` keys.
 *
 * @param t - translate callback (null falls back to the keys).
 * @returns five legend items in fixed order.
 */
export function aspectLegendItems(t: AiTranslate | null | undefined): AspectLegendItem[] {
  return ASPECT_LEGEND_ROWS.map(([aspect, key]) => ({ aspect, label: aiT(t, key) }))
}

/* -------------------------------------------------------------------------- */
/* Error copy (frozen AI-SPEC §6 vocabulary)                                  */
/* -------------------------------------------------------------------------- */

/** Turn host/stream failures into reader-facing copy. */
export function errorText(t: AiTranslate | null | undefined, error: unknown): string {
  if (typeof error === 'string' && error !== '') return error
  const record = asRecord(error)
  const code = asString(record?.['code'])
  if (code === 'llm-unavailable') return aiT(t, 'ai.errModel')
  if (code === 'llm-failed' || code === 'ai-failed') return aiT(t, 'ai.errFailed')
  if (code === 'context-too-large') return aiT(t, 'ai.errContext')
  if (code === 'aborted') return aiT(t, 'ai.errAborted')
  if (code === 'ai-unavailable' || code === 'host-unavailable') return aiT(t, 'ai.errHost')
  if (code === 'network') return aiT(t, 'ai.errNetwork')
  if (code === 'token-missing' || code === 'translate-unavailable') return aiT(t, 'ai.errModel')
  const message = asString(record?.['message']).trim()
  if (message !== '') return message
  return aiT(t, 'ai.errGeneric')
}
