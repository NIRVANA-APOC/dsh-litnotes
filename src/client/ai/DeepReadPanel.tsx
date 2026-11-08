/**
 * AI 精读 panel — the close-reading report view of the margin (design §1).
 *
 * Rendered by the reader inside `.ln-ai-panel__body` when the `精读` margin
 * filter is selected. It is a *reading report*, not a chat transcript: a quiet,
 * evidence-anchored account of what the AI understood, which blocks it read and
 * which annotations it wrote — every point can jump back to the page.
 *
 * Four states share one column:
 *  - idle (no record): CTA card with the promise, cost note and start action;
 *  - running: phase checklist + progress + current section + stop;
 *  - done: stats row, TL;DR, problem/gap/contributions (evidence chips), method,
 *    evaluation, findings, limitations, open questions, argument map, glossary,
 *    reading path, verdict, then the collapsible list of annotation cards;
 *  - error: retry/dismiss, with a previous record kept visible underneath.
 *
 * The component is props-driven (it renders with no reader/Host mounted in
 * tests), reads only `useDeepReadStore`, injects the shared AI stylesheet and
 * calls the reader seam through `onJump` / host hooks.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Annotation, DeepReadHighlight, DeepReadPoint, DeepReadRecord } from '../../shared/model.ts'
import { Icon } from '../design/icons.tsx'
import { AspectDot, Badge, Button, IconButton, ProgressBar, Spinner } from '../design/primitives.tsx'
import { useInjectedStyle } from '../design/use-style.ts'
import { useT } from '../shell/locale-context.ts'
import { useUiStore } from '../state/ui.ts'
import { aiT, excerpt, formatCount } from './chat.ts'
import type { AiTranslate } from './chat.ts'
import {
  DEEP_READ_PHASES,
  blockPageMap,
  boundText,
  buildDeepReadMarkdown,
  confidenceLabelKey,
  coveragePercent,
  deepReadT,
  evidenceLabelKey,
  evidenceRefLabel,
  evidenceRefs,
  formatModelLabel,
  formatTimestamp,
  phaseIndex,
  progressPercent,
  reportPointGroups,
  sortHighlights,
} from './deepread.ts'
import type { DeepReadEvidenceRef, DeepReadPointGroup } from './deepread.ts'
import { setDeepReadTranslate, useDeepReadStore } from './deepread-store.ts'
import type { DeepReadProgress } from './deepread-store.ts'
import { AiMarkdown } from './markdown.tsx'
import { adaptTranslate } from './translate.ts'
import aiCss from './styles.css'

/* -------------------------------------------------------------------------- */
/* Public contract                                                            */
/* -------------------------------------------------------------------------- */

/** Props of {@link DeepReadPanel} (the reader-owned mirror lives in `reader/api.ts`). */
export interface DeepReadPanelProps {
  /** Open document id. */
  documentId: string
  /** Reader annotations of the open document (persistence display). */
  annotations: Annotation[]
  /** Scroll+flash one report source block in the paper. */
  onJump: (blockKey: string) => void
  /** Reload the page annotations after a run wrote them. */
  onAnnotationsChanged: () => void | Promise<void>
}

/** Which top-level state the column renders. */
type DeepReadView = 'idle' | 'loading' | 'load-error' | 'running' | 'report' | 'error'

/* -------------------------------------------------------------------------- */
/* Markdown marker stub                                                       */
/* -------------------------------------------------------------------------- */

/** Report details are prose, not answers: inline `[n]` markers stay literal. */
function renderPlainMarker(index: number): ReactElement {
  return <span>[{index}]</span>
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The AI 精读 view: idle invitation, running checklist, close-reading report or
 * error, for one document.
 *
 * @param props - see {@link DeepReadPanelProps}.
 * @returns the margin body of the deep-read view.
 */
export function DeepReadPanel(props: DeepReadPanelProps): ReactElement {
  const { documentId, annotations, onJump, onAnnotationsChanged } = props
  const t = useT()
  const tr = useMemo(() => adaptTranslate(t), [t])
  useInjectedStyle('ai', aiCss)

  const storeDocumentId = useDeepReadStore((state) => state.documentId)
  const record = useDeepReadStore((state) => state.record)
  const recordState = useDeepReadStore((state) => state.recordState)
  const runState = useDeepReadStore((state) => state.runState)
  const progress = useDeepReadStore((state) => state.progress)
  const error = useDeepReadStore((state) => state.error)
  const busy = useDeepReadStore((state) => state.busy)

  const [annotationsOpen, setAnnotationsOpen] = useState(false)

  useEffect(() => {
    setDeepReadTranslate(tr)
  }, [tr])

  useEffect(() => {
    useDeepReadStore.getState().setHostHooks({ onAnnotationsChanged })
  }, [onAnnotationsChanged])

  useEffect(() => {
    void useDeepReadStore.getState().load(documentId)
  }, [documentId])

  // The store keeps one document at a time; a record of another paper is never
  // shown under this document's header (the reader loads the new one).
  const active = storeDocumentId === documentId
  const shownRecord = active ? record : null
  const runError = active ? error : null
  const hasRecord = shownRecord !== null

  let view: DeepReadView = 'idle'
  if (active && runState === 'running') view = 'running'
  else if (active && recordState === 'error' && !hasRecord) view = 'load-error'
  else if (active && recordState === 'loading' && !hasRecord) view = 'loading'
  else if (active && runState === 'error') view = hasRecord ? 'report' : 'error'
  else if (hasRecord) view = 'report'

  const jump = useCallback(
    (blockKey: string) => {
      if (blockKey !== '') onJump(blockKey)
    },
    [onJump],
  )
  const start = useCallback(() => {
    void useDeepReadStore.getState().start(documentId)
  }, [documentId])
  const rerun = useCallback(() => {
    void useDeepReadStore.getState().start(documentId, { force: true })
  }, [documentId])
  const stop = useCallback(() => useDeepReadStore.getState().stop(), [])
  const retry = useCallback(() => {
    void useDeepReadStore.getState().retry()
  }, [])
  const reload = useCallback(() => {
    void useDeepReadStore.getState().load(documentId)
  }, [documentId])
  const dismiss = useCallback(() => useDeepReadStore.getState().dismissError(), [])
  const toggleAnnotations = useCallback(() => setAnnotationsOpen((open) => !open), [])

  const copyReport = useCallback(async () => {
    const result = buildDeepReadMarkdown(useDeepReadStore.getState().record, { t: tr })
    if (result === null) {
      useUiStore.getState().toast(deepReadT(tr, 'deepread.copyEmpty'), 'warn')
      return
    }
    try {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) throw new Error('clipboard')
      await navigator.clipboard.writeText(result.markdown)
      useUiStore.getState().toast(deepReadT(tr, 'deepread.copied'), 'success')
    } catch {
      useUiStore.getState().toast(deepReadT(tr, 'deepread.copyFailed'), 'error')
    }
  }, [tr])

  return (
    <div className="ln-deepread" data-state={view} data-busy={busy ? 'true' : 'false'}>
      {view === 'running' ? (
        <RunningView t={tr} progress={active ? progress : null} onStop={stop} />
      ) : null}

      {view === 'loading' ? (
        <div className="ln-ai__state" role="status">
          <Spinner size={14} label={deepReadT(tr, 'deepread.loading')} />
          <span>{deepReadT(tr, 'deepread.loading')}</span>
        </div>
      ) : null}

      {view === 'load-error' ? (
        <div className="ln-ai__state" data-tone="error" role="alert">
          <Icon name="alert" size={15} />
          <span>{deepReadT(tr, 'deepread.loadFailed')}</span>
          <Button variant="ghost" size="sm" icon="refresh" onClick={reload}>
            {deepReadT(tr, 'deepread.retry')}
          </Button>
        </div>
      ) : null}

      {view === 'error' ? (
        <ErrorCard
          t={tr}
          message={runError === null ? deepReadT(tr, 'deepread.error.generic') : runError}
          hasRecord={false}
          onRetry={retry}
          onDismiss={dismiss}
        />
      ) : null}

      {view === 'idle' ? <IdleCta t={tr} onStart={start} /> : null}

      {view === 'report' ? (
        <>
          {runError !== null ? (
            <ErrorCard
              t={tr}
              message={runError}
              hasRecord={hasRecord}
              onRetry={retry}
              onDismiss={dismiss}
            />
          ) : null}
          {shownRecord !== null ? (
            <ReportView
              t={tr}
              record={shownRecord}
              annotations={annotations}
              busy={busy}
              annotationsOpen={annotationsOpen}
              onToggleAnnotations={toggleAnnotations}
              onJump={jump}
              onCopy={() => void copyReport()}
              onRerun={rerun}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Idle                                                                       */
/* -------------------------------------------------------------------------- */

/** The idle invitation: promise, cost/time note and the start action. */
function IdleCta({ t, onStart }: { t: AiTranslate; onStart: () => void }): ReactElement {
  return (
    <div className="ln-ai__empty ln-deepread__cta">
      <div className="ln-ai__empty-title">
        <span className="ln-ai__spark" aria-hidden="true">
          ✦
        </span>
        <span>{deepReadT(t, 'deepread.title')}</span>
      </div>
      <p className="ln-ai__empty-text">{deepReadT(t, 'deepread.promise')}</p>
      <p className="ln-ai__hint">{deepReadT(t, 'deepread.cost')}</p>
      <div className="ln-ai__actions">
        <Button variant="primary" size="sm" icon="sparkle" onClick={onStart}>
          {deepReadT(t, 'deepread.start')}
        </Button>
      </div>
      <p className="ln-ai__hint">{deepReadT(t, 'deepread.idleHint')}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

/** The running checklist: phases, counter, progress bar, current section, stop. */
function RunningView({
  t,
  progress,
  onStop,
}: {
  t: AiTranslate
  progress: DeepReadProgress | null
  onStop: () => void
}): ReactElement {
  const current = phaseIndex(progress?.phase ?? 'mapping')
  const done = progress?.done ?? 0
  const total = progress?.total ?? 1
  const percent = progressPercent(progress)
  return (
    <div className="ln-deepread__running">
      <div className="ln-deepread__running-head">
        <div className="ln-deepread__running-title">
          <Spinner size={14} label={deepReadT(t, 'deepread.running')} />
          <span>{deepReadT(t, 'deepread.running')}</span>
        </div>
        <Button variant="ghost" size="sm" icon="stop" onClick={onStop}>
          {deepReadT(t, 'deepread.stop')}
        </Button>
      </div>
      <ProgressBar value={done} total={total} label={deepReadT(t, 'deepread.progressLabel')} />
      <p className="ln-deepread__running-count">
        {deepReadT(t, 'deepread.phaseCount', { done: formatCount(done), total: formatCount(total) })}
        {' · '}
        {formatCount(percent)}%
      </p>
      <ol className="ln-deepread__phases">
        {DEEP_READ_PHASES.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'active' : 'pending'
          return (
            <li key={step.phase} className="ln-deepread__phase" data-state={state}>
              <span className="ln-deepread__phase-mark" aria-hidden="true">
                {state === 'done' ? <Icon name="check" size={12} /> : null}
              </span>
              <span className="ln-deepread__phase-label">{deepReadT(t, step.titleKey)}</span>
            </li>
          )
        })}
      </ol>
      {progress?.section !== undefined ? (
        <p className="ln-deepread__running-section">
          {deepReadT(t, 'deepread.sectionCurrent', { section: boundText(progress.section, 120) })}
        </p>
      ) : null}
      <p className="ln-ai__hint">{deepReadT(t, 'deepread.stopHint')}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Error                                                                      */
/* -------------------------------------------------------------------------- */

/** The run failure card: message, retry, dismiss and the "previous report" note. */
function ErrorCard({
  t,
  message,
  hasRecord,
  onRetry,
  onDismiss,
}: {
  t: AiTranslate
  message: string
  hasRecord: boolean
  onRetry: () => void
  onDismiss: () => void
}): ReactElement {
  return (
    <div className="ln-ai__error ln-deepread__error" role="alert">
      <div className="ln-deepread__error-head">
        <Icon name="alert" size={15} />
        <span className="ln-deepread__error-title">{deepReadT(t, 'deepread.error.title')}</span>
      </div>
      <p className="ln-deepread__error-text">{message}</p>
      {hasRecord ? <p className="ln-deepread__error-note">{deepReadT(t, 'deepread.error.previous')}</p> : null}
      <div className="ln-deepread__error-actions">
        <Button variant="primary" size="sm" icon="refresh" onClick={onRetry}>
          {deepReadT(t, 'deepread.retry')}
        </Button>
        <Button variant="quiet" size="sm" onClick={onDismiss}>
          {deepReadT(t, 'deepread.dismiss')}
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything one persisted run renders in the done state. */
function ReportView({
  t,
  record,
  annotations,
  busy,
  annotationsOpen,
  onToggleAnnotations,
  onJump,
  onCopy,
  onRerun,
}: {
  t: AiTranslate
  record: DeepReadRecord
  annotations: Annotation[]
  busy: boolean
  annotationsOpen: boolean
  onToggleAnnotations: () => void
  onJump: (blockKey: string) => void
  onCopy: () => void
  onRerun: () => void
}): ReactElement {
  const report = record.report
  const pages = useMemo(() => blockPageMap(record), [record])
  const groups = useMemo(() => reportPointGroups(report), [report])
  const highlights = useMemo(() => sortHighlights(record.highlights), [record.highlights])

  const persisted = useMemo(() => {
    if (annotations.length === 0 || record.highlights.length === 0) return 0
    const ids = new Set(annotations.map((annotation) => annotation.id))
    let count = 0
    for (const highlight of record.highlights) {
      if (highlight.annotationId !== '' && ids.has(highlight.annotationId)) count += 1
    }
    return count
  }, [annotations, record.highlights])

  const modelLabel = formatModelLabel(record.model)
  const generatedAt = formatTimestamp(record.generatedAt)
  const stats = record.stats
  const sectionsRead = stats.sectionsRead > 0 ? stats.sectionsRead : stats.sections
  const annotationCount = record.highlights.length
  const coverage = coveragePercent(stats)

  return (
    <div className="ln-deepread__report">
      <header className="ln-deepread__head">
        <div className="ln-deepread__head-row">
          <h3 className="ln-deepread__report-title">{deepReadT(t, 'deepread.reportTitle')}</h3>
          <div className="ln-deepread__report-actions">
            <IconButton icon="copy" size={15} label={deepReadT(t, 'deepread.copy')} onClick={onCopy} />
            <IconButton
              icon="refresh"
              size={15}
              label={deepReadT(t, 'deepread.rerun')}
              disabled={busy}
              onClick={onRerun}
            />
          </div>
        </div>
        <p className="ln-deepread__meta">
          <span>{deepReadT(t, 'deepread.model', { model: modelLabel === '' ? deepReadT(t, 'deepread.modelUnknown') : modelLabel })}</span>
          {generatedAt !== '' ? (
            <>
              <span className="ln-deepread__sep" aria-hidden="true">
                ·
              </span>
              <span>{deepReadT(t, 'deepread.generatedAt', { time: generatedAt })}</span>
            </>
          ) : null}
        </p>
        <p className="ln-deepread__stats">
          <span>{deepReadT(t, 'deepread.stats.sections', { count: formatCount(sectionsRead) })}</span>
          <span className="ln-deepread__sep" aria-hidden="true">
            ·
          </span>
          <span>{deepReadT(t, 'deepread.stats.annotations', { count: formatCount(annotationCount) })}</span>
          <span className="ln-deepread__sep" aria-hidden="true">
            ·
          </span>
          <span>{deepReadT(t, 'deepread.stats.coverage', { percent: formatCount(coverage) })}</span>
        </p>
        {stats.truncated ? (
          <p className="ln-ai__notice">
            <Icon name="info" size={13} />
            <span>{deepReadT(t, 'deepread.truncated')}</span>
          </p>
        ) : null}
      </header>

      {report.tldr.length > 0 ? (
          <section className="ln-deepread__section ln-deepread__section--tldr" data-section="tldr">
            <h4 className="ln-deepread__section-title">{deepReadT(t, 'deepread.section.tldr')}</h4>
            <ul className="ln-deepread__tldr">
              {report.tldr.map((line, index) => (
                <li key={`tldr-${index}`}>{line}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {groups.map((group) => (
          <PointSection
            key={group.id}
            t={t}
            group={group}
            pages={pages}
            onJump={onJump}
          />
        ))}

        {report.argumentMap.length > 0 ? (
          <section className="ln-deepread__section" data-section="argument-map">
            <h4 className="ln-deepread__section-title">{deepReadT(t, 'deepread.section.argumentMap')}</h4>
            <ul className="ln-deepread__edges">
              {report.argumentMap.map((edge, index) => (
                <li key={`edge-${index}`} className="ln-deepread__edge">
                  <span className="ln-deepread__edge-node">{edge.from}</span>
                  <span className="ln-deepread__edge-rel">{edge.relation !== '' ? edge.relation : '→'}</span>
                  <span className="ln-deepread__edge-node">{edge.to}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {report.glossary.length > 0 ? (
          <section className="ln-deepread__section" data-section="glossary">
            <h4 className="ln-deepread__section-title">{deepReadT(t, 'deepread.section.glossary')}</h4>
            <dl className="ln-deepread__glossary">
              {report.glossary.map((entry, index) => {
                const refs = evidenceRefs(entry.blockKeys, pages)
                return (
                  <div key={`gloss-${index}`} className="ln-deepread__gloss">
                    <dt className="ln-deepread__gloss-term">{entry.term}</dt>
                    <dd className="ln-deepread__gloss-def">
                      {entry.definition !== '' ? <p>{entry.definition}</p> : null}
                      <RefChips t={t} refs={refs} onJump={onJump} />
                    </dd>
                  </div>
                )
              })}
            </dl>
          </section>
        ) : null}

        {report.readingPath.length > 0 ? (
          <section className="ln-deepread__section" data-section="reading-path">
            <h4 className="ln-deepread__section-title">{deepReadT(t, 'deepread.section.readingPath')}</h4>
            <ol className="ln-deepread__path">
              {report.readingPath.map((step, index) => (
                <li key={`step-${index}`}>{step}</li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="ln-deepread__section" data-section="verdict">
          <h4 className="ln-deepread__section-title">
            <span>{deepReadT(t, 'deepread.section.verdict')}</span>
            <Badge tone={verdictTone(report.verdict.confidence)}>
              {deepReadT(t, 'deepread.verdict.confidence', {
                level: deepReadT(t, confidenceLabelKey(report.verdict.confidence)),
              })}
            </Badge>
          </h4>
          {report.verdict.strengths.length > 0 || report.verdict.weaknesses.length > 0 ? (
            <div className="ln-deepread__verdict">
              {report.verdict.strengths.length > 0 ? (
                <div className="ln-deepread__verdict-col" data-tone="strength">
                  <h5 className="ln-deepread__verdict-title">{deepReadT(t, 'deepread.verdict.strengths')}</h5>
                  <ul>
                    {report.verdict.strengths.map((item, index) => (
                      <li key={`strength-${index}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {report.verdict.weaknesses.length > 0 ? (
                <div className="ln-deepread__verdict-col" data-tone="weakness">
                  <h5 className="ln-deepread__verdict-title">{deepReadT(t, 'deepread.verdict.weaknesses')}</h5>
                  <ul>
                    {report.verdict.weaknesses.map((item, index) => (
                      <li key={`weakness-${index}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

      {highlights.length > 0 ? (
        <AnnotationsView
          t={t}
          highlights={highlights}
          persisted={persisted}
          open={annotationsOpen}
          onToggle={onToggleAnnotations}
          onJump={onJump}
        />
      ) : null}
    </div>
  )
}

/** Tone of one verdict confidence badge. */
function verdictTone(confidence: DeepReadRecord['report']['verdict']['confidence']): 'success' | 'warn' | 'neutral' {
  if (confidence === 'high') return 'success'
  if (confidence === 'medium') return 'warn'
  return 'neutral'
}

/** Tone of one evidence-strength badge. */
function evidenceTone(evidence: NonNullable<DeepReadPoint['evidence']>): 'success' | 'warn' | 'neutral' {
  if (evidence === 'strong') return 'success'
  if (evidence === 'partial') return 'warn'
  return 'neutral'
}

/* -------------------------------------------------------------------------- */
/* Report sections                                                            */
/* -------------------------------------------------------------------------- */

/** One titled point section (problem/gap/contributions/method/…). */
function PointSection({
  t,
  group,
  pages,
  onJump,
}: {
  t: AiTranslate
  group: DeepReadPointGroup
  pages: ReadonlyMap<string, number>
  onJump: (blockKey: string) => void
}): ReactElement {
  const showEvidence = group.id === 'contributions'
  // The problem/gap sections are single-point groups whose point label is the
  // section title itself (是否由模型或回退生成); repeating it is noise.
  const hideLabel = group.id === 'problem' || group.id === 'gap'
  return (
    <section className="ln-deepread__section" data-section={group.id}>
      <h4 className="ln-deepread__section-title">{deepReadT(t, group.titleKey)}</h4>
      <div className="ln-deepread__points">
        {group.points.map((point, index) => (
          <PointView
            key={`${group.id}-${index}`}
            t={t}
            point={point}
            pages={pages}
            showEvidence={showEvidence}
            hideLabel={hideLabel}
            onJump={onJump}
          />
        ))}
      </div>
    </section>
  )
}

/** One labeled, evidence-anchored report point. */
function PointView({
  t,
  point,
  pages,
  showEvidence,
  hideLabel,
  onJump,
}: {
  t: AiTranslate
  point: DeepReadPoint
  pages: ReadonlyMap<string, number>
  showEvidence: boolean
  /** The group title already names this single point (problem/gap). */
  hideLabel: boolean
  onJump: (blockKey: string) => void
}): ReactElement {
  const refs = evidenceRefs(point.blockKeys, pages)
  const labelKey = showEvidence ? evidenceLabelKey(point.evidence) : null
  const showLabel = !hideLabel && point.label !== ''
  return (
    <article className="ln-deepread__point" data-evidence={point.evidence}>
      {showLabel || labelKey !== null ? (
        <div className="ln-deepread__point-head">
          {showLabel ? <p className="ln-deepread__point-label">{point.label}</p> : null}
          {labelKey !== null && point.evidence !== undefined ? (
            <Badge tone={evidenceTone(point.evidence)}>{deepReadT(t, labelKey)}</Badge>
          ) : null}
        </div>
      ) : null}
      {point.detail !== '' ? (
        <AiMarkdown className="ln-deepread__detail" text={point.detail} renderCitation={renderPlainMarker} />
      ) : null}
      <RefChips t={t} refs={refs} onJump={onJump} />
    </article>
  )
}

/** The `原文 p.N` evidence buttons of one point/glossary entry. */
function RefChips({
  t,
  refs,
  onJump,
}: {
  t: AiTranslate
  refs: readonly DeepReadEvidenceRef[]
  onJump: (blockKey: string) => void
}): ReactElement | null {
  if (refs.length === 0) return null
  return (
    <div className="ln-deepread__refs">
      {refs.map((ref) => (
        <button
          key={ref.blockKey}
          type="button"
          className="ln-deepread__ref"
          onClick={() => onJump(ref.blockKey)}
        >
          {evidenceRefLabel(t, ref)}
        </button>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Annotations                                                                */
/* -------------------------------------------------------------------------- */

/** The collapsible `本次批注` list of annotation cards written by this run. */
function AnnotationsView({
  t,
  highlights,
  persisted,
  open,
  onToggle,
  onJump,
}: {
  t: AiTranslate
  highlights: readonly DeepReadHighlight[]
  persisted: number
  open: boolean
  onToggle: () => void
  onJump: (blockKey: string) => void
}): ReactElement {
  return (
    <section className="ln-deepread__annotations" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="ln-deepread__annotations-toggle"
        aria-expanded={open}
        aria-label={deepReadT(t, 'deepread.annotations')}
        onClick={onToggle}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <span className="ln-deepread__annotations-title">{deepReadT(t, 'deepread.annotations')}</span>
        <span className="ln-deepread__annotations-count ln-tabular">{formatCount(highlights.length)}</span>
        {persisted > 0 ? (
          <span className="ln-deepread__annotations-saved">
            {deepReadT(t, 'deepread.annotations.persisted', {
              written: formatCount(persisted),
              total: formatCount(highlights.length),
            })}
          </span>
        ) : null}
      </button>
      {open ? (
        <ul className="ln-deepread__cards">
          {highlights.map((highlight, index) => (
            <li
              key={`${highlight.blockKey}-${index}`}
              className="ln-deepread__card"
              data-aspect={highlight.aspect}
              data-importance={highlight.importance}
            >
              <div className="ln-deepread__card-head">
                <AspectDot aspect={highlight.aspect} size={7} />
                <span className="ln-deepread__card-aspect">{aiT(t, `aspect.${highlight.aspect}`)}</span>
                {highlight.page !== null ? (
                  <span className="ln-deepread__card-page ln-tabular">
                    {deepReadT(t, 'deepread.jump.page', { page: formatCount(highlight.page) })}
                  </span>
                ) : null}
              </div>
              {highlight.quote !== '' ? (
                <blockquote className="ln-deepread__card-quote">{excerpt(highlight.quote, 160)}</blockquote>
              ) : null}
              {highlight.note !== '' ? <p className="ln-deepread__card-note">{highlight.note}</p> : null}
              {highlight.blockKey !== '' ? (
                <button
                  type="button"
                  className="ln-deepread__card-jump"
                  onClick={() => onJump(highlight.blockKey)}
                >
                  {deepReadT(t, 'deepread.jump.card')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
