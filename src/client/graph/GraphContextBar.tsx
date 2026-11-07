/**
 * Graph-scene context bar — scope switch + filters on the left, build/rebuild
 * actions on the right (fixed frame region, DESIGN-V2 §4/§5).
 *
 * The shell imports this component by name; every control keeps its position
 * in every graph state (position principle). Build progress and cancel replace
 * the build button in place.
 */

import type { ReactElement } from 'react'

import { ASPECTS, GRAPH_NODE_TYPES, type Aspect, type GraphNodeType } from '../../shared/constants.ts'
import { useLibraryStore } from '../state/library.ts'
import { useUiStore } from '../state/ui.ts'
import {
  AspectLegend,
  Button,
  IconButton,
  Menu,
  ProgressBar,
  Segmented,
  type MenuItem,
  type SegmentOption,
} from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'
import { nodeAspectCounts, presentNodeTypes, type GraphScope } from './model.ts'
import { useGraphStore } from './store.ts'

/** Known build phases surfaced by the Host streams. */
const PHASE_KEYS: Readonly<Record<string, 'graph.phase.reading' | 'graph.phase.extracting' | 'graph.phase.merging' | 'graph.phase.done'>> = {
  reading: 'graph.phase.reading',
  extracting: 'graph.phase.extracting',
  merging: 'graph.phase.merging',
  done: 'graph.phase.done',
}

/** The graph-scene context bar. */
export function GraphContextBar(): ReactElement {
  const t = useT()
  const scope = useGraphStore((state) => state.scope)
  const setScope = useGraphStore((state) => state.setScope)
  const docEntry = useGraphStore((state) => state.doc)
  const libraryEntry = useGraphStore((state) => state.library)
  const typeFilters = useGraphStore((state) => state.typeFilters)
  const toggleType = useGraphStore((state) => state.toggleType)
  const clearTypeFilters = useGraphStore((state) => state.clearTypeFilters)
  const buildDoc = useGraphStore((state) => state.buildDoc)
  const rebuildLibrary = useGraphStore((state) => state.rebuildLibrary)
  const cancelBuild = useGraphStore((state) => state.cancelBuild)
  const documentId = useUiStore((state) => state.currentDocumentId)
  const activeAspect = useUiStore((state) => state.activeAspect)
  const toggleAspect = useUiStore((state) => state.toggleAspect)
  const aiGraphAvailable = useLibraryStore((state) => state.status?.ai?.graph)
  const documents = useLibraryStore((state) => state.documents)

  // No documents means no graph at all (stale persisted graphs must not leak
  // counts or build actions into the frame).
  const libraryEmpty = documents.length === 0
  const entry = scope === 'library' ? libraryEntry : docEntry
  const graph = libraryEmpty ? null : entry.graph
  const building = entry.status === 'building'
  const progress = entry.progress
  const nodes = libraryEmpty ? [] : (graph?.nodes ?? [])

  const scopeOptions: Array<SegmentOption<GraphScope>> = [
    { value: 'doc', label: t('graph.scope.doc'), disabled: documentId === null },
    { value: 'library', label: t('graph.scope.library') },
  ]

  const present = presentNodeTypes(nodes)
  const aspectCounts = nodeAspectCounts(nodes)
  const typeItems: MenuItem[] = [
    {
      id: 'all',
      label: t('graph.type.all'),
      checked: typeFilters === null,
      onSelect: clearTypeFilters,
    },
    ...present.map((type) => ({
      id: type,
      label: t(`graph.node.${type}` as 'graph.node.concept'),
      checked: typeFilters !== null && typeFilters.includes(type),
      onSelect: () => toggleType(type),
    })),
  ]

  const rebuild = (): void => {
    if (scope === 'library') {
      void rebuildLibrary()
      return
    }
    if (documentId !== null) void buildDoc(documentId, { force: graph !== null })
  }

  const buildLabel = scope === 'library'
    ? (graph === null ? t('graph.build.library') : t('graph.rebuild.library'))
    : (graph === null ? t('graph.build') : t('graph.rebuild'))
  const aiKnown = aiGraphAvailable !== undefined ? aiGraphAvailable : true

  return (
    <div className="ln-contextbar">
      <div className="ln-contextbar__left">
        <Segmented
          size="sm"
          value={scope}
          options={scopeOptions}
          onChange={setScope}
          ariaLabel={t('graph.scope.switch')}
        />
        {libraryEmpty ? null : (
        <Menu
          items={typeItems}
          ariaLabel={t('graph.type.filter')}
          button={(menuProps) => (
            <button
              type="button"
              className="ln-chip ln-chip--menu"
              aria-pressed={typeFilters !== null}
              title={t('graph.type.filter')}
              {...menuProps}
            >
              {t('graph.type.filter')}
              {typeFilters !== null ? <span className="ln-chip__count ln-tabular">{typeFilters.length}</span> : null}
            </button>
          )}
        />
        )}
        {libraryEmpty ? null : (
        <AspectLegend
          aspects={ASPECTS}
          active={activeAspect}
          counts={nodes.length > 0 ? aspectCounts : undefined}
          onToggle={(aspect) => toggleAspect(aspect as Aspect)}
          labelOf={(aspect) => (aspect === 'legend' ? t('aspect.legend') : t(`aspect.${aspect}` as 'aspect.method'))}
        />
        )}
        {scope === 'doc' && documents.some((document) => document.id === documentId) ? null : null}
      </div>
      <div className="ln-contextbar__right">
        {libraryEmpty ? null : (
        <>
        <span className="ln-contextbar__count ln-tabular">
          {t('graph.counts', { nodes: nodes.length, edges: graph?.edges.length ?? 0 })}
        </span>
        {building ? (
          <span className="ln-contextbar__build">
            <ProgressBar
              value={progress?.done}
              total={progress?.total}
              indeterminate={progress === null}
              label={t('graph.building')}
            />
            <span className="ln-contextbar__phase">
              {progress === null
                ? t('graph.building')
                : t(PHASE_KEYS[progress.phase] ?? 'graph.building')}
              {progress !== null && progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''}
            </span>
            <IconButton icon="stop" label={t('graph.build.cancel')} size={16} onClick={cancelBuild} />
          </span>
        ) : (
          <Button
            variant={graph === null ? 'primary' : 'ghost'}
            size="sm"
            icon={graph === null ? 'sparkle' : 'refresh'}
            disabled={!aiKnown || (scope === 'doc' && documentId === null)}
            title={aiKnown ? buildLabel : t('graph.empty.noAiBody')}
            onClick={rebuild}
          >
            {buildLabel}
          </Button>
        )}
        </>
        )}
      </div>
    </div>
  )
}

/** Node type order re-exported for tests that assert the filter menu order. */
export { GRAPH_NODE_TYPES }
export type { GraphNodeType }
