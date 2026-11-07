/**
 * Formatting helpers for the library rail and the shell dialogs.
 *
 * Everything user-visible is derived here (status labels, engine labels,
 * progress copy, compact dates) so the JSX stays declarative and the same
 * wording is used by the rail, the dialogs and the status bar.
 */

import type { DocumentStatus, DocumentSummary } from '../../shared/model.ts'
import type { LitnotesTranslate } from '../locale-context.ts'
import type { ParseEngine } from '../../shared/constants.ts'

/** Locale key of a parse-engine label. */
export function engineLabelKey(engine: string | null | undefined): 'status.engine.standard' | 'status.engine.agent' | 'status.engine.local' | 'status.engine.none' {
  if (engine === 'standard') return 'status.engine.standard'
  if (engine === 'agent') return 'status.engine.agent'
  if (engine === 'local') return 'status.engine.local'
  return 'status.engine.none'
}

/** Locale key of a document status label. */
export function statusLabelKey(status: DocumentStatus | null | undefined): 'rail.status.parsed' | 'rail.status.parsing' | 'rail.status.failed' | 'rail.status.uploaded' {
  if (status === 'parsed') return 'rail.status.parsed'
  if (status === 'parsing') return 'rail.status.parsing'
  if (status === 'failed') return 'rail.status.failed'
  return 'rail.status.uploaded'
}

/** Human label of one parse engine. */
export function engineLabel(t: LitnotesTranslate, engine: string | null | undefined): string {
  return t(engineLabelKey(engine))
}

/** Human label of one document status. */
export function statusLabel(t: LitnotesTranslate, status: DocumentStatus | null | undefined): string {
  return t(statusLabelKey(status))
}

/** Format an integer with locale grouping; `null` becomes an em dash. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat().format(value)
}

/** Title-cased extension without the dot (`pdf` → `PDF`). */
export function extensionLabel(ext: string | null | undefined): string {
  if (typeof ext !== 'string') return ''
  return ext.replace(/^\./, '').toUpperCase()
}

/** Lowercase extension including the dot, or `''` when the name has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}

/** Compact date for a rail meta line (`9月3日` / `Sep 3`). */
export function formatShortDate(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

/** Total parsed pages recorded on a document, when known. */
export function pageCountOf(document: DocumentSummary): number | null {
  const parsed = document.parse?.pages
  if (typeof parsed === 'number' && parsed > 0) return parsed
  const summary = document.pageCount
  if (typeof summary === 'number' && summary > 0) return summary
  return null
}

/** One-line parse progress copy: phase plus page counts when known. */
export function parseProgressText(document: DocumentSummary, t: LitnotesTranslate): string {
  const parse = document.parse
  const progress = parse?.progress ?? null
  const phase = parse?.phase ?? null
  const remoteState = parse?.remoteState ?? null
  let phaseText: string
  if (phase === 'extracting') phaseText = t('rail.progress.extracting')
  else if (phase === 'submitting') phaseText = t('rail.progress.submitting')
  else if (phase === 'uploading') phaseText = t('rail.progress.uploading')
  else if (remoteState === 'waiting-file') phaseText = t('rail.progress.uploading')
  else phaseText = t('rail.progress.polling')
  if (progress === null || progress.total <= 0) return phaseText
  return `${phaseText} · ${t('rail.progress.pages', { done: progress.extracted, total: progress.total })}`
}

/** Metadata fragments of one rail row, in fixed order. */
export function documentMetaParts(document: DocumentSummary, t: LitnotesTranslate): string[] {
  const parts: string[] = []
  const ext = extensionLabel(document.ext)
  if (ext !== '') parts.push(ext)
  const pages = pageCountOf(document)
  if (pages !== null) parts.push(t('rail.rowMeta.pages', { count: pages }))
  const words = document.wordCount
  if (typeof words === 'number' && words > 0) parts.push(t('rail.rowMeta.words', { count: formatNumber(words) }))
  parts.push(statusLabel(t, document.status))
  const engine = document.parse?.engine
  if (engine !== undefined && engine !== null) parts.push(engineLabel(t, engine))
  return parts
}

/** Problem pages of the last page-scoped repair attempt (empty when none). */
export function problemPagesOf(document: DocumentSummary): number[] {
  const failed = document.parse?.repair?.failedPages
  if (!Array.isArray(failed)) return []
  return failed.filter((page): page is number => typeof page === 'number' && Number.isInteger(page) && page > 0)
}

/** Whether a parsed document is currently being parsed again. */
export function isBusy(document: DocumentSummary): boolean {
  return document.status === 'parsing'
}

/** Compose a human label for an engine selection. */
export function assembleEngineLabel(engine: ParseEngine, t: LitnotesTranslate): string {
  if (engine === 'standard') return t('parse.engine.standard')
  if (engine === 'agent') return t('parse.engine.agent')
  if (engine === 'local') return t('parse.engine.local')
  return t('parse.engine.auto')
}
