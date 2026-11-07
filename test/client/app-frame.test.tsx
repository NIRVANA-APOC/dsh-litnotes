// @vitest-environment happy-dom
/**
 * Frame render test: the shell mounts against a fake Host client, loads the
 * stores, renders the empty desk and switches scenes without errors.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/client/shell/App.tsx'
import { setHostClient, type HostClient } from '../../src/client/api/client.ts'
import type {
  ApiMethod,
  ApiRequests,
  ApiResults,
  StreamMethod,
  StreamMethods,
} from '../../src/shared/protocol.ts'
import { DEFAULT_PREFERENCES } from '../../src/shared/preferences.ts'
import type { SettingsValue, StatusValue } from '../../src/shared/model.ts'

/** A fake host client answering the boot queries. */
function fakeClient(): HostClient {
  const settings: SettingsValue = {
    tokenConfigured: false,
    tokenPersistent: true,
    preferences: { ...DEFAULT_PREFERENCES },
    providers: [{ id: 'google', label: 'Google' }],
    defaults: {
      engine: 'auto',
      modelVersion: 'vlm',
      language: 'ch',
      targetLanguage: 'zh',
      translationProvider: 'auto',
      autoAllowAgentFallback: true,
      localProvider: 'auto',
    },
    local: {
      enabled: true,
      available: true,
      recommended: 'builtin',
      providers: [{ id: 'builtin', available: true, version: 'pdfjs-dist/5.4.449' }],
      capabilities: { textLayerPdf: true, office: false, images: false, html: false },
    },
  }
  const status: StatusValue = {
    version: '1.0.0',
    hostVersion: '1.0.0+host',
    dataDirDisplay: '~/.dsh/litnotes',
    tokenConfigured: false,
    tokenPersistent: true,
    translatorAvailable: true,
    modelAvailable: true,
    counts: { total: 0, parsed: 0, parsing: 0, failed: 0 },
    preferences: { ...DEFAULT_PREFERENCES },
    local: settings.local,
    ai: { available: true, graph: true, route: { provider: 'deepseek', model: 'deepseek-flash' }, retriever: true },
  }
  return {
    base: 'http://localhost/dsh-litnotes/api',
    async call<K extends ApiMethod>(method: K, _payload: ApiRequests[K]): Promise<ApiResults[K]> {
      if (method === 'settings.get') return settings as unknown as ApiResults[K]
      if (method === 'status') return status as unknown as ApiResults[K]
      if (method === 'library.list') return { documents: [] } as unknown as ApiResults[K]
      if (method === 'settings.update') {
        return { preferences: { ...DEFAULT_PREFERENCES } } as unknown as ApiResults[K]
      }
      throw new Error(`unexpected method ${method}`)
    },
    async stream<K extends StreamMethod>(_method: K, _request: StreamMethods[K]['request']): Promise<void> {
      throw new Error('stream not expected')
    },
    async upload() {
      throw new Error('upload not expected')
    },
    asset: (id, path) => `http://localhost/asset/${id}/${path}`,
    source: (id) => `http://localhost/source/${id}`,
    vendor: (path) => `http://localhost/vendor/${path}`,
    ping: () => {},
  }
}

const t = ((key: string) => key) as unknown as Parameters<typeof App>[0]['t']

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  setHostClient(fakeClient())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('reading desk frame', () => {
  it('mounts the shell and the empty desk from the Host stores', async () => {
    await act(async () => {
      root.render(<App t={t} />)
    })
    // Let the boot promises settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const shell = container.querySelector('.ln-root')
    expect(shell).not.toBeNull()
    expect(shell?.getAttribute('data-scene')).toBe('read')
    expect(container.querySelector('.ln-topbar')).not.toBeNull()
    expect(container.querySelector('.ln-rail')).not.toBeNull()
    expect(container.querySelector('.ln-statusbar')).not.toBeNull()
    expect(container.querySelector('.ln-empty')).not.toBeNull()
    expect(container.querySelectorAll('.ln-topbar .ln-seg__item').length).toBe(2)
  })

  it('switches scene from the fixed top-bar segmented control', async () => {
    await act(async () => {
      root.render(<App t={t} />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const graphButton = [...container.querySelectorAll<HTMLButtonElement>('.ln-topbar .ln-seg__item')].find((button) =>
      button.textContent?.includes('scene.graph'),
    )
    expect(graphButton).toBeDefined()
    await act(async () => {
      graphButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('.ln-root')?.getAttribute('data-scene')).toBe('graph')
  })
})
