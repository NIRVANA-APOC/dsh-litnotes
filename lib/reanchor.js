/**
 * Re-anchor annotations after a (re)parse.
 *
 * An annotation stores `{ blockKey, start, end, quote }`. A full reparse or a
 * page-scoped repair can change block keys, block boundaries and offsets, so
 * without re-anchoring the reader would silently lose the annotation targets
 * ("批注丢失引用"). This module relocates every annotation by its verbatim
 * quote in the new parse:
 *
 *  1. same blockKey and the stored offsets still cover the quote → unchanged;
 *  2. same blockKey, quote found elsewhere in the block → offsets updated;
 *  3. quote found in another block → blockKey + offsets updated (preferring a
 *     block close to the old page/index so multi-occurrence quotes stay put);
 *  4. quote no longer present → the annotation is kept and marked
 *     `stale: true` with a reason, so the client can show it as
 *     "位置已变化" instead of dropping it.
 *
 * Pure helpers are exported for unit tests; `reanchorAnnotations` is the store
 * wrapper used by the parse manager.
 *
 * @module lib/reanchor
 */
import { appendPageMarks, parseMarkdown } from '../ui/markdown.js'

/** Reason stored with an annotation that could no longer be located. */
export const STALE_REASON_NO_QUOTE = 'no-quote'
export const STALE_REASON_NOT_FOUND = 'quote-not-found'

/** Collapse whitespace for quote comparison (shared with AI citation checks). */
export function normalizeAnchorText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Whether a whitespace character. */
function isSpaceChar(character) {
  return character === ' ' || character === '\n' || character === '\r'
    || character === '\t' || character === '\f' || character === '\v'
}

/** Collapse whitespace and keep a map back to original character offsets. */
function collapseWithMap(text) {
  const chars = []
  const map = []
  let pendingSpace = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (isSpaceChar(character)) {
      if (!pendingSpace && chars.length > 0) {
        chars.push(' ')
        map.push(index)
        pendingSpace = true
      }
      continue
    }
    chars.push(character)
    map.push(index)
    pendingSpace = false
  }
  while (chars.length > 0 && chars[chars.length - 1] === ' ') {
    chars.pop()
    map.pop()
  }
  return { text: chars.join(''), map }
}

/**
 * Find `quote` in `text`, falling back to whitespace-insensitive matching.
 * @returns {{ start: number, end: number } | null}
 */
export function locateQuoteInText(text, quote) {
  const haystack = typeof text === 'string' ? text : ''
  const needle = typeof quote === 'string' ? quote : ''
  if (haystack === '' || needle.trim() === '') return null
  const exact = haystack.indexOf(needle)
  if (exact !== -1) return { start: exact, end: exact + needle.length }
  const collapsedHaystack = collapseWithMap(haystack)
  const collapsedNeedle = normalizeAnchorText(needle)
  if (collapsedNeedle === '') return null
  const at = collapsedHaystack.text.indexOf(collapsedNeedle)
  if (at === -1) return null
  const start = collapsedHaystack.map[at]
  const last = collapsedHaystack.map[at + collapsedNeedle.length - 1]
  if (!Number.isInteger(start) || !Number.isInteger(last)) return null
  return { start, end: last + 1 }
}

/**
 * Parse a markdown document into anchor blocks with page numbers.
 * @param {string} markdown - parsed `full.md`.
 * @param {Array<object>|undefined} contentList - MinerU content list for page marks.
 * @returns {Array<{key:string,index:number,page:number|null,kind:string,plainText:string}>}
 */
export function buildAnchorBlocks(markdown, contentList) {
  let model = parseMarkdown(String(markdown ?? ''))
  if (Array.isArray(contentList) && contentList.length > 0) {
    try {
      model = appendPageMarks(model, contentList)
    } catch {
      /* page marks are optional; block keys do not depend on them */
    }
  }
  const blocks = []
  let page = null
  for (const block of model.blocks ?? []) {
    if (block === null || typeof block !== 'object') continue
    if (block.kind === 'page') {
      page = Number(block.page) || page
      continue
    }
    blocks.push({
      key: block.key,
      index: blocks.length,
      page,
      kind: block.kind,
      plainText: typeof block.plainText === 'string' ? block.plainText : '',
    })
  }
  return blocks
}

/** Pick the best block containing the quote (nearest old page, then index). */
function locateBestBlock(blocks, quote, previousBlock) {
  const oldPage = previousBlock !== null && typeof previousBlock === 'object' ? previousBlock.page : null
  const oldIndex = previousBlock !== null && typeof previousBlock === 'object' ? previousBlock.index : null
  let best = null
  let bestScore = Infinity
  for (const block of blocks) {
    const found = locateQuoteInText(block.plainText, quote)
    if (found === null) continue
    let score = 0
    if (Number.isInteger(oldPage) && Number.isInteger(block.page)) score += Math.abs(block.page - oldPage) * 100
    if (Number.isInteger(oldIndex)) score += Math.abs(block.index - oldIndex)
    if (score < bestScore) {
      bestScore = score
      best = { block, start: found.start, end: found.end }
    }
  }
  return best
}

/** Read the annotation's effective start/end as positive integers. */
function offsetsOf(annotation) {
  const start = Number(annotation?.start)
  const end = Number(annotation?.end)
  return {
    start: Number.isInteger(start) && start >= 0 ? start : null,
    end: Number.isInteger(end) && end > 0 ? end : null,
  }
}

/**
 * Re-anchor one annotation against the blocks of the new parse.
 *
 * Pure and non-mutating. Returns the same object when nothing changed.
 *
 * @param {object} annotation - stored annotation.
 * @param {Array<ReturnType<typeof buildAnchorBlocks>[number]>} blocks - new blocks.
 * @returns {object} annotation with updated `blockKey`/`start`/`end` and
 *   `stale`/`staleReason`/`reanchored` flags when needed.
 */
export function reanchorAnnotation(annotation, blocks) {
  if (annotation === null || typeof annotation !== 'object') return annotation
  const list = Array.isArray(blocks) ? blocks : []
  const quote = typeof annotation.quote === 'string' ? annotation.quote : ''
  const oldKey = typeof annotation.blockKey === 'string' ? annotation.blockKey : ''
  const oldBlock = list.find((block) => block.key === oldKey) ?? null
  const previous = offsetsOf(annotation)

  // 1. The same block still covers the stored span: nothing to do.
  if (oldBlock !== null && previous.start !== null && previous.end !== null
    && oldBlock.plainText.slice(previous.start, previous.end) === quote && quote !== '') {
    return annotation.stale === true ? { ...annotation, stale: false, staleReason: undefined } : annotation
  }

  // 2. Same block, quote moved inside it (page marks or parser drift).
  if (oldBlock !== null && quote.trim() !== '') {
    const found = locateQuoteInText(oldBlock.plainText, quote)
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
      }
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
      }
    }
  }

  // 4. Keep the annotation, but mark it as unanchored.
  const reason = quote.trim() === '' ? STALE_REASON_NO_QUOTE : STALE_REASON_NOT_FOUND
  if (annotation.stale === true && annotation.staleReason === reason) return annotation
  return { ...annotation, stale: true, staleReason: reason }
}

/** Whether two annotation values differ in anchor-relevant fields. */
function anchorChanged(left, right) {
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
 *
 * @param {{
 *   store: {readMarkdown: Function, loadAnnotations: Function, saveAnnotations: Function},
 *   documentId: string,
 *   logger?: Record<string, Function>,
 * }} deps
 * @returns {Promise<{total:number, changed:number, reanchored:number, stale:number}>}
 */
export async function reanchorAnnotations({ store, documentId, logger } = {}) {
  const summary = { total: 0, changed: 0, reanchored: 0, stale: 0 }
  if (store === undefined || store === null || typeof documentId !== 'string' || documentId === '') return summary
  const parsed = await store.readMarkdown(documentId)
  const blocks = buildAnchorBlocks(parsed.markdown, parsed.contentList)
  const current = await store.loadAnnotations(documentId)
  const items = current !== null && typeof current === 'object' && Array.isArray(current.items) ? current.items : []
  summary.total = items.length
  if (items.length === 0) return summary
  const next = []
  let changed = false
  for (const item of items) {
    const updated = reanchorAnnotation(item, blocks)
    next.push(updated)
    if (anchorChanged(item, updated)) changed = true
    if (updated.stale === true) summary.stale += 1
    if (updated.reanchored === true) summary.reanchored += 1
  }
  summary.changed = changed ? next.length : 0
  if (changed) {
    await store.saveAnnotations(documentId, { version: 1, items: next })
    logger?.info?.(
      '[dsh-litnotes] re-anchored annotations for %s: %s reanchored, %s stale',
      documentId,
      summary.reanchored,
      summary.stale,
    )
  }
  return summary
}
