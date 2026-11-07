// @vitest-environment happy-dom
/**
 * Responsive rail tests: below 820px the rail is an overlay drawer with a
 * scrim, starts closed, and Escape closes it.
 */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '../../src/client/shell/Rail.tsx'
import { useUiStore } from '../../src/client/state/ui.ts'
import {
  flush,
  installShellClient,
  makeDocument,
  resetShellStores,
  renderShell,
  type ShellRender,
} from './shell-helpers.tsx'

/** A wider `matchMedia` stub: only max-width rules below 820px report a match. */
function mockNarrowViewport(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string): MediaQueryList => {
    const matches = query.includes('max-width: 820px')
    const list = {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
    return list as unknown as MediaQueryList
  })
}

let rendered: ShellRender | null = null

const documents = [makeDocument('a', { title: 'Transformer Reading' })]

beforeEach(() => {
  mockNarrowViewport()
  installShellClient({ documents })
  resetShellStores(documents)
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
})

describe('responsive rail drawer', () => {
  it('starts closed on a narrow viewport (icon strip hidden by CSS)', async () => {
    rendered = renderShell(<Rail />)
    await flush()
    expect(useUiStore.getState().railCollapsed).toBe(true)
    expect(rendered.container.querySelector('.ln-rail--collapsed')).not.toBeNull()
    expect(rendered.container.querySelector('.ln-rail__scrim')).toBeNull()
  })

  it('shows the drawer with a scrim when opened, and Escape closes it', async () => {
    rendered = renderShell(<Rail />)
    await flush()
    act(() => useUiStore.setState({ railCollapsed: false }))
    await flush()
    const view = rendered.container
    expect(view.querySelector('.ln-rail__scrim')).not.toBeNull()
    expect(view.querySelector('.ln-rail[data-drawer="true"]')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(useUiStore.getState().railCollapsed).toBe(true)
    expect(view.querySelector('.ln-rail__scrim')).toBeNull()
  })

  it('closes the drawer when the scrim is clicked', async () => {
    rendered = renderShell(<Rail />)
    await flush()
    act(() => useUiStore.setState({ railCollapsed: false }))
    await flush()
    act(() => {
      rendered?.container
        .querySelector('.ln-rail__scrim')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(useUiStore.getState().railCollapsed).toBe(true)
  })
})
