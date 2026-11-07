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
import { problemPagesOf } from './format.ts'

/** Problem pages of the last repair attempt (empty when none). */
export function repairPages(document: DocumentSummary): number[] {
  return problemPagesOf(document)
}

/** Whether a document currently has a repair action worth offering. */
export function canRepair(document: DocumentSummary): boolean {
  if (document.status !== 'parsed') return false
  if (document.parse?.engine === 'local') return false
  return repairPages(document).length > 0
}

/** Options of the document's last parse, when recorded (for "retry"). */
export function lastParseOptions(document: DocumentSummary): ParseOptions | null {
  const options = document.parse?.options
  if (options === null || options === undefined) return null
  return options
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
  const last = lastParseOptions(document)
  if (last !== null) return last
  return { ...fallback }
}
