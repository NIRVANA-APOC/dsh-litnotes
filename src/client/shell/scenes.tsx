/**
 * Scene stage: chooses the empty desk, the reader or the graph.
 *
 * The reader (`src/client/reader/**`) and graph (`src/client/graph/**`) scenes
 * are separate workstreams; until their scene components land this module
 * renders the desk skeleton with the real document identity, so the frame,
 * API, stores and routing can be exercised end to end.
 */

import type { ReactElement } from 'react'
import { useLibraryStore } from '../state/library.ts'
import { useUiStore } from '../state/ui.ts'
import { Button, EmptyState } from '../design/primitives.tsx'
import { useT } from './locale-context.ts'
import { ReadScene } from '../reader/ReadScene.tsx'
import { GraphScene } from '../graph/GraphScene.tsx'

/** The empty desk: no document selected. */
function EmptyDesk(): ReactElement {
  const t = useT()
  const documents = useLibraryStore((state) => state.documents)
  const loaded = useLibraryStore((state) => state.loaded)
  const openDialog = useUiStore((state) => state.openDialog)
  if (!loaded) {
    return (
      <div className="ln-stage__center">
        <span className="ln-spinner" style={{ width: 18, height: 18 }} aria-label={t('empty.loading')} />
      </div>
    )
  }
  if (documents.length === 0) {
    return (
      <div className="ln-stage__center">
        <EmptyState
          icon="book"
          title={t('empty.noDoc.title')}
          body={t('empty.noDoc.body')}
          actions={
            <Button variant="primary" icon="plus" onClick={() => openDialog('import')}>
              {t('empty.noDoc.action')}
            </Button>
          }
        />
      </div>
    )
  }
  return (
    <div className="ln-stage__center">
      <EmptyState icon="book" title={t('top.crumbs.pick')} body={t('empty.pick.body')} />
    </div>
  )
}

/** Document-selected but not parsed yet. */
function UnparsedDesk({ title }: { title: string }): ReactElement {
  const t = useT()
  const dialogTarget = useUiStore((state) => state.currentDocumentId)
  const openDialog = useUiStore((state) => state.openDialog)
  return (
    <div className="ln-stage__center">
      <EmptyState
        icon="file"
        title={title}
        body={t('empty.noParse.body')}
        actions={
          <Button variant="primary" icon="sparkle" onClick={() => openDialog('reparse', dialogTarget)}>
            {t('empty.noParse.action')}
          </Button>
        }
      />
    </div>
  )
}

/** The stage for the current scene and document. */
export function SceneStage(): ReactElement {
  const scene = useUiStore((state) => state.scene)
  const documentId = useUiStore((state) => state.currentDocumentId)
  const documents = useLibraryStore((state) => state.documents)
  const document = documents.find((entry) => entry.id === documentId)

  if (document === undefined) return <EmptyDesk />
  if (document.status !== 'parsed') return <UnparsedDesk title={document.title} />
  return scene === 'read' ? <ReadScene document={document} /> : <GraphScene document={document} />
}
