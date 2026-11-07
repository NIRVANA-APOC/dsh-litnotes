/**
 * Reader scene — owned by the `client-reader` workstream.
 *
 * This file starts as the Lead's scaffold of the sheet layout (gutter +
 * paper + margin). Replace the construction placeholder with the real paper
 * rendering, selection toolbar, translation and margin notes per
 * `.agents/plan/DESIGN-V2.md` §5–6. Keep the component name and signature so
 * `src/client/shell/scenes.tsx` keeps compiling.
 */

import type { ReactElement } from 'react'
import type { DocumentSummary } from '../../shared/model.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { useT } from '../shell/locale-context.ts'

/** Props supplied by the shell: the open document. */
export interface ReadSceneProps {
  document: DocumentSummary
}

/** The reading scene. */
export function ReadScene({ document }: ReadSceneProps): ReactElement {
  const t = useT()
  const preferences = useSettingsStore((state) => state.preferences)
  const marginOpen = useUiStore((state) => state.marginOpen)
  return (
    <div
      className="ln-reader"
      data-mode={preferences.readingMode}
      style={{ ['--ln-measure' as string]: `${preferences.readingMeasure}px` }}
    >
      <div className="ln-reader__scroll ln-scroll">
        <article className="ln-sheet">
          <div className="ln-sheet__gutter" aria-hidden="true" />
          <div className="ln-sheet__paper">
            <header className="ln-paper__titleblock">
              <h1 className="ln-paper__title">{document.title}</h1>
              <p className="ln-paper__meta ln-tabular">{document.originalName}</p>
              <div className="ln-paper__rule" aria-hidden="true" />
            </header>
            <div className="ln-reader__construction" role="status">
              <span className="ln-spinner" style={{ width: 18, height: 18 }} aria-label={t('empty.loading')} />
              <p>{t('empty.loading')}</p>
            </div>
          </div>
          {marginOpen ? (
            <aside className="ln-sheet__margin" aria-label={t('top.margin')}>
              <div className="ln-margin__head">
                <span>{t('top.margin')}</span>
              </div>
            </aside>
          ) : null}
        </article>
      </div>
    </div>
  )
}
