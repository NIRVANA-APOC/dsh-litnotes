/**
 * One library row: title, meta line, in-row parse progress and the per-document
 * action menu (DESIGN-V2 §7). Progress is always rendered *in the row*, never in
 * a dialog; failures get a warn badge plus a retry action.
 */

import type { ReactElement } from 'react'
import { ProgressBar, Badge, IconButton, Menu, type MenuItem } from '../../design/primitives.tsx'
import { Icon } from '../../design/icons.tsx'
import type { DocumentSummary } from '../../../shared/model.ts'
import { useT } from '../locale-context.ts'
import { canRepair, repairPages } from './parse-request.ts'
import { documentMetaParts, parseProgressText } from './format.ts'

/** Props of {@link DocumentRow}. */
export interface DocumentRowProps {
  document: DocumentSummary
  active: boolean
  onOpen: () => void
  onOpenDialog: (dialog: 'reparse' | 'rename' | 'delete', id: string) => void
  onRetry: () => void
  onRepair: () => void
  onCancel: () => void
}

/** Render one rail row. */
export function DocumentRow({
  document,
  active,
  onOpen,
  onOpenDialog,
  onRetry,
  onRepair,
  onCancel,
}: DocumentRowProps): ReactElement {
  const t = useT()
  const parsing = document.status === 'parsing'
  const failed = document.status === 'failed'
  const uploaded = document.status === 'uploaded'
  const repairable = canRepair(document)
  const pages = canRepair(document) ? repairPages(document).length : 0
  const progress = document.parse?.progress ?? null

  const items: MenuItem[] = []
  items.push({ type: 'item', id: 'open', label: t('rail.open'), icon: 'book', onSelect: onOpen })
  if (uploaded) {
    items.push({
      type: 'item',
      id: 'parse',
      label: t('rail.startParse'),
      icon: 'sparkle',
      onSelect: () => onOpenDialog('reparse', document.id),
    })
  } else if (failed) {
    items.push({ type: 'item', id: 'retry', label: t('rail.retryParse'), icon: 'refresh', onSelect: onRetry })
    items.push({
      type: 'item',
      id: 'settings',
      label: t('dlg.reparse.title'),
      icon: 'settings',
      onSelect: () => onOpenDialog('reparse', document.id),
    })
  } else {
    items.push({
      type: 'item',
      id: 'reparse',
      label: t('rail.reparse'),
      icon: 'refresh',
      disabled: parsing,
      onSelect: () => onOpenDialog('reparse', document.id),
    })
  }
  if (repairable) {
    items.push({
      type: 'item',
      id: 'repair',
      label: t('rail.repairParse', { count: pages }),
      icon: 'layers',
      onSelect: onRepair,
    })
  }
  items.push({ type: 'separator', id: 'sep-actions' })
  items.push({
    type: 'item',
    id: 'rename',
    label: t('rail.rename'),
    icon: 'edit',
    onSelect: () => onOpenDialog('rename', document.id),
  })
  items.push({ type: 'separator', id: 'sep-danger' })
  items.push({
    type: 'item',
    id: 'delete',
    label: t('rail.delete'),
    icon: 'trash',
    danger: true,
    onSelect: () => onOpenDialog('delete', document.id),
  })

  const meta = documentMetaParts(document, t)

  return (
    <div className="ln-doc" data-status={document.status} data-active={active || undefined}>
      <button
        type="button"
        className="ln-doc__open"
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
      >
        <span className="ln-doc__status" data-status={document.status} aria-hidden="true" />
        <span className="ln-doc__body">
          <span className="ln-doc__title">{document.title}</span>
          <span className="ln-doc__meta">
            {meta.map((part, index) => (
              <span key={`${part}-${index}`} className="ln-doc__metaText">
                {index === 0 ? null : <span className="ln-doc__metaSep"> · </span>}
                {part}
              </span>
            ))}
            {failed ? (
              <span className="ln-doc__badge">
                <Badge tone="warn">{t('rail.status.failed')}</Badge>
              </span>
            ) : uploaded ? (
              <span className="ln-doc__badge">
                <Badge tone="neutral">{t('rail.status.uploaded')}</Badge>
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <div className="ln-doc__trail">
        {parsing ? (
          <button
            type="button"
            className="ln-doc__cancel"
            title={t('rail.cancelParse')}
            aria-label={t('rail.cancelParse')}
            onClick={onCancel}
          >
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <Menu
            ariaLabel={t('rail.moreActions')}
            items={items}
            button={(props) => <IconButton icon="more" label={t('rail.moreActions')} size={15} {...props} />}
          />
        )}
      </div>
      {parsing ? (
        <div className="ln-doc__progressRow" aria-live="polite">
          <span className="ln-doc__progressText">{parseProgressText(document, t)}</span>
          <span className="ln-doc__progressBar">
            <ProgressBar
              label={parseProgressText(document, t)}
              value={progress?.extracted}
              total={progress?.total}
              indeterminate={progress === null || progress.total <= 0}
            />
          </span>
        </div>
      ) : null}
    </div>
  )
}
