/**
 * Pure helpers for the AI 精读 (deep read) panel — no React, no DOM.
 *
 * The Host owns every fact of a close-reading run (`DeepReadRecord`); this module
 * makes that record safe to render (tolerant normalization + display bounds),
 * builds the blockKey → page map used by every `原文 p.N` link, groups the report
 * sections, formats the run meta, normalizes failures and renders the Markdown
 * export of the report + annotations.
 */

import type {
  DeepReadEvidence,
  DeepReadHighlight,
  DeepReadPhase,
  DeepReadPoint,
  DeepReadRecord,
  DeepReadReport,
  DeepReadStats,
} from '../../shared/model.ts'
import type { DeepReadLocaleKey } from '../i18n/deepread.ts'
import { aiT, displayText, formatCount, normalizeAspect } from './chat.ts'
import type { AiTranslate } from './chat.ts'

/* Bounds: labels ≤120, details ≤800, TL;DR ≤5×240, refs/glossary/path and
 * verdict lists bounded so a corrupt record can never flood the margin. */
const LABEL_MAX = 120
const DETAIL_MAX = 800
const TLDR_MAX = 5
const TLDR_CHARS = 240
const REFS_MAX = 6
const GLOSSARY_MAX = 12
const PATH_MAX = 3
const VERDICT_MAX = 6
const QUOTE_MAX = 300

/** Translate one `deepread.*` key through the shared {@link aiT} rules. */
export function deepReadT(
  t: AiTranslate | null | undefined,
  key: DeepReadLocaleKey,
  params?: Record<string, unknown>,
): string {
  return aiT(t, key, params)
}

/* -------------------------------------------------------------------------- */
/* Tolerant normalization                                                     */
/* -------------------------------------------------------------------------- */

/** Plain record or null. */
function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** String or ''. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Finite integer or null. */
function int(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Non-negative integer, 0 for unusable input. */
function count(value: unknown): number {
  const n = int(value)
  return n !== null && n > 0 ? n : 0
}

/** Clamp a finite number into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Trimmed non-empty strings of a raw array. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const text = str(item).trim()
    if (text !== '') out.push(text)
  }
  return out
}

/** Bound arbitrary text for display. */
export function boundText(value: unknown, limit: number): string {
  const text = displayText(value)
  const max = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : text.length
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** Bound and collapse one label onto a single line. */
function label(value: unknown): string {
  return boundText(displayText(value).replace(/\s+/g, ' ').trim(), LABEL_MAX)
}

/** Normalize one report point; null when the value is not an object. */
export function normalizeDeepReadPoint(value: unknown): DeepReadPoint | null {
  const item = rec(value)
  if (item === null) return null
  const point: DeepReadPoint = {
    label: label(item['label']),
    detail: boundText(item['detail'], DETAIL_MAX),
    blockKeys: strings(item['blockKeys']).slice(0, REFS_MAX),
  }
  const evidence = item['evidence']
  if (evidence === 'strong' || evidence === 'partial' || evidence === 'thin') point.evidence = evidence
  return point
}

/** A point with a label, detail or evidence key carries a reading. */
export function isMeaningfulPoint(point: DeepReadPoint | null | undefined): point is DeepReadPoint {
  return point !== null && point !== undefined
    ? point.label !== '' || point.detail !== '' || point.blockKeys.length > 0
    : false
}

/** Normalize a point list, dropping empty entries. */
function pointList(value: unknown): DeepReadPoint[] {
  if (!Array.isArray(value)) return []
  const out: DeepReadPoint[] = []
  for (const item of value) {
    const point = normalizeDeepReadPoint(item)
    if (point !== null && isMeaningfulPoint(point)) out.push(point)
  }
  return out
}

/** Normalize the single-point report fields (problem/gap). */
function singlePoint(value: unknown): DeepReadPoint {
  return normalizeDeepReadPoint(value) ?? { label: '', detail: '', blockKeys: [] }
}

/** Normalize the argument map. */
function argumentMap(value: unknown): DeepReadReport['argumentMap'] {
  if (!Array.isArray(value)) return []
  const out: DeepReadReport['argumentMap'] = []
  for (const item of value) {
    const edge = rec(item)
    if (edge === null) continue
    const from = label(edge['from'])
    const to = label(edge['to'])
    if (from !== '' || to !== '') out.push({ from, to, relation: label(edge['relation']) })
  }
  return out
}

/** Normalize the glossary list. */
function glossary(value: unknown): DeepReadReport['glossary'] {
  if (!Array.isArray(value)) return []
  const out: DeepReadReport['glossary'] = []
  for (const item of value) {
    const entry = rec(item)
    if (entry === null) continue
    const term = label(entry['term'])
    if (term === '') continue
    out.push({
      term,
      definition: boundText(entry['definition'], DETAIL_MAX),
      blockKeys: strings(entry['blockKeys']).slice(0, REFS_MAX),
    })
    if (out.length >= GLOSSARY_MAX) break
  }
  return out
}

/** Normalize the verdict block. */
function verdict(value: unknown): DeepReadReport['verdict'] {
  const item = rec(value)
  return {
    strengths: strings(item?.['strengths']).slice(0, VERDICT_MAX).map((text) => boundText(text, DETAIL_MAX)),
    weaknesses: strings(item?.['weaknesses']).slice(0, VERDICT_MAX).map((text) => boundText(text, DETAIL_MAX)),
    confidence: item?.['confidence'] === 'high' || item?.['confidence'] === 'low' ? item['confidence'] : 'medium',
  }
}

/** Normalize a persisted report (empty collections for missing fields). */
export function normalizeDeepReadReport(value: unknown): DeepReadReport {
  const item = rec(value) ?? {}
  return {
    tldr: strings(item['tldr'])
      .slice(0, TLDR_MAX)
      .map((text) => boundText(text, TLDR_CHARS))
      .filter((text) => text !== ''),
    problem: singlePoint(item['problem']),
    gap: singlePoint(item['gap']),
    contributions: pointList(item['contributions']),
    method: pointList(item['method']),
    evaluation: pointList(item['evaluation']),
    findings: pointList(item['findings']),
    limitations: pointList(item['limitations']),
    openQuestions: pointList(item['openQuestions']),
    argumentMap: argumentMap(item['argumentMap']),
    glossary: glossary(item['glossary']),
    readingPath: strings(item['readingPath'])
      .slice(0, PATH_MAX)
      .map((text) => boundText(text, DETAIL_MAX)),
    verdict: verdict(item['verdict']),
  }
}

/** Normalize one run highlight; null when it carries no content. */
export function normalizeDeepReadHighlight(value: unknown): DeepReadHighlight | null {
  const item = rec(value)
  if (item === null) return null
  const blockKey = str(item['blockKey']).trim()
  const quote = boundText(item['quote'], QUOTE_MAX)
  const note = boundText(item['note'], DETAIL_MAX)
  if (blockKey === '' && quote === '' && note === '') return null
  const page = int(item['page'])
  const importance = int(item['importance'])
  const section = str(item['section']).trim()
  const kind = item['kind']
  const known = kind === 'definition' || kind === 'method' || kind === 'result' ||
    kind === 'limitation' || kind === 'connection' || kind === 'context'
  return {
    annotationId: str(item['annotationId']).trim(),
    blockKey,
    quote,
    start: count(item['start']),
    end: count(item['end']),
    page: page !== null && page > 0 ? page : null,
    aspect: normalizeAspect(item['aspect']),
    note,
    importance: importance !== null ? clamp(importance, 1, 5) : 3,
    section: section === '' ? null : label(section),
    kind: known ? (kind as DeepReadHighlight['kind']) : 'claim',
  }
}

/** Normalize the per-run statistics. */
export function normalizeDeepReadStats(value: unknown): DeepReadStats {
  const item = rec(value) ?? {}
  const coverage = Number(item['coverage'])
  return {
    sections: count(item['sections']),
    sectionsRead: count(item['sectionsRead']),
    chunks: count(item['chunks']),
    chunksRead: count(item['chunksRead']),
    candidates: count(item['candidates']),
    kept: count(item['kept']),
    skipped: count(item['skipped']),
    coverage: Number.isFinite(coverage) ? clamp(coverage, 0, 1) : 0,
    calls: count(item['calls']),
    durationMs: count(item['durationMs']),
    inputTokens: count(item['inputTokens']),
    outputTokens: count(item['outputTokens']),
    truncated: item['truncated'] === true,
  }
}

/** Normalize one model route; null when both fields are empty. */
function model(value: unknown): DeepReadRecord['model'] {
  const item = rec(value)
  if (item === null) return null
  const provider = str(item['provider']).trim()
  const name = str(item['model']).trim()
  return provider === '' && name === '' ? null : { provider, model: name }
}

/** Normalize one persisted/framed record for rendering. */
export function normalizeDeepReadRecord(value: unknown): DeepReadRecord | null {
  const item = rec(value)
  if (item === null) return null
  const highlights: DeepReadHighlight[] = []
  for (const raw of Array.isArray(item['highlights']) ? item['highlights'] : []) {
    const highlight = normalizeDeepReadHighlight(raw)
    if (highlight !== null) highlights.push(highlight)
  }
  return {
    version: 1,
    documentId: str(item['documentId']).trim(),
    generatedAt: str(item['generatedAt']).trim(),
    language: str(item['language']).trim(),
    model: model(item['model']),
    promptVersion: int(item['promptVersion']) ?? 1,
    report: normalizeDeepReadReport(item['report']),
    highlights,
    stats: normalizeDeepReadStats(item['stats']),
  }
}

/* -------------------------------------------------------------------------- */
/* Evidence anchors                                                           */
/* -------------------------------------------------------------------------- */

/** One clickable source anchor of a report point. */
export interface DeepReadEvidenceRef {
  blockKey: string
  page: number | null
}

/** Block key → page map of one run, built from its highlights. */
export function blockPageMap(record: DeepReadRecord | null | undefined): Map<string, number> {
  const pages = new Map<string, number>()
  for (const highlight of record?.highlights ?? []) {
    if (highlight.blockKey !== '' && highlight.page !== null && highlight.page > 0 && !pages.has(highlight.blockKey)) {
      pages.set(highlight.blockKey, highlight.page)
    }
  }
  return pages
}

/** The deduped, bounded evidence links of one point or glossary entry. */
export function evidenceRefs(
  blockKeys: readonly string[] | null | undefined,
  pages: ReadonlyMap<string, number> | null | undefined,
): DeepReadEvidenceRef[] {
  const refs: DeepReadEvidenceRef[] = []
  const seen = new Set<string>()
  for (const raw of blockKeys ?? []) {
    const blockKey = typeof raw === 'string' ? raw.trim() : ''
    if (blockKey === '' || seen.has(blockKey)) continue
    seen.add(blockKey)
    const page = pages?.get(blockKey)
    refs.push({ blockKey, page: page !== undefined && page > 0 ? page : null })
    if (refs.length >= REFS_MAX) break
  }
  return refs
}

/** Visible label of one evidence link (`原文 p.N` / `原文`). */
export function evidenceRefLabel(t: AiTranslate | null | undefined, ref: DeepReadEvidenceRef): string {
  return ref.page === null
    ? deepReadT(t, 'deepread.jump.nopage')
    : deepReadT(t, 'deepread.jump.page', { page: formatCount(ref.page) })
}

/** i18n key of one evidence-strength badge (null when absent). */
export function evidenceLabelKey(evidence: DeepReadEvidence | null | undefined): DeepReadLocaleKey | null {
  return evidence === 'strong'
    ? 'deepread.evidence.strong'
    : evidence === 'partial'
      ? 'deepread.evidence.partial'
      : evidence === 'thin'
        ? 'deepread.evidence.thin'
        : null
}

/** i18n key of one verdict confidence label. */
export function confidenceLabelKey(
  confidence: DeepReadReport['verdict']['confidence'] | null | undefined,
): DeepReadLocaleKey {
  return confidence === 'high'
    ? 'deepread.confidence.high'
    : confidence === 'low'
      ? 'deepread.confidence.low'
      : 'deepread.confidence.medium'
}

/** The annotation cards of one run in paper order (page, block, importance). */
export function sortHighlights(highlights: readonly DeepReadHighlight[]): DeepReadHighlight[] {
  return [...highlights].sort((left, right) => {
    const lp = left.page ?? Number.MAX_SAFE_INTEGER
    const rp = right.page ?? Number.MAX_SAFE_INTEGER
    if (lp !== rp) return lp - rp
    if (left.blockKey !== right.blockKey) return left.blockKey < right.blockKey ? -1 : 1
    return right.importance - left.importance
  })
}

/* -------------------------------------------------------------------------- */
/* Report grouping                                                            */
/* -------------------------------------------------------------------------- */

/** One titled block of the report body, in authoring order. */
export interface DeepReadPointGroup {
  id: 'problem' | 'gap' | 'contributions' | 'method' | 'evaluation' | 'findings' | 'limitations' | 'openQuestions'
  titleKey: DeepReadLocaleKey
  points: DeepReadPoint[]
}

/** The non-empty report point sections in the design's order. */
export function reportPointGroups(report: DeepReadReport | null | undefined): DeepReadPointGroup[] {
  if (report === null || report === undefined) return []
  const single = (point: DeepReadPoint): DeepReadPoint[] => (isMeaningfulPoint(point) ? [point] : [])
  const groups: DeepReadPointGroup[] = [
    { id: 'problem', titleKey: 'deepread.section.problem', points: single(report.problem) },
    { id: 'gap', titleKey: 'deepread.section.gap', points: single(report.gap) },
    { id: 'contributions', titleKey: 'deepread.section.contributions', points: report.contributions },
    { id: 'method', titleKey: 'deepread.section.method', points: report.method },
    { id: 'evaluation', titleKey: 'deepread.section.evaluation', points: report.evaluation },
    { id: 'findings', titleKey: 'deepread.section.findings', points: report.findings },
    { id: 'limitations', titleKey: 'deepread.section.limitations', points: report.limitations },
    { id: 'openQuestions', titleKey: 'deepread.section.openQuestions', points: report.openQuestions },
  ]
  return groups.filter((group) => group.points.length > 0)
}

/* -------------------------------------------------------------------------- */
/* Phase checklist / progress                                                 */
/* -------------------------------------------------------------------------- */

/** Checklist order of the workflow (the terminal `done` is not a row). */
export const DEEP_READ_PHASES: ReadonlyArray<{ phase: Exclude<DeepReadPhase, 'done'>; titleKey: DeepReadLocaleKey }> = [
  { phase: 'mapping', titleKey: 'deepread.phase.mapping' },
  { phase: 'reading', titleKey: 'deepread.phase.reading' },
  { phase: 'gaps', titleKey: 'deepread.phase.gaps' },
  { phase: 'judging', titleKey: 'deepread.phase.judging' },
  { phase: 'synthesizing', titleKey: 'deepread.phase.synthesizing' },
  { phase: 'annotating', titleKey: 'deepread.phase.annotating' },
]

/** Checklist index of one phase (`length` once finished). */
export function phaseIndex(phase: DeepReadPhase | null | undefined): number {
  if (phase === null || phase === undefined) return 0
  if (phase === 'done') return DEEP_READ_PHASES.length
  const index = DEEP_READ_PHASES.findIndex((step) => step.phase === phase)
  return index === -1 ? 0 : index
}

/** Percentage of the phase's own counter (0–100). */
export function progressPercent(progress: { done: number; total: number } | null | undefined): number {
  const total = Number(progress?.total ?? 0)
  const done = Number(progress?.done ?? 0)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return 0
  return clamp(Math.round((done / total) * 100), 0, 100)
}

/* -------------------------------------------------------------------------- */
/* Stats / meta formatting                                                    */
/* -------------------------------------------------------------------------- */

/** Coverage percentage of one run (0–100). */
export function coveragePercent(stats: DeepReadStats | null | undefined): number {
  const coverage = Number(stats?.coverage ?? 0)
  return Number.isFinite(coverage) ? Math.round(clamp(coverage, 0, 1) * 100) : 0
}

/** `provider/model` label ('' when unknown). */
export function formatModelLabel(model: DeepReadRecord['model'] | null | undefined): string {
  if (model === null || model === undefined) return ''
  const provider = model.provider.trim()
  const name = model.model.trim()
  return provider !== '' && name !== '' ? `${provider}/${name}` : provider !== '' ? provider : name
}

/** Local `YYYY-MM-DD HH:mm` timestamp (raw text when unparsable, '' when empty). */
export function formatTimestamp(value: unknown): string {
  const text = str(value).trim()
  if (text === '') return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  const pad = (number: number): string => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

/** Normalized run failure. */
export interface DeepReadFailure {
  code: string
  message: string
  retryable: boolean
}

/** Normalize one thrown value into a display failure (never throws). */
export function deepReadFailure(error: unknown): DeepReadFailure {
  if (error !== null && typeof error === 'object') {
    const item = error as { code?: unknown; message?: unknown }
    const code = typeof item.code === 'string' && item.code.trim() !== '' ? item.code : 'host-error'
    return {
      code,
      message: typeof item.message === 'string' ? item.message : '',
      retryable: code !== 'aborted' && code !== 'llm-unavailable',
    }
  }
  return typeof error === 'string' && error.trim() !== ''
    ? { code: 'host-error', message: error, retryable: true }
    : { code: 'host-error', message: '', retryable: true }
}

/** Error code → localized message key. */
const ERROR_KEYS: Record<string, DeepReadLocaleKey> = {
  'llm-unavailable': 'deepread.error.llmUnavailable',
  'token-missing': 'deepread.error.llmUnavailable',
  'llm-failed': 'deepread.error.llmFailed',
  'bad-request': 'deepread.error.badRequest',
  aborted: 'deepread.error.aborted',
  'host-error': 'deepread.error.hostError',
  'ai-unavailable': 'deepread.error.hostError',
  'host-unavailable': 'deepread.error.hostError',
  network: 'deepread.error.network',
  timeout: 'deepread.error.network',
  'bad-response': 'deepread.error.network',
  'http-error': 'deepread.error.network',
}

/** Reader-facing copy of one run failure. */
export function deepReadErrorMessage(
  t: AiTranslate | null | undefined,
  code: string | null | undefined,
  message?: string | null,
): string {
  const key =
    typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)
      ? ERROR_KEYS[code]
      : undefined
  if (key !== undefined) return deepReadT(t, key)
  const text = typeof message === 'string' ? message.trim() : ''
  return text !== '' ? text : deepReadT(t, 'deepread.error.generic')
}

/* -------------------------------------------------------------------------- */
/* Markdown export                                                            */
/* -------------------------------------------------------------------------- */

/** Metadata of one deep-read Markdown export. */
export interface DeepReadMarkdownMeta {
  title?: string
  t?: AiTranslate | null
}

/** One exported report file. */
export interface DeepReadMarkdownResult {
  filename: string
  markdown: string
}

/** Sanitize a title into a portable Markdown download filename. */
function exportFilename(title: string): string {
  let base = title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s-]+$/, '')
  if (base.length > 80) base = base.slice(0, 80).replace(/[.\s-]+$/, '')
  return `${base === '' ? 'deepread-report' : base}.md`
}

/** One report point as Markdown lines (label, detail, source links). */
function pointLines(point: DeepReadPoint, pages: ReadonlyMap<string, number>, t: AiTranslate | null): string[] {
  const lines: string[] = []
  if (point.label !== '') lines.push(`**${point.label}**`)
  if (point.detail.trim() !== '') lines.push(point.detail.trim())
  const refs = evidenceRefs(point.blockKeys, pages)
  if (refs.length > 0) lines.push(refs.map((ref) => evidenceRefLabel(t, ref)).join(' · '))
  return lines
}

/** Render one report section (`## title` + blank-line-separated blocks). */
function section(title: string, blocks: string[][]): string {
  const body = blocks.filter((block) => block.length > 0).map((block) => block.join('\n'))
  return body.length === 0 ? `## ${title}` : `## ${title}\n\n${body.join('\n\n')}`
}

/** Render one deep-read run as a portable Markdown report. */
export function buildDeepReadMarkdown(
  record: DeepReadRecord | null | undefined,
  meta: DeepReadMarkdownMeta = {},
): DeepReadMarkdownResult | null {
  if (record === null || record === undefined) return null
  const t = meta.t ?? null
  const report = record.report
  const pages = blockPageMap(record)
  const title = str(meta.title).trim()
  const modelLabel = formatModelLabel(record.model)
  const lines: string[] = [
    title === '' ? `# ${deepReadT(t, 'deepread.reportTitle')}` : `# ${title} — ${deepReadT(t, 'deepread.reportTitle')}`,
    '',
    `- ${deepReadT(t, 'deepread.model', { model: modelLabel === '' ? deepReadT(t, 'deepread.modelUnknown') : modelLabel })}`,
  ]
  const generatedAt = formatTimestamp(record.generatedAt)
  if (generatedAt !== '') lines.push(`- ${deepReadT(t, 'deepread.generatedAt', { time: generatedAt })}`)
  lines.push(
    `- ${deepReadT(t, 'deepread.stats.sections', { count: formatCount(record.stats.sectionsRead) })} · ` +
      `${deepReadT(t, 'deepread.stats.annotations', { count: formatCount(record.highlights.length) })} · ` +
      `${deepReadT(t, 'deepread.stats.coverage', { percent: formatCount(coveragePercent(record.stats)) })}`,
  )
  if (record.stats.truncated) lines.push('', `> ${deepReadT(t, 'deepread.truncated')}`)

  const blocks: string[] = []
  if (report.tldr.length > 0) {
    blocks.push(section(deepReadT(t, 'deepread.section.tldr'), [report.tldr.map((item) => `- ${item}`)]))
  }
  for (const group of reportPointGroups(report)) {
    blocks.push(section(deepReadT(t, group.titleKey), group.points.map((point) => pointLines(point, pages, t))))
  }
  if (report.argumentMap.length > 0) {
    blocks.push(
      section(
        deepReadT(t, 'deepread.section.argumentMap'),
        [report.argumentMap.map((edge) => `- ${edge.from} → ${edge.to}${edge.relation !== '' ? `（${edge.relation}）` : ''}`)],
      ),
    )
  }
  if (report.glossary.length > 0) {
    blocks.push(
      section(
        deepReadT(t, 'deepread.section.glossary'),
        [
          report.glossary.map((entry) => {
            const refs = evidenceRefs(entry.blockKeys, pages)
            const suffix = refs.length > 0 ? ` · ${refs.map((ref) => evidenceRefLabel(t, ref)).join(' · ')}` : ''
            return `- **${entry.term}**${entry.definition !== '' ? ` — ${entry.definition}` : ''}${suffix}`
          }),
        ],
      ),
    )
  }
  if (report.readingPath.length > 0) {
    blocks.push(
      section(deepReadT(t, 'deepread.section.readingPath'), [report.readingPath.map((step, index) => `${index + 1}. ${step}`)]),
    )
  }
  const verdictLines = [
    `- ${deepReadT(t, 'deepread.verdict.confidence', {
      level: deepReadT(t, confidenceLabelKey(report.verdict.confidence)),
    })}`,
  ]
  if (report.verdict.strengths.length > 0) {
    verdictLines.push('', `**${deepReadT(t, 'deepread.verdict.strengths')}**`, ...report.verdict.strengths.map((item) => `- ${item}`))
  }
  if (report.verdict.weaknesses.length > 0) {
    verdictLines.push('', `**${deepReadT(t, 'deepread.verdict.weaknesses')}**`, ...report.verdict.weaknesses.map((item) => `- ${item}`))
  }
  blocks.push(section(deepReadT(t, 'deepread.section.verdict'), [verdictLines]))

  if (record.highlights.length > 0) {
    const cards: string[] = []
    for (const highlight of record.highlights) {
      const head: string[] = []
      if (highlight.page !== null) head.push(deepReadT(t, 'deepread.jump.page', { page: formatCount(highlight.page) }))
      head.push(aiT(t, `aspect.${highlight.aspect}`))
      cards.push(`- **${head.join(' · ')}**`)
      if (highlight.quote !== '') cards.push(`  > ${highlight.quote.replace(/\s+/g, ' ').trim()}`)
      if (highlight.note !== '') cards.push(`  ${highlight.note.replace(/\s+/g, ' ').trim()}`)
    }
    blocks.push(section(deepReadT(t, 'deepread.annotations'), [cards]))
  }

  return { filename: exportFilename(title), markdown: `${lines.join('\n')}\n\n${blocks.join('\n\n')}\n` }
}
