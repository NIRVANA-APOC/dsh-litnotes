/**
 * Grounded reading conversation for dsh-litnotes (docs/AI-SPEC.md §3/§4/§5).
 *
 * One turn: load history → retrieve a bounded context window from the shared
 * reader-parser blocks → ask the model for a Markdown answer plus the trailing
 * ```litnotes-json block → stream the answer while holding the JSON fence back
 * → verify every citation against the block text (whitespace-normalized
 * substring, ≥20-char prefix fallback, offsets computed against `plainText`) →
 * one citation–claim entailment pass over the verified citations (supported /
 * partial / unsupported; unsupported evidence is moved to `unverified`) →
 * turn surviving citations into aspect-colored AI annotations (deduped, capped)
 * → persist the ChatMessage pair to `chat.json` → optional knowledge-graph
 * delta. Every failure after the stream starts is emitted as an error frame;
 * aborts never persist a half turn and never touch user annotations.
 *
 * Frames (exact objects from docs/AI-SPEC.md §4):
 *
 *     { type:'start', messageId, model }
 *     { type:'delta', text }
 *     { type:'phase', phase:'entailment' }        (before the entailment call)
 *     { type:'answer', messageId, markdown, citations, unverified, followups,
 *       annotationIds, entailment:{ checked, supported, partial, unsupported } }
 *     { type:'graph', delta: { nodes, edges } }
 *     { type:'usage', usage }
 *     { type:'done' }
 *     { type:'error', code, message }
 *
 * @module lib/ai/chat
 */
import { randomUUID } from 'node:crypto'
import { normalizeAspect, aspectColor } from './aspects.js'
import { AiError } from './llm.js'
import {
  ANSWER_FENCE_OPEN,
  CHAT_SYSTEM,
  ENTAILMENT_SYSTEM,
  PROMPT_VERSION,
  chatUserPrompt,
  entailmentPrompt,
  parseEntailmentOutput,
} from './prompts.js'

/** Aux JSON file holding one document's conversation (docs/AI-SPEC.md §2). */
const CHAT_FILE = 'chat.json'
/** Maximum stored messages per document (oldest are dropped). */
const MAX_CHAT_MESSAGES = 200
/** Maximum question length accepted from the client. */
const MAX_QUESTION_CHARS = 4000
/** Maximum answer markdown persisted/streamed as the final answer. */
const MAX_ANSWER_CHARS = 60000
/** Hard cap on raw model output consumed for one turn. */
const MAX_RAW_OUTPUT_CHARS = 200000
/** Maximum citations considered per answer. */
const MAX_CITATIONS = 60
/** Maximum follow-up suggestions. */
const MAX_FOLLOWUPS = 4
/** Maximum knowledge nodes/edges passed to the graph service per answer. */
const MAX_KNOWLEDGE_NODES = 8
const MAX_KNOWLEDGE_EDGES = 12
/** Quoted evidence length bounds. */
const MAX_QUOTE_CHARS = 2000
const MAX_NOTE_CHARS = 500
/** Annotation default cap per answer (config.ai.maxAnnotationsPerAnswer). */
const DEFAULT_MAX_ANNOTATIONS = 5
/** Default completion budget for the citation–claim entailment pass. */
const DEFAULT_ENTAILMENT_MAX_TOKENS = 600
/** Entailment states persisted on citations (docs/AI-SPEC.md §2). */
const ENTAILMENT_STATES = new Set(['supported', 'partial', 'unsupported', 'unchecked'])
/** Unverified reason assigned to citations the entailment pass rejects. */
const UNVERIFIED_REASON_ENTAILMENT = 'entailment-unsupported'
/** Maximum annotations stored per document (mirrors lib/store.js). */
const MAX_STORED_ANNOTATIONS = 5000
/** Minimum quote length that may verify via prefix fallback. */
const MIN_PREFIX_QUOTE_CHARS = 20
/** Prefix length tried first for the fallback (docs/AI-SPEC.md §3). */
const PREFIX_QUOTE_CHARS = 40
/** Bound for graph ids collected from a merge result. */
const MAX_KNOWLEDGE_IDS = 40

/** Node types accepted in Q&A knowledge deltas. */
const KNOWLEDGE_NODE_TYPES = new Set([
  'concept', 'method', 'finding', 'definition', 'limitation', 'section', 'question', 'insight',
  'paper', 'topic',
])
/** Edge types accepted in Q&A knowledge deltas. */
const KNOWLEDGE_EDGE_TYPES = new Set([
  'defines', 'uses', 'supports', 'contradicts', 'part_of', 'leads_to', 'evolves_from', 'relates',
  'answers', 'mentions',
])
/** Maximum number of `[n]` markers scanned in one answer. */
const MAX_MARKERS = 4000

/**
 * Clamp a finite integer into range with a fallback.
 * @param {unknown} value - candidate.
 * @param {number} min - minimum.
 * @param {number} max - maximum.
 * @param {number} fallback - value for invalid input.
 * @returns {number} clamped integer.
 */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Collapse all whitespace runs to single spaces and trim (quote matching). */
export function normalizeQuoteText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Build the whitespace-normalized text of a block plus the mapping from each
 * normalized character position back to the block's original offsets.
 *
 * @param {string} plainText - block plain text (offset space for annotations).
 * @returns {{ normalized: string, offsets: number[] }} normalized text and map.
 */
function normalizeWithMap(plainText) {
  const chars = []
  const offsets = []
  let lastWasSpace = false
  for (let index = 0; index < plainText.length; index += 1) {
    const char = plainText[index]
    if (/\s/.test(char)) {
      if (lastWasSpace) continue
      chars.push(' ')
      offsets.push(index)
      lastWasSpace = true
    } else {
      chars.push(char)
      offsets.push(index)
      lastWasSpace = false
    }
  }
  let start = 0
  while (start < chars.length && chars[start] === ' ') start += 1
  let end = chars.length
  while (end > start && chars[end - 1] === ' ') end -= 1
  return {
    normalized: chars.slice(start, end).join(''),
    offsets: offsets.slice(start, end),
  }
}

/**
 * Locate a quote inside one block's plain text and compute annotation offsets.
 *
 * Matching rules (docs/AI-SPEC.md §3/§5): whitespace-normalized substring
 * first; if that fails and the quote is at least 20 characters long, a prefix
 * of up to 40 characters is accepted (models drift on long quotes). The
 * returned offsets always address the ORIGINAL `plainText`, never the
 * normalized copy, so the client can highlight the exact span.
 *
 * @param {string} plainText - block plain text (annotation offset space).
 * @param {string} quote - model-provided verbatim quote.
 * @returns {{ start: number, end: number, exact: boolean, matched: number } | null}
 *   offsets (`end` exclusive) or null when the quote cannot be located.
 */
export function locateQuoteRange(plainText, quote) {
  const plain = typeof plainText === 'string' ? plainText : ''
  const needle = normalizeQuoteText(quote)
  if (plain === '' || needle === '') return null
  const { normalized, offsets } = normalizeWithMap(plain)
  if (normalized === '') return null
  const found = normalized.indexOf(needle)
  if (found !== -1) {
    const last = found + needle.length - 1
    return { start: offsets[found], end: offsets[last] + 1, exact: true, matched: needle.length }
  }
  if (needle.length < MIN_PREFIX_QUOTE_CHARS) return null
  const prefixLength = Math.min(needle.length, PREFIX_QUOTE_CHARS)
  const candidates = [needle.slice(0, prefixLength)]
  if (prefixLength > MIN_PREFIX_QUOTE_CHARS) candidates.push(needle.slice(0, MIN_PREFIX_QUOTE_CHARS))
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed.length < MIN_PREFIX_QUOTE_CHARS) continue
    const at = normalized.indexOf(trimmed)
    if (at === -1) continue
    const last = at + trimmed.length - 1
    return { start: offsets[at], end: offsets[last] + 1, exact: false, matched: trimmed.length }
  }
  return null
}

/** Parse JSON without throwing. */
function tryParseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Whether a parsed object looks like the model output contract payload. */
function isContractPayload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Array.isArray(value.citations) || value.knowledge !== undefined || Array.isArray(value.followups)
}

/**
 * Split raw model output into the visible answer Markdown and the trailing
 * `litnotes-json` payload.
 *
 * The primary split uses the documented fence tag (case/space tolerant). A
 * fallback accepts a bare trailing ```json fence that parses to the contract
 * shape, so a slightly drifting model still yields citations instead of raw
 * JSON in the reader. Text after the fence is ignored on purpose.
 *
 * @param {string} rawText - complete model output.
 * @returns {{ answer: string, payload: object | null, fenceFound: boolean }}
 *   answer without the fence, parsed contract payload (or null) and whether a
 *   `litnotes-json` fence was present.
 */
export function splitModelOutput(rawText) {
  const raw = typeof rawText === 'string' ? rawText : ''
  const marker = /```[ \t]*litnotes-json\b/i.exec(raw)
  let answer = raw
  let payloadText = ''
  let fenceFound = false
  if (marker !== null) {
    fenceFound = true
    answer = raw.slice(0, marker.index)
    const after = raw.slice(marker.index + marker[0].length)
    const close = after.indexOf('```')
    payloadText = close === -1 ? after : after.slice(0, close)
  } else {
    const fallback = /```(?:[ \t]*json)?[ \t]*\r?\n([\s\S]*?)```[ \t]*\s*$/i.exec(raw)
    if (fallback !== null) {
      const candidate = tryParseJson(fallback[1])
      if (isContractPayload(candidate)) {
        answer = raw.slice(0, fallback.index)
        payloadText = fallback[1]
      }
    }
  }
  let payload = null
  if (payloadText.trim() !== '') {
    payload = tryParseJson(payloadText)
    if (payload === null) {
      const firstBrace = payloadText.indexOf('{')
      const lastBrace = payloadText.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        payload = tryParseJson(payloadText.slice(firstBrace, lastBrace + 1))
      }
    }
  }
  return { answer: answer.trimEnd(), payload, fenceFound }
}

/** Bound one citation-ish object for persistence/validation. */
function boundedString(value, maxChars) {
  return typeof value === 'string' ? value.slice(0, maxChars) : ''
}

/**
 * Validate the model's citations against the actual parser blocks.
 *
 * `verified:true` requires both: the `blockKey` exists in the document and the
 * quote occurs in that block's plain text (whitespace-normalized substring, or
 * a ≥20-char prefix fallback). Everything else is reported in `unverified` and
 * never becomes an annotation or graph knowledge.
 *
 * @param {{
 *   payload: object | null,
 *   answer: string,
 *   blockEntries: Map<string, object>,
 * }} input - raw payload, visible answer Markdown and key→block map.
 * @returns {{ citations: object[], unverified: object[] }} validated citations.
 */
export function validateCitations({ payload, answer, blockEntries } = {}) {
  const text = typeof answer === 'string' ? answer : ''
  const referenced = new Set()
  const markerPattern = /\[(\d{1,4})\]/g
  let scanned = 0
  for (let match = markerPattern.exec(text); match !== null && scanned < MAX_MARKERS; match = markerPattern.exec(text)) {
    scanned += 1
    const index = Number(match[1])
    if (Number.isInteger(index) && index > 0) referenced.add(index)
  }
  const citations = []
  const unverified = []
  const seen = new Set()
  const rawCitations = Array.isArray(payload?.citations) ? payload.citations : []
  const entries = blockEntries instanceof Map ? blockEntries : new Map()
  for (const raw of rawCitations.slice(0, MAX_CITATIONS)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const index = Number.isInteger(raw.index) && raw.index > 0 ? raw.index : 0
    const blockKey = boundedString(raw.blockKey, 120).trim()
    const quote = boundedString(raw.quote, MAX_QUOTE_CHARS).trim()
    const aspect = normalizeAspect(raw.aspect)
    const note = boundedString(raw.note, MAX_NOTE_CHARS).trim()
    const base = { index, blockKey, quote, aspect, note }
    if (index === 0) {
      unverified.push({ ...base, verified: false, reason: 'invalid-index' })
      continue
    }
    if (seen.has(index)) {
      unverified.push({ ...base, verified: false, reason: 'duplicate-index' })
      continue
    }
    seen.add(index)
    if (!referenced.has(index)) {
      unverified.push({ ...base, verified: false, reason: 'index-not-in-answer' })
      continue
    }
    const entry = blockKey === '' ? undefined : entries.get(blockKey)
    if (entry === undefined) {
      unverified.push({ ...base, verified: false, reason: 'unknown-block' })
      continue
    }
    if (quote === '') {
      unverified.push({ ...base, verified: false, reason: 'empty-quote' })
      continue
    }
    const range = locateQuoteRange(entry.text, quote)
    if (range === null) {
      unverified.push({ ...base, verified: false, reason: 'quote-not-found' })
      continue
    }
    citations.push({
      index,
      blockKey,
      quote,
      start: range.start,
      end: range.end,
      page: Number.isInteger(entry.page) && entry.page > 0 ? entry.page : null,
      aspect,
      note,
      verified: true,
    })
  }
  citations.sort((left, right) => left.index - right.index)
  return { citations, unverified }
}

/** Empty entailment summary carried on the answer frame / ChatMessage. */
function emptyEntailmentSummary(checked = false) {
  return { checked, supported: 0, partial: 0, unsupported: 0 }
}

/**
 * Apply the entailment pass verdicts to one answer's validated citations.
 *
 * Contract (docs/AI-SPEC.md §5): `supported` / `partial` stay verified with the
 * verdict recorded on the citation (partial keeps its annotation, the UI warns);
 * `unsupported` is moved to `unverified` with
 * `reason:'entailment-unsupported'` and never becomes an annotation or graph
 * edge. Verdicts are matched by citation `index`; citations without a verdict
 * become `unchecked`. A null/invalid parse fails open: every citation keeps
 * `entailment:'unchecked'` and stays verified.
 *
 * @param {object[]} citations - verified citations of the answer.
 * @param {object[]} unverified - already-unverified entries of the answer.
 * @param {{ results: { index: number, verdict: string, reason?: string }[] } | null} parsed
 *   parsed entailment output, or null when the pass failed open.
 * @returns {{ citations: object[], unverified: object[], entailment: { checked: boolean,
 *   supported: number, partial: number, unsupported: number } }} applied verdicts.
 */
function applyEntailmentVerdicts(citations, unverified, parsed) {
  const verdicts = new Map()
  const checked = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.results)
  if (checked) {
    for (const entry of parsed.results) {
      if (entry === null || typeof entry !== 'object') continue
      if (verdicts.has(entry.index)) continue
      if (!ENTAILMENT_STATES.has(entry.verdict) || entry.verdict === 'unchecked') continue
      verdicts.set(entry.index, entry)
    }
  }
  const kept = []
  const moved = []
  const summary = emptyEntailmentSummary(checked)
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (citation === null || typeof citation !== 'object') continue
    const verdict = verdicts.get(citation.index)
    const state = verdict !== undefined ? verdict.verdict : 'unchecked'
    const reason = verdict !== undefined && typeof verdict.reason === 'string' ? verdict.reason.slice(0, 500).trim() : ''
    if (state === 'unsupported') {
      const entry = {
        index: citation.index,
        blockKey: citation.blockKey,
        quote: citation.quote,
        aspect: citation.aspect,
        note: citation.note,
        verified: false,
        reason: UNVERIFIED_REASON_ENTAILMENT,
        entailment: 'unsupported',
      }
      if (reason !== '') entry.entailmentReason = reason
      moved.push(entry)
      summary.unsupported += 1
      continue
    }
    const next = { ...citation, entailment: state }
    if (reason !== '') next.entailmentReason = reason
    if (state === 'supported') summary.supported += 1
    else if (state === 'partial') summary.partial += 1
    kept.push(next)
  }
  const existing = Array.isArray(unverified) ? unverified.slice() : []
  return { citations: kept, unverified: existing.concat(moved), entailment: summary }
}

/** Whether two annotation ranges overlap (zero-length ranges included). */
function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  if (leftStart === leftEnd) return rightStart <= leftStart && rightEnd >= leftStart
  if (rightStart === rightEnd) return leftStart <= rightStart && leftEnd >= rightStart
  return leftStart < rightEnd && rightStart < leftEnd
}

/**
 * Create aspect-colored AI annotations for verified citations.
 *
 * Dedupe rule (docs/AI-SPEC.md §2): an existing annotation on the same block
 * covering an overlapping range with the same aspect wins — the new one is
 * skipped, reported in `skipped` and does not consume the per-answer cap.
 * At most `config.ai.maxAnnotationsPerAnswer` (default 5) new annotations are
 * created; extra verified citations remain citations only.
 *
 * Concurrency: when `mutateAnnotations` is injected (the host store's atomic
 * read-modify-write), the whole dedupe+append+save runs inside it, so an
 * interleaved client save or agent annotation can never be overwritten. The
 * load/save fallback is kept for tests and for deployments without the store.
 *
 * @param {{
 *   documentId: string, chatId: string, messageId: string,
 *   model: { provider: string, model: string },
 *   citations: object[], maxAnnotations: number,
 *   loadAnnotations?: Function, saveAnnotations?: Function,
 *   mutateAnnotations?: Function,
 *   logger?: object,
 * }} input - turn context and verified citations.
 * @returns {Promise<{ ids: string[], skipped: number, failed: boolean }>}
 *   created annotation ids (exactly the persisted ones).
 */
async function createCitationAnnotations(input) {
  const result = { ids: [], skipped: 0, failed: false }
  if (!Array.isArray(input.citations) || input.citations.length === 0) return result
  const maxNew = clampInt(input.maxAnnotations, 0, 20, DEFAULT_MAX_ANNOTATIONS)
  const createdAt = new Date().toISOString()

  /**
   * Apply the dedupe + cap rules to one annotation list (appended in place).
   * @param {object[]} items - mutable annotation list.
   * @returns {{ version: 1, items: object[] }} payload to persist.
   */
  function apply(items) {
    result.ids = []
    result.skipped = 0
    for (const citation of input.citations) {
      if (result.ids.length >= maxNew) break
      if (citation === null || typeof citation !== 'object' || citation.verified !== true) continue
      const blockKey = boundedString(citation.blockKey, 120)
      const start = Number.isInteger(citation.start) ? Math.max(0, citation.start) : 0
      const end = Number.isInteger(citation.end) ? Math.max(start, citation.end) : start
      const aspect = normalizeAspect(citation.aspect)
      let duplicate = false
      for (const item of items) {
        if (item === null || typeof item !== 'object' || item.blockKey !== blockKey) continue
        if (normalizeAspect(item.aspect) !== aspect) continue
        const existingStart = Number.isInteger(item.start) ? item.start : 0
        const existingEnd = Number.isInteger(item.end) ? item.end : existingStart
        if (rangesOverlap(start, end, existingStart, existingEnd)) {
          duplicate = true
          break
        }
      }
      if (duplicate) {
        result.skipped += 1
        continue
      }
      const annotation = {
        id: randomUUID(),
        blockKey,
        start,
        end,
        quote: boundedString(citation.quote, 5000),
        note: (citation.note !== '' ? citation.note : citation.quote).slice(0, 2000),
        color: aspectColor(aspect),
        origin: 'ai',
        aspect,
        chatId: input.chatId,
        messageId: input.messageId,
        model: { provider: input.model.provider, model: input.model.model },
        createdAt,
      }
      items.push(annotation)
      result.ids.push(annotation.id)
    }
    return { version: 1, items }
  }

  // Preferred path: atomic read-modify-write on the document's annotation file.
  if (typeof input.mutateAnnotations === 'function') {
    try {
      const persisted = await input.mutateAnnotations(input.documentId, (current) => {
        const existing = Array.isArray(current) ? current : Array.isArray(current?.items) ? current.items : []
        return apply(existing.slice(0, MAX_STORED_ANNOTATIONS))
      })
      const persistedItems = Array.isArray(persisted?.items) ? persisted.items : []
      const persistedIds = new Set(persistedItems.map((item) => item?.id))
      result.ids = result.ids.filter((id) => persistedIds.has(id))
    } catch (error) {
      input.logger?.warn?.('[dsh-litnotes] cannot save AI annotations: %s', error?.message ?? error)
      result.ids = []
      result.failed = true
    }
    return result
  }

  // Fallback: load + whole-list save (tests / older host wiring).
  if (typeof input.saveAnnotations !== 'function') return result
  let loaded
  try {
    loaded = typeof input.loadAnnotations === 'function' ? await input.loadAnnotations(input.documentId) : null
  } catch (error) {
    // Never overwrite an annotation list we could not read: skipping AI
    // annotations is safe, losing the reader's notes is not.
    input.logger?.warn?.('[dsh-litnotes] cannot load annotations for AI highlighting: %s', error?.message ?? error)
    result.failed = true
    return result
  }
  const existing = Array.isArray(loaded) ? loaded : Array.isArray(loaded?.items) ? loaded.items : []
  const payload = apply(existing.slice(0, MAX_STORED_ANNOTATIONS))
  if (result.ids.length === 0) return result
  try {
    await input.saveAnnotations(input.documentId, payload)
  } catch (error) {
    input.logger?.warn?.('[dsh-litnotes] cannot save AI annotations: %s', error?.message ?? error)
    result.ids = []
    result.failed = true
  }
  return result
}

/** Normalize a label for graph matching (case-folded, punctuation-stripped). */
function normalizeLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normalize the optional knowledge payload into a trusted graph delta.
 *
 * Evidence rule: nodes are kept only when at least one of their blockKeys is a
 * VERIFIED citation of this answer, and edges only when both endpoints survive;
 * with no verified citations the whole delta is dropped. This is how
 * "unverified citations never create graph edges" is enforced.
 *
 * @param {object | null} knowledge - model `knowledge` payload.
 * @param {object[]} citations - verified citations of this answer.
 * @returns {{ nodes: object[], edges: object[] }} normalized delta.
 */
function normalizeKnowledge(knowledge, citations) {
  const verifiedKeys = new Set(
    (Array.isArray(citations) ? citations : [])
      .filter((citation) => citation !== null && typeof citation === 'object' && citation.verified === true)
      .map((citation) => citation.blockKey),
  )
  if (verifiedKeys.size === 0) return { nodes: [], edges: [] }
  const nodes = []
  const labels = new Set()
  const rawNodes = Array.isArray(knowledge?.nodes) ? knowledge.nodes : []
  for (const raw of rawNodes.slice(0, MAX_KNOWLEDGE_NODES)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const label = boundedString(raw.label, 80).replace(/\s+/g, ' ').trim()
    if (label === '') continue
    const type = KNOWLEDGE_NODE_TYPES.has(raw.type) ? raw.type : 'concept'
    const blockKeys = []
    if (Array.isArray(raw.blockKeys)) {
      for (const key of raw.blockKeys.slice(0, 6)) {
        if (typeof key === 'string' && verifiedKeys.has(key) && !blockKeys.includes(key)) blockKeys.push(key)
      }
    }
    if (blockKeys.length === 0) continue
    nodes.push({
      type,
      label,
      summary: boundedString(raw.summary, 500).trim(),
      blockKeys,
      aspect: normalizeAspect(raw.aspect),
      source: 'qa',
    })
    labels.add(normalizeLabel(label))
  }
  const edges = []
  const rawEdges = Array.isArray(knowledge?.edges) ? knowledge.edges : []
  for (const raw of rawEdges.slice(0, MAX_KNOWLEDGE_EDGES)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const fromKey = normalizeLabel(raw.from)
    const toKey = normalizeLabel(raw.to)
    if (fromKey === '' || toKey === '' || fromKey === toKey) continue
    if (!labels.has(fromKey) || !labels.has(toKey)) continue
    const type = KNOWLEDGE_EDGE_TYPES.has(raw.type) ? raw.type : 'relates'
    const edge = { from: boundedString(raw.from, 80).trim(), to: boundedString(raw.to, 80).trim(), type, source: 'qa' }
    const label = boundedString(raw.label, 120).trim()
    if (label !== '') edge.label = label
    edges.push(edge)
  }
  return { nodes, edges }
}

/** Extract created graph ids from a merge result (best effort, bounded). */
function knowledgeIds(result, delta) {
  const out = { nodeIds: [], edgeIds: [] }
  if (result === null || typeof result !== 'object') return out
  if (Array.isArray(result.nodeIds)) {
    out.nodeIds = result.nodeIds.filter((id) => typeof id === 'string').slice(0, MAX_KNOWLEDGE_IDS)
  }
  if (Array.isArray(result.edgeIds)) {
    out.edgeIds = result.edgeIds.filter((id) => typeof id === 'string').slice(0, MAX_KNOWLEDGE_IDS)
  }
  if (out.nodeIds.length === 0 && Array.isArray(result.nodes)) {
    const wanted = new Map()
    for (const node of delta?.nodes ?? []) wanted.set(normalizeLabel(node.label), node.label)
    for (const node of result.nodes) {
      if (node === null || typeof node !== 'object' || typeof node.id !== 'string') continue
      const label = normalizeLabel(node.label)
      if (wanted.has(label)) out.nodeIds.push(node.id)
    }
    out.nodeIds = out.nodeIds.slice(0, MAX_KNOWLEDGE_IDS)
  }
  if (out.edgeIds.length === 0 && out.nodeIds.length > 0 && Array.isArray(result.edges)) {
    const ids = new Set(out.nodeIds)
    for (const edge of result.edges) {
      if (edge === null || typeof edge !== 'object' || typeof edge.id !== 'string') continue
      if (ids.has(edge.from) && ids.has(edge.to)) out.edgeIds.push(edge.id)
    }
    out.edgeIds = out.edgeIds.slice(0, MAX_KNOWLEDGE_IDS)
  }
  return out
}

/** Keep only valid, deduplicated follow-up questions. */
function sanitizeFollowups(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const value of raw.slice(0, MAX_FOLLOWUPS * 2)) {
    if (typeof value !== 'string') continue
    const question = value.trim().slice(0, 200)
    if (question === '' || out.includes(question)) continue
    out.push(question)
    if (out.length >= MAX_FOLLOWUPS) break
  }
  return out
}

/** Normalize one persisted citation entailment state (`undefined` when absent/invalid). */
function normalizeEntailmentState(value) {
  return typeof value === 'string' && ENTAILMENT_STATES.has(value) ? value : undefined
}

/** Normalize the persisted entailment summary of one assistant message. */
function normalizeEntailmentSummary(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return {
    checked: raw.checked === true,
    supported: clampInt(raw.supported, 0, MAX_CITATIONS, 0),
    partial: clampInt(raw.partial, 0, MAX_CITATIONS, 0),
    unsupported: clampInt(raw.unsupported, 0, MAX_CITATIONS, 0),
  }
}

/** Normalize one persisted ChatMessage (defensive history read). */
function normalizeMessage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null
  if (role === null) return null
  const message = {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : randomUUID(),
    role,
    question: boundedString(raw.question, MAX_QUESTION_CHARS),
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt !== '' ? raw.createdAt : new Date().toISOString(),
  }
  if (Number.isInteger(raw.promptVersion)) message.promptVersion = raw.promptVersion
  if (role === 'assistant') {
    message.answer = boundedString(raw.answer, MAX_ANSWER_CHARS)
    const citations = []
    for (const citation of Array.isArray(raw.citations) ? raw.citations.slice(0, MAX_CITATIONS) : []) {
      if (citation === null || typeof citation !== 'object') continue
      const entry = {
        index: Number.isInteger(citation.index) ? citation.index : 0,
        blockKey: boundedString(citation.blockKey, 120),
        quote: boundedString(citation.quote, MAX_QUOTE_CHARS),
        start: Number.isInteger(citation.start) ? citation.start : 0,
        end: Number.isInteger(citation.end) ? citation.end : 0,
        page: Number.isInteger(citation.page) ? citation.page : null,
        aspect: normalizeAspect(citation.aspect),
        note: boundedString(citation.note, MAX_NOTE_CHARS),
        verified: citation.verified !== false,
      }
      // Citation–claim entailment second pass (docs/AI-SPEC.md §5).
      const entailment = normalizeEntailmentState(citation.entailment)
      if (entailment !== undefined) entry.entailment = entailment
      const entailmentReason = boundedString(citation.entailmentReason, 500).trim()
      if (entailmentReason !== '') entry.entailmentReason = entailmentReason
      citations.push(entry)
    }
    message.citations = citations
    const unverified = []
    for (const citation of Array.isArray(raw.unverified) ? raw.unverified.slice(0, MAX_CITATIONS) : []) {
      if (citation === null || typeof citation !== 'object') continue
      const entry = {
        index: Number.isInteger(citation.index) ? citation.index : 0,
        blockKey: boundedString(citation.blockKey, 120),
        quote: boundedString(citation.quote, MAX_QUOTE_CHARS),
        aspect: normalizeAspect(citation.aspect),
        note: boundedString(citation.note, MAX_NOTE_CHARS),
        verified: false,
      }
      const reason = boundedString(citation.reason, 80).trim()
      if (reason !== '') entry.reason = reason
      const entailment = normalizeEntailmentState(citation.entailment)
      if (entailment !== undefined) entry.entailment = entailment
      const entailmentReason = boundedString(citation.entailmentReason, 500).trim()
      if (entailmentReason !== '') entry.entailmentReason = entailmentReason
      unverified.push(entry)
    }
    message.unverified = unverified
    message.followups = sanitizeFollowups(raw.followups)
    if (raw.model !== null && typeof raw.model === 'object') {
      message.model = {
        provider: boundedString(raw.model.provider, 100),
        model: boundedString(raw.model.model, 100),
      }
    }
    const usage = raw.usage !== null && typeof raw.usage === 'object' ? raw.usage : {}
    message.usage = {
      inputTokens: clampInt(usage.inputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
      outputTokens: clampInt(usage.outputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    }
    message.annotationIds = Array.isArray(raw.annotationIds)
      ? raw.annotationIds.filter((id) => typeof id === 'string').slice(0, 100)
      : []
    const knowledge = raw.knowledge !== null && typeof raw.knowledge === 'object' ? raw.knowledge : {}
    message.knowledge = {
      nodeIds: Array.isArray(knowledge.nodeIds) ? knowledge.nodeIds.filter((id) => typeof id === 'string').slice(0, 40) : [],
      edgeIds: Array.isArray(knowledge.edgeIds) ? knowledge.edgeIds.filter((id) => typeof id === 'string').slice(0, 40) : [],
    }
    const entailment = normalizeEntailmentSummary(raw.entailment)
    if (entailment !== undefined) message.entailment = entailment
  }
  return message
}

/** Normalize the persisted chat file shape. */
function normalizeChatFile(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, messages: [] }
  const messages = []
  for (const item of Array.isArray(raw.messages) ? raw.messages : []) {
    const message = normalizeMessage(item)
    if (message !== null) messages.push(message)
    if (messages.length >= MAX_CHAT_MESSAGES) break
  }
  return { version: 1, messages }
}

/**
 * Create the grounded chat service.
 *
 * @param {{
 *   llm: { available?: Function, route?: Function, streamText: Function, completeText?: Function },
 *   retriever: { context: Function, blocks?: Function, buildIndex?: Function },
 *   store: object,
 *   config?: { ai?: { maxContextChars?: number, historyTurns?: number,
 *                     answerMaxTokens?: number, maxAnnotationsPerAnswer?: number,
 *                     reasoningEffort?: 'off'|'low'|'high'|'max' } },
 *   logger?: { debug?: Function, warn?: Function, error?: Function },
 *   loadAnnotations?: (documentId: string) => Promise<object[] | { items: object[] }>,
 *   saveAnnotations?: (documentId: string, data: object) => Promise<unknown>,
 *   mutateAnnotations?: (documentId: string, mutate: Function) => Promise<{ version: 1, items: object[] }>,
 *   mutateAux?: (documentId: string, name: string, mutate: Function) => Promise<unknown>,
 *   onGraphDelta?: (documentId: string, delta: object) => Promise<unknown>,
 * }} dependencies - engine dependencies (docs/AI-SPEC.md §3). When the atomic
 *   `mutateAnnotations` / `mutateAux` store helpers are injected the engine uses
 *   them for AI annotation creation and chat-turn persistence (concurrency
 *   safe); the load/save and readAux/writeAux fallbacks remain for tests.
 * @returns {{
 *   history(documentId: string): Promise<object[]>,
 *   clear(documentId: string): Promise<{ cleared: true }>,
 *   stream(request: object, options?: { signal?: AbortSignal }): AsyncGenerator<object>,
 *   available(): boolean,
 *   route(): { provider: string, model: string } | null,
 * }} the chat service facade.
 */
export function createChatService({
  llm,
  retriever,
  store,
  config,
  logger,
  loadAnnotations,
  saveAnnotations,
  mutateAnnotations,
  mutateAux,
  onGraphDelta,
} = {}) {
  if (llm === null || typeof llm !== 'object' || typeof llm.streamText !== 'function') {
    throw new TypeError('createChatService: an llm gateway is required')
  }
  if (retriever === null || typeof retriever !== 'object' || typeof retriever.context !== 'function') {
    throw new TypeError('createChatService: a retriever is required')
  }
  const log = logger ?? {}

  /** Resolved `ai` config block with the documented defaults. */
  function aiConfig() {
    const ai = config !== null && typeof config === 'object' && config.ai !== null && typeof config.ai === 'object'
      ? config.ai
      : {}
    return {
      maxContextChars: clampInt(ai.maxContextChars, 500, 64000, 9000),
      historyTurns: clampInt(ai.historyTurns, 0, 20, 6),
      answerMaxTokens: clampInt(ai.answerMaxTokens, 256, 16384, 4096),
      maxAnnotationsPerAnswer: clampInt(ai.maxAnnotationsPerAnswer, 0, 20, DEFAULT_MAX_ANNOTATIONS),
      // Citation–claim entailment second pass (docs/AI-SPEC.md §5): on by
      // default; a cheap, bounded classification call.
      entailmentCheck: ai.entailmentCheck !== false,
      entailmentMaxTokens: clampInt(ai.entailmentMaxTokens, 64, 4096, DEFAULT_ENTAILMENT_MAX_TOKENS),
      // Grounded reading calls always pin a reasoning effort: the adapter's
      // default "high" spends the completion budget on reasoning tokens and can
      // produce an empty visible answer.
      reasoningEffort: ['off', 'low', 'high', 'max'].includes(ai.reasoningEffort) ? ai.reasoningEffort : 'low',
    }
  }

  /** Whether the gateway has a usable route + host service. */
  function available() {
    if (typeof llm.available === 'function') {
      try {
        return llm.available() === true
      } catch {
        return false
      }
    }
    return true
  }

  /** Resolved model route, or null. */
  function route() {
    if (typeof llm.route !== 'function') return null
    try {
      const value = llm.route()
      if (value === null || typeof value !== 'object') return null
      const provider = typeof value.provider === 'string' ? value.provider : ''
      const model = typeof value.model === 'string' ? value.model : ''
      return provider === '' || model === '' ? null : { provider, model }
    } catch {
      return null
    }
  }

  /** Validate a document id from an HTTP payload. */
  function requireDocumentId(value) {
    const documentId = typeof value === 'string' ? value.trim() : ''
    if (documentId === '' || documentId.length > 200) {
      throw new AiError('bad-request', '缺少文档 ID（Missing documentId）')
    }
    return documentId
  }

  /** Validate + bound the question. */
  function normalizeQuestion(value) {
    const question = typeof value === 'string' ? value.trim() : ''
    if (question === '') throw new AiError('bad-request', '问题不能为空（The question must not be empty）')
    return question.slice(0, MAX_QUESTION_CHARS)
  }

  /** Normalize the optional reading focus from the client. */
  function normalizeFocus(focus) {
    if (focus === null || typeof focus !== 'object' || Array.isArray(focus)) return null
    const blockKey = typeof focus.blockKey === 'string' ? focus.blockKey.trim() : ''
    const selectionQuote = typeof focus.selectionQuote === 'string' ? focus.selectionQuote.trim() : ''
    if (blockKey === '' && selectionQuote === '') return null
    const safeKey = /^b\d+:[0-9a-f]{8}$/.test(blockKey) ? blockKey : ''
    return { blockKey: safeKey, selectionQuote: selectionQuote.slice(0, 2000) }
  }

  /** Read the parsed document via the store. */
  async function readDocument(documentId) {
    if (store === null || typeof store !== 'object' || typeof store.readMarkdown !== 'function') {
      throw new AiError('bad-request', '文档存储不可用（Document store unavailable）')
    }
    const parsed = await store.readMarkdown(documentId)
    return {
      markdown: parsed !== null && typeof parsed === 'object' && typeof parsed.markdown === 'string' ? parsed.markdown : '',
      contentList:
        parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.contentList) ? parsed.contentList : null,
    }
  }

  /** Document title for the prompt (best effort). */
  function readTitle(documentId) {
    if (store === null || typeof store !== 'object' || typeof store.get !== 'function') return ''
    try {
      const meta = store.get(documentId)
      return typeof meta?.title === 'string' ? meta.title.slice(0, 300) : ''
    } catch {
      return ''
    }
  }

  /** Read + normalize `chat.json`; a missing/corrupt file reads empty. */
  async function readChat(documentId) {
    if (store === null || typeof store !== 'object' || typeof store.readAux !== 'function') {
      return { version: 1, messages: [] }
    }
    try {
      return normalizeChatFile(await store.readAux(documentId, CHAT_FILE))
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot read chat history: %s', error?.message ?? error)
      return { version: 1, messages: [] }
    }
  }

  /** Persist `chat.json` (atomic, store-serialized); returns whether it wrote. */
  async function writeChat(documentId, messages) {
    if (store === null || typeof store !== 'object' || typeof store.writeAux !== 'function') return false
    const bounded = Array.isArray(messages) ? messages.slice(-MAX_CHAT_MESSAGES) : []
    try {
      await store.writeAux(documentId, CHAT_FILE, { version: 1, messages: bounded })
      return true
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot persist chat history: %s', error?.message ?? error)
      return false
    }
  }

  /** Previous turns for the prompt, newest last, bounded by `historyTurns`. */
  function promptHistory(messages, turns, excludeMessageId) {
    if (turns <= 0) return []
    const pairs = []
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message === null || typeof message !== 'object') continue
      if (message.role !== 'assistant') continue
      if (typeof excludeMessageId === 'string' && message.id === excludeMessageId) continue
      const answer = typeof message.answer === 'string' ? message.answer.trim() : ''
      if (answer === '') continue
      pairs.push({
        question: typeof message.question === 'string' ? message.question.slice(0, 500) : '',
        answer: answer.slice(0, 1200),
      })
    }
    return pairs.slice(-turns)
  }

  /** Load all parser blocks for citation validation. */
  function documentBlocks(documentId, markdown, contentList) {
    const input = { documentId, markdown, contentList }
    try {
      if (typeof retriever.blocks === 'function') return retriever.blocks(input)
      if (typeof retriever.buildIndex === 'function') return retriever.buildIndex(input).blocks ?? []
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot build block index for citation checks: %s', error?.message ?? error)
    }
    return []
  }

  /**
   * Append one completed turn to a normalized chat file and bound the result.
   * @param {{ version: 1, messages: object[] }} file - current chat file.
   * @param {object} turn - completed turn data.
   * @returns {{ version: 1, messages: object[] }} next chat file.
   */
  function appendTurn(file, turn) {
    const messages = Array.isArray(file?.messages) ? file.messages.slice() : []
    const userMessage = {
      id: turn.userMessageId,
      role: 'user',
      question: turn.question,
      promptVersion: PROMPT_VERSION,
      createdAt: turn.createdAt,
    }
    const assistantMessage = {
      id: turn.messageId,
      role: 'assistant',
      question: turn.question,
      answer: turn.answer,
      citations: turn.citations,
      unverified: turn.unverified,
      entailment: turn.entailment,
      followups: turn.followups,
      model: turn.model,
      usage: turn.usage,
      annotationIds: turn.annotationIds,
      knowledge: turn.knowledge,
      promptVersion: PROMPT_VERSION,
      createdAt: turn.createdAt,
    }
    if (typeof turn.regenerateOf === 'string' && turn.regenerateOf !== '') {
      const index = messages.findIndex((message) => message !== null && typeof message === 'object' && message.id === turn.regenerateOf)
      if (index !== -1) messages[index] = assistantMessage
      else messages.push(userMessage, assistantMessage)
    } else {
      messages.push(userMessage, assistantMessage)
    }
    return { version: 1, messages: messages.slice(-MAX_CHAT_MESSAGES) }
  }

  /**
   * Persist one completed turn (user + assistant messages).
   *
   * Uses the injected atomic `mutateAux` when available so two concurrent
   * turns (or one turn plus `clear()`) never overwrite each other's history;
   * falls back to read + whole-file write for tests and older host wiring.
   *
   * @param {object} turn - completed turn data.
   * @returns {Promise<boolean>} whether the turn was persisted.
   */
  async function persistTurn(turn) {
    if (typeof mutateAux === 'function') {
      try {
        const written = await mutateAux(turn.documentId, CHAT_FILE, (current) =>
          appendTurn(normalizeChatFile(current), turn),
        )
        return written !== undefined
      } catch (error) {
        log.warn?.('[dsh-litnotes] cannot persist chat history: %s', error?.message ?? error)
        return false
      }
    }
    const file = await readChat(turn.documentId)
    return writeChat(turn.documentId, appendTurn(file, turn).messages)
  }

  /**
   * Run one citation–claim entailment call and parse its verdicts.
   *
   * Fail-open by design: a model error, unavailable route, invalid output or
   * parse failure resolves null (the turn keeps its verified citations as
   * `unchecked`). A consumer abort always rethrows so the whole HTTP turn
   * aborts and nothing is persisted.
   *
   * @param {{ citations: object[], maxTokens: number, signal?: AbortSignal }} input
   *   verified citations and the token budget of the classification call.
   * @returns {Promise<object | null>} parsed verdicts or null (fail-open).
   */
  async function runEntailmentCheck({ citations, maxTokens, signal }) {
    try {
      const raw = await llm.completeText({
        system: ENTAILMENT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: entailmentPrompt(citations) }] }],
        signal,
        maxTokens,
        temperature: 0,
        reasoningEffort: 'off',
        purpose: 'entailment',
        maxChars: 20000,
      })
      return parseEntailmentOutput(raw)
    } catch (error) {
      if (signal?.aborted === true || error?.code === 'aborted' || error?.name === 'AbortError') {
        throw error instanceof AiError ? error : new AiError('aborted', '已停止（Aborted）')
      }
      log.warn?.('[dsh-litnotes] citation entailment check failed open: %s', error?.message ?? error)
      return null
    }
  }

  /** Map any thrown value to one public error frame (never leaks prompt text). */
  function errorFrame(error) {
    if (error instanceof AiError) {
      return { type: 'error', code: error.code, message: error.message }
    }
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'host-error'
    if (typeof error?.code === 'string' && error.code !== '') {
      // WireError/parser errors carry a user-safe bilingual message.
      return {
        type: 'error',
        code,
        message: typeof error?.message === 'string' && error.message !== '' ? error.message.slice(0, 500) : '请求失败（Request failed）',
      }
    }
    log.warn?.('[dsh-litnotes] chat turn failed: %s', error?.stack ?? error?.message ?? error)
    return { type: 'error', code, message: 'AI 服务内部错误（AI service error）' }
  }

  /**
   * Read the persisted conversation for one document.
   * @param {string} documentId - document id.
   * @returns {Promise<object[]>} ChatMessage[] oldest first.
   */
  async function history(documentId) {
    const docId = requireDocumentId(documentId)
    const file = await readChat(docId)
    return file.messages
  }

  /**
   * Clear the conversation for one document.
   * @param {string} documentId - document id.
   * @returns {Promise<{ cleared: true }>} acknowledgement.
   */
  async function clear(documentId) {
    const docId = requireDocumentId(documentId)
    await writeChat(docId, [])
    return { cleared: true }
  }

  /**
   * Stream one grounded answer as NDJSON frame objects.
   *
   * The generator never throws: expected failures (no model, model failure,
   * abort, unparsed document, bad request) are yielded as `{ type:'error' }`
   * frames so the HTTP route can keep writing after headers.
   *
   * @param {{
   *   documentId: string, question: string,
   *   focus?: { blockKey?: string, selectionQuote?: string },
   *   mode?: 'doc', regenerateOf?: string, signal?: AbortSignal,
   * }} request - client request (docs/AI-SPEC.md §3).
   * @param {{ signal?: AbortSignal }} [options] - per-call override for the abort signal.
   * @returns {AsyncGenerator<object>} NDJSON frame objects.
   */
  async function* stream(request = {}, options = {}) {
    const signal = options?.signal ?? request?.signal
    try {
      const documentId = requireDocumentId(request?.documentId)
      const question = normalizeQuestion(request?.question)
      const mode = typeof request?.mode === 'string' && request.mode !== '' ? request.mode : 'doc'
      if (mode !== 'doc') {
        throw new AiError('bad-request', '整库问答暂未开放（Library-wide Q&A is not available yet）')
      }
      if (signal !== null && signal !== undefined && signal.aborted === true) {
        throw new AiError('aborted', '已停止（Aborted）')
      }
      if (!available()) {
        throw new AiError('llm-unavailable', '当前配置没有可用的语言模型（No LLM route available）')
      }
      const modelRoute = route()
      if (modelRoute === null) {
        throw new AiError('llm-unavailable', '当前配置没有可用的语言模型（No LLM route available）')
      }
      const ai = aiConfig()
      const focus = normalizeFocus(request?.focus)
      const regenerateOf = typeof request?.regenerateOf === 'string' ? request.regenerateOf.trim().slice(0, 200) : ''

      const [parsed, chatFile] = await Promise.all([readDocument(documentId), readChat(documentId)])
      if (signal?.aborted === true) throw new AiError('aborted', '已停止（Aborted）')
      if (parsed.markdown.trim() === '') {
        throw new AiError('bad-request', '文档没有可读取的正文（The document has no parsed text）')
      }
      const context = retriever.context({
        documentId,
        markdown: parsed.markdown,
        contentList: parsed.contentList,
        question,
        focusBlockKey: focus?.blockKey ?? '',
        selection: focus !== null && focus.selectionQuote !== '' ? { blockKey: focus.blockKey, quote: focus.selectionQuote } : undefined,
        budgetChars: ai.maxContextChars,
      })
      if (context === null || typeof context !== 'object' || !Array.isArray(context.blocks) || context.blocks.length === 0) {
        throw new AiError('bad-request', '文档没有可检索的正文块（The document has no retrievable text blocks）')
      }
      const historyTurns = promptHistory(chatFile.messages, ai.historyTurns, regenerateOf)
      const messageId = randomUUID()
      const userMessageId = randomUUID()
      const createdAt = new Date().toISOString()
      const chatId = `doc:${documentId}`

      // 1) start
      yield { type: 'start', messageId, model: { provider: modelRoute.provider, model: modelRoute.model } }

      // 2) stream the model, holding back the trailing JSON fence.
      const userPrompt = chatUserPrompt(context, question, historyTurns, {
        title: readTitle(documentId),
        focusBlockKey: focus?.blockKey ?? '',
        selectionQuote: focus?.selectionQuote ?? '',
      })
      const marker = ANSWER_FENCE_OPEN.toLowerCase()
      const iterator = llm.streamText({
        system: CHAT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        signal,
        maxTokens: ai.answerMaxTokens,
        temperature: 0.2,
        reasoningEffort: ai.reasoningEffort,
        purpose: 'chat',
      })
      let rawText = ''
      let fenceSeen = false
      let pending = ''
      let streamedText = ''
      let usage = null
      for await (const chunk of iterator) {
        if (signal?.aborted === true) throw new AiError('aborted', '已停止（Aborted）')
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          rawText += chunk.text
          if (!fenceSeen) {
            pending += chunk.text
            const fenceAt = pending.toLowerCase().indexOf(marker)
            if (fenceAt !== -1) {
              const visible = pending.slice(0, fenceAt)
              if (visible !== '') {
                streamedText += visible
                yield { type: 'delta', text: visible }
              }
              fenceSeen = true
              pending = ''
            } else {
              // Hold back at most the fence-marker length so a delimiter split
              // across chunks is never shown to the reader.
              const keep = Math.min(marker.length, pending.length)
              const visible = pending.slice(0, pending.length - keep)
              if (visible !== '') {
                streamedText += visible
                yield { type: 'delta', text: visible }
              }
              pending = pending.slice(pending.length - keep)
            }
          }
          if (rawText.length > MAX_RAW_OUTPUT_CHARS) break
        } else if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
          usage = {
            inputTokens: clampInt(chunk.usage.inputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
            outputTokens: clampInt(chunk.usage.outputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
          }
        }
        // finish reasons are informational here.
      }
      if (!fenceSeen && pending !== '') {
        streamedText += pending
        yield { type: 'delta', text: pending }
        pending = ''
      }
      if (signal?.aborted === true) throw new AiError('aborted', '已停止（Aborted）')
      // A completion budget consumed entirely by reasoning (or an empty model
      // response) must surface as an error, never as an empty answer bubble.
      if (streamedText.trim() === '') {
        throw new AiError(
          'ai-failed',
          'AI 未生成可见回答（推理可能占用了输出预算）；请重试或调高 ai.answerMaxTokens / 降低 ai.reasoningEffort。'
            + '（AI produced no visible answer; retry or raise ai.answerMaxTokens / lower ai.reasoningEffort.）',
        )
      }

      // 3) validate citations, build knowledge, create annotations.
      const split = splitModelOutput(rawText)
      const answerMarkdown = split.answer.slice(0, MAX_ANSWER_CHARS)
      const blocks = documentBlocks(documentId, parsed.markdown, parsed.contentList)
      const blockEntries = new Map()
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && typeof block.key === 'string' && block.key !== '') {
          blockEntries.set(block.key, block)
        }
      }
      const validated = validateCitations({ payload: split.payload, answer: answerMarkdown, blockEntries })
      const followups = sanitizeFollowups(split.payload?.followups)
      const model = { provider: modelRoute.provider, model: modelRoute.model }
      const usageInfo = usage ?? { inputTokens: 0, outputTokens: 0 }

      // 4) citation–claim entailment second pass: one cheap bounded call over
      // the verified citations. Quote containment proves provenance, not
      // entailment; unsupported evidence is dropped from annotations + graph.
      // Any non-abort model failure fails open to `unchecked`.
      let entailment = emptyEntailmentSummary(false)
      if (ai.entailmentCheck && validated.citations.length > 0 && typeof llm.completeText === 'function') {
        yield { type: 'phase', phase: 'entailment' }
        const parsed = await runEntailmentCheck({
          citations: validated.citations,
          maxTokens: ai.entailmentMaxTokens,
          signal,
        })
        if (signal?.aborted === true) throw new AiError('aborted', '已停止（Aborted）')
        const applied = applyEntailmentVerdicts(validated.citations, validated.unverified, parsed)
        validated.citations = applied.citations
        validated.unverified = applied.unverified
        entailment = applied.entailment
      }
      if (signal?.aborted === true) throw new AiError('aborted', '已停止（Aborted）')
      const knowledgeDelta = normalizeKnowledge(split.payload?.knowledge, validated.citations)
      const annotations = await createCitationAnnotations({
        documentId,
        chatId,
        messageId,
        model,
        citations: validated.citations,
        maxAnnotations: ai.maxAnnotationsPerAnswer,
        loadAnnotations,
        saveAnnotations,
        mutateAnnotations,
        logger: log,
      })

      // 5) optional knowledge-graph delta (verified evidence only).
      let graphFrame = null
      let knowledge = { nodeIds: [], edgeIds: [] }
      if (knowledgeDelta.nodes.length > 0 || knowledgeDelta.edges.length > 0) {
        graphFrame = { nodes: knowledgeDelta.nodes, edges: knowledgeDelta.edges }
        if (typeof onGraphDelta === 'function') {
          try {
            const result = await onGraphDelta(documentId, {
              ...knowledgeDelta,
              question,
              messageId,
              model,
            })
            knowledge = knowledgeIds(result, knowledgeDelta)
          } catch (error) {
            log.warn?.('[dsh-litnotes] cannot merge Q&A knowledge into the graph: %s', error?.message ?? error)
          }
        }
      }

      // 6) persist the turn (best effort: an answer is still delivered).
      try {
        await persistTurn({
          documentId,
          question,
          messageId,
          userMessageId,
          createdAt,
          regenerateOf,
          answer: answerMarkdown,
          citations: validated.citations,
          unverified: validated.unverified,
          entailment,
          followups,
          model,
          usage: usageInfo,
          annotationIds: annotations.ids,
          knowledge,
        })
      } catch (error) {
        log.warn?.('[dsh-litnotes] cannot persist chat turn: %s', error?.message ?? error)
      }

      // 7) answer / graph / usage / done frames.
      yield {
        type: 'answer',
        messageId,
        markdown: answerMarkdown,
        citations: validated.citations,
        unverified: validated.unverified,
        entailment,
        followups,
        annotationIds: annotations.ids,
      }
      if (graphFrame !== null) yield { type: 'graph', delta: graphFrame }
      if (usage !== null) yield { type: 'usage', usage: usageInfo }
      yield { type: 'done' }
    } catch (error) {
      yield errorFrame(error)
    }
  }

  return { history, clear, stream, available, route }
}
