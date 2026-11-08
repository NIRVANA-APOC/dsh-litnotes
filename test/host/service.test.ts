/**
 * Unit tests for the shared operation service (`src/host/service.ts`): token
 * lifecycle, preferences, translation routing (Host translator → LLM fallback),
 * tool helpers (bounded reads, quote-located annotations), URL import limits,
 * local-engine wiring, annotation concurrency and the AI bridge.
 *
 * Ported from the frozen 1.0.0 `.mjs` suites (`service.test.mjs` plus the
 * service half of `qa-fixes.test.mjs`); response-shape assertions follow the
 * 1.0.0 contracts (documented per case).
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { expect } from 'vitest'

import { clearToken as resetMemoryToken, resolveConfig, type CredentialsLike } from '../../src/host/config.ts'
import type {
  AiServicesApi,
  LocalConfig,
  LocalEngineApi,
  ParseManagerApi,
  ParsePlan,
  ParseStartRequest,
  ServiceApi,
} from '../../src/host/contracts.ts'
import type { LlmService } from '../../src/host/host-services.ts'
import { normalizeParseOptions } from '../../src/host/parse/mineru.ts'
import { createService, type ServiceDeps, type ToolAnnotationInput } from '../../src/host/service.ts'
import { createStore } from '../../src/host/store/index.ts'
import { WireError } from '../../src/host/wire.ts'
import type { DocumentMeta, LocalCapabilities, ParseState } from '../../src/shared/model.ts'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'

/** Temporary stores created by the current test. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await resetMemoryToken(undefined)
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

/** In-memory credentials service matching the Host ApiKeyRecord API. */
function makeCredentials(): CredentialsLike & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>()
  return {
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
}

/** A fake translator matching the Host translator service contract. */
export function makeTranslator(
  providers: readonly ('google' | 'bing' | 'deepseek-account' | 'deepseek-official')[] = ['google', 'bing'],
): {
  availableProviders: () => Promise<readonly typeof providers[number][]>
  resolve: (request: { text: string; targetLanguage: string; sourceLanguage?: string; provider?: string }) => {
    text: string
    targetLanguage: string
    sourceLanguage: string
    provider: string
  }
  translate: (spec: { text: string; provider: string }) => Promise<string>
  calls: Array<{ kind: string; value: unknown }>
} {
  const calls: Array<{ kind: string; value: unknown }> = []
  return {
    calls,
    availableProviders: async () => providers,
    resolve(request) {
      calls.push({ kind: 'resolve', value: request })
      return {
        text: request.text,
        targetLanguage: request.targetLanguage,
        sourceLanguage: request.sourceLanguage ?? 'auto',
        provider: request.provider ?? 'google',
      }
    },
    async translate(spec) {
      calls.push({ kind: 'translate', value: spec })
      return `translated: ${spec.text}`
    },
  }
}

/** A fake local engine exposing the snapshot/supports contract the service probes. */
export function makeLocalEngine(
  options: {
    supports?: (meta: { originalName?: string; ext?: string }) => {
      supported: boolean
      provider: string | null
      reason?: string
    }
  } = {},
): LocalEngineApi {
  const supports =
    options.supports ??
    ((meta: { originalName?: string; ext?: string }) =>
      /\.pdf$/i.test(String(meta.originalName ?? meta.ext ?? ''))
        ? { supported: true, provider: 'builtin' }
        : { supported: false, provider: null, reason: 'unsupported extension' })
  const localConfig = {
    enabled: true,
    maxPages: 500,
    maxPdfBytes: 200 * 1024 * 1024,
    maxTextBytes: 32 * 1024 * 1024,
    minCharsPerPage: 30,
    maxParagraphChars: 4000,
    keepContentList: true,
    timeoutMs: 120000,
    maxOfficePdfBytes: 100 * 1024 * 1024,
  }
  const snapshot: LocalCapabilities & { configuration: LocalConfig } = {
    enabled: true,
    available: true,
    recommended: 'builtin',
    providers: [
      { id: 'builtin', available: true, version: 'pdfjs-dist/5.4.449' },
      { id: 'system:officeToPdf', available: false, version: '', reason: 'office-to-pdf is not mounted' },
    ],
    capabilities: { textLayerPdf: true, office: false, images: false, html: false },
    configuration: localConfig,
  }
  return {
    config: localConfig,
    providers: { builtin: 'builtin', office: 'system:officeToPdf' },
    snapshot: () => snapshot,
    supports,
    plan: () => ({ provider: 'builtin', params: {} }),
    extract: async () => {
      throw new Error('extract should not be called by these tests')
    },
  }
}

/** A mutable view of the read-only `AiServicesApi` for test fakes. */
type MutableAiBundle = { -readonly [K in keyof AiServicesApi]: AiServicesApi[K] }

/** Build a minimal AI bundle whose engines are all fakes. */
function makeAiBundle(overrides: Partial<MutableAiBundle> = {}): MutableAiBundle {
  const unavailable = async (): Promise<never> => {
    throw new Error('not used by this test')
  }
  return {
    llm: {
      available: () => true,
      route: () => null,
      async *streamText() {},
      async completeText() {
        return ''
      },
    },
    retriever: {
      buildIndex: () => {},
      context: () => ({
        blocks: [],
        outline: [],
        sections: [],
        usedChars: 0,
        totalBlocks: 0,
      }),
      search: () => [],
      blocks: () => [],
      invalidate: () => {},
    },
    chat: {
      history: unavailable,
      clear: unavailable,
      stream: async function* () {},
    },
    graph: {
      docGraph: () => ({ graph: null } as never),
      buildDocGraph: async function* () {},
      mergeDocKnowledge: unavailable,
      updateDocGraph: async (documentId, patch) =>
        ({ scope: 'document', documentId, nodes: patch.nodes ?? [], edges: [], stats: { nodes: 0, edges: 0 } }) as never,
      libraryGraph: unavailable,
      rebuildLibraryGraph: async function* () {},
    },
    deepread: {
      get: async () => null,
      run: async function* () {
        yield { type: 'start', model: { provider: 'fake-provider', model: 'fake-model' }, language: 'zh' } as never
        yield { type: 'progress', phase: 'mapping', done: 0, total: 1 } as never
        yield { type: 'done' } as never
      },
    },
    available: true,
    version: '0.0.0',
    ...overrides,
  }
}

/** Create a library + service over a temp data directory. */
async function setup(
  options: {
    credentials?: CredentialsLike
    translator?: ReturnType<typeof makeTranslator>
    llm?: LlmService
    defaultModel?: { provider: string; model: string }
    fetchImpl?: typeof fetch
    localEngine?: LocalEngineApi
    ai?: MutableAiBundle
    config?: Record<string, unknown>
  } = {},
): Promise<{
  dataDir: string
  config: ReturnType<typeof resolveConfig>
  store: ReturnType<typeof createStore>
  service: ServiceApi
  managerCalls: Array<{ id: string; request: ParseStartRequest }>
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-service-'))
  const config = resolveConfig({ dataDir, apiBase: 'https://api.mineru.test', ...options.config })
  const store = createStore({ dataDir })
  cleanups.push(async () => {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })
  await store.init()
  const managerCalls: Array<{ id: string; request: ParseStartRequest }> = []
  const manager: ParseManagerApi = {
    async start(id: string, request: ParseStartRequest): Promise<DocumentMeta> {
      managerCalls.push({ id, request })
      const plan = request as ParsePlan
      const parse: Partial<ParseState> = { engine: plan.engine ?? null, phase: 'submitting' }
      return store.update(id, { status: 'parsing', error: null, parse })
    },
    async cancel(id: string): Promise<DocumentMeta> {
      return store.update(id, { status: 'uploaded', error: null, parse: { phase: null } })
    },
    resume: () => {},
    async dispose() {},
  }
  const deps: ServiceDeps = {
    store,
    manager,
    config,
    logger: { warn() {}, info() {} },
    hostVersion: '0.1.0+host',
    getCredentials: () => options.credentials,
    getTranslator: () => options.translator,
    getLlm: () => options.llm,
    getDefaultModel: () => options.defaultModel,
    getAi: options.ai === undefined ? undefined : async () => options.ai as AiServicesApi,
    fetchImpl: options.fetchImpl,
    localEngine: options.localEngine,
    normalizeParseOptions,
  }
  const service = createService(deps)
  return { dataDir, config, store, service, managerCalls }
}

/** Create an uploaded document in the store. */
async function addDocument(
  env: { store: ReturnType<typeof createStore> },
  options: { name?: string; bytes?: string; title?: string } = {},
): Promise<DocumentMeta> {
  const id = randomUUID()
  const tempPath = env.store.newTempPath(id)
  await writeFile(tempPath, options.bytes ?? '%PDF-1.4 test')
  return env.store.createFromFile({
    id,
    tempPath,
    originalName: options.name ?? 'paper.pdf',
    title: options.title,
  })
}

/** Write a parsed markdown document. */
async function addParsedDocument(
  env: { store: ReturnType<typeof createStore> },
  markdown: string,
): Promise<DocumentMeta> {
  const meta = await addDocument(env)
  const parsedDir = env.store.parsedDir(meta.id)
  await mkdir(parsedDir, { recursive: true })
  await writeFile(join(parsedDir, 'full.md'), markdown)
  return env.store.update(meta.id, { status: 'parsed' })
}

/** Quote-located annotation call (the wire contract types the block-key path). */
function annotate(service: ServiceApi, id: string, input: ToolAnnotationInput) {
  return service.toolAnnotate(id, input as unknown as Parameters<ServiceApi['toolAnnotate']>[1])
}

// ---------------------------------------------------------------------------
// Status, token and preferences
// ---------------------------------------------------------------------------

test('token lifecycle: stored, never exposed, clearable', async () => {
  const credentials = makeCredentials()
  const env = await setup({ credentials })
  const token = 'unit-test-token-abcdef-123456'
  let status = await env.service.getStatus()
  expect(status.tokenConfigured).toBe(false)
  expect(status.tokenPersistent).toBe(true)

  const saved = await env.service.setToken(token)
  expect(saved.tokenConfigured).toBe(true)
  expect(saved.tokenPersistent).toBe(true)
  const record = credentials.records.get('dsh-litnotes/mineru-token') as { key?: string; kind?: string }
  expect(record.key).toBe(token)
  expect(record.kind).toBe('api-key')

  status = await env.service.getStatus()
  expect(status.tokenConfigured).toBe(true)
  expect(JSON.stringify(status).includes(token)).toBe(false)
  const settings = await env.service.getSettings()
  expect(settings.tokenConfigured).toBe(true)
  expect(JSON.stringify(settings).includes(token)).toBe(false)

  expect(await env.service.clearToken()).toEqual({ tokenConfigured: false, tokenPersistent: false })
  expect(credentials.records.has('dsh-litnotes/mineru-token')).toBe(false)
  status = await env.service.getStatus()
  expect(status.tokenConfigured).toBe(false)
})

test('setToken validates the token format and status works without credentials', async () => {
  const env = await setup({ credentials: undefined })
  await expect(env.service.setToken('  ')).rejects.toBeInstanceOf(WireError)
  await expect(env.service.setToken('  ')).rejects.toMatchObject({ code: 'bad-request' })
  await expect(env.service.setToken('has whitespace in it')).rejects.toThrow(/Token/)
  const saved = await env.service.setToken('memory-token-123456789')
  expect(saved.tokenConfigured).toBe(true)
  expect(saved.tokenPersistent).toBe(false)
  const status = await env.service.getStatus()
  expect(status.tokenConfigured).toBe(true)
  expect(status.tokenPersistent).toBe(false)
  expect(JSON.stringify(status).includes('memory-token-123456789')).toBe(false)
})

test('preferences merge, validate and persist host-side', async () => {
  const env = await setup()
  const initial = await env.service.getStatus()
  expect(initial.preferences.readingMode).toBe('original')
  expect(initial.preferences.targetLanguage).toBe('zh')

  const updated = await env.service.updatePreferences({
    readingMode: 'bilingual',
    readingScale: 1.12,
    defaultEngine: 'agent',
    showPageMarks: false,
    bogusKey: 'ignored',
  } as never)
  expect(updated.preferences.readingMode).toBe('bilingual')
  expect(updated.preferences.readingScale).toBe(1.12)
  expect(updated.preferences.defaultEngine).toBe('agent')
  expect(updated.preferences.showPageMarks).toBe(false)
  expect('bogusKey' in updated.preferences).toBe(false)

  // Invalid values fall back to the defaults instead of failing.
  const fallback = await env.service.updatePreferences({ readingMode: 'weird', readingScale: 99 } as never)
  expect(fallback.preferences.readingMode).toBe('original')
  expect(fallback.preferences.readingScale).toBe(1)

  // Persisted for the next host boot.
  const onDisk = JSON.parse(await readFile(join(env.dataDir, 'preferences.json'), 'utf8')) as {
    defaultEngine?: string
  }
  expect(onDisk.defaultEngine).toBe('agent')

  const second = await env.service.getSettings()
  expect(second.preferences.readingMode).toBe('original')
  expect(Array.isArray(second.providers)).toBe(true)
  expect(second.providers[0]?.id).toBe('auto')
  await expect(env.service.updatePreferences('nope' as never)).rejects.toThrow(/preferences 必须是对象/)
})

test('getStatus reports the AI availability snapshot', async () => {
  const env = await setup({ ai: makeAiBundle() })
  const status = await env.service.getStatus()
  expect(status.ai.available).toBe(true)
  expect(status.ai.graph).toBe(true)
  expect(status.ai.route).toBeNull()
  expect(status.hostVersion).toBe('0.1.0+host')
  expect(typeof status.version).toBe('string')
  expect(status.dataDirDisplay.startsWith('~') || status.dataDirDisplay.startsWith('/')).toBe(true)

  const unavailableEnv = await setup()
  const unavailable = await unavailableEnv.service.getStatus()
  expect(unavailable.ai.available).toBe(false)
  expect(unavailable.ai.reason).toBe('ai-unavailable')
})

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

test('translate prefers the Host translator anonymous provider', async () => {
  const translator = makeTranslator()
  const env = await setup({ translator })
  const result = await env.service.translate({ text: 'hello world', targetLanguage: 'zh', provider: 'bing' })
  expect(result).toEqual({ translation: 'translated: hello world', provider: 'bing', targetLanguage: 'zh' })
  expect(translator.calls[0]?.value).toMatchObject({ provider: 'bing' })

  const auto = await env.service.translate({ text: 'auto', targetLanguage: 'zh' })
  expect(auto.provider).toBe('google')
})

test('translate falls back to the default LLM with a translate-only prompt', async () => {
  const translator = makeTranslator(['google'])
  translator.resolve = () => {
    throw new Error('translator exploded')
  }
  const streamCalls: unknown[] = []
  const llm: LlmService = {
    stream(options) {
      streamCalls.push(options)
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' } as never
        yield { type: 'text-delta', index: 0, text: '你' }
        yield { type: 'text-delta', index: 0, text: '好' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const env = await setup({
    translator,
    llm,
    defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  const result = await env.service.translate({ text: 'hello', targetLanguage: 'zh', sourceLanguage: 'en' })
  expect(result.translation).toBe('你好')
  expect(result.provider).toBe('llm')
  // The LLM fallback reports the model it used (frozen 1.0.0 wire field).
  expect(result.model).toBe('deepseek-flash')
  expect(result.targetLanguage).toBe('zh')
  expect(streamCalls.length).toBe(1)
  const options = streamCalls[0] as {
    provider: string
    model: string
    temperature: number
    system: string
    messages: Array<{ content: Array<{ text: string }> }>
  }
  expect(options.provider).toBe('deepseek-official')
  expect(options.model).toBe('deepseek-flash')
  expect(options.temperature).toBe(0)
  expect(options.system).toMatch(/translation/i)
  const prompt = options.messages[0]?.content[0]?.text ?? ''
  expect(prompt).toMatch(/Target language: zh/)
  expect(prompt).toMatch(/hello/)
})

test('translate reports translate-unavailable when no backend can serve it', async () => {
  const env = await setup()
  await expect(env.service.translate({ text: 'hello' })).rejects.toMatchObject({
    code: 'translate-unavailable',
  })
  await expect(env.service.translate({ text: '   ' })).rejects.toThrow(/缺少待翻译文本/)
  await expect(env.service.translate({ text: 'x'.repeat(20001) })).rejects.toThrow(/超过/)
})

test('paid-only translator providers are not used without a Session; LLM fallback runs', async () => {
  const translator = makeTranslator(['deepseek-account'])
  let streamed = 0
  const llm: LlmService = {
    stream() {
      streamed += 1
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: 'ok' }
      })()
    },
  }
  const env = await setup({ translator, llm, defaultModel: { provider: 'p', model: 'm' } })
  const result = await env.service.translate({ text: 'x', targetLanguage: 'en' })
  expect(result.translation).toBe('ok')
  expect(streamed).toBe(1)
  expect(translator.calls.some((call) => call.kind === 'translate')).toBe(false)
})

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

test('toolRead returns bounded slices with nextOffset and caps maxChars', async () => {
  const markdown = 'a'.repeat(3000)
  const env = await setup({ config: { toolMaxChars: 1200 } })
  const document = await addParsedDocument(env, markdown)
  const first = await env.service.toolRead(document.id, { offset: 10, maxChars: 20 })
  expect(first.markdown).toBe('a'.repeat(20))
  expect(first.offset).toBe(10)
  expect(first.nextOffset).toBe(30)
  expect(first.totalChars).toBe(3000)
  expect(first.truncated).toBe(true)
  expect(first.documentId).toBe(document.id)
  expect(typeof first.title).toBe('string')

  // The configured cap wins over an oversized maxChars request.
  const capped = await env.service.toolRead(document.id, { offset: 0, maxChars: 10000 })
  expect(capped.markdown.length).toBe(1200)
  expect(capped.nextOffset).toBe(1200)

  const end = await env.service.toolRead(document.id, { offset: 2990, maxChars: 100 })
  expect(end.markdown.length).toBe(10)
  expect(end.truncated).toBe(false)
})

test('toolAnnotate locates a quote, derives the block key and round-trips removal', async () => {
  const markdown = '# A Title\n\nA unique sentence appears here.\n\nSecond paragraph.'
  const env = await setup()
  const document = await addParsedDocument(env, markdown)
  const added = await annotate(env.service, document.id, {
    quote: 'unique sentence',
    note: 'important',
    color: 'sky',
  })
  expect(added.annotation.blockKey).toMatch(/^b\d+:[0-9a-f]{8}$/)
  expect(added.annotation.note).toBe('important')
  expect(added.annotation.color).toBe('sky')
  expect(typeof added.annotation.start).toBe('number')
  expect(added.annotation.end - added.annotation.start).toBe('unique sentence'.length)
  expect(added.created).toBe(true)

  const listed = await env.service.toolAnnotations(document.id)
  expect(listed.annotations.length).toBe(1)
  expect(listed.documentId).toBe(document.id)

  // An explicit blockKey path also works (using a key that exists in the parse).
  const explicit = await annotate(env.service, document.id, {
    blockKey: added.annotation.blockKey,
    start: 1,
    end: 4,
    quote: 'abc',
    note: '',
    color: 'sage',
  })
  expect(explicit.created).toBe(true)
  expect(explicit.annotation.blockKey).toBe(added.annotation.blockKey)

  // A stale/unknown blockKey is rejected instead of saving an unrenderable note.
  await expect(
    annotate(env.service, document.id, { blockKey: 'b9:0123abcd', start: 1, end: 4, quote: 'abc' }),
  ).rejects.toThrow(/不存在/)

  const removed = await env.service.toolUnannotate(document.id, added.annotation.id)
  expect(removed.removed).toBe(true)

  await expect(env.service.toolUnannotate(document.id, added.annotation.id)).rejects.toMatchObject({
    code: 'not-found',
  })
  await expect(annotate(env.service, document.id, { quote: 'not in the document at all' })).rejects.toThrow(/未找到/)
  await expect(annotate(env.service, document.id, {})).rejects.toThrow(/blockKey 或 quote/)
})

test('toolAnnotate keeps AI provenance when updating an existing annotation', async () => {
  const env = await setup()
  const document = await addParsedDocument(env, '# Title\n\nA quote lives here.\n')
  const created = await annotate(env.service, document.id, { quote: 'quote lives', origin: 'ai', aspect: 'method' })
  expect(created.annotation.origin).toBe('ai')
  expect(created.annotation.aspect).toBe('method')

  // A later user edit (no origin/aspect in the payload) must not erase them.
  const updated = await annotate(env.service, document.id, {
    id: created.annotation.id,
    blockKey: created.annotation.blockKey,
    start: created.annotation.start,
    end: created.annotation.end,
    quote: created.annotation.quote,
    note: 'user note',
  })
  expect(updated.created).toBe(false)
  expect(updated.annotation.origin).toBe('ai')
  expect(updated.annotation.aspect).toBe('method')
  expect(updated.annotation.note).toBe('user note')
})

test('toolList reports compact rows with status/pages/engine/progress', async () => {
  const env = await setup()
  const document = await addParsedDocument(env, '# Title\n\nBody.')
  await env.store.update(document.id, {
    status: 'parsed',
    parse: { engine: 'standard', pages: 12, phase: null },
  })
  const list = await env.service.toolList()
  expect(list.documents.length).toBe(1)
  const row = list.documents[0]
  expect(row?.documentId).toBe(document.id)
  expect(row?.pages).toBe(12)
  expect(row?.engine).toBe('standard')
  expect(typeof row?.createdAt).toBe('string')

  // A parsing document exposes live progress + the upstream MinerU phase.
  await env.store.update(document.id, {
    status: 'parsing',
    parse: { engine: 'standard', phase: 'polling', remoteState: 'pending', progress: { extracted: 3, total: 12 } },
  })
  const parsingList = await env.service.toolList()
  expect(parsingList.documents[0]?.remoteState).toBe('pending')
  expect(parsingList.documents[0]?.progress).toEqual({ extracted: 3, total: 12 })

  const detail = await env.service.toolGet(document.id)
  expect(detail.document.id).toBe(document.id)
  expect(detail.annotations).toEqual([])
  expect(detail.translations.version).toBe(1)
})

test('startParse normalizes options and surfaces token-missing early', async () => {
  const env = await setup()
  const document = await addDocument(env)
  await expect(env.service.startParse(document.id, { engine: 'standard' })).rejects.toMatchObject({
    code: 'token-missing',
  })
  const started = await env.service.startParse(document.id, {})
  expect(started.document.status).toBe('parsing')
  expect((env.managerCalls[0]?.request as ParsePlan | undefined)?.engine).toBe('agent')
})

test('startParse sends a raw page-scoped repair request to the manager', async () => {
  const env = await setup()
  const document = await addDocument(env)
  const started = await env.service.startParse(document.id, {
    merge: true,
    pages: [2, 4],
    modelVersion: 'vlm',
    isOcr: true,
  })
  expect(started.document.status).toBe('parsing')
  expect(env.managerCalls[0]?.request).toEqual({
    merge: true,
    pages: [2, 4],
    modelVersion: 'vlm',
    language: undefined,
    isOcr: true,
    enableFormula: undefined,
    enableTable: undefined,
  })
})

// ---------------------------------------------------------------------------
// URL import
// ---------------------------------------------------------------------------

test('importUrl downloads a supported document into the library', async () => {
  const bytes = Buffer.from('%PDF-1.4 remote paper')
  const fetchImpl: typeof fetch = async (url, init) => {
    expect(String(url)).toBe('https://example.test/files/remote.pdf?token=abc')
    expect(init?.method).toBe('GET')
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
  const { document } = await env.service.importUrl({ url: 'https://example.test/files/remote.pdf?token=abc' })
  expect(document.originalName).toBe('remote.pdf')
  expect(document.status).toBe('uploaded')
  expect(document.title).toBe('remote')
  const source = await readFile(await env.store.sourcePath(document.id), 'utf8')
  expect(source).toBe(bytes.toString())
})

test('importUrl derives the extension from Content-Type when the file name has none', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(Buffer.from('%PDF-1.4 named by content type'), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })
  const env = await setup({ fetchImpl })
  const { document } = await env.service.importUrl({ url: 'https://example.test/download' })
  expect(document.originalName).toBe('download.pdf')
  expect(document.ext).toBe('.pdf')
})

test('importUrl rejects unsupported types and oversized downloads', async () => {
  const textFetch: typeof fetch = async () =>
    new Response(Buffer.from('plain text'), {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' },
    })
  const env = await setup({ fetchImpl: textFetch })
  await expect(env.service.importUrl({ url: 'https://example.test/notes.txt' })).rejects.toMatchObject({
    code: 'unsupported-type',
  })
  await expect(env.service.importUrl({ url: 'ftp://example.test/a.pdf' })).rejects.toMatchObject({
    code: 'bad-request',
  })

  const bigFetch: typeof fetch = async () =>
    new Response(null, {
      status: 200,
      headers: {
        'content-length': String(1024 * 1024 * 1024),
        'content-disposition': 'attachment; filename="big.pdf"',
      },
    })
  const bigEnv = await setup({ fetchImpl: bigFetch })
  await expect(bigEnv.service.importUrl({ url: 'https://example.test/big.pdf' })).rejects.toMatchObject({
    code: 'too-large',
  })
})

// ---------------------------------------------------------------------------
// Diagnostics and removal
// ---------------------------------------------------------------------------

test('healthPing appends a diagnostics entry', async () => {
  const env = await setup()
  const ack = await env.service.healthPing({ clientVersion: '1.2.3', event: 'active', detail: { panel: 'library' } })
  expect({ ok: ack.ok, hostVersion: ack.hostVersion }).toEqual({ ok: true, hostVersion: '0.1.0+host' })
  expect(typeof ack.receivedAt).toBe('string')
  const lines = (await readFile(join(env.dataDir, 'diagnostics', 'client.log'), 'utf8'))
    .split('\n')
    .filter(Boolean)
  expect(lines.length).toBe(1)
  const entry = JSON.parse(lines[0] ?? '{}') as { event?: string; clientVersion?: string; detail?: string }
  expect(entry.event).toBe('active')
  expect(entry.clientVersion).toBe('1.2.3')
  expect(entry.detail).toMatch(/library/)
})

test('library removal keeps no files behind and health counts follow', async () => {
  const env = await setup()
  const document = await addParsedDocument(env, '# Title\n\nBody.')
  let status = await env.service.getStatus()
  expect(status.counts.total).toBe(1)
  expect(status.counts.parsed).toBe(1)
  expect((await env.service.readMarkdown(document.id)).markdown).toBe('# Title\n\nBody.')
  expect(await env.service.removeDocument(document.id)).toEqual({ removed: true })
  status = await env.service.getStatus()
  expect(status.counts.total).toBe(0)
  await expect(env.service.readMarkdown(document.id)).rejects.toMatchObject({ code: 'not-found' })
})

// ---------------------------------------------------------------------------
// Local engine wiring (T0 / T0.5)
// ---------------------------------------------------------------------------

test('local capability snapshot is exposed through status and settings', async () => {
  const localEngine = makeLocalEngine()
  const env = await setup({ localEngine })
  const status = await env.service.getStatus()
  expect(status.local).not.toBeNull()
  expect(status.local?.enabled).toBe(true)
  expect(status.local?.available).toBe(true)
  expect(status.local?.capabilities.textLayerPdf).toBe(true)
  expect(status.local?.providers).toEqual(localEngine.snapshot().providers)

  const settings = await env.service.getSettings()
  expect(settings.local).toEqual(status.local)
  expect(settings.defaults.localProvider).toBe('auto')
  expect(settings.preferences.autoAllowAgentFallback).toBe(true)
})

test('auto parse without a token selects the local engine for supported files', async () => {
  const localEngine = makeLocalEngine()
  const env = await setup({ localEngine })
  const document = await addDocument(env, { name: 'paper.pdf' })
  const result = await env.service.startParse(document.id, { engine: 'auto' })
  expect(result.document.parse?.engine).toBe('local')
  expect(env.managerCalls.length).toBe(1)
  expect(env.managerCalls[0]?.request).toEqual({
    engine: 'local',
    params: { fileName: 'paper.pdf', language: 'ch', localProvider: 'auto' },
  })
})

test('explicit local parse reports local-missing-tool when the engine is absent', async () => {
  const env = await setup()
  const document = await addDocument(env, { name: 'paper.pdf' })
  const error = await env.service.startParse(document.id, { engine: 'local' }).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(WireError)
  expect((error as WireError).code).toBe('local-missing-tool')
  expect((error as WireError).status).toBe(503)
  expect(env.managerCalls.length).toBe(0)
})

// ---------------------------------------------------------------------------
// Annotation concurrency and graph curation pass-through
// ---------------------------------------------------------------------------

test('saveAnnotations returns the persisted merged items and honours baseIds', async () => {
  const env = await setup()
  const document = await addDocument(env)
  const base = { id: 'ann-mine', blockKey: 'b0:deadbeef', start: 0, end: 4, quote: 'base', note: '', color: 'yellow' as const }
  const first = await env.service.saveAnnotations(document.id, [base])
  expect(first.saved).toBe(true)
  expect(first.items.map((item) => item.id)).toEqual(['ann-mine'])

  // A concurrent AI/agent annotation lands after the client loaded its list.
  await env.store.mutateAnnotations(document.id, (items) => {
    items.push({
      id: 'ann-ai',
      blockKey: 'b1:feedface',
      start: 1,
      end: 5,
      quote: 'ai',
      note: 'from AI',
      color: 'sky',
      origin: 'ai',
    })
    return items
  })

  const saved = await env.service.saveAnnotations(document.id, [{ ...base, note: 'edited by user' }], ['ann-mine'])
  expect(saved.saved).toBe(true)
  expect(saved.items.length).toBe(2)
  expect(saved.items.find((item) => item.id === 'ann-mine')?.note).toBe('edited by user')
  expect(saved.items.some((item) => item.id === 'ann-ai')).toBe(true)
  expect((await env.store.loadAnnotations(document.id)).items).toEqual(saved.items)

  // Deletions win for ids the client had loaded (they are in baseIds).
  const cleared = await env.service.saveAnnotations(document.id, [], ['ann-mine', 'ann-ai'])
  expect(cleared.items).toEqual([])

  // Without baseIds the historical replace semantics stay exactly as today.
  await env.service.saveAnnotations(document.id, [base])
  const replaced = await env.service.saveAnnotations(document.id, [], undefined)
  expect(replaced.saved).toBe(true)
  expect(replaced.items).toEqual([])
})

test('auto parse with cloud fallback disabled and no local support is token-missing', async () => {
  const localEngine = makeLocalEngine({
    supports: () => ({ supported: false, provider: null, reason: 'unsupported extension .png' }),
  })
  const env = await setup({ localEngine })
  await env.service.updatePreferences({ autoAllowAgentFallback: false })
  const document = await addDocument(env, { name: 'scan.png' })
  const error = await env.service
    .startParse(document.id, { engine: 'auto' })
    .catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(WireError)
  expect((error as WireError).code).toBe('token-missing')
  expect((error as WireError).status).toBe(401)
  expect((error as WireError).message).toMatch(/云端回退已关闭/)
  expect(env.managerCalls.length).toBe(0)

  // With the default preference the token-free agent fallback is used.
  await env.service.updatePreferences({ autoAllowAgentFallback: true })
  const started = await env.service.startParse(document.id, { engine: 'auto' })
  expect(started.document.parse?.engine).toBe('agent')
})

test('local capability overrides surface in status when the engine is unavailable', async () => {
  const env = await setup()
  const status = await env.service.getStatus()
  expect(status.local).toBeNull()
  const document = await addDocument(env, { name: 'paper.pdf' })
  const started = await env.service.startParse(document.id, { engine: 'auto' })
  expect(started.document.parse?.engine).toBe('agent')
})

test('updateDocGraph forwards nodes/edges/merge to the graph engine', async () => {
  const calls: unknown[] = []
  const ai = makeAiBundle()
  ai.graph = {
    ...ai.graph,
    async updateDocGraph(documentId, patch) {
      calls.push({ documentId, patch })
      return { scope: 'document', nodes: [], edges: [], stats: { nodes: 0, edges: 0 } } as never
    },
  }
  const env = await setup({ ai })
  const document = await addDocument(env)
  const nodes = [{ id: 'n-a', label: 'A' }]
  const edges = [{ from: 'n-a', to: 'n-b', type: 'uses' as const }]
  const merge = [{ from: 'n-a', to: 'n-b' }]
  const result = await env.service.updateDocGraph(document.id, { nodes, edges, merge })
  expect(result.graph.scope).toBe('document')
  expect(calls[0]).toEqual({ documentId: document.id, patch: { nodes, edges, merge } })

  // Missing arrays normalize to empty arrays (never undefined) so the engine
  // always sees the documented payload shape.
  await env.service.updateDocGraph(document.id, {})
  expect(calls[1]).toEqual({ documentId: document.id, patch: { nodes: [], edges: [], merge: [] } })
})

// ---------------------------------------------------------------------------
// Local search / document model (works without an AI route)
// ---------------------------------------------------------------------------

test('searchDocuments finds matching blocks with coordinates and titles', async () => {
  const env = await setup()
  const document = await addParsedDocument(env, '# Findings\n\nThe model improves accuracy on benchmarks.\n')
  const result = await env.service.searchDocuments({ query: 'accuracy benchmarks' })
  expect(result.scope).toBe('library')
  expect(result.matches.length).toBeGreaterThan(0)
  expect(result.matches[0]?.documentId).toBe(document.id)
  expect(result.matches[0]?.blockKey).toMatch(/^b\d+:[0-9a-f]{8}$/)
  expect(result.matches[0]?.snippet).toMatch(/accuracy/)
  expect(result.scanned.documents).toBe(1)
  expect(result.scanned.blocks).toBeGreaterThan(0)

  const scoped = await env.service.searchDocuments({
    query: 'accuracy',
    scope: 'document',
    documentId: document.id,
  })
  expect(scoped.scope).toBe('document')
  expect(scoped.matches.length).toBeGreaterThan(0)

  await expect(env.service.searchDocuments({ query: '   ' })).rejects.toMatchObject({ code: 'bad-request' })
  await expect(env.service.searchDocuments({ query: 'a' })).rejects.toMatchObject({ code: 'bad-request' })
})

test('documentModel and blockTexts expose parser blocks and page coordinates', async () => {
  const env = await setup()
  const markdown = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n'
  const document = await addParsedDocument(env, markdown)
  const model = await env.service.documentModel(document.id)
  expect(model.document.id).toBe(document.id)
  expect(model.markdown).toBe(markdown)
  expect(model.blocks.length).toBeGreaterThanOrEqual(3)
  expect(model.outline.length).toBe(1)
  expect(model.stats.blocks).toBe(model.blocks.length)
  expect(model.stats.headings).toBe(1)

  const firstBlock = model.blocks.find((block) => block.plainText.includes('First paragraph'))
  expect(firstBlock).toBeTruthy()
  const texts = await env.service.blockTexts(document.id, [firstBlock?.key ?? 'missing'])
  expect(texts[0]?.found).toBe(true)
  expect(texts[0]?.text).toContain('First paragraph')
  expect(texts[0]?.blockKey).toBe(firstBlock?.key)
  const missing = await env.service.blockTexts(document.id, ['b99:00000000'])
  expect(missing[0]).toEqual({ blockKey: 'b99:00000000', found: false, page: null, kind: null, text: '' })
  await expect(env.service.blockTexts(document.id, [])).rejects.toMatchObject({ code: 'bad-request' })
})

// ---------------------------------------------------------------------------
// AI bridge: askDocument collects the streamed answer
// ---------------------------------------------------------------------------

test('askDocument collects the answer, citations, graph delta and message id', async () => {
  const frames = [
    { type: 'start', messageId: 'msg-1', model: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { type: 'delta', text: 'The paper says ' },
    { type: 'phase', phase: 'entailment' },
    {
      type: 'answer',
      messageId: 'msg-1',
      markdown: 'The paper says [1].',
      citations: [
        {
          index: 1,
          blockKey: 'b0:deadbeef',
          quote: 'quote',
          start: 0,
          end: 5,
          page: 1,
          aspect: 'result',
          note: 'claim',
          verified: true,
        },
      ],
      unverified: [],
      followups: ['Why?'],
      annotationIds: ['ann-1'],
      entailment: { checked: true, supported: 1, partial: 0, unsupported: 0 },
    },
    { type: 'graph', delta: { nodes: [{ label: 'Concept' }] } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'done' },
  ] as const
  const ai = makeAiBundle()
  ai.chat = {
    history: async () => [],
    clear: async () => ({ cleared: true as const }),
    stream: async function* () {
      for (const frame of frames) yield frame as never
    },
  }
  const env = await setup({ ai })
  const document = await addParsedDocument(env, '# Title\n\nBody.\n')
  const answer = await env.service.askDocument({ documentId: document.id, question: 'What does it say?' })
  expect(answer.documentId).toBe(document.id)
  expect(answer.title).toBe(document.title)
  expect(answer.answer).toBe('The paper says [1].')
  expect(answer.citations.length).toBe(1)
  expect(answer.messageId).toBe('msg-1')
  expect(answer.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  expect(answer.graph).toEqual({ nodes: [{ label: 'Concept' }] })
  expect(answer.followups).toEqual(['Why?'])
  expect(answer.annotationIds).toEqual(['ann-1'])
})

test('askDocument maps stream error frames to wire errors and validates the question', async () => {
  const ai = makeAiBundle()
  ai.chat = {
    history: async () => [],
    clear: async () => ({ cleared: true as const }),
    stream: async function* () {
      yield { type: 'error', code: 'llm-failed', message: 'boom' } as never
    },
  }
  const env = await setup({ ai })
  const document = await addParsedDocument(env, '# Title\n')
  await expect(env.service.askDocument({ documentId: document.id, question: 'hi' })).rejects.toMatchObject({
    code: 'llm-failed',
  })
  await expect(env.service.askDocument({ documentId: document.id, question: '  ' })).rejects.toMatchObject({
    code: 'bad-request',
  })
})

test('chatHistory/chatClear require a document and delegate to the AI bundle', async () => {
  const cleared: string[] = []
  const ai = makeAiBundle()
  ai.chat = {
    history: async () => [
      { id: 'm1', role: 'user', question: 'q', citations: [], unverified: [], createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    clear: async (documentId) => {
      cleared.push(documentId)
      return { cleared: true as const }
    },
    stream: async function* () {},
  }
  const env = await setup({ ai })
  const document = await addParsedDocument(env, '# Title\n')
  expect((await env.service.chatHistory(document.id)).messages.length).toBe(1)
  expect(await env.service.chatClear(document.id)).toEqual({ cleared: true })
  expect(cleared).toEqual([document.id])
  await expect(env.service.chatHistory(randomUUID())).rejects.toMatchObject({ code: 'not-found' })
})

// ---------------------------------------------------------------------------
// Quote-located annotations use the reader parser's block keys (QA regressions)
// ---------------------------------------------------------------------------

/** The parser block that owns a substring, with its canonical key. */
function blockOwning(model: ReturnType<typeof parseMarkdown>, needle: string) {
  return model.blocks.find(
    (block): block is Extract<typeof block, { plainText: string }> =>
      'plainText' in block && typeof block.plainText === 'string' && block.plainText.includes(needle),
  )
}

test('annotate(quote) uses the client parser keys for blockquotes (no merged-block drift)', async () => {
  const env = await setup()
  const markdown = [
    '## Findings',
    '',
    '> First claim line one.',
    '> First claim line two.',
    '',
    '> Second claim is separate.',
    '',
    'A paragraph after both quotes anchors the index.',
    '',
  ].join('\n')
  const document = await addParsedDocument(env, markdown)
  const model = parseMarkdown(markdown)

  const first = await annotate(env.service, document.id, { quote: 'First claim line one.' })
  expect(first.annotation.blockKey).toBe(blockOwning(model, 'First claim line one.')?.key)

  const second = await annotate(env.service, document.id, { quote: 'Second claim is separate.' })
  expect(second.annotation.blockKey).toBe(blockOwning(model, 'Second claim is separate.')?.key)

  const paragraph = await annotate(env.service, document.id, { quote: 'A paragraph after both quotes' })
  expect(paragraph.annotation.blockKey).toBe(blockOwning(model, 'A paragraph after both quotes')?.key)
  expect(first.annotation.blockKey).not.toBe(second.annotation.blockKey)
})

test('annotate(quote) uses the client parser keys for list blocks and offsets', async () => {
  const env = await setup()
  const markdown = ['- alpha beta', '- gamma delta', ''].join('\n')
  const document = await addParsedDocument(env, markdown)
  const model = parseMarkdown(markdown)
  const block = blockOwning(model, 'gamma delta')
  expect(block).toBeTruthy()

  const result = await annotate(env.service, document.id, { quote: 'gamma delta' })
  expect(result.annotation.blockKey).toBe(block?.key)
  expect(block?.plainText.slice(result.annotation.start, result.annotation.end)).toBe('gamma delta')
})

test('annotate(quote) uses the client parser keys for table cells', async () => {
  const env = await setup()
  const markdown = [
    '<table>',
    '<tr><th>Model</th><th>Recall</th></tr>',
    '<tr><td>Ours</td><td>Exact 42</td></tr>',
    '</table>',
    '',
  ].join('\n')
  const document = await addParsedDocument(env, markdown)
  const model = parseMarkdown(markdown)
  const block = blockOwning(model, 'Exact 42')
  expect(block).toBeTruthy()

  const result = await annotate(env.service, document.id, { quote: 'Exact 42' })
  expect(result.annotation.blockKey).toBe(block?.key)
  expect(block?.plainText.slice(result.annotation.start, result.annotation.end)).toBe('Exact 42')
})

test('annotate(quote) refuses an ambiguous quote with a clear code', async () => {
  const env = await setup()
  const document = await addParsedDocument(env, 'repeat me once.\n\nrepeat me twice.\n')
  await expect(annotate(env.service, document.id, { quote: 'repeat me' })).rejects.toMatchObject({
    code: 'bad-request',
  })
})

// ---------------------------------------------------------------------------
// Additional contract coverage (settings, translations, parse cancellation)
// ---------------------------------------------------------------------------

test('getSettings lists the anonymous providers and preference defaults', async () => {
  const env = await setup({ translator: makeTranslator(['google', 'bing']) })
  await env.service.updatePreferences({ targetLanguage: 'en', defaultEngine: 'local' })
  const settings = await env.service.getSettings()
  expect(settings.providers.map((provider) => provider.id)).toEqual(['auto', 'google', 'bing'])
  expect(settings.tokenConfigured).toBe(false)
  expect(settings.tokenPersistent).toBe(false)
  expect(settings.defaults.engine).toBe('local')
  expect(settings.defaults.targetLanguage).toBe('en')
  expect(settings.defaults.modelVersion).toBe('vlm')
  expect(settings.defaults.translationProvider).toBe('auto')
  expect(settings.defaults.localProvider).toBe('auto')
  expect(settings.preferences.targetLanguage).toBe('en')
})

test('saveTranslations stores the cache and falls back to the preferred target language', async () => {
  const env = await setup()
  const document = await addDocument(env)
  await env.service.updatePreferences({ targetLanguage: 'ja' })
  await expect(
    env.service.saveTranslations(document.id, '', { 'b0:deadbeef': 'x' }),
  ).resolves.toEqual({ saved: true })
  const loaded = await env.store.loadTranslations(document.id)
  expect(loaded.targetLanguage).toBe('ja')
  expect(loaded.entries['b0:deadbeef']).toBe('x')

  await expect(
    env.service.saveTranslations(document.id, 'zh', [] as unknown as Record<string, string>),
  ).rejects.toMatchObject({ code: 'bad-request' })
  await expect(env.service.saveTranslations(randomUUID(), 'zh', {})).rejects.toMatchObject({
    code: 'not-found',
  })
})

test('updateDocument renames with validation and keeps no-op payloads stable', async () => {
  const env = await setup()
  const document = await addDocument(env, { title: 'Original' })
  const renamed = await env.service.updateDocument(document.id, { title: '  Renamed  ' })
  expect(renamed.document.title).toBe('Renamed')
  const noop = await env.service.updateDocument(document.id, {})
  expect(noop.document.title).toBe('Renamed')
  await expect(env.service.updateDocument(document.id, { title: '   ' })).rejects.toThrow(/标题不能为空/)
  await expect(env.service.updateDocument(randomUUID(), { title: 'x' })).rejects.toMatchObject({
    code: 'not-found',
  })
})

test('cancelParse rejects when no parse is in progress and forwards cancellation', async () => {
  const env = await setup()
  const document = await addDocument(env)
  await expect(env.service.cancelParse(document.id)).rejects.toMatchObject({ code: 'bad-request' })

  await env.store.update(document.id, { status: 'parsing' })
  const cancelled = await env.service.cancelParse(document.id)
  expect(cancelled.document.status).toBe('uploaded')
})

test('toolRead clamps out-of-range offsets', async () => {
  const env = await setup()
  const document = await addParsedDocument(env, 'abcdefghij')
  const pastEnd = await env.service.toolRead(document.id, { offset: 999, maxChars: 10 })
  expect(pastEnd.markdown).toBe('')
  expect(pastEnd.offset).toBe(10)
  expect(pastEnd.truncated).toBe(false)
  const negative = await env.service.toolRead(document.id, { offset: -5, maxChars: 3 })
  expect(negative.offset).toBe(0)
  expect(negative.markdown).toBe('abc')
})

test('chatFrames and graph frames stream the AI bundle output through the service', async () => {
  const ai = makeAiBundle()
  ai.chat = {
    history: async () => [],
    clear: async () => ({ cleared: true as const }),
    stream: async function* () {
      yield { type: 'start', messageId: 'm1', model: { provider: 'p', model: 'm' } } as never
      yield { type: 'delta', text: 'x' } as never
      yield { type: 'done' } as never
    },
  }
  ai.graph = {
    ...ai.graph,
    buildDocGraph: async function* () {
      yield { type: 'progress', phase: 'reading', done: 1, total: 2, chunk: 1 } as never
      yield {
        type: 'graph',
        graph: {
          version: 1,
          scope: 'document',
          documentId: 'doc-1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          overview: '',
          nodes: [],
          edges: [],
          stats: { nodes: 0, edges: 0 },
        },
      } as never
    },
    rebuildLibraryGraph: async function* () {
      yield { type: 'progress', phase: 'aggregating', done: 1, total: 1 } as never
      yield {
        type: 'graph',
        graph: {
          version: 1,
          scope: 'library',
          generatedAt: '2026-01-01T00:00:00.000Z',
          overview: '',
          nodes: [],
          edges: [],
          stats: { nodes: 0, edges: 0 },
        },
      } as never
    },
  }
  const env = await setup({ ai })
  const document = await addParsedDocument(env, '# Title\n')
  const controller = new AbortController()
  const chatTypes: string[] = []
  for await (const frame of env.service.chatFrames({ documentId: document.id, question: 'q' }, controller.signal)) {
    chatTypes.push(frame.type)
  }
  expect(chatTypes).toEqual(['start', 'delta', 'done'])

  const graphFrames: string[] = []
  for await (const frame of env.service.graphBuildFrames({ documentId: document.id }, controller.signal)) {
    graphFrames.push(frame.type)
  }
  expect(graphFrames).toEqual(['progress', 'graph'])

  const libraryFrames: string[] = []
  for await (const frame of env.service.libraryGraphBuildFrames(controller.signal)) {
    libraryFrames.push(frame.type)
  }
  expect(libraryFrames).toEqual(['progress', 'graph'])
})

test('importUrl maps non-2xx downloads to bad-request and cleans up the temp file', async () => {
  const fetchImpl: typeof fetch = async () => new Response('missing', { status: 404 })
  const env = await setup({ fetchImpl })
  await expect(env.service.importUrl({ url: 'https://example.test/missing.pdf' })).rejects.toMatchObject({
    code: 'bad-request',
  })
  await expect(env.service.importUrl({ url: 'https://example.test/empty' })).rejects.toMatchObject({
    code: 'bad-request',
  })
  const tmpEntries = await import('node:fs/promises').then((fs) => fs.readdir(join(env.dataDir, 'tmp')))
  expect(tmpEntries.length).toBe(0)
})
