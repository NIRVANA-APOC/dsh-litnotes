// @vitest-environment happy-dom
/**
 * Graph scene render tests (happy-dom): selection, filtering, the node-card
 * action order, curation round-trips, scene states and the two cross-workstream
 * seams (reader jump + AI composer).
 */

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { setHostClient, type HostClient } from '../../src/client/api/client.ts'
import { useAiStore } from '../../src/client/ai/store.ts'
import { GraphContextBar } from '../../src/client/graph/GraphContextBar.tsx'
import { GraphScene } from '../../src/client/graph/GraphScene.tsx'
import { normalizeGraph } from '../../src/client/graph/model.ts'
import { useGraphStore } from '../../src/client/graph/store.ts'
import { useLibraryStore } from '../../src/client/state/library.ts'
import { useReaderStore } from '../../src/client/reader/store.ts'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import { zh } from '../../src/client/i18n/index.ts'
import { LocaleContext, type LitnotesTranslate } from '../../src/client/shell/locale-context.ts'
import { DEFAULT_PREFERENCES } from '../../src/shared/preferences.ts'
import { makeDocGraph, makeDocument, makeFakeClient, makeLibraryGraph, makeStatus } from './graph-fixtures.ts'

/** Translate through the zh dictionary (key fallback keeps assertions readable). */
const t: LitnotesTranslate = ((key: string, params?: Record<string, unknown>) => {
  let value = (zh as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement))
    }
  }
  return value
}) as unknown as LitnotesTranslate

/** Mount the graph context bar + scene with the locale context. */
function mountScene(doc = makeDocument()): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const tree: ReactElement = (
    <LocaleContext.Provider value={t}>
      <GraphContextBar />
      <GraphScene document={doc} />
    </LocaleContext.Provider>
  )
  act(() => root.render(tree))
  mounted = { container, root }
  return container
}

/** Seed the store with an already-loaded doc graph (skips the network). */
function seedDocGraph(): void {
  useGraphStore.setState({
    scope: 'doc',
    docId: 'doc-1',
    doc: {
      documentId: 'doc-1',
      status: 'ready',
      graph: normalizeGraph(makeDocGraph()),
      progress: null,
      error: null,
    },
    selectedId: null,
    typeFilters: null,
  })
}

/** Fire one pointer click sequence on a node / the background. */
function pointerSequence(target: Element, x = 120, y = 120): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: y }))
  })
}

/** Select one node by id. */
function selectNode(container: HTMLElement, id: string): void {
  const node = container.querySelector(`[data-node-id="${id}"]`)
  expect(node, `node ${id} rendered`).not.toBeNull()
  if (node !== null) pointerSequence(node)
}

/** Click a button by its visible text. */
function clickButton(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  expect(button, `button ${label}`).toBeDefined()
  if (button !== undefined) act(() => button.click())
}

let mounted: { container: HTMLDivElement; root: Root } | null = null

beforeEach(() => {
  useGraphStore.getState().reset()
  useUiStore.setState({ currentDocumentId: 'doc-1', marginOpen: true, scene: 'graph' })
  useSettingsStore.setState({ preferences: { ...DEFAULT_PREFERENCES } })
  useLibraryStore.setState({ documents: [makeDocument()], status: makeStatus() })
})

afterEach(() => {
  if (mounted !== null) {
    act(() => mounted?.root.unmount())
    mounted.container.remove()
    mounted = null
  }
  vi.restoreAllMocks()
})

describe('scene states', () => {
  test('renders the loaded graph with nodes and edges', async () => {
    setHostClient(makeFakeClient() as unknown as HostClient)
    seedDocGraph()
    const container = mountScene()
    await act(async () => { await Promise.resolve() })
    const canvas = container.querySelector('.ln-graph__canvas')
    expect(canvas).not.toBeNull()
    expect(container.querySelectorAll('[data-node-id]').length).toBe(makeDocGraph().nodes.length)
    expect(container.querySelectorAll('.ln-edge').length).toBe(makeDocGraph().edges.length)
    expect(container.querySelector('[data-scope="doc"]')).not.toBeNull()
  })

  test('an absent graph shows the build invitation with its cost explanation', async () => {
    setHostClient(makeFakeClient({ absent: true }) as unknown as HostClient)
    useGraphStore.setState({ doc: { documentId: 'doc-1', status: 'idle', graph: null, progress: null, error: null } })
    const container = mountScene()
    await act(async () => { await Promise.resolve() })
    const text = container.textContent ?? ''
    expect(text).toContain(zh['graph.empty.title'])
    expect(text).toContain(zh['graph.empty.body'])
    expect(text).toContain(zh['graph.empty.action'])
  })

  test('a node count of zero shows the rebuild invitation', () => {
    setHostClient(makeFakeClient() as unknown as HostClient)
    useGraphStore.setState({
      doc: {
        documentId: 'doc-1',
        status: 'ready',
        graph: normalizeGraph({ nodes: [], edges: [], scope: 'document' }),
        progress: null,
        error: null,
      },
    })
    const container = mountScene()
    expect(container.textContent).toContain(zh['graph.emptyNodes.title'])
  })
})

describe('selection and the node card', () => {
  test('clicking a node selects it and shows the card actions in fixed order', async () => {
    setHostClient(makeFakeClient() as unknown as HostClient)
    seedDocGraph()
    const container = mountScene()
    selectNode(container, 'n-method')
    expect(useGraphStore.getState().selectedId).toBe('n-method')
    const labels = [...container.querySelectorAll('.ln-gnode__actions button')]
      .map((button) => button.textContent ?? '')
    expect(labels).toEqual([
      zh['graph.action.rename'],
      zh['graph.action.merge'],
      zh['graph.action.pin'],
      zh['graph.action.ask'],
      zh['graph.action.jump'],
    ])
    expect(container.querySelector('[data-node-id="n-method"]')?.getAttribute('data-selected')).toBe('true')
  })

  test('Escape clears the selection and keeps the margin seat mounted', async () => {
    setHostClient(makeFakeClient() as unknown as HostClient)
    seedDocGraph()
    const container = mountScene()
    selectNode(container, 'n-method')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(useGraphStore.getState().selectedId).toBeNull()
    expect(container.querySelector('.ln-graph__margin')).not.toBeNull()
  })

  test('jump action uses the reader block-jump seam', async () => {
    setHostClient(makeFakeClient() as unknown as HostClient)
    seedDocGraph()
    const jump = vi.spyOn(useReaderStore.getState(), 'requestJump').mockImplementation(() => {})
    const container = mountScene()
    selectNode(container, 'n-concept')
    clickButton(container, zh['graph.action.jump'])
    expect(jump).toHaveBeenCalledWith('b0:aaaa1111', { flash: true, documentId: 'doc-1' })
    expect(useUiStore.getState().scene).toBe('read')
  })

  test('ask action focuses the AI composer with the node context', async () => {
    setHostClient(makeFakeClient() as unknown as HostClient)
    seedDocGraph()
    const focus = vi.spyOn(useAiStore.getState(), 'focusComposer').mockImplementation(() => {})
    const container = mountScene()
    selectNode(container, 'n-concept')
    clickButton(container, zh['graph.action.ask'])
    expect(focus).toHaveBeenCalledWith({
      blockKey: 'b0:aaaa1111',
      quote: 'Sparse routing',
      text: 'Keep k of E experts active.',
    })
    expect(useUiStore.getState().scene).toBe('read')
  })

  test('inline rename saves through graph.update and updates the card', async () => {
    const client = makeFakeClient()
    setHostClient(client as unknown as HostClient)
    seedDocGraph()
    const container = mountScene()
    selectNode(container, 'n-method')
    clickButton(container, zh['graph.action.rename'])
    const input = container.querySelector('.ln-gnode__rename input')
    expect(input).not.toBeNull()
    if (input === null) return
    act(() => {
      // React tracks the native value setter; assign through it so onChange fires.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Learned router')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      clickButton(container, zh['graph.rename.save'])
      await Promise.resolve()
    })
    const call = client.calls.find((entry) => entry.method === 'graph.update')
    expect(call?.payload).toEqual({ documentId: 'doc-1', nodes: [{ id: 'n-method', label: 'Learned router' }] })
    expect(container.querySelector('.ln-gnode__label')?.textContent).toBe('Learned router')
  })

  test('merge is a two-step picker and sends from/to', async () => {
    const client = makeFakeClient()
    setHostClient(client as unknown as HostClient)
    seedDocGraph()
    const container = mountScene()
    selectNode(container, 'n-concept')
    clickButton(container, zh['graph.action.merge'])
    // Step 1: pick a target from the candidate list.
    clickButton(container, 'Router')
    expect(container.textContent).toContain('合并')
    // Step 2: confirm.
    await act(async () => {
      clickButton(container, zh['action.confirm'])
      await Promise.resolve()
    })
    const call = client.calls.find((entry) => entry.method === 'graph.update')
    expect(call?.payload).toEqual({ documentId: 'doc-1', merge: [{ from: 'n-concept', to: 'n-method' }] })
    expect(useGraphStore.getState().selectedId).toBe('n-method')
  })

  test('pin action sends the node world position', async () => {
    const client = makeFakeClient()
    setHostClient(client as unknown as HostClient)
    seedDocGraph()
    const container = mountScene()
    selectNode(container, 'n-method')
    await act(async () => {
      clickButton(container, zh['graph.action.pin'])
      await Promise.resolve()
    })
    const call = client.calls.find((entry) => entry.method === 'graph.update')
    const payload = call?.payload as { nodes?: Array<{ id: string; pinned?: boolean; position?: unknown }> } | undefined
    expect(payload?.nodes?.[0]?.id).toBe('n-method')
    expect(payload?.nodes?.[0]?.pinned).toBe(true)
    expect(payload?.nodes?.[0]?.position).toBeDefined()
  })
})

describe('filters and scopes', () => {
  test('type filters drive the visible node set through the store', async () => {
    setHostClient(makeFakeClient() as unknown as HostClient)
    seedDocGraph()
    const container = mountScene()
    expect(container.querySelectorAll('[data-node-id]').length).toBe(4)
    act(() => useGraphStore.getState().toggleType('method'))
    expect(container.querySelectorAll('[data-node-id]').length).toBe(1)
    expect(container.querySelector('[data-node-id="n-method"]')).not.toBeNull()
    act(() => useGraphStore.getState().clearTypeFilters())
    expect(container.querySelectorAll('[data-node-id]').length).toBe(4)
  })

  test('switching to library scope loads and renders the aggregate graph', async () => {
    const client = makeFakeClient()
    setHostClient(client as unknown as HostClient)
    seedDocGraph()
    useGraphStore.setState({ library: { documentId: null, status: 'idle', graph: null, progress: null, error: null } })
    const container = mountScene()
    const libraryButton = [...container.querySelectorAll('.ln-seg__item')]
      .find((button) => button.textContent?.includes(zh['graph.scope.library']))
    expect(libraryButton).toBeDefined()
    await act(async () => {
      ;(libraryButton as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(useGraphStore.getState().scope).toBe('library')
    expect(client.calls.some((call) => call.method === 'graph.library')).toBe(true)
    await act(async () => { await Promise.resolve() })
    expect(useGraphStore.getState().library.graph?.nodes.length).toBe(makeLibraryGraph().nodes.length)
    expect(container.querySelectorAll('[data-node-id]').length).toBe(makeLibraryGraph().nodes.length)
    // Library card lists the related papers instead of doc curation.
    const topic = container.querySelector('[data-node-id="topic:routing"]')
    expect(topic).not.toBeNull()
    if (topic !== null) pointerSequence(topic)
    expect(container.textContent).toContain(zh['graph.card.papers'])
    expect(container.querySelector('.ln-gnode__paperlist')).not.toBeNull()
  })
})
