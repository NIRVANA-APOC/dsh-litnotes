/**
 * Client application root: locale context, frame, scenes, dialogs and the
 * global interactions (hotkeys, drag-and-drop import, layout persistence).
 */

import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { LocaleContext, type LitnotesTranslate } from './locale-context.ts'
import { StatusBar, ToastHost, TopBar } from './Frame.tsx'
import { ReadContextBar } from '../reader/ReadContextBar.tsx'
import { GraphContextBar } from '../graph/GraphContextBar.tsx'
import { Rail } from './Rail.tsx'
import { SceneStage } from './scenes.tsx'
import { ShellDialogs } from './Dialogs.tsx'
import { useHotkey } from '../design/primitives.tsx'
import { useLibraryStore } from '../state/library.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { useT } from './locale-context.ts'

/** Props supplied by the slot registration. */
export interface AppProps {
  t: LitnotesTranslate
}

/** Global drop overlay + handlers. */
function DropZone({ children }: { children: ReactElement }): ReactElement {
  const t = useT()
  const queueImportFiles = useUiStore((state) => state.queueImportFiles)
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  return (
    <div
      className="ln-dropwrap"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return
        event.preventDefault()
        depth.current = 0
        setOver(false)
        queueImportFiles(Array.from(event.dataTransfer.files))
      }}
    >
      {children}
      {over ? (
        <div className="ln-drop" aria-hidden="true">
          <div className="ln-drop__inner">
            <span className="ln-drop__icon">↓</span>
            <span className="ln-drop__label">{t('dlg.import.drop')}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Mount the whole reading desk. */
export function App({ t }: AppProps): ReactElement {
  const scene = useUiStore((state) => state.scene)
  const currentDocumentId = useUiStore((state) => state.currentDocumentId)
  const loaded = useLibraryStore((state) => state.loaded)
  const documents = useLibraryStore((state) => state.documents)

  // Boot: load independent stores in parallel; dispose the poller on unload.
  useEffect(() => {
    void useSettingsStore.getState().load()
    void useLibraryStore.getState().load()
    return () => useLibraryStore.getState().dispose()
  }, [])

  // Restore the last document once the library index and prefs are available.
  useEffect(() => {
    if (!loaded) return
    const prefs = useSettingsStore.getState().preferences
    if (currentDocumentId !== null) return
    const last = prefs.lastDocumentId
    if (last === null || !documents.some((document) => document.id === last)) return
    useUiStore.getState().openDocument(last)
  }, [loaded, documents, currentDocumentId])

  // Persist the current document for the next visit (host-side preferences).
  useEffect(() => {
    const prefs = useSettingsStore.getState().preferences
    if (currentDocumentId === prefs.lastDocumentId) return
    void useSettingsStore.getState().patch({ lastDocumentId: currentDocumentId })
  }, [currentDocumentId])

  // Scene switch: 1 / 2. Search: mod+K. Graph fit is owned by the graph scene.
  useHotkey('1', () => useUiStore.getState().setScene('read'))
  useHotkey('2', () => useUiStore.getState().setScene('graph'))
  useHotkey('mod+k', () => useUiStore.getState().focusSearch(), { force: true })

  return (
    <LocaleContext.Provider value={t}>
      <DropZone>
        <div className="ln-root" data-scene={scene}>
          <TopBar />
          {scene === 'read' ? <ReadContextBar /> : <GraphContextBar />}
          <div className="ln-desk">
            <Rail />
            <main className="ln-stage" data-stage={scene}>
              <SceneStage />
            </main>
          </div>
          <StatusBar />
          <ToastHost />
          <ShellDialogs />
        </div>
      </DropZone>
    </LocaleContext.Provider>
  )
}
