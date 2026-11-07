/**
 * Reading-desk frame: top bar, context bar, status bar and the toast host.
 *
 * The frame owns the *positions*: the wordmark, breadcrumb, scene switch and
 * the utility cluster keep the same place in every scene (DESIGN-V2 §4). The
 * scenes themselves render inside `.ln-stage`.
 */

import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { useLibraryStore } from '../state/library.ts'
import { useUiStore } from '../state/ui.ts'
import { Button, IconButton, Segmented, type SegmentOption } from '../design/primitives.tsx'
import { Icon } from '../design/icons.tsx'
import { useT } from './locale-context.ts'
import { engineLabelKey, statusDot } from './format.ts'

/** Top bar: identity, breadcrumb, scene switch and utility cluster. */
export function TopBar(): ReactElement {
  const t = useT()
  const scene = useUiStore((state) => state.scene)
  const documentId = useUiStore((state) => state.currentDocumentId)
  const documents = useLibraryStore((state) => state.documents)
  const setScene = useUiStore((state) => state.setScene)
  const marginOpen = useUiStore((state) => state.marginOpen)
  const setMarginOpen = useUiStore((state) => state.setMarginOpen)
  const focusSearch = useUiStore((state) => state.focusSearch)
  const openDialog = useUiStore((state) => state.openDialog)
  const collapsed = useUiStore((state) => state.railCollapsed)
  const setRailCollapsed = useUiStore((state) => state.setRailCollapsed)

  const current = useMemo(() => documents.find((document) => document.id === documentId), [documents, documentId])

  const sceneOptions: Array<SegmentOption<'read' | 'graph'>> = [
    { value: 'read', label: t('scene.read') },
    { value: 'graph', label: t('scene.graph') },
  ]

  return (
    <header className="ln-topbar">
      <button
        type="button"
        className="ln-wordmark"
        title={t('top.rail')}
        onClick={() => setRailCollapsed(!collapsed)}
      >
        <span className="ln-wordmark__mark" aria-hidden="true">
          <Icon name="book" size={17} />
        </span>
        <span className="ln-wordmark__text">{t('app.brand')}</span>
      </button>

      <div className="ln-crumbs">
        <button
          type="button"
          className="ln-crumbs__title"
          onClick={() => {
            setRailCollapsed(false)
            focusSearch()
          }}
        >
          <span className="ln-truncate">{current?.title ?? t('top.crumbs.library')}</span>
          <Icon name="chevronDown" size={14} />
        </button>
      </div>

      <div className="ln-topbar__center">
        <Segmented
          value={scene}
          options={sceneOptions}
          onChange={setScene}
          ariaLabel={t('scene.switch')}
        />
      </div>

      <div className="ln-topbar__utils">
        <IconButton icon="search" label={t('top.search')} onClick={focusSearch} />
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          onClick={() => {
            setRailCollapsed(false)
            openDialog('import')
          }}
        >
          {t('top.import')}
        </Button>
        {scene === 'read' ? (
          <IconButton
            icon={marginOpen ? 'panelRight' : 'columns'}
            label={t('top.margin')}
            pressed={marginOpen}
            onClick={() => setMarginOpen(!marginOpen)}
          />
        ) : (
          <span className="ln-topbar__spacer" aria-hidden="true" />
        )}
        <IconButton icon="settings" label={t('top.settings')} onClick={() => openDialog('settings')} />
      </div>
    </header>
  )
}

/** Bottom status bar: engine, document stats, model and graph facts. */
export function StatusBar(): ReactElement {
  const t = useT()
  const documentId = useUiStore((state) => state.currentDocumentId)
  const documents = useLibraryStore((state) => state.documents)
  const status = useLibraryStore((state) => state.status)
  const current = documents.find((document) => document.id === documentId)
  const engine = current?.parse?.engine ?? null
  const route = status?.ai?.route ?? null

  return (
    <footer className="ln-statusbar">
      <div className="ln-statusbar__left">
        <span className="ln-statusbar__engine">
          <span className="ln-statusdot" data-status={current?.status ?? 'none'} aria-hidden="true" />
          {engine === null ? t('status.engine.none') : t(engineLabelKey(engine) as 'status.engine.standard')}
        </span>
        {current?.parse?.pages !== null && current?.parse?.pages !== undefined ? (
          <span className="ln-tabular">{t('status.pages', { count: current.parse.pages })}</span>
        ) : null}
      </div>
      <div className="ln-statusbar__right">
        <span>{route === null ? t('status.noModel') : t('status.model', { model: route.model })}</span>
        {current?.parse?.hasContentList === true ? <span className="ln-statusbar__hint">页码对齐</span> : null}
      </div>
    </footer>
  )
}

/** Toast stack: transient notices from any store. */
export function ToastHost(): ReactElement {
  const toasts = useUiStore((state) => state.toasts)
  const dismiss = useUiStore((state) => state.dismissToast)
  return (
    <div className="ln-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className="ln-toast"
          data-tone={toast.tone}
          onClick={() => dismiss(toast.id)}
        >
          {toast.text}
        </button>
      ))}
    </div>
  )
}

/** Small helper re-exported for scenes that show a status dot. */
export { statusDot }
