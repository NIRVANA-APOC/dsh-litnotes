/**
 * Registration and dispatch tests for the seven library tools
 * (docs/AI-SPEC.md §7; `src/host/agent-tools.ts`).
 *
 * Ported from the frozen 1.0.0 `ai-tools-registry.test.mjs`. A fake tool
 * registry plus a fake service keep the test independent of the full host.
 */

import { test } from 'vitest'
import { expect } from 'vitest'

import { LIBRARY_TOOL_NAMES, registerLibraryTools } from '../../src/host/agent-tools.ts'
import type { ResolvedConfig, ServiceApi } from '../../src/host/contracts.ts'
import type { ToolDefinition, ToolsService } from '../../src/host/host-services.ts'

/** Minimal resolved config for tool registration. */
const CONFIG: ResolvedConfig = {
  dataDir: '/tmp/litnotes',
  apiBase: 'https://mineru.net',
  maxUploadBytes: 200 * 1024 * 1024,
  maxConcurrentParses: 2,
  pollIntervalMs: 3000,
  parseTimeoutMs: 1800000,
  toolMaxChars: 40000,
  ai: {
    provider: '',
    model: '',
    maxContextChars: 9000,
    historyTurns: 6,
    answerMaxTokens: 4096,
    graphMaxTokens: 4096,
    graphSummaryChars: 4000,
    maxAnnotationsPerAnswer: 5,
    reasoningEffort: 'low',
    maxGraphChunks: 12,
    maxGraphSourceChars: 160000,
    entailmentCheck: true,
    entailmentMaxTokens: 600,
  },
  local: {
    enabled: true,
    maxPages: 500,
    maxPdfBytes: 200 * 1024 * 1024,
    maxTextBytes: 32 * 1024 * 1024,
    minCharsPerPage: 30,
    maxParagraphChars: 4000,
    keepContentList: true,
    timeoutMs: 120000,
    maxOfficePdfBytes: 100 * 1024 * 1024,
  },
  hostVersion: '2.0.0',
}

/** Fake tool registry capturing definitions. */
function makeTools() {
  const definitions = new Map<string, ToolDefinition>()
  const disposed: string[] = []
  const tools: ToolsService = {
    register(definition: ToolDefinition) {
      definitions.set(definition.name, definition)
      return () => {
        disposed.push(definition.name)
        definitions.delete(definition.name)
      }
    },
  }
  return { definitions, disposed, tools }
}

/** The subset of service calls the tools exercise, recorded for assertions. */
interface RecordedCall {
  name: string
  args: unknown[]
}

/** A fake service with recorded calls and mutable per-call overrides. */
function makeService(overrides: Partial<ServiceApi> = {}): ServiceApi & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const record =
    <T>(name: string, value: T | ((...args: never[]) => T | Promise<T>)) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ name, args })
      return Promise.resolve(
        typeof value === 'function' ? (value as (...inner: unknown[]) => T | Promise<T>)(...args) : value,
      )
    }
  const service: ServiceApi & { calls: RecordedCall[] } = {
    calls,
    ASPECT_COLORS: {},
    healthPing: record('healthPing', { ok: true as const, hostVersion: '0.0.0', receivedAt: '' }),
    getStatus: record('getStatus', {
      hostVersion: '0.2.0+host',
      version: '0.2.0+host',
      dataDirDisplay: '~/.dsh/litnotes',
      tokenConfigured: true,
      tokenPersistent: true,
      translatorAvailable: true,
      modelAvailable: true,
      counts: { total: 0, parsed: 0, parsing: 0, failed: 0 },
      preferences: {} as never,
      local: null,
      ai: { available: false, graph: false, route: null, retriever: false },
    }),
    listDocuments: record('listDocuments', { documents: [] }),
    getDocument: record('getDocument', {
      document: { id: 'doc-1', title: 'Paper' } as never,
      annotations: [],
      translations: { version: 1 as const, targetLanguage: 'zh', entries: {} },
    }),
    updateDocument: record('updateDocument', { document: { id: 'doc-1', title: 'Renamed' } as never }),
    removeDocument: record('removeDocument', { removed: true as const }),
    importUrl: record('importUrl', { document: { id: 'doc-1', title: 'New' } as never }),
    startParse: record('startParse', { document: { id: 'doc-1', status: 'parsing' } as never }),
    cancelParse: record('cancelParse', { document: { id: 'doc-1', status: 'uploaded' } as never }),
    readMarkdown: record('readMarkdown', { markdown: '', contentList: null, pages: null }),
    saveAnnotations: record('saveAnnotations', { saved: true as const, items: [] }),
    saveTranslations: record('saveTranslations', { saved: true as const }),
    translate: record('translate', { translation: '译文', provider: 'google', targetLanguage: 'zh' }),
    getSettings: record('getSettings', {} as never),
    setToken: record('setToken', { tokenConfigured: true as const, tokenPersistent: true }),
    clearToken: record('clearToken', { tokenConfigured: false as const, tokenPersistent: false }),
    updatePreferences: record('updatePreferences', { preferences: {} as never }),
    aiStatus: record('aiStatus', { available: false, graph: false, route: null, retriever: false }),
    chatHistory: record('chatHistory', { messages: [] }),
    chatClear: record('chatClear', { cleared: true as const }),
    chatFrames: () => (async function* frames() {})(),
    graphBuildFrames: () =>
      (async function* frames() {
        yield { type: 'progress', phase: 'reading', done: 1, total: 2 } as never
        yield {
          type: 'graph',
          graph: {
            version: 1,
            scope: 'document',
            documentId: 'doc-1',
            generatedAt: '2026-01-01T00:00:00.000Z',
            overview: '',
            nodes: [
              {
                id: 'n1',
                type: 'concept',
                label: 'BEE',
                summary: '',
                blockKeys: [],
                source: 'ai-summary',
                weight: 1,
              },
            ],
            edges: [],
            stats: { nodes: 1, edges: 0 },
          },
        } as never
      })(),
    libraryGraphBuildFrames: () =>
      (async function* frames() {
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
      })(),
    docGraph: record('docGraph', {
      graph: {
        version: 1,
        scope: 'document',
        documentId: 'doc-1',
        generatedAt: '2026-01-01T00:00:00.000Z',
        overview: 'overview',
        nodes: [
          {
            id: 'n1',
            type: 'concept',
            label: 'BEE',
            summary: 's',
            blockKeys: ['b0:deadbeef'],
            source: 'ai-summary',
            weight: 2,
          },
        ],
        edges: [],
        stats: { nodes: 1, edges: 0 },
      },
    }),
    updateDocGraph: record('updateDocGraph', {
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
    }),
    libraryGraph: record('libraryGraph', {
      graph: {
        version: 1,
        scope: 'library',
        generatedAt: '2026-01-01T00:00:00.000Z',
        overview: '',
        nodes: [],
        edges: [],
        stats: { nodes: 0, edges: 0 },
      },
    }),
    askDocument: record('askDocument', {
      documentId: 'doc-1',
      title: 'Paper',
      answer: 'answer [1]',
      citations: [
        {
          index: 1,
          blockKey: 'b0:deadbeef',
          quote: 'Paper',
          start: 0,
          end: 5,
          page: 1,
          aspect: 'method',
          note: 'claim',
          verified: true,
        },
      ],
      unverified: [],
      followups: [],
      annotationIds: ['a1'],
      graph: null,
      model: { provider: 'deepseek', model: 'deepseek-flash' },
      messageId: 'm1',
    }),
    searchDocuments: record('searchDocuments', {
      query: 'x',
      scope: 'library',
      matches: [],
      scanned: { documents: 0, blocks: 0 },
      truncated: false,
    }),
    documentModel: record('documentModel', {
      document: { id: 'doc-1', title: 'Paper', status: 'parsed', pages: 3, parse: null },
      markdown: '# Paper',
      blocks: [{ key: 'b0:deadbeef', page: 1, kind: 'heading', plainText: 'Paper' }],
      outline: [],
      stats: { blocks: 1, headings: 1, chars: 5, words: 1 },
    }),
    blockTexts: record('blockTexts', [
      { blockKey: 'b0:deadbeef', found: true, page: 1, kind: 'heading', text: 'Paper' },
    ]),
    toolList: record('toolList', { documents: [] }),
    toolGet: record('toolGet', {
      document: { id: 'doc-1' } as never,
      annotations: [],
      translations: { version: 1 as const, targetLanguage: 'zh', entries: {} },
    }),
    toolRead: record('toolRead', {
      documentId: 'doc-1',
      title: 'Paper',
      offset: 0,
      markdown: 'slice',
      nextOffset: 5,
      totalChars: 5,
      truncated: false,
    }),
    toolAnnotations: record('toolAnnotations', { documentId: 'doc-1', annotations: [] }),
    toolAnnotate: record('toolAnnotate', {
      annotation: {
        id: 'a1',
        blockKey: 'b0:deadbeef',
        start: 0,
        end: 5,
        quote: 'Paper',
        color: 'yellow',
      } as never,
      created: true,
    }),
    toolUnannotate: record('toolUnannotate', { removed: true }),
    ...overrides,
  }
  return service
}

/** Extract the plain text of a tool result block list. */
function resultText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.map((block) => block.text ?? '').join('\n')
}

/** Invoke one registered tool and render its result. */
async function run(
  tools: ReturnType<typeof makeTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ value: unknown; text: string }> {
  const definition = tools.definitions.get(name)
  if (definition === undefined) throw new Error(`tool ${name} not registered`)
  const value = await definition.execute(args)
  const blocks = definition.output.render(args, value)
  expect(Array.isArray(blocks)).toBe(true)
  expect(blocks[0]?.type).toBe('text')
  return { value, text: resultText(blocks as Array<{ type: string; text?: string }>) }
}

/** Render a tool result as a typed record for assertions. */
function recordOf(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

test('all seven library tools register and dispose cleanly', () => {
  const tools = makeTools()
  const dispose = registerLibraryTools({ tools: tools.tools, service: makeService(), config: CONFIG })
  expect([...tools.definitions.keys()].sort()).toEqual([...LIBRARY_TOOL_NAMES].sort())
  for (const name of LIBRARY_TOOL_NAMES) {
    const definition = tools.definitions.get(name)
    expect(definition).toBeTruthy()
    expect(typeof definition?.description).toBe('string')
    expect((definition?.description ?? '').length).toBeGreaterThan(20)
    expect(definition?.parameters.type).toBe('object')
    expect(definition?.parameters.additionalProperties).toBe(false)
    expect(Array.isArray(definition?.parameters.required ?? [])).toBe(true)
    expect(definition?.output.schema).toEqual({ type: 'object' })
    expect(typeof definition?.execute).toBe('function')
    expect(typeof definition?.output.render).toBe('function')
  }
  dispose()
  expect(tools.definitions.size).toBe(0)
  expect(tools.disposed.length).toBe(7)
})

test('registration is a no-op when the tools service is missing', () => {
  const dispose = registerLibraryTools({ tools: undefined, service: makeService(), config: CONFIG })
  expect(typeof dispose).toBe('function')
  expect(() => dispose()).not.toThrow()
})

test('search/read/ask/annotate/translate/graph/manage dispatch through the service', async () => {
  const tools = makeTools()
  const service = makeService()
  registerLibraryTools({ tools: tools.tools, service, config: CONFIG })

  const search = await run(tools, 'library_search', { query: 'BEE' })
  expect(recordOf(search.value).matches).toEqual([])
  expect(service.calls.find((call) => call.name === 'searchDocuments')?.args[0]).toMatchObject({ query: 'BEE' })

  const read = await run(tools, 'library_read', { documentId: 'doc-1', view: 'meta' })
  expect(recordOf(read.value).documentId).toBe('doc-1')
  expect(service.calls.find((call) => call.name === 'documentModel')?.args[0]).toBe('doc-1')

  const readText = await run(tools, 'library_read', { documentId: 'doc-1' })
  expect(recordOf(readText.value).markdown).toBe('slice')
  expect(service.calls.filter((call) => call.name === 'toolRead').length).toBe(1)

  const ask = await run(tools, 'library_ask', { documentId: 'doc-1', question: 'What is BEE?' })
  expect((recordOf(ask.value).citations as unknown[]).length).toBe(1)
  expect(String(recordOf(ask.value).answer)).toContain('answer')

  const annotate = await run(tools, 'library_annotate', {
    action: 'create',
    documentId: 'doc-1',
    annotation: { quote: 'Paper', aspect: 'method' },
  })
  expect(recordOf(recordOf(annotate.value).annotation).id).toBe('a1')
  expect(service.calls.find((call) => call.name === 'toolAnnotate')?.args[0]).toBe('doc-1')

  const translate = await run(tools, 'library_translate', { documentId: 'doc-1', text: 'hello' })
  expect(recordOf(translate.value).translation).toBe('译文')

  const graph = await run(tools, 'library_graph', { action: 'build', documentId: 'doc-1' })
  expect((recordOf(graph.value).nodes as unknown[]).length).toBe(1)
  expect(recordOf(graph.value).progressFrames).toBe(1)

  const libraryGraph = await run(tools, 'library_graph', { action: 'library' })
  expect(recordOf(libraryGraph.value).scope).toBe('library')

  const manage = await run(tools, 'library_manage', { action: 'status' })
  expect(recordOf(manage.value).dataDir).toBe('~/.dsh/litnotes')

  const list = await run(tools, 'library_manage', { action: 'list' })
  expect(recordOf(list.value).total).toBe(0)
})

test('library_manage covers parse/repair/cancel/import/update/delete actions', async () => {
  const tools = makeTools()
  const service = makeService()
  registerLibraryTools({ tools: tools.tools, service, config: CONFIG })

  const parse = await run(tools, 'library_manage', {
    action: 'parse',
    documentId: 'doc-1',
    parse: { engine: 'auto' },
  })
  expect(recordOf(parse.value).parsing).toBe(true)
  expect(service.calls.find((call) => call.name === 'startParse')?.args[1]).toEqual({ engine: 'auto' })

  const repair = await run(tools, 'library_manage', { action: 'repair', documentId: 'doc-1', pages: [2, 3] })
  expect(recordOf(repair.value).repairing).toBe(true)
  const repairCall = service.calls.filter((call) => call.name === 'startParse').at(-1)
  expect(repairCall?.args[1]).toMatchObject({ merge: true, pages: [2, 3] })

  const cancel = await run(tools, 'library_manage', { action: 'cancel', documentId: 'doc-1' })
  expect(recordOf(cancel.value).cancelled).toBe(true)

  const imported = await run(tools, 'library_manage', { action: 'import_url', url: 'https://example.test/a.pdf' })
  expect(recordOf(imported.value).imported).toBe(true)

  const updated = await run(tools, 'library_manage', { action: 'update', documentId: 'doc-1', title: 'Renamed' })
  expect(recordOf(updated.value).title).toBe('Renamed')

  const deleted = await run(tools, 'library_manage', { action: 'delete', documentId: 'doc-1' })
  expect(recordOf(deleted.value).removed).toBe(true)

  await expect(run(tools, 'library_manage', { action: 'nonsense', documentId: 'doc-1' })).rejects.toThrow(
    /unknown action/,
  )
})

test('tool results are bounded text blocks', async () => {
  const tools = makeTools()
  registerLibraryTools({ tools: tools.tools, service: makeService(), config: CONFIG })
  const definition = tools.definitions.get('library_search')
  const huge = { matches: Array.from({ length: 2000 }, (_, index) => ({ index, snippet: 'x'.repeat(100) })) }
  const blocks = definition?.output.render({ query: 'x' }, huge) ?? []
  const text = resultText(blocks as Array<{ type: string; text?: string }>)
  expect(text.length).toBeLessThanOrEqual(16000 + 100)
  expect(text).toContain('truncated')
  expect((blocks[0] as { type: string }).type).toBe('text')
})

test('tool failures surface as plain errors with the wire message', async () => {
  const tools = makeTools()
  const service = makeService({
    searchDocuments: async () => {
      const error = new Error('查询不能为空（query must not be empty）') as Error & { code?: string }
      error.code = 'bad-request'
      throw error
    },
  })
  registerLibraryTools({ tools: tools.tools, service, config: CONFIG })
  const search = tools.definitions.get('library_search')
  await expect(search?.execute({ query: 'x' })).rejects.toThrow(/查询不能为空/)
  const manage = tools.definitions.get('library_manage')
  await expect(manage?.execute({ action: 'nonsense', documentId: 'doc-1' })).rejects.toThrow(/unknown action/)
})

test('library_read covers block and page views', async () => {
  const tools = makeTools()
  const service = makeService()
  registerLibraryTools({ tools: tools.tools, service, config: CONFIG })

  const block = await run(tools, 'library_read', { documentId: 'doc-1', view: 'block', blockKey: 'b0:deadbeef' })
  expect(recordOf(recordOf(block.value).blocks)[0]).toEqual({
    blockKey: 'b0:deadbeef',
    found: true,
    page: 1,
    kind: 'heading',
    text: 'Paper',
  })

  const page = await run(tools, 'library_read', { documentId: 'doc-1', view: 'page', page: 1 })
  expect(recordOf(page.value).page).toBe(1)
  expect(recordOf(page.value).text).toBe('Paper')
  expect(recordOf(page.value).truncated).toBe(false)

  const noPage = await run(tools, 'library_read', { documentId: 'doc-1', view: 'page', page: 9 }).catch(
    (error: unknown) => error,
  )
  expect(noPage).toBeInstanceOf(Error)
  expect((noPage as Error).message).toMatch(/no blocks/)
})

test('library_annotate list and delete dispatch through the service', async () => {
  const tools = makeTools()
  const service = makeService({
    getDocument: async () => ({
      document: { id: 'doc-1' } as never,
      annotations: [
        {
          id: 'a1',
          blockKey: 'b0:deadbeef',
          start: 0,
          end: 5,
          quote: 'Paper',
          color: 'sage',
          origin: 'ai',
          aspect: 'method',
        },
        {
          id: 'a2',
          blockKey: 'b1:feedface',
          start: 0,
          end: 5,
          quote: 'Body',
          color: 'yellow',
          origin: 'user',
        },
      ],
      translations: { version: 1, targetLanguage: 'zh', entries: {} },
    }),
  })
  registerLibraryTools({ tools: tools.tools, service, config: CONFIG })

  const list = await run(tools, 'library_annotate', {
    action: 'list',
    documentId: 'doc-1',
    origin: 'ai',
    aspect: 'method',
  })
  expect(recordOf(list.value).count).toBe(1)
  expect((recordOf(list.value).annotations as Array<{ id: string }>)[0]?.id).toBe('a1')

  const removed = await run(tools, 'library_annotate', {
    action: 'delete',
    documentId: 'doc-1',
    annotationId: 'a1',
  })
  expect(recordOf(removed.value).removed).toBe(true)
})

test('library_translate translates block keys with page coordinates', async () => {
  const tools = makeTools()
  const service = makeService()
  registerLibraryTools({ tools: tools.tools, service, config: CONFIG })
  const result = await run(tools, 'library_translate', {
    documentId: 'doc-1',
    blockKeys: ['b0:deadbeef'],
    targetLanguage: 'en',
  })
  const translations = recordOf(result.value).translations as Array<Record<string, unknown>>
  expect(translations.length).toBe(1)
  expect(translations[0]?.blockKey).toBe('b0:deadbeef')
  expect(translations[0]?.page).toBe(1)
  expect(translations[0]?.translation).toBe('译文')
  expect(translations[0]?.provider).toBe('google')

  const missing = await run(tools, 'library_translate', { documentId: 'doc-1' }).catch(
    (error: unknown) => error,
  )
  expect((missing as Error).message).toMatch(/provide text or blockKeys/)
})

test('library_graph covers get/search/update/rebuild actions', async () => {
  const tools = makeTools()
  const service = makeService()
  registerLibraryTools({ tools: tools.tools, service, config: CONFIG })

  const get = await run(tools, 'library_graph', { action: 'get', documentId: 'doc-1' })
  expect(recordOf(get.value).scope).toBe('document')
  expect((recordOf(get.value).nodes as Array<{ id: string }>)[0]?.id).toBe('n1')

  const search = await run(tools, 'library_graph', { action: 'search', documentId: 'doc-1', query: 'bee' })
  expect((recordOf(search.value).nodes as unknown[]).length).toBe(1)

  const update = await run(tools, 'library_graph', { action: 'update', documentId: 'doc-1', nodes: [], edges: [] })
  expect(recordOf(update.value).documentId).toBe('doc-1')

  const rebuild = await run(tools, 'library_graph', { action: 'rebuild' })
  expect(recordOf(rebuild.value).progressFrames).toBe(1)

  const unknown = await run(tools, 'library_graph', { action: 'nope', documentId: 'doc-1' }).catch(
    (error: unknown) => error,
  )
  expect((unknown as Error).message).toMatch(/unknown action/)
})

test('rendered results are valid JSON unless truncated', async () => {
  const tools = makeTools()
  registerLibraryTools({ tools: tools.tools, service: makeService(), config: CONFIG })
  const definition = tools.definitions.get('library_manage')
  const value = await definition?.execute({ action: 'list' })
  const blocks = definition?.output.render({ action: 'list' }, value) ?? []
  const text = resultText(blocks as Array<{ type: string; text?: string }>)
  expect(() => JSON.parse(text)).not.toThrow()
  const parsed = JSON.parse(text) as { total: number; documents: unknown[] }
  expect(parsed.total).toBe(0)
  expect(parsed.documents).toEqual([])
})
