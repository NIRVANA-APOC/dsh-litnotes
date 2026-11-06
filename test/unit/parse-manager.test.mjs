/**
 * Unit tests for the parse manager (`lib/parse-manager.js`).
 *
 * Drives complete standard and agent parse flows against an injected fake
 * MinerU HTTP implementation (routing on URL + method, returning real
 * `Response` objects), plus cancellation and host-restart resume. Result ZIPs
 * are built with the independent stored-method writer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../../lib/config.js'
import { normalizeParseOptions } from '../../lib/mineru.js'
import { createParseManager } from '../../lib/parse-manager.js'
import { createStore } from '../../lib/store.js'
import { makeStoredZip } from './zip-builder.test.mjs'

const TOKEN = 'unit-test-token-abcdef'
const STANDARD_MARKDOWN = '# Attention Test Paper\n\nAbstract text with a formula $E=mc^2$.'
const AGENT_MARKDOWN = '# Agent Parsed Paper\n\nAgent body text.'
const CONTENT_LIST = JSON.stringify([
  { type: 'text', text: 'page zero', page_idx: 0 },
  { type: 'text', text: 'page one', page_idx: 1 },
  { type: 'text', text: 'page two', page_idx: 2 },
])

/** A stored-method ZIP shaped like a MinerU standard result archive. */
function standardResultZip() {
  return makeStoredZip([
    { name: 'full.md', data: STANDARD_MARKDOWN },
    { name: 'paper_content_list.json', data: CONTENT_LIST },
    { name: 'images/fig1.svg', data: '<svg id="fig1"/>' },
    { name: 'layout.json', data: '{"should":"not be extracted"}' },
  ])
}

/** JSON response helper. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Poll a predicate until it returns a truthy value or the timeout expires. */
async function waitFor(predicate, { timeout = 5000, interval = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * Build a fake MinerU HTTP implementation with counters and captured requests.
 * @param {{ apiBase: string, docId: string, alwaysRunning?: boolean,
 *           resumeBatchId?: string, resumeTaskId?: string }} options
 */
function createFakeMineru({
  apiBase,
  docId,
  alwaysRunning = false,
  resumeBatchId,
  resumeTaskId,
  standardRunningPolls = 1,
}) {
  const state = {
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
  function standardBatchId() {
    return state.submissions === 1 && resumeBatchId === undefined ? 'batch-1' : resumeBatchId ?? `batch-${state.submissions}`
  }
  async function fetchImpl(url, init = {}) {
    const method = (init.method ?? 'GET').toUpperCase()
    // Standard submit
    if (url === `${apiBase}/api/v4/file-urls/batch` && method === 'POST') {
      state.submissions += 1
      state.lastStandardBody = JSON.parse(String(init.body))
      state.lastSubmitHeaders = init.headers ?? {}
      const batchId = resumeBatchId !== undefined ? resumeBatchId : `batch-${state.submissions}`
      return jsonResponse({ code: 0, data: { batch_id: batchId, file_urls: [`https://upload.test/std-${state.submissions}`] } })
    }
    // Signed uploads
    if (url.startsWith('https://upload.test/')) {
      state.uploads += 1
      assert.equal(method, 'PUT')
      assert.equal(init.headers?.['content-type'], undefined, 'signed upload must not set content-type')
      assert.ok(Buffer.isBuffer(init.body), 'signed upload body must be raw bytes')
      return new Response(null, { status: 200 })
    }
    // Standard poll
    const standardPoll = /\/api\/v4\/extract-results\/batch\/(.+)$/.exec(url)
    if (standardPoll !== null) {
      state.standardPolls += 1
      if (standardPoll[1] === resumeBatchId) state.resumePolls += 1
      const runningPolls = resumeBatchId !== undefined ? 0 : standardRunningPolls
      const running = alwaysRunning === true || state.standardPolls <= runningPolls
      return jsonResponse({
        code: 0,
        data: {
          batch_id: standardPoll[1],
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

/** Create a fresh temp library with one uploaded PDF document. */
async function setup({ token = TOKEN } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-parse-'))
  const config = resolveConfig({
    dataDir,
    apiBase: 'https://api.mineru.test',
    pollIntervalMs: 10,
    maxConcurrentParses: 2,
    parseTimeoutMs: 5000,
  })
  const logger = { info() {}, warn() {}, error() {} }
  const store = createStore({ dataDir, logger })
  await store.init()
  const id = randomUUID()
  const tempPath = store.newTempPath(id)
  await writeFile(tempPath, Buffer.from('%PDF-1.4 fake paper bytes'))
  const meta = await store.createFromFile({ id, tempPath, originalName: 'paper.pdf' })
  return { dataDir, config, store, id, meta, logger }
}

/** Build a manager for a setup environment. */
function makeManager(env, fake, token = TOKEN) {
  return createParseManager({
    store: env.store,
    config: env.config,
    logger: env.logger,
    getToken: async () => (token === null ? undefined : token),
    fetchImpl: fake.fetchImpl,
  })
}

/** Clean up a test environment. */
async function teardown(env, ...managers) {
  for (const manager of managers) await manager.dispose()
  await env.store.dispose()
  await rm(env.dataDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------

test('standard flow: submit, upload, poll, unzip and persist parsed metadata', async () => {
  const env = await setup()
  const fake = createFakeMineru({ apiBase: env.config.apiBase, docId: env.id })
  const manager = makeManager(env, fake)
  try {
    const meta = env.store.get(env.id)
    const normalized = normalizeParseOptions(
      { engine: 'standard', pageRanges: '2,4-6', enableTable: false, language: 'en' },
      meta,
      { hasToken: true, maxUploadBytes: env.config.maxUploadBytes },
    )
    const started = await manager.start(env.id, normalized)
    assert.equal(started.status, 'parsing')
    assert.equal(started.parse.engine, 'standard')
    assert.equal(started.error, null)

    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current.status === 'parsed' ? current : null
      },
      { label: 'standard parse completion' },
    )
    assert.equal(final.status, 'parsed')
    assert.equal(final.error, null)
    assert.equal(final.parse.phase, null)
    assert.equal(final.parse.engine, 'standard')
    assert.equal(final.parse.modelVersion, 'vlm')
    assert.equal(final.parse.hasContentList, true)
    assert.equal(final.parse.pages, 3)
    assert.ok(final.parse.progress.extracted >= 1)
    assert.equal(final.parse.progress.total, 3)
    assert.match(final.title, /Attention Test Paper/, 'first heading becomes the default title')
    assert.equal(typeof final.parse.finishedAt, 'string')

    // Request shape captured by the fake.
    assert.equal(fake.state.submissions, 1)
    assert.equal(fake.state.uploads, 1)
    assert.ok(fake.state.standardPolls >= 2)
    assert.equal(fake.state.zipDownloads, 1)
    assert.equal(fake.state.lastSubmitHeaders.authorization, `Bearer ${TOKEN}`)
    const file = fake.state.lastStandardBody.files[0]
    assert.equal(file.data_id, env.id)
    assert.equal(file.name, 'paper.pdf')
    assert.equal(file.page_ranges, '2,4-6')
    assert.equal(file.is_ocr, false)
    assert.equal(fake.state.lastStandardBody.model_version, 'vlm')
    assert.equal(fake.state.lastStandardBody.language, 'en')
    assert.equal(fake.state.lastStandardBody.enable_table, false)

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
    await waitFor(() => env.store.get(env.id).status === 'parsed', { label: 'second parse' })
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
    const normalized = normalizeParseOptions({}, meta, {
      hasToken: false,
      maxUploadBytes: env.config.maxUploadBytes,
    })
    assert.equal(normalized.engine, 'agent')
    const started = await manager.start(env.id, normalized)
    assert.equal(started.parse.engine, 'agent')

    const final = await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current.status === 'parsed' ? current : null
      },
      { label: 'agent parse completion' },
    )
    assert.equal(final.parse.engine, 'agent')
    assert.equal(final.parse.hasContentList, false)
    assert.equal(final.parse.phase, null)
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
  const progressWrites = []
  const originalUpdate = env.store.update.bind(env.store)
  env.store.update = async (id, patch) => {
    if (patch?.parse && Object.keys(patch.parse).length === 1 && 'progress' in patch.parse) {
      progressWrites.push(patch.parse.progress)
    }
    return originalUpdate(id, patch)
  }
  try {
    const meta = env.store.get(env.id)
    const normalized = normalizeParseOptions({ engine: 'standard' }, meta, {
      hasToken: true,
      maxUploadBytes: env.config.maxUploadBytes,
    })
    await manager.start(env.id, normalized)
    await waitFor(() => env.store.get(env.id).status === 'parsed', {
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
    const normalized = normalizeParseOptions({ engine: 'standard' }, meta, {
      hasToken: true,
      maxUploadBytes: env.config.maxUploadBytes,
    })
    await manager.start(env.id, normalized)
    await waitFor(
      () => {
        const current = env.store.get(env.id)
        return current.parse?.phase === 'polling' ? current : null
      },
      { label: 'polling phase' },
    )
    const cancelled = await manager.cancel(env.id)
    assert.equal(cancelled.status, 'uploaded')
    assert.equal(cancelled.error, null)
    assert.equal(cancelled.parse.phase, null)
    assert.equal(cancelled.parse.batchId, null)

    // Source is still there, no parsed output was written.
    assert.equal(existsSync(await env.store.sourcePath(env.id)), true)
    assert.equal(existsSync(join(env.store.docDir(env.id), 'parsed')), false)

    await assert.rejects(manager.cancel(env.id), (error) => {
      assert.equal(error.code, 'bad-request')
      return true
    })
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
        return current.status === 'parsed' ? current : null
      },
      { label: 'resumed parse completion' },
    )
    assert.equal(final.status, 'parsed')
    assert.equal(final.parse.hasContentList, true)
    assert.equal(final.parse.pages, 3)
    assert.equal(fake.state.submissions, 0, 'resume must not resubmit the file')
    assert.equal(fake.state.uploads, 0, 'resume must not re-upload the file')
    assert.ok(fake.state.resumePolls >= 1)
    assert.equal(
      await readFile(join(env.store.parsedDir(env.id), 'full.md'), 'utf8'),
      STANDARD_MARKDOWN,
    )
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
        return current.status === 'parsed' ? current : null
      },
      { label: 'resumed agent parse completion' },
    )
    assert.equal(final.parse.engine, 'agent')
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
    assert.equal(current.status, 'failed')
    assert.match(current.error, /中断/)
    assert.equal(current.parse.phase, null)
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
    await assert.rejects(manager.start(randomUUID(), { engine: 'standard', params: {} }), (error) => {
      assert.equal(error.code, 'not-found')
      return true
    })
    const meta = env.store.get(env.id)
    const normalized = normalizeParseOptions({ engine: 'standard' }, meta, {
      hasToken: true,
      maxUploadBytes: env.config.maxUploadBytes,
    })
    await manager.start(env.id, normalized)
    await assert.rejects(manager.start(env.id, normalized), (error) => {
      assert.equal(error.code, 'conflict')
      return true
    })
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
    const normalized = normalizeParseOptions({ engine: 'standard' }, meta, {
      hasToken: true,
      maxUploadBytes: env.config.maxUploadBytes,
    })
    await manager.start(env.id, normalized)
    await waitFor(() => fake.state.standardPolls >= 1, { label: 'first poll' })
    await manager.dispose()
    // Already-disposed manager rejects new work but does not crash.
    await assert.rejects(manager.start(env.id, normalized), (error) => {
      assert.equal(error.code, 'host-error')
      return true
    })
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
async function seedParsedPaper(env) {
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
    version: 1,
    items: [{
      id: 'ann-1', blockKey: 'b0:deadbeef', start: 0, end: 5, quote: 'Page', color: 'yellow', note: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  })
}

/** Fake MinerU that serves a two-page-ranged repair archive. */
function createRepairFake({ apiBase, docId, fail = false, alwaysRunning = false }) {
  const state = { submissions: 0, polls: 0, zips: 0, lastStandardBody: null }
  const zip = makeStoredZip([
    { name: 'full.md', data: REPAIR_NEW_MARKDOWN },
    { name: 'repair_content_list.json', data: JSON.stringify(REPAIR_NEW_CONTENT_LIST) },
    { name: 'images/new.svg', data: '<svg id="new"/>' },
  ])
  async function fetchImpl(url, init = {}) {
    const method = (init.method ?? 'GET').toUpperCase()
    if (url === `${apiBase}/api/v4/file-urls/batch` && method === 'POST') {
      state.submissions += 1
      state.lastStandardBody = JSON.parse(String(init.body))
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
          batch_id: poll[1],
          extract_result: [{
            data_id: docId,
            file_name: 'paper.pdf',
            state: running ? 'running' : fail ? 'failed' : 'done',
            err_msg: fail ? 'repair failed on purpose' : '',
            ...(running || fail ? {} : { full_zip_url: 'https://cdn.test/repair.zip' }),
          }],
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
    assert.deepEqual(started.parse.repairPages, [2])
    assert.equal(started.parse.options.pageRanges, '2')
    assert.equal(fake.state.lastStandardBody, null, 'submit happens asynchronously')

    const final = await waitFor(() => {
      const current = env.store.get(env.id)
      return current.status === 'parsed' && current.parse.repair ? current : null
    }, { label: 'page repair completion' })
    assert.equal(final.status, 'parsed')
    assert.equal(final.error, null)
    assert.equal(final.parse.repairPages, null)
    assert.deepEqual(final.parse.repair.pages, [2])
    assert.deepEqual(final.parse.repair.failedPages, [])
    assert.equal(final.parse.pages, 3, 'total page count is preserved')
    assert.match(fake.state.lastStandardBody.files[0].page_ranges, /^2$/)
    assert.equal(fake.state.submissions, 1)

    const parsed = await env.store.readMarkdown(env.id)
    assert.ok(parsed.markdown.includes('recovered symbol q'))
    assert.ok(!parsed.markdown.includes('\ufffd'))
    assert.ok(parsed.markdown.includes('Page one introduction stays untouched.'))
    assert.ok(parsed.markdown.includes('Page three results stay untouched.'))
    assert.deepEqual(
      parsed.contentList.map((entry) => entry.page_idx),
      [0, 0, 0, 1, 1, 2, 2].slice(0, parsed.contentList.length),
    )
    // Old artifacts survive, new images are added.
    const parsedDir = env.store.parsedDir(env.id)
    assert.equal(await readFile(join(parsedDir, 'images', 'old.svg'), 'utf8'), '<svg id="old"/>')
    assert.equal(await readFile(join(parsedDir, 'images', 'new.svg'), 'utf8'), '<svg id="new"/>')
    // Annotations are untouched by a page-scoped repair.
    const annotations = await env.store.loadAnnotations(env.id)
    assert.equal(annotations.items.length, 1)
    assert.equal(annotations.items[0].id, 'ann-1')
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
    const final = await waitFor(() => {
      const current = env.store.get(env.id)
      return current.status === 'parsed' && current.parse.repairError ? current : null
    }, { label: 'repair failure state' })
    assert.match(final.parse.repairError, /repair failed/i)
    assert.equal(final.parse.repairPages, null)
    assert.equal(final.error, null, 'the document stays parsed, not failed')
    const parsed = await env.store.readMarkdown(env.id)
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
    assert.equal(cancelled.parse.repairPages, null)
    const parsed = await env.store.readMarkdown(env.id)
    assert.equal(parsed.markdown, REPAIR_OLD_MARKDOWN)
  } finally {
    await teardown(env, manager)
  }
})
