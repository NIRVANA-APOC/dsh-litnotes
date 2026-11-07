// @vitest-environment happy-dom
/**
 * Rail render tests: instant MiniSearch filtering, status filter chips,
 * sorting, row actions, upload rows and the empty/loading/error states.
 */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Rail } from '../../src/client/shell/Rail.tsx'
import { useImportController } from '../../src/client/shell/library/import-controller.ts'
import { useLibraryStore } from '../../src/client/state/library.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import {
  buttonByText,
  click,
  flush,
  installShellClient,
  makeDocument,
  resetShellStores,
  renderShell,
  type ShellRender,
  type ShellClient,
} from './shell-helpers.tsx'

/** Five-row library covering every status. */
function library(): ReturnType<typeof makeDocument>[] {
  return [
    makeDocument('a', {
      title: 'Transformer Reading',
      updatedAt: '2026-11-05T10:00:00.000Z',
    }),
    makeDocument('b', {
      title: 'Attention Is All You Need',
      updatedAt: '2026-11-03T10:00:00.000Z',
    }),
    makeDocument('c', {
      title: 'Sparse Attention',
      status: 'parsing',
      updatedAt: '2026-11-04T10:00:00.000Z',
      parse: {
        engine: 'standard',
        provider: null,
        local: null,
        modelVersion: 'vlm',
        language: 'ch',
        phase: 'polling',
        remoteState: 'running',
        ocr: false,
        pages: 10,
        progress: { extracted: 3, total: 10 },
        hasContentList: false,
        startedAt: null,
        finishedAt: null,
      },
    }),
    makeDocument('d', { title: 'Broken Paper', status: 'failed', error: 'boom' }),
    makeDocument('e', {
      title: 'Unparsed Paper',
      status: 'uploaded',
      parse: null,
    }),
  ]
}

let client: ShellClient
let rendered: ShellRender | null = null

/** Render the rail against the fake client. */
function renderRail(): ShellRender {
  rendered = renderShell(<Rail />)
  return rendered
}

beforeEach(() => {
  const documents = library()
  client = installShellClient({ documents })
  resetShellStores(documents)
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
})

describe('library rail', () => {
  it('renders one row per document with status attributes and chip counts', () => {
    const { container } = renderRail()
    const rows = container.querySelectorAll('.ln-doc')
    expect(rows.length).toBe(5)
    expect(container.querySelector('.ln-doc[data-status="parsing"]')).not.toBeNull()
    expect(container.querySelector('.ln-doc[data-status="failed"]')).not.toBeNull()
    expect(container.querySelector('.ln-doc[data-status="uploaded"]')).not.toBeNull()
    // Filter chips: 全部/已解析/解析中/待解析/失败 with counts.
    const chips = [...container.querySelectorAll('.ln-rail__filters .ln-chip')]
    expect(chips.length).toBe(5)
    expect(chips[1]?.textContent).toContain('2')
    expect(chips[2]?.textContent).toContain('1')
  })

  it('filters instantly through MiniSearch on the title', async () => {
    const { container } = renderRail()
    const input = container.querySelector<HTMLInputElement>('.ln-rail__search input')
    expect(input).not.toBeNull()
    if (input === null) return
    act(() => {
      input.value = 'transformer'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    const titles = [...container.querySelectorAll('.ln-doc__title')].map((node) => node.textContent)
    expect(titles).toEqual(['Transformer Reading'])
  })

  it('toggles the status filter chips', async () => {
    const { container } = renderRail()
    const parsedChip = buttonByText(container.querySelector('.ln-rail__filters'), 'rail.filter.parsed')
    click(parsedChip)
    await flush()
    const statuses = [...container.querySelectorAll('.ln-doc')].map((node) => node.getAttribute('data-status'))
    expect(statuses).toEqual(['parsed', 'parsed'])
    // Clicking the same chip again returns to "all".
    click(parsedChip)
    await flush()
    expect(container.querySelectorAll('.ln-doc').length).toBe(5)
  })

  it('sorts rows by title via the sort menu', async () => {
    const { container } = renderRail()
    const sortButton = container.querySelector<HTMLButtonElement>('button[aria-label="rail.sort"]')
    click(sortButton)
    await flush()
    const titleItem = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
      (item.textContent ?? '').includes('rail.sort.title'),
    )
    click(titleItem)
    await flush()
    const titles = [...container.querySelectorAll('.ln-doc__title')].map((node) => node.textContent ?? '')
    expect(titles).toEqual([
      'Attention Is All You Need',
      'Broken Paper',
      'Sparse Attention',
      'Transformer Reading',
      'Unparsed Paper',
    ])
  })

  it('opens a document from its row and selects the read scene', () => {
    const { container } = renderRail()
    const firstOpen = container.querySelector<HTMLButtonElement>('.ln-doc[data-status="parsed"] .ln-doc__open')
    click(firstOpen)
    expect(useUiStore.getState().currentDocumentId).toBe('a')
    expect(useUiStore.getState().scene).toBe('read')
  })

  it('retries a failed parse from the row menu without a modal', async () => {
    const { container } = renderRail()
    const failedRow = container.querySelector<HTMLElement>('.ln-doc[data-status="failed"]')
    expect(failedRow).not.toBeNull()
    const menuTrigger = failedRow?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    click(menuTrigger)
    await flush()
    const retryItem = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
      (item.textContent ?? '').includes('rail.retryParse'),
    )
    click(retryItem)
    await flush()
    expect(client.callsOf('parse.start').length).toBe(1)
    expect(useUiStore.getState().dialog).toBe('none')
  })

  it('shows the empty-library invitation and its import action', () => {
    resetShellStores([])
    const { container } = renderRail()
    expect(container.querySelector('.ln-empty')).not.toBeNull()
    click(buttonByText(container, 'rail.import'))
    expect(useUiStore.getState().dialog).toBe('import')
  })

  it('shows a load error with a working reload action', async () => {
    resetShellStores([])
    useLibraryStore.setState({ loaded: false, loading: false, error: 'host offline' })
    const { container } = renderRail()
    expect(container.querySelector('.ln-rail__notice--error')).not.toBeNull()
    click(buttonByText(container, 'rail.retry'))
    await flush()
    expect(client.callsOf('library.list').length).toBeGreaterThanOrEqual(1)
  })

  it('renders in-flight upload rows', () => {
    const { container } = renderRail()
    act(() => {
      useImportController.setState({
        uploads: [
          {
            key: 'u1',
            name: 'big-paper.pdf',
            progress: 0.42,
            file: new File(['x'], 'big-paper.pdf'),
            parseOptions: null,
            state: 'uploading',
            error: null,
            guide: null,
          },
        ],
      })
    })
    const upload = container.querySelector('.ln-upload')
    expect(upload).not.toBeNull()
    expect(upload?.textContent).toContain('big-paper.pdf')
    expect(upload?.textContent).toContain('rail.uploading')
  })
})
