/**
 * Parse/repair request builders.
 *
 * The Host accepts a plain `ParseOptions` for a fresh parse and a
 * `ParseStartOptions` with `{ merge: true, pages }` for a page-scoped repair
 * (see `src/host/service.ts#startParse`). These helpers keep that decision in
 * one place so the rail menu, the reparse dialog and the import flow all build
 * the same request shape.
 */

import type { DocumentSummary, ParseOptions, ParseStartOptions } from '../../../shared/model.ts'
import { getHostClient } from '../../api/client.ts'

/** Options of the a parse attempt, reconstructed from the light list row. */
export function summaryParseOptions(document: DocumentSummary): ParseOptions | null {
  const parse = document.parse
  if (parse === null) return null
  const options: ParseOptions = { isOcr: parse.ocr }
  if (parse.engine !== null) options.engine = parse.engine
  if (parse.modelVersion !== null) options.modelVersion = parse.modelVersion
  if (parse.language !== null) options.language = parse.language
  return options
}

/** Detail fetched on demand for actions that need the full parse state. */
export interface ParseDetail {
  /** Options of the last parse (`null` before the first parse). */
  options: ParseOptions | null
  /** Pages the last page-scoped repair reported as failed. */
  repairPages: number[]
}

/**
 * Fetch the full document metadata (`library.get`) for an action that needs
 * parse-repair state, which the library list deliberately trims.
 *
 * @param documentId - document id.
 * @returns last parse options and problem pages.
 */
export async function loadParseDetail(documentId: string): Promise<ParseDetail> {
  const { document } = await getHostClient().call('library.get', { id: documentId })
  const parse = document.parse
  const failed = parse?.repair?.failedPages
  const repairPages = Array.isArray(failed)
    ? failed.filter((page): page is number => typeof page === 'number' && Number.isInteger(page) && page > 0)
    : []
  return { options: parse?.options ?? null, repairPages }
}

/**
 * Build a page-scoped repair request from the current form state.
 *
 * Repair reuses the chosen model/language/OCR flags; the engine choice is
 * irrelevant because the Host dispatches on `merge` first.
 *
 * @param options - form values of the reparse dialog.
 * @param pages - 1-based pages to repair.
 * @returns a `parse.start` request body for the repair.
 */
export function repairRequest(options: ParseOptions, pages: ReadonlyArray<number>): ParseStartOptions {
  const request: ParseStartOptions = { merge: true, pages: [...pages] }
  if (options.modelVersion !== undefined) request.modelVersion = options.modelVersion
  if (options.language !== undefined) request.language = options.language
  if (typeof options.isOcr === 'boolean') request.isOcr = options.isOcr
  if (typeof options.enableFormula === 'boolean') request.enableFormula = options.enableFormula
  if (typeof options.enableTable === 'boolean') request.enableTable = options.enableTable
  return request
}

/** Request used by the row's "retry parsing" action (last options, else defaults). */
export function retryRequest(document: DocumentSummary, fallback: ParseOptions): ParseStartOptions {
  return summaryParseOptions(document) ?? { ...fallback }
}
