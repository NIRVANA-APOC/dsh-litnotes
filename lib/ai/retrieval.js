/**
 * Lexical retrieval over parsed document blocks for dsh-litnotes.
 *
 * The retriever is the grounding layer between the reader parser
 * (`ui/markdown.js`, also used by the client) and the model prompts. It turns
 * the parser's block model into a small BM25-ish index (ASCII words + CJK
 * bigrams — no embeddings, no dependencies, offline-friendly), caches it per
 * document keyed by markdown content signature, and builds a bounded, stable
 * context window for one question:
 *
 *  - the title/abstract head is always present,
 *  - the reader's focus block and selection are always present,
 *  - the top lexical matches are expanded with their neighbours,
 *  - blocks are ordered by position in the document (prompt stability),
 *  - the total character budget is enforced.
 *
 * Page numbers come from the same `appendPageMarks()` pass the client uses, so
 * a citation page matches what the reader sees.
 *
 * @module lib/ai/retrieval
 */
import { AiError } from './llm.js'
import {
  appendPageMarks as markdownAppendPageMarks,
  parseMarkdown as markdownParseMarkdown,
  plainTextOfBlock as markdownPlainTextOfBlock,
} from '../../ui/markdown.js'

/** Block kinds indexed for retrieval, with their score multipliers. */
const KIND_WEIGHTS = new Map([
  ['heading', 1.5],
  ['paragraph', 1],
  ['quote', 1.1],
  ['list', 1],
  ['table', 0.9],
  ['code', 0.6],
])

/** How many documents keep a built index in memory. */
const MAX_CACHED_DOCUMENTS = 8

/** BM25 parameters. */
const BM25_K1 = 1.2
const BM25_B = 0.75

/** A single block longer than this is truncated inside the prompt context. */
const MAX_CONTEXT_BLOCK_CHARS = 4000

/** Small English stop-word set; the BM25 IDF already downweights common words. */
const STOPWORDS = new Set([
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

/** Context defaults (docs/AI-SPEC.md §9 `ai.maxContextChars` mirrors this). */
const DEFAULT_TOP_K = 12
const DEFAULT_BUDGET_CHARS = 9000
/** Snippet length returned by {@link createRetriever}'s `.search()`. */
const SNIPPET_CHARS = 360
/** Upper bound for returned outline/section entries. */
const MAX_STRUCTURE_ENTRIES = 60

/** FNV-1a 32-bit hash as 8 hex characters (cache signatures only). */
function hashText(value) {
  const text = String(value ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Clamp a finite integer into range with a fallback. */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Normalize whitespace for quote/selection matching. */
function normalizeMatchText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Tokenize text into ASCII words (lowercase, punctuation-split) and CJK bigrams.
 * Single CJK characters also count so one-character queries remain searchable.
 * @param {unknown} value - text to tokenize.
 * @returns {string[]} tokens (duplicates preserved: they are term frequencies).
 */
function tokenize(value) {
  const text = String(value ?? '').toLowerCase()
  const tokens = []
  const words = text.match(/[a-z0-9]+/g)
  if (words !== null) {
    for (const word of words) {
      if (word.length === 1 && !/^[0-9]$/.test(word)) continue
      if (STOPWORDS.has(word)) continue
      tokens.push(word)
    }
  }
  const cjkRuns = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)
  if (cjkRuns !== null) {
    for (const run of cjkRuns) {
      if (run.length === 1) {
        tokens.push(run)
        continue
      }
      for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
    }
  }
  return tokens
}

/** Count term frequencies for one block. */
function termFrequencies(tokens) {
  const counts = new Map()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/** Build a short search snippet centred on the first query-term hit. */
function makeSnippet(text, queryTokens) {
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

/** Make one cache entry's public block shape (JSON-safe). */
function publicBlock(entry) {
  return {
    key: entry.key,
    index: entry.index,
    kind: entry.kind,
    page: entry.page,
    section: entry.section,
    text: entry.text,
  }
}

/** Build a public context block (context-specific, with score). */
function contextBlock(entry, score) {
  return {
    key: entry.key,
    index: entry.index,
    kind: entry.kind,
    page: entry.page,
    section: entry.section,
    text: entry.text,
    score,
  }
}

/** Resolve a `selection` option to `{ blockKey, quote }`. */
function normalizeSelection(selection) {
  if (typeof selection === 'string') return { blockKey: '', quote: selection }
  if (selection === null || typeof selection !== 'object') return { blockKey: '', quote: '' }
  const blockKey = typeof selection.blockKey === 'string' ? selection.blockKey.trim() : ''
  const quote = typeof selection.quote === 'string' ? selection.quote : ''
  return { blockKey, quote }
}

/**
 * Create the lexical retriever.
 *
 * @param {{
 *   parseMarkdown?: Function,
 *   plainTextOfBlock?: Function,
 *   appendPageMarks?: Function,
 *   logger?: { warn?: Function, debug?: Function },
 * }} [dependencies] - injectable parser helpers (defaults: `ui/markdown.js`).
 * @returns {{
 *   buildIndex(input: object): object,
 *   blocks(input: object): object[],
 *   context(input: object): object,
 *   search(input: object, query: string, limit?: number): object[],
 *   invalidate(documentId?: string): void,
 * }} the retriever facade.
 */
export function createRetriever({ parseMarkdown, plainTextOfBlock, appendPageMarks, logger } = {}) {
  const log = logger ?? {}
  const parse = typeof parseMarkdown === 'function' ? parseMarkdown : markdownParseMarkdown
  const plainText = typeof plainTextOfBlock === 'function' ? plainTextOfBlock : markdownPlainTextOfBlock
  const appendMarks = typeof appendPageMarks === 'function' ? appendPageMarks : markdownAppendPageMarks

  /** @type {Map<string, { index: object, signature: string }>} */
  const cache = new Map()

  /** Refresh LRU position and evict the oldest entry beyond the cache cap. */
  function touchCache(documentId, value) {
    cache.delete(documentId)
    cache.set(documentId, value)
    while (cache.size > MAX_CACHED_DOCUMENTS) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  /** Signature of the parser input; a changed markdown rebuilds the index. */
  function signatureOf(markdown, contentList) {
    const listLength = Array.isArray(contentList) ? contentList.length : -1
    return `${markdown.length}:${hashText(markdown)}:${listLength}`
  }

  /** Validate the shared index input and derive the content signature. */
  function normalizeInput(input) {
    if (input === null || typeof input !== 'object') {
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
  function buildInternal(input) {
    let model
    try {
      model = parse(input.markdown)
    } catch (error) {
      throw new AiError('bad-request', '无法解析文档内容（Cannot parse the document）', error?.message ?? String(error))
    }
    if (model === null || typeof model !== 'object' || !Array.isArray(model.blocks)) {
      throw new AiError('bad-request', '文档解析结果无效（Invalid parsed document model）')
    }
    let blocks = model.blocks
    if (input.contentList !== null && input.contentList.length > 0) {
      try {
        const marked = appendMarks(model, input.contentList)
        if (marked !== null && typeof marked === 'object' && Array.isArray(marked.blocks)) blocks = marked.blocks
      } catch (error) {
        log.warn?.('[dsh-litnotes] page-mark pass failed: %s', error?.message ?? error)
      }
    }
    const entries = []
    const byKey = new Map()
    /** @type {Array<{ level: number, text: string }>} */
    const headingStack = []
    let page = null
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.kind === 'page') {
        const value = Number(block.page)
        if (Number.isFinite(value) && value > 0) page = Math.trunc(value)
        continue
      }
      if (block.kind === 'heading') {
        const level = Number.isInteger(block.level) ? Math.min(Math.max(block.level, 1), 6) : 1
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) headingStack.pop()
        const headingText = typeof block.plainText === 'string' ? block.plainText.trim() : ''
        headingStack.push({ level, text: headingText })
      }
      if (!KIND_WEIGHTS.has(block.kind)) continue
      let text = typeof block.plainText === 'string' ? block.plainText : ''
      if (text === '') {
        try {
          text = plainText(block)
        } catch {
          text = ''
        }
      }
      if (typeof text !== 'string' || text.trim() === '') continue
      const tokens = termFrequencies(tokenize(text))
      const sectionParts = []
      for (const heading of headingStack.slice(-2)) if (heading.text !== '') sectionParts.push(heading.text)
      const entry = {
        order: entries.length,
        index: Number.isInteger(block.index) ? block.index : entries.length,
        key: typeof block.key === 'string' ? block.key : '',
        kind: block.kind,
        level: block.kind === 'heading' ? (Number.isInteger(block.level) ? block.level : 1) : undefined,
        page,
        section: sectionParts.join(' > '),
        text,
        tokens,
        length: Math.max(1, text.length),
      }
      entries.push(entry)
      if (entry.key !== '') byKey.set(entry.key, entry)
    }
    const documentFrequency = new Map()
    for (const entry of entries) {
      for (const token of entry.tokens.keys()) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
      }
    }
    const averageLength =
      entries.length === 0
        ? 1
        : entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length
    const outlineSource =
      input.outline !== null && input.outline.length > 0
        ? input.outline
        : Array.isArray(model.outline)
          ? model.outline
          : []
    const outline = []
    for (const entry of outlineSource.slice(0, MAX_STRUCTURE_ENTRIES)) {
      if (entry === null || typeof entry !== 'object') continue
      outline.push({
        key: typeof entry.key === 'string' ? entry.key : '',
        level: Number.isInteger(entry.level) ? entry.level : 1,
        text: typeof entry.text === 'string' ? entry.text : '',
      })
    }
    const sections = entries
      .filter((entry) => entry.kind === 'heading')
      .slice(0, MAX_STRUCTURE_ENTRIES)
      .map((entry) => ({ key: entry.key, level: entry.level ?? 1, text: entry.text, page: entry.page }))
    return {
      documentId: input.documentId,
      signature: input.signature,
      entries,
      byKey,
      outline,
      sections,
      totalBlocks: entries.length,
      averageLength,
      documentFrequency,
    }
  }

  /** Get (or build and cache) the rich index for one document. */
  function ensureIndex(input) {
    const normalized = normalizeInput(input)
    const cached = cache.get(normalized.documentId)
    if (cached !== undefined && cached.signature === normalized.signature) {
      touchCache(normalized.documentId, cached)
      return cached.index
    }
    const index = buildInternal(normalized)
    touchCache(normalized.documentId, { index, signature: normalized.signature })
    return index
  }

  /** BM25-ish score of one block against the query token list. */
  function scoreEntry(index, entry, queryTokens) {
    let score = 0
    for (const token of queryTokens) {
      const frequency = entry.tokens.get(token)
      if (frequency === undefined) continue
      const df = index.documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (index.totalBlocks - df + 0.5) / (df + 0.5))
      const denominator =
        frequency + BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / index.averageLength)
      score += idf * ((frequency * (BM25_K1 + 1)) / (denominator === 0 ? 1 : denominator))
    }
    return score * (KIND_WEIGHTS.get(entry.kind) ?? 1)
  }

  /** Round scores to keep JSON frames/tests deterministic. */
  function roundScore(score) {
    return Math.round(score * 1000) / 1000
  }

  /** Find the block containing a quote (selection fallback when no blockKey). */
  function findSelectionEntry(index, selection) {
    const key = typeof selection.blockKey === 'string' ? selection.blockKey.trim() : ''
    if (key !== '' && index.byKey.has(key)) return index.byKey.get(key)
    const quote = normalizeMatchText(selection.quote).toLowerCase()
    if (quote === '') return null
    for (const entry of index.entries) {
      if (normalizeMatchText(entry.text).toLowerCase().includes(quote)) return entry
    }
    return null
  }

  /** Build the public index view. */
  function buildIndex(input) {
    const index = ensureIndex(input)
    return {
      documentId: index.documentId,
      signature: index.signature,
      totalBlocks: index.totalBlocks,
      outline: index.outline,
      sections: index.sections,
      blocks: index.entries.map(publicBlock),
    }
  }

  /** All text blocks of one document (ordered), useful for citation lookups. */
  function blocks(input) {
    const index = ensureIndex(input)
    return index.entries.map(publicBlock)
  }

  /**
   * Build the bounded context window for one question.
   *
   * @param {{
   *   documentId: string, markdown: string, contentList?: object[],
   *   question?: string, focusBlockKey?: string,
   *   selection?: string | { blockKey?: string, quote?: string },
   *   topK?: number, budgetChars?: number,
   * }} input - document + question/focus.
   * @returns {{
   *   blocks: object[], outline: object[], sections: object[],
   *   usedChars: number, totalBlocks: number,
   * }} context blocks ordered by document position.
   */
  function context(input = {}) {
    const index = ensureIndex(input)
    const topK = clampInt(input.topK, 1, 40, DEFAULT_TOP_K)
    const budgetChars = clampInt(input.budgetChars, 500, 64000, DEFAULT_BUDGET_CHARS)
    const empty = {
      blocks: [],
      outline: index.outline,
      sections: index.sections,
      usedChars: 0,
      totalBlocks: index.totalBlocks,
    }
    if (index.totalBlocks === 0) return empty

    const question = typeof input.question === 'string' ? input.question : ''
    const queryTokens = tokenize(question)
    /** @type {Map<number, { entry: object, score: number, reason: string }>} */
    const picked = new Map()
    function add(entry, score, reason) {
      if (entry === null || entry === undefined) return
      const existing = picked.get(entry.order)
      if (existing === undefined || existing.score < score) {
        picked.set(entry.order, { entry, score, reason })
      }
    }

    // The title/abstract head is always present so the model knows the paper.
    for (const entry of index.entries.slice(0, 3)) add(entry, 1000 - entry.order, 'head')
    // Reader focus and selection are always present.
    const focusKey = typeof input.focusBlockKey === 'string' ? input.focusBlockKey.trim() : ''
    if (focusKey !== '' && index.byKey.has(focusKey)) add(index.byKey.get(focusKey), 900, 'focus')
    const selection = normalizeSelection(input.selection)
    const selectionEntry = findSelectionEntry(index, selection)
    if (selectionEntry !== null) add(selectionEntry, 899, 'selection')

    // Top lexical matches.
    const scored = []
    if (queryTokens.length > 0) {
      for (const entry of index.entries) {
        const score = scoreEntry(index, entry, queryTokens)
        if (score > 0) scored.push({ entry, score })
      }
      scored.sort((left, right) => right.score - left.score || left.entry.order - right.entry.order)
      for (const item of scored.slice(0, topK)) add(item.entry, item.score, 'match')
      // Neighbours of the strongest hits keep local context coherent.
      for (const item of scored.slice(0, 4)) {
        for (const delta of [-1, 1]) {
          const order = item.entry.order + delta
          if (order < 0 || order >= index.entries.length) continue
          add(index.entries[order], item.score * 0.35, 'neighbour')
        }
      }
    }

    const ordered = [...picked.values()].sort((left, right) => left.entry.order - right.entry.order)
    const blocks = []
    let usedChars = 0
    for (const item of ordered) {
      const entry = item.entry
      let text = entry.text
      if (text.length > MAX_CONTEXT_BLOCK_CHARS) text = text.slice(0, MAX_CONTEXT_BLOCK_CHARS).trimEnd()
      // Rough per-block prompt overhead: `[[key]] (page N) ` + newline.
      const overhead = (entry.key.length + 24) | 0
      if (usedChars + text.length + overhead > budgetChars && blocks.length > 0) {
        if (item.reason === 'match' || item.reason === 'neighbour') continue
        const remaining = budgetChars - usedChars - overhead
        if (remaining < 160) continue
        text = text.slice(0, remaining).trimEnd()
      }
      if (text === '') continue
      usedChars += text.length
      blocks.push(contextBlock(entry, roundScore(item.score)))
    }
    if (blocks.length === 0) {
      // Degenerate budget: always return the first block so the model sees text.
      const first = index.entries[0]
      const text = first.text.slice(0, Math.max(80, budgetChars)).trimEnd()
      blocks.push(contextBlock(first, roundScore(0)))
      usedChars = text.length
    }
    return {
      blocks,
      outline: index.outline,
      sections: index.sections,
      usedChars,
      totalBlocks: index.totalBlocks,
    }
  }

  /**
   * Lexically search one document (for agent tools and quick lookups).
   *
   * @param {{ documentId: string, markdown: string, contentList?: object[] }} input - document.
   * @param {string} query - search text.
   * @param {number} [limit] - maximum results (1-50, default 20).
   * @returns {object[]} matching blocks with snippets and coordinates.
   */
  function search(input = {}, query, limit = 20) {
    const index = ensureIndex(input)
    const text = typeof query === 'string' ? query.trim() : ''
    if (text === '') return []
    const queryTokens = tokenize(text)
    if (queryTokens.length === 0) return []
    const maximum = clampInt(limit, 1, 50, 20)
    const scored = []
    for (const entry of index.entries) {
      const score = scoreEntry(index, entry, queryTokens)
      if (score > 0) scored.push({ entry, score })
    }
    scored.sort((left, right) => right.score - left.score || left.entry.order - right.entry.order)
    return scored.slice(0, maximum).map((item) => ({
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
   * @param {string} [documentId] - document id.
   * @returns {void}
   */
  function invalidate(documentId) {
    if (typeof documentId !== 'string' || documentId.trim() === '') {
      cache.clear()
      return
    }
    cache.delete(documentId.trim())
  }

  return { buildIndex, blocks, context, search, invalidate }
}
