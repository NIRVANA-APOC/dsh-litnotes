// @vitest-environment happy-dom
/**
 * Reparse/repair and document-dialog tests: fresh parse options, page-scoped
 * repair (`{merge:true,pages}` through the widened wire contract), rename and
 * delete wiring.
 */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShellDialogs } from '../../src/client/shell/Dialogs.tsx'
import type { DocumentMeta } from '../../src/shared/model.ts'
import { useLibraryStore } from '../../src/client/state/library.ts'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import {
  buttonByText,
  click,
  flush,
  installShellClient,
  makeDocument,
  makeDocumentMeta,
  makeSettings,
  makeStatus,
  resetShellStores,
  renderShell,
  typeInto,
  type ShellClient,
  type ShellRender,
} from './shell-helpers.tsx'

let client: ShellClient
let rendered: ShellRender | null = null

/** Detail payload whose last parse reported two unreadable pages. */
function repairableDetail(): DocumentMeta {
  const base = makeDocumentMeta(makeDocument('a', { title: 'Repairable Paper' }))
  return {
    ...base,
    status: 'parsed',
    parse: {
      ...(base.parse ?? {}),
      engine: 'standard',
      options: { engine: 'standard', modelVersion: 'vlm', language: 'ch', isOcr: true },
      repair: { pages: [2, 3], failedPages: [2, 3] },
    } as DocumentMeta['parse'],
  }
}

beforeEach(() => {
  resetShellStores([])
  useLibraryStore.setState({ status: makeStatus() })
  useSettingsStore.setState({ providers: makeSettings().providers, local: makeStatus().local })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useUiStore.setState({ dialog: 'none' })
})

describe('reparse dialog', () => {
  it('starts a fresh parse with the chosen engine for an unparsed document', async () => {
    const uploaded = makeDocument('u', { title: 'New Paper', status: 'uploaded', parse: null })
    client = installShellClient({ documents: [uploaded] })
    resetShellStores([uploaded])
    useUiStore.setState({ dialog: 'reparse', dialogTarget: 'u' })
    const view = renderShell(<ShellDialogs />)
    rendered = view
    await flush()
    click(buttonByText(view.container, 'parse.engine.local'))
    await flush()
    click(buttonByText(view.container, 'dlg.reparse.start'))
    await flush()
    const parses = client.callsOf('parse.start') as Array<{ id: string; options: { engine?: string } }>
    expect(parses.length).toBe(1)
    expect(parses[0]?.id).toBe('u')
    expect(parses[0]?.options.engine).toBe('local')
    expect(useUiStore.getState().dialog).toBe('none')
  })

  it('offers page-scoped repair and sends merge+pages through parse.start', async () => {
    const document = makeDocument('a', { title: 'Repairable Paper' })
    client = installShellClient({ documents: [document], detail: repairableDetail() })
    resetShellStores([document])
    useUiStore.setState({ dialog: 'reparse', dialogTarget: 'a' })
    const view = renderShell(<ShellDialogs />)
    rendered = view
    await flush()
    const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox?.checked).toBe(true)
    click(buttonByText(view.container, 'dlg.reparse.start'))
    await flush()
    const parses = client.callsOf('parse.start') as Array<{
      id: string
      options: { merge?: boolean; pages?: number[]; isOcr?: boolean }
    }>
    expect(parses.length).toBe(1)
    expect(parses[0]?.options.merge).toBe(true)
    expect(parses[0]?.options.pages).toEqual([2, 3])
  })
})

describe('document dialogs', () => {
  it('renames a document', async () => {
    const document = makeDocument('a', { title: 'Old Title' })
    client = installShellClient({ documents: [document] })
    resetShellStores([document])
    useUiStore.setState({ dialog: 'rename', dialogTarget: 'a' })
    const view = renderShell(<ShellDialogs />)
    rendered = view
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('#ln-rename-title')
    expect(input).not.toBeNull()
    if (input === null) return
    act(() => typeInto(input, 'New Title'))
    click(buttonByText(view.container, 'action.save'))
    await flush()
    expect(client.callsOf('library.update')).toEqual([{ id: 'a', title: 'New Title' }])
    expect(useUiStore.getState().dialog).toBe('none')
  })

  it('deletes a document after confirmation', async () => {
    const document = makeDocument('a', { title: 'Delete Me' })
    client = installShellClient({ documents: [document] })
    resetShellStores([document])
    useUiStore.setState({ dialog: 'delete', dialogTarget: 'a' })
    const view = renderShell(<ShellDialogs />)
    rendered = view
    await flush()
    expect(view.container.textContent).toContain('dlg.delete.body')
    click(buttonByText(view.container, 'dlg.delete.confirm'))
    await flush()
    expect(client.callsOf('library.remove')).toEqual([{ id: 'a' }])
  })
})
