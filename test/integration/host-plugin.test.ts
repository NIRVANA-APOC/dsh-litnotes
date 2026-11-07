/**
 * Host plugin integration test: build the real Host bundle, mount it on a fake
 * Cordis context and exercise the real HTTP routes through the frozen envelope
 * contract. This proves the composition root (config → store → parse manager →
 * AI bundle → service → routes/tools) without a DSH process.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

/** One registered route (only the shapes this plugin uses). */
interface RegisteredRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: FakeResponse) => void | Promise<void>
}

/** Minimal ServerResponse double that records status/headers/body. */
class FakeResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string | number> = {}
  body = ''
  headersSent = false
  writableEnded = false
  ended = false
  writable = true
  destroyed = false

  constructor() {
    super()
    this.setMaxListeners(0)
  }

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = value
    return this
  }

  flushHeaders(): void {
    this.headersSent = true
  }

  write(chunk: string | Buffer): boolean {
    this.headersSent = true
    this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    return true
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.write(chunk)
    this.headersSent = true
    this.writableEnded = true
    this.ended = true
  }

  destroy(): void {
    this.writableEnded = true
    this.destroyed = true
  }

  json(): unknown {
    return JSON.parse(this.body)
  }
}

/** Build a request double from a method, URL and raw body. */
function makeRequest(method: string, url: string, body?: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  return Object.assign(stream, {
    method,
    url,
    headers: { 'content-length': body === undefined ? '0' : String(Buffer.byteLength(body)), ...headers },
  }) as unknown as IncomingMessage
}

interface FakeContext {
  ctx: unknown
  routes: RegisteredRoute[]
  fence: { reject: boolean }
  toolNames: string[]
  effects: number
  logger: { info: () => void; warn: () => void; error: () => void; debug: () => void }
}

/** Mount the built plugin on a fake host context. */
async function mountPlugin(): Promise<FakeContext> {
  const routes: RegisteredRoute[] = []
  const toolNames: string[] = []
  const fence = { reject: false }
  const state = { effects: 0 }
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const ctx = {
    logger,
    effect: (callback: () => (() => void) | void) => {
      state.effects += 1
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: (serviceName: string) => {
      if (serviceName === 'tools') {
        return {
          register: (definition: { name: string }) => {
            toolNames.push(definition.name)
            return () => {}
          },
        }
      }
      return undefined
    },
    webServer: {
      register: (route: RegisteredRoute) => {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection: () => (fence.reject ? 403 : undefined),
    },
  }
  const module = (await import(pathToFileURL(join(ROOT, 'index.js')).href)) as {
    apply: (ctx: unknown, config?: Record<string, unknown>) => void
  }
  module.apply(ctx, {})
  return {
    ctx,
    routes,
    fence,
    toolNames,
    effects: state.effects,
    logger,
  } as unknown as FakeContext
}

const tempHome = mkdtempSync(join(tmpdir(), 'litnotes-host-test-'))

beforeAll(() => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.ts')], { cwd: ROOT, stdio: 'pipe' })
})

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

/** POST one JSON API method through the registered prefix route. */
async function callApi(
  mounted: FakeContext,
  method: string,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; envelope: unknown }> {
  const route = mounted.routes.find((entry) => entry.path === '/dsh-litnotes/api' && entry.kind === 'prefix')
  if (route === undefined) throw new Error('api prefix route not registered')
  const res = new FakeResponse()
  await route.handler(makeRequest('POST', `/dsh-litnotes/api/${method}`, JSON.stringify(payload)), res)
  return { status: res.statusCode, envelope: res.json() }
}

describe('host plugin composition', () => {
  beforeAll(() => {
    vi.stubEnv('DSH_HOME', tempHome)
  })

  it('registers the api + asset routes, tools and boot effects', async () => {
    const mounted = await mountPlugin()
    expect(mounted.effects).toBeGreaterThanOrEqual(3)
    expect(mounted.routes.some((route) => route.path === '/dsh-litnotes/api')).toBe(true)
    expect(mounted.toolNames).toHaveLength(7)
    expect(mounted.toolNames).toContain('library_search')
    expect(mounted.toolNames).toContain('library_manage')
    // The store initializes asynchronously; one request awaits the same init promise.
    await callApi(mounted, 'status')
    expect(statSync(join(tempHome, 'litnotes')).isDirectory()).toBe(true)
  })

  it('answers status with the frozen shape', async () => {
    const mounted = await mountPlugin()
    const { status, envelope } = await callApi(mounted, 'status')
    expect(status).toBe(200)
    const typed = envelope as { ok: true; value: Record<string, unknown> }
    expect(typed.ok).toBe(true)
    expect(typed.value.version).toBe(`${PACKAGE_VERSION}+host`)
    expect(typed.value.hostVersion).toBe(`${PACKAGE_VERSION}+host`)
    expect(typed.value.counts).toEqual({ total: 0, parsed: 0, parsing: 0, failed: 0 })
    expect(typed.value.preferences).toMatchObject({ readingMode: 'original', targetLanguage: 'zh' })
    expect(typed.value.ai).toMatchObject({ available: false })
  })

  it('answers library.list and health.ping', async () => {
    const mounted = await mountPlugin()
    const list = await callApi(mounted, 'library.list')
    expect((list.envelope as { value: { documents: unknown[] } }).value.documents).toEqual([])
    const ping = await callApi(mounted, 'health.ping', { event: 'test' })
    expect((ping.envelope as { value: { hostVersion: string } }).value.hostVersion).toBe(`${PACKAGE_VERSION}+host`)
  })

  it('rejects unknown methods with the not-found envelope', async () => {
    const mounted = await mountPlugin()
    const { status, envelope } = await callApi(mounted, 'nope.nope')
    expect(status).toBe(404)
    expect((envelope as { error: { code: string } }).error.code).toBe('not-found')
  })

  it('enforces the POST-only method contract', async () => {
    const mounted = await mountPlugin()
    const route = mounted.routes.find((entry) => entry.path === '/dsh-litnotes/api')
    if (route === undefined) throw new Error('api prefix route not registered')
    const res = new FakeResponse()
    await route.handler(makeRequest('GET', '/dsh-litnotes/api/status'), res)
    expect(res.statusCode).toBe(405)
    expect((res.json() as { error: { code: string } }).error.code).toBe('method-not-allowed')
  })

  it('enforces the connection fence', async () => {
    const mounted = await mountPlugin()
    mounted.fence.reject = true
    const { status, envelope } = await callApi(mounted, 'status')
    expect(status).toBe(403)
    expect((envelope as { error: { code: string } }).error.code).toBe('forbidden')
  })

  it('rejects an upload without the file-name header', async () => {
    const mounted = await mountPlugin()
    const route = mounted.routes.find((entry) => entry.path === '/dsh-litnotes/api')
    if (route === undefined) throw new Error('api prefix route not registered')
    const res = new FakeResponse()
    await route.handler(makeRequest('POST', '/dsh-litnotes/api/upload', ''), res)
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('bad-request')
  })

  it('rejects oversized JSON bodies', async () => {
    const mounted = await mountPlugin()
    const route = mounted.routes.find((entry) => entry.path === '/dsh-litnotes/api')
    if (route === undefined) throw new Error('api prefix route not registered')
    const res = new FakeResponse()
    const huge = `{"x":"${'a'.repeat(2 * 1024 * 1024 + 10)}"}`
    await route.handler(makeRequest('POST', '/dsh-litnotes/api/status', huge), res)
    expect(res.statusCode).toBe(413)
    expect((res.json() as { error: { code: string } }).error.code).toBe('too-large')
  })

  it('serves vendored assets from the package vendor directory', async () => {
    const mounted = await mountPlugin()
    const route = mounted.routes.find((entry) => entry.path === '/dsh-litnotes/assets')
    if (route === undefined) throw new Error('asset prefix route not registered')
    const res = new FakeResponse()
    await route.handler(makeRequest('GET', '/dsh-litnotes/assets/katex/katex.min.css'), res)
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'] ?? '')).toContain('css')
    expect(res.body.length).toBeGreaterThan(0)
    expect(res.body).toBe(readFileSync(join(ROOT, 'vendor', 'katex', 'katex.min.css'), 'utf8'))
  })
})
