/**
 * Reparse dialog: engine + options for a fresh parse, and the page-repair mode
 * for documents whose last parse reported unreadable pages.
 *
 * Also reached from the rail row menu ("开始解析"/"重新解析"/"按页修复"), so the
 * same options form and the same parse-start path serve every entry point.
 */

import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { ParseOptions } from '../../../shared/model.ts'
import { useLibraryStore } from '../../state/library.ts'
import { useSettingsStore } from '../../state/settings.ts'
import { useUiStore } from '../../state/ui.ts'
import { Button, Dialog, ProgressBar } from '../../design/primitives.tsx'
import { useT } from '../locale-context.ts'
import { defaultParseOptions, rememberParseOptions } from './options.ts'
import { canRepair, repairPages, repairRequest } from './parse-request.ts'
import { assembleEngineLabel, parseProgressText } from './format.ts'
import { ParseOptionsForm } from './ParseOptionsForm.tsx'
import { SHELL_LIBRARY_CSS } from './styles.ts'
import { useInjectedStyle } from '../../design/use-style.ts'

/** Merge the document's last options over the preference defaults. */
function initialOptions(last: ParseOptions | null | undefined, preferences: Parameters<typeof defaultParseOptions>[0]): ParseOptions {
  const base = defaultParseOptions(preferences)
  if (last === null || last === undefined) return base
  const merged: ParseOptions = { ...base }
  if (last.engine !== undefined) merged.engine = last.engine
  if (last.localProvider !== undefined) merged.localProvider = last.localProvider
  if (last.modelVersion !== undefined) merged.modelVersion = last.modelVersion
  if (last.language !== undefined) merged.language = last.language
  if (typeof last.isOcr === 'boolean') merged.isOcr = last.isOcr
  if (typeof last.enableFormula === 'boolean') merged.enableFormula = last.enableFormula
  if (typeof last.enableTable === 'boolean') merged.enableTable = last.enableTable
  if (last.pageRanges !== undefined) merged.pageRanges = last.pageRanges
  return merged
}

/** The reparse sheet. */
export function ReparseDialog(): ReactElement {
  useInjectedStyle('shell-library', SHELL_LIBRARY_CSS)
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const target = useUiStore((state) => state.dialogTarget)
  const currentDocumentId = useUiStore((state) => state.currentDocumentId)
  const close = useUiStore((state) => state.closeDialog)
  const openSettings = useUiStore((state) => state.openDialog)
  const documents = useLibraryStore((state) => state.documents)
  const startParse = useLibraryStore((state) => state.startParse)
  const cancelParse = useLibraryStore((state) => state.cancelParse)
  const preferences = useSettingsStore((state) => state.preferences)
  const patchPreferences = useSettingsStore((state) => state.patch)
  const tokenConfigured = useSettingsStore((state) => state.tokenConfigured)
  const local = useSettingsStore((state) => state.local)
  const documentId = target ?? currentDocumentId
  const document = documents.find((entry) => entry.id === documentId)
  const [options, setOptions] = useState<ParseOptions>(() => defaultParseOptions(preferences))
  const [repairOnly, setRepairOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const open = dialog === 'reparse' && document !== undefined

  // Reset the draft every time the dialog opens for a (possibly different) doc.
  useEffect(() => {
    if (!open || document === undefined) return
    setOptions(initialOptions(document.parse?.options, useSettingsStore.getState().preferences))
    setRepairOnly(document.status === 'parsed' && canRepair(document))
    setBusy(false)
  }, [open, document])

  const pages = useMemo(() => (document === undefined ? [] : repairPages(document)), [document])
  const repairAvailable = document !== undefined && canRepair(document)
  const parsing = document?.status === 'parsing'
  const lastOptions = document?.parse?.options ?? null

  /** Start the selected parse (fresh or page repair) and close on dispatch. */
  const submit = async (): Promise<void> => {
    if (busy || document === undefined || parsing) return
    setBusy(true)
    try {
      if (repairOnly && repairAvailable) {
        await startParse(document.id, repairRequest(options, pages))
      } else {
        await startParse(document.id, options)
      }
      void patchPreferences(rememberParseOptions(options))
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={document?.status === 'parsed' ? t('dlg.reparse.titleAgain') : t('dlg.reparse.title')}
      description={document?.status === 'uploaded' ? t('empty.noParse.body') : t('dlg.reparse.description')}
      width={660}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          {parsing ? (
            <Button
              variant="default"
              onClick={() => {
                if (document !== undefined) void cancelParse(document.id)
              }}
            >
              {t('rail.cancelParse')}
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => void submit()} disabled={busy || parsing}>
            {busy ? t('dlg.reparse.starting') : t('dlg.reparse.start')}
          </Button>
        </>
      }
    >
      {document === undefined ? null : (
        <div className="ln-parseform">
          {parsing ? (
            <div className="ln-callout ln-callout--info">
              <span className="ln-callout__text">{t('dlg.reparse.parseRunning')}</span>
              <ProgressBar label={t('rail.progress.polling')} indeterminate />
            </div>
          ) : null}

          {repairAvailable ? (
            <div className="ln-field">
              <span className="ln-field__label">{t('rail.repairParse', { count: pages.length })}</span>
              <div className="ln-field__control">
                <label className="ln-parseform__switch">
                  <input
                    type="checkbox"
                    checked={repairOnly}
                    onChange={(event) => setRepairOnly(event.target.checked)}
                    aria-label={t('dlg.reparse.repair', { count: pages.length })}
                  />
                  <span>
                    <span className="ln-parseform__switchLabel">{t('dlg.reparse.repair', { count: pages.length })}</span>
                    <span className="ln-parseform__switchHint">{t('dlg.reparse.repairHint')}</span>
                  </span>
                </label>
              </div>
            </div>
          ) : null}

          {document.parse?.engine === 'local' && document.status === 'parsed' ? (
            <div className="ln-callout ln-callout--info">
              <span className="ln-callout__text">{t('dlg.reparse.repairUnavailable')}</span>
            </div>
          ) : null}

          <ParseOptionsForm
            value={options}
            onChange={setOptions}
            tokenConfigured={tokenConfigured}
            local={local}
            ext={document.ext.toLowerCase()}
            disabled={busy || parsing}
            showEngine={!repairOnly}
            onOpenSettings={() => {
              close()
              openSettings('settings')
            }}
          />

          {lastOptions !== null ? (
            <p className="ln-field__hint">
              {t('dlg.reparse.lastOptions', {
                engine: assembleEngineLabel(lastOptions.engine ?? 'auto', t),
                language: lastOptions.language ?? '—',
              })}
            </p>
          ) : null}

          {parsing ? (
            <p className="ln-field__hint">{parseProgressText(document, t)}</p>
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
