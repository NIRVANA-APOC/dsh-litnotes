/**
 * End-to-end parse harness: a real Host stack (store + parse manager + service)
 * wired to the mock MinerU server and a temp data directory.
 *
 * Every resource is closed in one `onTestFinished` hook in dependency order.
 * Tests use a tiny `pollIntervalMs` (10 ms) so parse flows finish in
 * milliseconds, and every wait is bounded via `waitFor` — no unbounded polling.
 *
 * Ported from the frozen `test/e2e/harness.mjs` + `test/e2e/helpers.mjs`
 * (typed, scoped to the parse pipeline; fake credentials/translator included
 * because the service consumes them).
 *
 * @module test/helpers/e2e-harness
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import type { ResolvedConfig, ServiceApi, StoreApi } from '../../src/host/contracts.ts'
import type {
  Logger,
  TranslationProviderId,
  TranslationRequest,
  TranslationSpec,
  TranslatorService,
} from '../../src/host/host-services.ts'
import type { DocumentMeta, ParseState } from '../../src/shared/model.ts'
import { WireError } from '../../src/host/wire.ts'
import type { CredentialsLike } from '../../src/host/config.ts'
import { TOKEN_KEY, clearToken, getToken, resolveConfig } from '../../src/host/config.ts'
import type { LocalEngine } from '../../src/host/parse/local/engine.ts'
import type { ParseManager } from '../../src/host/parse/manager.ts'
import { createParseManager } from '../../src/host/parse/manager.ts'
import { describeMineruError, normalizeParseOptions } from '../../src/host/parse/mineru.ts'
import { createService } from '../../src/host/service.ts'
import { createStore } from '../../src/host/store/index.ts'
import { startMockMineru } from './mock-mineru.ts'
import type { MockMineru, StartMockMineruOptions } from './mock-mineru.ts'
import { pdfBytes, standardResultZip } from './parse-fixtures.ts'

/** One recorded translator call. */
export interface TranslatorCall {
  kind: 'resolve' | 'translate'
  text?: string
  provider?: string
  targetLanguage?: string
}

/** In-memory credentials service the Host config/token code accepts. */
export interface FakeCredentials extends CredentialsLike {
  records: Map<string, unknown>
  describeRecord: (key: string) => Promise<{ key: string; writable: boolean; present: boolean }>
}

/** A recording console-like logger for host modules. */
export interface RecordingLogger extends Logger {
  entries: Array<{ level: string; args: unknown[] }>
}

/** In-memory `ctx.get('credentials')` stand-in matching the Host surface. */
export function createFakeCredentials(initial: Record<string, unknown> = {}): FakeCredentials {
  const records = new Map<string, unknown>(Object.entries(initial))
  return {
    records,
    async readRecord(key: string) {
      return records.get(key)
    },
    async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown> | unknown) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return next
    },
    async deleteRecord(key: string) {
      records.delete(key)
    },
    async describeRecord(key: string) {
      return { key, writable: true, present: records.has(key) }
    },
  }
}

/** A recording console-like logger for host modules. */
export function createLogger(): RecordingLogger {
  const entries: Array<{ level: string; args: unknown[] }> = []
  const record = (level: string) => (...args: unknown[]): void => {
    entries.push({ level, args })
  }
  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  }
}

/** A recording `getTranslator` fake matching the Host translator surface. */
export interface FakeTranslator extends TranslatorService {
  requested: TranslatorCall[]
}

/** Create a fake translator that wraps text with a marker prefix. */
export function createFakeTranslator(prefix = '【译】'): FakeTranslator {
  const requested: TranslatorCall[] = []
  return {
    requested,
    async availableProviders() {
      const providers: TranslationProviderId[] = ['google', 'bing']
      return providers
    },
    resolve(request: TranslationRequest): TranslationSpec {
      const provider = request.provider ?? 'google'
      requested.push({
        kind: 'resolve',
        text: request.text,
        provider,
        targetLanguage: request.targetLanguage,
      })
      return {
        provider,
        text: request.text,
        targetLanguage: request.targetLanguage,
        sourceLanguage: request.sourceLanguage ?? 'en',
      }
    },
    async translate(spec: TranslationSpec) {
      requested.push({ kind: 'translate', text: spec.text, provider: String(spec.provider), targetLanguage: spec.targetLanguage })
      return `${prefix}${spec.text}`
    },
  }
}

/** Options of {@link createHarness}. */
export interface HarnessOptions {
  /** MinerU token (null = unconfigured). */
  token?: string | null
  /** Fake translator ('fake') or none (null). */
  translator?: 'fake' | null
  /** Mock MinerU scripting overrides. */
  mock?: Omit<StartMockMineruOptions, 'token'>
  /** Resolved-config overrides. */
  config?: Record<string, unknown>
  /** Injected local engine; absent means the profile cannot parse locally. */
  localEngine?: LocalEngine
}

/** A live end-to-end test environment. */
export interface Harness {
  root: string
  dataDir: string
  config: ResolvedConfig
  mock: MockMineru
  logger: RecordingLogger
  store: StoreApi
  credentials: FakeCredentials
  manager: ParseManager
  service: ServiceApi
  translator: FakeTranslator | undefined
  /** Absolute path of a document's directory. */
  docDir: (id: string) => string
  close: () => Promise<void>
}

/**
 * Create a full Host stack against the mock MinerU server and a temp library.
 *
 * @param options - token, translator mock, mock scripting and config overrides.
 * @returns the live harness; its resources are closed automatically after the
 *   current test finishes.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { token = 'e2e-token-1234', translator = 'fake', mock: mockOptions = {}, config: configOverrides = {} } = options
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
  const localEngine: LocalEngine | null = options.localEngine ?? null
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
    normalizeParseOptions,
    describeMineruError,
  })

  let closed = false
  const harness: Harness = {
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
    docDir(id: string) {
      return join(config.dataDir, 'documents', id)
    },
    async close() {
      if (closed) return
      closed = true
      await manager.dispose().catch(() => {})
      await store.dispose().catch(() => {})
      await mock.close().catch(() => {})
      await rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
  onTestFinished(() => harness.close())
  return harness
}

/** Write a source file into the store's upload temp dir and create the document. */
export async function importDocument(
  harness: Harness,
  options: { name?: string; bytes?: Uint8Array; title?: string } = {},
): Promise<DocumentMeta> {
  const { name = 'sparse-route.pdf', bytes = pdfBytes(), title } = options
  const id = randomUUID()
  const tempPath = harness.store.newTempPath(id)
  await writeFile(tempPath, bytes)
  return harness.store.createFromFile({ id, tempPath, originalName: name, title })
}

/** Narrow a document's optional parse state (null until the first parse). */
export function requireParse(meta: DocumentMeta): ParseState {
  if (meta.parse === null) throw new Error(`document ${meta.id} has no parse state`)
  return meta.parse
}

/** Assert an async call rejects with a WireError carrying `code` (and status). */
export async function rejectsWithCode(
  promiseFactory: () => Promise<unknown>,
  code: string,
  status?: number,
): Promise<WireError> {
  let captured: WireError | undefined
  await assertRejects(promiseFactory, (error) => {
    if (!(error instanceof WireError)) return false
    captured = error
    return error.code === code && (status === undefined || error.status === status)
  })
  if (captured === undefined) throw new Error(`expected a WireError with code ${code}`)
  return captured
}

/** Vitest-free rejection helper so callers keep an explicit return type. */
function assertRejects(fn: () => Promise<unknown>, predicate: (error: unknown) => boolean): Promise<void> {
  return fn().then(
    () => {
      throw new Error('expected the promise to reject')
    },
    (error: unknown) => {
      if (!predicate(error)) {
        throw new Error(`unexpected rejection: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  )
}

/** Wait until the document reaches `status`, returning the fresh metadata. */
export async function waitForStatus(
  store: StoreApi,
  id: string,
  status: string,
  options: { timeout?: number; interval?: number } = {},
): Promise<DocumentMeta> {
  const { timeout = 5000, interval = 10 } = options
  const deadline = Date.now() + timeout
  for (;;) {
    const meta = store.get(id)
    if (meta !== undefined && meta.status === status) return meta
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for document ${id} to become ${status}`)
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, interval)
    })
  }
}
