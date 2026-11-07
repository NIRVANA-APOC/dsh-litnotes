/**
 * Lexical retrieval over parsed document blocks for dsh-litnotes.
 *
 * The retriever is the grounding layer between the shared reading-block model
 * (`src/shared/markdown/**`, also used by the client) and the model prompts.
 * Scoring is delegated to **MiniSearch** (BM25+ with prefix search) over a
 * custom tokenizer: ASCII words (stop-worded) plus CJK segmentation through
 * `Intl.Segmenter`, so bilingual documents rank correctly without embeddings or
 * extra dependencies. The index is cached per document keyed by a content
 * signature and the context window is assembled deterministically:
 *
 *  - the title/abstract head is always present,
 *  - the reader's focus block and selection are always present,
 *  - the top lexical matches are expanded with their neighbours,
 *  - blocks are ordered by position in the document (prompt stability),
 *  - the total character budget is enforced.
 *
 * Page numbers come from the shared `appendPageMarks()` pass the client uses, so
 * a citation page matches what the reader sees.
 *
 * @module host/ai/retrieval
 */

import MiniSearch from 'minisearch'
import { AiError } from './llm.ts'
import { appendPageMarks, parseMarkdown } from '../../shared/markdown/parse.ts'
import { plainTextOfBlock, type Block, type PaperModel } from '../../shared/markdown/model.ts'
import type { RetrieverApi, RetrievedBlock, RetrievedContext } from '../contracts.ts'
import type { ContentListEntry } from '../../shared/model.ts'
import type { Logger } from '../host-services.ts'

/** Block kinds indexed for retrieval, with their score multipliers. */
const KIND_WEIGHTS: ReadonlyMap<string, number> = new Map([
  ['heading', 1.5],
  ['paragraph', 1],
  ['quote', 1.1],
  ['list', 1],
  ['table', 0.9],
  ['code', 0.6],
])

/** How many documents keep a built index in memory. */
const MAX_CACHED_DOCUMENTS = 8

/** A single block longer than this is truncated inside the prompt context. */
const MAX_CONTEXT_BLOCK_CHARS = 4000

/** Small English stop-word set; the BM25 IDF already downweights common words. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
  'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'may', 'me', 'might', 'more',
  'most', 'must', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so',
  'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
])

/** Context defaults (`ai.maxContextChars` mirrors `DEFAULT_BUDGET_CHARS`). */
const DEFAULT_TOP_K = 12
const DEFAULT_BUDGET_CHARS = 9000
/** Snippet length returned by {@link Retriever.search}. */
const SNIPPET_CHARS = 360
/** Upper bound for returned outline/section entries. */
const MAX_STRUCTURE_ENTRIES = 60

/**
 * CJK word segmenter. `Intl.Segmenter` uses ICU dictionaries, which handles
 * Chinese/Japanese/Korean runs far better than fixed-size bigrams while still
 * being deterministic for a given Node build (the plugin supports Node ≥ 20
 * with full ICU).
 */
const CJK_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

/** FNV-1a 32-bit hash as 8 hex characters (cache signatures only). */
function hashText(value: unknown): string {
  const text = String(value ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Clamp a finite integer into range with a fallback. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Normalize whitespace for quote/selection matching. */
export function normalizeMatchText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Tokenize text into ASCII words (lowercase, punctuation-split, stop-worded)
 * and CJK words. CJK runs are segmented with `Intl.Segmenter`; single-character
 * runs and very short query terms still become searchable tokens.
 *
 * @param value - text to tokenize.
 * @returns tokens (duplicates preserved: MiniSearch derives term frequencies).
 */
export function tokenize(value: unknown): string[] {
  const text = String(value ?? '').toLowerCase()
  const tokens: string[] = []
  const ascii = text.match(/[a-z0-9]+/g)
  if (ascii !== null) {
    for (const word of ascii) {
      if (word.length === 1 && !/^[0-9]$/.test(word)) continue
      if (STOPWORDS.has(word)) continue
      tokens.push(word)
    }
  }
  // CJK runs: segment each contiguous run so mixed Chinese/English lines keep
  // their word boundaries while punctuation still separates segments.
  const cjkRuns = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g)
  if (cjkRuns !== null) {
    for (const run of cjkRuns) {
      if (run.length === 1) {
        tokens.push(run)
        continue
      }
      for (const segment of CJK_SEGMENTER.segment(run)) {
        const word = segment.segment
        if (word.trim() === '') continue
        // Keep single-ideograph segments (some segmenters drop particles).
        tokens.push(word)
      }
    }
  }
  return tokens
}

/** One indexed block (the retriever's internal cache entry + public view). */
export interface IndexedBlock {
  order: number
  index: number
  key: string
  kind: string
  page: number | null
  section: string | null
  text: string
}

/** Public view of a built index. */
export interface RetrievalIndexView {
  documentId: string
  signature: string
  totalBlocks: number
  outline: Array<{ key: string; level: number; text: string }>
  sections: string[]
  blocks: IndexedBlock[]
}

/** A built index plus the MiniSearch instance that ranks it. */
interface CachedIndex {
  documentId: string
  signature: string
  entries: IndexedBlock[]
  byKey: Map<string, IndexedBlock>
  outline: Array<{ key: string; level: number; text: string }>
  sections: string[]
  search: MiniSearch<{ id: number; text: string; kind: string }>
}

/** Input accepted by every retriever method. */
export interface RetrieverInput {
  documentId: string
  markdown: string
  contentList?: readonly unknown[] | null | undefined
  outline?: ReadonlyArray<{ key?: unknown; level?: unknown; text?: unknown }> | null | undefined
}

/** Context request. */
export interface RetrieverContextInput extends RetrieverInput {
  question?: unknown
  focusBlockKey?: unknown
  selection?: string | { blockKey?: unknown; quote?: unknown } | null | undefined
  topK?: unknown
  budgetChars?: unknown
}

/** Search request (the contract carries query/limit in the input object). */
export interface RetrieverSearchInput extends RetrieverInput {
  query?: unknown
  limit?: unknown
}

/** A search hit: contract block plus the `blockKey` alias agent tools use. */
export interface SearchResultBlock extends RetrievedBlock {
  blockKey: string
}

/** The concrete retriever facade (contract API plus index helpers). */
export interface Retriever extends RetrieverApi {
  buildIndex: (input: RetrieverInput) => RetrievalIndexView
  blocks: (input: RetrieverInput) => IndexedBlock[]
  context: (input: RetrieverContextInput) => RetrievedContext
  search: (input: RetrieverSearchInput) => SearchResultBlock[]
  invalidate: (documentId?: string) => void
}

/** Injectable parser helpers (defaults: the shared paper model). */
export interface RetrieverDeps {
  logger?: Logger | undefined
  parseMarkdown?: ((markdown: string) => PaperModel) | undefined
  plainTextOfBlock?: ((block: Block) => string) | undefined
  appendPageMarks?: ((model: PaperModel, contentList: readonly ContentListEntry[] | null) => PaperModel) | undefined
}

/** Build a short search snippet centred on the first query-term hit. */
function makeSnippet(text: unknown, queryTokens: readonly string[]): string {
  const plain = String(text ?? '')
  if (plain === '') return ''
  if (plain.length <= SNIPPET_CHARS) return plain
  const lower = plain.toLowerCase()
  let hit = -1
  for (const token of queryTokens) {
    const found = lower.indexOf(token)
    if (found !== -1 && (hit === -1 || found < hit)) hit = found
  }
  const half = Math.floor((SNIPPET_CHARS - 40) / 2)
  let start = hit === -1 ? 0 : Math.max(0, hit - half)
  const end = Math.min(plain.length, start + SNIPPET_CHARS)
  if (end === plain.length) start = Math.max(0, end - SNIPPET_CHARS)
  let snippet = plain.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < plain.length) snippet = `${snippet}…`
  return snippet
}

/** Round scores to keep JSON frames/tests deterministic. */
function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000
}

/**
 * Create the lexical retriever.
 *
 * @param deps - injectable parser helpers and logger.
 * @returns the retriever facade.
 */
export function createRetriever(deps: RetrieverDeps = {}): Retriever {
  const log = deps.logger ?? {}
  const parse = deps.parseMarkdown ?? parseMarkdown
  const plainText = deps.plainTextOfBlock ?? plainTextOfBlock
  const appendMarks = deps.appendPageMarks ?? appendPageMarks

  /** documentId → cached index (LRU order). */
  const cache = new Map<string, CachedIndex>()

  /** Refresh LRU position and evict the oldest entry beyond the cache cap. */
  function touchCache(documentId: string, value: CachedIndex): void {
    cache.delete(documentId)
    cache.set(documentId, value)
    while (cache.size > MAX_CACHED_DOCUMENTS) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  /** Signature of the parser input; a changed markdown rebuilds the index. */
  function signatureOf(markdown: string, contentList: unknown): string {
    const listLength = Array.isArray(contentList) ? contentList.length : -1
    return `${markdown.length}:${hashText(markdown)}:${listLength}`
  }

  /** Validate the shared index input and derive the content signature. */
  function normalizeInput(input: RetrieverInput | null | undefined): {
    documentId: string
    markdown: string
    contentList: readonly unknown[] | null
    outline: ReadonlyArray<{ key?: unknown; level?: unknown; text?: unknown }> | null
    signature: string
  } {
    if (input === null || input === undefined || typeof input !== 'object') {
      throw new AiError('bad-request', '缺少检索参数（Missing retrieval input）')
    }
    const documentId = typeof input.documentId === 'string' ? input.documentId.trim() : ''
    if (documentId === '') throw new AiError('bad-request', '缺少文档 ID（Missing documentId）')
    const markdown = typeof input.markdown === 'string' ? input.markdown : ''
    return {
      documentId,
      markdown,
      contentList: Array.isArray(input.contentList) ? input.contentList : null,
      outline: Array.isArray(input.outline) ? input.outline : null,
      signature: signatureOf(markdown, input.contentList),
    }
  }

  /** Build the rich index structure (not exposed directly). */
  function buildInternal(input: ReturnType<typeof normalizeInput>): CachedIndex {
    let model: PaperModel
    try {
      model = parse(input.markdown)
    } catch (error) {
      throw new AiError(
        'bad-request',
        '无法解析文档内容（Cannot parse the document）',
        (error as Error)?.message ?? String(error),
      )
    }
    if (model === null || typeof model !== 'object' || !Array.isArray(model.blocks)) {
      throw new AiError('bad-request', '文档解析结果无效（Invalid parsed document model）')
    }
    let blocks: readonly Block[] = model.blocks
    if (input.contentList !== null && input.contentList.length > 0) {
      try {
        // The retriever input keeps MinerU's content list opaque; the shared
        // page-mark pass validates every entry at runtime.
        const marked = appendMarks(model, input.contentList as readonly ContentListEntry[])
        if (marked !== null && typeof marked === 'object' && Array.isArray(marked.blocks)) blocks = marked.blocks
      } catch (error) {
        log.warn?.('[dsh-litnotes] page-mark pass failed: %s', (error as Error)?.message ?? error)
      }
    }
    const entries: IndexedBlock[] = []
    const byKey = new Map<string, IndexedBlock>()
    const headingStack: Array<{ level: number; text: string }> = []
    let page: number | null = null
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.kind === 'page') {
        const value = Number(block.page)
        if (Number.isFinite(value) && value > 0) page = Math.trunc(value)
        continue
      }
      if (Number.isFinite(block.page) && (block.page as number) > 0) page = Math.trunc(block.page as number)
      if (block.kind === 'heading') {
        const level = Number.isInteger(block.level) ? Math.min(Math.max(block.level, 1), 6) : 1
        while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= level) {
          headingStack.pop()
        }
        const headingText = block.plainText.trim()
        headingStack.push({ level, text: headingText })
      }
      if (!KIND_WEIGHTS.has(block.kind)) continue
      let text = block.plainText
      if (text === '') {
        try {
          text = plainText(block)
        } catch {
          text = ''
        }
      }
      if (typeof text !== 'string' || text.trim() === '') continue
      const sectionParts: string[] = []
      for (const heading of headingStack.slice(-2)) if (heading.text !== '') sectionParts.push(heading.text)
      const entry: IndexedBlock = {
        order: entries.length,
        index: Number.isInteger(block.index) ? block.index : entries.length,
        key: typeof block.key === 'string' ? block.key : '',
        kind: block.kind,
        page,
        section: sectionParts.length > 0 ? sectionParts.join(' > ') : null,
        text,
      }
      entries.push(entry)
      if (entry.key !== '') byKey.set(entry.key, entry)
    }
    const outlineSource =
      input.outline !== null && input.outline.length > 0
        ? input.outline
        : Array.isArray(model.outline)
          ? model.outline
          : []
    const outline: Array<{ key: string; level: number; text: string }> = []
    for (const entry of outlineSource.slice(0, MAX_STRUCTURE_ENTRIES)) {
      if (entry === null || entry === undefined || typeof entry !== 'object') continue
      outline.push({
        key: typeof entry.key === 'string' ? entry.key : '',
        level: Number.isInteger(entry.level) ? (entry.level as number) : 1,
        text: typeof entry.text === 'string' ? entry.text : '',
      })
    }
    const sections = entries
      .filter((entry) => entry.kind === 'heading')
      .slice(0, MAX_STRUCTURE_ENTRIES)
      .map((entry) => entry.text)
    const search = new MiniSearch<{ id: number; text: string; kind: string }>({
      fields: ['text'],
      idField: 'id',
      tokenize,
      // Exact/prefix matching only: case, accent and word-segmentation rules are
      // handled by the tokenizer above, not by MiniSearch's English pipeline.
      processTerm: (term) => (term === '' ? null : term),
    })
    search.addAll(
      entries.map((entry) => ({
        id: entry.order,
        text: entry.text,
        kind: entry.kind,
      })),
    )
    return {
      documentId: input.documentId,
      signature: input.signature,
      entries,
      byKey,
      outline,
      sections,
      search,
    }
  }

  /** Get (or build and cache) the rich index for one document. */
  function ensureIndex(input: RetrieverInput | null | undefined): CachedIndex {
    const normalized = normalizeInput(input)
    const cached = cache.get(normalized.documentId)
    if (cached !== undefined && cached.signature === normalized.signature) {
      touchCache(normalized.documentId, cached)
      return cached
    }
    const index = buildInternal(normalized)
    touchCache(normalized.documentId, index)
    return index
  }

  /**
   * Rank all blocks for one question (deterministic: score, then position).
   *
   * MiniSearch answers with BM25+ prefix matches; a block is only a real hit
   * when at least one query term occurs in it EXACTLY (the frozen lexical
   * contract — prefix matching must not turn a morphologically similar word
   * like `documents` into a hit for `document`). Prefix matches still shape the
   * score among the blocks that do contain exact query terms.
   */
  function rankBlocks(index: CachedIndex, query: string): Array<{ entry: IndexedBlock; score: number }> {
    const text = typeof query === 'string' ? query.trim() : ''
    if (text === '') return []
    const queryTokens = tokenize(text)
    if (queryTokens.length === 0) return []
    const querySet = new Set(queryTokens)
    const results = index.search.search(text, { prefix: true })
    const scored: Array<{ entry: IndexedBlock; score: number }> = []
    for (const result of results) {
      const order = Number(result.id)
      const entry = index.entries[order]
      if (entry === undefined) continue
      const entryTokens = tokenize(entry.text)
      if (!entryTokens.some((token) => querySet.has(token))) continue
      const score = result.score * (KIND_WEIGHTS.get(entry.kind) ?? 1)
      if (score > 0) scored.push({ entry, score })
    }
    scored.sort((left, right) => right.score - left.score || left.entry.order - right.entry.order)
    return scored
  }

  /** Find the block containing a quote (selection fallback when no blockKey). */
  function findSelectionEntry(
    index: CachedIndex,
    selection: { blockKey: string; quote: string },
  ): IndexedBlock | null {
    const key = selection.blockKey
    if (key !== '' && index.byKey.has(key)) return index.byKey.get(key) ?? null
    const quote = normalizeMatchText(selection.quote).toLowerCase()
    if (quote === '') return null
    for (const entry of index.entries) {
      if (normalizeMatchText(entry.text).toLowerCase().includes(quote)) return entry
    }
    return null
  }

  /** Build the public index view. */
  function buildIndex(input: RetrieverInput): RetrievalIndexView {
    const index = ensureIndex(input)
    return {
      documentId: index.documentId,
      signature: index.signature,
      totalBlocks: index.entries.length,
      outline: index.outline,
      sections: index.sections,
      blocks: index.entries.map((entry) => ({ ...entry })),
    }
  }

  /** All text blocks of one document (ordered), useful for citation lookups. */
  function blocks(input: RetrieverInput): IndexedBlock[] {
    const index = ensureIndex(input)
    return index.entries.map((entry) => ({ ...entry }))
  }

  /** Resolve a `selection` option to `{ blockKey, quote }`. */
  function normalizeSelection(selection: RetrieverContextInput['selection']): { blockKey: string; quote: string } {
    if (typeof selection === 'string') return { blockKey: '', quote: selection }
    if (selection === null || selection === undefined || typeof selection !== 'object') {
      return { blockKey: '', quote: '' }
    }
    return {
      blockKey: typeof selection.blockKey === 'string' ? selection.blockKey.trim() : '',
      quote: typeof selection.quote === 'string' ? selection.quote : '',
    }
  }

  /**
   * Build the bounded context window for one question.
   *
   * @param input - document + question/focus.
   * @returns context blocks ordered by document position.
   */
  function context(input: RetrieverContextInput): RetrievedContext {
    const index = ensureIndex(input)
    const topK = clampInt(input.topK, 1, 40, DEFAULT_TOP_K)
    const budgetChars = clampInt(input.budgetChars, 500, 64000, DEFAULT_BUDGET_CHARS)
    const empty: RetrievedContext = {
      blocks: [],
      outline: index.outline,
      sections: index.sections,
      usedChars: 0,
      totalBlocks: index.entries.length,
    }
    if (index.entries.length === 0) return empty

    const question = typeof input.question === 'string' ? input.question : ''
    /** order → picked entry with its score/reason. */
    const picked = new Map<number, { entry: IndexedBlock; score: number; reason: string }>()
    const add = (entry: IndexedBlock | undefined, score: number, reason: string): void => {
      if (entry === undefined) return
      const existing = picked.get(entry.order)
      if (existing === undefined || existing.score < score) picked.set(entry.order, { entry, score, reason })
    }

    // The title/abstract head is always present so the model knows the paper.
    for (const entry of index.entries.slice(0, 3)) add(entry, 1000 - entry.order, 'head')
    // Reader focus and selection are always present.
    const focusKey = typeof input.focusBlockKey === 'string' ? input.focusBlockKey.trim() : ''
    if (focusKey !== '') add(index.byKey.get(focusKey), 900, 'focus')
    const selectionEntry = findSelectionEntry(index, normalizeSelection(input.selection))
    if (selectionEntry !== null) add(selectionEntry, 899, 'selection')

    // Top lexical matches (MiniSearch BM25+ ranking, kind-weighted).
    const scored = rankBlocks(index, question)
    for (const item of scored.slice(0, topK)) add(item.entry, item.score, 'match')
    // Neighbours of the strongest hits keep local context coherent.
    for (const item of scored.slice(0, 4)) {
      for (const delta of [-1, 1]) {
        const order = item.entry.order + delta
        if (order < 0 || order >= index.entries.length) continue
        add(index.entries[order], item.score * 0.35, 'neighbour')
      }
    }

    const ordered = [...picked.values()].sort((left, right) => left.entry.order - right.entry.order)
    const selected: RetrievedBlock[] = []
    let usedChars = 0
    for (const item of ordered) {
      const entry = item.entry
      let text = entry.text
      if (text.length > MAX_CONTEXT_BLOCK_CHARS) text = text.slice(0, MAX_CONTEXT_BLOCK_CHARS).trimEnd()
      // Rough per-block prompt overhead: `[[key]] (page N) ` + newline.
      const overhead = (entry.key.length + 24) | 0
      if (usedChars + text.length + overhead > budgetChars && selected.length > 0) {
        if (item.reason === 'match' || item.reason === 'neighbour') continue
        const remaining = budgetChars - usedChars - overhead
        if (remaining < 160) continue
        text = text.slice(0, remaining).trimEnd()
      }
      if (text === '') continue
      usedChars += text.length
      selected.push({
        key: entry.key,
        page: entry.page,
        index: entry.index,
        text,
        kind: entry.kind,
        score: roundScore(item.score),
        section: entry.section,
      })
    }
    if (selected.length === 0) {
      // Degenerate budget: always return the first block so the model sees text.
      const first = index.entries[0]
      if (first !== undefined) {
        const text = first.text.slice(0, Math.max(80, budgetChars)).trimEnd()
        selected.push({
          key: first.key,
          page: first.page,
          index: first.index,
          text,
          kind: first.kind,
          score: 0,
          section: first.section,
        })
        usedChars = text.length
      }
    }
    return {
      blocks: selected,
      outline: index.outline,
      sections: index.sections,
      usedChars,
      totalBlocks: index.entries.length,
    }
  }

  /**
   * Lexically search one document (for agent tools and quick lookups).
   *
   * @param input - document plus the search text (`query`) and optional `limit`
   *   (1-50, default 20).
   * @returns matching blocks with snippets and coordinates.
   */
  function search(input: RetrieverSearchInput): SearchResultBlock[] {
    const index = ensureIndex(input)
    const text = typeof input.query === 'string' ? input.query.trim() : ''
    if (text === '') return []
    const queryTokens = tokenize(text)
    if (queryTokens.length === 0) return []
    const maximum = clampInt(input.limit, 1, 50, 20)
    return rankBlocks(index, text)
      .slice(0, maximum)
      .map((item) => ({
        blockKey: item.entry.key,
        key: item.entry.key,
        index: item.entry.index,
        kind: item.entry.kind,
        page: item.entry.page,
        section: item.entry.section,
        score: roundScore(item.score),
        text: makeSnippet(item.entry.text, queryTokens),
      }))
  }

  /**
   * Drop one cached index, or every cached index when no id is given.
   *
   * @param documentId - document id.
   */
  function invalidate(documentId?: string): void {
    if (typeof documentId !== 'string' || documentId.trim() === '') {
      cache.clear()
      return
    }
    cache.delete(documentId.trim())
  }

  return { buildIndex, blocks, context, search, invalidate }
}
