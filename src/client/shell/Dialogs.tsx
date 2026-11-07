/**
 * Shell dialogs: import, settings, rename, delete and parse options.
 *
 * Each dialog is thin — all state lives in the stores; the dialog only edits a
 * local draft and calls one store action, so the same operation is available to
 * the agent tools through the Host service.
 */

import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGE_OPTIONS, MODEL_VERSIONS, PARSE_ENGINES } from '../../shared/constants.ts'
import type { ParseEngine, ModelVersion } from '../../shared/constants.ts'
import { useLibraryStore } from '../state/library.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { Button, Dialog, Field, Segmented, Select, Switch, TextInput } from '../design/primitives.tsx'
import { useT } from './locale-context.ts'

/** Import dialog: local files and URL import. */
function ImportDialog(): ReactElement {
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const close = useUiStore((state) => state.closeDialog)
  const openDialog = useUiStore((state) => state.openDialog)
  const importFiles = useLibraryStore((state) => state.importFiles)
  const importUrl = useLibraryStore((state) => state.importUrl)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const submitFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setBusy(true)
    try {
      await importFiles(Array.from(files))
      close()
    } finally {
      setBusy(false)
    }
  }

  const submitUrl = async (): Promise<void> => {
    if (url.trim() === '') return
    setBusy(true)
    try {
      const document = await importUrl(url.trim())
      if (document !== null) {
        close()
        openDialog('reparse', document.id)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={dialog === 'import'}
      onClose={close}
      title={t('dlg.import.title')}
      description={t('dlg.import.hint')}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submitUrl()} disabled={busy || url.trim() === ''}>
            {t('dlg.import.start')}
          </Button>
        </>
      }
    >
      <div className="ln-import">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="ln-vh"
          onChange={(event) => void submitFiles(event.target.files)}
        />
        <Button icon="upload" variant="default" onClick={() => fileRef.current?.click()} disabled={busy}>
          {t('dlg.import.file')}
        </Button>
        <div className="ln-import__divider" aria-hidden="true" />
        <Field label={t('dlg.import.url')} htmlFor="ln-import-url">
          <div className="ln-import__url">
            <TextInput
              id="ln-import-url"
              value={url}
              placeholder={t('dlg.import.urlPlaceholder')}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitUrl()
              }}
            />
          </div>
        </Field>
      </div>
    </Dialog>
  )
}

/** Settings dialog: token + local capabilities + about. */
function SettingsDialog(): ReactElement {
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const close = useUiStore((state) => state.closeDialog)
  const toast = useUiStore((state) => state.toast)
  const settings = useSettingsStore()
  const status = useLibraryStore((state) => state.status)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={dialog === 'settings'} onClose={close} title={t('dlg.settings.title')} width={620}>
      <div className="ln-settings">
        <h3 className="ln-settings__section">{t('dlg.settings.parse')}</h3>
        <Field
          label={t('dlg.settings.token')}
          description={
            settings.tokenConfigured
              ? t('dlg.settings.tokenSaved')
              : `${t('dlg.settings.tokenMissing')}${settings.tokenPersistent ? '' : ' · 仅本次运行可用'}`
          }
        >
          <div className="ln-settings__row">
            <TextInput
              type="password"
              value={token}
              placeholder={t('dlg.settings.tokenPlaceholder')}
              onChange={(event) => setToken(event.target.value)}
            />
            <Button
              disabled={busy || token.trim() === ''}
              onClick={() => {
                setBusy(true)
                void settings.setToken(token.trim()).finally(() => {
                  setBusy(false)
                  setToken('')
                  toast(t('toast.saved'), 'success')
                })
              }}
            >
              {t('dlg.settings.tokenSave')}
            </Button>
            {settings.tokenConfigured ? (
              <Button variant="ghost" onClick={() => void settings.clearToken()}>
                {t('dlg.settings.tokenClear')}
              </Button>
            ) : null}
          </div>
        </Field>
        <Field
          label={t('dlg.settings.local')}
          description={
            settings.local !== null && settings.local.available
              ? t('dlg.settings.localReady')
              : t('dlg.settings.localMissing')
          }
        >
          <span className="ln-settings__facts">
            {settings.local?.providers.map((provider) => (
              <span key={provider.id} className="ln-badge">
                {provider.id}
              </span>
            )) ?? null}
          </span>
        </Field>
        <h3 className="ln-settings__section">关于</h3>
        <Field label={t('dlg.settings.version')}>
          <span className="ln-tabular">{status?.version ?? '2.0.0'}</span>
        </Field>
        <Field label={t('dlg.settings.dataDir')}>
          <span className="ln-settings__path">{status?.dataDirDisplay ?? '—'}</span>
        </Field>
      </div>
    </Dialog>
  )
}

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
    if (dialog === 'rename') setTitle(document?.title ?? '')
  }, [dialog, document?.title])

  return (
    <Dialog
      open={dialog === 'rename'}
      onClose={close}
      title={t('rail.rename')}
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
      <TextInput value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
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

  return (
    <Dialog
      open={dialog === 'delete'}
      onClose={close}
      title={t('rail.delete')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (target === null) return
              void remove(target).finally(() => close())
            }}
          >
            {t('action.delete')}
          </Button>
        </>
      }
    >
      <p className="ln-dialog__paragraph">
        删除后该文献的解析结果、批注、对话与图谱会一并删除，且不可恢复。
      </p>
      <p className="ln-dialog__paragraph ln-dialog__paragraph--strong">{document?.title ?? ''}</p>
    </Dialog>
  )
}

/** Parse-options dialog (fresh parse or page-scoped repair). */
function ReparseDialog(): ReactElement {
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const target = useUiStore((state) => state.dialogTarget)
  const close = useUiStore((state) => state.closeDialog)
  const documents = useLibraryStore((state) => state.documents)
  const startParse = useLibraryStore((state) => state.startParse)
  const preferences = useSettingsStore((state) => state.preferences)
  const document = documents.find((entry) => entry.id === target)
  const [engine, setEngine] = useState<ParseEngine>(preferences.defaultEngine)
  const [modelVersion, setModelVersion] = useState<ModelVersion>(preferences.defaultModelVersion)
  const [language, setLanguage] = useState(preferences.defaultLanguage)
  const [isOcr, setIsOcr] = useState(preferences.defaultIsOcr)
  const [enableFormula, setEnableFormula] = useState(preferences.defaultEnableFormula)
  const [enableTable, setEnableTable] = useState(preferences.defaultEnableTable)
  const [pageRanges, setPageRanges] = useState('')
  const [busy, setBusy] = useState(false)
  const localSupported = document?.status === 'uploaded' || document?.status === 'failed' || document?.status === 'parsed'

  const engineOptions = useMemo(
    () =>
      PARSE_ENGINES.map((value) => ({
        value,
        label:
          value === 'auto'
            ? '自动'
            : value === 'standard'
              ? '精准解析'
              : value === 'agent'
                ? '轻量解析'
                : '本地解析',
      })),
    [],
  )

  return (
    <Dialog
      open={dialog === 'reparse'}
      onClose={close}
      title={document?.status === 'parsed' ? t('rail.reparse') : '解析文献'}
      description={document?.title}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || target === null}
            onClick={() => {
              if (target === null) return
              setBusy(true)
              void startParse(target, {
                engine,
                modelVersion,
                language,
                isOcr,
                enableFormula,
                enableTable,
                pageRanges: pageRanges.trim() === '' ? undefined : pageRanges.trim(),
              }).finally(() => {
                setBusy(false)
                close()
              })
            }}
          >
            开始解析
          </Button>
        </>
      }
    >
      <div className="ln-parse-options">
        <Field label="解析引擎">
          <Segmented
            size="sm"
            value={engine}
            options={engineOptions}
            onChange={setEngine}
            ariaLabel="解析引擎"
          />
        </Field>
        <Field label="模型版本" description={engine === 'local' ? '本地解析不使用模型版本。' : undefined}>
          <Segmented
            size="sm"
            value={modelVersion}
            options={MODEL_VERSIONS.map((value) => ({ value, label: value === 'vlm' ? 'VLM' : 'Pipeline' }))}
            onChange={setModelVersion}
            ariaLabel="模型版本"
          />
        </Field>
        <Field label="文档语言">
          <Select value={language} onChange={(event) => setLanguage(event.target.value)}>
            {LANGUAGE_OPTIONS.map(([value, key]) => (
              <option key={value} value={value}>
                {t(key as 'setup.langCh')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="选项">
          <div className="ln-parse-options__switches">
            <label className="ln-parse-options__switch">
              <Switch checked={isOcr} onChange={setIsOcr} label="OCR" />
              OCR
            </label>
            <label className="ln-parse-options__switch">
              <Switch checked={enableFormula} onChange={setEnableFormula} label="公式" />
              公式
            </label>
            <label className="ln-parse-options__switch">
              <Switch checked={enableTable} onChange={setEnableTable} label="表格" />
              表格
            </label>
          </div>
        </Field>
        <Field
          label="页码范围"
          description={engine === 'local' ? '本地解析仅支持整篇解析。' : '留空解析全文，例如 2,4-6'}
        >
          <TextInput
            value={pageRanges}
            disabled={engine === 'local'}
            placeholder="2,4-6"
            onChange={(event) => setPageRanges(event.target.value)}
          />
        </Field>
        {engine === 'local' && !localSupported ? (
          <p className="ln-dialog__paragraph">本地解析仅处理 PDF 文字层与 Office 转换文件。</p>
        ) : null}
      </div>
    </Dialog>
  )
}

/** Mount every shell dialog (only one is open at a time). */
export function ShellDialogs(): ReactElement {
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
