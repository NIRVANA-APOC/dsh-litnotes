// @vitest-environment happy-dom
/**
 * Rail drag-resize tests: pointer and keyboard resizing within 200–400px,
 * persistence through `preferences.railWidth`, and default-width fallback.
 */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Rail } from '../../src/client/shell/Rail.tsx'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import {
  flush,
  installShellClient,
  makeDocument,
  resetShellStores,
  renderShell,
  type ShellClient,
  type ShellRender,
} from './shell-helpers.tsx'

const documents = [makeDocument('a', { title: 'Transformer Reading' })]

let rendered: ShellRender | null = null
let client: ShellClient

/** Dispatch a raw mouse event with pointer coordinates (happy-dom has no PointerEvent). */
function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
}

/** Render the rail and return its resizer handle + aside. */
function renderRail(): { view: ShellRender; handle: HTMLButtonElement; rail: HTMLElement } {
  rendered = renderShell(<Rail />)
  const handle = rendered.container.querySelector<HTMLButtonElement>('.ln-rail__resizer')
  const rail = rendered.container.querySelector<HTMLElement>('.ln-rail')
  if (handle === null || rail === null) throw new Error('rail or resizer missing')
  return { view: rendered, handle, rail }
}

beforeEach(() => {
  client = installShellClient({ documents })
  resetShellStores(documents)
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
})

describe('rail resize', () => {
  it('uses the stylesheet default until a custom width is remembered', () => {
    const { handle, rail } = renderRail()
    expect(rail.style.flexBasis).toBe('')
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-valuemin')).toBe('200')
    expect(handle.getAttribute('aria-valuemax')).toBe('400')
    expect(handle.getAttribute('aria-valuenow')).toBeNull()
  })

  it('applies a remembered width from preferences', () => {
    useSettingsStore.setState({ preferences: { ...useSettingsStore.getState().preferences, railWidth: 320 } })
    const { handle, rail } = renderRail()
    expect(rail.style.flexBasis).toBe('320px')
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
  })

  it('drags the edge, clamps and persists the width on release', async () => {
    const { handle, rail } = renderRail()
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', 264))
    })
    act(() => {
      window.dispatchEvent(pointer('pointermove', 264 + 80))
    })
    // Default (288) + 80 → 368.
    expect(rail.style.flexBasis).toBe('368px')
    act(() => {
      window.dispatchEvent(pointer('pointermove', 264 + 1000))
    })
    expect(rail.style.flexBasis).toBe('400px')
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1264))
    })
    await flush()
    const updates = client.callsOf('settings.update') as Array<{ preferences: { railWidth?: number } }>
    expect(updates.at(-1)?.preferences.railWidth).toBe(400)
    expect(useSettingsStore.getState().preferences.railWidth).toBe(400)
    expect(rail.style.flexBasis).toBe('400px')
  })

  it('supports keyboard resizing with a debounced preference write', async () => {
    const { handle, rail } = renderRail()
    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    // Default 288 + step 8.
    expect(rail.style.flexBasis).toBe('296px')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320))
    })
    const preferences = useSettingsStore.getState().preferences
    expect(preferences.railWidth).toBe(296)
  })

  it('resets to the default width on double-click', async () => {
    useSettingsStore.setState({ preferences: { ...useSettingsStore.getState().preferences, railWidth: 360 } })
    const { handle } = renderRail()
    expect(useSettingsStore.getState().preferences.railWidth).toBe(360)
    act(() => {
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await flush()
    expect(useSettingsStore.getState().preferences.railWidth).toBe(288)
  })
})
