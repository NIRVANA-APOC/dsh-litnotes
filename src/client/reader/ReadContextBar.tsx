/**
 * Read-scene context bar — owned by the `client-reader` workstream.
 *
 * Sits in the fixed context-bar region (DESIGN-V2 §4): reading controls on the
 * left, document actions on the right. Keep the exported name; the shell
 * imports it.
 */

import type { ReactElement } from 'react'
import { ASPECTS, READING_MEASURES, READING_MODES } from '../../shared/constants.ts'
import type { ReadingMode } from '../../shared/constants.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { AspectLegend, IconButton, Segmented, type SegmentOption } from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'
import { useLibraryStore } from '../state/library.ts'

/** The read-scene context bar. */
export function ReadContextBar(): ReactElement {
  const t = useT()
  const preferences = useSettingsStore((state) => state.preferences)
  const patch = useSettingsStore((state) => state.patch)
  const documentId = useUiStore((state) => state.currentDocumentId)
  const openDialog = useUiStore((state) => state.openDialog)
  const documents = useLibraryStore((state) => state.documents)
  const current = documents.find((document) => document.id === documentId)

  const modes: Array<SegmentOption<ReadingMode>> = READING_MODES.map((mode) => ({
    value: mode,
    label: t(`read.mode.${mode}` as 'read.mode.original'),
  }))
  const measureOptions: Array<SegmentOption<string>> = READING_MEASURES.map((value) => ({
    value: String(value),
    label: `${value}`,
  }))

  return (
    <div className="ln-contextbar">
      <div className="ln-contextbar__left">
        <Segmented
          size="sm"
          value={preferences.readingMode}
          options={modes}
          onChange={(mode) => void patch({ readingMode: mode })}
          ariaLabel={t('read.controls.mode')}
        />
        <Segmented
          size="sm"
          value={String(preferences.readingMeasure)}
          options={measureOptions}
          onChange={(value) => void patch({ readingMeasure: Number(value) as 500 | 560 | 700 | 840 })}
          ariaLabel={t('read.controls.measure')}
        />
        <IconButton
          icon="list"
          label={t('read.controls.pageMarks')}
          size={16}
          pressed={preferences.showPageMarks}
          onClick={() => void patch({ showPageMarks: !preferences.showPageMarks })}
        />
      </div>
      <div className="ln-contextbar__right">
        <AspectLegend
          aspects={ASPECTS}
          labelOf={(aspect) => (aspect === 'legend' ? t('aspect.legend') : t(`aspect.${aspect}` as 'aspect.method'))}
        />
        {current === undefined ? null : (
          <IconButton icon="more" label={t('action.more')} onClick={() => openDialog('reparse', current.id)} />
        )}
      </div>
    </div>
  )
}
