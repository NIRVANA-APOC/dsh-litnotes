/**
 * Graph-scene context bar — owned by the `client-graph` workstream.
 *
 * Sits in the fixed context-bar region (DESIGN-V2 §4): scope switch + filters
 * on the left, build/rebuild actions on the right. Keep the exported name; the
 * shell imports it.
 */

import type { ReactElement } from 'react'
import { ASPECTS } from '../../shared/constants.ts'
import { AspectLegend, Segmented } from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'

/** The graph-scene context bar. */
export function GraphContextBar(): ReactElement {
  const t = useT()
  return (
    <div className="ln-contextbar">
      <div className="ln-contextbar__left">
        <Segmented
          size="sm"
          value="doc"
          options={[
            { value: 'doc', label: t('graph.scope.doc') },
            { value: 'library', label: t('graph.scope.library') },
          ]}
          onChange={() => {}}
          ariaLabel={t('graph.scope.switch')}
        />
      </div>
      <div className="ln-contextbar__right">
        <AspectLegend
          aspects={ASPECTS}
          labelOf={(aspect) => (aspect === 'legend' ? t('aspect.legend') : t(`aspect.${aspect}` as 'aspect.method'))}
        />
      </div>
    </div>
  )
}
