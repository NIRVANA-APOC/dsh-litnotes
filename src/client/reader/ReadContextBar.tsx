/**
 * Read-scene context bar — owned by the `client-reader` workstream.
 *
 * Sits in the fixed context-bar region (DESIGN-V2 §4): reading controls on the
 * left (mode, page marks, outline, scale, translate-all), document
 * actions on the right (aspect legend-as-filter + document menu). The position
 * of every control here must not move between states (position principle).
 *
 * The shell (`src/client/shell/App.tsx`) imports this component by name.
 */

import type { ReactElement } from 'react'
import { READING_MODES, READING_SCALES, ASPECTS } from '../../shared/constants.ts'
import type { ReadingMode } from '../../shared/constants.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { useLibraryStore } from '../state/library.ts'
import { AspectLegend, Button, IconButton, Segmented, type SegmentOption } from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'
import { useReaderStore } from './store.ts'
import { OutlineButton } from './outline.tsx'

/** The read-scene context bar. */
export function ReadContextBar(): ReactElement {
  const t = useT()
  const preferences = useSettingsStore((state) => state.preferences)
  const patch = useSettingsStore((state) => state.patch)
  const documentId = useUiStore((state) => state.currentDocumentId)
  const openDialog = useUiStore((state) => state.openDialog)
  const activeAspect = useUiStore((state) => state.activeAspect)
  const toggleAspect = useUiStore((state) => state.toggleAspect)
  const documents = useLibraryStore((state) => state.documents)
  const phase = useReaderStore((state) => state.phase)
  const translateAll = useReaderStore((state) => state.translateAll)
  const current = documents.find((document) => document.id === documentId)

  const modes: Array<SegmentOption<ReadingMode>> = READING_MODES.map((mode) => ({
    value: mode,
    label: t(`read.mode.${mode}` as 'read.mode.original'),
  }))
  const scaleIndex = READING_SCALES.indexOf(preferences.readingScale as (typeof READING_SCALES)[number])
  const canScaleDown = scaleIndex > 0
  const canScaleUp = scaleIndex >= 0 && scaleIndex < READING_SCALES.length - 1
  const translating = translateAll !== null && translateAll.running

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
        <IconButton
          icon="eye"
          label={t('read.controls.pageMarks')}
          size={16}
          pressed={preferences.showPageMarks}
          onClick={() => void patch({ showPageMarks: !preferences.showPageMarks })}
        />
        <OutlineButton />
        <IconButton
          icon="minus"
          label={t('read.controls.scaleDown')}
          size={16}
          disabled={!canScaleDown}
          onClick={() => {
            if (!canScaleDown) return
            const next = READING_SCALES[scaleIndex - 1]
            if (next !== undefined) void patch({ readingScale: next })
          }}
        />
        <IconButton
          icon="plus"
          label={t('read.controls.scaleUp')}
          size={16}
          disabled={!canScaleUp}
          onClick={() => {
            if (!canScaleUp) return
            const next = READING_SCALES[scaleIndex + 1]
            if (next !== undefined) void patch({ readingScale: next })
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="translate"
          disabled={phase !== 'ready' || translating}
          onClick={() => void useReaderStore.getState().translateAllBlocks()}
        >
          {t('read.controls.translateAll')}
        </Button>
      </div>
      <div className="ln-contextbar__right">
        <AspectLegend
          aspects={ASPECTS}
          active={activeAspect}
          onToggle={(aspect) => toggleAspect(aspect as (typeof ASPECTS)[number])}
          labelOf={(aspect) =>
            aspect === 'legend'
              ? t('aspect.legend')
              : t(`aspect.${aspect}` as 'aspect.definition')
          }
        />
        {current === undefined ? null : (
          <IconButton
            icon="more"
            label={t('action.more')}
            onClick={() => openDialog('reparse', current.id)}
          />
        )}
      </div>
    </div>
  )
}
