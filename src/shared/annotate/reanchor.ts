/**
 * Annotation re-anchoring after a (re)parse.
 *
 * An annotation stores `{ blockKey, start, end, quote }`. A full reparse or a
 * page-scoped repair can change block keys, block boundaries and offsets, so
 * without re-anchoring the reader would silently lose the annotation targets
 * ("批注丢失引用"). This module relocates every annotation by its verbatim quote
 * in the new parse (frozen 1.0.0 `lib/reanchor.js` semantics):
 *
 *  1. same blockKey and the stored offsets still cover the quote → unchanged;
 *  2. same blockKey, quote found elsewhere in the block → offsets updated;
 *  3. quote found in another block → blockKey + offsets updated (preferring a
 *     block close to the old page/index so multi-occurrence quotes stay put);
 *  4. quote no longer present → the annotation is kept and marked
 *     `stale: true` with a reason, so the client can show it as "位置已变化"
 *     instead of dropping it.
 *
 * Two entry points are provided:
 *  - {@link reanchorDocumentAnnotations} — the pure hook the parse manager calls
 *    with the freshly parsed markdown + the stored annotations (matches
 *    `host/contracts.ts` `ReanchorHook`).
 *  - {@link reanchorAnnotations} — the frozen store wrapper (load → re-anchor →
 *    save + summary) for callers that prefer an end-to-end helper.
 *
 * Environment-neutral: imports only the shared paper model.
 */

import { appendPageMarks, parseMarkdown } from '../markdown/parse.ts'
import type { Annotation } from '../model.ts'
import { findQuoteRange } from './anchors.ts'

/** Re-exported frozen reanchor helpers (tests + Host citation checks share them). */
export { locateQuoteInText, normalizeAnchorText } from './anchors.ts'

/** Reason stored with an annotation that has no quote text at all. */
export const STALE_REASON_NO_QUOTE = 'no-quote'

/** Reason stored with an annotation whose quote no longer occurs in the parse. */
export const STALE_REASON_NOT_FOUND = 'quote-not-found'

/** One block of a parsed document with its display page, in anchor form. */
export interface AnchorBlock {
  key: string
  index: number
  page: number | null
  kind: string
  plainText: string
}

/** Fields re-anchoring reads from a stored annotation (structural, data-safe). */
export interface ReanchorableAnnotation {
  blockKey?: unknown
  start?: unknown
  end?: unknown
  quote?: unknown
  stale?: boolean
  staleReason?: string
  reanchored?: boolean
}

/** Annotation list read/persisted by the parse manager hook. */
export interface ReanchorDocumentInput {
  documentId?: string
  annotations: readonly Annotation[]
  markdown: string
  contentList?: readonly unknown[] | null
}

/** Result of a full re-anchor pass. */
export interface ReanchorSummary {
  total: number
  changed: number
  reanchored: number
  stale: number
}

/** Structural dependency on the Host store (avoids a host → shared import). */
export interface ReanchorStore {
  readMarkdown: (documentId: string) => Promise<{ markdown: string; contentList: readonly unknown[] | null }>
  loadAnnotations: (documentId: string) => Promise<{ items: readonly unknown[] } | null | undefined>
  saveAnnotations: (
    documentId: string,
    data: { version: 1; items: readonly unknown[] },
  ) => Promise<unknown>
}

/** Minimal logger surface (matches the Host `Logger` contract). */
export interface ReanchorLogger {
  info?: (message: string, ...args: unknown[]) => void
}

/** Input of the frozen store-wrapper entry point. */
export interface ReanchorAnnotationsInput {
  store?: ReanchorStore | null
  documentId?: string
  logger?: ReanchorLogger | null
}

/** Read the annotation's effective start/end as non-negative integers. */
function offsetsOf(annotation: ReanchorableAnnotation): { start: number | null; end: number | null } {
  const start = Number(annotation.start)
  const end = Number(annotation.end)
  return {
    start: Number.isInteger(start) && start >= 0 ? start : null,
    end: Number.isInteger(end) && end > 0 ? end : null,
  }
}

/** Pick the best block containing the quote (nearest old page, then index). */
function locateBestBlock(
  blocks: readonly AnchorBlock[],
  quote: string,
  previousBlock: AnchorBlock | null,
): { block: AnchorBlock; start: number; end: number } | null {
  const oldPage = previousBlock !== null && typeof previousBlock === 'object' ? previousBlock.page : null
  const oldIndex = previousBlock !== null && typeof previousBlock === 'object' ? previousBlock.index : null
  let best: { block: AnchorBlock; start: number; end: number } | null = null
  let bestScore = Infinity
  for (const block of blocks) {
    const found = findQuoteRange(block.plainText, quote)
    if (found === null) continue
    let score = 0
    if (Number.isInteger(oldPage) && Number.isInteger(block.page)) {
      score += Math.abs((block.page ?? 0) - (oldPage ?? 0)) * 100
    }
    if (Number.isInteger(oldIndex)) score += Math.abs(block.index - (oldIndex ?? 0))
    if (score < bestScore) {
      bestScore = score
      best = { block, start: found.start, end: found.end }
    }
  }
  return best
}

/**
 * Parse a markdown document into anchor blocks with page numbers.
 *
 * Page marks are best effort: MinerU's content list is optional and a failure
 * to align it must never break re-anchoring (block keys do not depend on it).
 */
export function buildAnchorBlocks(
  markdown: string | null | undefined,
  contentList?: readonly unknown[] | null,
): AnchorBlock[] {
  let model = parseMarkdown(String(markdown ?? ''))
  if (Array.isArray(contentList) && contentList.length > 0) {
    try {
      model = appendPageMarks(model, contentList)
    } catch {
      /* page marks are optional; block keys do not depend on them */
    }
  }
  const blocks: AnchorBlock[] = []
  let page: number | null = null
  for (const block of model.blocks) {
    if (block.kind === 'page') {
      page = Number(block.page) || page
      continue
    }
    blocks.push({
      key: block.key,
      index: blocks.length,
      page,
      kind: block.kind,
      plainText: block.plainText,
    })
  }
  return blocks
}

/**
 * Re-anchor one annotation against the blocks of the new parse.
 *
 * Pure and non-mutating: returns the same object when nothing changed, a new
 * object when offsets/key changed, and keeps unknown fields untouched.
 */
export function reanchorAnnotation<T extends ReanchorableAnnotation>(
  annotation: T,
  blocks: readonly AnchorBlock[],
): T {
  if (annotation === null || typeof annotation !== 'object') return annotation
  const list = Array.isArray(blocks) ? blocks : []
  const quote = typeof annotation.quote === 'string' ? annotation.quote : ''
  const oldKey = typeof annotation.blockKey === 'string' ? annotation.blockKey : ''
  const oldBlock = list.find((block) => block.key === oldKey) ?? null
  const previous = offsetsOf(annotation)

  // 1. The same block still covers the stored span: nothing to do.
  if (oldBlock !== null && previous.start !== null && previous.end !== null
    && oldBlock.plainText.slice(previous.start, previous.end) === quote && quote !== '') {
    if (annotation.stale === true) {
      // Internal shape assertion: the frozen annotation contract is an open record.
      return { ...annotation, stale: false, staleReason: undefined } as T
    }
    return annotation
  }

  // 2. Same block, quote moved inside it (page marks or parser drift).
  if (oldBlock !== null && quote.trim() !== '') {
    const found = findQuoteRange(oldBlock.plainText, quote)
    if (found !== null) {
      if (annotation.stale !== true && found.start === previous.start && found.end === previous.end) {
        return annotation
      }
      return {
        ...annotation,
        blockKey: oldBlock.key,
        start: found.start,
        end: found.end,
        stale: false,
        staleReason: undefined,
        reanchored: true,
      } as T
    }
  }

  // 3. Search the whole document.
  if (quote.trim() !== '') {
    const best = locateBestBlock(list, quote, oldBlock)
    if (best !== null) {
      return {
        ...annotation,
        blockKey: best.block.key,
        start: best.start,
        end: best.end,
        stale: false,
        staleReason: undefined,
        reanchored: true,
      } as T
    }
  }

  // 4. Keep the annotation, but mark it as unanchored.
  const reason = quote.trim() === '' ? STALE_REASON_NO_QUOTE : STALE_REASON_NOT_FOUND
  if (annotation.stale === true && annotation.staleReason === reason) return annotation
  return { ...annotation, stale: true, staleReason: reason } as T
}

/**
 * Re-anchor a whole annotation list against one freshly parsed document.
 *
 * This is the pure {@link import('../host/contracts.ts').ReanchorHook}-shaped
 * entry point: it never throws for a single bad annotation (the hook contract
 * keeps every annotation, marked `stale` when it cannot be relocated).
 */
export function reanchorDocumentAnnotations(input: ReanchorDocumentInput): Annotation[] {
  const markdown = typeof input?.markdown === 'string' ? input.markdown : ''
  const contentList = Array.isArray(input?.contentList) ? input.contentList : null
  const blocks = buildAnchorBlocks(markdown, contentList)
  const annotations: readonly Annotation[] = Array.isArray(input?.annotations) ? input.annotations : []
  return annotations.map((annotation) => reanchorAnnotation<Annotation>(annotation, blocks))
}

/** Whether two annotation values differ in anchor-relevant fields. */
function anchorChanged(left: ReanchorableAnnotation, right: ReanchorableAnnotation): boolean {
  return left.blockKey !== right.blockKey
    || left.start !== right.start
    || left.end !== right.end
    || left.stale !== right.stale
    || left.staleReason !== right.staleReason
    || left.reanchored !== right.reanchored
}

/**
 * Load, re-anchor and persist the annotations of one document.
 *
 * Best effort by contract: the caller catches/logs failures; a reparse must
 * never fail because an annotation could not be updated.
 */
export async function reanchorAnnotations(input?: ReanchorAnnotationsInput): Promise<ReanchorSummary> {
  const summary: ReanchorSummary = { total: 0, changed: 0, reanchored: 0, stale: 0 }
  const store = input?.store
  const documentId = input?.documentId
  if (store === undefined || store === null || typeof documentId !== 'string' || documentId === '') {
    return summary
  }
  const parsed = await store.readMarkdown(documentId)
  const blocks = buildAnchorBlocks(parsed.markdown, parsed.contentList)
  const current = await store.loadAnnotations(documentId)
  const items: readonly unknown[] = current !== null && typeof current === 'object' && Array.isArray(current.items)
    ? current.items
    : []
  summary.total = items.length
  if (items.length === 0) return summary
  const next: unknown[] = []
  let changed = false
  for (const item of items) {
    // Internal assertion: stored annotations are plain JSON records.
    const annotation = (item !== null && typeof item === 'object' ? item : {}) as ReanchorableAnnotation
    const updated = reanchorAnnotation(annotation, blocks)
    next.push(updated)
    if (anchorChanged(annotation, updated)) changed = true
    if (updated.stale === true) summary.stale += 1
    if (updated.reanchored === true) summary.reanchored += 1
  }
  summary.changed = changed ? next.length : 0
  if (changed) {
    await store.saveAnnotations(documentId, { version: 1, items: next })
    input?.logger?.info?.(
      '[dsh-litnotes] re-anchored annotations for %s: %s stale, %s reanchored',
      documentId,
      summary.stale,
      summary.reanchored,
    )
  }
  return summary
}
