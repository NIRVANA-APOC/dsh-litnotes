/**
 * Graph scene — the knowledge map of one paper or the whole library.
 *
 * Layout ownership: this component computes the deterministic first layout
 * (`layoutGraph`, d3-force) from the loaded model, remembers it per scope so
 * re-entry is stable, and hands the canvas both the full graph (for the live
 * drag simulation) and the filtered view. It also renders the scene states
 * (loading / building / empty / error) and the node card in the margin seat,
 * and implements the two cross-workstream seams: reader jump + AI composer.
 */

import type { ReactElement } from 'react'
import { useEffect, useMemo } from 'react'

import type { DocumentSummary, GraphNode } from '../../shared/model.ts'
import { useLibraryStore } from '../state/library.ts'
import { useUiStore } from '../state/ui.ts'
import { useAiStore } from '../ai/store.ts'
import { jumpToBlock } from '../reader/api.ts'
import { Button, EmptyState, ProgressBar, Spinner } from '../design/primitives.tsx'
import { useInjectedStyle } from '../design/use-style.ts'
import { Icon } from '../design/icons.tsx'
import { useT } from '../shell/locale-context.ts'
import { GraphCanvas } from './GraphCanvas.tsx'
import { useGraphMediaQuery } from './hooks.ts'
import { GraphNodeCard } from './GraphNodeCard.tsx'
import { layoutGraph } from './layout.ts'
import { storedPins, visibleGraph, type Point, type VisibleGraph } from './model.ts'
import { emptyGraphEntry, graphAiAvailable, installGraphSeams, useGraphStore } from './store.ts'
import graphCss from './styles.css'

/** Props supplied by the shell: the open document (may be undefined for library scope). */
export interface GraphSceneProps {
  document: DocumentSummary | null
}

/** Empty visible graph (shared constant so memos stay referentially stable). */
const EMPTY_VISIBLE: VisibleGraph = { nodes: [], edges: [] }

/** Idle empty graph entry shown when the library has no documents. */
const EMPTY_GRAPH_ENTRY = emptyGraphEntry(null)

/** Map a build phase to a copy key. */
function phaseLabelKey(phase: string): 'graph.phase.reading' | 'graph.phase.extracting' | 'graph.phase.merging' | 'graph.phase.done' | 'graph.building' {
  if (phase === 'reading' || phase === 'extracting' || phase === 'merging' || phase === 'done') {
    return `graph.phase.${phase}`
  }
  return 'graph.building'
}

/** The knowledge-map scene. */
export function GraphScene({ document }: GraphSceneProps): ReactElement {
  const t = useT()
  useInjectedStyle('graph', graphCss)
  const reducedMotion = useGraphMediaQuery('(prefers-reduced-motion: reduce)')

  const documentId = document?.id ?? null
  const scope = useGraphStore((state) => state.scope)
  const selectedId = useGraphStore((state) => state.selectedId)
  const typeFilters = useGraphStore((state) => state.typeFilters)
  const docEntry = useGraphStore((state) => state.doc)
  const libraryEntry = useGraphStore((state) => state.library)
  const selectNode = useGraphStore((state) => state.selectNode)
  const buildDoc = useGraphStore((state) => state.buildDoc)
  const rebuildLibrary = useGraphStore((state) => state.rebuildLibrary)
  const loadActive = useGraphStore((state) => state.loadActive)
  const documents = useLibraryStore((state) => state.documents)
  const marginOpen = useUiStore((state) => state.marginOpen)
  const activeAspect = useUiStore((state) => state.activeAspect)

  // With no documents the library graph persisted by the Host (or a stale
  // in-memory entry) must never leak counts into the frame: force an empty
  // library entry and show the import invitation instead.
  const libraryEmpty = documents.length === 0
  const entry = libraryEmpty ? EMPTY_GRAPH_ENTRY : scope === 'library' ? libraryEntry : docEntry
  const graph = entry.graph

  // Cross-workstream seams (idempotent): auto-build after parse / AI knowledge.
  useEffect(() => {
    installGraphSeams()
  }, [])

  // A document-scoped map is meaningless without a document: collapse to the
  // library scope (which itself renders the import invitation while empty).
  useEffect(() => {
    if (documentId !== null) return
    if (useGraphStore.getState().scope !== 'doc') return
    useGraphStore.getState().setScope('library')
  }, [documentId])

  // Load whichever scope is showing (the store deduplicates concurrent loads).
  useEffect(() => {
    if (libraryEmpty) return
    void loadActive(documentId)
  }, [documentId, scope, loadActive, libraryEmpty])

  const pinned = useMemo(() => (graph === null ? {} : storedPins(graph.nodes)), [graph])

  // The cached map of this scope as it was when the scene last unmounted.
  const cachedPositions = useMemo<Record<string, Point> | undefined>(() => {
    if (graph === null) return undefined
    return useGraphStore.getState().cachedPositions(scope, documentId)
  }, [graph, scope, documentId])

  const layout = useMemo(() => {
    if (graph === null || graph.nodes.length === 0) return null
    return layoutGraph(graph, {
      scope,
      seed: `${scope}:${documentId ?? 'library'}`,
      pinned,
      ...(cachedPositions === undefined ? {} : { previous: cachedPositions }),
    })
  }, [graph, scope, documentId, pinned, cachedPositions])

  // Remember the settled map so re-entry/refit keeps the same picture.
  useEffect(() => {
    if (layout === null) return
    useGraphStore.getState().rememberPositions(scope, documentId, layout.positions)
  }, [layout, scope, documentId])

  const visible = useMemo<VisibleGraph>(() => {
    if (graph === null) return EMPTY_VISIBLE
    return visibleGraph(graph, {
      types: typeFilters,
      aspect: activeAspect,
      keepStructural: scope === 'library',
    })
  }, [graph, typeFilters, activeAspect, scope])

  const selectedNode = graph === null || selectedId === null
    ? null
    : graph.nodes.find((node) => node.id === selectedId) ?? null
  const selectedPosition = selectedNode === null || layout === null ? null : layout.positions[selectedNode.id] ?? null

  /** Open one block in the read scene (doc scope = this paper). */
  const jump = (blockKey: string, node: GraphNode): void => {
    if (blockKey === '') return
    const targetDocumentId = scope === 'library' ? node.documentIds?.[0] : documentId
    jumpToBlock(blockKey, {
      ...(targetDocumentId === undefined || targetDocumentId === null ? {} : { documentId: targetDocumentId }),
    })
  }

  const onJump = (node: GraphNode): void => {
    const blockKey = node.blockKeys[0] ?? ''
    if (blockKey !== '') {
      jump(blockKey, node)
      return
    }
    // No provenance: still open the paper so the user is not stranded.
    if (scope === 'library') {
      const target = node.documentIds?.[0]
      if (target !== undefined) openPaper(target)
    }
  }

  const onAsk = (node: GraphNode): void => {
    const targetDocumentId = scope === 'library' ? node.documentIds?.[0] ?? null : documentId
    const blockKey = node.blockKeys[0] ?? ''
    if (targetDocumentId !== null) useUiStore.getState().openDocument(targetDocumentId)
    useUiStore.getState().setScene('read')
    if (blockKey !== '') jumpToBlock(blockKey, targetDocumentId === null ? {} : { documentId: targetDocumentId })
    useAiStore.getState().focusComposer(blockKey === ''
      ? null
      : { blockKey, quote: node.label, text: node.summary === '' ? node.label : node.summary })
  }

  const openPaper = (id: string): void => {
    useUiStore.getState().openDocument(id)
    useUiStore.getState().setScene('read')
  }

  const onPin = (id: string, position: Point): void => {
    void useGraphStore.getState().curate('pin', { id, position })
  }

  const onPositions = (positions: Record<string, Point>): void => {
    useGraphStore.getState().rememberPositions(scope, documentId, positions)
  }

  const aiAvailable = graphAiAvailable()
  const canBuild = !libraryEmpty && (scope === 'library' || documentId !== null)
  const build = (force = false): void => {
    if (scope === 'library') {
      void rebuildLibrary()
      return
    }
    if (documentId !== null) void buildDoc(documentId, { force })
  }

  const emptyAction = aiAvailable
    ? { label: scope === 'library' ? t('graph.empty.libraryAction') : t('graph.empty.action'), onClick: () => build(false) }
    : { label: t('graph.empty.noAiAction'), onClick: () => useUiStore.getState().openDialog('settings') }

  const showBuildInvitation = !libraryEmpty && graph === null
  const showEmptyNodes = !libraryEmpty && graph !== null && graph.nodes.length === 0
  const loading = !libraryEmpty && entry.status === 'loading' && graph === null
  const error = !libraryEmpty && entry.status === 'error' && graph === null

  return (
    <div className="ln-graph" data-scope={scope} data-status={entry.status}>
      <div className="ln-graph__stage">
        {graph !== null && visible.nodes.length > 0 && layout !== null ? (
          <GraphCanvas
            graph={graph}
            visible={visible}
            scope={scope}
            documentId={documentId}
            layoutPositions={layout.positions}
            pinned={pinned}
            selectedId={selectedId}
            reducedMotion={reducedMotion}
            onSelect={selectNode}
            onJump={onJump}
            onPin={onPin}
            onPositions={onPositions}
          />
        ) : null}

        {libraryEmpty ? (
          <div className="ln-graph__state">
            <EmptyState
              icon="book"
              title={t('graph.empty.noDocsTitle')}
              body={t('graph.empty.noDocsBody')}
              actions={
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => useUiStore.getState().openDialog('import')}
                >
                  {t('graph.empty.noDocsAction')}
                </Button>
              }
            />
          </div>
        ) : null}

        {loading ? (
          <div className="ln-graph__state" role="status">
            <Spinner label={t('graph.loading')} />
            <span>{t('graph.loading')}</span>
          </div>
        ) : null}

        {!libraryEmpty && entry.status === 'building' ? (
          <div className="ln-graph__state ln-graph__state--build" role="status">
            <span className="ln-graph__stateTitle">
              {entry.progress === null
                ? t('graph.building')
                : `${t(phaseLabelKey(entry.progress.phase))} ${entry.progress.done}/${entry.progress.total}`}
            </span>
            <div className="ln-graph__stateBar">
              <ProgressBar
                value={entry.progress?.done}
                total={entry.progress?.total}
                indeterminate={entry.progress === null}
                label={t('graph.building')}
              />
              <Button variant="ghost" size="sm" icon="stop" onClick={() => useGraphStore.getState().cancelBuild()}>
                {t('graph.build.cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="ln-graph__state">
            <EmptyState
              icon="alert"
              title={t('graph.error.title')}
              body={entry.error ?? undefined}
              actions={
                <Button variant="default" size="sm" icon="refresh" onClick={() => build(false)}>
                  {t('graph.error.retry')}
                </Button>
              }
            />
          </div>
        ) : null}

        {showBuildInvitation && !loading && entry.status !== 'building' && !error ? (
          <div className="ln-graph__state">
            {aiAvailable ? (
              <EmptyState
                icon="graph"
                title={scope === 'library' ? t('graph.empty.libraryTitle') : t('graph.empty.title')}
                body={scope === 'library' ? t('graph.empty.libraryBody') : t('graph.empty.body')}
                actions={
                  <Button
                    variant="primary"
                    icon="sparkle"
                    disabled={!canBuild}
                    onClick={emptyAction.onClick}
                  >
                    {emptyAction.label}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="sparkle"
                title={t('graph.empty.noAiTitle')}
                body={t('graph.empty.noAiBody')}
                actions={
                  <Button
                    variant="primary"
                    onClick={() => useUiStore.getState().openDialog('settings')}
                  >
                    {emptyAction.label}
                  </Button>
                }
              />
            )}
          </div>
        ) : null}

        {showEmptyNodes && entry.status !== 'building' ? (
          <div className="ln-graph__state">
            <EmptyState
              icon="graph"
              title={t('graph.emptyNodes.title')}
              body={t('graph.emptyNodes.body')}
              actions={
                <Button variant="primary" icon="refresh" onClick={() => build(true)}>
                  {t('graph.emptyNodes.action')}
                </Button>
              }
            />
          </div>
        ) : null}
      </div>

      {marginOpen ? (
        <aside className="ln-sheet__margin ln-graph__margin" aria-label={t('graph.card.title')}>
          <div className="ln-margin__head">
            <span className="ln-margin__title">{t('graph.card.title')}</span>
          </div>
          {selectedNode !== null ? (
            <GraphNodeCard
              node={selectedNode}
              scope={scope}
              nodes={graph?.nodes ?? []}
              position={selectedPosition}
              documents={documents}
              onClose={() => selectNode(null)}
              onJump={onJump}
              onJumpBlock={(blockKey) => jump(blockKey, selectedNode)}
              onOpenPaper={openPaper}
              onAsk={onAsk}
            />
          ) : (
            <p className="ln-graph__marginHint">
              <Icon name="graph" size={16} />
              <span>
                {libraryEmpty
                  ? t('graph.empty.noDocsBody')
                  : graph !== null && graph.nodes.length > 0
                  ? scope === 'library'
                    ? t('graph.selectHintLibrary')
                    : t('graph.selectHint')
                  : scope === 'library'
                    ? t('graph.empty.libraryTitle')
                    : t('graph.empty.title')}
              </span>
            </p>
          )}
        </aside>
      ) : null}
    </div>
  )
}
