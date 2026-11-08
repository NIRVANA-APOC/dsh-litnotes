/**
 * Unit tests for the lazy AI service bundle (`src/host/ai/index.ts`): the
 * `ensure()`/`peek()` lifecycle the Host composition root relies on, lazy
 * service getters (llm/tokenMeter may mount after the plugin boots), the
 * `AiServicesApi` shape and the degraded graph service fallback.
 */

import { expect, test } from 'vitest'
import { createAiServices, type AiServicesDeps } from '../../src/host/ai/index.ts'
import { createFakeDefaultModel, createFakeLlm, type FakeLlm } from '../helpers/fake-llm.ts'
import type { ResolvedConfig, StoreApi } from '../../src/host/contracts.ts'

/** Minimal resolved Host config for the engine (AI budgets only matter here). */
function makeConfig(): ResolvedConfig {
  return {
    dataDir: '/tmp/litnotes-test',
    apiBase: '/dsh-litnotes/api',
    maxUploadBytes: 1000,
    maxConcurrentParses: 1,
    pollIntervalMs: 10,
    parseTimeoutMs: 1000,
    toolMaxChars: 1000,
    ai: {
      provider: '',
      model: '',
      maxContextChars: 9000,
      historyTurns: 6,
      answerMaxTokens: 1024,
      graphMaxTokens: 3000,
      graphSummaryChars: 4000,
      maxAnnotationsPerAnswer: 5,
      reasoningEffort: 'low',
      maxGraphChunks: 12,
      maxGraphSourceChars: 160000,
      entailmentCheck: true,
      entailmentMaxTokens: 600,
      deepReadMaxChunks: 24,
      deepReadMaxSourceChars: 240000,
      deepReadMaxAnnotations: 24,
      deepReadMaxTokens: 2400,
      deepReadSynthesisChars: 14000,
      deepReadCoveragePass: true,
      deepReadJudge: true,
    },
    local: {
      enabled: false,
      maxPages: 1,
      maxPdfBytes: 1,
      maxTextBytes: 1,
      minCharsPerPage: 1,
      maxParagraphChars: 1,
      keepContentList: false,
      timeoutMs: 1,
      maxOfficePdfBytes: 1,
    },
    hostVersion: '1.0.0',
  }
}

/** A store stub exposing just what the bundle's factories validate at construction. */
function makeStore(): StoreApi {
  const store = {
    list: () => [],
    readMarkdown: async () => ({ markdown: '', contentList: null, pages: null }),
    loadAnnotations: async () => ({ version: 1 as const, items: [] }),
    saveAnnotations: async () => ({ version: 1 as const, items: [] }),
    mutateAnnotations: async () => ({ version: 1 as const, items: [] }),
    readAux: async () => undefined,
    writeAux: async () => undefined,
    readLibraryAux: async () => undefined,
    writeLibraryAux: async () => undefined,
    mutateAux: async (_id: string, _name: string, mutate: (current: unknown) => unknown) => mutate(undefined),
    get: () => undefined,
  }
  return store as unknown as StoreApi
}

/** Bundle deps with a fake Host llm + default model. */
function makeDeps(fake: FakeLlm = createFakeLlm()): AiServicesDeps {
  return {
    store: makeStore(),
    config: makeConfig(),
    logger: { warn(): void {}, debug(): void {}, error(): void {} },
    getLlm: () => fake,
    getDefaultModel: () => createFakeDefaultModel(),
    getTokenMeter: () => undefined,
    hostVersion: '1.0.0-test',
  }
}

test('peek() is empty until ensure() builds the bundle and memoizes it', async () => {
  const bundle = createAiServices(makeDeps())
  expect(bundle.peek()).toBeUndefined()
  const built = await bundle.ensure()
  expect(built).toBeDefined()
  expect(bundle.peek()).toBe(built)
  // A second ensure resolves the same bundle instance (lazy creation).
  expect(await bundle.ensure()).toBe(built)
  expect(built.llm).toBeDefined()
  expect(built.retriever).toBeDefined()
  expect(built.chat).toBeDefined()
  expect(built.graph).toBeDefined()
  expect(built.deepread).toBeDefined()
  expect(typeof built.available).toBe('boolean')
  expect(built.version).toBe('1.0.0-test')
})

test('the AiServicesApi surface matches the contract (available/version/engines)', async () => {
  const deps = makeDeps()
  const built = await createAiServices(deps).ensure()
  expect(built.available).toBe(true)
  expect(built.llm.available()).toBe(true)
  expect(built.llm.route()).toEqual({ provider: 'fake-provider', model: 'fake-model' })
  expect(typeof built.chat.history).toBe('function')
  expect(typeof built.chat.clear).toBe('function')
  expect(typeof built.chat.stream).toBe('function')
  expect(typeof built.graph.docGraph).toBe('function')
  expect(typeof built.graph.buildDocGraph).toBe('function')
  expect(typeof built.graph.libraryGraph).toBe('function')
  expect(typeof built.deepread.get).toBe('function')
  expect(typeof built.deepread.run).toBe('function')
  // The concrete retriever also exposes the contract's blocks() helper.
  expect(built.retriever.blocks({ documentId: 'doc-1', markdown: '', contentList: null })).toEqual([])
})

test('host service getters stay lazy: services may mount after the bundle is built', async () => {
  let fake: FakeLlm | undefined
  let selection: ReturnType<typeof createFakeDefaultModel> | undefined
  const deps = makeDeps()
  // The composition root passes closures over `ctx.get(...)`; the services can
  // mount after the plugin (and therefore after the bundle) is created.
  deps.getLlm = () => fake
  deps.getDefaultModel = () => selection
  const built = await createAiServices(deps).ensure()
  expect(built.available).toBe(false)
  // The Host mounts the services later; the gateway reads the getters per call.
  fake = createFakeLlm()
  selection = createFakeDefaultModel()
  expect(built.llm.available()).toBe(true)
  expect(built.llm.route()).toEqual({ provider: 'fake-provider', model: 'fake-model' })
})

test('the token meter is injected for the prompt context budget', async () => {
  const deps = makeDeps()
  deps.getTokenMeter = () => ({
    estimateMessage: (message: { content: Array<{ text: string }> }) => message.content[0]?.text.length ?? 0,
  })
  const built = await createAiServices(deps).ensure()
  // estimateTokens is the concrete-gateway helper (Host meter: 1 token/char).
  const gateway = built.llm as unknown as { estimateTokens: (text: string) => number }
  expect(gateway.estimateTokens('abcdefgh')).toBe(8)
})

test('a store without the aux API degrades the graph service instead of failing the bundle', async () => {
  const deps = makeDeps()
  // `list` is required by the graph factory; omitting it forces the fallback.
  deps.store = { ...makeStore(), list: undefined } as unknown as StoreApi
  const built = await createAiServices(deps).ensure()
  expect(built.graph).toBeDefined()
  await expect(built.graph.docGraph('doc-1')).rejects.toThrow(/知识图谱服务不可用|Knowledge-graph service unavailable/)
  // Chat still works with the same store shape (it only needs readMarkdown).
  expect(typeof built.chat.stream).toBe('function')
})

