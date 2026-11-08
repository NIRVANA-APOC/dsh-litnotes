/**
 * Read-scene context bar — owned by the `client-reader` workstream.
 *
 * Sits in the fixed context-bar region (DESIGN-V2 §4): reading controls on the
 * left (mode, page marks, outline, scale, `AI 精读`, translate-all), document
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
import { useDeepReadStore } from '../ai/deepread-store.ts'
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
  const status = useLibraryStore((state) => state.status)
  const phase = useReaderStore((state) => state.phase)
  const translateAll = useReaderStore((state) => state.translateAll)
  const current = documents.find((document) => document.id === documentId)

  // 精读 needs a parsed paper and a model route; otherwise the margin CTA is
  // the place to start (the composer explains how to configure the model).
  const canDeepRead = current !== undefined && current.status === 'parsed' && status?.ai?.available === true

  const modes: Array<SegmentOption<ReadingMode>> = READING_MODES.map((mode) => ({
    value: mode,
    label: t(`read.mode.${mode}` as 'read.mode.original'),
  }))
  const scaleIndex = READING_SCALES.indexOf(preferences.readingScale as (typeof READING_SCALES)[number])
  const canScaleDown = scaleIndex > 0
  const canScaleUp = scaleIndex >= 0 && scaleIndex < READING_SCALES.length - 1
  const translating = translateAll !== null && translateAll.running

  /**
   * Open the 精读 view in the margin; start the first run only when this paper
   * has no report yet. An in-flight run is never restarted or cancelled here —
   * the click just brings its progress back into view.
   */
  const openDeepRead = (): void => {
    const ui = useUiStore.getState()
    ui.setMarginOpen(true)
    ui.setMarginFilter('deepread')
    const target = documentId
    if (target === null) return
    const deepRead = useDeepReadStore.getState()
    const hasRecord = deepRead.record !== null && deepRead.record.documentId === target
    const running = deepRead.runState === 'running' && deepRead.documentId === target
    // The record may still be loading for a paper that already has a report:
    // never fire a duplicate (expensive) run in that window.
    const loadingRecord = deepRead.recordState === 'loading' && deepRead.documentId === target
    if (hasRecord || running || loadingRecord) return
    void deepRead.start(target).catch(() => {
      /* the panel surfaces the failure with a retry action */
    })
  }

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
          variant="primary"
          size="sm"
          icon="sparkle"
          disabled={!canDeepRead}
          onClick={openDeepRead}
        >
          {t('ai.deepread.open')}
        </Button>
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
