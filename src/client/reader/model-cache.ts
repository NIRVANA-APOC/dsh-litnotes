/**
 * Reader model cache: parse once per `documentId + markdown hash`, derive the
 * page-marked view cheaply.
 *
 * Opening a document fetches its markdown; the reading block model is built
 * off the critical path and cached so re-opening the same paper (scene switch,
 * page-mark toggle) never parses the markdown twice. The shared parser
 * (`src/shared/markdown/parse.ts`) owns correctness; this module owns the
 * lifecycle and the small bounded cache.
 */

import { fnv1a } from '../../shared/markdown/model.ts'
import type { Block, PaperModel } from '../../shared/markdown/model.ts'
import { appendPageMarks, parseMarkdown } from '../../shared/markdown/parse.ts'

/** Maximum number of parsed documents kept in memory (small papers are cheap). */
const MAX_CACHED_MODELS = 4

/** One cached parse, keyed by `documentId:hash`. */
interface CacheEntry {
  model: PaperModel
  /** Insertion order for the bounded eviction (oldest first). */
  order: number
}

const cache = new Map<string, CacheEntry>()
let cacheOrder = 0

/** Page-marked views derived from a base model (content list identity + flag). */
const pageMarkViews = new WeakMap<PaperModel, { contentList: readonly unknown[]; marked: PaperModel }>()

/** Stable cache key of one fetched markdown payload. */
export function modelCacheKey(documentId: string, markdown: string): string {
  return `${documentId}:${fnv1a(markdown)}`
}

/**
 * Parse `markdown` for `documentId`, reusing a cached model when the markdown
 * hash is unchanged. The cache is bounded (oldest entry evicted first).
 */
export function getBaseModel(documentId: string, markdown: string): PaperModel {
  const key = modelCacheKey(documentId, markdown)
  const cached = cache.get(key)
  if (cached !== undefined) {
    cached.order = (cacheOrder += 1)
    return cached.model
  }
  const model = parseMarkdown(markdown)
  cache.set(key, { model, order: (cacheOrder += 1) })
  if (cache.size > MAX_CACHED_MODELS) {
    let oldestKey: string | null = null
    let oldestOrder = Number.POSITIVE_INFINITY
    for (const [candidateKey, entry] of cache) {
      if (entry.order < oldestOrder) {
        oldestOrder = entry.order
        oldestKey = candidateKey
      }
    }
    if (oldestKey !== null) cache.delete(oldestKey)
  }
  return model
}

/**
 * Return the model annotated with synthetic page marks when requested.
 *
 * Page marks clone every block (annotation-stable: keys and indexes are
 * unchanged), so the result is memoized per base-model/content-list pair. When
 * page marks are off the base model is returned as-is.
 */
export function getViewableModel(
  base: PaperModel,
  contentList: readonly unknown[] | null | undefined,
  showPageMarks: boolean,
): PaperModel {
  if (!showPageMarks || !Array.isArray(contentList) || contentList.length === 0) return base
  const cached = pageMarkViews.get(base)
  if (cached !== undefined && cached.contentList === contentList) return cached.marked
  let marked: PaperModel
  try {
    marked = appendPageMarks(base, contentList)
  } catch {
    // Page marks are best effort: a malformed content list must never break the
    // reader (frozen 1.0.0 behaviour).
    marked = base
  }
  pageMarkViews.set(base, { contentList, marked })
  return marked
}

/** Drop one document's cached parse (reparse invalidation) or the whole cache. */
export function invalidateModelCache(documentId?: string): void {
  if (documentId === undefined) {
    cache.clear()
    return
  }
  const prefix = `${documentId}:`
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/** Index of every block key in document order (`orderOf` source). */
export function buildDocumentOrder(model: PaperModel): Map<string, number> {
  const order = new Map<string, number>()
  for (let index = 0; index < model.blocks.length; index += 1) {
    const block = model.blocks[index]
    if (block === undefined || typeof block.key !== 'string' || block.key === '') continue
    order.set(block.key, index)
  }
  return order
}

/** Fast lookup of one block by its stable key. */
export function findBlock(model: PaperModel, blockKey: string): Block | null {
  if (blockKey === '') return null
  for (const block of model.blocks) {
    if (block.key === blockKey) return block
  }
  return null
}

/**
 * Blocks that carry a plain-text offset space and therefore translations and
 * annotations: heading, paragraph, quote and list (frozen `mruIsTextBlock`).
 */
export function isTextBlock(block: Block | null | undefined): boolean {
  if (block === null || block === undefined) return false
  return (
    block.kind === 'heading' ||
    block.kind === 'paragraph' ||
    block.kind === 'quote' ||
    block.kind === 'list'
  )
}

/** Text-bearing, non-empty blocks in document order (translation candidates). */
export function translatableBlocks(model: PaperModel): Block[] {
  const out: Block[] = []
  for (const block of model.blocks) {
    if (!isTextBlock(block)) continue
    if (typeof block.plainText !== 'string' || block.plainText.trim() === '') continue
    out.push(block)
  }
  return out
}

/** Whether any block of the model needs KaTeX (formula block or inline math). */
export function modelNeedsKatex(model: PaperModel): boolean {
  const hasMathRun = (runs: unknown): boolean => {
    if (!Array.isArray(runs)) return false
    return runs.some((run) => run !== null && typeof run === 'object' && (run as { type?: unknown }).type === 'math')
  }
  for (const block of model.blocks) {
    if (block.kind === 'formula') return true
    if ('runs' in block && hasMathRun(block.runs)) return true
    if (block.kind === 'list') {
      for (const item of block.items) if (hasMathRun(item.runs)) return true
    }
    if (block.kind === 'table') {
      for (const cell of block.head) if (hasMathRun(cell.runs)) return true
      for (const row of block.rows) for (const cell of row) if (hasMathRun(cell.runs)) return true
    }
  }
  return false
}
