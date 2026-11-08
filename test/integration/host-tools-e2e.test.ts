/**
 * Cross-half integration test: the 8 agent tool definitions executed against the
 * real composed service layer (`registerLibraryTools` → `ServiceApi` → store).
 *
 * Builds the real Host bundle, mounts it on a fake Cordis context that captures
 * every tool registered through `ctx.get('tools')`, seeds a synthetic library
 * (one parsed paper + one spare document) on a temp data dir, and executes each
 * tool's `execute()` handler exactly as the agent would:
 *
 *   library_search / library_read / library_annotate / library_translate /
 *   library_graph / library_manage / library_ask / library_deepread
 *
 * Assertions cover bounded outputs (`config.toolMaxChars`), coordinate fields
 * (documentId / blockKey / page / snippet / quote), real disk side effects
 * (annotations.json, graph.json, title/remove), and the error contract (tools
 * throw `Error`s carrying the wire message/code instead of returning failures).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  ContentBlock,
  JsonSchema,
  LlmGenerateOptions,
  LlmStreamChunk,
  ToolDefinition,
} from '../../src/host/host-services.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { createStore } from '../../src/host/store/index.ts'
import { appendPageMarks, parseMarkdown } from '../../src/shared/markdown/parse.ts'
import type { Annotation, ChatMessage, ContentListEntry } from '../../src/shared/model.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HOST_ARTIFACT = join(ROOT, 'index.js')

/** Row config used for the mounted plugin (small tool cap proves truncation). */
const ROW_CONFIG: Record<string, unknown> = {
  dataDir: '',
  apiBase: 'https://api.invalid',
  pollIntervalMs: 10,
  parseTimeoutMs: 5000,
  toolMaxChars: 2000,
}

// ---------------------------------------------------------------------------
// Synthetic library fixture (written by the test, no user data)
// ---------------------------------------------------------------------------

/** The parsed paper markdown used by every case. */
const PAPER_MARKDOWN = [
  '# Sparse Expert Routing for Efficient Retrieval',
  '',
  'Sparse expert routing activates only a small number of experts for each token.',
  '',
  '## Routing Method',
  '',
  'The router selects the top-2 experts for every token and gates their outputs.',
  '',
  '## Results',
  '',
  'Sparse routing matches dense retrieval quality at a third of the compute.',
  '',
].join('\n')

/** Content list giving each block a page index (page-mark alignment). */
const PAPER_CONTENT_LIST: ContentListEntry[] = PAPER_MARKDOWN.split('\n\n').map((text, index) => ({
  type: 'text',
  text: text.replace(/^#+\s*/, ''),
  page_idx: index < 2 ? 0 : 1,
}))

/** The quoted sentence used by the scripted citation (verbatim from the paper). */
const CITATION_QUOTE = 'The router selects the top-2 experts for every token and gates their outputs.'

/** The scripted answer (visible markdown; the fence is stripped by the engine). */
const ANSWER_VISIBLE =
  'Sparse routing activates only a few experts per token, and the router picks the top two [1].'

/** Entailment second-pass output. */
const ENTAILMENT_RAW = [
  '```litnotes-entailment',
  '{"results":[{"index":1,"verdict":"supported","reason":"The quote states the router selects the top-2 experts."}]}',
  '```',
].join('\n')

/** Citation fixture resolved through the shared parser (the same model the Host uses). */
interface CitationFixture {
  blockKey: string
  page: number
}

/** Resolve the citation block key/page from the shared parser. */
function resolveCitation(): CitationFixture {
  const model = appendPageMarks(parseMarkdown(PAPER_MARKDOWN), PAPER_CONTENT_LIST)
  const block = model.blocks.find((entry) => entry.kind !== 'page' && entry.plainText.includes(CITATION_QUOTE))
  if (block === undefined) throw new Error('tool fixture: citation block not found')
  return { blockKey: block.key, page: block.page ?? 1 }
}

/** Build the scripted model answer (one verified citation + trailing JSON fence). */
function scriptedAnswer(citation: CitationFixture): string {
  const payload = {
    citations: [
      {
        index: 1,
        blockKey: citation.blockKey,
        quote: CITATION_QUOTE,
        aspect: 'method',
        note: 'The router selects the top-2 experts for every token.',
      },
    ],
    knowledge: { nodes: [], edges: [] },
    followups: ['How are the gated outputs combined?'],
  }
  return `${ANSWER_VISIBLE}\n\n\`\`\`litnotes-json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
}

// ---------------------------------------------------------------------------
// Fake Host context + services
// ---------------------------------------------------------------------------

/** One registered route (only the shapes this plugin uses). */
interface RegisteredRoute {
  kind: 'exact' | 'prefix' | 'resource'
  path: string
}

/** Fake `llm` Host service: scripts the chat answer and the entailment pass. */
class FakeLlmService {
  fail = false
  readonly purposes: string[] = []
  private readonly answer: string

  constructor(answer: string) {
    this.answer = answer
  }

  stream(options: LlmGenerateOptions): AsyncIterable<LlmStreamChunk> {
    if (this.fail) throw new Error('simulated host llm failure')
    // The gateway pins reasoning effort 'off' for the utility entailment pass.
    const purpose = options.reasoningEffort === 'off' ? 'entailment' : 'chat'
    this.purposes.push(purpose)
    const raw = purpose === 'entailment' ? ENTAILMENT_RAW : this.answer
    return FakeLlmService.chunks(raw)
  }

  private static async *chunks(raw: string): AsyncGenerator<LlmStreamChunk> {
    const size = 23
    for (let index = 0; index < raw.length; index += size) {
      yield { type: 'text-delta', text: raw.slice(index, index + size) }
    }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 48 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Fake translator service matching the Host translator surface. */
function createFakeTranslator(): {
  availableProviders: () => Promise<Array<'google' | 'bing'>>
  resolve: (request: { text: string; targetLanguage: string; provider?: string }) => unknown
  translate: (spec: unknown) => Promise<string>
} {
  return {
    async availableProviders() {
      return ['google', 'bing']
    },
    resolve(request) {
      return {
        provider: request.provider ?? 'google',
        text: request.text,
        targetLanguage: request.targetLanguage,
        sourceLanguage: 'en',
      }
    },
    async translate(spec) {
      const text = spec !== null && typeof spec === 'object' ? (spec as { text?: unknown }).text : ''
      return `【译】${typeof text === 'string' ? text : ''}`
    },
  }
}

/** Everything one mounted plugin instance exposes to this test. */
interface MountedPlugin {
  ctx: unknown
  routes: RegisteredRoute[]
  tools: ToolDefinition[]
  fakeLlm: FakeLlmService
  translated: Array<{ text: string; targetLanguage: string }>
}

/** Fake Cordis context that captures tools and mounts the real plugin. */
function mountPlugin(fakeLlm: FakeLlmService): MountedPlugin {
  const routes: RegisteredRoute[] = []
  const tools: ToolDefinition[] = []
  const translated: Array<{ text: string; targetLanguage: string }> = []
  const translator = createFakeTranslator()
  const wrappedTranslator = {
    availableProviders: translator.availableProviders,
    resolve: (request: { text: string; targetLanguage: string; provider?: string }) => {
      translated.push({ text: request.text, targetLanguage: request.targetLanguage })
      return translator.resolve(request)
    },
    translate: translator.translate,
  }
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: (serviceName: string) => {
      if (serviceName === 'tools') {
        return {
          register: (definition: ToolDefinition) => {
            tools.push(definition)
            return () => {}
          },
        }
      }
      if (serviceName === 'llm') return fakeLlm
      if (serviceName === 'translator') return wrappedTranslator
      if (serviceName === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
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
      requestRejection: () => undefined,
    },
  }
  return { ctx, routes, tools, fakeLlm, translated }
}

/** Latest mtime of any file under `src/host/**`. */
function latestHostSourceMtime(): number {
  let latest = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.json'))) {
        latest = Math.max(latest, statSync(path).mtimeMs)
      }
    }
  }
  visit(join(ROOT, 'src', 'host'))
  return latest
}

/** Build the Host bundle unless an up-to-date artifact already exists. */
function ensureHostBundle(): void {
  const artifactMtime = existsSync(HOST_ARTIFACT) ? statSync(HOST_ARTIFACT).mtimeMs : 0
  if (artifactMtime > 0 && artifactMtime >= latestHostSourceMtime()) return
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.ts')], { cwd: ROOT, stdio: 'pipe' })
  } catch (error) {
    // The host bundle is written before the client half; a failing client build
    // (another workstream's in-flight code) must not block this host-only test.
    const refreshed = existsSync(HOST_ARTIFACT) && statSync(HOST_ARTIFACT).mtimeMs > artifactMtime
    if (!refreshed) throw error
  }
}

/** Import the freshly built Host bundle and call its `apply`. */
async function applyPlugin(dataDir: string, fakeLlm: FakeLlmService): Promise<MountedPlugin> {
  const mounted = mountPlugin(fakeLlm)
  const moduleUrl = `${pathToFileURL(HOST_ARTIFACT).href}?mtime=${statSync(HOST_ARTIFACT).mtimeMs}`
  const module = (await import(moduleUrl)) as {
    apply: (ctx: unknown, config?: Record<string, unknown>) => void
  }
  module.apply(mounted.ctx, { ...ROW_CONFIG, dataDir })
  return mounted
}

/** Seed the synthetic library: one parsed paper and one spare uploaded document. */
async function seedLibrary(dataDir: string): Promise<{
  mainId: string
  spareId: string
  citation: CitationFixture
}> {
  const config = resolveConfig({ dataDir })
  const store = createStore({ dataDir: config.dataDir, logger: { info: () => {}, warn: () => {}, error: () => {} } })
  await store.init()
  try {
    const mainId = '11111111-2222-4333-8444-555555555555'
    const mainTemp = store.newTempPath(mainId)
    await writeFile(mainTemp, Buffer.from('%PDF-1.4 tools fixture\n%%EOF\n'))
    await store.createFromFile({
      id: mainId,
      tempPath: mainTemp,
      originalName: 'sparse-routing.pdf',
      title: 'Sparse Expert Routing for Efficient Retrieval',
    })
    const parsedDir = store.parsedDir(mainId)
    await mkdir(parsedDir, { recursive: true })
    await writeFile(join(parsedDir, 'full.md'), PAPER_MARKDOWN)
    await writeFile(join(parsedDir, 'content_list.json'), JSON.stringify(PAPER_CONTENT_LIST, null, 2))
    const now = new Date().toISOString()
    await store.update(mainId, {
      status: 'parsed',
      error: null,
      parse: {
        engine: 'standard',
        provider: null,
        local: null,
        modelVersion: 'vlm',
        language: 'ch',
        options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
        phase: null,
        remoteState: null,
        taskId: null,
        batchId: null,
        startedAt: now,
        finishedAt: now,
        pages: 2,
        progress: { extracted: 2, total: 2 },
        hasContentList: true,
      },
    })
    await store.saveAnnotations(mainId, { items: [] })

    const spareId = '99999999-8888-4777-8666-555555555555'
    const spareTemp = store.newTempPath(spareId)
    await writeFile(spareTemp, Buffer.from('%PDF-1.4 spare fixture\n%%EOF\n'))
    await store.createFromFile({ id: spareId, tempPath: spareTemp, originalName: 'spare-paper.pdf' })
    return { mainId, spareId, citation: resolveCitation() }
  } finally {
    await store.dispose()
  }
}

// ---------------------------------------------------------------------------
// Tool execution helpers
// ---------------------------------------------------------------------------

/** The tool registry captured at mount time. */
let mounted: MountedPlugin
let mainId = ''
let spareId = ''
let citation: CitationFixture

/** Look one tool up by name (failing the test when it is missing). */
function tool(name: string): ToolDefinition {
  const definition = mounted.tools.find((entry) => entry.name === name)
  if (definition === undefined) throw new Error(`tool not registered: ${name}`)
  return definition
}

/** Execute one tool like the agent runtime does. */
async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return tool(name).execute(args)
}

/** Render one tool value through its output declaration and return the text. */
function renderTool(name: string, args: Record<string, unknown>, value: unknown): string {
  const definition = tool(name)
  const blocks: ContentBlock[] = definition.output.render(args, value)
  return blocks.map((block) => (typeof block.text === 'string' ? block.text : JSON.stringify(block))).join('')
}

/** Assert a tool result is bounded by the configured host tool cap. */
function assertBounded(name: string, args: Record<string, unknown>, value: unknown): void {
  const rendered = renderTool(name, args, value)
  expect(rendered.length).toBeLessThanOrEqual(ROW_CONFIG.toolMaxChars as number)
  expect(rendered.length).toBeGreaterThan(0)
}

/** Assert an async tool call rejects with an Error carrying `messagePart`/`code`. */
async function rejectsWith(
  promiseFactory: () => Promise<unknown>,
  messagePart: string | RegExp,
  code?: string,
): Promise<Error> {
  let captured: Error | undefined
  await promiseFactory().then(
    () => {
      throw new Error('expected the tool call to reject')
    },
    (error: unknown) => {
      if (!(error instanceof Error)) throw new Error(`expected an Error, got ${String(error)}`)
      captured = error
    },
  )
  if (captured === undefined) throw new Error('expected the tool call to reject with an Error')
  if (messagePart instanceof RegExp) expect(captured.message).toMatch(messagePart)
  else expect(captured.message).toContain(messagePart)
  if (code !== undefined) {
    expect((captured as Error & { code?: string }).code).toBe(code)
  }
  return captured
}

/** Read one JSON file from a document directory. */
function readDocumentJson<T>(dataDir: string, documentId: string, name: string): T {
  const parsed: unknown = JSON.parse(readFileSync(join(dataDir, 'documents', documentId, name), 'utf8'))
  return parsed as T
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-litnotes-tools-integration-'))
const DATA_DIR = join(tempRoot, 'data')

beforeAll(async () => {
  ensureHostBundle()
  const seeded = await seedLibrary(DATA_DIR)
  mainId = seeded.mainId
  spareId = seeded.spareId
  citation = seeded.citation
  mounted = await applyPlugin(DATA_DIR, new FakeLlmService(scriptedAnswer(citation)))
}, 120_000)

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('agent tools end-to-end against the real service layer', () => {
  it('registers the 8 focused library tools with schemas and output declarations', () => {
    expect(mounted.tools.map((definition) => definition.name).sort()).toEqual([
      'library_annotate',
      'library_ask',
      'library_deepread',
      'library_graph',
      'library_manage',
      'library_read',
      'library_search',
      'library_translate',
    ])
    for (const definition of mounted.tools) {
      expect(definition.description.length).toBeGreaterThan(40)
      const parameters = definition.parameters as JsonSchema
      expect(parameters.type).toBe('object')
      const properties = parameters.properties as Record<string, unknown> | undefined
      expect(properties !== undefined).toBe(true)
      expect(Array.isArray(parameters.required)).toBe(true)
      expect(definition.output.schema).toMatchObject({ type: 'object' })
      expect(typeof definition.output.render).toBe('function')
    }

    // The AI 精读 tool declares its get|run surface and bounded output.
    const deepread = tool('library_deepread')
    const parameters = deepread.parameters as JsonSchema
    expect(parameters.additionalProperties).toBe(false)
    expect(parameters.required).toEqual(['action', 'documentId'])
    const properties = parameters.properties as Record<string, Record<string, unknown>>
    expect(properties.action?.enum).toEqual(['get', 'run'])
    expect(properties.documentId?.type).toBe('string')
    expect(properties.language?.type).toBe('string')
    expect(deepread.output.schema).toMatchObject({ type: 'object' })
    expect(typeof deepread.output.render).toBe('function')
    expect(deepread.description).toMatch(/精读|close reading/i)
  })

  it('library_search finds coordinate-bearing passages and honours scope/limit', async () => {
    const args = { query: 'router selects experts token', limit: 5 }
    const result = (await runTool('library_search', args)) as Record<string, unknown>
    expect(result.scope).toBe('library')
    const matches = result.matches as Array<Record<string, unknown>>
    expect(matches.length).toBeGreaterThanOrEqual(1)
    const hit = matches[0]
    expect(hit?.documentId).toBe(mainId)
    expect(typeof hit?.blockKey).toBe('string')
    expect(String(hit?.blockKey)).toMatch(/^b\d+:[0-9a-f]{8}$/)
    expect(typeof hit?.page).toBe('number')
    expect(typeof hit?.snippet).toBe('string')
    expect(String(hit?.snippet).length).toBeGreaterThan(0)
    const scanned = result.scanned as { documents: number; blocks: number }
    expect(scanned.documents).toBe(1) // only parsed documents are scanned
    expect(scanned.blocks).toBeGreaterThan(0)
    assertBounded('library_search', args, result)

    // Scope + limit are respected.
    const scoped = (await runTool('library_search', { ...args, scope: 'document', documentId: mainId, limit: 1 })) as Record<
      string,
      unknown
    >
    expect(scoped.scope).toBe('document')
    expect((scoped.matches as unknown[]).length).toBeLessThanOrEqual(1)

    // Failures surface as thrown Errors with the wire message.
    await rejectsWith(() => runTool('library_search', { query: '   ' }), /查询不能为空|query/)
  })

  it('library_read supports text/block/page/meta views with coordinates and bounds', async () => {
    // text view: bounded slice + nextOffset/totalChars.
    const textArgs = { documentId: mainId, view: 'text', offset: 0, maxChars: 40 }
    const text = (await runTool('library_read', textArgs)) as Record<string, unknown>
    expect(text.documentId).toBe(mainId)
    expect(text.offset).toBe(0)
    expect(String(text.markdown).length).toBe(40)
    expect(text.nextOffset).toBe(40)
    expect(text.totalChars).toBe(PAPER_MARKDOWN.length)
    expect(text.truncated).toBe(true)
    assertBounded('library_read', textArgs, text)

    // block view: exact text + page coordinate for a known block key.
    const blockArgs = { documentId: mainId, view: 'block', blockKey: citation.blockKey }
    const block = (await runTool('library_read', blockArgs)) as {
      documentId: string
      blocks: Array<Record<string, unknown>>
    }
    expect(block.documentId).toBe(mainId)
    const blockText = block.blocks[0]
    expect(blockText?.found).toBe(true)
    expect(String(blockText?.text)).toContain(CITATION_QUOTE)
    expect(typeof blockText?.page).toBe('number')
    assertBounded('library_read', blockArgs, block)

    // page view: blocks on one page with keys.
    const pageArgs = { documentId: mainId, view: 'page', page: citation.page }
    const page = (await runTool('library_read', pageArgs)) as Record<string, unknown>
    expect(page.page).toBe(citation.page)
    const pageBlocks = page.blocks as Array<Record<string, unknown>>
    expect(pageBlocks.length).toBeGreaterThan(0)
    for (const entry of pageBlocks) expect(String(entry.blockKey)).toMatch(/^b\d+:[0-9a-f]{8}$/)
    expect(String(page.text).length).toBeGreaterThan(0)
    assertBounded('library_read', pageArgs, page)

    // meta view: document model summary (graph is best-effort).
    const metaArgs = { documentId: mainId, view: 'meta' }
    const meta = (await runTool('library_read', metaArgs)) as Record<string, unknown>
    expect(meta.documentId).toBe(mainId)
    expect(meta.title).toBe('Sparse Expert Routing for Efficient Retrieval')
    expect(meta.status).toBe('parsed')
    expect(meta.pages).toBe(2)
    const stats = meta.stats as Record<string, unknown>
    expect(Number(stats.blocks)).toBeGreaterThan(0)
    expect(Array.isArray(meta.outline)).toBe(true)
    assertBounded('library_read', metaArgs, meta)

    // Failures: unknown document, bad page.
    await rejectsWith(
      () => runTool('library_read', { documentId: '00000000-0000-4000-8000-000000000000', view: 'text' }),
      /文档不存在|Document not found/,
      'not-found',
    )
    await rejectsWith(() => runTool('library_read', { documentId: mainId, view: 'page', page: 99 }), /no blocks/)
  })

  it('library_annotate create/list/delete round-trips and persists on disk', async () => {
    let listed = (await runTool('library_annotate', { action: 'list', documentId: mainId })) as Record<string, unknown>
    expect(listed.count).toBe(0)

    const createArgs = {
      action: 'create',
      documentId: mainId,
      annotation: { quote: CITATION_QUOTE, note: 'agent-authored note', aspect: 'method' },
    }
    const created = (await runTool('library_annotate', createArgs)) as {
      annotation: Annotation
      created: boolean
    }
    expect(created.created).toBe(true)
    const annotation = created.annotation
    expect(annotation.blockKey).toBe(citation.blockKey)
    expect(annotation.quote).toBe(CITATION_QUOTE)
    expect(annotation.aspect).toBe('method')
    expect(annotation.color).toBe('sage')
    expect(annotation.note).toBe('agent-authored note')
    expect(typeof annotation.start).toBe('number')
    expect(typeof annotation.end).toBe('number')
    expect(annotation.end - annotation.start).toBe(CITATION_QUOTE.length)
    assertBounded('library_annotate', createArgs, created)

    listed = (await runTool('library_annotate', { action: 'list', documentId: mainId })) as Record<string, unknown>
    expect(listed.count).toBe(1)
    const onDisk = readDocumentJson<{ items: Annotation[] }>(DATA_DIR, mainId, 'annotations.json')
    expect(onDisk.items).toHaveLength(1)
    expect(onDisk.items[0]?.id).toBe(annotation.id)

    // delete round-trip
    const deleted = (await runTool('library_annotate', {
      action: 'delete',
      documentId: mainId,
      annotationId: annotation.id,
    })) as Record<string, unknown>
    expect(deleted.removed).toBe(true)
    listed = (await runTool('library_annotate', { action: 'list', documentId: mainId })) as Record<string, unknown>
    expect(listed.count).toBe(0)

    // Failure: missing annotation id for delete.
    await rejectsWith(
      () => runTool('library_annotate', { action: 'delete', documentId: mainId }),
      /annotationId/,
    )
  })

  it('library_translate translates text and parsed blocks through the mounted translator', async () => {
    const textArgs = { documentId: mainId, text: 'Hello world', targetLanguage: 'zh' }
    const text = (await runTool('library_translate', textArgs)) as Record<string, unknown>
    expect(text.translation).toBe('【译】Hello world')
    expect(text.targetLanguage).toBe('zh')
    expect(typeof text.provider).toBe('string')
    expect(text.documentId).toBe(mainId)
    expect(mounted.translated).toHaveLength(1)
    assertBounded('library_translate', textArgs, text)

    const blockArgs = { documentId: mainId, blockKeys: [citation.blockKey], targetLanguage: 'zh' }
    const block = (await runTool('library_translate', blockArgs)) as {
      documentId: string
      translations: Array<Record<string, unknown>>
    }
    expect(block.translations).toHaveLength(1)
    const entry = block.translations[0]
    expect(entry?.blockKey).toBe(citation.blockKey)
    expect(typeof entry?.page).toBe('number')
    expect(String(entry?.source)).toContain('The router selects')
    expect(String(entry?.translation)).toContain('【译】')
    assertBounded('library_translate', blockArgs, block)

    // Failure: nothing to translate.
    await rejectsWith(() => runTool('library_translate', { documentId: mainId }), /provide text or blockKeys/)
  })

  it('library_graph reads, curates (persisted graph.json) and searches the doc graph', async () => {
    const get = (await runTool('library_graph', { action: 'get', documentId: mainId })) as Record<string, unknown>
    const initialNodes = get.nodes as unknown[]
    expect(Array.isArray(initialNodes)).toBe(true)
    // No graph has been built yet: a read returns the (valid) empty document graph.
    expect(initialNodes).toHaveLength(0)
    expect(get.stats).toMatchObject({ nodes: 0 })

    const updateArgs = {
      action: 'update',
      documentId: mainId,
      nodes: [
        {
          label: 'Sparse routing',
          type: 'method',
          summary: 'Routes each token to a small set of experts.',
          blockKeys: [citation.blockKey],
          aspect: 'method',
          weight: 3,
        },
      ],
      edges: [],
      merge: [],
    }
    const updated = (await runTool('library_graph', updateArgs)) as Record<string, unknown>
    const nodes = updated.nodes as Array<Record<string, unknown>>
    const curated = nodes.find((node) => node.label === 'Sparse routing')
    expect(curated).toBeDefined()
    expect(Array.isArray(curated?.blockKeys)).toBe(true)
    expect((curated?.blockKeys as string[]).includes(citation.blockKey)).toBe(true)
    assertBounded('library_graph', updateArgs, updated)

    // The curation patch persisted to graph.json on disk.
    const graphOnDisk = readDocumentJson<{ nodes: Array<{ label: string }> }>(DATA_DIR, mainId, 'graph.json')
    expect(graphOnDisk.nodes.some((node) => node.label === 'Sparse routing')).toBe(true)

    const searchArgs = { action: 'search', documentId: mainId, query: 'sparse routing' }
    const found = (await runTool('library_graph', searchArgs)) as Record<string, unknown>
    expect(Array.isArray(found.nodes)).toBe(true)
    expect((found.nodes as Array<Record<string, unknown>>).length).toBeGreaterThanOrEqual(1)
    assertBounded('library_graph', searchArgs, found)

    const libraryArgs = { action: 'library' }
    const library = (await runTool('library_graph', libraryArgs)) as Record<string, unknown>
    expect(Array.isArray(library.nodes)).toBe(true)
    assertBounded('library_graph', libraryArgs, library)

    // Failure: unknown action surfaces as a thrown Error.
    await rejectsWith(
      () => runTool('library_graph', { action: 'wat', documentId: mainId }),
      /unknown action/,
    )
  })

  it('library_manage lists/status and removes a document with real disk side effects', async () => {
    const listArgs = { action: 'list' }
    const list = (await runTool('library_manage', listArgs)) as Record<string, unknown>
    expect(list.total).toBe(2)
    const documents = list.documents as Array<Record<string, unknown>>
    const mainRow = documents.find((row) => row.documentId === mainId)
    expect(mainRow?.status).toBe('parsed')
    expect(mainRow?.pages).toBe(2)
    expect(mainRow?.engine).toBe('standard')
    expect(mainRow?.provider).toBeNull()
    expect(mainRow?.error).toBeNull()
    assertBounded('library_manage', listArgs, list)

    const statusArgs = { action: 'status' }
    const status = (await runTool('library_manage', statusArgs)) as Record<string, unknown>
    expect(String(status.version)).toMatch(/^\d+\.\d+\.\d+/)
    expect(status.tokenConfigured).toBe(false)
    expect(status.translatorAvailable).toBe(true)
    expect(status.modelAvailable).toBe(true)
    expect(status.counts).toEqual({ total: 2, parsed: 1, parsing: 0, failed: 0 })
    const ai = status.ai as Record<string, unknown>
    expect(ai.available).toBe(true)
    assertBounded('library_manage', statusArgs, status)

    // Failure: update without a title.
    await rejectsWith(
      () => runTool('library_manage', { action: 'update', documentId: spareId }),
      /title is required/,
    )

    // Delete the spare document: gone from the store and from disk.
    const deleteArgs = { action: 'delete', documentId: spareId }
    const deleted = (await runTool('library_manage', deleteArgs)) as Record<string, unknown>
    expect(deleted.removed).toBe(true)
    expect(existsSync(join(DATA_DIR, 'documents', spareId))).toBe(false)
    const afterList = (await runTool('library_manage', { action: 'list' })) as Record<string, unknown>
    expect(afterList.total).toBe(1)
  })

  it('library_ask produces a grounded answer with citations and AI annotations', async () => {
    const askArgs = { documentId: mainId, question: 'How does the router choose experts?' }
    const result = (await runTool('library_ask', askArgs)) as Record<string, unknown>
    expect(result.documentId).toBe(mainId)
    expect(result.answer).toBe(ANSWER_VISIBLE)
    const citations = result.citations as Array<Record<string, unknown>>
    expect(citations).toHaveLength(1)
    expect(citations[0]).toMatchObject({
      blockKey: citation.blockKey,
      page: citation.page,
      quote: CITATION_QUOTE,
      aspect: 'method',
      verified: true,
    })
    expect(result.unverified).toEqual([])
    expect(result.followups).toEqual(['How are the gated outputs combined?'])
    const annotationIds = result.annotationIds as string[]
    expect(annotationIds).toHaveLength(1)
    expect(typeof result.messageId).toBe('string')
    assertBounded('library_ask', askArgs, result)

    // Verified citations became an aspect annotation on disk (AI provenance).
    const annotations = readDocumentJson<{ items: Annotation[] }>(DATA_DIR, mainId, 'annotations.json')
    expect(annotations.items).toHaveLength(1)
    expect(annotations.items[0]).toMatchObject({
      origin: 'ai',
      aspect: 'method',
      chatId: `doc:${mainId}`,
      blockKey: citation.blockKey,
      quote: CITATION_QUOTE,
    })
    expect(annotations.items[0]?.id).toBe(annotationIds[0])
    // The chat turn was persisted as a pair of messages.
    const chat = readDocumentJson<{ messages: ChatMessage[] }>(DATA_DIR, mainId, 'chat.json')
    expect(chat.messages).toHaveLength(2)

    // Failure: blank question surfaces a thrown Error.
    await rejectsWith(
      () => runTool('library_ask', { documentId: mainId, question: '   ' }),
      /问题不能为空|question/,
    )
  })

  it('library_deepread returns the persisted report (null before the first run)', async () => {
    const getArgs = { action: 'get', documentId: mainId }
    const result = (await runTool('library_deepread', getArgs)) as Record<string, unknown>
    expect(result.documentId).toBe(mainId)
    // No deep-read has run for this fixture: the tool answers a null record
    // (not an error) and spends no model calls.
    expect(result.record).toBeNull()
    assertBounded('library_deepread', getArgs, result)
    expect(JSON.parse(renderTool('library_deepread', getArgs, result))).toMatchObject({
      documentId: mainId,
      record: null,
    })

    // A missing document surfaces the wire error through the tool.
    await rejectsWith(
      () => runTool('library_deepread', { action: 'get', documentId: '00000000-0000-4000-8000-000000000000' }),
      /文档不存在|Document not found/,
      'not-found',
    )
  })
})
