/**
 * Margin stream filter chips (全部 / 对话 / AI 批注 / 我的批注 + counts).
 *
 * The shared filter lives in the Lead-owned UI store (`useUiStore.marginFilter`)
 * and is persisted host-side for the origin filters; the reader's note list and
 * this AI stream read the same value so the margin never shows two disagreeing
 * filters. The chips are the AI workstream's header inside the margin column.
 */

import type { ReactElement } from 'react'
import { Chip } from '../design/primitives.tsx'
import { useUiStore } from '../state/ui.ts'
import type { MarginFilter } from '../state/ui.ts'
import { useT } from '../shell/locale-context.ts'

/** Counts shown on the four chips. */
export interface MarginFilterCounts {
  chat: number
  ai: number
  user: number
}

/** Props of {@link AiMarginFilterChips}. */
export interface AiMarginFilterChipsProps {
  counts: MarginFilterCounts
}

/** One filter definition: value, i18n key and count. */
interface FilterDef {
  value: MarginFilter
  key: 'ai.filter.all' | 'ai.filter.chat' | 'ai.filter.ai' | 'ai.filter.user'
  count: number
}

/**
 * The margin filter header: four toggle chips with counts.
 *
 * Rendered above the AI entries; the reader's note slips and the AI stream both
 * honor the selected value.
 */
export function AiMarginFilterChips({ counts }: AiMarginFilterChipsProps): ReactElement {
  const t = useT()
  const filter = useUiStore((state) => state.marginFilter)
  const setFilter = useUiStore((state) => state.setMarginFilter)
  const definitions: FilterDef[] = [
    { value: 'all', key: 'ai.filter.all', count: counts.chat + counts.ai + counts.user },
    { value: 'chat', key: 'ai.filter.chat', count: counts.chat },
    { value: 'ai', key: 'ai.filter.ai', count: counts.ai },
    { value: 'user', key: 'ai.filter.user', count: counts.user },
  ]
  return (
    <div className="ln-ai__filters" role="group" aria-label={t('ai.filter.label')}>
      {definitions.map((definition) => (
        <Chip
          key={definition.value}
          pressed={filter === definition.value}
          count={definition.count}
          onClick={() => setFilter(definition.value)}
        >
          {t(definition.key)}
        </Chip>
      ))}
    </div>
  )
}
