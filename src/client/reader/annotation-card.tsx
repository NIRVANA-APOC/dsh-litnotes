/**
 * Anchored annotation card: clicking a highlight opens this popover at the
 * marked sentence, showing the note (or the quoted text when the note is
 * empty) plus edit/delete actions. It restores the original reading-desk
 * behaviour where a highlight answers in place instead of only scrolling the
 * margin.
 */

import { autoUpdate, flip, offset, shift, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react'
import type { ReactElement } from 'react'
import { useLayoutEffect, useMemo } from 'react'

import type { NormalizedAnnotation } from '../../shared/annotate/highlight.ts'
import { IconButton } from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'

/** Props of the anchored annotation card. */
export interface AnnotationCardProps {
  annotation: NormalizedAnnotation | null
  anchor: HTMLElement | null
  onClose: () => void
  onEdit: (annotation: NormalizedAnnotation) => void
  onDelete: (annotation: NormalizedAnnotation) => void
}

/** Fixed-position popover anchored to the clicked highlight. */
export function AnnotationCard({ annotation, anchor, onClose, onEdit, onDelete }: AnnotationCardProps): ReactElement | null {
  const t = useT()
  const open = annotation !== null && anchor !== null
  // The reader's other overlays (selection toolbar, note editor) anchor to
  // captured rectangles through a virtual reference; following the same path
  // avoids offset-parent surprises inside the scrolling sheet and keeps the
  // card glued to the sentence while the paper scrolls.
  const reference = useMemo(() => {
    if (anchor === null) return null
    return {
      getBoundingClientRect: (): DOMRect => anchor.getBoundingClientRect(),
    }
  }, [anchor])
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) onClose()
    },
    strategy: 'fixed',
    placement: 'bottom',
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
  })
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  useLayoutEffect(() => {
    refs.setPositionReference(reference)
  }, [reference, refs])

  if (annotation === null || anchor === null) return null
  const aspect = annotation.aspect ?? 'context'
  const ai = annotation.origin === 'ai'
  const note = typeof annotation.note === 'string' ? annotation.note.trim() : ''
  const quote = typeof annotation.quote === 'string' ? annotation.quote.trim() : ''

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className="ln-anncard"
      data-aspect={aspect}
      data-origin={ai ? 'ai' : 'user'}
      role="dialog"
      aria-label={t('read.annCard.label')}
      {...getFloatingProps()}
    >
      <header className="ln-anncard__head">
        <span className="ln-aspectdot" data-aspect={aspect} aria-hidden="true" />
        <span className="ln-anncard__aspect">{t(`aspect.${aspect}` as 'aspect.context')}</span>
        <span className="ln-anncard__origin" title={ai ? t('read.annCard.ai') : t('read.annCard.user')}>
          {ai ? '✦' : '●'}
        </span>
        <span className="ln-anncard__spacer" />
        <IconButton icon="close" label={t('action.close')} size={14} onClick={onClose} />
      </header>
      {note === '' ? null : <p className="ln-anncard__note">{note}</p>}
      {quote === '' ? null : (
        <blockquote className="ln-anncard__quote">
          <span>{quote}</span>
        </blockquote>
      )}
      <footer className="ln-anncard__actions">
        <button type="button" className="ln-anncard__action" onClick={() => onEdit(annotation)}>
          {t('read.annCard.edit')}
        </button>
        <button
          type="button"
          className="ln-anncard__action ln-anncard__action--danger"
          onClick={() => onDelete(annotation)}
        >
          {t('read.annCard.delete')}
        </button>
      </footer>
    </div>
  )
}
