// @vitest-environment happy-dom
/**
 * Graph store tests with a fake Host client: load, streaming build + cancel,
 * curation patches, library scope and the auto-build-after-parse seam.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { setHostClient, type HostClient } from '../../src/client/api/client.ts'
import { useAiStore } from '../../src/client/ai/store.ts'
import { useGraphStore } from '../../src/client/graph/store.ts'
import { positionsKey } from '../../src/client/graph/store.ts'
import { useLibraryStore } from '../../src/client/state/library.ts'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import { DEFAULT_PREFERENCES } from '../../src/shared/preferences.ts'
import { makeDocGraph, makeDocument, makeFakeClient, makeLibraryGraph } from './graph-fixtures.ts'

/** Cast the structural fake into the client singleton slot. */
function installFake(client: ReturnType<typeof makeFakeClient>): void {
  setHostClient(client as unknown as HostClient)
}

beforeEach(() => {
  useGraphStore.getState().reset()
  useUiStore.setState({ currentDocumentId: 'doc-1', marginOpen: false, scene: 'graph' })
  useSettingsStore.setState({ preferences: { ...DEFAULT_PREFERENCES } })
})

describe('graph loading', () => {
  test('loadDoc fetches, normalizes and stores the paper graph', async () => {
    const client = makeFakeClient()
    installFake(client)
    await useGraphStore.getState().loadDoc('doc-1')
    const state = useGraphStore.getState()
    expect(state.docId).toBe('doc-1')
    expect(state.doc.status).toBe('ready')
    expect(state.doc.graph?.nodes.length).toBe(4)
    expect(state.doc.graph?.stats.nodes).toBe(4)
    expect(client.calls.some((call) => call.method === 'graph.doc')).toBe(true)
    // Loading the same document again is a cache hit (no second call).
    const before = client.calls.length
    await useGraphStore.getState().loadDoc('doc-1')
    expect(client.calls.length).toBe(before)
  })

  test('an absent graph is an empty ready state, not an error', async () => {
    installFake(makeFakeClient({ absent: true }))
    await useGraphStore.getState().loadDoc('doc-1')
    const entry = useGraphStore.getState().doc
    expect(entry.status).toBe('ready')
    expect(entry.graph).toBeNull()
    expect(entry.error).toBeNull()
  })

  test('loadLibrary fetches the aggregated graph', async () => {
    const client = makeFakeClient()
    installFake(client)
    await useGraphStore.getState().loadLibrary()
    expect(useGraphStore.getState().library.status).toBe('ready')
    expect(useGraphStore.getState().library.graph?.nodes.length).toBe(3)
    expect(client.calls.some((call) => call.method === 'graph.library')).toBe(true)
  })
})

describe('streaming builds', () => {
  test('buildDoc consumes progress + graph frames and adopts the graph', async () => {
    const client = makeFakeClient()
    installFake(client)
    await useGraphStore.getState().buildDoc('doc-1')
    const entry = useGraphStore.getState().doc
    expect(entry.status).toBe('ready')
    expect(entry.progress).toBeNull()
    expect(entry.graph?.nodes.length).toBe(4)
    expect(client.calls.some((call) => call.method === 'graph.build')).toBe(true)
  })

  test('cancelBuild aborts the stream and leaves the scene idle', async () => {
    installFake(makeFakeClient({ build: 'hang' }))
    const building = useGraphStore.getState().buildDoc('doc-1')
    await vi.waitFor(() => expect(useGraphStore.getState().doc.status).toBe('building'))
    expect(useGraphStore.getState().doc.progress?.phase).toBe('reading')
    useGraphStore.getState().cancelBuild()
    await building
    const entry = useGraphStore.getState().doc
    expect(entry.status).toBe('idle')
    expect(entry.progress).toBeNull()
  })

  test('rebuildLibrary streams library progress and adopts the result', async () => {
    installFake(makeFakeClient())
    await useGraphStore.getState().rebuildLibrary()
    const entry = useGraphStore.getState().library
    expect(entry.status).toBe('ready')
    expect(entry.graph?.scope).toBe('library')
    expect(entry.graph?.nodes.length).toBe(3)
  })
})

describe('curation', () => {
  test('rename sends a graph.update patch and adopts the returned graph', async () => {
    const client = makeFakeClient()
    installFake(client)
    await useGraphStore.getState().loadDoc('doc-1')
    const ok = await useGraphStore.getState().curate('rename', { id: 'n-method', label: 'Learned router' })
    expect(ok).toBe(true)
    const call = client.calls.find((entry) => entry.method === 'graph.update')
    expect(call?.payload).toEqual({ documentId: 'doc-1', nodes: [{ id: 'n-method', label: 'Learned router' }] })
    expect(useGraphStore.getState().doc.graph?.nodes.find((node) => node.id === 'n-method')?.label).toBe('Learned router')
  })

  test('pin sends the rounded position and marks the node pinned', async () => {
    const client = makeFakeClient()
    installFake(client)
    await useGraphStore.getState().loadDoc('doc-1')
    const ok = await useGraphStore.getState().curate('pin', { id: 'n-concept', position: { x: 10.04, y: -2.06 } })
    expect(ok).toBe(true)
    const call = client.calls.find((entry) => entry.method === 'graph.update')
    expect(call?.payload).toEqual({
      documentId: 'doc-1',
      nodes: [{ id: 'n-concept', pinned: true, position: { x: 10, y: -2.1 } }],
    })
    const node = useGraphStore.getState().doc.graph?.nodes.find((candidate) => candidate.id === 'n-concept')
    expect(node?.pinned).toBe(true)
  })

  test('merge adopts the survivor and selects it', async () => {
    const client = makeFakeClient()
    installFake(client)
    await useGraphStore.getState().loadDoc('doc-1')
    const ok = await useGraphStore.getState().curate('merge', { from: 'n-limitation', into: 'n-method' })
    expect(ok).toBe(true)
    const ids = useGraphStore.getState().doc.graph?.nodes.map((node) => node.id) ?? []
    expect(ids).not.toContain('n-limitation')
    expect(useGraphStore.getState().selectedId).toBe('n-method')
  })

  test('invalid curation is refused without a Host call', async () => {
    const client = makeFakeClient()
    installFake(client)
    await useGraphStore.getState().loadDoc('doc-1')
    const before = client.calls.length
    expect(await useGraphStore.getState().curate('rename', { id: 'n-method', label: '  ' })).toBe(false)
    expect(client.calls.length).toBe(before)
  })
})

describe('selection, filters and position cache', () => {
  test('selectNode selects and opens the margin seat', async () => {
    installFake(makeFakeClient())
    await useGraphStore.getState().loadDoc('doc-1')
    useGraphStore.getState().selectNode('n-method')
    expect(useGraphStore.getState().selectedId).toBe('n-method')
    expect(useUiStore.getState().marginOpen).toBe(true)
    useGraphStore.getState().selectNode(null)
    expect(useGraphStore.getState().selectedId).toBeNull()
  })

  test('type filters toggle independently of the aspect filter', () => {
    const store = useGraphStore.getState()
    expect(store.typeFilters).toBeNull()
    store.toggleType('method')
    expect(useGraphStore.getState().typeFilters).toEqual(['method'])
    useGraphStore.getState().toggleType('finding')
    expect(useGraphStore.getState().typeFilters).toEqual(['method', 'finding'])
    useGraphStore.getState().toggleType('method')
    expect(useGraphStore.getState().typeFilters).toEqual(['finding'])
    useGraphStore.getState().toggleType('finding')
    expect(useGraphStore.getState().typeFilters).toBeNull()
  })

  test('positions are cached per scope/document with a bounded cache', () => {
    const store = useGraphStore.getState()
    store.rememberPositions('doc', 'doc-1', { a: { x: 1, y: 2 } })
    expect(useGraphStore.getState().cachedPositions('doc', 'doc-1')).toEqual({ a: { x: 1, y: 2 } })
    expect(positionsKey('library', null)).toBe('library')
    expect(positionsKey('doc', 'doc-1')).toBe('doc:doc-1')
    for (let index = 0; index < 12; index += 1) {
      useGraphStore.getState().rememberPositions('doc', `d${index}`, {})
    }
    expect(Object.keys(useGraphStore.getState().positions).length).toBeLessThanOrEqual(8)
  })
})

describe('host seams', () => {
  test('auto-builds the active paper after a parse when the preference is on', async () => {
    const client = makeFakeClient()
    installFake(client)
    // The poller refresh must report the parse transition.
    const parsed = makeDocument({ status: 'parsed' })
    const callable = client as unknown as { call: (method: string, payload: unknown) => Promise<unknown> }
    const original = callable.call.bind(client)
    callable.call = async (method: string, payload: unknown) =>
      method === 'library.list' ? { documents: [parsed] } : original(method, payload)
    useSettingsStore.setState({ preferences: { ...DEFAULT_PREFERENCES, graphAutoBuild: true } })
    useLibraryStore.setState({ documents: [makeDocument({ status: 'parsing' })] })
    const { installGraphSeams } = await import('../../src/client/graph/store.ts')
    installGraphSeams()
    await useLibraryStore.getState().refresh({ quiet: true })
    await vi.waitFor(() => expect(useGraphStore.getState().doc.status).toBe('ready'))
    expect(client.calls.some((call) => call.method === 'graph.build')).toBe(true)
    expect(useGraphStore.getState().doc.graph?.nodes.length).toBe(makeDocGraph().nodes.length)
    // The AI knowledge seam never throws when the AI half is not mounted.
    expect(typeof useAiStore.getState().focusComposer).toBe('function')
    expect(makeLibraryGraph().nodes.length).toBe(3)
  })
})
