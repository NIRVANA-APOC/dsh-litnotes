/**
 * Unit tests for the shared operation service (`lib/service.js`): token
 * lifecycle, preferences, translation routing (Host translator → LLM
 * fallback), tool helpers (bounded reads, quote-located annotations) and
 * URL import limits.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearToken as resetMemoryToken, resolveConfig } from '../../lib/config.js'
import { createService } from '../../lib/service.js'
import { createStore } from '../../lib/store.js'
import { WireError } from '../../lib/wire.js'

/** In-memory credentials service matching the Host ApiKeyRecord API. */
function makeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async describeRecord(key) {
      return { configured: records.has(key), kind: 'api-key', writable: true }
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

/** Create a library + service over a temp data directory. */
async function setup({
  credentials,
  translator,
  llm,
  defaultModel,
  fetchImpl,
  config: configOverrides = {},
} = {}) {
  // Reset the module-level in-memory token fallback so tests stay isolated.
  await resetMemoryToken(undefined)
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-service-'))
  const config = resolveConfig({ dataDir, apiBase: 'https://api.mineru.test', ...configOverrides })
  const store = createStore({ dataDir })
  await store.init()
  const managerCalls = []
  const manager = {
    async start(id, normalized) {
      managerCalls.push({ id, normalized })
      return store.update(id, {
        status: 'parsing',
        error: null,
        parse: { engine: normalized.engine, phase: 'submitting' },
      })
    },
    async cancel(id) {
      return store.update(id, { status: 'uploaded', error: null, parse: { phase: null } })
    },
    async resume() {},
    async dispose() {},
  }
  const service = createService({
    store,
    manager,
    config,
    logger: { warn() {}, info() {} },
    hostVersion: '0.1.0+host',
    getCredentials: () => credentials,
    getTranslator: () => translator,
    getLlm: () => llm,
    getDefaultModel: () => defaultModel,
    fetchImpl,
  })
  return { dataDir, config, store, service, managerCalls }
}

/** Create an uploaded document in the store. */
async function addDocument(env, { name = 'paper.pdf', bytes = '%PDF-1.4 test', title } = {}) {
  const id = randomUUID()
  const tempPath = env.store.newTempPath(id)
  await writeFile(tempPath, bytes)
  return env.store.createFromFile({ id, tempPath, originalName: name, title })
}

/** Write a parsed markdown document. */
async function addParsedDocument(env, markdown) {
  const meta = await addDocument(env)
  const parsedDir = env.store.parsedDir(meta.id)
  await mkdir(parsedDir, { recursive: true })
  await writeFile(join(parsedDir, 'full.md'), markdown)
  return env.store.update(meta.id, { status: 'parsed' })
}

/** Teardown a service environment. */
async function teardown(env) {
  await env.store.dispose()
  await rm(env.dataDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Status, token and preferences
// ---------------------------------------------------------------------------

test('token lifecycle: stored, never exposed, clearable', async () => {
  const credentials = makeCredentials()
  const env = await setup({ credentials })
  try {
    const token = 'unit-test-token-abcdef-123456'
    let status = await env.service.getStatus()
    assert.equal(status.tokenConfigured, false)
    assert.equal(status.tokenPersistent, true)

    const saved = await env.service.setToken(token)
    assert.equal(saved.tokenConfigured, true)
    assert.equal(saved.tokenPersistent, true)
    assert.equal(credentials.records.get('dsh-litnotes/mineru-token').key, token)
    assert.equal(credentials.records.get('dsh-litnotes/mineru-token').kind, 'api-key')

    status = await env.service.getStatus()
    assert.equal(status.tokenConfigured, true)
    assert.equal(JSON.stringify(status).includes(token), false, 'status never contains the token')
    const settings = await env.service.getSettings()
    assert.equal(settings.tokenConfigured, true)
    assert.equal(JSON.stringify(settings).includes(token), false, 'settings never contains the token')

    assert.deepEqual(await env.service.clearToken(), { tokenConfigured: false, tokenPersistent: false })
    assert.equal(credentials.records.has('dsh-litnotes/mineru-token'), false)
    status = await env.service.getStatus()
    assert.equal(status.tokenConfigured, false)
  } finally {
    await teardown(env)
  }
})

test('setToken validates the token format and status works without credentials', async () => {
  const env = await setup({ credentials: undefined })
  try {
    await assert.rejects(env.service.setToken('  '), (error) => {
      assert.ok(error instanceof WireError)
      assert.equal(error.code, 'bad-request')
      return true
    })
    await assert.rejects(env.service.setToken('has whitespace in it'), /Token/)
    const saved = await env.service.setToken('memory-token-123456789')
    assert.equal(saved.tokenConfigured, true)
    assert.equal(saved.tokenPersistent, false, 'no credential service means session-only token')
    const status = await env.service.getStatus()
    assert.equal(status.tokenConfigured, true)
    assert.equal(status.tokenPersistent, false)
    assert.equal(JSON.stringify(status).includes('memory-token-123456789'), false)
  } finally {
    await teardown(env)
  }
})

test('preferences merge, validate and persist host-side', async () => {
  const env = await setup()
  try {
    const initial = await env.service.getStatus()
    assert.equal(initial.preferences.readingMode, 'original')
    assert.equal(initial.preferences.targetLanguage, 'zh')

    const updated = await env.service.updatePreferences({
      readingMode: 'bilingual',
      readingScale: 1.12,
      defaultEngine: 'agent',
      showPageMarks: false,
      bogusKey: 'ignored',
    })
    assert.equal(updated.preferences.readingMode, 'bilingual')
    assert.equal(updated.preferences.readingScale, 1.12)
    assert.equal(updated.preferences.defaultEngine, 'agent')
    assert.equal(updated.preferences.showPageMarks, false)
    assert.equal('bogusKey' in updated.preferences, false)

    // Invalid values fall back to the defaults instead of failing.
    const fallback = await env.service.updatePreferences({ readingMode: 'weird', readingScale: 99 })
    assert.equal(fallback.preferences.readingMode, 'original')
    assert.equal(fallback.preferences.readingScale, 1)

    // Persisted for the next host boot.
    const onDisk = JSON.parse(await readFile(join(env.dataDir, 'preferences.json'), 'utf8'))
    assert.equal(onDisk.defaultEngine, 'agent')

    const second = await env.service.getSettings()
    assert.equal(second.preferences.readingMode, 'original')
    assert.ok(Array.isArray(second.providers))
    assert.equal(second.providers[0].id, 'auto')
    assert.equal(second.currentProvider, 'auto')
    await assert.rejects(env.service.updatePreferences('nope'), /preferences 必须是对象/)
  } finally {
    await teardown(env)
  }
})

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

test('translate prefers the Host translator anonymous provider', async () => {
  const translatorCalls = []
  const translator = {
    async availableProviders() {
      return ['google', 'bing']
    },
    resolve(request) {
      translatorCalls.push({ kind: 'resolve', request })
      return { ...request, provider: request.provider ?? 'google', sourceLanguage: request.sourceLanguage ?? 'auto' }
    },
    async translate(spec) {
      translatorCalls.push({ kind: 'translate', spec })
      return `translated: ${spec.text}`
    },
  }
  const env = await setup({ translator })
  try {
    const result = await env.service.translate({ text: 'hello world', targetLanguage: 'zh', provider: 'bing' })
    assert.deepEqual(result, { translation: 'translated: hello world', provider: 'bing', targetLanguage: 'zh' })
    assert.equal(translatorCalls[0].request.provider, 'bing')

    const auto = await env.service.translate({ text: 'auto', targetLanguage: 'zh' })
    assert.equal(auto.provider, 'google', 'auto prefers google when available')
  } finally {
    await teardown(env)
  }
})

test('translate falls back to the default LLM with a translate-only prompt', async () => {
  const translator = {
    async availableProviders() {
      return ['google']
    },
    resolve() {
      throw new Error('translator exploded')
    },
    async translate() {
      throw new Error('unreachable')
    },
  }
  const streamCalls = []
  const llm = {
    stream(options) {
      streamCalls.push(options)
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '你' }
        yield { type: 'text-delta', index: 0, text: '好' }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  }
  const env = await setup({ translator, llm, defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  try {
    const result = await env.service.translate({
      text: 'hello',
      targetLanguage: 'zh',
      sourceLanguage: 'en',
    })
    assert.equal(result.translation, '你好')
    assert.equal(result.provider, 'llm')
    assert.equal(result.model, 'deepseek-flash')
    assert.equal(result.targetLanguage, 'zh')
    assert.equal(streamCalls.length, 1)
    const options = streamCalls[0]
    assert.equal(options.provider, 'deepseek-official')
    assert.equal(options.model, 'deepseek-flash')
    assert.equal(options.temperature, 0)
    assert.match(options.system, /translation/i)
    const prompt = options.messages[0].content[0].text
    assert.match(prompt, /Target language: zh/)
    assert.match(prompt, /hello/)
  } finally {
    await teardown(env)
  }
})

test('translate reports translate-unavailable when no backend can serve it', async () => {
  const env = await setup()
  try {
    await assert.rejects(env.service.translate({ text: 'hello' }), (error) => {
      assert.equal(error.code, 'translate-unavailable')
      return true
    })
    await assert.rejects(env.service.translate({ text: '   ' }), /缺少待翻译文本/)
    await assert.rejects(env.service.translate({ text: 'x'.repeat(20001) }), /超过/)
  } finally {
    await teardown(env)
  }
})

test('paid-only translator providers are not used without a Session; LLM fallback runs', async () => {
  const translator = {
    async availableProviders() {
      return ['deepseek-account']
    },
    resolve() {
      throw new Error('paid route requires a session')
    },
    async translate() {
      throw new Error('unreachable')
    },
  }
  let streamed = 0
  const llm = {
    stream() {
      streamed += 1
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: 'ok' }
      })()
    },
  }
  const env = await setup({ translator, llm, defaultModel: { provider: 'p', model: 'm' } })
  try {
    const result = await env.service.translate({ text: 'x', targetLanguage: 'en' })
    assert.equal(result.translation, 'ok')
    assert.equal(streamed, 1)
  } finally {
    await teardown(env)
  }
})

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

test('toolRead returns bounded slices with nextOffset and caps maxChars', async () => {
  const markdown = 'a'.repeat(3000)
  const env = await setup({ config: { toolMaxChars: 1200 } })
  try {
    const document = await addParsedDocument(env, markdown)
    const first = await env.service.toolRead(document.id, { offset: 10, maxChars: 20 })
    assert.equal(first.text, 'a'.repeat(20))
    assert.equal(first.offset, 10)
    assert.equal(first.nextOffset, 30)
    assert.equal(first.totalChars, 3000)
    assert.equal(first.truncated, true)

    // The configured cap wins over an oversized maxChars request.
    const capped = await env.service.toolRead(document.id, { offset: 0, maxChars: 10000 })
    assert.equal(capped.text.length, 1200)
    assert.equal(capped.nextOffset, 1200)

    const end = await env.service.toolRead(document.id, { offset: 2990, maxChars: 100 })
    assert.equal(end.text.length, 10)
    assert.equal(end.truncated, false)
  } finally {
    await teardown(env)
  }
})

test('toolAnnotate locates a quote, derives the block key and round-trips removal', async () => {
  const markdown = '# A Title\n\nA unique sentence appears here.\n\nSecond paragraph.'
  const env = await setup()
  try {
    const document = await addParsedDocument(env, markdown)
    const added = await env.service.toolAnnotate(document.id, {
      quote: 'unique sentence',
      note: 'important',
      color: 'sky',
    })
    assert.match(added.annotation.blockKey, /^b\d+:[0-9a-f]{8}$/)
    assert.equal(added.annotation.note, 'important')
    assert.equal(added.annotation.color, 'sky')
    assert.equal(typeof added.annotation.start, 'number')
    assert.equal(added.annotation.end - added.annotation.start, 'unique sentence'.length)
    assert.equal(added.count, 1)

    const listed = await env.service.toolAnnotations(document.id)
    assert.equal(listed.annotations.length, 1)

    // An explicit blockKey path also works.
    const explicit = await env.service.toolAnnotate(document.id, {
      blockKey: 'b9:0123abcd',
      start: 1,
      end: 4,
      quote: 'abc',
      note: '',
      color: 'sage',
    })
    assert.equal(explicit.count, 2)
    assert.equal(explicit.annotation.blockKey, 'b9:0123abcd')

    const removed = await env.service.toolUnannotate(document.id, added.annotation.id)
    assert.equal(removed.removed, true)
    assert.equal(removed.count, 1)

    await assert.rejects(env.service.toolUnannotate(document.id, added.annotation.id), (error) => {
      assert.equal(error.code, 'not-found')
      return true
    })
    await assert.rejects(env.service.toolAnnotate(document.id, { quote: 'not in the document at all' }), /未找到/)
    await assert.rejects(env.service.toolAnnotate(document.id, {}), /blockKey 或 quote/)
  } finally {
    await teardown(env)
  }
})

test('toolList reports compact rows with status/pages/engine', async () => {
  const env = await setup()
  try {
    const document = await addParsedDocument(env, '# Title\n\nBody.')
    await env.store.update(document.id, {
      status: 'parsed',
      parse: { engine: 'standard', pages: 12, phase: null },
    })
    const list = await env.service.toolList()
    assert.equal(list.total, 1)
    assert.deepEqual(
      { id: list.documents[0].id, pages: list.documents[0].pages, engine: list.documents[0].engine },
      { id: document.id, pages: 12, engine: 'standard' },
    )
    // A parsing document exposes live progress + the upstream MinerU phase so
    // the Agent tool can report how far a long pipeline/OCR parse has come.
    await env.store.update(document.id, {
      status: 'parsing',
      parse: { engine: 'standard', phase: 'polling', remoteState: 'pending', progress: { extracted: 3, total: 12 } },
    })
    const parsingList = await env.service.toolList()
    assert.equal(parsingList.documents[0].remoteState, 'pending')
    assert.deepEqual(parsingList.documents[0].progress, { extracted: 3, total: 12 })

    const detail = await env.service.toolGet(document.id)
    assert.equal(detail.document.id, document.id)
    assert.deepEqual(detail.annotations, [])
  } finally {
    await teardown(env)
  }
})

test('startParse normalizes options and surfaces token-missing early', async () => {
  const env = await setup()
  try {
    const document = await addDocument(env)
    await assert.rejects(env.service.startParse(document.id, { engine: 'standard' }), (error) => {
      assert.equal(error.code, 'token-missing')
      return true
    })
    const started = await env.service.startParse(document.id, {})
    assert.equal(started.document.status, 'parsing')
    assert.equal(env.managerCalls[0].normalized.engine, 'agent')
  } finally {
    await teardown(env)
  }
})

// ---------------------------------------------------------------------------
// URL import
// ---------------------------------------------------------------------------

test('importUrl downloads a supported document into the library', async () => {
  const bytes = Buffer.from('%PDF-1.4 remote paper')
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://example.test/files/remote.pdf?token=abc')
    assert.equal(init.method, 'GET')
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="remote.pdf"',
        'content-length': String(bytes.length),
      },
    })
  }
  const env = await setup({ fetchImpl })
  try {
    const { document } = await env.service.importUrl({ url: 'https://example.test/files/remote.pdf?token=abc' })
    assert.equal(document.originalName, 'remote.pdf')
    assert.equal(document.status, 'uploaded')
    assert.equal(document.title, 'remote')
    const source = await readFile(await env.store.sourcePath(document.id), 'utf8')
    assert.equal(source, bytes.toString())
  } finally {
    await teardown(env)
  }
})

test('importUrl rejects unsupported types and oversized downloads', async () => {
  const textFetch = async () =>
    new Response(Buffer.from('plain text'), {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' },
    })
  const env = await setup({ fetchImpl: textFetch })
  try {
    await assert.rejects(env.service.importUrl({ url: 'https://example.test/notes.txt' }), (error) => {
      assert.equal(error.code, 'unsupported-type')
      return true
    })
    await assert.rejects(env.service.importUrl({ url: 'ftp://example.test/a.pdf' }), (error) => {
      assert.equal(error.code, 'bad-request')
      return true
    })
  } finally {
    await teardown(env)
  }

  const bigFetch = async () =>
    new Response(null, {
      status: 200,
      headers: { 'content-length': String(1024 * 1024 * 1024), 'content-disposition': 'attachment; filename="big.pdf"' },
    })
  const bigEnv = await setup({ fetchImpl: bigFetch })
  try {
    await assert.rejects(bigEnv.service.importUrl({ url: 'https://example.test/big.pdf' }), (error) => {
      assert.equal(error.code, 'too-large')
      return true
    })
  } finally {
    await teardown(bigEnv)
  }
})

test('healthPing appends a diagnostics entry', async () => {
  const env = await setup()
  try {
    const ack = await env.service.healthPing({ clientVersion: '1.2.3', event: 'active', detail: { panel: 'mineru' } })
    assert.deepEqual({ ok: ack.ok, hostVersion: ack.hostVersion }, { ok: true, hostVersion: '0.1.0+host' })
    assert.equal(typeof ack.receivedAt, 'string')
    const lines = (await readFile(join(env.dataDir, 'diagnostics', 'client.log'), 'utf8'))
      .split('\n')
      .filter(Boolean)
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.event, 'active')
    assert.equal(entry.clientVersion, '1.2.3')
    assert.match(entry.detail, /mineru/)
  } finally {
    await teardown(env)
  }
})

test('library removal keeps no files behind and health counts follow', async () => {
  const env = await setup()
  try {
    const document = await addParsedDocument(env, '# Title\n\nBody.')
    let status = await env.service.getStatus()
    assert.equal(status.counts.total, 1)
    assert.equal(status.counts.parsed, 1)
    assert.equal((await env.service.readMarkdown(document.id)).markdown, '# Title\n\nBody.')
    assert.deepEqual(await env.service.removeDocument(document.id), { removed: true })
    status = await env.service.getStatus()
    assert.equal(status.counts.total, 0)
    await assert.rejects(env.service.readMarkdown(document.id), (error) => {
      assert.equal(error.code, 'not-found')
      return true
    })
  } finally {
    await teardown(env)
  }
})
