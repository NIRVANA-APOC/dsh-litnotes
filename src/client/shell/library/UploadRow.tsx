/**
 * One in-flight (or failed) upload row in the rail.
 *
 * Upload progress is part of "progress lives in the row, not the dialog"
 * (DESIGN-V2 §7): files being uploaded appear here until the library refresh
 * replaces them with the real document row.
 */

import type { ReactElement } from 'react'
import { Button, IconButton, ProgressBar } from '../../design/primitives.tsx'
import { useT } from '../locale-context.ts'
import type { UploadItem } from './import-controller.ts'

/** Props of {@link UploadRow}. */
export interface UploadRowProps {
  upload: UploadItem
  onRetry: () => void
  onDismiss: () => void
}

/** Render one upload row. */
export function UploadRow({ upload, onRetry, onDismiss }: UploadRowProps): ReactElement {
  const t = useT()
  const percent = Math.round(Math.max(0, Math.min(1, upload.progress)) * 100)
  const failed = upload.state === 'failed'
  return (
    <div className="ln-upload" data-status={failed ? 'failed' : 'uploading'}>
      <div className="ln-upload__head">
        <span className="ln-upload__name" title={upload.name}>
          {upload.name}
        </span>
        <span className="ln-upload__state" data-failed={failed || undefined}>
          {failed ? t('rail.uploadFailed') : t('rail.uploading', { percent })}
        </span>
        <span className="ln-upload__actions">
          {failed ? (
            <>
              <Button variant="quiet" size="sm" onClick={onRetry}>
                {t('rail.uploadRetry')}
              </Button>
              <IconButton icon="close" label={t('rail.uploadDismiss')} size={12} onClick={onDismiss} />
            </>
          ) : null}
        </span>
      </div>
      <ProgressBar
        label={failed ? t('rail.uploadFailed') : t('rail.uploading', { percent })}
        value={failed ? undefined : upload.progress * 100}
        total={100}
        indeterminate={!failed && upload.progress <= 0}
      />
      {upload.guide === null ? null : <p className="ln-upload__guide">{upload.guide}</p>}
    </div>
  )
}
