/**
 * Unit tests for the parse manager (`src/host/parse/manager.ts`).
 *
 * Drives complete standard, agent, page-repair and local flows against an
 * injected fake MinerU HTTP implementation (routing on URL + method, returning
 * real `Response` objects) and the real on-disk store, plus cancellation and
 * host-restart resume. Result ZIPs are built with the independent ZIP writer
 * (`test/helpers/zip-builder.ts`).
 *
 * Ported from the frozen `test/unit/parse-manager.test.mjs`.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { LocalExtractResult, ResolvedConfig, StoreApi } from '../../src/host/contracts.ts'
import { resolveConfig } from '../../src/host/config.ts'
import type { Logger } from '../../src/host/host-services.ts'
import type { DocumentMeta, LocalParseStats, ParsedDocument, ParseProgress, ParseState } from '../../src/shared/model.ts'
import type { LocalEngine, LocalExtractInput } from '../../src/host/parse/local/engine.ts'
import type { MineruFetch, MineruResponse, NormalizedParsePlan } from '../../src/host/parse/mineru.ts'
import type { ParseOptionContext } from '../../src/host/contracts.ts'
import { normalizeParseOptions } from '../../src/host/parse/mineru.ts'
import type { ParseManager } from '../../src/host/parse/manager.ts'
import { createParseManager } from '../../src/host/parse/manager.ts'
import { createStore } from '../../src/host/store/index.ts'
import { WireError } from '../../src/host/wire.ts'
import { makeStoredZip } from '../helpers/zip-builder.ts'
import { waitFor } from '../helpers/parse-fixtures.ts'

const TOKEN = 'unit-test-token-abcdef'
const STANDARD_MARKDOWN = '# Attention Test Paper\n\nAbstract text with a formula $E=mc^2$.'
const AGENT_MARKDOWN = '# Agent Parsed Paper\n\nAgent body text.'
const CONTENT_LIST = JSON.stringify([
  { type: 'text', text: 'page zero', page_idx: 0 },
  { type: 'text', text: 'page one', page_idx: 1 },
  { type: 'text', text: 'page two', page_idx: 2 },
])

/** A stored-method ZIP shaped like a MinerU standard result archive. */
function standardResultZip(): Buffer<ArrayBuffer> {
  return makeStoredZip([
    { name: 'full.md', data: STANDARD_MARKDOWN },
    { name: 'paper_content_list.json', data: CONTENT_LIST },
    { name: 'images/fig1.svg', data: '<svg id="fig1"/>' },
    { name: 'layout.json', data: '{"should":"not be extracted"}' },
  ])
}

/** JSON response helper. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Read one request header regardless of its HeadersInit representation. */
function headerOf(headers: RequestInit['headers'], name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined
  if (headers instanceof Headers) {
    const value = headers.get(name)
    return value === null ? undefined : value
  }
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1]
  return headers[name]
}

/** Capture request headers as a plain string record. */
function headerRecordOf(headers: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {}
  if (headers === undefined || headers === null) return record
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value
    })
    return record
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[key.toLowerCase()] = value
    return record
  }
  for (const [key, value] of Object.entries(headers)) record[key.toLowerCase()] = value
  return record
}

/** Parse a captured JSON request body. */
function jsonBodyOf(init: RequestInit): Record<string, unknown> {
  const body = init.body
  assert.equal(typeof body, 'string', 'expected a JSON string body')
  const parsed: unknown = JSON.parse(body as string) // narrow: asserted string above
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

/** First `files[]` entry of a standard submit body. */
function firstSubmittedFile(body: Record<string, unknown> | null): Record<string, unknown> {
  assert.ok(body !== null, 'expected a captured standard submit body')
  const files = body.files
  assert.ok(Array.isArray(files) && files.length === 1)
  const file = files[0]
  assert.ok(file !== null && typeof file === 'object')
  return file as Record<string, unknown>
}

/** Standard context info for `normalizeParseOptions`. */
function ctxInfo(hasToken: boolean, maxUploadBytes = 200 * 1024 * 1024): ParseOptionContext {
  return { hasToken, maxUploadBytes, localSupported: false, localMaxBytes: 0, autoAllowAgentFallback: true }
}

/** Test environment: temp library with one uploaded PDF document. */
interface Env {
  dataDir: string
  config: ResolvedConfig
  store: StoreApi
  id: string
  meta: DocumentMeta
  logger: Logger
}

/** Create a fresh temp library with one uploaded PDF document. */
async function setup(options: { token?: string | null } = {}): Promise<Env> {
  void options
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-parse-'))
  const config = resolveConfig({
    dataDir,
    apiBase: 'https://api.mineru.test',
    pollIntervalMs: 10,
    maxConcurrentParses: 2,
    parseTimeoutMs: 5000,
  })
  const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
  const store = createStore({ dataDir, logger })
  await store.init()
  const id = randomUUID()
  const tempPath = store.newTempPath(id)
  await writeFile(tempPath, Buffer.from('%PDF-1.4 fake paper bytes'))
  const meta = await store.createFromFile({ id, tempPath, originalName: 'paper.pdf' })
  return { dataDir, config, store, id, meta, logger }
}

/** Build a manager for a setup environment. */
function makeManager(
  env: Env,
  fake: { fetchImpl: MineruFetch },
  token: string | null = TOKEN,
  localEngine?: LocalEngine,
  reanchor?: Parameters<typeof createParseManager>[0]['reanchor'],
): ParseManager {
  return createParseManager({
    store: env.store,
    config: env.config,
    logger: env.logger,
    getToken: async () => (token === null ? undefined : token),
    fetchImpl: fake.fetchImpl,
    ...(localEngine === undefined ? {} : { localEngine }),
    ...(reanchor === undefined ? {} : { reanchor }),
  })
}

/** Clean up a test environment. */
async function teardown(env: Env, ...managers: ParseManager[]): Promise<void> {
  for (const manager of managers) await manager.dispose()
  await env.store.dispose()
  await rm(env.dataDir, { recursive: true, force: true })
}

/** Assert an async call rejects with a WireError carrying `code`. */
async function rejectsWire(
  promiseFactory: () => Promise<unknown>,
  code: string,
  status?: number,
): Promise<void> {
  await assert.rejects(promiseFactory, (error: unknown) => {
    assert.ok(error instanceof WireError, `expected a WireError, got ${String(error)}`)
    assert.equal(error.code, code)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  })
}

/** Narrow a document's optional parse state (null until the first parse). */
function parseOf(meta: DocumentMeta): ParseState {
  assert.ok(meta.parse !== null, 'expected the document to have a parse state')
  return meta.parse
}

/** Observable state of the fake MinerU server. */
interface FakeMineruState {
  docId: string
  submissions: number
  agentSubmissions: number
  uploads: number
  standardPolls: number
  agentPolls: number
  zipDownloads: number
  markdownDownloads: number
  resumePolls: number
  lastStandardBody: Record<string, unknown> | null
  lastSubmitHeaders: Record<string, string> | null
}

/** Options of {@link createFakeMineru}. */
interface FakeMineruOptions {
  apiBase: string
  docId: string
  alwaysRunning?: boolean
  resumeBatchId?: string
  resumeTaskId?: string
  standardRunningPolls?: number
}

/**
 * Build a fake MinerU HTTP implementation with counters and captured requests.
 */
function createFakeMineru(options: FakeMineruOptions): { state: FakeMineruState; fetchImpl: MineruFetch } {
  const { apiBase, docId, alwaysRunning = false, resumeBatchId, resumeTaskId, standardRunningPolls = 1 } = options
  const state: FakeMineruState = {
    docId,
    submissions: 0,
    agentSubmissions: 0,
    uploads: 0,
    standardPolls: 0,
    agentPolls: 0,
    zipDownloads: 0,
    markdownDownloads: 0,
    resumePolls: 0,
    lastStandardBody: null,
    lastSubmitHeaders: null,
  }
  function standardBatchId(): string {
    return state.submissions === 1 && resumeBatchId === undefined ? 'batch-1' : (resumeBatchId ?? `batch-${state.submissions}`)
  }
  const fetchImpl: MineruFetch = async (url, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    // Standard submit
    if (url === `${apiBase}/api/v4/file-urls/batch` && method === 'POST') {
      state.submissions += 1
      state.lastStandardBody = jsonBodyOf(init)
      state.lastSubmitHeaders = headerRecordOf(init.headers)
      const batchId = resumeBatchId !== undefined ? resumeBatchId : `batch-${state.submissions}`
      return jsonResponse({
        code: 0,
        data: { batch_id: batchId, file_urls: [`https://upload.test/std-${state.submissions}`] },
      })
    }
    // Signed uploads
    if (url.startsWith('https://upload.test/')) {
      state.uploads += 1
      assert.equal(method, 'PUT')
      assert.equal(headerOf(init.headers, 'content-type'), undefined, 'signed upload must not set content-type')
      assert.ok(Buffer.isBuffer(init.body), 'signed upload body must be raw bytes')
      return new Response(null, { status: 200 })
    }
    // Standard poll
    const standardPoll = /\/api\/v4\/extract-results\/batch\/(.+)$/.exec(url)
    if (standardPoll !== null) {
      state.standardPolls += 1
      const polledId = standardPoll[1]
      if (polledId === resumeBatchId) state.resumePolls += 1
      const runningPolls = resumeBatchId !== undefined ? 0 : standardRunningPolls
      const running = alwaysRunning === true || state.standardPolls <= runningPolls
      return jsonResponse({
        code: 0,
        data: {
          batch_id: standardPoll[1] ?? standardBatchId(),
          extract_result: [
            {
              data_id: state.docId,
              file_name: 'paper.pdf',
              state: running ? 'running' : 'done',
              extract_progress: {
                extracted_pages: Math.min(state.standardPolls, 3),
                total_pages: 3,
              },
              ...(running ? {} : { full_zip_url: 'https://cdn.test/result.zip' }),
            },
          ],
        },
      })
    }
    // Agent submit
    if (url === `${apiBase}/api/v1/agent/parse/file` && method === 'POST') {
      state.agentSubmissions += 1
      return jsonResponse({ code: 0, data: { task_id: 'task-1', file_url: 'https://upload.test/agent-1' } })
    }
    // Agent poll
    if (/\/api\/v1\/agent\/parse\/.+$/.test(url)) {
      state.agentPolls += 1
      if (resumeTaskId !== undefined) state.resumePolls += 1
      const running = alwaysRunning === true || (resumeTaskId === undefined && state.agentPolls < 2)
      return jsonResponse({
        code: 0,
        data: {
          task_id: 'task-1',
          state: running ? 'running' : 'done',
          ...(running ? {} : { markdown_url: 'https://cdn.test/agent.md' }),
        },
      })
    }
    // Standard result ZIP
    if (url === 'https://cdn.test/result.zip') {
      state.zipDownloads += 1
      return new Response(standardResultZip(), { status: 200 })
    }
    // Agent markdown
    if (url === 'https://cdn.test/agent.md') {
      state.markdownDownloads += 1
      return new Response(AGENT_MARKDOWN, { status: 200 })
    }
    throw new Error(`unexpected fake MinerU request: ${method} ${url}`)
  }
  return { state, fetchImpl }
}

// ---------------------------------------------------------------------------

test('standard flow: submit, upload, poll, unzip and persist parsed metadata', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id })
  const manager = makeManager(env, fake)
  try {
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    const normalized = normalizeParseOptions(
      { engine: 'standard', pageRanges: '2,4-6', enableTable: false, language: 'en' },
      meta,
      ctxInfo(true, env.config.maxUploadBytes),
    )
    const started = await manager.start(env.id, normalized)
    assert.equal(started.status, 'parsing')
    assert.equal(parseOf(started).engine, 'standard')
    assert.equal(started.error, null)

    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'parsed' ? current : null
      },
      { label: 'standard parse completion' },
    )
    assert.equal(final.status, 'parsed')
    assert.equal(final.error, null)
    assert.equal(parseOf(final).phase, null)
    assert.equal(parseOf(final).engine, 'standard')
    assert.equal(parseOf(final).modelVersion, 'vlm')
    assert.equal(parseOf(final).hasContentList, true)
    assert.equal(parseOf(final).pages, 3)
    assert.ok((parseOf(final).progress?.extracted ?? 0) >= 1)
    assert.equal(parseOf(final).progress?.total, 3)
    assert.match(final.title, /Attention Test Paper/, 'first heading becomes the default title')
    assert.equal(typeof parseOf(final).finishedAt, 'string')

    // Request shape captured by the fake.
    assert.equal(fake.state.submissions, 1)
    assert.equal(fake.state.uploads, 1)
    assert.ok(fake.state.standardPolls >= 2)
    assert.equal(fake.state.zipDownloads, 1)
    assert.equal(fake.state.lastSubmitHeaders?.authorization, `Bearer ${TOKEN}`)
    const file = firstSubmittedFile(fake.state.lastStandardBody)
    assert.equal(file.data_id, env.id)
    assert.equal(file.name, 'paper.pdf')
    assert.equal(file.page_ranges, '2,4-6')
    assert.equal(file.is_ocr, false)
    assert.equal(fake.state.lastStandardBody?.model_version, 'vlm')
    assert.equal(fake.state.lastStandardBody?.language, 'en')
    assert.equal(fake.state.lastStandardBody?.enable_table, false)

    // Files on disk: wanted entries only.
    const parsedDir = env.store.parsedDir(env.id)
    assert.equal(await readFile(join(parsedDir, 'full.md'), 'utf8'), STANDARD_MARKDOWN)
    assert.equal(await readFile(join(parsedDir, 'paper_content_list.json'), 'utf8'), CONTENT_LIST)
    assert.equal(await readFile(join(parsedDir, 'images', 'fig1.svg'), 'utf8'), '<svg id="fig1"/>')
    assert.equal(existsSync(join(parsedDir, 'layout.json')), false, 'unwanted zip entries are not extracted')

    // The library read path sees the result.
    const markdown = await env.store.readMarkdown(env.id)
    assert.equal(markdown.markdown, STANDARD_MARKDOWN)
    assert.equal(markdown.pages, 3)

    // A second parse can start once the first finished (task cleanup).
    const again = await manager.start(env.id, normalized)
    assert.equal(again.status, 'parsing')
    await waitFor(() => env.store.get(env.id)?.status === 'parsed', { label: 'second parse' })
  } finally {
    await teardown(env, manager)
  }
})

test('agent flow: token-free parse stores markdown and clears hasContentList', async () => {
  const env = await setup({ token: null })
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id })
  const manager = makeManager(env, fake, null)
  try {
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    const normalized = normalizeParseOptions({}, meta, ctxInfo(false, env.config.maxUploadBytes))
    assert.equal(normalized.engine, 'agent')
    const started = await manager.start(env.id, normalized)
    assert.equal(parseOf(started).engine, 'agent')

    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'parsed' ? current : null
      },
      { label: 'agent parse completion' },
    )
    assert.equal(parseOf(final).engine, 'agent')
    assert.equal(parseOf(final).hasContentList, false)
    assert.equal(parseOf(final).phase, null)
    assert.match(final.title, /Agent Parsed Paper/, 'first heading becomes the default title')
    assert.equal(fake.state.agentSubmissions, 1)
    assert.equal(fake.state.markdownDownloads, 1)
    assert.equal(fake.state.submissions, 0, 'agent flow never touches the standard API')

    const parsedDir = env.store.parsedDir(env.id)
    assert.equal(await readFile(join(parsedDir, 'full.md'), 'utf8'), AGENT_MARKDOWN)
    assert.equal(existsSync(join(parsedDir, 'paper_content_list.json')), false)
  } finally {
    await teardown(env, manager)
  }
})

test('progress writes are throttled to at most one per two seconds', async () => {
  const env = await setup()
  const fake = createFakeMineru({
    apiBase: env.config.apiBase,
    docId: env.id,
    standardRunningPolls: 6,
  })
  const manager = makeManager(env, fake)
  // Observe only progress-only metadata patches (phase/final patches are not throttled).
  const progressWrites: Array<ParseProgress | null> = []
  const originalUpdate = env.store.update.bind(env.store)
  env.store.update = async (id, patch) => {
    const parsePatch = patch.parse
    if (
      parsePatch !== null &&
      parsePatch !== undefined &&
      Object.keys(parsePatch).length === 1 &&
      'progress' in parsePatch
    ) {
      progressWrites.push(parsePatch.progress ?? null)
    }
    return originalUpdate(id, patch)
  }
  try {
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    const normalized = normalizeParseOptions(
      { engine: 'standard' },
      meta,
      ctxInfo(true, env.config.maxUploadBytes),
    )
    await manager.start(env.id, normalized)
    await waitFor(() => env.store.get(env.id)?.status === 'parsed', {
      timeout: 5000,
      label: 'throttled parse completion',
    })
    assert.ok(fake.state.standardPolls >= 7, `expected several polls, got ${fake.state.standardPolls}`)
    assert.equal(progressWrites.length, 1, 'only the first progress change inside the 2 s window is written')
    assert.deepEqual(progressWrites[0], { extracted: 1, total: 3 })
  } finally {
    await teardown(env, manager)
  }
})

test('cancel aborts polling and returns the document to uploaded without an error', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id, alwaysRunning: true })
  const manager = makeManager(env, fake)
  try {
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    const normalized = normalizeParseOptions(
      { engine: 'standard' },
      meta,
      ctxInfo(true, env.config.maxUploadBytes),
    )
    await manager.start(env.id, normalized)
    await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current?.parse?.phase === 'polling' ? current : null
      },
      { label: 'polling phase' },
    )
    const cancelled = await manager.cancel(env.id)
    assert.equal(cancelled.status, 'uploaded')
    assert.equal(cancelled.error, null)
    assert.equal(parseOf(cancelled).phase, null)
    assert.equal(parseOf(cancelled).batchId, null)

    // Source is still there, no parsed output was written.
    assert.equal(existsSync(await env.store.sourcePath(env.id)), true)
    assert.equal(existsSync(join(env.store.docDir(env.id), 'parsed')), false)

    await rejectsWire(() => manager.cancel(env.id), 'bad-request')
  } finally {
    await teardown(env, manager)
  }
})

test('resume restarts polling from a persisted batch id after a host restart', async () => {
  const env = await setup()
  const fake = createFakeMineru({
    apiBase: env.config.apiBase,
    docId: env.id,
    resumeBatchId: 'batch-resume',
  })
  // Simulate a host that died while polling: persist status + phase + ids only.
  await env.store.update(env.id, {
    status: 'parsing',
    error: null,
    parse: {
      engine: 'standard',
      modelVersion: 'vlm',
      language: 'ch',
      options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
      phase: 'polling',
      taskId: null,
      batchId: 'batch-resume',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: null,
      progress: null,
      hasContentList: false,
    },
  })
  const manager = makeManager(env, fake)
  try {
    await manager.resume()
    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'parsed' ? current : null
      },
      { label: 'resumed parse completion' },
    )
    assert.equal(final.status, 'parsed')
    assert.equal(parseOf(final).hasContentList, true)
    assert.equal(parseOf(final).pages, 3)
    assert.equal(fake.state.submissions, 0, 'resume must not resubmit the file')
    assert.equal(fake.state.uploads, 0, 'resume must not re-upload the file')
    assert.ok(fake.state.resumePolls >= 1)
    assert.equal(await readFile(join(env.store.parsedDir(env.id), 'full.md'), 'utf8'), STANDARD_MARKDOWN)
  } finally {
    await teardown(env, manager)
  }
})

test('resume restarts agent polling from a persisted task id', async () => {
  const env = await setup({ token: null })
  const fake = createFakeMineru({
    apiBase: env.config.apiBase,
    docId: env.id,
    resumeTaskId: 'task-resume',
  })
  await env.store.update(env.id, {
    status: 'parsing',
    error: null,
    parse: {
      engine: 'agent',
      modelVersion: null,
      language: 'ch',
      options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
      phase: 'polling',
      taskId: 'task-resume',
      batchId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: null,
      progress: null,
      hasContentList: false,
    },
  })
  const manager = makeManager(env, fake, null)
  try {
    await manager.resume()
    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'parsed' ? current : null
      },
      { label: 'resumed agent parse completion' },
    )
    assert.equal(parseOf(final).engine, 'agent')
    assert.equal(fake.state.agentSubmissions, 0)
    assert.ok(fake.state.resumePolls >= 1)
  } finally {
    await teardown(env, manager)
  }
})

test('resume fails parses interrupted before the polling phase', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id })
  await env.store.update(env.id, {
    status: 'parsing',
    error: null,
    parse: {
      engine: 'standard',
      phase: 'uploading',
      batchId: 'batch-partial',
      taskId: null,
      options: {},
    },
  })
  const manager = makeManager(env, fake)
  try {
    await manager.resume()
    const current = env.store.get(env.id)
    assert.ok(current !== undefined)
    assert.equal(current.status, 'failed')
    assert.match(current.error ?? '', /中断/)
    assert.equal(current.parse?.phase, null)
    assert.equal(fake.state.standardPolls, 0)
  } finally {
    await teardown(env, manager)
  }
})

test('start validates document existence and rejects concurrent parses', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id, alwaysRunning: true })
  const manager = makeManager(env, fake)
  try {
    await rejectsWire(() => manager.start(randomUUID(), { engine: 'standard', params: {} }), 'not-found')
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    const normalized = normalizeParseOptions(
      { engine: 'standard' },
      meta,
      ctxInfo(true, env.config.maxUploadBytes),
    )
    await manager.start(env.id, normalized)
    await rejectsWire(() => manager.start(env.id, normalized), 'conflict')
  } finally {
    await teardown(env, manager)
  }
})

test('dispose aborts an in-flight parse promptly', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id, alwaysRunning: true })
  const manager = makeManager(env, fake)
  try {
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    const normalized = normalizeParseOptions(
      { engine: 'standard' },
      meta,
      ctxInfo(true, env.config.maxUploadBytes),
    )
    await manager.start(env.id, normalized)
    await waitFor(() => fake.state.standardPolls >= 1, { label: 'first poll' })
    await manager.dispose()
    // Already-disposed manager rejects new work but does not crash.
    await rejectsWire(() => manager.start(env.id, normalized), 'host-error')
  } finally {
    await teardown(env, manager)
  }
})

// ---------------------------------------------------------------------------
// Page-scoped repair
// ---------------------------------------------------------------------------

const REPAIR_OLD_MARKDOWN = [
  '# Repair Test Paper',
  '',
  '## 1 Introduction',
  '',
  'Page one introduction stays untouched.',
  '',
  '## 2 Method',
  '',
  'Page two has a broken symbol \ufffd here.',
  '',
  '## 3 Results',
  '',
  'Page three results stay untouched.',
  '',
].join('\n')

const REPAIR_OLD_CONTENT_LIST = [
  { type: 'text', text: 'Repair Test Paper', text_level: 1, page_idx: 0 },
  { type: 'text', text: '1 Introduction', text_level: 2, page_idx: 0 },
  { type: 'text', text: 'Page one introduction stays untouched.', page_idx: 0 },
  { type: 'text', text: '2 Method', text_level: 2, page_idx: 1 },
  { type: 'text', text: 'Page two has a broken symbol \ufffd here.', page_idx: 1 },
  { type: 'text', text: '3 Results', text_level: 2, page_idx: 2 },
  { type: 'text', text: 'Page three results stay untouched.', page_idx: 2 },
]

const REPAIR_NEW_MARKDOWN = '## 2 Method\n\nPage two has a recovered symbol q here.\n'
const REPAIR_NEW_CONTENT_LIST = [
  { type: 'text', text: '2 Method', text_level: 2, page_idx: 0 },
  { type: 'text', text: 'Page two has a recovered symbol q here.', page_idx: 0 },
]

/** Seed the uploaded test document as an already parsed paper. */
async function seedParsedPaper(env: Env): Promise<void> {
  const parsedDir = env.store.parsedDir(env.id)
  await mkdir(join(parsedDir, 'images'), { recursive: true })
  await writeFile(join(parsedDir, 'full.md'), REPAIR_OLD_MARKDOWN)
  await writeFile(join(parsedDir, 'paper_content_list.json'), JSON.stringify(REPAIR_OLD_CONTENT_LIST))
  await writeFile(join(parsedDir, 'images', 'old.svg'), '<svg id="old"/>')
  await env.store.update(env.id, {
    status: 'parsed',
    error: null,
    parse: {
      engine: 'standard',
      modelVersion: 'vlm',
      language: 'ch',
      options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
      phase: null,
      taskId: null,
      batchId: null,
      pages: 3,
      progress: null,
      hasContentList: true,
    },
  })
  await env.store.saveAnnotations(env.id, {
    items: [
      {
        id: 'ann-1',
        blockKey: 'b0:deadbeef',
        start: 0,
        end: 5,
        quote: 'Page',
        color: 'yellow',
        note: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  })
}

/** Fake MinerU that serves a two-page-ranged repair archive. */
function createRepairFake(options: {
  apiBase: string
  docId: string
  fail?: boolean
  alwaysRunning?: boolean
}): { state: { submissions: number; polls: number; zips: number; lastStandardBody: Record<string, unknown> | null }; fetchImpl: MineruFetch } {
  const { apiBase, docId, fail = false, alwaysRunning = false } = options
  const state = {
    submissions: 0,
    polls: 0,
    zips: 0,
    lastStandardBody: null as Record<string, unknown> | null,
  }
  const zip = makeStoredZip([
    { name: 'full.md', data: REPAIR_NEW_MARKDOWN },
    { name: 'repair_content_list.json', data: JSON.stringify(REPAIR_NEW_CONTENT_LIST) },
    { name: 'images/new.svg', data: '<svg id="new"/>' },
  ])
  const fetchImpl: MineruFetch = async (url, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    if (url === `${apiBase}/api/v4/file-urls/batch` && method === 'POST') {
      state.submissions += 1
      state.lastStandardBody = jsonBodyOf(init)
      return jsonResponse({ code: 0, data: { batch_id: 'repair-batch', file_urls: ['https://upload.test/repair'] } })
    }
    if (url.startsWith('https://upload.test/')) {
      assert.equal(method, 'PUT')
      return new Response(null, { status: 200 })
    }
    const poll = /\/api\/v4\/extract-results\/batch\/(.+)$/.exec(url)
    if (poll !== null) {
      state.polls += 1
      const running = alwaysRunning === true || (!fail && state.polls < 2)
      return jsonResponse({
        code: 0,
        data: {
          batch_id: poll[1] ?? 'repair-batch',
          extract_result: [
            {
              data_id: docId,
              file_name: 'paper.pdf',
              state: running ? 'running' : fail ? 'failed' : 'done',
              err_msg: fail ? 'repair failed on purpose' : '',
              ...(running || fail ? {} : { full_zip_url: 'https://cdn.test/repair.zip' }),
            },
          ],
        },
      })
    }
    if (url === 'https://cdn.test/repair.zip') {
      state.zips += 1
      return new Response(zip, { status: 200 })
    }
    throw new Error(`unexpected repair fake request: ${method} ${url}`)
  }
  return { state, fetchImpl }
}

test('page repair: only the problem page is re-parsed and spliced back in', async () => {
  const env = await setup()
  const fake = createRepairFake({ apiBase: env.config.apiBase, docId: env.id })
  const manager = makeManager(env, fake)
  try {
    await seedParsedPaper(env)
    const started = await manager.start(env.id, { merge: true })
    assert.equal(started.status, 'parsing')
    assert.deepEqual(parseOf(started).repairPages, [2])
    assert.equal(parseOf(started).options?.pageRanges, '2')
    assert.equal(fake.state.lastStandardBody, null, 'submit happens asynchronously')

    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'parsed' && current.parse?.repair !== undefined && current.parse?.repair !== null
          ? current
          : null
      },
      { label: 'page repair completion' },
    )
    assert.equal(final.status, 'parsed')
    assert.equal(final.error, null)
    assert.equal(parseOf(final).repairPages, null)
    assert.deepEqual(parseOf(final).repair?.pages, [2])
    assert.deepEqual(parseOf(final).repair?.failedPages, [])
    assert.equal(parseOf(final).pages, 3, 'total page count is preserved')
    assert.match(String(firstSubmittedFile(fake.state.lastStandardBody).page_ranges), /^2$/)
    assert.equal(fake.state.submissions, 1)

    const parsed = await env.store.readMarkdown(env.id)
    assert.ok(parsed.markdown.includes('recovered symbol q'))
    assert.ok(!parsed.markdown.includes('\ufffd'))
    assert.ok(parsed.markdown.includes('Page one introduction stays untouched.'))
    assert.ok(parsed.markdown.includes('Page three results stay untouched.'))
    assert.ok(Array.isArray(parsed.contentList))
    assert.deepEqual(
      (parsed.contentList ?? []).map((entry) => entry.page_idx),
      [0, 0, 0, 1, 1, 2, 2].slice(0, parsed.contentList?.length ?? 0),
    )
    // Old artifacts survive, new images are added.
    const parsedDir = env.store.parsedDir(env.id)
    assert.equal(await readFile(join(parsedDir, 'images', 'old.svg'), 'utf8'), '<svg id="old"/>')
    assert.equal(await readFile(join(parsedDir, 'images', 'new.svg'), 'utf8'), '<svg id="new"/>')
    // Annotations are untouched by a page-scoped repair.
    const annotations = await env.store.loadAnnotations(env.id)
    assert.equal(annotations.items.length, 1)
    assert.equal(annotations.items[0]?.id, 'ann-1')
  } finally {
    await teardown(env, manager)
  }
})

test('page repair failure restores the previous parsed state with an error note', async () => {
  const env = await setup()
  const fake = createRepairFake({ apiBase: env.config.apiBase, docId: env.id, fail: true })
  const manager = makeManager(env, fake)
  try {
    await seedParsedPaper(env)
    await manager.start(env.id, { merge: true })
    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'parsed' && current.parse?.repairError !== undefined && current.parse?.repairError !== null
          ? current
          : null
      },
      { label: 'repair failure state' },
    )
    assert.match(parseOf(final).repairError ?? '', /repair failed/i)
    assert.equal(parseOf(final).repairPages, null)
    assert.equal(final.error, null, 'the document stays parsed, not failed')
    const parsed: ParsedDocument = await env.store.readMarkdown(env.id)
    assert.equal(parsed.markdown, REPAIR_OLD_MARKDOWN, 'previous parse is untouched')
  } finally {
    await teardown(env, manager)
  }
})

test('cancelling a page repair restores the parsed document', async () => {
  const env = await setup()
  const fake = createRepairFake({ apiBase: env.config.apiBase, docId: env.id, alwaysRunning: true })
  const manager = makeManager(env, fake)
  try {
    await seedParsedPaper(env)
    await manager.start(env.id, { merge: true })
    await waitFor(() => fake.state.polls >= 1, { label: 'repair polling' })
    const cancelled = await manager.cancel(env.id)
    assert.equal(cancelled.status, 'parsed')
    assert.equal(parseOf(cancelled).repairPages, null)
    const parsed = await env.store.readMarkdown(env.id)
    assert.equal(parsed.markdown, REPAIR_OLD_MARKDOWN)
  } finally {
    await teardown(env, manager)
  }
})

// ---------------------------------------------------------------------------
// Local engine (T0 / T0.5) flows
// ---------------------------------------------------------------------------

const LOCAL_MARKDOWN = '# Local Parsed Paper\n\nLocal body text extracted on device.\n'
const LOCAL_CONTENT_LIST = [
  { type: 'text', text: 'Local Parsed Paper', page_idx: 0, text_level: 1 },
  { type: 'text', text: 'Local body text extracted on device.', page_idx: 1, text_level: 0 },
]
const LOCAL_STATS: LocalParseStats = {
  pageCount: 2,
  textChars: 42,
  extractMs: 3,
  toolVersion: 'pdfjs-dist/5.4.449',
  provider: 'builtin',
  warnings: [],
}

/** In-memory local engine facade matching `createLocalEngine()`'s surface. */
interface FakeLocalState {
  extracts: LocalExtractInput[]
  aborted: boolean
  started: Promise<void>
}

/**
 * In-memory local engine facade. `fail` throws during extraction; `hang` blocks
 * until the task is cancelled.
 */
function createFakeLocalEngine(options: { fail?: unknown; hang?: boolean } = {}): {
  engine: LocalEngine
  state: FakeLocalState
} {
  let markStarted = (): void => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const state: FakeLocalState = { extracts: [], aborted: false, started }
  const fake = {
    state,
    config: { maxPdfBytes: 200 * 1024 * 1024 },
    providers: { builtin: 'builtin', office: 'system:officeToPdf' },
    snapshot: () => ({
      enabled: true,
      available: true,
      recommended: 'builtin',
      providers: [],
      capabilities: { textLayerPdf: true, office: false, images: false, html: false },
      configuration: { maxPdfBytes: 200 * 1024 * 1024 },
    }),
    supports: (meta: { originalName?: string }) =>
      /\.pdf$/i.test(String(meta?.originalName ?? ''))
        ? { supported: true, provider: 'builtin' }
        : { supported: false, provider: null, reason: 'unsupported extension' },
    plan: () => ({ provider: 'builtin', params: { language: 'local' } }),
    async extract(input: LocalExtractInput): Promise<LocalExtractResult> {
      state.extracts.push(input)
      if (options.hang === true) {
        markStarted()
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            state.aborted = true
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
          }
          if (input.signal?.aborted === true) abort()
          else input.signal?.addEventListener('abort', abort, { once: true })
        })
        throw new Error('unreachable')
      }
      if (options.fail !== undefined) throw options.fail
      input.onProgress?.({ extracted: 1, total: 2 })
      input.onProgress?.({ extracted: 2, total: 2 })
      return {
        markdown: LOCAL_MARKDOWN,
        contentList: LOCAL_CONTENT_LIST,
        pages: 2,
        provider: 'builtin',
        title: 'Local Parsed Paper',
        warnings: ['no-structure', 'no-outline'],
        stats: { ...LOCAL_STATS },
      }
    },
  }
  return { engine: fake as unknown as LocalEngine, state }
}

/** A fetch implementation that fails loudly if the local path ever uses it. */
const NO_NETWORK: MineruFetch = async (url) => {
  throw new Error(`local parse must not use the network (${url})`)
}

const LOCAL_PLAN = {
  engine: 'local' as const,
  params: { fileName: 'paper.pdf', language: 'local', localProvider: 'builtin' },
}

test('local flow: extracts on device, writes artifacts and records provider metadata', async () => {
  const env = await setup()
  const local = createFakeLocalEngine()
  const manager = makeManager(env, { fetchImpl: NO_NETWORK }, TOKEN, local.engine)
  try {
    const started = await manager.start(env.id, LOCAL_PLAN)
    assert.equal(started.status, 'parsing')
    assert.equal(parseOf(started).engine, 'local')
    assert.equal(parseOf(started).phase, 'extracting')
    assert.equal(parseOf(started).modelVersion, null, 'local parses have no model version')
    assert.equal(parseOf(started).hasContentList, false)
    assert.deepEqual(parseOf(started).options, { isOcr: false, enableFormula: false, enableTable: false, pageRanges: '' })

    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'parsed' ? current : null
      },
      { label: 'local parse completion' },
    )
    assert.equal(final.error, null)
    assert.equal(parseOf(final).engine, 'local')
    assert.equal(parseOf(final).phase, null)
    assert.equal(parseOf(final).provider, 'builtin')
    assert.equal(parseOf(final).pages, 2)
    assert.equal(parseOf(final).hasContentList, true)
    assert.equal(final.title, 'Local Parsed Paper')
    assert.deepEqual(parseOf(final).local, { ...LOCAL_STATS, warnings: ['no-structure', 'no-outline'] })

    // The local extractor got the source path, params and a live abort signal.
    assert.equal(local.state.extracts.length, 1)
    const input = local.state.extracts[0]
    assert.ok(input !== undefined)
    assert.equal(input.id, env.id)
    assert.equal(input.sourcePath, await env.store.sourcePath(env.id))
    assert.deepEqual(input.params, LOCAL_PLAN.params)
    assert.ok(input.signal instanceof AbortSignal)
    assert.equal(typeof input.onProgress, 'function')

    // Artifacts on disk.
    const parsedDir = env.store.parsedDir(env.id)
    assert.equal(await readFile(join(parsedDir, 'full.md'), 'utf8'), LOCAL_MARKDOWN)
    assert.deepEqual(JSON.parse(await readFile(join(parsedDir, 'content_list.json'), 'utf8')), LOCAL_CONTENT_LIST)

    // The library read path sees the local result.
    const read = await env.store.readMarkdown(env.id)
    assert.equal(read.markdown, LOCAL_MARKDOWN)
    assert.deepEqual(read.contentList, LOCAL_CONTENT_LIST)
    assert.equal(read.pages, 2)
  } finally {
    await teardown(env, manager)
  }
})

test('local flow: local-empty-text fails the document and writes no artifacts', async () => {
  const env = await setup()
  const failure = new WireError('local-empty-text', '没有从文件中提取到文字（可能是扫描件）', 422)
  const local = createFakeLocalEngine({ fail: failure })
  const manager = makeManager(env, { fetchImpl: NO_NETWORK }, TOKEN, local.engine)
  try {
    await manager.start(env.id, LOCAL_PLAN)
    const failed = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current !== undefined && current.status === 'failed' ? current : null
      },
      { label: 'local parse failure' },
    )
    assert.match(failed.error ?? '', /没有从文件中提取到文字/)
    assert.equal(parseOf(failed).phase, null)
    assert.equal(existsSync(join(env.store.docDir(env.id), 'parsed')), false)
    assert.equal(await env.store.sourcePath(env.id).then((path) => existsSync(path)), true, 'the source is kept')
  } finally {
    await teardown(env, manager)
  }
})

test('local flow: cancelling during extraction returns the document to uploaded', async () => {
  const env = await setup()
  const local = createFakeLocalEngine({ hang: true })
  const manager = makeManager(env, { fetchImpl: NO_NETWORK }, TOKEN, local.engine)
  try {
    await manager.start(env.id, LOCAL_PLAN)
    await local.state.started
    const cancelled = await manager.cancel(env.id)
    assert.equal(cancelled.status, 'uploaded')
    assert.equal(cancelled.error, null)
    assert.equal(parseOf(cancelled).phase, null)
    await waitFor(() => local.state.aborted, { label: 'local extractor abort' })
    assert.equal(existsSync(join(env.store.docDir(env.id), 'parsed')), false)
  } finally {
    await teardown(env, manager)
  }
})

test('local parses cannot be page-repaired', async () => {
  const env = await setup()
  const local = createFakeLocalEngine()
  const manager = makeManager(env, { fetchImpl: NO_NETWORK }, TOKEN, local.engine)
  try {
    // Seed a parsed document produced by the local engine.
    const parsedDir = env.store.parsedDir(env.id)
    await mkdir(parsedDir, { recursive: true })
    await writeFile(join(parsedDir, 'full.md'), LOCAL_MARKDOWN)
    await writeFile(join(parsedDir, 'content_list.json'), JSON.stringify(LOCAL_CONTENT_LIST))
    await env.store.update(env.id, {
      status: 'parsed',
      error: null,
      parse: {
        engine: 'local',
        provider: 'builtin',
        language: 'local',
        phase: null,
        pages: 2,
        hasContentList: true,
      },
    })
    await assert.rejects(manager.start(env.id, { merge: true }), (error: unknown) => {
      assert.ok(error instanceof WireError)
      assert.equal(error.code, 'repair-unavailable')
      assert.equal(error.status, 409)
      assert.match(error.message, /本地解析不支持按页修复/)
      return true
    })
    assert.equal(local.state.extracts.length, 0, 'no repair work reached the local engine')
  } finally {
    await teardown(env, manager)
  }
})

// ---------------------------------------------------------------------------
// Annotation re-anchoring
// ---------------------------------------------------------------------------

test('a successful reparse re-anchors annotations through the shared hook', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id })
  const manager = makeManager(env, fake)
  try {
    // Seed a stale-looking annotation whose quote still exists in the new parse.
    const parsedDir = env.store.parsedDir(env.id)
    await mkdir(parsedDir, { recursive: true })
    await writeFile(join(parsedDir, 'full.md'), '# Old Title\n\nAttention appears in the title line.\n')
    await env.store.saveAnnotations(env.id, {
      items: [
        {
          id: 'ann-re',
          blockKey: 'b99:stale',
          start: 0,
          end: 9,
          quote: 'Attention Test Paper',
          color: 'yellow',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    const normalized = normalizeParseOptions({ engine: 'standard' }, meta, ctxInfo(true, env.config.maxUploadBytes))
    await manager.start(env.id, normalized)
    await waitFor(() => env.store.get(env.id)?.status === 'parsed', { label: 'reparse completion' })
    // The default hook is the shared reanchor implementation: the quote moved to
    // the new title block, so the annotation is re-anchored (not stale).
    const annotations = await env.store.loadAnnotations(env.id)
    const reanchored = annotations.items.find((item) => item.id === 'ann-re')
    assert.ok(reanchored !== undefined)
    assert.equal(reanchored.stale, undefined)
    assert.equal(reanchored.reanchored, true)
    assert.notEqual(reanchored.blockKey, 'b99:stale')
    assert.equal(reanchored.quote, 'Attention Test Paper')
  } finally {
    await teardown(env, manager)
  }
})

test('the reanchor hook can be injected and its changes are persisted', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id })
  const manager = makeManager(env, fake, TOKEN, undefined, ({ annotations }) =>
    annotations.map((annotation) => ({ ...annotation, stale: true, staleReason: 'quote-not-found' })),
  )
  try {
    const parsedDir = env.store.parsedDir(env.id)
    await mkdir(parsedDir, { recursive: true })
    await writeFile(join(parsedDir, 'full.md'), '# Old\n')
    await env.store.saveAnnotations(env.id, {
      items: [
        {
          id: 'ann-hook',
          blockKey: 'b0:abc',
          start: 0,
          end: 3,
          quote: 'gone',
          color: 'sky',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const meta = env.store.get(env.id)
    assert.ok(meta !== undefined)
    await manager.start(
      env.id,
      normalizeParseOptions({ engine: 'standard' }, meta, ctxInfo(true, env.config.maxUploadBytes)),
    )
    await waitFor(() => env.store.get(env.id)?.status === 'parsed', { label: 'reparse completion' })
    const annotations = await env.store.loadAnnotations(env.id)
    const updated = annotations.items.find((item) => item.id === 'ann-hook')
    assert.ok(updated !== undefined)
    assert.equal(updated.stale, true)
    assert.equal(updated.staleReason, 'quote-not-found')
  } finally {
    await teardown(env, manager)
  }
})

/** Keep the imported normalized-plan type referenced (documentation aid). */
export type ManagerTestPlan = NormalizedParsePlan
/** Keep the response type referenced for fake-server documentation. */
export type ManagerTestResponse = MineruResponse
