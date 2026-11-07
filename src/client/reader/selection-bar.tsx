/**
 * Selection toolbar (`.ln-selbar`) — the fixed-order actions for a live text
 * selection: 高亮 ▾ · 批注 · 问 AI · 翻译 (DESIGN-V2 §5/§6).
 *
 * Positioned with floating-ui against the selection rectangle, above it by
 * default and flipped below when there is no room. Clicking a button must not
 * collapse the native selection before the action runs, so the bar cancels
 * mousedown; the scene keeps the captured selection state anyway.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { LitnotesTranslate } from '../shell/locale-context.ts'
import { ANNOTATION_COLORS } from '../../shared/constants.ts'
import type { AnnotationColor } from '../../shared/constants.ts'
import { Icon } from '../design/icons.tsx'
import { cx } from '../design/primitives.tsx'
import { useRectFloating } from './floating.ts'
import type { ReaderSelection } from './selection.ts'

/** Props of the selection toolbar. */
export interface SelectionToolbarProps {
  t: LitnotesTranslate
  selection: ReaderSelection
  onHighlight: (color: AnnotationColor) => void
  onNote: () => void
  onAsk: () => void
  onTranslate: () => void
  onCopy: () => void
  onRemoveHighlight: (ids: string[]) => void
}

/** Ink label key for one annotation color. */
function inkLabelKey(color: AnnotationColor): 'ink.yellow' | 'ink.sage' | 'ink.sky' | 'ink.rose' {
  switch (color) {
    case 'sage':
      return 'ink.sage'
    case 'sky':
      return 'ink.sky'
    case 'rose':
      return 'ink.rose'
    default:
      return 'ink.yellow'
  }
}

/** The floating selection toolbar. */
export function SelectionToolbar({
  t,
  selection,
  onHighlight,
  onNote,
  onAsk,
  onTranslate,
  onCopy,
  onRemoveHighlight,
}: SelectionToolbarProps): ReactElement {
  const { setFloating, floatingStyles } = useRectFloating(selection.rect, 'top-start', 10)
  const [inksOpen, setInksOpen] = useState(false)
  const firstRef = useRef<HTMLButtonElement | null>(null)
  const removable = selection.annotationIds.length > 0

  useEffect(() => {
    if (selection.source === 'keyboard') firstRef.current?.focus()
  }, [selection])

  const highlight = (color: AnnotationColor): void => {
    setInksOpen(false)
    onHighlight(color)
  }

  return (
    <div
      ref={setFloating}
      style={floatingStyles}
      className="ln-selbar"
      role="toolbar"
      aria-label={t('sel.toolbar')}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="ln-selbar__group">
        <button
          ref={firstRef}
          type="button"
          className="ln-selbar__btn ln-selbar__btn--primary"
          onClick={() => highlight('yellow')}
        >
          <Icon name="highlight" size={14} />
          <span>{t('sel.highlight')}</span>
        </button>
        <button
          type="button"
          className="ln-selbar__btn ln-selbar__chevron"
          aria-label={t('sel.colors')}
          aria-haspopup="menu"
          aria-expanded={inksOpen}
          onClick={() => setInksOpen((value) => !value)}
        >
          <Icon name="chevronDown" size={13} />
        </button>
        {inksOpen ? (
          <div className="ln-selbar__inks" role="menu" aria-label={t('sel.colors')}>
            {ANNOTATION_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="menuitem"
                className={cx('ln-swatch', `ln-swatch--${color}`)}
                data-color={color}
                aria-label={t(inkLabelKey(color))}
                title={t(inkLabelKey(color))}
                onClick={() => highlight(color)}
              />
            ))}
          </div>
        ) : null}
      </div>
      <span className="ln-selbar__sep" aria-hidden="true" />
      <button type="button" className="ln-selbar__btn" onClick={onNote}>
        <Icon name="note" size={14} />
        <span>{t('sel.note')}</span>
      </button>
      <button type="button" className="ln-selbar__btn ln-selbar__btn--ai" onClick={onAsk}>
        <Icon name="sparkle" size={14} />
        <span>{t('sel.askAi')}</span>
      </button>
      <button type="button" className="ln-selbar__btn" onClick={onTranslate}>
        <Icon name="translate" size={14} />
        <span>{t('sel.translate')}</span>
      </button>
      {removable ? (
        <button
          type="button"
          className="ln-selbar__btn ln-selbar__btn--danger"
          onClick={() => onRemoveHighlight(selection.annotationIds)}
        >
          <Icon name="trash" size={14} />
          <span>{t('sel.removeHighlight')}</span>
        </button>
      ) : null}
      <span className="ln-selbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="ln-selbar__btn ln-selbar__icon"
        aria-label={t('sel.copy')}
        title={t('sel.copy')}
        onClick={onCopy}
      >
        <Icon name="copy" size={14} />
      </button>
    </div>
  )
}
