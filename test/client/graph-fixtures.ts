/**
 * Graph workstream test fixtures: knowledge graphs + a fake Host client.
 *
 * Shared by the store/layout/scene tests. The fake client implements exactly the
 * graph methods the store calls (`graph.doc`, `graph.library`, `graph.update`,
 * `graph.build` stream, `graph.library.rebuild` stream) and records calls.
 */

import type { HostClient } from '../../src/client/api/client.ts'
import { ApiError } from '../../src/client/api/client.ts'
import type {
  KnowledgeGraph,
  GraphPatch,
  GraphBuildFrame,
  LibraryGraphFrame,
  DocumentSummary,
} from '../../src/shared/model.ts'
import { DEFAULT_PREFERENCES } from '../../src/shared/preferences.ts'
import type { StatusValue } from '../../src/shared/model.ts'

/** A document summary for library/scene tests. */
export function makeDocument(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  const now = '2026-11-07T00:00:00.000Z'
  return {
    schemaVersion: 1,
    id: 'doc-1',
    title: 'Sparse Routing',
    originalName: 'sparse.pdf',
    ext: '.pdf',
    mime: 'application/pdf',
    size: 1024,
    sha256: 'x',
    createdAt: now,
    updatedAt: now,
    status: 'parsed',
    error: null,
    pages: 3,
    wordCount: 1000,
    pageCount: 3,
    parse: {
      engine: 'standard',
      provider: null,
      modelVersion: 'vlm',
      language: 'en',
      options: null,
      phase: null,
      remoteState: null,
      taskId: null,
      batchId: null,
      startedAt: now,
      finishedAt: now,
      pages: 3,
      progress: null,
      hasContentList: true,
      local: null,
    },
    ...overrides,
  } as DocumentSummary
}

/** One normalized-looking doc graph (concept/method/finding). */
export function makeDocGraph(documentId = 'doc-1'): KnowledgeGraph {
  return {
    version: 1,
    scope: 'document',
    documentId,
    generatedAt: '2026-11-07T00:00:00.000Z',
    overview: 'A sparse routing paper.',
    nodes: [
      {
        id: 'n-concept',
        type: 'concept',
        label: 'Sparse routing',
        summary: 'Keep k of E experts active.',
        blockKeys: ['b0:aaaa1111', 'b1:bbbb2222', 'b2:cccc3333', 'b3:dddd4444'],
        aspect: 'definition',
        source: 'ai-summary',
        weight: 3,
      },
      {
        id: 'n-method',
        type: 'method',
        label: 'Router',
        summary: 'Token-level router trained jointly.',
        blockKeys: ['b1:bbbb2222'],
        aspect: 'method',
        source: 'ai-summary',
        weight: 2,
      },
      {
        id: 'n-finding',
        type: 'finding',
        label: 'Cheaper inference',
        summary: 'Cost scales with k rather than E.',
        blockKeys: ['b2:cccc3333'],
        aspect: 'result',
        source: 'qa',
        weight: 1,
      },
      {
        id: 'n-limitation',
        type: 'limitation',
        label: 'Load balance',
        summary: 'Experts must stay uniformly used.',
        blockKeys: [],
        aspect: 'limitation',
        source: 'qa',
        weight: 1,
      },
    ],
    edges: [
      { id: 'e1', from: 'n-concept', to: 'n-method', type: 'uses', source: 'ai-summary', weight: 1 },
      { id: 'e2', from: 'n-method', to: 'n-finding', type: 'supports', source: 'ai-summary', weight: 1 },
      { id: 'e3', from: 'n-concept', to: 'n-finding', type: 'defines', source: 'qa', weight: 1 },
    ],
    stats: { nodes: 4, edges: 3 },
  }
}

/** One normalized-looking library graph (paper + topic nodes). */
export function makeLibraryGraph(): KnowledgeGraph {
  return {
    version: 1,
    scope: 'library',
    generatedAt: '2026-11-07T00:00:00.000Z',
    overview: 'Two papers about routing.',
    nodes: [
      {
        id: 'paper:doc-1',
        type: 'paper',
        label: 'Sparse Routing',
        summary: '',
        blockKeys: [],
        documentIds: ['doc-1'],
        source: 'aggregate',
        weight: 2,
      },
      {
        id: 'paper:doc-2',
        type: 'paper',
        label: 'Dense Retrieval',
        summary: '',
        blockKeys: [],
        documentIds: ['doc-2'],
        source: 'aggregate',
        weight: 2,
      },
      {
        id: 'topic:routing',
        type: 'topic',
        label: 'Routing',
        summary: 'MoE routing.',
        blockKeys: ['b1:bbbb2222'],
        documentIds: ['doc-1', 'doc-2'],
        aspect: 'method',
        source: 'aggregate',
        weight: 4,
      },
    ],
    edges: [
      { id: 'le1', from: 'paper:doc-1', to: 'topic:routing', type: 'mentions', source: 'aggregate', weight: 1 },
      { id: 'le2', from: 'paper:doc-2', to: 'topic:routing', type: 'mentions', source: 'aggregate', weight: 1 },
    ],
    stats: { nodes: 3, edges: 2 },
  }
}

/** A tiny status value for the library store (`graphAiAvailable`). */
export function makeStatus(): StatusValue {
  return {
    version: '2.0.0',
    hostVersion: '2.0.0+host',
    dataDirDisplay: '~/.dsh/litnotes',
    tokenConfigured: true,
    tokenPersistent: true,
    translatorAvailable: true,
    modelAvailable: true,
    counts: { total: 2, parsed: 2, parsing: 0, failed: 0 },
    preferences: { ...DEFAULT_PREFERENCES },
    local: null,
    ai: {
      available: true,
      graph: true,
      route: { provider: 'deepseek', model: 'deepseek-flash' },
      retriever: true,
    },
  }
}

/** Recorded calls / controls of one fake graph client. */
export interface FakeClientOptions {
  docGraph?: KnowledgeGraph
  libraryGraph?: KnowledgeGraph
  /** Throw this on `graph.doc`/`graph.library` (null → empty `not-found`). */
  absent?: boolean
  /** Behaviour of the streaming build (default: progress → graph → done). */
  build?: 'complete' | 'hang'
  /** Graph returned by `graph.update` (default: the doc graph with the patch applied shallowly). */
  updateResult?: KnowledgeGraph
}

/** A fake Host client plus the call log. */
export interface FakeGraphClient extends HostClient {
  calls: Array<{ method: string; payload: unknown }>
}

/** Build the fake client. */
export function makeFakeClient(options: FakeClientOptions = {}): FakeGraphClient {
  const docGraph = options.docGraph ?? makeDocGraph()
  const libraryGraph = options.libraryGraph ?? makeLibraryGraph()
  const calls: Array<{ method: string; payload: unknown }> = []
  let currentDoc = docGraph
  const client = {
    base: 'http://localhost/dsh-litnotes/api',
    calls,
    async call(method: string, payload: unknown): Promise<unknown> {
      calls.push({ method, payload })
      if (method === 'graph.doc') {
        if (options.absent === true) throw new ApiError('not-found', 'not found', 404)
        return { graph: currentDoc }
      }
      if (method === 'graph.library') {
        if (options.absent === true) throw new ApiError('not-found', 'not found', 404)
        return { graph: libraryGraph }
      }
      if (method === 'graph.update') {
        const patch = payload as GraphPatch & { documentId: string }
        currentDoc = options.updateResult ?? applyPatch(currentDoc, patch)
        return { graph: currentDoc }
      }
      if (method === 'status') return makeStatus()
      if (method === 'library.list') return { documents: [] }
      if (method === 'settings.get') {
        return {
          tokenConfigured: true,
          preferences: { ...DEFAULT_PREFERENCES },
          providers: [],
          defaults: {
            engine: 'auto',
            modelVersion: 'vlm',
            language: 'ch',
            targetLanguage: 'zh',
            translationProvider: 'auto',
            autoAllowAgentFallback: true,
            localProvider: 'auto',
          },
          local: null,
        }
      }
      if (method === 'settings.update') return { preferences: { ...DEFAULT_PREFERENCES } }
      throw new Error(`unexpected call ${String(method)}`)
    },
    async stream(
      method: string,
      _request: unknown,
      handlers: { onFrame: (frame: GraphBuildFrame | LibraryGraphFrame) => void; signal?: AbortSignal },
    ): Promise<void> {
      calls.push({ method, payload: _request })
      if (options.build === 'hang') {
        handlers.onFrame({ type: 'progress', phase: 'reading', done: 1, total: 10 })
        await new Promise<void>((_resolve, reject) => {
          handlers.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
        return
      }
      if (method === 'graph.build') {
        handlers.onFrame({ type: 'progress', phase: 'reading', done: 1, total: 2 })
        handlers.onFrame({ type: 'progress', phase: 'done', done: 2, total: 2 })
        handlers.onFrame({ type: 'graph', graph: currentDoc })
        return
      }
      handlers.onFrame({ type: 'progress', phase: 'aggregate', done: 1, total: 1 })
      handlers.onFrame({ type: 'graph', graph: libraryGraph })
    },
    async upload() {
      throw new Error('upload not expected')
    },
    asset: (id: string, path: string) => `http://localhost/asset/${id}/${path}`,
    source: (id: string) => `http://localhost/source/${id}`,
    vendor: (path: string) => `http://localhost/vendor/${path}`,
    ping: () => {},
  }
  // The methods are structurally compatible with HostClient; the fake implements
  // a superset signature on purpose so tests can record raw calls.
  return client as unknown as FakeGraphClient
}

/** Apply a curation patch shallowly (enough to assert adoption/merge). */
function applyPatch(graph: KnowledgeGraph, patch: GraphPatch): KnowledgeGraph {
  let nodes = graph.nodes.map((node) => ({ ...node }))
  if (patch.nodes !== undefined) {
    for (const update of patch.nodes) {
      nodes = nodes.map((node) => (node.id === update.id
        ? {
            ...node,
            ...(update.label === undefined ? {} : { label: update.label }),
            ...(update.summary === undefined ? {} : { summary: update.summary }),
            ...(update.aspect === undefined ? {} : { aspect: update.aspect }),
            ...(update.weight === undefined ? {} : { weight: update.weight }),
            ...(update.pinned === undefined ? {} : { pinned: update.pinned }),
            ...(update.position === undefined ? {} : { position: update.position }),
            ...(update.type === undefined ? {} : { type: update.type }),
          }
        : node))
    }
  }
  if (patch.merge !== undefined) {
    for (const merge of patch.merge) {
      nodes = nodes.filter((node) => node.id !== merge.from)
    }
  }
  const ids = new Set(nodes.map((node) => node.id))
  const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  return { ...graph, nodes, edges, stats: { nodes: nodes.length, edges: edges.length } }
}
