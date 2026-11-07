/**
 * Outline popover — the contextbar trigger for the paper's section list.
 *
 * Lives in the read-scene contextbar (fixed position per DESIGN-V2 §4) and
 * positions its panel with floating-ui. Clicking an entry scrolls the sheet to
 * the heading (the store's jump signal), and the popover closes on selection,
 * outside click and Escape (floating-ui dismiss interaction).
 */

import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { useAnchored } from '../design/primitives.tsx'
import { Icon } from '../design/icons.tsx'
import { useT } from '../shell/locale-context.ts'
import { useReaderStore } from './store.ts'

/** Contextbar outline trigger + popover. */
export function OutlineButton(): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const model = useReaderStore((state) => state.model)
  const document = useReaderStore((state) => state.document)
  const requestJump = useReaderStore((state) => state.requestJump)
  const { refs, floatingStyles, getReferenceProps, getFloatingProps } = useAnchored({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
  })

  const outline = useMemo(() => {
    const title = (document?.title ?? '').trim().toLowerCase()
    return model.outline.filter((entry) => {
      if (title === '') return true
      return !(entry.level === 1 && entry.text.trim().toLowerCase() === title)
    })
  }, [document, model])

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        className="ln-iconbtn"
        aria-label={t('read.controls.outline')}
        title={t('read.controls.outline')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        {...getReferenceProps()}
      >
        <Icon name="list" size={16} />
      </button>
      {open ? (
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="ln-pop ln-outline"
          role="dialog"
          aria-label={t('read.outline.title')}
          {...getFloatingProps()}
        >
          <div className="ln-outline__head">
            <span>{t('read.outline.title')}</span>
            <button
              type="button"
              className="ln-iconbtn"
              aria-label={t('action.close')}
              title={t('action.close')}
              onClick={() => setOpen(false)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          {outline.length === 0 ? (
            <p className="ln-outline__empty">{t('read.outline.empty')}</p>
          ) : (
            <nav className="ln-outline__list" aria-label={t('read.outline.title')}>
              {outline.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`ln-outline__item ln-outline__item--l${Math.min(4, Math.max(1, entry.level))}`}
                  title={entry.text}
                  onClick={() => {
                    setOpen(false)
                    requestJump(entry.key, { flash: false })
                  }}
                >
                  {entry.text}
                </button>
              ))}
            </nav>
          )}
        </div>
      ) : null}
    </>
  )
}
