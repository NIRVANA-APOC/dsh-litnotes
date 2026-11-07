/**
 * Artifact smoke tests: the generated bundles must load in the exact shapes
 * the Harness uses — the Host as an ESM plugin module, the Client as a
 * `window.__ModuleLoader__` factory whose `clientMain()` returns the plugin.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function buildOnce(): void {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.ts')], { cwd: ROOT, stdio: 'pipe' })
}

/** One row captured from `window.__ModuleLoader__.load(...)`. */
interface LoaderRow {
  id: string
  factory: (require: (id: string) => unknown) => unknown
}

/** Evaluate the client bundle in a fake browser module-loader shell. */
function loadClientRow(): LoaderRow {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const rows: LoaderRow[] = []
  const window = { __ModuleLoader__: { load: (row: LoaderRow) => rows.push(row) } }
  vm.runInNewContext(source, {
    window,
    console,
    URL,
    URLSearchParams,
    AbortSignal,
    TextDecoder,
    Intl,
    setTimeout,
    clearTimeout,
  })
  const row = rows[0]
  if (row === undefined) throw new Error('client bundle registered no module row')
  return row
}

/** Build the plugin object the way the Harness loader materializes the module. */
async function materializeClient(): Promise<{ inject?: string[]; apply: (ctx: unknown) => void }> {
  const row = loadClientRow()
  const react: unknown = await import('react')
  const plugin = row.factory((id: string) => {
    if (id === 'react') return react
    throw new Error(`unexpected module request: ${id}`)
  }) as { inject?: string[]; apply: (ctx: unknown) => void }
  return plugin
}

/** Minimal fake Client context that records registrations. */
function fakeClientContext() {
  const effects: string[] = []
  const registered: Array<{ name: string; options: Record<string, unknown> }> = []
  const ctx = {
    effect(callback: () => (() => void) | void, label?: string): () => void {
      effects.push(label ?? 'effect')
      callback()
      return () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject(_key: string, callback: () => unknown) {
        return callback()
      },
      register(options: Record<string, unknown>) {
        registered.push({ name: String(options.name), options })
        return () => {}
      },
    },
  }
  return { ctx, effects, registered }
}

/** Minimal fake Host context that records route registrations. */
function fakeHostContext() {
  const routes: Array<{ kind: string; path: string }> = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(callback: () => (() => void) | void) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(route: { kind: string; path: string }) {
        routes.push(route)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    get: () => undefined,
  }
  return { ctx, routes }
}

beforeAll(() => {
  buildOnce()
})

describe('client bundle artifact', () => {
  it('registers the module row and returns the plugin object', async () => {
    const row = loadClientRow()
    expect(row.id).toBe('dsh-litnotes')
    const plugin = await materializeClient()
    expect(plugin.inject).toEqual(['slots', 'locale', 'layout'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('registers the sidebar panel and the keyed main panel', async () => {
    const plugin = await materializeClient()
    const { ctx, effects, registered } = fakeClientContext()
    plugin.apply(ctx)
    expect(effects.length).toBeGreaterThanOrEqual(3)
    expect(registered.map((entry) => entry.name)).toEqual(['sidebar.panellist', 'main'])
    expect(registered[0]?.options.id).toBe('litnotes')
    expect(registered[1]?.options.key).toBe('litnotes')
  })
})

describe('host bundle artifact', () => {
  it('exports the Cordis plugin identity and apply()', async () => {
    const module = (await import(pathToFileURL(join(ROOT, 'index.js')).href)) as {
      name?: string
      inject?: string[]
      apply?: unknown
      HOST_VERSION?: string
    }
    expect(module.name).toBe('dsh-litnotes')
    expect(module.inject).toEqual(['webServer', 'connection'])
    expect(typeof module.apply).toBe('function')
    expect(module.HOST_VERSION).toMatch(/^2\.0\.0\+host$/)
  })

  it('registers the API and asset routes through the web-server effect', async () => {
    const module = (await import(pathToFileURL(join(ROOT, 'index.js')).href)) as {
      apply: (ctx: unknown, config?: Record<string, unknown>) => void
    }
    const { ctx, routes } = fakeHostContext()
    module.apply(ctx, {})
    const paths = routes.map((route) => route.path)
    expect(paths).toContain('/dsh-litnotes/api')
    expect(paths).toContain('/dsh-litnotes/assets')
    expect(paths).toContain('/dsh-litnotes/api/chat')
  })
})
