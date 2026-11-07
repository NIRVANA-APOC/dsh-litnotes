/**
 * Graph scene — owned by the `client-graph` workstream.
 *
 * This file starts as the Lead's scaffold (stage + margin seat). Replace it
 * with the d3-force canvas, HUD, node card and curation per
 * `.agents/plan/DESIGN-V2.md` §5. Keep the component name and signature so
 * `src/client/shell/scenes.tsx` keeps compiling.
 */

import type { ReactElement } from 'react'
import type { DocumentSummary } from '../../shared/model.ts'
import { useUiStore } from '../state/ui.ts'
import { useT } from '../shell/locale-context.ts'

/** Props supplied by the shell: the open document (may be undefined for library scope). */
export interface GraphSceneProps {
  document: DocumentSummary | null
}

/** The knowledge-map scene. */
export function GraphScene({ document }: GraphSceneProps): ReactElement {
  const t = useT()
  const marginOpen = useUiStore((state) => state.marginOpen)
  return (
    <div className="ln-graph" data-scope={document === null ? 'library' : 'doc'}>
      <div className="ln-graph__canvas ln-graph__canvas--placeholder">
        <span className="ln-graph__placeholderText">{t('empty.loading')}</span>
      </div>
      {marginOpen ? (
        <aside className="ln-sheet__margin ln-graph__margin" aria-label={t('top.margin')}>
          <div className="ln-margin__head">
            <span>{t('top.margin')}</span>
          </div>
        </aside>
      ) : null}
    </div>
  )
}
