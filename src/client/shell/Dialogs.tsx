/**
 * Shell dialogs: import, settings, reparse and the small document dialogs
 * (rename, delete).
 *
 * Each dialog owns only a local draft and calls one store action, so the same
 * operation stays available to the agent tools through the Host service. The
 * heavy sheets live in `./library/**`; this module is the mount point
 * (`App.tsx` renders `<ShellDialogs/>` once).
 */

import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { useLibraryStore } from '../state/library.ts'
import { useUiStore } from '../state/ui.ts'
import { Button, Dialog, TextInput } from '../design/primitives.tsx'
import { useT } from './locale-context.ts'
import { useInjectedStyle } from '../design/use-style.ts'
import { ImportDialog } from './library/ImportDialog.tsx'
import { ReparseDialog } from './library/ReparseDialog.tsx'
import { SettingsDialog } from './library/SettingsDialog.tsx'
import { SHELL_LIBRARY_CSS } from './library/styles.ts'

/** Rename dialog for one document. */
function RenameDialog(): ReactElement {
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const target = useUiStore((state) => state.dialogTarget)
  const close = useUiStore((state) => state.closeDialog)
  const documents = useLibraryStore((state) => state.documents)
  const rename = useLibraryStore((state) => state.rename)
  const document = documents.find((entry) => entry.id === target)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (dialog === 'rename') {
      setTitle(document?.title ?? '')
      setBusy(false)
    }
  }, [dialog, document?.title])

  return (
    <Dialog
      open={dialog === 'rename'}
      onClose={close}
      title={t('dlg.rename.title')}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || title.trim() === '' || target === null}
            onClick={() => {
              if (target === null) return
              setBusy(true)
              void rename(target, title.trim()).finally(() => {
                setBusy(false)
                close()
              })
            }}
          >
            {t('action.save')}
          </Button>
        </>
      }
    >
      <div className="ln-field">
        <label className="ln-field__label" htmlFor="ln-rename-title">
          {t('dlg.rename.label')}
        </label>
        <div className="ln-field__control">
          <TextInput
            id="ln-rename-title"
            value={title}
            placeholder={t('dlg.rename.placeholder')}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (title.trim() === '' || target === null) return
              setBusy(true)
              void rename(target, title.trim()).finally(() => {
                setBusy(false)
                close()
              })
            }}
            autoFocus
          />
        </div>
      </div>
    </Dialog>
  )
}

/** Delete confirmation. */
function DeleteDialog(): ReactElement {
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const target = useUiStore((state) => state.dialogTarget)
  const close = useUiStore((state) => state.closeDialog)
  const documents = useLibraryStore((state) => state.documents)
  const remove = useLibraryStore((state) => state.remove)
  const document = documents.find((entry) => entry.id === target)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog
      open={dialog === 'delete'}
      onClose={close}
      title={t('dlg.delete.title')}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={busy || target === null}
            onClick={() => {
              if (target === null) return
              setBusy(true)
              void remove(target).finally(() => {
                setBusy(false)
                close()
              })
            }}
          >
            {t('dlg.delete.confirm')}
          </Button>
        </>
      }
    >
      <p className="ln-dialog__paragraph">{t('dlg.delete.body')}</p>
      {document === undefined ? null : (
        <p className="ln-dialog__paragraph ln-dialog__paragraph--strong">{document.title}</p>
      )}
    </Dialog>
  )
}

/** Mount every shell dialog (only one is open at a time). */
export function ShellDialogs(): ReactElement {
  useInjectedStyle('shell-library', SHELL_LIBRARY_CSS)
  return (
    <>
      <ImportDialog />
      <SettingsDialog />
      <RenameDialog />
      <DeleteDialog />
      <ReparseDialog />
    </>
  )
}
