/**
 * Unit tests for Host configuration (`src/host/config.ts`): raw row config
 * normalization, the `ai:`/`local:` blocks, token storage through the Host
 * credentials service (+ in-memory fallback) and preference persistence through
 * the store.
 *
 * There is no dedicated frozen 1.0.0 `config.test.mjs`; the preference and
 * ai-block coverage lived in `store-aux.test.mjs`, and the token lifecycle was
 * exercised through the service. These tests keep those assertions at the
 * config seam.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { expect } from 'vitest'

import {
  PACKAGE_VERSION,
  clearToken,
  getToken,
  isTokenPersistent,
  loadPreferences,
  normalizeToken,
  resolveConfig,
  savePreferences,
  setToken,
  TOKEN_KEY,
  type CredentialsLike,
} from '../../src/host/config.ts'
import { createStore } from '../../src/host/store/index.ts'
import { WireError } from '../../src/host/wire.ts'
import { DEFAULT_PREFERENCES } from '../../src/shared/preferences.ts'

/** Temporary data directories created by the current test. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await clearToken(undefined)
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

/** Create an isolated data directory. */
async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-config-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  return dataDir
}

/** A real store over an isolated directory, disposed after the test. */
async function makeStore() {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  cleanups.push(() => store.dispose())
  return { dataDir, store }
}

/** In-memory credentials service matching the Host ApiKeyRecord API. */
function makeCredentials() {
  const records = new Map<string, unknown>()
  const service: CredentialsLike & { records: Map<string, unknown> } = {
    records,
    readRecord: async (key) => records.get(key),
    describeRecord: async (key) => ({ configured: records.has(key), kind: 'api-key', writable: true }),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return records.get(key)
    },
    deleteRecord: async (key) => {
      records.delete(key)
    },
  }
  return service
}

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

test('resolveConfig applies defaults, expands dataDir and canonicalizes apiBase', async () => {
  vi.stubEnv('DSH_HOME', '/tmp/litnotes-dsh-home')
  const base = resolveConfig(undefined)
  expect(base.dataDir).toBe('/tmp/litnotes-dsh-home/litnotes')
  expect(base.apiBase).toBe('https://mineru.net')
  expect(base.maxUploadBytes).toBe(200 * 1024 * 1024)
  expect(base.maxConcurrentParses).toBe(2)
  expect(base.pollIntervalMs).toBe(3000)
  expect(base.parseTimeoutMs).toBe(30 * 60 * 1000)
  expect(base.toolMaxChars).toBe(40000)
  expect(base.hostVersion).toBe(PACKAGE_VERSION)
  expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)

  const custom = resolveConfig({
    dataDir: '~/data/../papers',
    apiBase: 'https://api.example.test///',
  })
  expect(custom.dataDir.startsWith('/')).toBe(true)
  expect(custom.dataDir.endsWith('papers')).toBe(true)
  expect(custom.apiBase).toBe('https://api.example.test')

  // Invalid apiBase falls back to the default; non-http protocols are refused.
  expect(resolveConfig({ apiBase: 'not a url' }).apiBase).toBe('https://mineru.net')
  expect(resolveConfig({ apiBase: 'ftp://example.test' }).apiBase).toBe('https://mineru.net')
  // Relative dataDir is resolved against the process cwd.
  const relative = resolveConfig({ dataDir: 'relative/library' })
  expect(relative.dataDir.endsWith(join('relative', 'library'))).toBe(true)
})

test('resolveConfig clamps integer limits into their documented ranges', () => {
  const clamped = resolveConfig({
    maxUploadBytes: 1,
    maxConcurrentParses: 99,
    pollIntervalMs: 'nope',
    parseTimeoutMs: 1,
    toolMaxChars: 10_000_000,
  })
  expect(clamped.maxUploadBytes).toBe(64 * 1024)
  expect(clamped.maxConcurrentParses).toBe(8)
  expect(clamped.pollIntervalMs).toBe(3000)
  expect(clamped.parseTimeoutMs).toBe(1000)
  expect(clamped.toolMaxChars).toBe(400000)
})

test('ai config exposes the entailment switch and no dead autoBuildGraph key', () => {
  const base = resolveConfig({ ai: undefined }).ai
  expect(base.entailmentCheck).toBe(true)
  expect(base.entailmentMaxTokens).toBe(600)
  expect('autoBuildGraph' in base).toBe(false)
  expect(base.reasoningEffort).toBe('low')

  const custom = resolveConfig({
    ai: {
      entailmentCheck: false,
      entailmentMaxTokens: 1234,
      autoBuildGraph: true,
      provider: ' deepseek-official ',
      model: ' deepseek-flash ',
      reasoningEffort: 'max',
    },
  }).ai
  expect(custom.entailmentCheck).toBe(false)
  expect(custom.entailmentMaxTokens).toBe(1234)
  expect('autoBuildGraph' in custom).toBe(false)
  expect(custom.provider).toBe('deepseek-official')
  expect(custom.model).toBe('deepseek-flash')
  expect(custom.reasoningEffort).toBe('max')

  // Bounds are clamped; only an explicit false disables the pass.
  expect(resolveConfig({ ai: { entailmentMaxTokens: 1 } }).ai.entailmentMaxTokens).toBe(64)
  expect(resolveConfig({ ai: { entailmentMaxTokens: 'huge' } }).ai.entailmentMaxTokens).toBe(600)
  expect(resolveConfig({ ai: { entailmentCheck: 'false' } }).ai.entailmentCheck).toBe(true)
  expect(resolveConfig({ ai: { reasoningEffort: 'turbo' } }).ai.reasoningEffort).toBe('low')
  expect(resolveConfig({ ai: { historyTurns: 99 } }).ai.historyTurns).toBe(20)
  expect(resolveConfig({ ai: { maxAnnotationsPerAnswer: 0 } }).ai.maxAnnotationsPerAnswer).toBe(1)
})

test('ai deep-read block keeps defaults and clamps overrides', () => {
  const base = resolveConfig({}).ai
  expect(base.deepReadMaxChunks).toBe(24)
  expect(base.deepReadMaxSourceChars).toBe(240000)
  expect(base.deepReadMaxAnnotations).toBe(24)
  expect(base.deepReadMaxTokens).toBe(2400)
  expect(base.deepReadSynthesisChars).toBe(14000)
  expect(base.deepReadCoveragePass).toBe(true)
  expect(base.deepReadJudge).toBe(true)

  // Clamped into the documented ranges (docs/AI-SPEC.md §7).
  const clamped = resolveConfig({
    ai: {
      deepReadMaxChunks: 1,
      deepReadMaxSourceChars: 1,
      deepReadMaxAnnotations: 1000,
      deepReadMaxTokens: 1,
      deepReadSynthesisChars: 1,
      deepReadCoveragePass: false,
      deepReadJudge: 'false',
    },
  }).ai
  expect(clamped.deepReadMaxChunks).toBe(4)
  expect(clamped.deepReadMaxSourceChars).toBe(20000)
  expect(clamped.deepReadMaxAnnotations).toBe(60)
  expect(clamped.deepReadMaxTokens).toBe(512)
  expect(clamped.deepReadSynthesisChars).toBe(4000)
  // Only an explicit false disables the passes (matches the entailment switch).
  expect(clamped.deepReadCoveragePass).toBe(false)
  expect(clamped.deepReadJudge).toBe(true)
  expect(resolveConfig({ ai: { deepReadJudge: false } }).ai.deepReadJudge).toBe(false)
})

test('local config block keeps defaults and clamps overrides', () => {
  const base = resolveConfig({}).local
  expect(base.enabled).toBe(true)
  expect(base.maxPages).toBe(500)
  expect(base.maxPdfBytes).toBe(200 * 1024 * 1024)
  expect(base.maxTextBytes).toBe(32 * 1024 * 1024)
  expect(base.minCharsPerPage).toBe(30)
  expect(base.maxParagraphChars).toBe(4000)
  expect(base.keepContentList).toBe(true)
  expect(base.timeoutMs).toBe(120000)
  expect(base.maxOfficePdfBytes).toBe(100 * 1024 * 1024)

  const custom = resolveConfig({
    local: {
      enabled: false,
      maxPages: 100000,
      maxPdfBytes: 1,
      maxTextBytes: 'x',
      minCharsPerPage: -5,
      keepContentList: false,
    },
  }).local
  expect(custom.enabled).toBe(false)
  expect(custom.maxPages).toBe(5000)
  expect(custom.maxPdfBytes).toBe(64 * 1024)
  expect(custom.maxTextBytes).toBe(32 * 1024 * 1024)
  expect(custom.minCharsPerPage).toBe(0)
  expect(custom.keepContentList).toBe(false)
})

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

test('token lifecycle: stored, never exposed, clearable', async () => {
  const credentials = makeCredentials()
  const token = 'unit-test-token-abcdef-123456'
  expect(await getToken(credentials)).toBeUndefined()
  expect(await isTokenPersistent(credentials)).toBe(true)

  const persisted = await setToken(credentials, token)
  expect(persisted).toBe(true)
  expect(await getToken(credentials)).toBe(token)
  const record = credentials.records.get(TOKEN_KEY) as { key?: string; kind?: string }
  expect(record.key).toBe(token)
  expect(record.kind).toBe('api-key')

  // clearToken removes the durable record.
  expect(await clearToken(credentials)).toBe(true)
  expect(credentials.records.has(TOKEN_KEY)).toBe(false)
  expect(await getToken(credentials)).toBeUndefined()
})

test('setToken validates the token format and status works without credentials', async () => {
  await expect(async () => setToken(undefined, '  ')).rejects.toBeInstanceOf(WireError)
  await expect(async () => setToken(undefined, '  ')).rejects.toMatchObject({ code: 'bad-request' })
  await expect(async () => setToken(undefined, 'has whitespace in it')).rejects.toThrow(/Token/)
  await expect(async () => normalizeToken('short')).rejects.toThrow()
  expect(() => normalizeToken('short')).toThrow(/Token 格式无效/)
  expect(() => normalizeToken(42)).toThrow(/Token 不能为空/)
  expect(() => normalizeToken('x'.repeat(4097))).toThrow(/Token 格式无效/)
  expect(normalizeToken('  memory-token-123456789  ')).toBe('memory-token-123456789')

  // No credentials service means a session-only token.
  expect(await setToken(undefined, 'memory-token-123456789')).toBe(false)
  expect(await getToken(undefined)).toBe('memory-token-123456789')
  expect(await isTokenPersistent(undefined)).toBe(false)
  expect(await clearToken(undefined)).toBe(false)
  expect(await getToken(undefined)).toBeUndefined()
})

test('isTokenPersistent follows describeRecord and tolerates failures', async () => {
  const readonly: CredentialsLike = {
    modifyRecord: async () => undefined,
    describeRecord: async () => ({ writable: false }),
  }
  expect(await isTokenPersistent(readonly)).toBe(false)

  const readable: CredentialsLike = {
    modifyRecord: async () => undefined,
    describeRecord: async () => ({ writable: true }),
  }
  expect(await isTokenPersistent(readable)).toBe(true)

  // A describeRecord failure reports "persistent": the write path decides.
  const failing: CredentialsLike = {
    modifyRecord: async () => undefined,
    describeRecord: async () => {
      throw new Error('unavailable')
    },
  }
  expect(await isTokenPersistent(failing)).toBe(true)

  // No describeRecord at all: a writable credential store is persistent.
  expect(await isTokenPersistent({ modifyRecord: async () => undefined })).toBe(true)

  // A throwing readRecord falls back to the in-memory token.
  const throwingRead: CredentialsLike = {
    readRecord: async () => {
      throw new Error('unreadable')
    },
    modifyRecord: async () => undefined,
  }
  expect(await getToken(throwingRead)).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Preferences (persisted through the store)
// ---------------------------------------------------------------------------

test('preferences keep the margin origin filter notesFilter', async () => {
  const { dataDir, store } = await makeStore()
  expect(DEFAULT_PREFERENCES.notesFilter).toBe('all')
  expect('autoBuildGraph' in DEFAULT_PREFERENCES).toBe(false)

  // Fresh install reads the defaults.
  expect((await loadPreferences(store)).notesFilter).toBe('all')

  // Preferences round-trip through the host-persisted file.
  const saved = await savePreferences(store, { notesFilter: 'ai' })
  expect(saved.notesFilter).toBe('ai')
  expect((await loadPreferences(store)).notesFilter).toBe('ai')
  const onDisk = JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')) as {
    notesFilter?: string
  }
  expect(onDisk.notesFilter).toBe('ai')

  // A later invalid update resets the field to its default, never crashes.
  expect((await savePreferences(store, { notesFilter: 'nope' })).notesFilter).toBe('all')
  await expect(async () => savePreferences(store, 'nope')).rejects.toMatchObject({
    code: 'bad-request',
  })
})

test('savePreferences merges over stored values and drops unknown keys', async () => {
  const { store } = await makeStore()
  await savePreferences(store, { readingMode: 'bilingual', readingScale: 1.12 })
  const merged = await savePreferences(store, { defaultEngine: 'agent', bogusKey: 'ignored' })
  expect(merged.readingMode).toBe('bilingual')
  expect(merged.readingScale).toBe(1.12)
  expect(merged.defaultEngine).toBe('agent')
  expect('bogusKey' in merged).toBe(false)
  // Out-of-range values fall back to the defaults.
  const fallback = await savePreferences(store, { readingMode: 'weird', readingScale: 99 })
  expect(fallback.readingMode).toBe('original')
  expect(fallback.readingScale).toBe(1)
})
