/**
 * Grounded reading conversation for dsh-litnotes (`docs/AI-SPEC.md` §3/§4/§5).
 *
 * One turn: load history → retrieve a bounded context window from the shared
 * reader-parser blocks → ask the model for a Markdown answer plus the trailing
 * ```litnotes-json block → stream the answer while holding the JSON fence back
 * → verify every citation against the block text (shared anchor rules:
 * whitespace-normalized substring, ≥20-char prefix fallback, offsets computed
 * against `plainText`) → one citation–claim entailment pass over the verified
 * citations (supported / partial / unsupported; unsupported evidence is moved
 * to `unverified`) → turn surviving citations into aspect-colored AI annotations
 * (deduped through the shared overlap rule, capped) → persist the ChatMessage
 * pair to `chat.json` → optional knowledge-graph delta. Every failure after the
 * stream starts is emitted as an error frame; aborts never persist a half turn
 * and never touch user annotations.
 *
 * Frames (exact objects from `docs/AI-SPEC.md` §4):
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
 * @module host/ai/chat
 */

import { randomUUID } from 'node:crypto'
import { aspectColor, normalizeAspect } from './aspects.ts'
import { AiError, type LlmCompleteRequest, type LlmStreamRequest } from './llm.ts'
import {
  ANSWER_FENCE_OPEN,
  CHAT_SYSTEM,
  ENTAILMENT_SYSTEM,
  PROMPT_VERSION,
  chatUserPrompt,
  entailmentPrompt,
  parseEntailmentOutput,
  type ParsedEntailmentOutput,
} from './prompts.ts'
import { findDuplicateAnnotation, locateQuote } from '../../shared/annotate/anchors.ts'
import type {
  AnnotationEnvelope,
  ChatFrame,
  GraphEdgeInput,
  GraphNodeInput,
  ChatMessage,
  ChatRequest,
  Citation,
  DocumentMeta,
  EntailmentSummary,
  KnowledgeDelta,
  ParsedDocument,
} from '../../shared/model.ts'
import type { Annotation } from '../../shared/model.ts'
import type { AnnotationColor, Aspect } from '../../shared/constants.ts'
import type { AiConfig, AiStreamChunk, ChatServiceApi } from '../contracts.ts'
import type { Logger } from '../host-services.ts'
import type { IndexedBlock, RetrieverContextInput, RetrieverInput } from './retrieval.ts'

/** Aux JSON file holding one document's conversation (`docs/AI-SPEC.md` §2). */
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
/** Annotation default cap per answer (`ai.maxAnnotationsPerAnswer`). */
const DEFAULT_MAX_ANNOTATIONS = 5
/** Default completion budget for the citation–claim entailment pass. */
const DEFAULT_ENTAILMENT_MAX_TOKENS = 600
/** Entailment states persisted on citations (`docs/AI-SPEC.md` §2). */
const ENTAILMENT_STATES: ReadonlySet<string> = new Set(['supported', 'partial', 'unsupported', 'unchecked'])
/** Unverified reason assigned to citations the entailment pass rejects. */
const UNVERIFIED_REASON_ENTAILMENT = 'entailment-unsupported'
/** Maximum annotations stored per document (mirrors the store cap). */
const MAX_STORED_ANNOTATIONS = 5000
/** Maximum number of `[n]` markers scanned in one answer. */
const MAX_MARKERS = 4000
/** Bound for graph ids collected from a merge result. */
const MAX_KNOWLEDGE_IDS = 40

/** Node types accepted in Q&A knowledge deltas. */
const KNOWLEDGE_NODE_TYPES: ReadonlySet<string> = new Set([
  'concept', 'method', 'finding', 'definition', 'limitation', 'section', 'question', 'insight',
  'paper', 'topic',
])
/** Edge types accepted in Q&A knowledge deltas. */
const KNOWLEDGE_EDGE_TYPES: ReadonlySet<string> = new Set([
  'defines', 'uses', 'supports', 'contradicts', 'part_of', 'leads_to', 'evolves_from', 'relates',
  'answers', 'mentions',
])

/** Shared lexical helpers re-exported for callers/tests (single implementation). */
export { normalizeQuoteText, locateQuote, locateQuoteRange } from '../../shared/annotate/anchors.ts'

/** A verified citation with the host-computed extras the wire format allows. */
export interface VerifiedCitation extends Citation {
  /** One-line verdict reason from the entailment pass (frozen wire extra). */
  entailmentReason?: string
}

/**
 * An unverified citation (invalid/duplicate/dangling/unsupported evidence).
 *
 * The frozen wire shape intentionally carries NO `start`/`end`/`page` on these
 * entries (they never anchor to the page); the shared `Citation` type requires
 * them, so the engine casts only at the wire/persistence boundary.
 */
export interface UnverifiedCitation {
  index: number
  blockKey: string
  quote: string
  aspect: Aspect
  note: string
  verified: false
  reason?: string
  entailment?: Citation['entailment']
  entailmentReason?: string
}

/** A persisted AI annotation record (the frozen 1.0.0 on-disk shape). */
type AiAnnotation = Annotation

/** A knowledge-delta node with the provenance tag the wire frame carries. */
type KnowledgeNodeDelta = GraphNodeInput & { source?: KnowledgeDeltaSource }
/** A knowledge-delta edge with the provenance tag the wire frame carries. */
type KnowledgeEdgeDelta = GraphEdgeInput & { source?: KnowledgeDeltaSource }
/** Provenance tag of Q&A-derived graph knowledge. */
type KnowledgeDeltaSource = 'qa'

/** The LLM gateway surface the chat engine consumes. */
export interface ChatLlmApi {
  available?: (() => boolean) | undefined
  route?: (() => unknown) | undefined
  streamText: (request: LlmStreamRequest) => AsyncGenerator<AiStreamChunk>
  completeText?: ((request: LlmCompleteRequest) => Promise<string>) | undefined
}

/** The retriever surface the chat engine consumes (bounds: block list + context). */
export interface ChatRetrieverApi {
  context: (input: RetrieverContextInput) => {
    blocks: Array<{ key: string; page: number | null; index: number; text: string; kind: string; score: number; section: string | null }>
    outline: Array<{ key: string; level: number; text: string }>
    sections: string[]
    usedChars: number
    totalBlocks: number
  }
  blocks?: ((input: RetrieverInput) => readonly IndexedBlock[]) | undefined
  buildIndex?: ((input: RetrieverInput) => { blocks?: readonly IndexedBlock[] }) | undefined
}

/** The store surface the chat engine consumes. */
export interface ChatStoreApi {
  readMarkdown?: ((documentId: string) => Promise<ParsedDocument>) | undefined
  get?: ((documentId: string) => DocumentMeta | undefined) | undefined
  readAux?: ((documentId: string, name: 'chat.json') => Promise<unknown>) | undefined
  writeAux?: ((documentId: string, name: 'chat.json', value: unknown) => Promise<void>) | undefined
  loadAnnotations?: ((documentId: string) => Promise<AnnotationEnvelope>) | undefined
  saveAnnotations?:
    | ((documentId: string, data: { items?: Annotation[]; baseIds?: string[] }) => Promise<AnnotationEnvelope>)
    | undefined
}

/** Dependencies of {@link createChatService}. */
export interface ChatServiceDeps {
  llm: ChatLlmApi
  retriever: ChatRetrieverApi
  store?: ChatStoreApi | undefined
  config?: { ai?: Partial<AiConfig> | undefined } | undefined
  logger?: Logger | undefined
  loadAnnotations?: ((documentId: string) => Promise<AnnotationEnvelope>) | undefined
  saveAnnotations?:
    | ((documentId: string, data: { items?: Annotation[]; baseIds?: string[] }) => Promise<AnnotationEnvelope>)
    | undefined
  mutateAnnotations?:
    | ((
        documentId: string,
        mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>,
      ) => Promise<AnnotationEnvelope>)
    | undefined
  mutateAux?:
    | (<T>(documentId: string, name: 'chat.json', mutate: (current: T | undefined) => T | Promise<T>) => Promise<T | undefined>)
    | undefined
  onGraphDelta?:
    | ((
        documentId: string,
        delta: KnowledgeDelta & { question: string; messageId: string; model: { provider: string; model: string } },
      ) => Promise<unknown>)
    | undefined
}

/** The chat service facade (contract API plus availability helpers). */
export interface ChatService extends ChatServiceApi {
  stream: (request: ChatRequest, signal?: AbortSignal) => AsyncGenerator<ChatFrame>
  available: () => boolean
  route: () => { provider: string; model: string } | null
}

/** One raw message shape read from `chat.json` (defensive history read). */
interface StoredChatMessage {
  id: string
  role: 'user' | 'assistant'
  question?: string
  answer?: string
  citations?: VerifiedCitation[]
  unverified?: UnverifiedCitation[]
  followups?: string[]
  model?: { provider: string; model: string }
  usage?: { inputTokens?: number; outputTokens?: number }
  annotationIds?: string[]
  knowledge?: { nodeIds: string[]; edgeIds: string[] }
  entailment?: EntailmentSummary
  promptVersion?: number
  createdAt: string
}

/** Parsed `chat.json` payload. */
interface ChatFile {
  version: 1
  messages: StoredChatMessage[]
}

/** Result of splitting model output into the answer and the JSON payload. */
export interface SplitModelOutput {
  answer: string
  payload: Record<string, unknown> | null
  fenceFound: boolean
}

/** Result of validating the model's citations against the parser blocks. */
export interface ValidatedCitations {
  citations: VerifiedCitation[]
  unverified: UnverifiedCitation[]
}

/** One verified citation produced by validation. */
interface RawCitationBase {
  index: number
  blockKey: string
  quote: string
  aspect: Aspect
  note: string
}

/** Clamp a finite integer into range with a fallback. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Whether the consumer turn has been aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/** Parse JSON without throwing. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/** Whether a parsed object looks like the model output contract payload. */
function isContractPayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.citations) || record.knowledge !== undefined || Array.isArray(record.followups)
}

/** Bound one citation-ish object for persistence/validation. */
function boundedString(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.slice(0, maxChars) : ''
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
 * @param rawText - complete model output.
 * @returns answer without the fence, parsed contract payload and fence presence.
 */
export function splitModelOutput(rawText: unknown): SplitModelOutput {
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
      const candidate = tryParseJson(fallback[1] ?? '')
      if (isContractPayload(candidate)) {
        answer = raw.slice(0, fallback.index)
        payloadText = fallback[1] ?? ''
      }
    }
  }
  let payload: Record<string, unknown> | null = null
  if (payloadText.trim() !== '') {
    const parsed = tryParseJson(payloadText)
    payload = isContractPayload(parsed) ? parsed : null
    if (payload === null) {
      const firstBrace = payloadText.indexOf('{')
      const lastBrace = payloadText.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const salvaged = tryParseJson(payloadText.slice(firstBrace, lastBrace + 1))
        payload = isContractPayload(salvaged) ? salvaged : null
      }
    }
  }
  return { answer: answer.trimEnd(), payload, fenceFound }
}

/**
 * Validate the model's citations against the actual parser blocks.
 *
 * `verified:true` requires both: the `blockKey` exists in the document and the
 * quote occurs in that block's plain text (shared anchor rules: whitespace-
 * normalized substring, or a ≥20-char prefix fallback). Everything else is
 * reported in `unverified` and never becomes an annotation or graph knowledge.
 *
 * @param input - raw payload, visible answer Markdown and key→block map.
 * @returns validated citations.
 */
export function validateCitations(input: {
  payload: Record<string, unknown> | null
  answer: string
  blockEntries: ReadonlyMap<string, IndexedBlock | { key: string; page: number | null; text: string }>
}): ValidatedCitations {
  const text = typeof input.answer === 'string' ? input.answer : ''
  const referenced = new Set<number>()
  const markerPattern = /\[(\d{1,4})\]/g
  let scanned = 0
  for (let match = markerPattern.exec(text); match !== null && scanned < MAX_MARKERS; match = markerPattern.exec(text)) {
    scanned += 1
    const index = Number(match[1])
    if (Number.isInteger(index) && index > 0) referenced.add(index)
  }
  const citations: VerifiedCitation[] = []
  const unverified: UnverifiedCitation[] = []
  const seen = new Set<number>()
  const payload = input.payload
  const rawCitations = payload !== null && Array.isArray(payload.citations) ? payload.citations : []
  const entries = input.blockEntries
  for (const raw of rawCitations.slice(0, MAX_CITATIONS)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const index = Number.isInteger(record.index) && (record.index as number) > 0 ? (record.index as number) : 0
    const blockKey = boundedString(record.blockKey, 120).trim()
    const quote = boundedString(record.quote, MAX_QUOTE_CHARS).trim()
    const aspect = normalizeAspect(record.aspect)
    const note = boundedString(record.note, MAX_NOTE_CHARS).trim()
    const base: RawCitationBase = { index, blockKey, quote, aspect, note }
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
    const range = locateQuote(entry.text, quote)
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
      page: Number.isInteger(entry.page) && (entry.page as number) > 0 ? (entry.page as number) : null,
      aspect,
      note,
      verified: true,
    })
  }
  citations.sort((left, right) => left.index - right.index)
  return { citations, unverified }
}

/** Empty entailment summary carried on the answer frame / ChatMessage. */
function emptyEntailmentSummary(checked = false): EntailmentSummary {
  return { checked, supported: 0, partial: 0, unsupported: 0 }
}

/**
 * Apply the entailment pass verdicts to one answer's validated citations.
 *
 * `supported` / `partial` stay verified with the verdict recorded on the
 * citation (partial keeps its annotation, the UI warns); `unsupported` is moved
 * to `unverified` with `reason:'entailment-unsupported'` and never becomes an
 * annotation or graph edge. Citations without a verdict become `unchecked`. A
 * null/invalid parse fails open: every citation keeps `entailment:'unchecked'`
 * and stays verified.
 */
function applyEntailmentVerdicts(
  citations: readonly VerifiedCitation[],
  unverified: readonly UnverifiedCitation[],
  parsed: ParsedEntailmentOutput | null,
): { citations: VerifiedCitation[]; unverified: UnverifiedCitation[]; entailment: EntailmentSummary } {
  const verdicts = new Map<number, { index: number; verdict: string; reason: string }>()
  const checked = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.results)
  if (checked) {
    for (const entry of parsed.results) {
      if (entry === null || typeof entry !== 'object') continue
      if (verdicts.has(entry.index)) continue
      if (!ENTAILMENT_STATES.has(entry.verdict)) continue
      verdicts.set(entry.index, entry)
    }
  }
  const kept: VerifiedCitation[] = []
  const moved: UnverifiedCitation[] = []
  const summary = emptyEntailmentSummary(checked)
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (citation === null || typeof citation !== 'object') continue
    const verdict = verdicts.get(citation.index)
    const state = verdict !== undefined ? verdict.verdict : 'unchecked'
    const reason = verdict !== undefined && typeof verdict.reason === 'string' ? verdict.reason.slice(0, 500).trim() : ''
    if (state === 'unsupported') {
      const entry: UnverifiedCitation = {
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
    const next: VerifiedCitation = { ...citation, entailment: state as VerifiedCitation['entailment'] }
    if (reason !== '') next.entailmentReason = reason
    if (state === 'supported') summary.supported += 1
    else if (state === 'partial') summary.partial += 1
    kept.push(next)
  }
  return { citations: kept, unverified: [...unverified, ...moved], entailment: summary }
}

/**
 * Create aspect-colored AI annotations for verified citations.
 *
 * Dedupe rule (shared anchor rules, `docs/AI-SPEC.md` §2): an existing
 * annotation on the same block covering an overlapping range with the same
 * aspect wins — the new one is skipped, reported in `skipped` and does not
 * consume the per-answer cap. At most `ai.maxAnnotationsPerAnswer` (default 5)
 * new annotations are created.
 *
 * Concurrency: when `mutateAnnotations` is injected (the host store's atomic
 * read-modify-write), dedupe + append + save run inside it, so an interleaved
 * client save or agent annotation can never be overwritten.
 */
async function createCitationAnnotations(input: {
  documentId: string
  chatId: string
  messageId: string
  model: { provider: string; model: string }
  citations: readonly VerifiedCitation[]
  maxAnnotations: number
  loadAnnotations?: ((documentId: string) => Promise<AnnotationEnvelope>) | undefined
  saveAnnotations?:
    | ((documentId: string, data: { items?: Annotation[]; baseIds?: string[] }) => Promise<AnnotationEnvelope>)
    | undefined
  mutateAnnotations?:
    | ((
        documentId: string,
        mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>,
      ) => Promise<AnnotationEnvelope>)
    | undefined
  logger?: Logger | undefined
}): Promise<{ ids: string[]; skipped: number; failed: boolean }> {
  const result = { ids: [] as string[], skipped: 0, failed: false }
  if (!Array.isArray(input.citations) || input.citations.length === 0) return result
  const maxNew = clampInt(input.maxAnnotations, 0, 20, DEFAULT_MAX_ANNOTATIONS)
  const createdAt = new Date().toISOString()

  /** Apply the dedupe + cap rules to one annotation list (appended in place). */
  function apply(items: AiAnnotation[]): AiAnnotation[] {
    result.ids = []
    result.skipped = 0
    for (const citation of input.citations) {
      if (result.ids.length >= maxNew) break
      if (citation === null || typeof citation !== 'object' || citation.verified !== true) continue
      const blockKey = boundedString(citation.blockKey, 120)
      const start = Number.isInteger(citation.start) ? Math.max(0, citation.start) : 0
      const end = Number.isInteger(citation.end) ? Math.max(start, citation.end) : start
      const aspect = normalizeAspect(citation.aspect)
      const candidate = { blockKey, start, end, aspect }
      // Shared single-source dedupe rule: same block + overlapping range + aspect.
      if (findDuplicateAnnotation(items, candidate) !== null) {
        result.skipped += 1
        continue
      }
      const annotation: AiAnnotation = {
        id: randomUUID(),
        blockKey,
        start,
        end,
        quote: boundedString(citation.quote, 5000),
        note: (citation.note !== '' ? citation.note : citation.quote).slice(0, 2000),
        color: aspectColor(aspect) as AnnotationColor,
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
    return items
  }

  // Preferred path: atomic read-modify-write on the document's annotation file.
  if (typeof input.mutateAnnotations === 'function') {
    try {
      const persisted = await input.mutateAnnotations(input.documentId, (current) => {
        const existing = Array.isArray(current) ? current : []
        return apply(existing.slice(0, MAX_STORED_ANNOTATIONS))
      })
      const persistedItems = Array.isArray(persisted?.items) ? persisted.items : []
      const persistedIds = new Set(persistedItems.map((item) => item?.id))
      result.ids = result.ids.filter((id) => persistedIds.has(id))
    } catch (error) {
      input.logger?.warn?.('[dsh-litnotes] cannot save AI annotations: %s', (error as Error)?.message ?? error)
      result.ids = []
      result.failed = true
    }
    return result
  }

  // Fallback: load + whole-list save (tests / older host wiring).
  if (typeof input.saveAnnotations !== 'function') return result
  let loaded: AnnotationEnvelope | null = null
  try {
    loaded =
      typeof input.loadAnnotations === 'function'
        ? await input.loadAnnotations(input.documentId)
        : { version: 1, items: [] }
  } catch (error) {
    // Never overwrite an annotation list we could not read: skipping AI
    // annotations is safe, losing the reader's notes is not.
    input.logger?.warn?.('[dsh-litnotes] cannot load annotations for AI highlighting: %s', (error as Error)?.message ?? error)
    result.failed = true
    return result
  }
  const existing = Array.isArray(loaded.items) ? loaded.items : []
  const payload = apply(existing.slice(0, MAX_STORED_ANNOTATIONS))
  if (result.ids.length === 0) return result
  try {
    await input.saveAnnotations(input.documentId, { items: payload })
  } catch (error) {
    input.logger?.warn?.('[dsh-litnotes] cannot save AI annotations: %s', (error as Error)?.message ?? error)
    result.ids = []
    result.failed = true
  }
  return result
}

/** Normalize a label for graph matching (case-folded, punctuation-stripped). */
function normalizeLabel(value: unknown): string {
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
 * with no verified citations the whole delta is dropped.
 */
function normalizeKnowledge(knowledge: unknown, citations: readonly VerifiedCitation[]): KnowledgeDelta {
  const verifiedKeys = new Set(
    (Array.isArray(citations) ? citations : [])
      .filter((citation) => citation !== null && typeof citation === 'object' && citation.verified === true)
      .map((citation) => citation.blockKey),
  )
  if (verifiedKeys.size === 0) return { nodes: [], edges: [] }
  const payload = knowledge !== null && typeof knowledge === 'object' ? (knowledge as Record<string, unknown>) : {}
  const nodes: KnowledgeNodeDelta[] = []
  const labels = new Set<string>()
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : []
  for (const raw of rawNodes.slice(0, MAX_KNOWLEDGE_NODES)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const label = boundedString(record.label, 80).replace(/\s+/g, ' ').trim()
    if (label === '') continue
    const type = (KNOWLEDGE_NODE_TYPES.has(record.type as string) ? record.type : 'concept') as GraphNodeInput['type']
    const blockKeys: string[] = []
    if (Array.isArray(record.blockKeys)) {
      for (const key of record.blockKeys.slice(0, 6)) {
        if (typeof key === 'string' && verifiedKeys.has(key) && !blockKeys.includes(key)) blockKeys.push(key)
      }
    }
    if (blockKeys.length === 0) continue
    nodes.push({
      type,
      label,
      summary: boundedString(record.summary, 500).trim(),
      blockKeys,
      aspect: normalizeAspect(record.aspect),
      source: 'qa',
    })
    labels.add(normalizeLabel(label))
  }
  const edges: KnowledgeEdgeDelta[] = []
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : []
  for (const raw of rawEdges.slice(0, MAX_KNOWLEDGE_EDGES)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const fromKey = normalizeLabel(record.from)
    const toKey = normalizeLabel(record.to)
    if (fromKey === '' || toKey === '' || fromKey === toKey) continue
    if (!labels.has(fromKey) || !labels.has(toKey)) continue
    const type = (KNOWLEDGE_EDGE_TYPES.has(record.type as string) ? record.type : 'relates') as GraphEdgeInput['type']
    const edge: KnowledgeEdgeDelta = {
      from: boundedString(record.from, 80).trim(),
      to: boundedString(record.to, 80).trim(),
      type,
      source: 'qa',
    }
    const label = boundedString(record.label, 120).trim()
    if (label !== '') edge.label = label
    edges.push(edge)
  }
  return { nodes, edges }
}

/** Extract created graph ids from a merge result (best effort, bounded). */
function knowledgeIds(result: unknown, delta: KnowledgeDelta): { nodeIds: string[]; edgeIds: string[] } {
  const out = { nodeIds: [] as string[], edgeIds: [] as string[] }
  if (result === null || typeof result !== 'object') return out
  const record = result as Record<string, unknown>
  if (Array.isArray(record.nodeIds)) {
    out.nodeIds = record.nodeIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_KNOWLEDGE_IDS)
  }
  if (Array.isArray(record.edgeIds)) {
    out.edgeIds = record.edgeIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_KNOWLEDGE_IDS)
  }
  if (out.nodeIds.length === 0 && Array.isArray(record.nodes)) {
    const wanted = new Map<string, string>()
    for (const node of delta.nodes ?? []) wanted.set(normalizeLabel(node.label), node.label)
    for (const node of record.nodes) {
      if (node === null || typeof node !== 'object' || typeof node.id !== 'string') continue
      const label = normalizeLabel((node as { label?: unknown }).label)
      if (wanted.has(label)) out.nodeIds.push(node.id)
    }
    out.nodeIds = out.nodeIds.slice(0, MAX_KNOWLEDGE_IDS)
  }
  if (out.edgeIds.length === 0 && out.nodeIds.length > 0 && Array.isArray(record.edges)) {
    const ids = new Set(out.nodeIds)
    for (const edge of record.edges) {
      if (edge === null || typeof edge !== 'object' || typeof edge.id !== 'string') continue
      if (ids.has(edge.from) && ids.has(edge.to)) out.edgeIds.push(edge.id)
    }
    out.edgeIds = out.edgeIds.slice(0, MAX_KNOWLEDGE_IDS)
  }
  return out
}

/** Keep only valid, deduplicated follow-up questions. */
function sanitizeFollowups(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
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
function normalizeEntailmentState(value: unknown): Citation['entailment'] | undefined {
  return typeof value === 'string' && ENTAILMENT_STATES.has(value) ? (value as Citation['entailment']) : undefined
}

/** Normalize the persisted entailment summary of one assistant message. */
function normalizeEntailmentSummary(raw: unknown): EntailmentSummary | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  return {
    checked: record.checked === true,
    supported: clampInt(record.supported, 0, MAX_CITATIONS, 0),
    partial: clampInt(record.partial, 0, MAX_CITATIONS, 0),
    unsupported: clampInt(record.unsupported, 0, MAX_CITATIONS, 0),
  }
}

/** Normalize one persisted ChatMessage (defensive history read). */
function normalizeMessage(raw: unknown): StoredChatMessage | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null
  if (role === null) return null
  const message: StoredChatMessage = {
    id: typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : randomUUID(),
    role,
    question: boundedString(record.question, MAX_QUESTION_CHARS),
    createdAt: typeof record.createdAt === 'string' && record.createdAt !== '' ? record.createdAt : new Date().toISOString(),
  }
  if (Number.isInteger(record.promptVersion)) message.promptVersion = record.promptVersion as number
  if (role === 'assistant') {
    message.answer = boundedString(record.answer, MAX_ANSWER_CHARS)
    const citations: VerifiedCitation[] = []
    const rawCitations = Array.isArray(record.citations) ? record.citations.slice(0, MAX_CITATIONS) : []
    for (const citation of rawCitations) {
      if (citation === null || typeof citation !== 'object') continue
      const entry = citation as Record<string, unknown>
      const normalized: VerifiedCitation = {
        index: Number.isInteger(entry.index) ? (entry.index as number) : 0,
        blockKey: boundedString(entry.blockKey, 120),
        quote: boundedString(entry.quote, MAX_QUOTE_CHARS),
        start: Number.isInteger(entry.start) ? (entry.start as number) : 0,
        end: Number.isInteger(entry.end) ? (entry.end as number) : 0,
        page: Number.isInteger(entry.page) ? (entry.page as number) : null,
        aspect: normalizeAspect(entry.aspect),
        note: boundedString(entry.note, MAX_NOTE_CHARS),
        verified: entry.verified !== false,
      }
      // Citation–claim entailment second pass (`docs/AI-SPEC.md` §5).
      const entailment = normalizeEntailmentState(entry.entailment)
      if (entailment !== undefined) normalized.entailment = entailment
      const entailmentReason = boundedString(entry.entailmentReason, 500).trim()
      if (entailmentReason !== '') normalized.entailmentReason = entailmentReason
      citations.push(normalized)
    }
    message.citations = citations
    const unverified: UnverifiedCitation[] = []
    const rawUnverified = Array.isArray(record.unverified) ? record.unverified.slice(0, MAX_CITATIONS) : []
    for (const citation of rawUnverified) {
      if (citation === null || typeof citation !== 'object') continue
      const entry = citation as Record<string, unknown>
      const normalized: UnverifiedCitation = {
        index: Number.isInteger(entry.index) ? (entry.index as number) : 0,
        blockKey: boundedString(entry.blockKey, 120),
        quote: boundedString(entry.quote, MAX_QUOTE_CHARS),
        aspect: normalizeAspect(entry.aspect),
        note: boundedString(entry.note, MAX_NOTE_CHARS),
        verified: false,
      }
      const reason = boundedString(entry.reason, 80).trim()
      if (reason !== '') normalized.reason = reason
      const entailment = normalizeEntailmentState(entry.entailment)
      if (entailment !== undefined) normalized.entailment = entailment
      const entailmentReason = boundedString(entry.entailmentReason, 500).trim()
      if (entailmentReason !== '') normalized.entailmentReason = entailmentReason
      unverified.push(normalized)
    }
    message.unverified = unverified
    message.followups = sanitizeFollowups(record.followups)
    if (record.model !== null && typeof record.model === 'object') {
      const modelRecord = record.model as Record<string, unknown>
      message.model = {
        provider: boundedString(modelRecord.provider, 100),
        model: boundedString(modelRecord.model, 100),
      }
    }
    const usage = record.usage !== null && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>) : {}
    message.usage = {
      inputTokens: clampInt(usage.inputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
      outputTokens: clampInt(usage.outputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    }
    message.annotationIds = Array.isArray(record.annotationIds)
      ? record.annotationIds.filter((id): id is string => typeof id === 'string').slice(0, 100)
      : []
    const knowledge = record.knowledge !== null && typeof record.knowledge === 'object'
      ? (record.knowledge as Record<string, unknown>)
      : {}
    message.knowledge = {
      nodeIds: Array.isArray(knowledge.nodeIds)
        ? knowledge.nodeIds.filter((id): id is string => typeof id === 'string').slice(0, 40)
        : [],
      edgeIds: Array.isArray(knowledge.edgeIds)
        ? knowledge.edgeIds.filter((id): id is string => typeof id === 'string').slice(0, 40)
        : [],
    }
    const entailment = normalizeEntailmentSummary(record.entailment)
    if (entailment !== undefined) message.entailment = entailment
  }
  return message
}

/** Normalize the persisted chat file shape. */
function normalizeChatFile(raw: unknown): ChatFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, messages: [] }
  const record = raw as Record<string, unknown>
  const messages: StoredChatMessage[] = []
  for (const item of Array.isArray(record.messages) ? record.messages : []) {
    const message = normalizeMessage(item)
    if (message !== null) messages.push(message)
    if (messages.length >= MAX_CHAT_MESSAGES) break
  }
  return { version: 1, messages }
}

/**
 * Create the grounded chat service.
 *
 * @param deps - engine dependencies (`docs/AI-SPEC.md` §3): the LLM gateway,
 *   the retriever, the store (readMarkdown/aux/annotations) and the optional
 *   atomic store helpers. Without them the historical load/save path is used
 *   (tests / minimal hosts).
 * @returns the chat service facade.
 */
export function createChatService(deps: ChatServiceDeps): ChatService {
  const { llm, retriever } = deps
  if (llm === null || typeof llm !== 'object' || typeof llm.streamText !== 'function') {
    throw new TypeError('createChatService: an llm gateway is required')
  }
  if (retriever === null || typeof retriever !== 'object' || typeof retriever.context !== 'function') {
    throw new TypeError('createChatService: a retriever is required')
  }
  const store = deps.store ?? {}
  const log = deps.logger ?? {}
  const loadAnnotations =
    deps.loadAnnotations ??
    (typeof store.loadAnnotations === 'function' ? (id: string) => store.loadAnnotations!(id) : undefined)
  const saveAnnotations = deps.saveAnnotations ?? store.saveAnnotations
  const mutateAnnotations = deps.mutateAnnotations
  const mutateAux = deps.mutateAux
  const onGraphDelta = deps.onGraphDelta

  /** Resolved `ai` config block with the documented defaults. */
  function aiConfig(): {
    maxContextChars: number
    historyTurns: number
    answerMaxTokens: number
    maxAnnotationsPerAnswer: number
    entailmentCheck: boolean
    entailmentMaxTokens: number
    reasoningEffort: string
  } {
    const ai =
      deps.config !== null && deps.config !== undefined && deps.config.ai !== null && deps.config.ai !== undefined
        ? deps.config.ai
        : {}
    return {
      maxContextChars: clampInt(ai.maxContextChars, 500, 64000, 9000),
      historyTurns: clampInt(ai.historyTurns, 0, 20, 6),
      answerMaxTokens: clampInt(ai.answerMaxTokens, 256, 16384, 4096),
      maxAnnotationsPerAnswer: clampInt(ai.maxAnnotationsPerAnswer, 0, 20, DEFAULT_MAX_ANNOTATIONS),
      // Citation–claim entailment second pass (`docs/AI-SPEC.md` §5): on by
      // default; a cheap, bounded classification call.
      entailmentCheck: ai.entailmentCheck !== false,
      entailmentMaxTokens: clampInt(ai.entailmentMaxTokens, 64, 4096, DEFAULT_ENTAILMENT_MAX_TOKENS),
      // Grounded reading calls always pin a reasoning effort: the adapter's
      // default "high" spends the completion budget on reasoning tokens and can
      // produce an empty visible answer.
      reasoningEffort: ['off', 'low', 'high', 'max'].includes(ai.reasoningEffort as string)
        ? (ai.reasoningEffort as string)
        : 'low',
    }
  }

  /** Whether the gateway has a usable route + host service. */
  function available(): boolean {
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
  function route(): { provider: string; model: string } | null {
    if (typeof llm.route !== 'function') return null
    try {
      const value: unknown = llm.route()
      if (value === null || typeof value !== 'object') return null
      const record = value as Record<string, unknown>
      const provider = typeof record.provider === 'string' ? record.provider : ''
      const model = typeof record.model === 'string' ? record.model : ''
      return provider === '' || model === '' ? null : { provider, model }
    } catch {
      return null
    }
  }

  /** Validate a document id from an HTTP payload. */
  function requireDocumentId(value: unknown): string {
    const documentId = typeof value === 'string' ? value.trim() : ''
    if (documentId === '' || documentId.length > 200) {
      throw new AiError('bad-request', '缺少文档 ID（Missing documentId）')
    }
    return documentId
  }

  /** Validate + bound the question. */
  function normalizeQuestion(value: unknown): string {
    const question = typeof value === 'string' ? value.trim() : ''
    if (question === '') throw new AiError('bad-request', '问题不能为空（The question must not be empty）')
    return question.slice(0, MAX_QUESTION_CHARS)
  }

  /** Normalize the optional reading focus from the client. */
  function normalizeFocus(focus: unknown): { blockKey: string; selectionQuote: string } | null {
    if (focus === null || typeof focus !== 'object' || Array.isArray(focus)) return null
    const record = focus as Record<string, unknown>
    const blockKey = typeof record.blockKey === 'string' ? record.blockKey.trim() : ''
    const selectionQuote = typeof record.selectionQuote === 'string' ? record.selectionQuote.trim() : ''
    if (blockKey === '' && selectionQuote === '') return null
    const safeKey = /^b\d+:[0-9a-f]{8}$/.test(blockKey) ? blockKey : ''
    return { blockKey: safeKey, selectionQuote: selectionQuote.slice(0, 2000) }
  }

  /** Read the parsed document via the store. */
  async function readDocument(documentId: string): Promise<{ markdown: string; contentList: unknown[] | null }> {
    if (store === null || typeof store !== 'object' || typeof store.readMarkdown !== 'function') {
      throw new AiError('bad-request', '文档存储不可用（Document store unavailable）')
    }
    const parsed = await store.readMarkdown(documentId)
    return {
      markdown: parsed !== null && typeof parsed === 'object' && typeof parsed.markdown === 'string' ? parsed.markdown : '',
      contentList: parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.contentList) ? parsed.contentList : null,
    }
  }

  /** Document title for the prompt (best effort). */
  function readTitle(documentId: string): string {
    if (store === null || typeof store !== 'object' || typeof store.get !== 'function') return ''
    try {
      const meta = store.get(documentId)
      return typeof meta?.title === 'string' ? meta.title.slice(0, 300) : ''
    } catch {
      return ''
    }
  }

  /** Read + normalize `chat.json`; a missing/corrupt file reads empty. */
  async function readChat(documentId: string): Promise<ChatFile> {
    if (store === null || typeof store !== 'object' || typeof store.readAux !== 'function') {
      return { version: 1, messages: [] }
    }
    try {
      return normalizeChatFile(await store.readAux(documentId, CHAT_FILE))
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot read chat history: %s', (error as Error)?.message ?? error)
      return { version: 1, messages: [] }
    }
  }

  /** Persist `chat.json` (atomic, store-serialized); returns whether it wrote. */
  async function writeChat(documentId: string, messages: readonly StoredChatMessage[]): Promise<boolean> {
    if (store === null || typeof store !== 'object' || typeof store.writeAux !== 'function') return false
    const bounded = Array.isArray(messages) ? messages.slice(-MAX_CHAT_MESSAGES) : []
    try {
      await store.writeAux(documentId, CHAT_FILE, { version: 1, messages: bounded })
      return true
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot persist chat history: %s', (error as Error)?.message ?? error)
      return false
    }
  }

  /** Previous turns for the prompt, newest last, bounded by `historyTurns`. */
  function promptHistory(
    messages: readonly StoredChatMessage[],
    turns: number,
    excludeMessageId: string,
  ): Array<{ question: string; answer: string }> {
    if (turns <= 0) return []
    const pairs: Array<{ question: string; answer: string }> = []
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message === null || typeof message !== 'object') continue
      if (message.role !== 'assistant') continue
      if (excludeMessageId !== '' && message.id === excludeMessageId) continue
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
  function documentBlocks(documentId: string, markdown: string, contentList: unknown[] | null): IndexedBlock[] {
    const input: RetrieverInput = { documentId, markdown, contentList }
    try {
      if (typeof retriever.blocks === 'function') return [...retriever.blocks(input)]
      if (typeof retriever.buildIndex === 'function') return [...(retriever.buildIndex(input).blocks ?? [])]
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot build block index for citation checks: %s', (error as Error)?.message ?? error)
    }
    return []
  }

  /** Append one completed turn to a normalized chat file and bound the result. */
  function appendTurn(file: ChatFile, turn: {
    documentId: string
    question: string
    messageId: string
    userMessageId: string
    createdAt: string
    regenerateOf: string
    answer: string
    citations: VerifiedCitation[]
    unverified: UnverifiedCitation[]
    entailment: EntailmentSummary
    followups: string[]
    model: { provider: string; model: string }
    usage: { inputTokens?: number; outputTokens?: number }
    annotationIds: string[]
    knowledge: { nodeIds: string[]; edgeIds: string[] }
  }): ChatFile {
    const messages = Array.isArray(file?.messages) ? file.messages.slice() : []
    const userMessage: StoredChatMessage = {
      id: turn.userMessageId,
      role: 'user',
      question: turn.question,
      promptVersion: PROMPT_VERSION,
      createdAt: turn.createdAt,
    }
    const assistantMessage: StoredChatMessage = {
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
    if (turn.regenerateOf !== '') {
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
   * Uses the injected atomic `mutateAux` when available so two concurrent turns
   * (or one turn plus `clear()`) never overwrite each other's history; falls
   * back to read + whole-file write for tests and minimal host wiring.
   */
  async function persistTurn(turn: Parameters<typeof appendTurn>[1]): Promise<boolean> {
    if (typeof mutateAux === 'function') {
      try {
        const written = await mutateAux<ChatFile>(turn.documentId, CHAT_FILE, (current) =>
          appendTurn(normalizeChatFile(current), turn),
        )
        return written !== undefined
      } catch (error) {
        log.warn?.('[dsh-litnotes] cannot persist chat history: %s', (error as Error)?.message ?? error)
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
   */
  async function runEntailmentCheck(input: {
    citations: readonly VerifiedCitation[]
    maxTokens: number
    signal: AbortSignal | undefined
  }): Promise<ParsedEntailmentOutput | null> {
    if (typeof llm.completeText !== 'function') return null
    try {
      const raw = await llm.completeText({
        system: ENTAILMENT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: entailmentPrompt(input.citations) }] }],
        signal: input.signal,
        maxTokens: input.maxTokens,
        temperature: 0,
        reasoningEffort: 'off',
        purpose: 'entailment',
        maxChars: 20000,
      })
      return parseEntailmentOutput(raw)
    } catch (error) {
      if (isAborted(input.signal) || (error as { code?: string })?.code === 'aborted' || (error as { name?: string })?.name === 'AbortError') {
        throw error instanceof AiError ? error : new AiError('aborted', '已停止（Aborted）')
      }
      log.warn?.('[dsh-litnotes] citation entailment check failed open: %s', (error as Error)?.message ?? error)
      return null
    }
  }

  /** Map any thrown value to one public error frame (never leaks prompt text). */
  function errorFrame(error: unknown): ChatFrame {
    if (error instanceof AiError) {
      return { type: 'error', code: error.code, message: error.message }
    }
    const code = (error as { code?: string })?.code
    if (typeof code === 'string' && code !== '') {
      // WireError/parser errors carry a user-safe bilingual message.
      return {
        type: 'error',
        code,
        message:
          typeof (error as { message?: string })?.message === 'string' && (error as { message: string }).message !== ''
            ? (error as { message: string }).message.slice(0, 500)
            : '请求失败（Request failed）',
      }
    }
    log.warn?.(
      '[dsh-litnotes] chat turn failed: %s',
      (error as { stack?: string })?.stack ?? (error as { message?: string })?.message ?? String(error),
    )
    return { type: 'error', code: 'host-error', message: 'AI 服务内部错误（AI service error）' }
  }

  /**
   * Read the persisted conversation for one document.
   * @param documentId - document id.
   * @returns ChatMessage[] oldest first.
   */
  async function history(documentId: string): Promise<ChatMessage[]> {
    const docId = requireDocumentId(documentId)
    const file = await readChat(docId)
    // Frozen `chat.json` messages carry historical fields the shared type
    // narrows (entailmentReason, promptVersion) and user messages omit the
    // citation arrays; the runtime shape is the 1.0.0 format.
    return file.messages as unknown as ChatMessage[]
  }

  /**
   * Clear the conversation for one document.
   * @param documentId - document id.
   * @returns acknowledgement.
   */
  async function clear(documentId: string): Promise<{ cleared: true }> {
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
   * @param request - client request (`docs/AI-SPEC.md` §3).
   * @param signal - consumer abort signal (the route's abort controller).
   * @returns NDJSON frame objects.
   */
  async function* stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatFrame> {
    // The route passes the abort controller as the second argument; the frozen
    // engine tests (and 1.0 callers) also carried it on the request object.
    const effectiveSignal = signal ?? (request as { signal?: AbortSignal } | null | undefined)?.signal
    try {
      const documentId = requireDocumentId(request?.documentId)
      const question = normalizeQuestion(request?.question)
      const rawMode: unknown = (request as { mode?: unknown } | undefined)?.mode
      const mode = typeof rawMode === 'string' && rawMode !== '' ? rawMode : 'doc'
      if (mode !== 'doc') {
        throw new AiError('bad-request', '整库问答暂未开放（Library-wide Q&A is not available yet）')
      }
      if (isAborted(effectiveSignal)) {
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
      if (isAborted(effectiveSignal)) throw new AiError('aborted', '已停止（Aborted）')
      if (parsed.markdown.trim() === '') {
        throw new AiError('bad-request', '文档没有可读取的正文（The document has no parsed text）')
      }
      const context = retriever.context({
        documentId,
        markdown: parsed.markdown,
        contentList: parsed.contentList,
        question,
        focusBlockKey: focus?.blockKey ?? '',
        selection:
          focus !== null && focus.selectionQuote !== ''
            ? { blockKey: focus.blockKey, quote: focus.selectionQuote }
            : undefined,
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
        signal: effectiveSignal,
        maxTokens: ai.answerMaxTokens,
        temperature: 0.2,
        reasoningEffort: ai.reasoningEffort,
        purpose: 'chat',
      })
      let rawText = ''
      let fenceSeen = false
      let pending = ''
      let streamedText = ''
      let usage: { inputTokens: number; outputTokens: number } | null = null
      for await (const chunk of iterator) {
        if (isAborted(effectiveSignal)) throw new AiError('aborted', '已停止（Aborted）')
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
      if (isAborted(effectiveSignal)) throw new AiError('aborted', '已停止（Aborted）')
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
      const blockEntries = new Map<string, IndexedBlock>()
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
      // the verified citations. Any non-abort model failure fails open to
      // `unchecked`.
      let entailment = emptyEntailmentSummary(false)
      if (ai.entailmentCheck && validated.citations.length > 0 && typeof llm.completeText === 'function') {
        yield { type: 'phase', phase: 'entailment' }
        const parsedVerdicts = await runEntailmentCheck({
          citations: validated.citations,
          maxTokens: ai.entailmentMaxTokens,
          signal: effectiveSignal,
        })
        if (isAborted(effectiveSignal)) throw new AiError('aborted', '已停止（Aborted）')
        const applied = applyEntailmentVerdicts(validated.citations, validated.unverified, parsedVerdicts)
        validated.citations = applied.citations
        validated.unverified = applied.unverified
        entailment = applied.entailment
      }
      if (isAborted(effectiveSignal)) throw new AiError('aborted', '已停止（Aborted）')
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
      let graphFrame: KnowledgeDelta | null = null
      let knowledge = { nodeIds: [] as string[], edgeIds: [] as string[] }
      if ((knowledgeDelta.nodes?.length ?? 0) > 0 || (knowledgeDelta.edges?.length ?? 0) > 0) {
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
            log.warn?.('[dsh-litnotes] cannot merge Q&A knowledge into the graph: %s', (error as Error)?.message ?? error)
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
        log.warn?.('[dsh-litnotes] cannot persist chat turn: %s', (error as Error)?.message ?? error)
      }

      // 7) answer / graph / usage / done frames. The unverified list has no
      // page offsets by contract but the shared Citation type requires them;
      // cast at the wire boundary to keep the frozen frame shape.
      yield {
        type: 'answer',
        messageId,
        markdown: answerMarkdown,
        citations: validated.citations,
        unverified: validated.unverified as unknown as Citation[],
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
