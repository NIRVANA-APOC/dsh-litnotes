/**
 * Real-plugin boot smoke test: imports the TypeScript composition root
 * (`src/host/index.ts`), mounts it with `apply(fakeCtx, {})` against an
 * in-memory Cordis context, exercises the registered HTTP handlers and then
 * disposes every effect.
 *
 * This is the Host-half pre-install smoke test: it catches import cycles,
 * missing `ctx.get()` services, wrong route registration and broken wiring that
 * unit tests of individual modules cannot see.
 *
 * `$DSH_HOME` is pointed at a fresh temp directory for the duration of each test
 * so `apply(ctx, {})` resolves its data dir there — the real user library is
 * never touched.
 *
 * Ported from the frozen 1.0.0 `test/e2e/boot.test.mjs` (2.0 response shapes).
 */

import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, test } from 'vitest'
import { expect } from 'vitest'

import { TOKEN_KEY } from '../../src/host/config.ts'
import type { PromptSection, WebRoute } from '../../src/host/host-services.ts'
import { apply, inject, name } from '../../src/host/index.ts'
import type { HostContext } from '../../src/host/host-services.ts'

const API = '/dsh-litnotes/api'

/** Cleanups registered by the current test. */
const cleanups: Array<() => Promise<void> | void> = []
const previousDshHome = process.env.DSH_HOME

afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

/** A fresh `$DSH_HOME` for one test. */
async function makeDshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-litnotes-boot-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** In-memory credentials service for the boot test. */
function makeCredentials(initial: Record<string, unknown> = {}) {
  const records = new Map<string, unknown>(Object.entries(initial))
  return {
    records,
    readRecord: async (key: string) => records.get(key),
    describeRecord: async (key: string) => ({ configured: records.has(key), kind: 'api-key', writable: true }),
    modifyRecord: async (key: string, mutate: (current: unknown) => Promise<unknown> | unknown) => {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return records.get(key)
    },
    deleteRecord: async (key: string) => {
      records.delete(key)
    },
  }
}

/** A registered route plus the fake's disposal bookkeeping. */
type FakeRoute = WebRoute & { disposed: boolean }

interface FakeEffect {
  label: string | undefined
  cleanup: (() => void) | undefined
  disposed: boolean
}

/** An in-memory Cordis-like plugin context. */
function makeCtx(services: Record<string, unknown> = {}) {
  const routes: FakeRoute[] = []
  const effects: FakeEffect[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    routes,
    effects,
    webServer: {
      register(route: WebRoute) {
        const fake = route as unknown as FakeRoute
        fake.disposed = false
        routes.push(fake)
        return () => {
          fake.disposed = true
          const index = routes.indexOf(fake)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: { requestRejection: () => undefined },
    get(serviceName: string) {
      return services[serviceName]
    },
    effect(callback: () => (() => void) | void, label?: string) {
      const effect: FakeEffect = { label, cleanup: undefined, disposed: false }
      effect.cleanup = callback() ?? undefined
      effects.push(effect)
      return () => {
        effect.disposed = true
      }
    },
  }
  // The platform context is structurally compatible; the cast documents the
  // deliberate structural fake at the Cordis boundary.
  return { ctx: ctx as unknown as HostContext, routes, effects }
}

/** A fake `systemPrompt` service recording registered sections. */
function makeSystemPrompt() {
  const sections: PromptSection[] = []
  const disposed: string[] = []
  const service = {
    section(section: PromptSection) {
      sections.push(section)
      return () => {
        disposed.push(section.name)
      }
    },
  }
  return { sections, disposed, service }
}

/** A fake request readable carrying `body`. */
function makeReq(options: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)])
  const fake = req as unknown as IncomingMessage & {
    method: string
    url: string
    headers: Record<string, string>
  }
  fake.method = options.method
  fake.url = options.url
  fake.headers = options.headers ?? {}
  return fake
}

/** A fake response that collects status, headers and the body. */
function makeRes() {
  const chunks: Buffer[] = []
  const res = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  }) as Writable & Record<string, unknown>
  res.statusCode = 0
  const headers: Record<string, string | number | readonly string[]> = {}
  res.headers = headers
  res.headersSent = false
  res.setHeader = (headerName: string, value: string | number | readonly string[]) => {
    headers[String(headerName).toLowerCase()] = value
    return res
  }
  res.getHeader = (headerName: string) => headers[String(headerName).toLowerCase()]
  return {
    response: res as unknown as ServerResponse,
    get statusCode() {
      return Number(res.statusCode)
    },
    body: () => Buffer.concat(chunks).toString('utf8'),
    json: () => {
      const text = Buffer.concat(chunks).toString('utf8')
      return JSON.parse(text) as Record<string, unknown>
    },
    done: () => (res.writableEnded === true ? Promise.resolve() : once(res, 'finish').then(() => undefined)),
  }
}

/** Run one JSON POST through the API prefix handler. */
async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  method: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify(payload ?? {})
  const req = makeReq({
    method: 'POST',
    url: `${API}/${method}`,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  })
  const res = makeRes()
  await handler(req, res.response)
  await res.done()
  return { status: res.statusCode, body: res.json() }
}

/** Poll until `predicate` is true (bounded). */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Extract the registered prefix route handler. */
function apiHandler(route: WebRoute | undefined): (req: IncomingMessage, res: ServerResponse) => void | Promise<void> {
  if (route === undefined || !('handler' in route)) throw new Error('API route not registered')
  return route.handler
}

test('apply() boots, serves the API route and disposes cleanly', async () => {
  const root = await makeDshHome()
  process.env.DSH_HOME = root

  expect(name).toBe('dsh-litnotes')
  expect(inject).toEqual(['webServer', 'connection'])

  const credentials = makeCredentials({ [TOKEN_KEY]: { kind: 'api-key', key: 'boot-test-token-12345' } })
  const { ctx, routes, effects } = makeCtx({ credentials })

  // --- apply: no throw, routes + effects registered -------------------------
  expect(() => apply(ctx, {})).not.toThrow()
  // The API prefix, the assets prefix and three exact NDJSON streaming routes.
  expect(routes.length).toBe(5)
  const api = routes.find((route) => route.path === API)
  const assets = routes.find((route) => route.path === '/dsh-litnotes/assets')
  expect(api).toBeTruthy()
  expect(assets).toBeTruthy()
  expect(api?.kind).toBe('prefix')
  expect(assets?.kind).toBe('prefix')
  for (const suffix of ['chat', 'graph.build', 'graph.library.rebuild']) {
    const stream = routes.find((route) => route.path === `${API}/${suffix}`)
    expect(stream?.kind).toBe('exact')
  }
  expect(effects.length).toBeGreaterThanOrEqual(3)

  // The boot effect initializes the library asynchronously under $DSH_HOME.
  const dataDir = join(root, 'litnotes')
  await waitFor(() => existsSync(join(dataDir, 'documents')), 'library initialization')

  // --- invoke the real HTTP handlers --------------------------------------
  const handler = apiHandler(api)
  const ping = await invoke(handler, 'health.ping', { clientVersion: 'boot-test', event: 'active' })
  expect(ping.status).toBe(200)
  const pingValue = ping.body.value as { ok: boolean; hostVersion: string; receivedAt: string }
  expect(ping.body.ok).toBe(true)
  expect(pingValue.ok).toBe(true)
  expect(pingValue.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(pingValue.hostVersion).toMatch(/\+host$/)

  const status = await invoke(handler, 'status', {})
  expect(status.status).toBe(200)
  const statusValue = status.body.value as {
    tokenConfigured: boolean
    counts: unknown
    ai: { available: boolean }
  }
  expect(statusValue.tokenConfigured).toBe(true)
  expect(statusValue.counts).toEqual({ total: 0, parsed: 0, parsing: 0, failed: 0 })
  expect(statusValue.ai.available).toBe(false)

  const library = await invoke(handler, 'library.list', {})
  expect(library.status).toBe(200)
  expect((library.body.value as { documents: unknown[] }).documents).toEqual([])

  // health.ping reached the diagnostics log inside the temp data dir.
  const diagnostics = await readFile(join(dataDir, 'diagnostics', 'client.log'), 'utf8')
  expect(diagnostics).toMatch(/boot-test/)

  // The token is not leaked by status.
  expect(JSON.stringify(status.body).includes('boot-test-token-12345')).toBe(false)

  // --- dispose every effect; route disposers must run ---------------------
  for (const effect of effects) {
    effect.disposed = true
    effect.cleanup?.()
  }
  await waitFor(() => routes.every((route) => route.disposed), 'route disposers')
  expect(routes.length).toBe(0)
  expect(effects.every((effect) => effect.disposed)).toBe(true)
})

test('apply() boots with no optional services available', async () => {
  const root = await makeDshHome()
  process.env.DSH_HOME = root

  // No credentials/translator/llm/tools in the profile: the plugin must still mount.
  const { ctx, routes, effects } = makeCtx({})
  expect(() => apply(ctx, {})).not.toThrow()

  const api = routes.find((route) => route.path === API)
  expect(api).toBeTruthy()
  await waitFor(() => existsSync(join(root, 'litnotes', 'documents')), 'library initialization')

  const handler = apiHandler(api)
  const status = await invoke(handler, 'status', {})
  expect(status.status).toBe(200)
  const statusValue = status.body.value as {
    tokenConfigured: boolean
    translatorAvailable: boolean
    modelAvailable: boolean
  }
  expect(statusValue.tokenConfigured).toBe(false)
  expect(statusValue.translatorAvailable).toBe(false)
  expect(statusValue.modelAvailable).toBe(false)

  // A feature that needs the missing services fails with a clean envelope.
  const translate = await invoke(handler, 'translate', { text: 'hello' })
  expect(translate.status).toBe(503)
  expect(translate.body.ok).toBe(false)
  expect((translate.body.error as { code: string }).code).toBe('translate-unavailable')

  for (const effect of effects) effect.cleanup?.()
  await waitFor(() => routes.every((route) => route.disposed), 'route disposers')
})

test('apply() respects an explicit dataDir from the row config', async () => {
  const root = await makeDshHome()
  const explicit = join(root, 'custom-library')
  const { ctx, routes, effects } = makeCtx({})
  expect(() => apply(ctx, { dataDir: explicit })).not.toThrow()
  await waitFor(() => existsSync(join(explicit, 'documents')), 'custom library initialization')
  for (const effect of effects) effect.cleanup?.()
  await waitFor(() => routes.every((route) => route.disposed), 'route disposers')
})

test('apply() registers the static library hint in the agent system prompt', async () => {
  const root = await makeDshHome()
  process.env.DSH_HOME = root
  const prompt = makeSystemPrompt()
  const { ctx, routes, effects } = makeCtx({ systemPrompt: prompt.service })

  expect(() => apply(ctx, {})).not.toThrow()
  // Exactly one compact, static section naming the tool family and coordinates.
  expect(prompt.sections.map((section) => section.name)).toEqual(['litnotes-library'])
  expect(prompt.sections[0]?.order).toBe(55)
  expect(prompt.sections[0]?.text).toContain('library_search')
  expect(prompt.sections[0]?.text).toContain('blockKey')
  expect(prompt.sections[0]?.text).toContain('library_manage')

  for (const effect of effects) effect.cleanup?.()
  await waitFor(() => routes.every((route) => route.disposed), 'route disposers')
  // The section is owned by an effect, so plugin disposal removes it.
  expect(prompt.disposed).toEqual(['litnotes-library'])
})
