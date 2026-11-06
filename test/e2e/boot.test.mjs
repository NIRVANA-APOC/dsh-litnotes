/**
 * Real-plugin boot test: imports the actual `index.js`, mounts it with
 * `apply(fakeCtx, {})` against an in-memory Cordis context, exercises the
 * registered HTTP handlers and then disposes every effect.
 *
 * This is the pre-install smoke test for the Host half: it catches import
 * cycles, missing `ctx.get()` services, wrong route registration and broken
 * wiring that unit tests of individual modules cannot see.
 *
 * `$DSH_HOME` is pointed at a fresh temp directory for the duration of the test
 * so `apply(ctx, {})` resolves its data dir there — the real user library is
 * never touched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_KEY } from '../../lib/config.js'
import {
  createFakeCredentials,
  createFakeCtx,
  createFakeRequest,
  createFakeResponse,
  responseJson,
  waitFor,
} from './helpers.mjs'

const API = '/dsh-litnotes/api'

/** Run one JSON POST through a fake req/res pair. */
async function invoke(handler, method, payload) {
  const body = JSON.stringify(payload ?? {})
  const req = createFakeRequest({
    method: 'POST',
    url: `${API}/${method}`,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  })
  const res = createFakeResponse()
  await handler(req, res)
  return { status: res.state.statusCode, body: responseJson(res), res }
}

test('index.js apply() boots, serves the API route and disposes cleanly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-litnotes-boot-'))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await rm(root, { recursive: true, force: true })
  })

  const plugin = await import('../../index.js')
  assert.equal(plugin.name, 'dsh-litnotes')
  assert.deepEqual(plugin.inject, ['webServer', 'connection'])
  assert.equal(typeof plugin.apply, 'function')

  const credentials = createFakeCredentials({
    [TOKEN_KEY]: { kind: 'api-key', key: 'boot-test-token-12345' },
  })
  const ctx = createFakeCtx({ get: { credentials } })

  // --- apply: no throw, routes + effects registered -------------------------
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
  assert.equal(ctx.routes.length, 2, 'exactly the api + assets prefix routes are registered')
  const api = ctx.routes.find((route) => route.path === API)
  const assets = ctx.routes.find((route) => route.path === '/dsh-litnotes/assets')
  assert.ok(api !== undefined, `${API} route registered`)
  assert.ok(assets !== undefined, 'assets route registered')
  assert.equal(api.kind, 'prefix')
  assert.equal(assets.kind, 'prefix')
  assert.equal(typeof api.handler, 'function')
  assert.ok(ctx.effects.length >= 3, 'boot, routes and agent-tool effects registered')

  // The boot effect initializes the library asynchronously under $DSH_HOME.
  const dataDir = join(root, 'litnotes')
  await waitFor(() => existsSync(join(dataDir, 'documents')), { label: 'library initialization' })

  // --- invoke the real HTTP handlers --------------------------------------
  const ping = await invoke(api.handler, 'health.ping', { clientVersion: 'boot-test', event: 'active' })
  assert.equal(ping.status, 200)
  assert.equal(ping.body.ok, true)
  assert.equal(ping.body.value.ok, true)
  assert.match(ping.body.value.receivedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(ping.body.value.hostVersion, /\+host$/)

  const status = await invoke(api.handler, 'status', {})
  assert.equal(status.status, 200)
  assert.equal(status.body.ok, true)
  assert.equal(status.body.value.tokenConfigured, true)
  assert.equal(status.body.value.configured.token, true)
  assert.deepEqual(status.body.value.counts, { total: 0, parsed: 0, parsing: 0, failed: 0 })

  const library = await invoke(api.handler, 'library.list', {})
  assert.equal(library.status, 200)
  assert.deepEqual(library.body.value.documents, [])

  // health.ping reached the diagnostics log inside the temp data dir.
  const diagnostics = await readFile(join(dataDir, 'diagnostics', 'client.log'), 'utf8')
  assert.match(diagnostics, /boot-test/)

  // The token is not leaked by status (the credential store value never crosses the API).
  assert.equal(JSON.stringify(status.body).includes('boot-test-token-12345'), false)

  // --- dispose every effect; route disposers must run ---------------------
  for (const effect of ctx.effects) {
    effect.disposed = true
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
  await waitFor(() => ctx.routes.every((route) => route.disposed === true), {
    label: 'route disposers',
  })
  assert.ok(ctx.routes.every((route) => route.disposed), 'both routes were unregistered')
  assert.ok(ctx.effects.every((effect) => effect.disposed === true), 'every effect cleanup ran')
})

test('index.js boots with no optional services available', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-litnotes-boot-min-'))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await rm(root, { recursive: true, force: true })
  })

  const plugin = await import('../../index.js')
  // No credentials/translator/llm/tools in the profile: the plugin must still mount.
  const ctx = createFakeCtx({ get: {} })
  assert.doesNotThrow(() => plugin.apply(ctx, {}))

  const api = ctx.routes.find((route) => route.path === API)
  assert.ok(api)
  await waitFor(() => existsSync(join(root, 'litnotes', 'documents')), { label: 'library initialization' })

  const status = await invoke(api.handler, 'status', {})
  assert.equal(status.status, 200)
  assert.equal(status.body.value.tokenConfigured, false)
  assert.equal(status.body.value.configured.translator, false)
  assert.equal(status.body.value.configured.model, false)

  // A feature that needs the missing services fails with a clean envelope.
  const translate = await invoke(api.handler, 'translate', { text: 'hello' })
  assert.equal(translate.status, 503)
  assert.equal(translate.body.ok, false)
  assert.equal(translate.body.error.code, 'translate-unavailable')

  for (const effect of ctx.effects) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
  await waitFor(() => ctx.routes.every((route) => route.disposed === true), { label: 'route disposers' })
})
