/**
 * The library rail: the persistent document list.
 *
 * The rail *is* the library (there is no separate library page): instant search
 * (MiniSearch), status filters, sorting, in-row parse progress, upload rows and
 * per-document actions live here, in every scene. Below 820px it becomes an
 * overlay drawer with a scrim; the topbar wordmark (which toggles
 * `railCollapsed`) opens and closes it, Escape closes it too.
 */

import type { KeyboardEvent, ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentSummary, ParseOptions } from '../../shared/model.ts'
import { useLibraryStore } from '../state/library.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { useImportController } from './library/import-controller.ts'
import { Button, Chip, EmptyState, IconButton, Menu, Spinner, cx, useMediaQuery, type MenuItem } from '../design/primitives.tsx'
import { Icon } from '../design/icons.tsx'
import { useT } from './locale-context.ts'
import { useInjectedStyle } from '../design/use-style.ts'
import { DocumentRow } from './library/DocumentRow.tsx'
import { UploadRow } from './library/UploadRow.tsx'
import {
  buildLibrarySearchIndex,
  sortDocuments,
  statusCounts,
  type LibrarySort,
  type RailStatusFilter,
} from './library/search.ts'
import { defaultParseOptions } from './library/options.ts'
import { lastParseOptions, repairPages, repairRequest, retryRequest } from './library/parse-request.ts'
import { formatNumber } from './library/format.ts'
import { SHELL_LIBRARY_CSS } from './library/styles.ts'

/** Status filter chips, in fixed order. */
const FILTERS: ReadonlyArray<{
  value: RailStatusFilter
  key: 'rail.filter.all' | 'rail.filter.parsed' | 'rail.filter.parsing' | 'rail.filter.uploaded' | 'rail.filter.failed'
}> = [
  { value: 'all', key: 'rail.filter.all' },
  { value: 'parsed', key: 'rail.filter.parsed' },
  { value: 'parsing', key: 'rail.filter.parsing' },
  { value: 'uploaded', key: 'rail.filter.uploaded' },
  { value: 'failed', key: 'rail.filter.failed' },
]

/** The rail column. */
export function Rail(): ReactElement {
  useInjectedStyle('shell-library', SHELL_LIBRARY_CSS)
  const t = useT()
  const documents = useLibraryStore((state) => state.documents)
  const loaded = useLibraryStore((state) => state.loaded)
  const loading = useLibraryStore((state) => state.loading)
  const error = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)
  const startParse = useLibraryStore((state) => state.startParse)
  const cancelParse = useLibraryStore((state) => state.cancelParse)
  const searchQuery = useUiStore((state) => state.searchQuery)
  const setSearchQuery = useUiStore((state) => state.setSearchQuery)
  const searchFocusTick = useUiStore((state) => state.searchFocusTick)
  const focusSearch = useUiStore((state) => state.focusSearch)
  const currentDocumentId = useUiStore((state) => state.currentDocumentId)
  const openDocument = useUiStore((state) => state.openDocument)
  const setScene = useUiStore((state) => state.setScene)
  const collapsed = useUiStore((state) => state.railCollapsed)
  const setCollapsed = useUiStore((state) => state.setRailCollapsed)
  const openDialog = useUiStore((state) => state.openDialog)
  const preferences = useSettingsStore((state) => state.preferences)
  const uploads = useImportController((state) => state.uploads)
  const retryUpload = useImportController((state) => state.retryUpload)
  const dismissUpload = useImportController((state) => state.dismissUpload)
  const drawer = useMediaQuery('(max-width: 820px)')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const drawerDefaultApplied = useRef(false)
  const [filter, setFilter] = useState<RailStatusFilter>('all')
  const [sort, setSort] = useState<LibrarySort>('updated')

  // Focus the search field when the topbar hotkey / wordmark asks for it.
  useEffect(() => {
    if (searchFocusTick > 0) inputRef.current?.focus()
  }, [searchFocusTick])

  // Below 820px the rail starts closed (it is a drawer, not a column).
  useEffect(() => {
    if (!drawer || drawerDefaultApplied.current) return
    drawerDefaultApplied.current = true
    if (!useUiStore.getState().railCollapsed) useUiStore.getState().setRailCollapsed(true)
  }, [drawer])

  // Opening the drawer focuses the search field, ready for a query.
  useEffect(() => {
    if (!drawer || collapsed) return
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [drawer, collapsed])

  // Escape closes the drawer (unless it is dismissing a dialog first).
  useEffect(() => {
    if (!drawer || collapsed) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('dialog[open]') !== null) return
      setCollapsed(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawer, collapsed, setCollapsed])

  // Instant search: rebuilt only when the list or the query changes.
  const searchIndex = useMemo(() => buildLibrarySearchIndex(documents), [documents])
  const matched = useMemo(
    () => (searchQuery.trim() === '' ? null : searchIndex.search(searchQuery)),
    [searchIndex, searchQuery],
  )
  const counts = useMemo(() => statusCounts(documents), [documents])
  const sorted = useMemo(() => sortDocuments(documents, sort), [documents, sort])
  const visible = useMemo(() => {
    const byStatus = filter === 'all' ? sorted : sorted.filter((document) => document.status === filter)
    return matched === null ? byStatus : byStatus.filter((document) => matched.has(document.id))
  }, [sorted, filter, matched])

  // Keep the active row in view when the open document changes.
  useEffect(() => {
    if (currentDocumentId === null) return
    const list = listRef.current
    if (list === null) return
    const row = list.querySelector<HTMLElement>('.ln-doc[data-active]')
    if (row === null) return
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [currentDocumentId, visible])

  /** Open a document (drawer closes itself on narrow screens). */
  const openDoc = (id: string): void => {
    openDocument(id)
    setScene('read')
    if (drawer) setCollapsed(true)
  }

  /** Retry a failed parse with the document's last options (no modal). */
  const retryDocument = (document: DocumentSummary): void => {
    const base: ParseOptions = lastParseOptions(document) ?? defaultParseOptions(preferences)
    void startParse(document.id, retryRequest(document, base))
  }

  /** Repair the pages the last parse reported as unreadable (no modal). */
  const repairDocument = (document: DocumentSummary): void => {
    const pages = repairPages(document)
    if (pages.length === 0) return
    const base: ParseOptions = lastParseOptions(document) ?? defaultParseOptions(preferences)
    void startParse(document.id, repairRequest(base, pages))
  }

  /** Clear search and status filter (empty-state action). */
  const clearFilters = (): void => {
    setSearchQuery('')
    setFilter('all')
  }

  /** Arrow-key navigation between document rows (DESIGN-V2 §10). */
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const handled = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!handled.includes(event.key)) return
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.ln-doc__open') ?? [])
    if (buttons.length === 0) return
    const current = buttons.findIndex((button) => button === document.activeElement)
    let next = 0
    if (event.key === 'End') next = buttons.length - 1
    else if (event.key === 'ArrowUp') next = current <= 0 ? 0 : current - 1
    else if (event.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(buttons.length - 1, current + 1)
    event.preventDefault()
    buttons[next]?.focus()
  }

  const sortItems: MenuItem[] = [
    { type: 'item', id: 'updated', label: t('rail.sort.updated'), checked: sort === 'updated', onSelect: () => setSort('updated') },
    { type: 'item', id: 'created', label: t('rail.sort.created'), checked: sort === 'created', onSelect: () => setSort('created') },
    { type: 'item', id: 'title', label: t('rail.sort.title'), checked: sort === 'title', onSelect: () => setSort('title') },
  ]

  /** One document row. */
  const renderRow = (document: DocumentSummary): ReactElement => (
    <DocumentRow
      key={document.id}
      document={document}
      active={document.id === currentDocumentId}
      onOpen={() => openDoc(document.id)}
      onOpenDialog={(kind, id) => openDialog(kind, id)}
      onRetry={() => retryDocument(document)}
      onRepair={() => repairDocument(document)}
      onCancel={() => void cancelParse(document.id)}
    />
  )

  /** The list content: loading skeleton, error, empty invitations or rows. */
  const listContent = ((): ReactElement => {
    if (!loaded && loading) {
      return (
        <div aria-busy="true" aria-label={t('action.loading')}>
          <div className="ln-rail__skeleton" />
          <div className="ln-rail__skeleton" />
          <div className="ln-rail__skeleton" />
        </div>
      )
    }
    if (error !== null && documents.length === 0) {
      return (
        <div className="ln-rail__notice ln-rail__notice--error" role="alert">
          <p className="ln-rail__noticeTitle">{t('err.load')}</p>
          <span>{t('rail.error', { message: error })}</span>
          <Button size="sm" icon="refresh" onClick={() => void refresh()}>
            {t('rail.retry')}
          </Button>
        </div>
      )
    }
    if (documents.length === 0 && uploads.length === 0) {
      return (
        <EmptyState
          compact
          icon="book"
          title={t('rail.empty')}
          body={t('rail.emptyBody')}
          actions={
            <Button size="sm" variant="primary" icon="plus" onClick={() => openDialog('import')}>
              {t('rail.import')}
            </Button>
          }
        />
      )
    }
    if (visible.length === 0 && uploads.length === 0) {
      return (
        <div className="ln-rail__notice">
          <p className="ln-rail__noticeTitle">{t('rail.searchEmpty')}</p>
          <span>{t('rail.searchEmptyBody')}</span>
          <Button size="sm" variant="quiet" icon="close" onClick={clearFilters}>
            {t('rail.clear')}
          </Button>
        </div>
      )
    }
    return (
      <>
        {visible.map(renderRow)}
        {uploads.map((upload) => (
          <UploadRow
            key={upload.key}
            upload={upload}
            onRetry={() => void retryUpload(upload.key, t)}
            onDismiss={() => dismissUpload(upload.key)}
          />
        ))}
      </>
    )
  })()

  if (collapsed) {
    return (
      <aside className="ln-rail ln-rail--collapsed" aria-label={t('rail.title')}>
        <div className="ln-rail__strip">
          <IconButton icon="chevronRight" label={t('rail.expand')} onClick={() => setCollapsed(false)} />
          <IconButton
            icon="search"
            label={t('rail.search')}
            onClick={() => {
              setCollapsed(false)
              focusSearch()
            }}
          />
          <span className="ln-rail__stripCount ln-tabular">{documents.length}</span>
          <div className="ln-rail__spacer" />
          <IconButton icon="plus" label={t('rail.import')} onClick={() => openDialog('import')} />
        </div>
      </aside>
    )
  }

  return (
    <>
      {drawer ? (
        <button
          type="button"
          className="ln-rail__scrim"
          aria-label={t('rail.close')}
          onClick={() => setCollapsed(true)}
        />
      ) : null}
      <aside className={cx('ln-rail')} data-drawer={drawer || undefined} aria-label={t(drawer ? 'rail.drawer' : 'rail.title')}>
        <header className="ln-rail__head">
          <span className="ln-rail__title">{t('rail.title')}</span>
          <span className="ln-rail__count ln-tabular">{formatNumber(documents.length)}</span>
          <IconButton
            icon={drawer ? 'close' : 'chevronLeft'}
            label={drawer ? t('rail.close') : t('rail.collapse')}
            size={16}
            onClick={() => setCollapsed(true)}
          />
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
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setSearchQuery('')
                return
              }
              if (event.key === 'ArrowDown') {
                const first = listRef.current?.querySelector<HTMLButtonElement>('.ln-doc__open')
                if (first !== null && first !== undefined) {
                  event.preventDefault()
                  first.focus()
                }
              }
            }}
          />
          {searchQuery === '' ? null : (
            <IconButton icon="close" label={t('rail.clearSearch')} size={14} onClick={() => setSearchQuery('')} />
          )}
        </div>
        <div className="ln-rail__toolbar">
          <div className="ln-rail__filters" role="group" aria-label={t('rail.filter')}>
            {FILTERS.map((entry) => (
              <Chip
                key={entry.value}
                pressed={filter === entry.value}
                count={counts[entry.value]}
                onClick={() => setFilter(filter === entry.value && entry.value !== 'all' ? 'all' : entry.value)}
              >
                {t(entry.key)}
              </Chip>
            ))}
          </div>
          <Menu
            ariaLabel={t('rail.sort')}
            items={sortItems}
            button={(props) => <IconButton icon="sort" label={t('rail.sort')} size={14} {...props} />}
          />
        </div>
        <div
          ref={listRef}
          className="ln-rail__list ln-scroll"
          role="list"
          aria-label={t('rail.title')}
          onKeyDown={onListKeyDown}
        >
          {listContent}
        </div>
        <footer className="ln-rail__foot">
          <span className="ln-tabular">
            {t('rail.foot', { total: formatNumber(documents.length), parsed: formatNumber(counts.parsed) })}
          </span>
          {drawer ? null : (
            <span className="ln-rail__width">{preferences.readingMeasure}ch</span>
          )}
        </footer>
      </aside>
    </>
  )
}

/** Small helper re-exported for the dialogs: default options for a fresh parse. */
export { defaultParseOptions }
