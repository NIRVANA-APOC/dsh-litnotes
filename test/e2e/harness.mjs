/**
 * End-to-end harness: a real Host stack (store + parse manager + service) wired
 * to the mock MinerU server and a temp data directory.
 *
 * Every resource is closed in one `t.after` hook in dependency order. Tests use
 * a tiny `pollIntervalMs` (10 ms) so parse flows finish in milliseconds, and
 * every wait is bounded via `waitFor` — no unbounded polling.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../lib/store.js'
import { createParseManager } from '../../lib/parse-manager.js'
import { createService } from '../../lib/service.js'
import { TOKEN_KEY, clearToken, getToken, resolveConfig } from '../../lib/config.js'
import { startMockMineru } from '../mock-mineru.mjs'
import {
  createFakeCredentials,
  createFakeTranslator,
  createLogger,
  pdfBytes,
  standardResultZip,
} from './helpers.mjs'

/**
 * @param {import('node:test').TestContext} t
 * @param {{
 *   token?: string | null,
 *   translator?: 'fake' | null,
 *   mock?: object,
 *   config?: object,
 *   localEngine?: object,
 * }} [options]
 */
export async function createHarness(t, options = {}) {
  const {
    token = 'e2e-token-1234',
    translator = 'fake',
    mock: mockOptions = {},
    config: configOverrides = {},
    localEngine,
  } = options
  const root = await mkdtemp(join(tmpdir(), 'dsh-litnotes-e2e-'))
  const mock = await startMockMineru({
    token: token ?? 'no-token-configured',
    zip: standardResultZip(),
    standardStates: ['waiting-file', 'pending', 'running', 'converting', 'done'],
    agentStates: ['pending', 'running', 'done'],
    ...mockOptions,
  })
  const logger = createLogger()
  const config = resolveConfig({
    dataDir: join(root, 'data'),
    apiBase: mock.url,
    pollIntervalMs: 10,
    parseTimeoutMs: 8000,
    maxUploadBytes: 4 * 1024 * 1024,
    maxConcurrentParses: 2,
    ...configOverrides,
  })
  const store = createStore({ dataDir: config.dataDir, logger })
  await store.init()
  // The credential store is the source of truth; reset the module fallback so
  // earlier tests cannot leak a token into a "no token configured" harness.
  const credentials = createFakeCredentials()
  await clearToken(credentials)
  if (token !== null) credentials.records.set(TOKEN_KEY, { kind: 'api-key', key: token })

  const translatorImpl = translator === 'fake' ? createFakeTranslator() : undefined
  const manager = createParseManager({
    store,
    config,
    getToken: () => getToken(credentials),
    logger,
    localEngine,
  })
  const service = createService({
    store,
    manager,
    config,
    logger,
    hostVersion: 'test+host',
    getCredentials: () => credentials,
    getTranslator: () => translatorImpl,
    getLlm: () => undefined,
    getDefaultModel: () => undefined,
    localEngine,
  })

  const harness = {
    root,
    dataDir: config.dataDir,
    config,
    mock,
    logger,
    store,
    credentials,
    manager,
    service,
    translator: translatorImpl,
    /** Absolute path of a document's parsed directory. */
    docDir(id) {
      return join(config.dataDir, 'documents', id)
    },
    async close() {
      await manager.dispose().catch(() => {})
      await store.dispose().catch(() => {})
      await mock.close().catch(() => {})
      await rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
  t.after(() => harness.close())
  return harness
}

/**
 * Write a source file into the store's upload temp dir and create the document,
 * exactly as the raw upload route does.
 *
 * @param {Awaited<ReturnType<typeof createHarness>>} harness
 * @param {{ name?: string, bytes?: Buffer, title?: string }} [options]
 */
export async function importDocument(harness, options = {}) {
  const { name = 'sparse-route.pdf', bytes = pdfBytes(), title } = options
  const id = randomUUID()
  const tempPath = harness.store.newTempPath(id)
  await writeFile(tempPath, bytes)
  return harness.store.createFromFile({ id, tempPath, originalName: name, title })
}
