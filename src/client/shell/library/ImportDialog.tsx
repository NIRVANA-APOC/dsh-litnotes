/**
 * Import dialog: one sheet for local files, URLs and the parse settings that
 * apply right after import (DESIGN-V2 §7).
 *
 * The dialog closes immediately on submit; upload/parse progress lives in the
 * rail rows (`ImportController`), never in this sheet. Files dropped anywhere on
 * the desk reach this dialog preloaded through `useUiStore.takeImportFiles()`.
 */

import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ACCEPT_ATTR, SUPPORTED_EXTENSIONS } from '../../../shared/constants.ts'
import type { ParseOptions } from '../../../shared/model.ts'
import { useImportController } from './import-controller.ts'
import { useSettingsStore } from '../../state/settings.ts'
import { useUiStore } from '../../state/ui.ts'
import { Button, Dialog, IconButton } from '../../design/primitives.tsx'
import { useT } from '../locale-context.ts'
import { defaultParseOptions } from './options.ts'
import { rememberParseOptions } from './options.ts'
import { extensionOf } from './format.ts'
import type { ImportFailure } from './import-errors.ts'
import { ParseOptionsForm } from './ParseOptionsForm.tsx'
import { SHELL_LIBRARY_CSS } from './styles.ts'
import { useInjectedStyle } from '../../design/use-style.ts'

/** Format a byte size for the selected-file rows. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'B'}`
}

/** Filter a picker/drop selection down to supported extensions. */
function partitionFiles(files: ReadonlyArray<File>): { supported: File[]; skipped: string[] } {
  const supported: File[] = []
  const skipped: string[] = []
  for (const file of files) {
    if (SUPPORTED_EXTENSIONS.includes(extensionOf(file.name))) supported.push(file)
    else skipped.push(file.name)
  }
  return { supported, skipped }
}

/** The import sheet. */
export function ImportDialog(): ReactElement {
  useInjectedStyle('shell-library', SHELL_LIBRARY_CSS)
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const close = useUiStore((state) => state.closeDialog)
  const openDialog = useUiStore((state) => state.openDialog)
  const takeImportFiles = useUiStore((state) => state.takeImportFiles)
  const preferences = useSettingsStore((state) => state.preferences)
  const patchPreferences = useSettingsStore((state) => state.patch)
  const tokenConfigured = useSettingsStore((state) => state.tokenConfigured)
  const local = useSettingsStore((state) => state.local)
  const importFiles = useImportController((state) => state.importFiles)
  const importUrl = useImportController((state) => state.importUrl)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [url, setUrl] = useState('')
  const [options, setOptions] = useState<ParseOptions>(() => defaultParseOptions(preferences))
  const [busy, setBusy] = useState(false)
  const [urlError, setUrlError] = useState<ImportFailure | { message: string; hint: string | null } | null>(null)

  // Opening the dialog: adopt dropped files and the remembered parse choices.
  useEffect(() => {
    if (dialog !== 'import') return
    const queued = takeImportFiles()
    const picked = queued === null ? { supported: [], skipped: [] } : partitionFiles(queued)
    if (queued !== null) {
      setFiles((previous) => [...previous, ...picked.supported])
      if (picked.skipped.length > 0) setSkipped((previous) => [...previous, ...picked.skipped])
    }
    setOptions(defaultParseOptions(useSettingsStore.getState().preferences))
    setUrlError(null)
    setBusy(false)
    // `takeImportFiles` is stable and the dialog is a singleton; the effect is
    // the open transition only.
  }, [dialog, takeImportFiles])

  useEffect(() => {
    if (dialog === 'import') setOptions(defaultParseOptions(preferences))
    // Keep the draft aligned when preferences finish loading after opening.
  }, [dialog, preferences])

  /** Add files from the picker, filtering unsupported extensions. */
  const addFiles = (incoming: ReadonlyArray<File>): void => {
    const picked = partitionFiles(incoming)
    if (picked.supported.length > 0) setFiles((previous) => [...previous, ...picked.supported])
    if (picked.skipped.length > 0) setSkipped((previous) => [...previous, ...picked.skipped])
  }

  /** Persist the last choices (remembered for the next import/reparse). */
  const remember = (): void => {
    void patchPreferences(rememberParseOptions(options))
  }

  /** Import the selected files (optionally parsing them right away). */
  const submitFiles = (parse: boolean): void => {
    if (files.length === 0 || busy) return
    const parseOptions = parse ? options : null
    remember()
    close()
    void importFiles(files, parseOptions, t)
  }

  /** Validate and import the URL. */
  const submitUrl = async (): Promise<void> => {
    if (busy) return
    const value = url.trim()
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      setUrlError({ message: t('dlg.import.badUrl'), hint: null })
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setUrlError({ message: t('dlg.import.badUrl'), hint: null })
      return
    }
    remember()
    setBusy(true)
    setUrlError(null)
    const failure = await importUrl(parsed.toString(), options, t)
    setBusy(false)
    if (failure === null) {
      close()
      setUrl('')
      return
    }
    setUrlError(failure)
  }

  const firstPicked = files[0]
  const canSubmit = files.length > 0 || url.trim() !== ''

  return (
    <Dialog
      open={dialog === 'import'}
      onClose={close}
      title={t('dlg.import.title')}
      description={t('dlg.import.hint')}
      width={660}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button variant="quiet" onClick={() => submitFiles(false)} disabled={busy || files.length === 0}>
            {t('dlg.import.onlyImport')}
          </Button>
          <Button variant="primary" onClick={() => submitFiles(true)} disabled={busy || files.length === 0}>
            {files.length > 0 ? t('dlg.import.start') : t('dlg.import.urlSubmit')}
          </Button>
        </>
      }
    >
      <div className="ln-import">
        <div className="ln-import__zone">
          <span className="ln-import__zoneTitle">{t('dlg.import.zoneTitle')}</span>
          <p className="ln-import__zoneBody">{t('dlg.import.zoneBody')}</p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="ln-vh"
            aria-label={t('dlg.import.file')}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <Button icon="upload" onClick={() => fileRef.current?.click()} disabled={busy}>
            {t('dlg.import.file')}
          </Button>
        </div>

        {skipped.length > 0 ? (
          <div className="ln-callout ln-callout--warn">
            <span className="ln-callout__text">{t('dlg.import.unsupported', { files: skipped.join('、') })}</span>
          </div>
        ) : null}

        {files.length === 0 ? null : (
          <div>
            <div className="ln-import__filesHead">
              <span>{t('dlg.import.selected', { count: files.length })}</span>
              <Button variant="quiet" size="sm" onClick={() => setFiles([])} disabled={busy}>
                {t('dlg.import.removeAll')}
              </Button>
            </div>
            <ul className="ln-import__files">
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="ln-import__file">
                  <span className="ln-import__fileName">{file.name}</span>
                  <span className="ln-import__fileSize ln-tabular">{formatBytes(file.size)}</span>
                  <IconButton
                    icon="close"
                    label={t('dlg.import.remove')}
                    size={12}
                    onClick={() => setFiles((previous) => previous.filter((_, position) => position !== index))}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ln-import__separator" aria-hidden="true">
          <span>{t('dlg.import.url')}</span>
        </div>

        <div>
          <div className="ln-import__urlRow">
            <input
              type="url"
              className="ln-input"
              value={url}
              placeholder={t('dlg.import.urlPlaceholder')}
              aria-label={t('dlg.import.url')}
              disabled={busy}
              onChange={(event) => {
                setUrl(event.target.value)
                setUrlError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submitUrl()
                }
              }}
            />
            <Button
              variant="default"
              icon="link"
              onClick={() => void submitUrl()}
              disabled={busy || url.trim() === ''}
            >
              {busy ? t('dlg.import.starting') : t('dlg.import.urlSubmit')}
            </Button>
          </div>
          <p className="ln-field__hint">{t('dlg.import.urlHint')}</p>
          {urlError !== null ? (
            <div className="ln-callout ln-callout--error">
              <span className="ln-callout__text">
                {t('err.importUrlFailed', { message: urlError.message })}
                {urlError.hint === null ? null : ` ${urlError.hint}`}
              </span>
            </div>
          ) : null}
        </div>

        <div>
          <div className="ln-import__sectionHead">
            <h3 className="ln-import__sectionTitle">{t('dlg.import.parseSection')}</h3>
            <span className="ln-import__sectionHint">{t('dlg.import.parseHint')}</span>
          </div>
          <ParseOptionsForm
            value={options}
            onChange={setOptions}
            tokenConfigured={tokenConfigured}
            local={local}
            ext={firstPicked === undefined ? '' : extensionOf(firstPicked.name)}
            onOpenSettings={() => {
              close()
              openDialog('settings')
            }}
          />
        </div>

        {files.length === 0 ? (
          <p className="ln-field__hint">{canSubmit ? t('dlg.import.readyToParse') : t('dlg.import.empty')}</p>
        ) : null}
      </div>
    </Dialog>
  )
}
