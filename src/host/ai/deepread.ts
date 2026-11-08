/**
 * AI 精读 (deep read) — whole-paper close reading for dsh-litnotes.
 *
 * The 1.0.0 chat flow answers one question from a bounded retrieval window; a
 * deep read instead reads the paper section by section and leaves a structured
 * close-reading record on disk. The workflow (`docs/AI-SPEC.md` §5.3, design
 * `.agents/plan/DEEPREAD.md` §2):
 *
 *   1. prepare     — parse the paper through the shared reader parser
 *                    (`parseMarkdown` + `appendPageMarks`), split it into
 *                    heading-scoped sections, classify each section's role,
 *                    chunk the sections at block boundaries (~4000 chars) and
 *                    select at most `ai.deepReadMaxChunks` chunks by role
 *                    priority + a deterministic even fill.
 *   2. paper map   — one call builds a reading plan (problem, gap, claimed
 *                    contributions, key terms, refined section roles). It is a
 *                    reading aid, never a quote source; a failed call falls back
 *                    to a deterministic map.
 *   3. close read  — one sequential call per selected chunk with the paper map,
 *                    a rolling reading memory and the section's role lens.
 *                    Every annotation quote is verified against the actual
 *                    parser block text (`locateQuote`); metadata, trivial notes
 *                    and quote restatements are rejected by the Host.
 *   4. gap pass    — re-reads up to `MAX_GAP_PASSES` content sections that got
 *                    no durable annotation, so the annotations cannot collapse
 *                    into abstract/introduction only.
 *   5. adjudicate  — optional model judge (fail-open) drops restating, vague,
 *                    metadata or unsupported candidates.
 *   6. select      — deterministic de-duplication (shared overlap rule),
 *                    coverage-aware ranking and the annotation cap.
 *   7. synthesize  — one call writes the critical close-reading report; a
 *                    malformed answer falls back to a deterministic report.
 *   8. persist     — annotations are created atomically through
 *                    `store.mutateAnnotations` (fallback load/save) and the
 *                    record is written to `documents/<id>/deepread.json`.
 *
 * The generator never throws: expected failures are `{type:'error', code,
 * message}` frames. An aborted run writes nothing and leaves the previous
 * record intact; a non-forced call replays the cached record with no model
 * call at all.
 *
 * @module host/ai/deepread
 */

import { randomUUID } from 'node:crypto'
import { aspectColor, normalizeAspect } from './aspects.ts'
import { AiError, type LlmCompleteRequest, type LlmStreamRequest } from './llm.ts'
import {
  DEEPREAD_GAP_SYSTEM,
  DEEPREAD_JUDGE_SYSTEM,
  DEEPREAD_MAP_SYSTEM,
  DEEPREAD_PROMPT_VERSION,
  DEEPREAD_REPORT_SYSTEM,
  DEEPREAD_SECTION_SYSTEM,
  deepReadGapUserPrompt,
  deepReadJudgeUserPrompt,
  deepReadMapUserPrompt,
  deepReadReportUserPrompt,
  deepReadSectionUserPrompt,
  normalizeDeepReadReport,
  parseDeepReadJudgeOutput,
  parseDeepReadMapOutput,
  parseDeepReadReportOutput,
  parseDeepReadSectionOutput,
  type DeepReadReportAnnotationInput,
  type ParsedDeepReadMap,
  type ParsedDeepReadPoint,
  type ParsedDeepReadSection,
} from './prompts.ts'
import { appendPageMarks, parseMarkdown } from '../../shared/markdown/parse.ts'
import { plainTextOfBlock } from '../../shared/markdown/model.ts'
import type { PaperModel } from '../../shared/markdown/model.ts'
import { findDuplicateAnnotation, locateQuote, normalizeQuoteText } from '../../shared/annotate/anchors.ts'
import type { AnnotationColor, Aspect } from '../../shared/constants.ts'
import type {
  Annotation,
  AnnotationEnvelope,
  DeepReadFrame,
  DeepReadHighlight,
  DeepReadPoint,
  DeepReadRecord,
  DeepReadReport,
  DeepReadSectionRole,
  DeepReadStats,
  DeepReadUnitKind,
  DocumentMeta,
  ParsedDocument,
} from '../../shared/model.ts'
import type { AiConfig, DeepReadServiceApi, DocumentAuxName } from '../contracts.ts'
import type { Logger } from '../host-services.ts'

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Aux JSON file holding one document's close-reading record. */
const DEEPREAD_FILE: DocumentAuxName = 'deepread.json'

/** Target size of one close-reading chunk (the reader parser block budget). */
const CHUNK_TARGET_CHARS = 4000
/** Maximum model calls of the coverage/gap pass. */
const MAX_GAP_PASSES = 4
/** Maximum candidates entering adjudication (defensive bound). */
const MAX_CANDIDATES = 240
/** Candidates per adjudication call. */
const JUDGE_BATCH_SIZE = 60
/** Maximum adjudication calls (240 candidates / 60 per call). */
const MAX_JUDGE_CALLS = 4
/** Maximum annotations stored per document (mirrors the store cap). */
const MAX_STORED_ANNOTATIONS = 5000
/** Default annotation target/cap (`ai.deepReadMaxAnnotations`). */
const DEFAULT_MAX_ANNOTATIONS = 24
/** Default close-reading chunk cap (`ai.deepReadMaxChunks`). */
const DEFAULT_MAX_CHUNKS = 24
/** Quote verification bounds (`docs/AI-SPEC.md` §5.3). */
const MIN_QUOTE_CHARS = 15
const MAX_QUOTE_CHARS = 500
/** Note verification bounds. */
const MIN_NOTE_CHARS = 30
const MAX_NOTE_CHARS = 700
/** Rolling reading memory bound (chars) — the prompt never grows without limit. */
const MAX_MEMORY_CHARS = 2500
/** Maximum sections preview-rendered in the map prompt. */
const MAX_MAP_PREVIEW_CHARS = 300
/** First-chars budget of the map prompt. */
const MAP_HEAD_CHARS = 5000
/** Map output budget (small JSON payload). */
const MAP_MAX_TOKENS = 1600
/** Hard cap on raw model output consumed for one call. */
const MAX_RAW_OUTPUT_CHARS = 200000
/** Sections with less content than this are not "content sections" (no coverage). */
const MIN_CONTENT_SECTION_CHARS = 40
/** Report fallback and record bounds. */
const MAX_RECORD_HIGHLIGHTS = 200
const MAX_GLOSSARY_TERMS = 12
/** Accepted fenced payload for highlights (unit kind vocabulary). */
const UNIT_KINDS: ReadonlySet<string> = new Set([
  'claim',
  'definition',
  'method',
  'result',
  'limitation',
  'connection',
  'context',
])
/** Accepted reader language ids (`docs/AI-SPEC.md` §5.3 normalization). */
const LANGUAGE_PATTERN = /^[a-z-]{2,16}$/
/** Default reader language when the request omits/invalidates it. */
const DEFAULT_LANGUAGE = 'en'

/** High-value roles: every chunk of these roles is preferred by the selector. */
const HIGH_VALUE_ROLES: readonly DeepReadSectionRole[] = Object.freeze([
  'method',
  'experiment',
  'results',
  'discussion',
  'limitation',
  'introduction',
  'abstract',
])
/** Filler roles: read only after the high-value roles when slots remain. */
const FILL_ROLES: readonly DeepReadSectionRole[] = Object.freeze([
  'appendix',
  'background',
  'related-work',
  'conclusion',
  'other',
])
/** Reading/coverage order of section roles (most argument-bearing first). */
const SECTION_ROLE_PRIORITY: readonly DeepReadSectionRole[] = Object.freeze([
  'method',
  'experiment',
  'results',
  'limitation',
  'discussion',
  'conclusion',
  'introduction',
  'abstract',
  'background',
  'related-work',
  'appendix',
  'other',
  'references',
])

/** Metadata block patterns: title/authors/affiliation/venue/boilerplate blocks. */
const METADATA_BLOCK_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bcorresponding author\b/i,
  /\bequal(ly)? contribut/i,
  /\bwork (done|performed) while\b/i,
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,
  /\b(university|universit[äa]t|institute|institut|department|dept\.|faculty|school of|college|laborator|academy of)\b/i,
  /\b(arxiv|doi|isbn|issn)\b\s*:?\s*[a-z0-9./-]+/i,
  /\b(proceedings|conference|workshop|symposium|journal)\b[^.]{0,80}\b(19|20)\d{2}\b/i,
  /\b(copyright|all rights reserved|creative commons|licen[cs]e)\b/i,
  /\b(acknowledg(e)?ments?|funded by|funding|grant (no\.?|number)|supported by|we thank)\b/i,
  /\b(received|accepted|published)\b[^.]{0,40}\b(19|20)\d{2}\b/i,
  /©|®|™/,
  /^\s*(keywords?|index terms|acm classification|ccs concepts)\b/i,
])

/** Metadata quote patterns: labels, reference markers, bare URLs. */
const METADATA_QUOTE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^(figure|fig\.?|table|tab\.?|algorithm|listing|equation|eq\.?)\s*[a-z]?\d+[a-z]?[^\p{L}]*$/iu,
  /^\[\d{1,3}\]\s*$/,
  /^\s*https?:\/\/\S+$/i,
])

/** Report labels used by the deterministic fallback (zh + en). */
const REPORT_LABELS: Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>> = Object.freeze({
  zh: Object.freeze({
    problem: '研究问题',
    gap: '研究空白',
    contributions: '核心贡献',
    method: '方法',
    evaluation: '实验与证据',
    findings: '主要发现',
    limitations: '局限与风险',
    openQuestions: '开放问题',
    verdict: '总体评价',
  }),
  en: Object.freeze({
    problem: 'Research problem',
    gap: 'Research gap',
    contributions: 'Contributions',
    method: 'Method',
    evaluation: 'Evaluation',
    findings: 'Findings',
    limitations: 'Limitations',
    openQuestions: 'Open questions',
    verdict: 'Verdict',
  }),
})

/* -------------------------------------------------------------------------- */
/* Public interfaces (design §5 factory signature)                            */
/* -------------------------------------------------------------------------- */

/** The LLM gateway surface the deep-read engine consumes. */
export interface DeepReadLlmApi {
  available?: (() => boolean) | undefined
  route?: (() => unknown) | undefined
  completeText?: ((request: LlmCompleteRequest) => Promise<string>) | undefined
  streamText?: ((request: LlmStreamRequest) => AsyncIterable<unknown>) | undefined
}

/** The store surface the deep-read engine consumes. */
export interface DeepReadStoreApi {
  get?: ((documentId: string) => DocumentMeta | undefined) | undefined
  readMarkdown?: ((documentId: string) => Promise<ParsedDocument>) | undefined
  readAux: (documentId: string, name: DocumentAuxName) => Promise<unknown>
  writeAux: (documentId: string, name: DocumentAuxName, value: unknown) => Promise<void>
  mutateAnnotations?:
    | ((
        documentId: string,
        mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>,
      ) => Promise<AnnotationEnvelope>)
    | undefined
  loadAnnotations?: ((documentId: string) => Promise<AnnotationEnvelope>) | undefined
  saveAnnotations?:
    | ((documentId: string, data: { items?: Annotation[]; baseIds?: string[] }) => Promise<AnnotationEnvelope>)
    | undefined
}

/** Dependencies of {@link createDeepReadService}. */
export interface DeepReadServiceDeps {
  llm?: DeepReadLlmApi | undefined
  store: DeepReadStoreApi
  config?: { ai?: Partial<AiConfig> | undefined } | undefined
  logger?: Logger | undefined
  readMarkdown?: ((documentId: string) => Promise<ParsedDocument | string>) | undefined
}

/** The deep-read service facade: contract API plus `get`/`run`. */
export interface DeepReadService extends DeepReadServiceApi {
  get: (documentId: string) => Promise<DeepReadRecord | null>
  run: (
    documentId: string,
    options?: { signal?: AbortSignal | undefined; force?: boolean | undefined; language?: string | undefined },
  ) => AsyncGenerator<DeepReadFrame>
}

/* -------------------------------------------------------------------------- */
/* Internal types                                                             */
/* -------------------------------------------------------------------------- */

/** Resolved deep-read limits (`config.ai` with the documented clamps). */
interface DeepReadConfig {
  maxChunks: number
  maxSourceChars: number
  maxAnnotations: number
  maxTokens: number
  synthesisChars: number
  coveragePass: boolean
  judge: boolean
  reasoningEffort: string
}

/** One parser block prepared for the close reading (offset space preserved). */
interface PreparedBlock {
  key: string
  index: number
  kind: string
  level: number
  page: number | null
  /** Canonical block plain text; annotation offsets address this string. */
  text: string
}

/** One heading-scoped document section. */
interface PreparedSection {
  id: number
  heading: string
  level: number
  role: DeepReadSectionRole
  blocks: PreparedBlock[]
  /** Non-heading text characters (heading-only sections are not content). */
  contentChars: number
}

/** One selected close-reading chunk. */
interface DeepReadChunk {
  id: number
  sectionId: number
  section: string
  role: DeepReadSectionRole
  lines: string[]
  blockKeys: string[]
  chars: number
  /** False for heading-only chunks (nothing to annotate). */
  annotatable: boolean
}

/** The prepared document: blocks, sections, chunks and the selection. */
interface PreparedDocument {
  documentId: string
  title: string
  blocks: PreparedBlock[]
  byKey: Map<string, PreparedBlock>
  sections: PreparedSection[]
  sectionById: Map<number, PreparedSection>
  contentSectionIds: Set<number>
  chunks: DeepReadChunk[]
  selected: DeepReadChunk[]
  outline: string[]
  head: string
  /** Heading outline of the unread tail when the source was truncated. */
  tailOutline: string[]
  truncated: boolean
}

/** One validated annotation candidate (verified quote, interpretive note). */
interface Candidate {
  blockKey: string
  quote: string
  start: number
  end: number
  page: number | null
  aspect: Aspect
  note: string
  importance: number
  sectionId: number
  section: string | null
  role: DeepReadSectionRole
  pass: 'read' | 'gap'
  /** Stable production order (deterministic tie-breaking). */
  order: number
  /** Model judge verdict (1/2 keep, 0 dropped before selection). */
  judgeScore?: number
}

/** Per-section reading material collected for the report synthesis. */
interface SectionMaterial {
  heading: string
  role: DeepReadSectionRole
  summary: string
  points: ParsedDeepReadPoint[]
}

/** One entry of the rolling reading memory. */
interface MemoryEntry {
  section: string
  role: DeepReadSectionRole
  summary: string
  points: string[]
}

/** Mutable run state (stats, memory, candidates, reading material). */
interface RunState {
  stats: DeepReadStats
  memory: Map<number, MemoryEntry>
  material: Map<number, SectionMaterial>
  candidates: Candidate[]
  openQuestions: ParsedDeepReadPoint[]
  candidateOrder: number
  readSectionIds: Set<number>
}

/** One verified annotation batch of a close-reading call. */
interface VerifiedBatch {
  candidates: Candidate[]
  grounded: number
}

/** Result of one reading/gap pass. */
interface ReadingPassResult {
  failures: number
  successes: number
}

/** Annotation persistence result (ids aligned with the selected candidates). */
interface PersistResult {
  ids: Array<string | null>
  created: number
  failed: boolean
}

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Whether a value is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Clamp a finite integer into range with a fallback. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Bound one arbitrary value to a trimmed string. */
function boundedText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** Whether the consumer run has been aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/** The canonical abort failure of the engine. */
function abortFailure(): AiError {
  return new AiError('aborted', '已停止（Aborted）')
}

/** Whether one thrown value means "the consumer aborted". */
function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (isAborted(signal)) return true
  if (error instanceof AiError) return error.code === 'aborted'
  if (!isObject(error)) return false
  const name = typeof error.name === 'string' ? error.name : ''
  const code = typeof error.code === 'string' ? error.code : ''
  return name === 'AbortError' || code === 'aborted' || code === 'ABORT_ERR'
}

/** Sanitize a `{ provider, model }` value. */
function sanitizeModel(raw: unknown): { provider: string; model: string } | null {
  if (!isObject(raw)) return null
  const provider = boundedText(raw.provider, 100)
  const model = boundedText(raw.model, 100)
  return provider === '' || model === '' ? null : { provider, model }
}

/** Collapse one heading to a comparison key (numbering and punctuation removed). */
function normalizeHeadingKey(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^[\s\d.\u00a7#:()[\]]+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Section role priority index (`-1` roles sort last). */
function rolePriority(role: DeepReadSectionRole): number {
  const index = SECTION_ROLE_PRIORITY.indexOf(role)
  return index === -1 ? SECTION_ROLE_PRIORITY.length : index
}

/** Derive the unit kind of one page annotation from its aspect. */
function unitKindForAspect(aspect: Aspect): DeepReadUnitKind {
  return aspect
}

/* -------------------------------------------------------------------------- */
/* Document preparation                                                       */
/* -------------------------------------------------------------------------- */

/** Extract up to 60 de-duplicated ATX headings from a markdown fragment. */
function extractOutlineHeadings(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const pattern = /^[ \t]{0,3}(#{1,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (out.length >= 60) break
    const heading = boundedText(match[2], 200)
    const key = normalizeHeadingKey(heading)
    if (heading === '' || key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(heading)
  }
  return out
}

/** Limit the source to the configured budget and keep the tail outline. */
function limitDeepReadSource(
  markdown: string,
  maxSourceChars: number,
): { source: string; truncated: boolean; tailOutline: string[] } {
  const source = typeof markdown === 'string' ? markdown : ''
  if (source.length <= maxSourceChars) return { source, truncated: false, tailOutline: [] }
  const head = source.slice(0, maxSourceChars)
  return { source: head, truncated: true, tailOutline: extractOutlineHeadings(source.slice(maxSourceChars)) }
}

/** Build the ordered block list (page/rule/figure blocks skipped). */
function buildPreparedBlocks(model: PaperModel): PreparedBlock[] {
  const blocks: PreparedBlock[] = []
  for (const block of Array.isArray(model.blocks) ? model.blocks : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.kind === 'page' || block.kind === 'rule' || block.kind === 'figure') continue
    const text = plainTextOfBlock(block)
    if (text.trim() === '') continue
    blocks.push({
      key: block.key,
      index: block.index,
      kind: block.kind,
      level: block.kind === 'heading' ? block.level : 0,
      page: Number.isInteger(block.page) && (block.page as number) > 0 ? (block.page as number) : null,
      text,
    })
  }
  return blocks
}

/** Classify one section role from its heading (the map pass may refine it). */
function classifySectionRole(heading: string): DeepReadSectionRole {
  const text = normalizeHeadingKey(heading)
  if (text === '') return 'other'
  if (/^abstract\b/.test(text) || text === 'summary') return 'abstract'
  if (/^(introduction|intro)\b/.test(text)) return 'introduction'
  if (/^(related work|related literature|literature review)\b/.test(text)) return 'related-work'
  if (/^background\b/.test(text) || /^preliminar/.test(text)) return 'background'
  if (/^(method|methods|approach|design|system|model|architecture)\b/.test(text)) return 'method'
  if (/^(experiment|experiments|evaluation|setup|benchmark)\b/.test(text)) return 'experiment'
  if (/^(result|results|analysis|ablation)\b/.test(text)) return 'results'
  if (/^discussion\b/.test(text)) return 'discussion'
  if (/^(limitation|limitations|threat|threats|validity)\b/.test(text)) return 'limitation'
  if (/^(conclusion|conclusions|future work)\b/.test(text)) return 'conclusion'
  if (/^(appendix|supplementary)\b/.test(text)) return 'appendix'
  if (/^(references|bibliography|acknowledg)/.test(text)) return 'references'
  return 'other'
}

/** Split prepared blocks into heading-scoped sections. */
function buildPreparedSections(blocks: readonly PreparedBlock[]): PreparedSection[] {
  const sections: PreparedSection[] = []
  let current: PreparedSection | null = null
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (current !== null) sections.push(current)
      current = {
        id: sections.length,
        heading: block.text.trim(),
        level: block.level,
        role: classifySectionRole(block.text),
        blocks: [block],
        contentChars: 0,
      }
      continue
    }
    if (current === null) {
      current = { id: 0, heading: '', level: 0, role: 'other', blocks: [], contentChars: 0 }
    }
    current.blocks.push(block)
    current.contentChars += block.text.length
  }
  if (current !== null) sections.push(current)
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (section !== undefined) section.id = index
  }
  return sections
}

/** Render one prepared block as a `[[key]] (page N) text` chunk line. */
function renderChunkBlock(block: PreparedBlock): string {
  const text = normalizeQuoteText(block.text)
  if (text === '') return ''
  const page = block.page !== null ? `page ${block.page}` : 'page unknown'
  return `[[${block.key}]] (${page}) ${text}`
}

/** Build the section-aware close-reading chunks (~4000 chars, split at blocks). */
function buildDeepReadChunks(sections: readonly PreparedSection[]): DeepReadChunk[] {
  const chunks: DeepReadChunk[] = []
  /** Push one accumulated chunk. */
  function flush(section: PreparedSection, lines: string[], blockKeys: string[], chars: number): void {
    if (lines.length === 0) return
    chunks.push({
      id: chunks.length,
      sectionId: section.id,
      section: section.heading,
      role: section.role,
      lines,
      blockKeys,
      chars,
      annotatable: section.blocks.some((block) => block.kind !== 'heading'),
    })
  }
  for (const section of sections) {
    const headingBlock = section.blocks.find((block) => block.kind === 'heading')
    const headingLine = headingBlock !== undefined ? renderChunkBlock(headingBlock) : ''
    let lines: string[] = []
    let blockKeys: string[] = []
    let chars = 0
    for (const block of section.blocks) {
      const line = renderChunkBlock(block)
      if (line === '') continue
      if (lines.length > 0 && chars + line.length + 1 > CHUNK_TARGET_CHARS) {
        flush(section, lines, blockKeys, chars)
        lines = []
        blockKeys = []
        chars = 0
        // An oversized section repeats its heading at the top of every piece.
        if (headingLine !== '' && block.kind !== 'heading' && headingBlock !== undefined) {
          lines.push(headingLine)
          blockKeys.push(headingBlock.key)
          chars += headingLine.length + 1
        }
      }
      lines.push(line)
      if (!blockKeys.includes(block.key)) blockKeys.push(block.key)
      chars += line.length + 1
    }
    flush(section, lines, blockKeys, chars)
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    if (chunk !== undefined) chunk.id = index
  }
  return chunks
}

/** Pick up to `max` entries spread evenly across a list (deterministic). */
function pickEvenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items]
  if (max <= 0) return []
  const first = items[0]
  if (max === 1 || first === undefined) return first === undefined ? [] : [first]
  const picked: T[] = []
  for (let index = 0; index < max; index += 1) {
    const position = Math.round((index * (items.length - 1)) / (max - 1))
    const item = items[position]
    if (item !== undefined && !picked.includes(item)) picked.push(item)
  }
  return picked
}

/**
 * Select the chunks the close reading actually reads.
 *
 * Rule (`docs/AI-SPEC.md` §5.3 stage 0): references are never read; every
 * high-value role contributes its first chunk (in the documented priority
 * order), remaining slots are filled round-robin across the high-value roles,
 * and the last slots are spread evenly across the filler roles. The result is
 * returned in document order so the reading memory grows sequentially.
 */
function selectDeepReadChunks(chunks: readonly DeepReadChunk[], maxChunks: number): DeepReadChunk[] {
  const byRole = new Map<DeepReadSectionRole, DeepReadChunk[]>()
  for (const chunk of chunks) {
    // References are never quoted and heading-only chunks have nothing to read.
    if (chunk.role === 'references' || !chunk.annotatable) continue
    const list = byRole.get(chunk.role) ?? []
    list.push(chunk)
    byRole.set(chunk.role, list)
  }
  const selected: DeepReadChunk[] = []
  const taken = new Set<number>()
  /** Add one chunk when it is not taken and the cap allows it. */
  function take(chunk: DeepReadChunk | undefined): boolean {
    if (chunk === undefined || taken.has(chunk.id) || selected.length >= maxChunks) return false
    taken.add(chunk.id)
    selected.push(chunk)
    return true
  }
  // One chunk of every high-value role first (the abstract/introduction survive a
  // method-heavy paper), then round-robin the remaining high-value chunks.
  for (const role of HIGH_VALUE_ROLES) {
    const list = byRole.get(role)
    if (list !== undefined && list.length > 0) take(list[0])
    if (selected.length >= maxChunks) break
  }
  let progressed = true
  while (selected.length < maxChunks && progressed) {
    progressed = false
    for (const role of HIGH_VALUE_ROLES) {
      const list = byRole.get(role) ?? []
      const next = list.find((chunk) => !taken.has(chunk.id))
      if (next !== undefined && take(next)) progressed = true
      if (selected.length >= maxChunks) break
    }
  }
  if (selected.length < maxChunks) {
    const rest: DeepReadChunk[] = []
    for (const role of FILL_ROLES) rest.push(...(byRole.get(role) ?? []))
    rest.sort((left, right) => left.id - right.id)
    for (const chunk of pickEvenly(rest, maxChunks - selected.length)) take(chunk)
  }
  selected.sort((left, right) => left.id - right.id)
  return selected
}

/** Content sections: non-reference sections with annotatable (non-metadata) text. */
function contentSectionIdsOf(sections: readonly PreparedSection[], documentTitle: string): Set<number> {
  const ids = new Set<number>()
  for (const section of sections) {
    if (section.role === 'references') continue
    if (section.contentChars < MIN_CONTENT_SECTION_CHARS) continue
    // A title/author/affiliation-only preamble can never be annotated, so it must
    // not count against coverage nor consume a gap re-read.
    const hasAnnotatableText = section.blocks.some(
      (block) =>
        block.kind !== 'heading' &&
        block.text.trim().length >= MIN_QUOTE_CHARS &&
        !isMetadataBlock(block, section.role, documentTitle),
    )
    if (!hasAnnotatableText) continue
    ids.add(section.id)
  }
  return ids
}

/** Coverage of the selected annotations over the content sections (0-1). */
function coverageOf(document: PreparedDocument, selected: readonly Candidate[]): number {
  const total = document.contentSectionIds.size
  if (total === 0) return 0
  const covered = new Set<number>()
  for (const candidate of selected) {
    if (document.contentSectionIds.has(candidate.sectionId)) covered.add(candidate.sectionId)
  }
  return Math.min(1, covered.size / total)
}

/** Prepare the whole paper for the close reading. */
function prepareDocument(input: {
  documentId: string
  title: string
  markdown: string
  contentList: readonly unknown[] | null
  config: DeepReadConfig
}): PreparedDocument {
  const limited = limitDeepReadSource(input.markdown, input.config.maxSourceChars)
  const model = appendPageMarks(parseMarkdown(limited.source), input.contentList)
  const blocks = buildPreparedBlocks(model)
  if (blocks.length === 0) {
    throw new AiError('bad-request', '文档没有可读取的正文块（The document has no readable text blocks）')
  }
  const sections = buildPreparedSections(blocks)
  const byKey = new Map<string, PreparedBlock>()
  for (const block of blocks) byKey.set(block.key, block)
  const sectionById = new Map<number, PreparedSection>()
  for (const section of sections) sectionById.set(section.id, section)
  const chunks = buildDeepReadChunks(sections)
  const selected = selectDeepReadChunks(chunks, input.config.maxChunks)
  const outline: string[] = []
  for (const entry of Array.isArray(model.outline) ? model.outline : []) {
    if (outline.length >= 80) break
    const text = boundedText(entry?.text, 200)
    if (text !== '') outline.push(text)
  }
  return {
    documentId: input.documentId,
    title: input.title,
    blocks,
    byKey,
    sections,
    sectionById,
    contentSectionIds: contentSectionIdsOf(sections, input.title),
    chunks,
    selected,
    outline,
    head: limited.source.slice(0, MAP_HEAD_CHARS),
    tailOutline: limited.tailOutline,
    truncated: limited.truncated,
  }
}

/* -------------------------------------------------------------------------- */
/* Metadata / quality gate                                                    */
/* -------------------------------------------------------------------------- */

/** Whether one short block reads like a metadata line (not narrative prose). */
function looksLikeMetadataLine(text: string): boolean {
  if (text.length > 320) return false
  const sentenceEnds = (text.match(/[.!?](?:\s|$)/g) ?? []).length
  return sentenceEnds <= 2
}

/** Whether a block is title/author/affiliation/venue/boilerplate material. */
function isMetadataBlock(block: PreparedBlock, role: DeepReadSectionRole, documentTitle: string): boolean {
  if (role === 'references') return true
  // Generic headings are never worth an annotation.
  if (block.kind === 'heading') return true
  const text = normalizeQuoteText(block.text)
  if (text === '') return true
  // The paper title (or a block that is essentially the title line).
  const title = normalizeQuoteText(documentTitle).toLowerCase()
  if (title.length >= 8) {
    const lower = text.toLowerCase()
    if (lower === title) return true
    const prefix = title.slice(0, Math.min(title.length, 80))
    if (lower.length <= title.length + 40 && (lower.includes(prefix) || title.includes(lower.slice(0, Math.min(lower.length, 80))))) {
      return true
    }
  }
  // Metadata lines are short and non-narrative; a long body paragraph that merely
  // mentions a university or a venue is still paper content.
  if (looksLikeMetadataLine(text) && METADATA_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) return true
  if (text.length <= 240 && looksLikeAuthorLine(text)) return true
  return false
}

/** Whether a short block reads like an author list (`Alice Zhang, Bob Li, …`). */
function looksLikeAuthorLine(text: string): boolean {
  if (text.length > 240 || /[.;:!?]/.test(text)) return false
  if ((text.match(/,/g) ?? []).length < 2) return false
  const words = text.split(/[,\s]+/).filter((word) => word !== '')
  if (words.length < 4 || words.length > 40) return false
  return words.every((word) => /^[\p{L}][\p{L}\p{N}.'’-]*$/u.test(word) || /^\d+$/.test(word))
}

/** Whether a quote is metadata even when its block passed the block checks. */
function isMetadataQuote(quote: string, block: PreparedBlock): boolean {
  const text = normalizeQuoteText(quote)
  if (text === '') return true
  if (!/\p{L}/u.test(text)) return true
  for (const pattern of METADATA_QUOTE_PATTERNS) {
    if (pattern.test(text)) return true
  }
  if (text.length <= 120 && METADATA_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) return true
  // A table caption/number is not an argument; a table row needs real words.
  if (block.kind === 'table') {
    const words = text.split(/\s+/).filter((word) => /^\p{L}{3,}/u.test(word))
    if (text.length < 40 || words.length < 3) return true
  }
  return false
}

/** Token set of one normalized text (words + CJK runs stay together). */
function tokenSetOf(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const token of text.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2) tokens.add(token)
  }
  return tokens
}

/** Character bigram set of one text (works for space-less languages). */
function bigramSetOf(text: string): Set<string> {
  const compact = text.replace(/[^\p{L}\p{N}]+/gu, '')
  const grams = new Set<string>()
  for (let index = 0; index + 1 < compact.length; index += 1) {
    grams.add(compact.slice(index, index + 2))
  }
  return grams
}

/** Jaccard similarity of two sets. */
function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const value of left) if (right.has(value)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

/**
 * Whether a note merely restates/paraphrases its quote.
 *
 * The Host rejects notes equal to, prefixed by, containing or largely
 * overlapping their quote; this is the cheap deterministic half of the quality
 * gate (the model judge catches semantic restatements the text comparison
 * misses).
 */
function quoteRestatesNote(note: string, quote: string): boolean {
  const normalizedNote = normalizeQuoteText(note).toLowerCase()
  const normalizedQuote = normalizeQuoteText(quote).toLowerCase()
  if (normalizedNote === '' || normalizedQuote === '') return false
  if (normalizedNote === normalizedQuote) return true
  if (normalizedNote.startsWith(normalizedQuote) || normalizedQuote.startsWith(normalizedNote)) return true
  if (normalizedQuote.length >= MIN_QUOTE_CHARS && normalizedNote.includes(normalizedQuote)) return true
  const noteTokens = tokenSetOf(normalizedNote)
  const quoteTokens = tokenSetOf(normalizedQuote)
  if (noteTokens.size >= 4 && quoteTokens.size >= 4 && jaccard(noteTokens, quoteTokens) >= 0.6) return true
  const noteGrams = bigramSetOf(normalizedNote)
  const quoteGrams = bigramSetOf(normalizedQuote)
  if (noteGrams.size >= 8 && quoteGrams.size >= 8 && jaccard(noteGrams, quoteGrams) >= 0.55) return true
  return false
}

/* -------------------------------------------------------------------------- */
/* Reading memory / paper map rendering                                       */
/* -------------------------------------------------------------------------- */

/** Render the paper map as prompt lines (a reading plan, never a quote source). */
function renderPaperMap(map: ParsedDeepReadMap): string {
  const lines: string[] = []
  if (map.kind !== 'other') lines.push(`Kind: ${map.kind}`)
  if (map.problem !== '') lines.push(`Problem: ${map.problem}`)
  if (map.gap !== '') lines.push(`Gap: ${map.gap}`)
  if (map.contributions.length > 0) lines.push(`Claimed contributions: ${map.contributions.join(' | ')}`)
  if (map.methodFamily !== '') lines.push(`Method family: ${map.methodFamily}`)
  if (map.evaluation !== '') lines.push(`Evaluation: ${map.evaluation}`)
  if (map.keyTerms.length > 0) lines.push(`Key terms: ${map.keyTerms.join(', ')}`)
  return lines.join('\n')
}

/** Render the rolling reading memory, keeping the most recent entries in budget. */
function renderReadingMemory(memory: ReadonlyMap<number, MemoryEntry>, maxChars: number): string {
  const parts: string[] = []
  for (const entry of memory.values()) {
    const heading = entry.section !== '' ? entry.section : '(untitled)'
    const lines = [`- ${heading} [${entry.role}]${entry.summary !== '' ? `: ${entry.summary}` : ''}`]
    for (const point of entry.points) lines.push(`  · ${point}`)
    parts.push(lines.join('\n'))
  }
  let text = ''
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] ?? ''
    if (text === '') {
      text = part
      continue
    }
    if (text.length + part.length + 1 > maxChars) break
    text = `${part}\n${text}`
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** Point kinds a reading memory prefers (the argument-bearing ones first). */
const MEMORY_POINT_PRIORITY: readonly string[] = Object.freeze([
  'limitation',
  'result',
  'claim',
  'connection',
  'method',
  'gap',
  'contribution',
  'assumption',
  'question',
])

/** Pick up to three strongest point texts for the reading memory. */
function strongestPointTexts(points: readonly ParsedDeepReadPoint[]): string[] {
  const ranked = [...points].sort(
    (left, right) => MEMORY_POINT_PRIORITY.indexOf(left.kind) - MEMORY_POINT_PRIORITY.indexOf(right.kind),
  )
  const out: string[] = []
  for (const point of ranked) {
    if (out.includes(point.text)) continue
    out.push(point.text)
    if (out.length >= 3) break
  }
  return out
}

/** Merge a new point list into the section material (kind+text unique). */
function mergePoints(existing: readonly ParsedDeepReadPoint[], incoming: readonly ParsedDeepReadPoint[]): ParsedDeepReadPoint[] {
  const merged = [...existing]
  for (const point of incoming) {
    if (merged.some((candidate) => candidate.kind === point.kind && candidate.text === point.text)) continue
    merged.push(point)
    if (merged.length >= 10) break
  }
  return merged
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

/** Resolve the deep-read limits with the documented clamps (`docs/AI-SPEC.md` §7). */
function resolveDeepReadConfig(config: { ai?: Partial<AiConfig> | undefined } | undefined): DeepReadConfig {
  const ai = config !== null && config !== undefined && isObject(config.ai) ? config.ai : {}
  const reasoningEffort = ['off', 'low', 'high', 'max'].includes(ai.reasoningEffort as string)
    ? (ai.reasoningEffort as string)
    : 'low'
  return {
    maxChunks: clampInt(ai.deepReadMaxChunks, 4, 60, DEFAULT_MAX_CHUNKS),
    maxSourceChars: clampInt(ai.deepReadMaxSourceChars, 20000, 1000000, 240000),
    maxAnnotations: clampInt(ai.deepReadMaxAnnotations, 8, 60, DEFAULT_MAX_ANNOTATIONS),
    maxTokens: clampInt(ai.deepReadMaxTokens, 512, 8192, 2400),
    synthesisChars: clampInt(ai.deepReadSynthesisChars, 4000, 40000, 14000),
    coveragePass: ai.deepReadCoveragePass !== false,
    judge: ai.deepReadJudge !== false,
    reasoningEffort,
  }
}

/** Normalize the reader language id (default `en`, `docs/AI-SPEC.md` §5.3). */
function normalizeLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_LANGUAGE
  const language = value.trim().toLowerCase()
  return LANGUAGE_PATTERN.test(language) ? language : DEFAULT_LANGUAGE
}

/* -------------------------------------------------------------------------- */
/* Record normalization                                                       */
/* -------------------------------------------------------------------------- */

/** Normalize one stored highlight (defensive on-disk read). */
function normalizeHighlight(raw: unknown): DeepReadHighlight | null {
  if (!isObject(raw)) return null
  const blockKey = boundedText(raw.blockKey, 120)
  if (!/^b\d+:[0-9a-f]{8}$/.test(blockKey)) return null
  const quote = boundedText(raw.quote, MAX_QUOTE_CHARS)
  if (quote === '') return null
  const start = clampInt(raw.start, 0, MAX_RAW_OUTPUT_CHARS, 0)
  const end = clampInt(raw.end, start, MAX_RAW_OUTPUT_CHARS, start)
  const page = Number.isInteger(raw.page) && (raw.page as number) > 0 ? (raw.page as number) : null
  const aspect = normalizeAspect(raw.aspect)
  const rawKind = typeof raw.kind === 'string' ? raw.kind : ''
  const kind = UNIT_KINDS.has(rawKind) ? (rawKind as DeepReadUnitKind) : unitKindForAspect(aspect)
  return {
    annotationId: boundedText(raw.annotationId, 100),
    blockKey,
    quote,
    start,
    end,
    page,
    aspect,
    note: boundedText(raw.note, MAX_NOTE_CHARS),
    importance: clampInt(raw.importance, 1, 5, 3),
    section: typeof raw.section === 'string' && raw.section.trim() !== '' ? boundedText(raw.section, 200) : null,
    kind,
  }
}

/** Normalize one stored stats object. */
function normalizeStats(raw: unknown): DeepReadStats {
  const stats = isObject(raw) ? raw : {}
  return {
    sections: clampInt(stats.sections, 0, 100000, 0),
    sectionsRead: clampInt(stats.sectionsRead, 0, 100000, 0),
    chunks: clampInt(stats.chunks, 0, 100000, 0),
    chunksRead: clampInt(stats.chunksRead, 0, 100000, 0),
    candidates: clampInt(stats.candidates, 0, 100000, 0),
    kept: clampInt(stats.kept, 0, 100000, 0),
    skipped: clampInt(stats.skipped, 0, 100000, 0),
    coverage: typeof stats.coverage === 'number' && Number.isFinite(stats.coverage)
      ? Math.min(1, Math.max(0, stats.coverage))
      : 0,
    calls: clampInt(stats.calls, 0, 100000, 0),
    durationMs: clampInt(stats.durationMs, 0, Number.MAX_SAFE_INTEGER, 0),
    inputTokens: clampInt(stats.inputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    outputTokens: clampInt(stats.outputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    truncated: stats.truncated === true,
  }
}

/**
 * Normalize one persisted `deepread.json` payload.
 *
 * Corrupt/unreadable files answer `null` (the caller treats the document as
 * never deep-read). A file for another document id is refused.
 */
function normalizeDeepReadRecord(raw: unknown, documentId: string): DeepReadRecord | null {
  if (!isObject(raw)) return null
  if (raw.version !== 1) return null
  const rawDocumentId = typeof raw.documentId === 'string' ? raw.documentId : ''
  if (rawDocumentId === '' || rawDocumentId !== documentId) return null
  const report = normalizeDeepReadReport(raw.report)
  if (report === null) return null
  const highlights: DeepReadHighlight[] = []
  for (const item of Array.isArray(raw.highlights) ? raw.highlights.slice(0, MAX_RECORD_HIGHLIGHTS) : []) {
    const highlight = normalizeHighlight(item)
    if (highlight !== null) highlights.push(highlight)
  }
  const generatedAt = boundedText(raw.generatedAt, 40)
  return {
    version: 1,
    documentId,
    generatedAt: generatedAt !== '' ? generatedAt : new Date().toISOString(),
    language: normalizeLanguage(raw.language),
    model: sanitizeModel(raw.model),
    promptVersion: clampInt(raw.promptVersion, 0, 1000, DEEPREAD_PROMPT_VERSION),
    report,
    highlights,
    stats: normalizeStats(raw.stats),
  }
}

/* -------------------------------------------------------------------------- */
/* Report fallback                                                            */
/* -------------------------------------------------------------------------- */

/** Report labels of one reader language (zh/en table, en for everything else). */
function reportLabels(language: string): Readonly<Record<string, string>> {
  return language.toLowerCase().startsWith('zh') ? REPORT_LABELS.zh : REPORT_LABELS.en
}

/** Build report points from candidates with one of the given aspects. */
function pointsFromCandidates(
  candidates: readonly Candidate[],
  aspects: readonly Aspect[] | null,
  label: string,
  maxPoints: number,
): DeepReadPoint[] {
  const out: DeepReadPoint[] = []
  for (const candidate of candidates) {
    if (aspects !== null && !aspects.includes(candidate.aspect)) continue
    out.push({ label, detail: boundedText(candidate.note, 500), blockKeys: [candidate.blockKey] })
    if (out.length >= maxPoints) break
  }
  return out
}

/** First block keys of the points of sections with the given roles. */
function pointKeysForRoles(document: PreparedDocument, material: ReadonlyMap<number, SectionMaterial>, roles: readonly DeepReadSectionRole[]): string[] {
  const keys: string[] = []
  for (const role of roles) {
    for (const [sectionId, entry] of material) {
      if (entry.role !== role) continue
      for (const point of entry.points) {
        for (const key of point.blockKeys) {
          if (!keys.includes(key)) keys.push(key)
        }
      }
      const section = document.sectionById.get(sectionId)
      if (section !== undefined && keys.length === 0) {
        for (const block of section.blocks) {
          if (block.kind === 'heading') continue
          keys.push(block.key)
          break
        }
      }
    }
    if (keys.length >= 4) break
  }
  return keys.slice(0, 4)
}

/**
 * Build the deterministic fallback report (synthesis failed or was empty).
 *
 * From the paper map, the section summaries and the selected annotations: tldr
 * = top notes, problem/gap from the map, contributions from the map, method /
 * findings / limitations grouped by aspect, open questions from reading points,
 * glossary from key terms (definitions when available), reading path from the
 * most annotated sections, `confidence: 'medium'`.
 */
function buildFallbackReport(input: {
  language: string
  map: ParsedDeepReadMap
  document: PreparedDocument
  material: ReadonlyMap<number, SectionMaterial>
  openQuestions: readonly ParsedDeepReadPoint[]
  selected: readonly Candidate[]
}): DeepReadReport {
  const labels = reportLabels(input.language)
  const notes = input.selected.map((candidate) => boundedText(candidate.note, 200)).filter((note) => note !== '')
  const tldr = (notes.length > 0 ? notes : input.map.contributions).slice(0, 3).map((note) => note.slice(0, 200))
  const problem: DeepReadPoint = {
    label: labels.problem ?? 'Research problem',
    detail: boundedText(input.map.problem, 500),
    blockKeys: pointKeysForRoles(input.document, input.material, ['abstract', 'introduction']),
  }
  const gap: DeepReadPoint = {
    label: labels.gap ?? 'Research gap',
    detail: boundedText(input.map.gap, 500),
    blockKeys: [],
  }
  const contributions: DeepReadPoint[] = input.map.contributions.map((text) => ({
    label: boundedText(text, 90),
    detail: boundedText(text, 500),
    blockKeys: [],
    evidence: 'partial' as const,
  }))
  const limitations = pointsFromCandidates(input.selected, ['limitation'], labels.limitations ?? 'Limitations', 4)
  for (const entry of input.material.values()) {
    for (const point of entry.points) {
      if (point.kind !== 'limitation' || limitations.length >= 4) continue
      limitations.push({
        label: labels.limitations ?? 'Limitations',
        detail: boundedText(point.text, 500),
        blockKeys: point.blockKeys.slice(0, 4),
      })
    }
  }
  const openQuestions: DeepReadPoint[] = []
  for (const point of input.openQuestions.slice(0, 4)) {
    openQuestions.push({
      label: labels.openQuestions ?? 'Open questions',
      detail: boundedText(point.text, 500),
      blockKeys: point.blockKeys.slice(0, 4),
    })
  }
  const glossary: DeepReadReport['glossary'] = []
  const definitionCandidates = input.selected.filter((candidate) => candidate.aspect === 'definition')
  const usedCandidates = new Set<number>()
  for (const term of input.map.keyTerms.slice(0, MAX_GLOSSARY_TERMS)) {
    const normalizedTerm = term.toLowerCase()
    const match = definitionCandidates.find((candidate) => {
      if (usedCandidates.has(candidate.order)) return false
      const note = candidate.note.toLowerCase()
      const quote = candidate.quote.toLowerCase()
      return note.includes(normalizedTerm) || quote.includes(normalizedTerm)
    })
    if (match !== undefined) usedCandidates.add(match.order)
    glossary.push({
      term,
      definition: match !== undefined ? boundedText(match.note, 300) : '',
      blockKeys: match !== undefined ? [match.blockKey] : [],
    })
  }
  const sectionCounts = new Map<number, number>()
  for (const candidate of input.selected) {
    sectionCounts.set(candidate.sectionId, (sectionCounts.get(candidate.sectionId) ?? 0) + 1)
  }
  const readingPath: string[] = []
  const rankedSections = [...sectionCounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])
  for (const [sectionId] of rankedSections) {
    const section = input.document.sectionById.get(sectionId)
    if (section === undefined || section.heading === '') continue
    if (readingPath.includes(section.heading)) continue
    readingPath.push(boundedText(section.heading, 200))
    if (readingPath.length >= 3) break
  }
  if (readingPath.length === 0) {
    for (const section of input.document.sections) {
      if (!input.document.contentSectionIds.has(section.id) || section.heading === '') continue
      readingPath.push(boundedText(section.heading, 200))
      if (readingPath.length >= 3) break
    }
  }
  return {
    tldr,
    problem,
    gap,
    contributions,
    method: pointsFromCandidates(input.selected, ['method'], labels.method ?? 'Method', 4),
    evaluation: pointsFromCandidates(
      input.selected.filter((candidate) => candidate.role === 'experiment'),
      null,
      labels.evaluation ?? 'Evaluation',
      3,
    ),
    findings: pointsFromCandidates(input.selected, ['result'], labels.findings ?? 'Findings', 4),
    limitations,
    openQuestions,
    argumentMap: [],
    glossary,
    readingPath,
    verdict: {
      strengths: tldr.slice(0, 3),
      weaknesses: limitations.slice(0, 3).map((point) => boundedText(point.detail, 200)),
      confidence: 'medium',
    },
  }
}

/** Whether a parsed report carries any usable content at all. */
function isUsableReport(report: DeepReadReport): boolean {
  return (
    report.tldr.length > 0 ||
    report.problem.detail !== '' ||
    report.gap.detail !== '' ||
    report.contributions.length > 0 ||
    report.method.length > 0 ||
    report.evaluation.length > 0 ||
    report.findings.length > 0 ||
    report.limitations.length > 0 ||
    report.openQuestions.length > 0 ||
    report.argumentMap.length > 0 ||
    report.glossary.length > 0 ||
    report.readingPath.length > 0 ||
    report.verdict.strengths.length > 0 ||
    report.verdict.weaknesses.length > 0
  )
}

/** Fill the few empty structural fields of a usable model report from the fallback. */
function fillReportGaps(report: DeepReadReport, fallback: DeepReadReport): DeepReadReport {
  if (report.tldr.length === 0) report.tldr = fallback.tldr.slice(0, 3)
  if (report.problem.detail === '') report.problem = fallback.problem
  if (report.gap.detail === '') report.gap = fallback.gap
  return report
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create the AI 精读 close-reading service.
 *
 * @param deps - injected engine dependencies: the optional LLM gateway, the
 *   document store (aux JSON + annotation helpers) and the resolved config.
 *   Without a gateway `get()` still replays the persisted record and `run()`
 *   fails with an `llm-unavailable` error frame instead of throwing.
 * @returns the service facade (`get` / `run`).
 */
export function createDeepReadService(deps: DeepReadServiceDeps): DeepReadService {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('createDeepReadService: dependencies are required')
  }
  const store = deps.store
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createDeepReadService: an injected store is required')
  }
  if (typeof store.readAux !== 'function' || typeof store.writeAux !== 'function') {
    throw new TypeError('createDeepReadService: store.readAux/writeAux are required')
  }
  const llm = deps.llm
  const log = deps.logger ?? {}
  const readingConfig = resolveDeepReadConfig(deps.config)
  const readMarkdownImpl =
    typeof deps.readMarkdown === 'function'
      ? deps.readMarkdown
      : typeof store.readMarkdown === 'function'
        ? (documentId: string): Promise<ParsedDocument> => store.readMarkdown!(documentId)
        : null

  /** Serialize record writes per document (two concurrent runs never interleave). */
  const docChains = new Map<string, Promise<void>>()
  function queueDoc<T>(documentId: string, task: () => Promise<T>): Promise<T> {
    const previous = docChains.get(documentId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    docChains.set(documentId, tail)
    void tail.then(() => {
      if (docChains.get(documentId) === tail) docChains.delete(documentId)
    })
    return run
  }

  /** Whether the gateway has a usable route + host service. */
  function gatewayAvailable(): boolean {
    if (llm === null || llm === undefined || typeof llm !== 'object') return false
    if (typeof llm.available === 'function') {
      try {
        return llm.available() === true
      } catch {
        return false
      }
    }
    return typeof llm.completeText === 'function' || typeof llm.streamText === 'function'
  }

  /** Resolved model route, or null. */
  function routeOf(): { provider: string; model: string } | null {
    if (llm === null || llm === undefined || typeof llm !== 'object' || typeof llm.route !== 'function') return null
    try {
      return sanitizeModel(llm.route())
    } catch {
      return null
    }
  }

  /** Validate a document id (tolerant read path, strict run path). */
  function requireDocumentId(value: unknown): string {
    const documentId = typeof value === 'string' ? value.trim() : ''
    if (documentId === '' || documentId.length > 200) {
      throw new AiError('bad-request', '缺少文档 ID（Missing documentId）')
    }
    return documentId
  }

  /** Best-effort document title (prompts tolerate an empty title). */
  function documentTitle(documentId: string): string {
    if (typeof store.get !== 'function') return ''
    try {
      const meta = store.get(documentId)
      if (isObject(meta) && typeof meta.title === 'string') return boundedText(meta.title, 300)
    } catch {
      /* invalid id / not found: prompts fall back to an empty title */
    }
    return ''
  }

  /** Read one parsed document through the injected reader (or store). */
  async function loadDocument(documentId: string): Promise<{ markdown: string; contentList: unknown[] | null }> {
    if (readMarkdownImpl === null) {
      throw new AiError('bad-request', '文档存储不可用（Document store unavailable）')
    }
    let result: ParsedDocument | string
    try {
      result = await readMarkdownImpl(documentId)
    } catch (error) {
      if (isAbortFailure(error, undefined)) throw abortFailure()
      const code = isObject(error) && typeof error.code === 'string' ? error.code : ''
      if (code === 'not-parsed' || code === 'not-found') {
        throw new AiError('bad-request', '文档尚未解析（The document has not been parsed yet）')
      }
      throw error
    }
    if (typeof result === 'string') return { markdown: result, contentList: null }
    if (isObject(result) && typeof result.markdown === 'string') {
      return {
        markdown: result.markdown,
        contentList: Array.isArray(result.contentList) ? result.contentList : null,
      }
    }
    return { markdown: '', contentList: null }
  }

  /** Read + normalize the persisted record (tolerant: unreadable answers null). */
  async function readRecord(documentId: string): Promise<DeepReadRecord | null> {
    try {
      const raw = await store.readAux(documentId, DEEPREAD_FILE)
      if (raw === null || raw === undefined) return null
      const record = normalizeDeepReadRecord(raw, documentId)
      if (record === null) {
        log.warn?.('[dsh-litnotes] ignoring unreadable deep-read record for %s', documentId)
      }
      return record
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot read deep-read record: %s', (error as Error)?.message ?? error)
      return null
    }
  }

  /** Read the document's current annotations (best effort; never throws). */
  async function readAnnotations(documentId: string): Promise<Annotation[]> {
    if (typeof store.loadAnnotations !== 'function') return []
    try {
      const envelope = await store.loadAnnotations(documentId)
      return envelope !== null && typeof envelope === 'object' && Array.isArray(envelope.items) ? envelope.items : []
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot load annotations for deep-read dedupe: %s', (error as Error)?.message ?? error)
      return []
    }
  }

  /** Estimate the token usage of one prompt/completion (char heuristic, ~4 chars/token). */
  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  /**
   * Run one bounded completion through the injected gateway and accumulate
   * usage/call statistics. `completeText` is preferred; a gateway exposing only
   * `streamText` is collected frame by frame. Aborts always throw; other
   * failures are the caller's decision (fail-open or count a failure).
   */
  async function completeModel(
    state: RunState,
    input: {
      purpose: string
      system: string
      user: string
      maxTokens: number
      signal: AbortSignal | undefined
      temperature?: number | undefined
    },
  ): Promise<string> {
    if (isAborted(input.signal)) throw abortFailure()
    if (llm === null || llm === undefined || typeof llm !== 'object') {
      throw new AiError('llm-unavailable', '当前配置没有可用的语言模型（No LLM route available）')
    }
    const request: LlmCompleteRequest = {
      system: input.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.user }] }],
      signal: input.signal,
      maxTokens: input.maxTokens,
      temperature: input.temperature ?? 0.2,
      reasoningEffort: readingConfig.reasoningEffort,
      purpose: input.purpose,
      maxChars: Math.min(MAX_RAW_OUTPUT_CHARS, Math.max(20000, input.maxTokens * 16)),
    }
    state.stats.calls += 1
    const inputEstimate = estimateTokens(input.system) + estimateTokens(input.user)
    if (typeof llm.completeText === 'function') {
      const value: unknown = await llm.completeText(request)
      if (isAborted(input.signal)) throw abortFailure()
      const text = typeof value === 'string' ? value : isObject(value) && typeof value.text === 'string' ? value.text : ''
      state.stats.inputTokens += inputEstimate
      state.stats.outputTokens += estimateTokens(text)
      return text
    }
    if (typeof llm.streamText === 'function') {
      let text = ''
      let usage: { inputTokens?: number; outputTokens?: number } | null = null
      for await (const frame of llm.streamText(request)) {
        if (isAborted(input.signal)) throw abortFailure()
        if (!isObject(frame)) continue
        const type = typeof frame.type === 'string' ? frame.type : ''
        if (type === 'error') {
          throw new AiError(
            typeof frame.code === 'string' && frame.code !== '' ? frame.code : 'llm-failed',
            typeof frame.message === 'string' && frame.message !== '' ? frame.message.slice(0, 500) : '模型调用失败（LLM request failed）',
          )
        }
        if ((type === 'delta' || type === 'text' || type === 'text-delta') && typeof frame.text === 'string') {
          text += frame.text
          if (text.length > MAX_RAW_OUTPUT_CHARS) break
        } else if (type === 'usage' && isObject(frame.usage)) {
          usage = {
            inputTokens: clampInt(frame.usage.inputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
            outputTokens: clampInt(frame.usage.outputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
          }
        }
      }
      if (isAborted(input.signal)) throw abortFailure()
      state.stats.inputTokens += usage?.inputTokens ?? inputEstimate
      state.stats.outputTokens += usage?.outputTokens ?? estimateTokens(text)
      return text
    }
    throw new AiError('llm-unavailable', '当前配置没有可用的语言模型（No LLM route available）')
  }

  /** Build one blank run state for a prepared document. */
  function createRunState(document: PreparedDocument, startedAt: number): RunState {
    return {
      stats: {
        sections: document.sections.length,
        sectionsRead: 0,
        chunks: document.selected.length,
        chunksRead: 0,
        candidates: 0,
        kept: 0,
        skipped: 0,
        coverage: 0,
        calls: 0,
        durationMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        truncated: document.truncated,
      },
      memory: new Map<number, MemoryEntry>(),
      material: new Map<number, SectionMaterial>(),
      candidates: [],
      openQuestions: [],
      candidateOrder: 0,
      readSectionIds: new Set<number>(),
    }
  }

  /** Record one successful close-reading call in the reading memory / material. */
  function recordReading(
    state: RunState,
    document: PreparedDocument,
    sectionId: number,
    parsed: ParsedDeepReadSection,
  ): void {
    const section = document.sectionById.get(sectionId)
    if (section === undefined) return
    const previous = state.material.get(sectionId)
    const points = mergePoints(previous?.points ?? [], parsed.points)
    const summary = parsed.summary !== '' ? parsed.summary : (previous?.summary ?? '')
    state.material.set(sectionId, { heading: section.heading, role: section.role, summary, points })
    const memoryPoints = strongestPointTexts(points)
    if (summary !== '' || memoryPoints.length > 0) {
      state.memory.set(sectionId, { section: section.heading, role: section.role, summary, points: memoryPoints })
    }
    for (const point of parsed.points) {
      if (point.kind !== 'question' && point.kind !== 'assumption') continue
      if (state.openQuestions.some((existing) => existing.text === point.text)) continue
      state.openQuestions.push(point)
      if (state.openQuestions.length >= 20) break
    }
  }

  /**
   * Verify the annotations of one close-reading call against the actual blocks.
   *
   * A candidate survives only when: its block belongs to the chunk, the quote is
   * a verbatim (whitespace-normalized) span of 15-500 chars locate-able in the
   * block's plain text, the block/quote are not metadata, and the note is a real
   * interpretation (≥ 30 chars, not a restatement of the quote).
   */
  function verifyReadingOutput(input: {
    state: RunState
    parsed: ParsedDeepReadSection
    chunk: DeepReadChunk
    document: PreparedDocument
  }): VerifiedBatch {
    const candidates: Candidate[] = []
    let grounded = 0
    const chunkKeys = new Set(input.chunk.blockKeys)
    for (const annotation of input.parsed.annotations) {
      const block = input.document.byKey.get(annotation.blockKey)
      if (block === undefined || !chunkKeys.has(annotation.blockKey)) continue
      const needle = normalizeQuoteText(annotation.quote)
      if (needle.length < MIN_QUOTE_CHARS || needle.length > MAX_QUOTE_CHARS) continue
      if (!/\p{L}/u.test(needle)) continue
      const range = locateQuote(block.text, needle)
      if (range === null) continue
      const quote = normalizeQuoteText(block.text.slice(range.start, range.end))
      if (quote.length < MIN_QUOTE_CHARS) continue
      // Grounded candidate: quoted text verified against the real block.
      grounded += 1
      // Quality gate (metadata / trivial / restating notes never reach the page).
      if (isMetadataBlock(block, input.chunk.role, input.document.title)) continue
      if (isMetadataQuote(quote, block)) continue
      const note = boundedText(annotation.note, MAX_NOTE_CHARS)
      if (note.length < MIN_NOTE_CHARS) continue
      if (quoteRestatesNote(note, quote)) continue
      input.state.candidates.push({
        blockKey: annotation.blockKey,
        quote,
        start: range.start,
        end: range.end,
        page: block.page,
        aspect: annotation.aspect,
        note,
        importance: annotation.importance,
        sectionId: input.chunk.sectionId,
        section: input.chunk.section !== '' ? input.chunk.section : null,
        role: input.chunk.role,
        pass: 'read',
        order: input.state.candidateOrder,
      })
      input.state.candidateOrder += 1
      candidates.push(input.state.candidates[input.state.candidates.length - 1] as Candidate)
    }
    return { candidates, grounded }
  }

  /**
   * Read one chunk: prompt, model call, parse, verification, state updates.
   *
   * @returns `true` when the call produced a parsable answer (even if every
   *   annotation was rejected by the quality gate), `false` on a model/parse
   *   failure. Aborts always throw.
   */
  async function closeReadChunk(
    state: RunState,
    input: {
      pass: 'read' | 'gap'
      chunk: DeepReadChunk
      document: PreparedDocument
      map: ParsedDeepReadMap
      language: string
      signal: AbortSignal | undefined
    },
  ): Promise<boolean> {
    if (isAborted(input.signal)) throw abortFailure()
    const promptInput = {
      title: input.document.title,
      language: input.language,
      paperMap: renderPaperMap(input.map),
      readingMemory: renderReadingMemory(state.memory, MAX_MEMORY_CHARS),
      role: input.chunk.role,
      section: input.chunk.section,
      index: input.chunk.id + 1,
      total: input.document.chunks.length,
      lines: input.chunk.lines,
    }
    const prompt =
      input.pass === 'gap' ? deepReadGapUserPrompt(promptInput) : deepReadSectionUserPrompt(promptInput)
    let raw: string
    try {
      raw = await completeModel(state, {
        purpose: input.pass === 'gap' ? 'deepread-gap' : 'deepread-section',
        system: input.pass === 'gap' ? DEEPREAD_GAP_SYSTEM : DEEPREAD_SECTION_SYSTEM,
        user: prompt,
        maxTokens: readingConfig.maxTokens,
        signal: input.signal,
      })
    } catch (error) {
      if (isAbortFailure(error, input.signal)) throw abortFailure()
      log.warn?.('[dsh-litnotes] deep-read close reading call failed: %s', (error as Error)?.message ?? error)
      return false
    }
    if (isAborted(input.signal)) throw abortFailure()
    const parsed = parseDeepReadSectionOutput(raw)
    if (parsed === null) {
      log.warn?.('[dsh-litnotes] deep-read close reading returned no parsable payload')
      return false
    }
    const verified = verifyReadingOutput({
      state,
      parsed,
      chunk: input.chunk,
      document: input.document,
    })
    // Mark the pass-specific provenance (gap annotations rank slightly higher).
    if (input.pass === 'gap') {
      for (const candidate of verified.candidates) candidate.pass = 'gap'
    }
    state.stats.candidates += verified.grounded
    state.readSectionIds.add(input.chunk.sectionId)
    if (input.pass === 'read') state.stats.chunksRead += 1
    recordReading(state, input.document, input.chunk.sectionId, parsed)
    return true
  }

  /** The first/best chunk of one section (the largest, deterministic). */
  function bestChunkForSection(document: PreparedDocument, sectionId: number): DeepReadChunk | undefined {
    let best: DeepReadChunk | undefined
    for (const chunk of document.chunks) {
      if (chunk.sectionId !== sectionId) continue
      if (best === undefined || chunk.chars > best.chars) best = chunk
    }
    return best
  }

  /** The deterministic reading map used when the map call fails. */
  function deterministicMap(sections: readonly PreparedSection[]): ParsedDeepReadMap {
    let problem = ''
    const candidateSections = [
      sections.find((section) => section.role === 'abstract'),
      sections.find((section) => section.role === 'introduction'),
    ]
    for (const section of candidateSections) {
      if (section === undefined) continue
      const first = section.blocks.find((block) => block.kind !== 'heading')
      if (first === undefined) continue
      problem = boundedText(normalizeQuoteText(first.text), 300)
      if (problem !== '') break
    }
    return {
      kind: 'other',
      problem,
      gap: '',
      contributions: [],
      methodFamily: '',
      evaluation: '',
      keyTerms: [],
      sectionRoles: [],
    }
  }

  /** Apply the map's section-role refinements (normalized heading match). */
  function applyMapRoles(sections: readonly PreparedSection[], map: ParsedDeepReadMap): void {
    if (map.sectionRoles.length === 0) return
    const byHeading = new Map<string, PreparedSection>()
    for (const section of sections) {
      const key = normalizeHeadingKey(section.heading)
      if (key === '' || byHeading.has(key)) continue
      byHeading.set(key, section)
    }
    for (const entry of map.sectionRoles) {
      const section = byHeading.get(normalizeHeadingKey(entry.heading))
      if (section !== undefined) section.role = entry.role
    }
  }

  /** Refresh chunk roles after the map refinement (roles drive lenses/gaps). */
  function refreshChunkRoles(document: PreparedDocument): void {
    for (const chunk of document.chunks) {
      const section = document.sectionById.get(chunk.sectionId)
      if (section !== undefined) chunk.role = section.role
    }
    const selectedIds = new Set(document.selected.map((chunk) => chunk.id))
    const refreshed: DeepReadChunk[] = []
    for (const chunk of document.chunks) {
      if (selectedIds.has(chunk.id)) refreshed.push(chunk)
    }
    document.selected = refreshed
  }

  /** Section preview of the map prompt: the first ~300 chars of the section. */
  function sectionPreview(section: PreparedSection, maxChars: number): string {
    const parts: string[] = []
    for (const block of section.blocks) {
      if (block.kind === 'heading') continue
      parts.push(normalizeQuoteText(block.text))
      if (parts.join(' ').length >= maxChars) break
    }
    return boundedText(parts.join(' '), maxChars)
  }

  /** Map pass: one model call, deterministic fallback on any failure. */
  async function* mapPass(
    state: RunState,
    input: { document: PreparedDocument; language: string; signal: AbortSignal | undefined },
  ): AsyncGenerator<DeepReadFrame, ParsedDeepReadMap> {
    yield { type: 'progress', phase: 'mapping', done: 0, total: 1 }
    let map: ParsedDeepReadMap | null = null
    try {
      const prompt = deepReadMapUserPrompt({
        title: input.document.title,
        language: input.language,
        outline: input.document.outline,
        head: input.document.head,
        sectionPreviews: input.document.sections.map((section) => ({
          heading: section.heading,
          role: section.role,
          preview: sectionPreview(section, MAX_MAP_PREVIEW_CHARS),
        })),
        tailOutline: input.document.tailOutline,
        truncated: input.document.truncated,
      })
      const raw = await completeModel(state, {
        purpose: 'deepread-map',
        system: DEEPREAD_MAP_SYSTEM,
        user: prompt,
        maxTokens: Math.min(MAP_MAX_TOKENS, readingConfig.maxTokens),
        signal: input.signal,
      })
      map = parseDeepReadMapOutput(raw)
    } catch (error) {
      if (isAbortFailure(error, input.signal)) throw abortFailure()
      log.warn?.('[dsh-litnotes] deep-read map call failed, using the deterministic map: %s', (error as Error)?.message ?? error)
    }
    if (map === null) {
      log.warn?.('[dsh-litnotes] deep-read map output unusable, using the deterministic map')
      map = deterministicMap(input.document.sections)
    }
    yield { type: 'progress', phase: 'mapping', done: 1, total: 1 }
    return map
  }

  /** Close-reading pass over the selected chunks (sequential, rolling memory). */
  async function* readingPass(
    state: RunState,
    input: {
      pass: 'read'
      chunks: readonly DeepReadChunk[]
      document: PreparedDocument
      map: ParsedDeepReadMap
      language: string
      signal: AbortSignal | undefined
    },
  ): AsyncGenerator<DeepReadFrame, ReadingPassResult> {
    const result: ReadingPassResult = { failures: 0, successes: 0 }
    const total = input.chunks.length
    if (total === 0) return result
    yield { type: 'progress', phase: 'reading', done: 0, total }
    for (let index = 0; index < total; index += 1) {
      const chunk = input.chunks[index]
      if (chunk === undefined) continue
      // A map-refined `references` role is never read for annotations.
      if (chunk.role === 'references') {
        result.successes += 1
        continue
      }
      yield { type: 'progress', phase: 'reading', done: index, total, section: chunk.section }
      const ok = await closeReadChunk(state, {
        pass: 'read',
        chunk,
        document: input.document,
        map: input.map,
        language: input.language,
        signal: input.signal,
      })
      if (ok) result.successes += 1
      else result.failures += 1
    }
    yield { type: 'progress', phase: 'reading', done: total, total }
    return result
  }

  /** Coverage/gap pass: re-read up to four uncovered content sections. */
  async function* gapPass(
    state: RunState,
    input: {
      document: PreparedDocument
      map: ParsedDeepReadMap
      language: string
      signal: AbortSignal | undefined
    },
  ): AsyncGenerator<DeepReadFrame, ReadingPassResult> {
    const result: ReadingPassResult = { failures: 0, successes: 0 }
    if (!readingConfig.coveragePass) return result
    const covered = new Set(state.candidates.map((candidate) => candidate.sectionId))
    const uncovered: PreparedSection[] = []
    for (const sectionId of input.document.contentSectionIds) {
      if (covered.has(sectionId)) continue
      const section = input.document.sectionById.get(sectionId)
      if (section !== undefined) uncovered.push(section)
    }
    uncovered.sort((left, right) => rolePriority(left.role) - rolePriority(right.role) || left.id - right.id)
    const targets = uncovered.slice(0, MAX_GAP_PASSES)
    if (targets.length === 0) return result
    yield { type: 'progress', phase: 'gaps', done: 0, total: targets.length }
    for (let index = 0; index < targets.length; index += 1) {
      const section = targets[index]
      if (section === undefined) continue
      if (isAborted(input.signal)) throw abortFailure()
      const chunk = bestChunkForSection(input.document, section.id)
      if (chunk === undefined) continue
      yield { type: 'progress', phase: 'gaps', done: index, total: targets.length, section: section.heading }
      const ok = await closeReadChunk(state, {
        pass: 'gap',
        chunk,
        document: input.document,
        map: input.map,
        language: input.language,
        signal: input.signal,
      })
      if (ok) result.successes += 1
      else result.failures += 1
    }
    yield { type: 'progress', phase: 'gaps', done: targets.length, total: targets.length }
    return result
  }

  /** Deterministic score of one candidate (importance, judge, diversity, specificity). */
  function candidateScore(candidate: Candidate, aspectCounts: ReadonlyMap<Aspect, number>): number {
    const aspectNeed = 5 - (aspectCounts.get(candidate.aspect) ?? 0)
    const length = normalizeQuoteText(candidate.quote).length
    const specificity = length >= 40 && length <= 260 ? 20 : length > 260 && length <= 500 ? 12 : length >= 25 ? 6 : 0
    return (
      candidate.importance * 100 +
      (candidate.judgeScore ?? 1) * 10 +
      aspectNeed * 6 +
      specificity +
      (candidate.pass === 'gap' ? 4 : 0)
    )
  }

  /**
   * Adjudication pass (optional): drop score-0 candidates, fail open on any
   * model/parse failure so a down judge never empties the page.
   */
  async function* judgePass(
    state: RunState,
    candidates: readonly Candidate[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<DeepReadFrame, Candidate[]> {
    if (!readingConfig.judge || candidates.length === 0) return [...candidates]
    const ordered = [...candidates].sort((left, right) => left.order - right.order)
    const pool = ordered.slice(0, MAX_CANDIDATES)
    const overflow = ordered.slice(MAX_CANDIDATES)
    const batchCount = Math.min(MAX_JUDGE_CALLS, Math.ceil(pool.length / JUDGE_BATCH_SIZE))
    yield { type: 'progress', phase: 'judging', done: 0, total: batchCount }
    const kept: Candidate[] = []
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      if (isAborted(signal)) throw abortFailure()
      const batch = pool.slice(batchIndex * JUDGE_BATCH_SIZE, (batchIndex + 1) * JUDGE_BATCH_SIZE)
      yield { type: 'progress', phase: 'judging', done: batchIndex, total: batchCount }
      try {
        const raw = await completeModel(state, {
          purpose: 'deepread-judge',
          system: DEEPREAD_JUDGE_SYSTEM,
          user: deepReadJudgeUserPrompt({
            candidates: batch.map((candidate, index) => ({
              id: index + 1,
              aspect: candidate.aspect,
              quote: candidate.quote,
              note: candidate.note,
              section: candidate.section ?? '',
            })),
          }),
          maxTokens: 1400,
          temperature: 0,
          signal,
        })
        const parsed = parseDeepReadJudgeOutput(raw)
        if (parsed === null) {
          log.warn?.('[dsh-litnotes] deep-read judge output unusable; keeping the batch (fail open)')
          kept.push(...batch)
          continue
        }
        const scores = new Map<number, 0 | 1 | 2>()
        for (const result of parsed.results) {
          if (scores.has(result.id)) continue
          scores.set(result.id, result.score)
        }
        batch.forEach((candidate, index) => {
          const score = scores.get(index + 1)
          if (score === 0) return
          if (score !== undefined) candidate.judgeScore = score
          kept.push(candidate)
        })
      } catch (error) {
        if (isAbortFailure(error, signal)) throw abortFailure()
        log.warn?.('[dsh-litnotes] deep-read judge call failed; keeping the batch (fail open): %s', (error as Error)?.message ?? error)
        kept.push(...batch)
      }
    }
    yield { type: 'progress', phase: 'judging', done: batchCount, total: batchCount }
    return [...kept, ...overflow]
  }

  /**
   * Deterministic selection: shared dedupe rule (existing annotations and the
   * run's own candidates), coverage-aware first pass (one candidate per content
   * section), then importance/aspect-diversity/specificity ranking up to the cap.
   */
  function selectCandidates(input: {
    candidates: readonly Candidate[]
    existing: readonly Annotation[]
    document: PreparedDocument
    maxAnnotations: number
  }): Candidate[] {
    const max = clampInt(input.maxAnnotations, 8, 60, DEFAULT_MAX_ANNOTATIONS)
    const fresh: Candidate[] = []
    for (const candidate of [...input.candidates].sort((left, right) => left.order - right.order)) {
      if (findDuplicateAnnotation(input.existing, candidate) !== null) continue
      fresh.push(candidate)
    }
    const unique: Candidate[] = []
    for (const candidate of fresh) {
      if (findDuplicateAnnotation(unique, candidate) !== null) continue
      unique.push(candidate)
    }
    const selected: Candidate[] = []
    const taken = new Set<number>()
    const aspectCounts = new Map<Aspect, number>()
    const take = (candidate: Candidate | undefined): boolean => {
      if (candidate === undefined || taken.has(candidate.order) || selected.length >= max) return false
      taken.add(candidate.order)
      selected.push(candidate)
      aspectCounts.set(candidate.aspect, (aspectCounts.get(candidate.aspect) ?? 0) + 1)
      return true
    }
    // 1) One strongest candidate per covered content section, argument-bearing
    //    sections first, so a small cap cannot collapse onto one section.
    const bySection = new Map<number, Candidate[]>()
    for (const candidate of unique) {
      if (!input.document.contentSectionIds.has(candidate.sectionId)) continue
      const list = bySection.get(candidate.sectionId) ?? []
      list.push(candidate)
      bySection.set(candidate.sectionId, list)
    }
    const sectionOrder = [...input.document.contentSectionIds].sort((left, right) => {
      const leftSection = input.document.sectionById.get(left)
      const rightSection = input.document.sectionById.get(right)
      const leftRole = leftSection?.role ?? 'other'
      const rightRole = rightSection?.role ?? 'other'
      return rolePriority(leftRole) - rolePriority(rightRole) || left - right
    })
    for (const sectionId of sectionOrder) {
      if (selected.length >= max) break
      const list = bySection.get(sectionId)
      if (list === undefined || list.length === 0) continue
      let best: Candidate | undefined
      for (const candidate of list) {
        if (taken.has(candidate.order)) continue
        if (best === undefined || candidateScore(candidate, aspectCounts) > candidateScore(best, aspectCounts)) best = candidate
      }
      take(best)
    }
    // 2) Fill the remaining slots by deterministic dynamic score.
    while (selected.length < max) {
      let best: Candidate | undefined
      let bestScore = Number.NEGATIVE_INFINITY
      for (const candidate of unique) {
        if (taken.has(candidate.order)) continue
        const score = candidateScore(candidate, aspectCounts)
        if (score > bestScore) {
          bestScore = score
          best = candidate
        }
      }
      if (best === undefined || !take(best)) break
    }
    return selected
  }

  /** Render the per-section digest of the report prompt + the citable keys. */
  function renderSectionDigest(input: {
    document: PreparedDocument
    state: RunState
    selected: readonly Candidate[]
    maxChars: number
  }): { digest: string; evidenceKeys: string[] } {
    const lines: string[] = []
    const keys = new Set<string>()
    const bySection = new Map<number, Candidate[]>()
    for (const candidate of input.selected) {
      keys.add(candidate.blockKey)
      const list = bySection.get(candidate.sectionId) ?? []
      list.push(candidate)
      bySection.set(candidate.sectionId, list)
    }
    let length = 0
    for (const section of input.document.sections) {
      if (section.role === 'references') continue
      const material = input.state.material.get(section.id)
      const annotations = bySection.get(section.id) ?? []
      if (material === undefined && annotations.length === 0) continue
      const block: string[] = [`## ${section.heading !== '' ? section.heading : '(untitled)'} [${section.role}]`]
      if (material !== undefined && material.summary !== '') block.push(`Summary: ${material.summary}`)
      if (material !== undefined && material.points.length > 0) {
        block.push('Points:')
        for (const point of material.points.slice(0, 6)) {
          for (const key of point.blockKeys) keys.add(key)
          block.push(
            `- [${point.kind}] ${point.text}${point.blockKeys.length > 0 ? ` (${point.blockKeys.join(' ')})` : ''}`,
          )
        }
      }
      const text = block.join('\n')
      if (length + text.length + 2 > input.maxChars) break
      lines.push(text)
      length += text.length + 2
    }
    let digest = lines.join('\n\n')
    if (digest.length > input.maxChars) {
      digest = `${digest.slice(0, input.maxChars)}\n…（已截断 / truncated）`
    }
    return { digest, evidenceKeys: [...keys].slice(0, 200) }
  }

  /** Synthesis pass: one report call with the deterministic fallback. */
  async function* synthesisPass(
    state: RunState,
    input: {
      document: PreparedDocument
      map: ParsedDeepReadMap
      language: string
      selected: readonly Candidate[]
      signal: AbortSignal | undefined
    },
  ): AsyncGenerator<DeepReadFrame, DeepReadReport> {
    yield { type: 'progress', phase: 'synthesizing', done: 0, total: 1 }
    const fallback = buildFallbackReport({
      language: input.language,
      map: input.map,
      document: input.document,
      material: state.material,
      openQuestions: state.openQuestions,
      selected: input.selected,
    })
    const { digest, evidenceKeys } = renderSectionDigest({
      document: input.document,
      state,
      selected: input.selected,
      maxChars: Math.max(2000, readingConfig.synthesisChars - 3000),
    })
    const annotations: DeepReadReportAnnotationInput[] = input.selected.map((candidate) => ({
      aspect: candidate.aspect,
      quote: candidate.quote,
      note: candidate.note,
      blockKey: candidate.blockKey,
    }))
    let parsed: DeepReadReport | null = null
    try {
      const prompt = deepReadReportUserPrompt({
        title: input.document.title,
        language: input.language,
        paperMap: renderPaperMap(input.map),
        digest,
        annotations,
        knownBlockKeys: evidenceKeys,
        maxChars: readingConfig.synthesisChars,
        truncated: input.document.truncated,
      })
      const raw = await completeModel(state, {
        purpose: 'deepread-report',
        system: DEEPREAD_REPORT_SYSTEM,
        user: prompt,
        maxTokens: clampInt(readingConfig.maxTokens * 2, 1024, 8192, 4800),
        temperature: 0.3,
        signal: input.signal,
      })
      const knownBlockKeys = new Set(input.document.blocks.map((block) => block.key))
      parsed = parseDeepReadReportOutput(raw, { knownBlockKeys })
    } catch (error) {
      if (isAbortFailure(error, input.signal)) throw abortFailure()
      log.warn?.('[dsh-litnotes] deep-read report call failed, using the deterministic report: %s', (error as Error)?.message ?? error)
    }
    const report = parsed !== null && isUsableReport(parsed) ? fillReportGaps(parsed, fallback) : fallback
    if (parsed === null || !isUsableReport(parsed)) {
      log.warn?.('[dsh-litnotes] deep-read report output unusable, using the deterministic report')
    }
    yield { type: 'progress', phase: 'synthesizing', done: 1, total: 1 }
    return report
  }

  /** Build one stored annotation for a selected candidate. */
  function toAnnotation(candidate: Candidate, input: {
    documentId: string
    runId: string
    model: { provider: string; model: string }
    createdAt: string
  }): Annotation {
    return {
      id: randomUUID(),
      blockKey: candidate.blockKey,
      start: candidate.start,
      end: candidate.end,
      quote: candidate.quote,
      color: aspectColor(candidate.aspect) as AnnotationColor,
      aspect: candidate.aspect,
      note: candidate.note,
      origin: 'ai',
      chatId: `deepread:${input.documentId}`,
      messageId: input.runId,
      model: { provider: input.model.provider, model: input.model.model },
      createdAt: input.createdAt,
    }
  }

  /**
   * Create the selected annotations atomically.
   *
   * The dedupe rule runs again against the freshly read list (a concurrent
   * user/chat save must never be overwritten); a save failure is reported but
   * never fails the run. At most {@link MAX_STORED_ANNOTATIONS} items are kept.
   */
  async function persistHighlights(input: {
    documentId: string
    runId: string
    model: { provider: string; model: string }
    selected: readonly Candidate[]
  }): Promise<PersistResult> {
    const result: PersistResult = { ids: [], created: 0, failed: false }
    if (input.selected.length === 0) return result
    const createdAt = new Date().toISOString()
    /** Append the non-duplicate candidates to one annotation list (in place). */
    function apply(items: Annotation[]): Annotation[] {
      result.ids = input.selected.map(() => null)
      result.created = 0
      for (let index = 0; index < input.selected.length; index += 1) {
        const candidate = input.selected[index]
        if (candidate === undefined) continue
        if (items.length >= MAX_STORED_ANNOTATIONS) break
        if (findDuplicateAnnotation(items, candidate) !== null) continue
        const annotation = toAnnotation(candidate, {
          documentId: input.documentId,
          runId: input.runId,
          model: input.model,
          createdAt,
        })
        items.push(annotation)
        result.ids[index] = annotation.id
        result.created += 1
      }
      return items
    }
    if (typeof store.mutateAnnotations === 'function') {
      try {
        const persisted = await store.mutateAnnotations(input.documentId, (current) =>
          apply(Array.isArray(current) ? current.slice() : []),
        )
        const persistedItems = Array.isArray(persisted?.items) ? persisted.items : []
        const persistedIds = new Set(persistedItems.map((item) => item?.id))
        result.ids = result.ids.map((id) => (id !== null && persistedIds.has(id) ? id : null))
        result.created = result.ids.filter((id) => id !== null).length
      } catch (error) {
        log.warn?.('[dsh-litnotes] cannot save deep-read annotations: %s', (error as Error)?.message ?? error)
        result.ids = input.selected.map(() => null)
        result.created = 0
        result.failed = true
      }
      return result
    }
    if (typeof store.saveAnnotations !== 'function' || typeof store.loadAnnotations !== 'function') return result
    let existing: Annotation[] = []
    try {
      const envelope = await store.loadAnnotations(input.documentId)
      existing = envelope !== null && typeof envelope === 'object' && Array.isArray(envelope.items) ? envelope.items : []
    } catch (error) {
      // Never overwrite an annotation list we could not read.
      log.warn?.('[dsh-litnotes] cannot load annotations for deep-read highlighting: %s', (error as Error)?.message ?? error)
      result.failed = true
      return result
    }
    const payload = apply(existing.slice(0, MAX_STORED_ANNOTATIONS))
    if (result.created === 0) return result
    try {
      await store.saveAnnotations(input.documentId, { items: payload })
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot save deep-read annotations: %s', (error as Error)?.message ?? error)
      result.ids = input.selected.map(() => null)
      result.created = 0
      result.failed = true
    }
    return result
  }

  /** Write one record (best effort: the streamed report is already delivered). */
  async function writeRecord(documentId: string, record: DeepReadRecord): Promise<void> {
    try {
      await store.writeAux(documentId, DEEPREAD_FILE, record)
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot persist deep-read record: %s', (error as Error)?.message ?? error)
    }
  }

  /** Build one highlight from a selected candidate and its annotation id. */
  function toHighlight(candidate: Candidate, annotationId: string): DeepReadHighlight {
    return {
      annotationId,
      blockKey: candidate.blockKey,
      quote: candidate.quote,
      start: candidate.start,
      end: candidate.end,
      page: candidate.page,
      aspect: candidate.aspect,
      note: candidate.note,
      importance: candidate.importance,
      section: candidate.section,
      kind: unitKindForAspect(candidate.aspect),
    }
  }

  /** Map any thrown value to one public error frame (never leaks prompt text). */
  function errorFrame(error: unknown): DeepReadFrame {
    if (error instanceof AiError) return { type: 'error', code: error.code, message: error.message }
    const code = isObject(error) && typeof error.code === 'string' ? error.code : ''
    if (code !== '') {
      return {
        type: 'error',
        code,
        message:
          typeof (error as { message?: string }).message === 'string' && (error as { message: string }).message !== ''
            ? (error as { message: string }).message.slice(0, 500)
            : '精读失败（Deep read failed）',
      }
    }
    log.warn?.(
      '[dsh-litnotes] deep-read run failed: %s',
      (error as { stack?: string })?.stack ?? (error as { message?: string })?.message ?? String(error),
    )
    return { type: 'error', code: 'host-error', message: '精读服务内部错误（Deep-read service error）' }
  }

  /**
   * Read the persisted deep-read record for one document.
   * @param documentId - document id.
   * @returns the record, or null when never deep-read / unreadable.
   */
  async function get(documentId: string): Promise<DeepReadRecord | null> {
    const id = typeof documentId === 'string' ? documentId.trim() : ''
    if (id === '' || id.length > 200) return null
    return readRecord(id)
  }

  /**
   * Run (or replay) the close-reading workflow and stream its frames.
   *
   * The generator never throws: failures are `{type:'error'}` frames. Frames:
   * `start` → `progress` (mapping / reading / gaps / judging / synthesizing /
   * annotating / done) → `report` → `annotations` → `usage` → `done`.
   *
   * @param documentId - document id.
   * @param options - abort signal, force re-run flag and the reader language.
   * @returns NDJSON frame objects.
   */
  async function* run(
    documentId: string,
    options: { signal?: AbortSignal | undefined; force?: boolean | undefined; language?: string | undefined } = {},
  ): AsyncGenerator<DeepReadFrame> {
    const startedAt = Date.now()
    const signal = options.signal
    try {
      const docId = requireDocumentId(documentId)
      const force = options.force === true
      const language = normalizeLanguage(options.language)
      if (isAborted(signal)) throw abortFailure()

      // Cached replay: the persisted record, no model call at all.
      if (!force) {
        const cached = await readRecord(docId)
        if (cached !== null) {
          yield { type: 'progress', phase: 'mapping', done: 0, total: 1 }
          yield { type: 'progress', phase: 'done', done: 1, total: 1 }
          yield { type: 'report', record: cached }
          yield { type: 'annotations', created: 0, highlights: cached.highlights }
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
          yield { type: 'done' }
          return
        }
      }

      if (!gatewayAvailable()) {
        throw new AiError('llm-unavailable', '当前配置没有可用的语言模型（No LLM route available）')
      }
      const modelRoute = routeOf()
      if (modelRoute === null) {
        throw new AiError('llm-unavailable', '当前配置没有可用的语言模型（No LLM route available）')
      }
      yield { type: 'start', model: modelRoute, language }

      const loaded = await loadDocument(docId)
      if (isAborted(signal)) throw abortFailure()
      if (loaded.markdown.trim() === '') {
        throw new AiError('bad-request', '文档没有可读取的正文（The document has no parsed text）')
      }
      const document = prepareDocument({
        documentId: docId,
        title: documentTitle(docId),
        markdown: loaded.markdown,
        contentList: loaded.contentList,
        config: readingConfig,
      })
      const state = createRunState(document, startedAt)

      // Stage 1: reading map (one call, deterministic fallback).
      const map = yield* mapPass(state, { document, language, signal })
      applyMapRoles(document.sections, map)
      refreshChunkRoles(document)
      document.contentSectionIds = contentSectionIdsOf(document.sections, document.title)

      // Stage 2: sequential close reading of the selected chunks.
      const reading = yield* readingPass(state, {
        pass: 'read',
        chunks: document.selected,
        document,
        map,
        language,
        signal,
      })
      if (document.selected.length > 0 && reading.failures >= document.selected.length) {
        throw new AiError('llm-failed', '每一节精读都失败了（The model failed on every section）')
      }

      // Stage 3: coverage / gap pass.
      yield* gapPass(state, { document, map, language, signal })

      // Stage 4: optional adjudication (fail-open).
      const judged = yield* judgePass(state, state.candidates, signal)

      // Stage 5: deterministic dedupe / coverage ranking / cap.
      const existing = await readAnnotations(docId)
      const selected = selectCandidates({
        candidates: judged,
        existing,
        document,
        maxAnnotations: readingConfig.maxAnnotations,
      })
      if (isAborted(signal)) throw abortFailure()

      // Stage 6: report synthesis (model call + deterministic fallback).
      const report = yield* synthesisPass(state, { document, map, language, selected, signal })
      if (isAborted(signal)) throw abortFailure()

      // Stage 7: persist annotations and the record atomically per document.
      yield { type: 'progress', phase: 'annotating', done: 0, total: 1 }
      const runId = randomUUID()
      const persisted = await queueDoc(docId, async () => {
        const annotationResult = await persistHighlights({
          documentId: docId,
          runId,
          model: modelRoute,
          selected,
        })
        const highlights = selected.map((candidate, index) =>
          toHighlight(candidate, annotationResult.ids[index] ?? ''),
        )
        state.stats.kept = highlights.length
        state.stats.skipped = Math.max(0, state.stats.candidates - highlights.length)
        state.stats.sectionsRead = state.readSectionIds.size
        state.stats.coverage = coverageOf(document, selected)
        state.stats.durationMs = Date.now() - startedAt
        const record: DeepReadRecord = {
          version: 1,
          documentId: docId,
          generatedAt: new Date().toISOString(),
          language,
          model: modelRoute,
          promptVersion: DEEPREAD_PROMPT_VERSION,
          report,
          highlights,
          stats: state.stats,
        }
        await writeRecord(docId, record)
        return { record, highlights, created: annotationResult.created }
      })
      if (isAborted(signal)) throw abortFailure()

      yield { type: 'progress', phase: 'annotating', done: 1, total: 1 }
      yield { type: 'progress', phase: 'done', done: 1, total: 1 }
      yield { type: 'report', record: persisted.record }
      yield { type: 'annotations', created: persisted.created, highlights: persisted.highlights }
      yield {
        type: 'usage',
        usage: { inputTokens: state.stats.inputTokens, outputTokens: state.stats.outputTokens },
      }
      yield { type: 'done' }
    } catch (error) {
      yield errorFrame(error)
    }
  }

  return { get, run }
}
