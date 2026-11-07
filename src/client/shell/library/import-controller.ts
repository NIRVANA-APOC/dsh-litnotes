/**
 * Import orchestration for the shell: local files → upload (with per-file
 * progress) → library refresh → optional parse with the chosen options.
 *
 * The library store owns list state and parse polling; this controller only
 * tracks in-flight uploads (the rail renders them as rows) and composes the
 * existing store actions so the dialog can close immediately after submit.
 */

import { create } from 'zustand'
import { getHostClient } from '../../api/client.ts'
import type { ParseOptions } from '../../../shared/model.ts'
import { useLibraryStore } from '../../state/library.ts'
import { useUiStore } from '../../state/ui.ts'
import type { LitnotesTranslate } from '../locale-context.ts'
import { describeImportFailure, failureText, type ImportFailure } from './import-errors.ts'

/** One upload row state. */
export interface UploadItem {
  key: string
  name: string
  /** Upload ratio, 0–1. */
  progress: number
  /** Kept so the row can offer "retry upload". */
  file: File
  /** Parse options to apply after this upload (null = import only). */
  parseOptions: ParseOptions | null
  state: 'uploading' | 'failed'
  /** Failure message (failed state only). */
  error: string | null
  /** What to do next (failed state only). */
  guide: string | null
}

/** Import controller store shape. */
export interface ImportControllerState {
  uploads: UploadItem[]
  /** Upload files, refresh the library, then parse each imported document. */
  importFiles: (files: ReadonlyArray<File>, parseOptions: ParseOptions | null, t: LitnotesTranslate) => Promise<void>
  /** Import one URL, then optionally parse it; returns the failure, if any. */
  importUrl: (url: string, parseOptions: ParseOptions | null, t: LitnotesTranslate) => Promise<ImportFailure | null>
  /** Retry one failed upload (same file, same parse options). */
  retryUpload: (key: string, t: LitnotesTranslate) => Promise<void>
  dismissUpload: (key: string) => void
}

let uploadSeq = 0

/** Replace one upload item in place. */
function updateUpload(
  set: (updater: (state: ImportControllerState) => Partial<ImportControllerState>) => void,
  key: string,
  patch: Partial<UploadItem>,
): void {
  set((state) => ({
    uploads: state.uploads.map((item) => (item.key === key ? { ...item, ...patch } : item)),
  }))
}

/** Remove one upload item. */
function removeUpload(set: (updater: (state: ImportControllerState) => Partial<ImportControllerState>) => void, key: string): void {
  set((state) => ({ uploads: state.uploads.filter((item) => item.key !== key) }))
}

/** One imported document, as much as the import flow needs after upload. */
export interface ImportedDocument {
  id: string
  title: string
}

/** Run one file through upload. */
async function runUpload(
  set: (updater: (state: ImportControllerState) => Partial<ImportControllerState>) => void,
  key: string,
  file: File,
  t: LitnotesTranslate,
): Promise<ImportedDocument | null> {
  try {
    const client = getHostClient()
    const { document } = await client.upload(file, {
      onProgress: (ratio: number) => updateUpload(set, key, { progress: Math.max(0, Math.min(1, ratio)) }),
    })
    removeUpload(set, key)
    useUiStore.getState().toast(t('toast.imported', { name: file.name }), 'success')
    return document
  } catch (error) {
    const failure = describeImportFailure(error, t)
    updateUpload(set, key, { state: 'failed', error: failure.message, guide: failure.hint })
    useUiStore.getState().toast(t('toast.uploadFailed', { message: failureText(failure) }), 'error')
    return null
  }
}

/** The import controller. */
export const useImportController = create<ImportControllerState>((set, get) => ({
  uploads: [],

  importFiles: async (files, parseOptions, t) => {
    const list = Array.from(files).filter((file) => file instanceof File)
    if (list.length === 0) return
    const queue: Array<{ key: string; file: File }> = []
    for (const file of list) {
      uploadSeq += 1
      const key = `upload-${uploadSeq}`
      queue.push({ key, file })
      set((state) => ({
        uploads: [
          ...state.uploads,
          {
            key,
            name: file.name,
            progress: 0,
            file,
            parseOptions,
            state: 'uploading',
            error: null,
            guide: null,
          },
        ],
      }))
    }
    const imported: ImportedDocument[] = []
    for (const entry of queue) {
      const document = await runUpload(set, entry.key, entry.file, t)
      if (document !== null) imported.push(document)
    }
    if (imported.length === 0) return
    // Show the new rows before parsing so the row — not the dialog — is the
    // place where progress lives (DESIGN-V2 §7).
    await useLibraryStore.getState().refresh({ quiet: true })
    const ui = useUiStore.getState()
    const first = imported[0]
    if (first !== undefined && ui.currentDocumentId === null) {
      ui.openDocument(first.id)
      if (parseOptions !== null) ui.setScene('read')
    }
    if (parseOptions !== null) {
      for (const document of imported) {
        await useLibraryStore.getState().startParse(document.id, parseOptions)
      }
      const name = imported.length === 1 ? imported[0]?.title ?? '' : String(imported.length)
      useUiStore.getState().toast(t('toast.parseStarted', { name }), 'success')
    }
  },

  importUrl: async (url, parseOptions, t) => {
    try {
      const { document } = await getHostClient().call('library.importUrl', { url })
      await useLibraryStore.getState().refresh({ quiet: true })
      useUiStore.getState().toast(t('toast.imported', { name: document.title }), 'success')
      const ui = useUiStore.getState()
      if (ui.currentDocumentId === null) {
        ui.openDocument(document.id)
        if (parseOptions !== null) ui.setScene('read')
      }
      if (parseOptions !== null) {
        await useLibraryStore.getState().startParse(document.id, parseOptions)
      }
      return null
    } catch (error) {
      // The dialog renders the message + next step inline (it stays open), so
      // no toast here: the failure guidance must not disappear in 3 seconds.
      return describeImportFailure(error, t)
    }
  },

  retryUpload: async (key, t) => {
    const item = get().uploads.find((upload) => upload.key === key)
    if (item === undefined) return
    removeUpload(set, key)
    await get().importFiles([item.file], item.parseOptions, t)
  },

  dismissUpload: (key) => removeUpload(set, key),
}))
