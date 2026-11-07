/**
 * Margin notes: the reader's own marks in the margin stream, sorted by where
 * they sit in the paper, plus the note editor popover.
 *
 * The AI conversation entries are rendered by `client-ai`'s `AiMarginEntries`
 * component inside the same margin column; notes and AI entries share the same
 * document-order comparator (`orderOf`) and the same tether layer
 * (`data-anchor-block` on every entry root).
 */

import type { ReactElement } from 'react'
import type { LitnotesTranslate } from '../shell/locale-context.ts'
import type { Aspect, AnnotationColor } from '../../shared/constants.ts'
import { ASPECT_COLORS, ASPECTS } from '../../shared/constants.ts'
import type { NormalizedAnnotation } from '../../shared/annotate/highlight.ts'
import { AspectDot, IconButton, Textarea, cx } from '../design/primitives.tsx'
import { useRectFloating } from './floating.ts'
import type { StaleAnnotation } from './annotations.ts'
import type { MarginFilter } from '../state/ui.ts'

/** Aspect ink for an annotation: explicit aspect first, annotation color second. */
export function aspectOfAnnotation(annotation: NormalizedAnnotation): Aspect | null {
  if (annotation.aspect !== undefined) return annotation.aspect
  switch (annotation.color) {
    case 'sage':
      return 'method'
    case 'sky':
      return 'result'
    case 'rose':
      return 'limitation'
    case 'yellow':
      return 'definition'
    default:
      return null
  }
}

/** Ink color for an aspect (the aspect picker stores the mapped color). */
export function colorOfAspect(aspect: Aspect): AnnotationColor {
  return ASPECT_COLORS[aspect]
}

/** Stable document-order comparator for margin entries. */
export function compareByAnchor(
  left: { blockKey: string; createdAt?: string },
  right: { blockKey: string; createdAt?: string },
  orderOf: (blockKey: string) => number | null,
): number {
  const leftOrder = orderOf(left.blockKey)
  const rightOrder = orderOf(right.blockKey)
  const leftRank = leftOrder === null ? Number.POSITIVE_INFINITY : leftOrder
  const rightRank = rightOrder === null ? Number.POSITIVE_INFINITY : rightOrder
  if (leftRank !== rightRank) return leftRank - rightRank
  return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
}

/** Short relative-ish time for a note slip (Intl, platform). */
export function formatNoteTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(5, 16).replace('T', ' ')
  }
}

/** Props of one note slip. */
export interface NoteEntryProps {
  t: LitnotesTranslate
  annotation: NormalizedAnnotation
  active: boolean
  hovered: boolean
  onHover: (annotationId: string | null, blockKey: string | null) => void
  onActivate: (annotation: NormalizedAnnotation) => void
  onEdit: (annotation: NormalizedAnnotation) => void
  onDelete: (annotation: NormalizedAnnotation) => void
}

/** One margin note slip with tether anchor attributes. */
export function NoteEntry({
  t,
  annotation,
  active,
  hovered,
  onHover,
  onActivate,
  onEdit,
  onDelete,
}: NoteEntryProps): ReactElement {
  const aspect = aspectOfAnnotation(annotation)
  const ai = annotation.origin === 'ai'
  const aspectLabel = aspect === null ? '' : t(`aspect.${aspect}` as 'aspect.method')
  return (
    <article
      className={cx('ln-margin__entry', 'ln-note', active && 'is-active', hovered && 'is-hover', ai && 'is-ai')}
      data-kind="note"
      data-aspect={aspect ?? undefined}
      data-color={annotation.color}
      data-origin={annotation.origin ?? 'user'}
      data-anchor-block={annotation.blockKey}
      data-anchor-id={annotation.id}
      data-annotation-id={annotation.id}
      tabIndex={0}
      onMouseEnter={() => onHover(annotation.id, annotation.blockKey)}
      onMouseLeave={() => onHover(null, null)}
      onFocus={() => onHover(annotation.id, annotation.blockKey)}
      onBlur={() => onHover(null, null)}
      onClick={() => onActivate(annotation)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onActivate(annotation)
      }}
    >
      <div className="ln-note__head">
        <AspectDot aspect={aspect ?? 'context'} />
        {ai ? (
          <span className="ln-note__origin" title={t('margin.noteAiOriginPlain')}>
            {aspectLabel === ''
              ? t('margin.noteAiOriginPlain')
              : t('margin.noteAiOrigin', { aspect: aspectLabel })}
          </span>
        ) : null}
        <time className="ln-note__time ln-tabular">
          {formatNoteTime(annotation.updatedAt ?? annotation.createdAt)}
        </time>
        <span className="ln-note__actions">
          <IconButton
            icon="edit"
            size={13}
            label={t('margin.noteEdit')}
            onClick={(event) => {
              event.stopPropagation()
              onEdit(annotation)
            }}
          />
          <IconButton
            icon="trash"
            size={13}
            label={t('margin.noteDelete')}
            onClick={(event) => {
              event.stopPropagation()
              onDelete(annotation)
            }}
          />
        </span>
      </div>
      <blockquote className="ln-note__quote">{annotation.quote}</blockquote>
      {annotation.note !== undefined && annotation.note !== '' ? (
        <p className="ln-note__body">{annotation.note}</p>
      ) : null}
    </article>
  )
}

/** Props of one stale (unlocatable) note slip. */
export interface StaleNoteEntryProps {
  t: LitnotesTranslate
  annotation: StaleAnnotation
  onDelete: (annotation: StaleAnnotation) => void
}

/** A note whose block anchor no longer resolves: shown, savable, not jumpable. */
export function StaleNoteEntry({ t, annotation, onDelete }: StaleNoteEntryProps): ReactElement {
  const aspect = aspectOfAnnotation(annotation)
  return (
    <article
      className="ln-margin__entry ln-note is-stale"
      data-kind="note"
      data-origin={annotation.origin ?? 'user'}
      data-aspect={aspect ?? undefined}
      data-annotation-id={annotation.id}
      data-stale="true"
    >
      <div className="ln-note__head">
        <AspectDot aspect={aspect ?? 'context'} />
        <span className="ln-note__staleTag">{t('margin.staleTag')}</span>
        <time className="ln-note__time ln-tabular">
          {formatNoteTime(annotation.updatedAt ?? annotation.createdAt)}
        </time>
        <span className="ln-note__actions">
          <IconButton
            icon="trash"
            size={13}
            label={t('margin.noteDelete')}
            onClick={() => onDelete(annotation)}
          />
        </span>
      </div>
      <blockquote className="ln-note__quote">{annotation.quote}</blockquote>
      {annotation.note !== '' ? <p className="ln-note__body">{annotation.note}</p> : null}
    </article>
  )
}

/** Props of the margin notes list. */
export interface MarginNotesProps {
  t: LitnotesTranslate
  annotations: NormalizedAnnotation[]
  staleAnnotations: StaleAnnotation[]
  droppedAnnotations: number
  /** Origin/aspect filter state (Lead-owned UI store). */
  marginFilter: MarginFilter
  activeAspect: string | null
  activeAnnotationId: string | null
  hoveredAnnotationId: string | null
  orderOf: (blockKey: string) => number | null
  onHover: (annotationId: string | null, blockKey: string | null) => void
  onActivate: (annotation: NormalizedAnnotation) => void
  onEdit: (annotation: NormalizedAnnotation) => void
  onDelete: (annotation: NormalizedAnnotation) => void
  onDeleteStale: (annotation: StaleAnnotation) => void
  onClearFilters: () => void
}

/** Whether one annotation is visible under the current margin filters. */
function matchesFilter(
  annotation: { origin?: 'user' | 'ai'; aspect?: Aspect },
  marginFilter: MarginFilter,
  activeAspect: string | null,
): boolean {
  if (marginFilter === 'chat') return false
  if (marginFilter === 'ai' && annotation.origin !== 'ai') return false
  if (marginFilter === 'user' && annotation.origin === 'ai') return false
  if (activeAspect !== null && annotation.aspect !== activeAspect) return false
  return true
}

/** The reader notes section of the margin stream. */
export function MarginNotes({
  t,
  annotations,
  staleAnnotations,
  droppedAnnotations,
  marginFilter,
  activeAspect,
  activeAnnotationId,
  hoveredAnnotationId,
  orderOf,
  onHover,
  onActivate,
  onEdit,
  onDelete,
  onDeleteStale,
  onClearFilters,
}: MarginNotesProps): ReactElement {
  const total = annotations.length + staleAnnotations.length
  const visible = annotations
    .filter((annotation) => matchesFilter(annotation, marginFilter, activeAspect))
    .sort((left, right) => compareByAnchor(left, right, orderOf))
  const visibleStale = staleAnnotations.filter((annotation) =>
    matchesFilter(annotation, marginFilter, activeAspect),
  )
  const filtering = marginFilter !== 'all' || activeAspect !== null
  const empty = visible.length === 0 && visibleStale.length === 0
  return (
    <section className="ln-margin__notes" aria-label={t('margin.notesCount', { count: total })}>
      {droppedAnnotations > 0 ? (
        <p className="ln-margin__notice">{t('margin.dropped', { count: droppedAnnotations })}</p>
      ) : null}
      {visibleStale.length > 0 ? (
        <p className="ln-margin__notice" role="status">
          {t('margin.staleNotice', { count: visibleStale.length })}
        </p>
      ) : null}
      {empty ? (
        <div className="ln-margin__empty">
          <span>{total === 0 ? t('margin.empty') : t('margin.emptyFiltered')}</span>
          {filtering ? (
            <button type="button" className="ln-link-btn" onClick={onClearFilters}>
              {t('margin.clearFilters')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="ln-margin__stream">
          {visible.map((annotation) => (
            <NoteEntry
              key={annotation.id}
              t={t}
              annotation={annotation}
              active={activeAnnotationId === annotation.id}
              hovered={hoveredAnnotationId === annotation.id}
              onHover={onHover}
              onActivate={onActivate}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
          {visibleStale.length > 0 ? (
            <section className="ln-margin__stale">
              <h3 className="ln-margin__staleTitle">{t('margin.staleSection')}</h3>
              {visibleStale.map((annotation) => (
                <StaleNoteEntry
                  key={`stale-${annotation.id}`}
                  t={t}
                  annotation={annotation}
                  onDelete={onDeleteStale}
                />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Note editor                                                                */
/* -------------------------------------------------------------------------- */

/** State of the open note editor (create or edit). */
export interface NoteEditorState {
  mode: 'create' | 'edit'
  /** Set when editing an existing annotation. */
  annotationId: string | null
  blockKey: string
  start: number
  end: number
  quote: string
  note: string
  color: AnnotationColor
  aspect: Aspect | ''
  origin: 'user' | 'ai'
  /** Anchor rectangle (selection or margin slip). */
  rect: DOMRect | null
}

/** Props of the note editor popover. */
export interface NoteEditorProps {
  t: LitnotesTranslate
  editor: NoteEditorState
  onChange: (patch: Partial<NoteEditorState>) => void
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
}

/** The inline note editor (create from selection/block, edit from a slip). */
export function NoteEditor({
  t,
  editor,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: NoteEditorProps): ReactElement {
  const { setFloating, floatingStyles } = useRectFloating(editor.rect, 'bottom-start')
  const aiNote = editor.origin === 'ai'
  return (
    <div
      ref={setFloating}
      style={floatingStyles}
      className="ln-noteeditor"
      role="dialog"
      aria-label={t('note.title')}
    >
      {aiNote ? (
        <div className="ln-noteeditor__origin">{t('margin.noteAiOriginPlain')}</div>
      ) : null}
      <blockquote className="ln-noteeditor__quote">{editor.quote}</blockquote>
      {aiNote ? null : (
        <div
          className="ln-aspectpicker"
          role="radiogroup"
          aria-label={t('note.aspect')}
        >
          {ASPECTS.map((aspect) => {
            const selected = editor.aspect === aspect
            return (
              <button
                key={aspect}
                type="button"
                role="radio"
                aria-checked={selected}
                className={cx('ln-aspectpicker__item', selected && 'is-selected')}
                data-aspect={aspect}
                title={t(`aspect.${aspect}` as 'aspect.method')}
                onClick={() =>
                  onChange({
                    aspect,
                    color: colorOfAspect(aspect),
                  })
                }
              >
                <span className="ln-aspectpicker__dot" aria-hidden="true" />
                <span>{t(`aspect.${aspect}` as 'aspect.method')}</span>
              </button>
            )
          })}
        </div>
      )}
      <Textarea
        className="ln-noteeditor__input"
        value={editor.note}
        placeholder={t('note.placeholder')}
        aria-label={t('note.placeholder')}
        autoFocus
        rows={3}
        onChange={(event) => onChange({ note: event.currentTarget.value })}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            onSave()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="ln-noteeditor__foot">
        {editor.mode === 'edit' ? (
          <button type="button" className="ln-btn ln-btn--ghost ln-btn--sm ln-btn--danger" onClick={onDelete}>
            {editor.note === '' ? t('sel.removeHighlight') : t('note.delete')}
          </button>
        ) : null}
        <span className="ln-noteeditor__spacer" />
        <button type="button" className="ln-btn ln-btn--ghost ln-btn--sm" onClick={onCancel}>
          {t('note.cancel')}
        </button>
        <button type="button" className="ln-btn ln-btn--primary ln-btn--sm" onClick={onSave}>
          {t('note.save')}
        </button>
      </div>
    </div>
  )
}
