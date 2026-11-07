/**
 * Instant library search (ALGORITHMS.md #16).
 *
 * MiniSearch indexes the rail rows in memory; queries are answered on the
 * keystroke with no host round trip. A custom tokenizer keeps CJK text
 * searchable (`Intl.Segmenter` word granularity) next to ASCII terms, and the
 * `annotationText` field is a seam: the reader/AI workstreams or a future
 * `library_search` call can feed annotation excerpts without touching the rail.
 */

import MiniSearch from 'minisearch'
import type { DocumentStatus, DocumentSummary } from '../../../shared/model.ts'

/** Rail ordering modes. */
export type LibrarySort = 'updated' | 'created' | 'title'

/** Rail status filter (`all` keeps every document). */
export type RailStatusFilter = 'all' | DocumentStatus

/** One indexed row. */
interface LibrarySearchRow {
  id: string
  title: string
  originalName: string
  annotationText: string
}

/** Result shape of the (future) host annotation search seam. */
export interface AnnotationSearchHit {
  documentId: string
  blockKey: string
  excerpt: string
}

/** Libraries at or below this size are indexed synchronously on change. */
export const SEARCH_INDEX_LIMIT = 5000

/** Split text into lowercase ASCII terms plus CJK word segments. */
export function searchTokens(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  const normalized = text.normalize('NFKC').toLowerCase()
  const tokens: string[] = []
  const ascii = normalized.match(/[a-z0-9]+/g)
  if (ascii !== null) tokens.push(...ascii)
  if (CJK_PATTERN.test(normalized)) {
    if (segmenter !== null) {
      for (const segment of segmenter.segment(normalized)) {
        if (segment.isWordLike) tokens.push(segment.segment)
      }
    } else {
      const runs = normalized.match(CJK_RUN_PATTERN)
      if (runs !== null) tokens.push(...runs)
    }
  }
  return tokens
}

/** Unicode ranges that are written without spaces (CJK + kana + hangul). */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
/** Whole CJK runs, used when `Intl.Segmenter` is unavailable. */
const CJK_RUN_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g

/** Word segmenter when the runtime provides one (Node 20 / modern browsers do). */
const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null

/** Locale-aware title collator (numeric so "GPT-4" sorts after "GPT-2"). */
const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Timestamp used for a rail sort mode; 0 when the field is missing. */
function timestamp(value: string | null | undefined): number {
  if (typeof value !== 'string' || value === '') return 0
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

/** Sort a document list for the rail. */
export function sortDocuments(documents: ReadonlyArray<DocumentSummary>, sort: LibrarySort): DocumentSummary[] {
  const sorted = [...documents]
  if (sort === 'title') {
    sorted.sort((a, b) => titleCollator.compare(a.title, b.title))
    return sorted
  }
  const field: 'updatedAt' | 'createdAt' = sort === 'created' ? 'createdAt' : 'updatedAt'
  sorted.sort((a, b) => timestamp(b[field]) - timestamp(a[field]) || titleCollator.compare(a.title, b.title))
  return sorted
}

/** Count documents per status for the filter chips. */
export function statusCounts(documents: ReadonlyArray<DocumentSummary>): Record<RailStatusFilter, number> {
  const counts: Record<RailStatusFilter, number> = { all: documents.length, uploaded: 0, parsing: 0, parsed: 0, failed: 0 }
  for (const document of documents) counts[document.status] += 1
  return counts
}

/** One built search index; `search('')` returns `null` (no filtering). */
export interface LibrarySearchIndex {
  search: (query: string) => Set<string> | null
}

/**
 * Build the instant search index over the current library rows.
 *
 * @param documents - rows to index.
 * @param annotationTexts - optional excerpts keyed by document id (seam).
 * @returns an index whose `search` returns matching ids, or `null` for blank queries.
 */
export function buildLibrarySearchIndex(
  documents: ReadonlyArray<DocumentSummary>,
  annotationTexts?: ReadonlyMap<string, string>,
): LibrarySearchIndex {
  const index = new MiniSearch<LibrarySearchRow>({
    idField: 'id',
    fields: ['title', 'originalName', 'annotationText'],
    tokenize: (text: string) => searchTokens(text),
    processTerm: (term: string) => term,
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 3, originalName: 2 },
      combineWith: 'OR',
    },
  })
  const rows: LibrarySearchRow[] = documents.map((document) => ({
    id: document.id,
    title: document.title,
    originalName: document.originalName,
    annotationText: annotationTexts?.get(document.id) ?? '',
  }))
  index.addAll(rows)
  return {
    search: (query: string): Set<string> | null => {
      const trimmed = query.trim()
      if (trimmed === '') return null
      const results = index.search(trimmed)
      return new Set(results.map((result) => String(result.id)))
    },
  }
}

/**
 * Search annotation text through the Host (seam only).
 *
 * The 2.0 wire has no annotation-search method yet; the rail composes its
 * instant title search with whatever this returns once a workstream adds it.
 * Kept `async` so callers already treat it as a remote lookup.
 *
 * @param query - user query.
 * @returns always an empty list for now.
 */
export async function searchAnnotationText(query: string): Promise<AnnotationSearchHit[]> {
  if (query.trim() === '') return []
  return []
}
