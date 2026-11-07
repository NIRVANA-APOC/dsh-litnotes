// @vitest-environment happy-dom
/**
 * Import flow tests: URL validation + guidance, dropped-file preloading,
 * unsupported-extension filtering, token warning and the upload controller
 * (progress row → library refresh → parse with the chosen options).
 */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShellDialogs } from '../../src/client/shell/Dialogs.tsx'
import { useImportController } from '../../src/client/shell/library/import-controller.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import { ApiError } from '../../src/client/api/client.ts'
import { describeImportFailure } from '../../src/client/shell/library/import-errors.ts'
import {
  buttonByText,
  click,
  flush,
  installShellClient,
  resetShellStores,
  renderShell,
  tIdentity,
  typeInto,
  type ShellClient,
  type ShellRender,
} from './shell-helpers.tsx'

let client: ShellClient
let rendered: ShellRender | null = null

/** Open the import dialog and render the shell dialogs. */
function renderImport(): ShellRender {
  useUiStore.setState({ dialog: 'import' })
  rendered = renderShell(<ShellDialogs />)
  return rendered
}

beforeEach(() => {
  client = installShellClient({})
  resetShellStores([])
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useUiStore.setState({ dialog: 'none' })
})

describe('import dialog', () => {
  it('rejects an invalid URL inline and never calls the Host', async () => {
    const { container } = renderImport()
    const urlInput = container.querySelector<HTMLInputElement>('.ln-import__urlRow input')
    expect(urlInput).not.toBeNull()
    if (urlInput === null) return
    act(() => typeInto(urlInput, 'not-a-url'))
    click(buttonByText(container, 'dlg.import.urlSubmit'))
    await flush()
    // The message text is parameterised through t(); assert the guided callout.
    expect(container.querySelector('.ln-callout--error')).not.toBeNull()
    expect(container.textContent).toContain('err.importUrlFailed')
    expect(client.callsOf('library.importUrl').length).toBe(0)
  })

  it('imports a valid URL and starts parsing with the chosen options', async () => {
    const { container } = renderImport()
    const urlInput = container.querySelector<HTMLInputElement>('.ln-import__urlRow input')
    if (urlInput === null) return
    act(() => typeInto(urlInput, 'https://example.com/paper.pdf'))
    click(buttonByText(container, 'dlg.import.urlSubmit'))
    await flush()
    const imports = client.callsOf('library.importUrl')
    expect(imports.length).toBe(1)
    expect(imports[0]).toEqual({ url: 'https://example.com/paper.pdf' })
    const parses = client.callsOf('parse.start') as Array<{ id: string; options: { engine?: string } }>
    expect(parses.length).toBe(1)
    expect(parses[0]?.options.engine).toBe('auto')
    expect(useUiStore.getState().dialog).toBe('none')
  })

  it('preloads files dropped on the desk before the dialog opened', async () => {
    act(() => {
      useUiStore.getState().queueImportFiles([new File(['pdf'], 'dropped-paper.pdf')])
    })
    const view = renderShell(<ShellDialogs />)
    rendered = view
    await flush()
    const fileRow = view.container.querySelector('.ln-import__file')
    expect(fileRow).not.toBeNull()
    expect(fileRow?.textContent).toContain('dropped-paper.pdf')
  })

  it('filters unsupported extensions with an explanatory callout', async () => {
    act(() => {
      useUiStore.getState().queueImportFiles([new File(['text'], 'notes.txt')])
    })
    const view = renderShell(<ShellDialogs />)
    rendered = view
    await flush()
    expect(view.container.querySelector('.ln-import__file')).toBeNull()
    expect(view.container.textContent).toContain('dlg.import.unsupported')
  })

  it('warns that precise parsing needs a token', async () => {
    const { container } = renderImport()
    const standard = buttonByText(container, 'parse.engine.standard')
    click(standard)
    await flush()
    expect(container.textContent).toContain('dlg.import.tokenWarn')
  })
})

describe('import error guidance', () => {
  it('maps wire codes to a concrete next step', () => {
    const token = describeImportFailure(new ApiError('token-missing', 'hidden'), tIdentity)
    expect(token.hint).toBe('err.tokenMissing')
    expect(token.retryable).toBe(false)
    const local = describeImportFailure(new ApiError('local-unsupported', 'hidden'), tIdentity)
    expect(local.hint).toBe('err.localUnsupported')
    const large = describeImportFailure(new ApiError('too-large', 'hidden'), tIdentity)
    expect(large.hint).toBe('err.tooLarge')
    const network = describeImportFailure(new ApiError('network', 'hidden'), tIdentity)
    expect(network.message).toBe('err.network')
    expect(network.retryable).toBe(true)
  })
})

describe('import controller', () => {
  it('uploads, refreshes the library and dispatches the parse with options', async () => {
    await act(async () => {
      await useImportController
        .getState()
        .importFiles([new File(['pdf'], 'fresh.pdf')], { engine: 'local' }, tIdentity)
    })
    expect(client.callsOf('upload')).toEqual(['fresh.pdf'])
    expect(client.callsOf('library.list').length).toBeGreaterThanOrEqual(1)
    const parses = client.callsOf('parse.start') as Array<{ id: string; options: { engine?: string } }>
    expect(parses.length).toBe(1)
    expect(parses[0]?.options.engine).toBe('local')
    expect(useImportController.getState().uploads).toHaveLength(0)
  })

  it('keeps a failed upload row with guidance and a retry', async () => {
    client = installShellClient({ upload: null })
    useImportController.setState({ uploads: [] })
    resetShellStores([])
    await act(async () => {
      await useImportController.getState().importFiles([new File(['pdf'], 'broken.pdf')], null, tIdentity)
    })
    const uploads = useImportController.getState().uploads
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.state).toBe('failed')
    expect(useUiStore.getState().toasts.length).toBeGreaterThanOrEqual(1)
    expect(useUiStore.getState().toasts[0]?.tone).toBe('error')
  })

  it('remembers the last parse choices through preferences on submit', async () => {
    act(() => {
      useUiStore.getState().queueImportFiles([new File(['pdf'], 'fresh.pdf')])
    })
    const view = renderShell(<ShellDialogs />)
    rendered = view
    await flush()
    click(buttonByText(view.container, 'parse.engine.local'))
    await flush()
    click(buttonByText(view.container, 'dlg.import.start'))
    await flush()
    const updates = client.callsOf('settings.update') as Array<{ preferences: { defaultEngine?: string } }>
    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates[0]?.preferences.defaultEngine).toBe('local')
  })
})
