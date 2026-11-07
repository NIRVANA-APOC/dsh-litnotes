// @vitest-environment happy-dom
/**
 * Settings dialog tests: section rendering, preference persistence through
 * `settings.update`, MinerU token save/clear and capability-driven disabling.
 */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShellDialogs } from '../../src/client/shell/Dialogs.tsx'
import { useLibraryStore } from '../../src/client/state/library.ts'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import {
  buttonByText,
  click,
  flush,
  installShellClient,
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

/** Render the shell dialogs with the settings sheet open. */
function renderSettings(): ShellRender {
  useUiStore.setState({ dialog: 'settings' })
  rendered = renderShell(<ShellDialogs />)
  return rendered
}

beforeEach(() => {
  client = installShellClient({})
  resetShellStores([])
  useLibraryStore.setState({ status: makeStatus() })
  useSettingsStore.setState({
    providers: makeSettings().providers,
    local: makeStatus().local,
    tokenConfigured: false,
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useUiStore.setState({ dialog: 'none' })
})

describe('settings dialog', () => {
  it('renders every section and the about facts', () => {
    const { container } = renderSettings()
    const text = container.textContent ?? ''
    for (const key of ['set.title', 'set.nav.parse', 'set.nav.translate', 'set.nav.ai', 'set.nav.appearance', 'set.nav.about']) {
      expect(text).toContain(key)
    }
    expect(text).toContain('set.token')
    expect(text).toContain('set.targetLang')
    expect(text).toContain('set.graphAutoBuild')
    expect(text).toContain('set.entailmentNotice')
    expect(text).toContain('set.themeFollow')
    expect(text).toContain('2.0.0')
    expect(text).toContain('~/.dsh/litnotes')
    expect(text).toContain('pdfjs-dist/5.4.449')
  })

  it('persists the auto graph-build toggle through settings.update', async () => {
    const { container } = renderSettings()
    const graphSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="set.graphAutoBuild"]')
    expect(graphSwitch?.disabled).toBe(false)
    click(graphSwitch)
    await flush()
    const updates = client.callsOf('settings.update') as Array<{ preferences: { graphAutoBuild?: boolean } }>
    expect(updates.length).toBe(1)
    expect(updates[0]?.preferences.graphAutoBuild).toBe(true)
  })

  it('persists the entailment-notice toggle through settings.update', async () => {
    const { container } = renderSettings()
    const noticeSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="set.entailmentNotice"]')
    click(noticeSwitch)
    await flush()
    const updates = client.callsOf('settings.update') as Array<{ preferences: { entailmentNotice?: boolean } }>
    expect(updates.length).toBe(1)
    expect(updates[0]?.preferences.entailmentNotice).toBe(false)
  })

  it('updates the translation target language', async () => {
    const { container } = renderSettings()
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="set.targetLang"]')
    expect(select).not.toBeNull()
    if (select === null) return
    act(() => {
      select.value = 'en'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    const updates = client.callsOf('settings.update') as Array<{ preferences: { targetLanguage?: string } }>
    expect(updates.length).toBe(1)
    expect(updates[0]?.preferences.targetLanguage).toBe('en')
  })

  it('saves a MinerU token through the credentials-backed action', async () => {
    const { container } = renderSettings()
    const input = container.querySelector<HTMLInputElement>('input[type="password"][aria-label="set.token"]')
    expect(input).not.toBeNull()
    if (input === null) return
    act(() => typeInto(input, 'mineru-token-123'))
    click(buttonByText(container, 'set.tokenSave'))
    await flush()
    expect(client.callsOf('settings.setToken')).toEqual([{ token: 'mineru-token-123' }])
  })

  it('disables auto graph build when the graph engine is unavailable', () => {
    useLibraryStore.setState({
      status: makeStatus({ ai: { available: false, graph: false, route: null, retriever: false, reason: 'no model' } }),
    })
    const { container } = renderSettings()
    const graphSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="set.graphAutoBuild"]')
    expect(graphSwitch?.disabled).toBe(true)
    expect(container.textContent).toContain('set.aiUnavailable')
  })
})
