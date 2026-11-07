/**
 * The library rail: the persistent document list.
 *
 * The rail is the library (there is no separate "library page"): search,
 * statuses, in-row parse progress and per-document actions live here, in every
 * scene. Collapsed, it keeps the same vertical position but shrinks to a
 * 44px strip so the paper can use the width.
 */

import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useLibraryStore } from '../state/library.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { IconButton, Menu, ProgressBar, Spinner, type MenuItem } from '../design/primitives.tsx'
import { Icon } from '../design/icons.tsx'
import { useT } from './locale-context.ts'
import { engineLabelKey, formatNumber, statusDot, statusLabelKey } from './format.ts'
import type { DocumentSummary } from '../../shared/model.ts'

/** One document row. */
function DocumentRow({
  document,
  active,
  onOpen,
}: {
  document: DocumentSummary
  active: boolean
  onOpen: () => void
}): ReactElement {
  const t = useT()
  const openDialog = useUiStore((state) => state.openDialog)
  const cancelParse = useLibraryStore((state) => state.cancelParse)
  const progress = document.parse?.progress ?? null
  const parsing = document.status === 'parsing'

  const items: MenuItem[] = [
    { id: 'open', label: t('rail.open'), icon: 'book', onSelect: onOpen },
    {
      id: 'reparse',
      label: t('rail.reparse'),
      icon: 'refresh',
      disabled: parsing,
      onSelect: () => openDialog('reparse', document.id),
    },
    { id: 'rename', label: t('rail.rename'), icon: 'edit', onSelect: () => openDialog('rename', document.id) },
    { type: 'separator', id: 'sep' },
    {
      id: 'delete',
      label: t('rail.delete'),
      icon: 'trash',
      danger: true,
      onSelect: () => openDialog('delete', document.id),
    },
  ]

  return (
    <div className="ln-doc" data-status={document.status} data-active={active || undefined}>
      <button type="button" className="ln-doc__open" onClick={onOpen}>
        <span className="ln-doc__status" data-status={statusDot(document.status)} aria-hidden="true" />
        <span className="ln-doc__body">
          <span className="ln-doc__title">{document.title}</span>
          <span className="ln-doc__meta">
            <span>{document.ext.replace('.', '').toUpperCase()}</span>
            {document.parse?.pages !== null && document.parse?.pages !== undefined ? (
              <span className="ln-tabular">{document.parse.pages} 页</span>
            ) : null}
            <span>{t(statusLabelKey(document.status) as 'rail.status.parsed')}</span>
            {document.parse?.engine !== null && document.parse?.engine !== undefined ? (
              <span className="ln-doc__engine">{t(engineLabelKey(document.parse.engine) as 'status.engine.local')}</span>
            ) : null}
          </span>
        </span>
      </button>
      <div className="ln-doc__trail">
        {parsing ? (
          <button
            type="button"
            className="ln-doc__cancel"
            title={t('action.cancel')}
            aria-label={t('action.cancel')}
            onClick={() => void cancelParse(document.id)}
          >
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <Menu
            ariaLabel={t('action.more')}
            items={items}
            button={(props) => <IconButton icon="more" label={t('action.more')} size={15} {...props} />}
          />
        )}
      </div>
      {parsing ? (
        <div className="ln-doc__progress">
          <ProgressBar
            label={t('rail.status.parsing')}
            value={progress?.extracted}
            total={progress?.total}
            indeterminate={progress === null}
          />
        </div>
      ) : null}
    </div>
  )
}

/** The rail column. */
export function Rail(): ReactElement {
  const t = useT()
  const documents = useLibraryStore((state) => state.documents)
  const loading = useLibraryStore((state) => state.loading)
  const loaded = useLibraryStore((state) => state.loaded)
  const searchQuery = useUiStore((state) => state.searchQuery)
  const setSearchQuery = useUiStore((state) => state.setSearchQuery)
  const searchTick = useUiStore((state) => state.searchFocusTick)
  const currentDocumentId = useUiStore((state) => state.currentDocumentId)
  const openDocument = useUiStore((state) => state.openDocument)
  const setScene = useUiStore((state) => state.setScene)
  const collapsed = useUiStore((state) => state.railCollapsed)
  const setCollapsed = useUiStore((state) => state.setRailCollapsed)
  const openDialog = useUiStore((state) => state.openDialog)
  const prefs = useSettingsStore((state) => state.preferences)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (searchTick > 0) inputRef.current?.focus()
  }, [searchTick])

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (query === '') return documents
    return documents.filter((document) => {
      const title = document.title.toLowerCase()
      return title.includes(query) || document.originalName.toLowerCase().includes(query)
    })
  }, [documents, searchQuery])

  const parsedCount = documents.filter((document) => document.status === 'parsed').length

  if (collapsed) {
    return (
      <aside className="ln-rail ln-rail--collapsed" aria-label={t('rail.title')}>
        <IconButton icon="chevronRight" label={t('rail.expand')} onClick={() => setCollapsed(false)} />
        <IconButton icon="book" label={t('rail.title')} onClick={() => setScene('read')} />
        <span className="ln-rail__count ln-tabular">{documents.length}</span>
        <div className="ln-rail__spacer" />
        <IconButton icon="plus" label={t('rail.import')} onClick={() => openDialog('import')} />
      </aside>
    )
  }

  return (
    <aside className="ln-rail" aria-label={t('rail.title')}>
      <header className="ln-rail__head">
        <span className="ln-rail__title">{t('rail.title')}</span>
        <span className="ln-rail__count ln-tabular">{formatNumber(documents.length)}</span>
        <IconButton icon="chevronLeft" label={t('rail.collapse')} size={16} onClick={() => setCollapsed(true)} />
      </header>
      <div className="ln-rail__search">
        <Icon name="search" size={15} className="ln-rail__searchIcon" />
        <input
          ref={inputRef}
          className="ln-input ln-input--search"
          value={searchQuery}
          placeholder={t('rail.search')}
          aria-label={t('rail.search')}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {searchQuery === '' ? null : (
          <IconButton icon="close" label={t('action.cancel')} size={14} onClick={() => setSearchQuery('')} />
        )}
      </div>
      <div className="ln-rail__list ln-scroll">
        {loading && !loaded ? (
          <div className="ln-rail__loading">
            <Spinner />
          </div>
        ) : filtered.length === 0 ? (
          <div className="ln-rail__empty">
            <p className="ln-rail__emptyTitle">{searchQuery === '' ? t('rail.empty') : t('rail.more')}</p>
            {searchQuery === '' ? <p className="ln-rail__emptyBody">{t('rail.emptyBody')}</p> : null}
            {searchQuery === '' ? (
              <button type="button" className="ln-btn ln-btn--sm" onClick={() => openDialog('import')}>
                {t('rail.import')}
              </button>
            ) : null}
          </div>
        ) : (
          filtered.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              active={document.id === currentDocumentId}
              onOpen={() => {
                openDocument(document.id)
                setScene('read')
              }}
            />
          ))
        )}
      </div>
      <footer className="ln-rail__foot">
        <span className="ln-tabular">
          {t('rail.count', { total: formatNumber(documents.length), parsed: formatNumber(parsedCount) })}
        </span>
        <span className="ln-rail__width">{prefs.readingMeasure}ch</span>
      </footer>
    </aside>
  )
}
