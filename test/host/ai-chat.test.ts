/**
 * Unit tests for the grounded chat service (`src/host/ai/chat.ts`): NDJSON
 * frame sequence, fence hold-back, citation verification (whitespace
 * normalization, prefix fallback, invalid blocks), annotation creation/dedupe/
 * caps, chat.json persistence, history trimming, knowledge deltas, error frames,
 * aborts, the entailment second pass and concurrent-writer merges.
 *
 * Everything is in-memory: a fake Host llm (`test/helpers/fake-llm.ts`) and a
 * fake store aux API — no temp dirs, no network.
 */

import { expect, test } from 'vitest'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { plainTextOfBlock } from '../../src/shared/markdown/model.ts'
import {
  createFakeLlm,
  entailmentText,
  litnotesAnswerText,
  type FakeCitation,
  type FakeLlm,
  type FakeLlmScript,
} from '../helpers/fake-llm.ts'
import { createLlmGateway } from '../../src/host/ai/llm.ts'
import { createRetriever } from '../../src/host/ai/retrieval.ts'
import {
  createChatService,
  locateQuoteRange,
  normalizeQuoteText,
  splitModelOutput,
  type ChatService,
  type ChatServiceDeps,
} from '../../src/host/ai/chat.ts'
import { ANSWER_FENCE_TAG, CHAT_SYSTEM, ENTAILMENT_FENCE_TAG, PROMPT_VERSION } from '../../src/host/ai/prompts.ts'
import type { Annotation, AnnotationEnvelope, ChatFrame, ChatRequest, Citation, KnowledgeDelta, ParsedDocument } from '../../src/shared/model.ts'
import type { AiConfig } from '../../src/host/contracts.ts'

const quietLogger = { debug(): void {}, warn(): void {}, error(): void {} }
const DOC_ID = 'doc-1'

const MARKDOWN = `# Sparse Attention for Long Documents

## Abstract

We study efficient attention for long documents. Our sparse attention method reduces memory by 60% while keeping accuracy.

## 1 Introduction

Transformers are expensive for long documents. Sparse attention is a common solution.

## 2 Method

We propose block-sparse attention with learned routing. The routing network selects relevant blocks for each query token.

## 3 Results

On the LongBench benchmark our method improves throughput by 2.4x with equal accuracy.

## 4 Limitations

Routing adds latency on short sequences and requires a warm-up phase.
`

const CAP_MARKDOWN = `# Six Findings

Alpha sentence about bird migration patterns.

Beta sentence about ocean current models.

Gamma sentence about quantum dot synthesis.

Delta sentence about protein folding energy.

Epsilon sentence about graph matching algorithms.

Zeta sentence about reinforcement learning agents.
`

/** A started/answer frame narrowed by its type tag. */
type FrameOf<T extends ChatFrame['type']> = Extract<ChatFrame, { type: T }>

/** All frames of one type (typed). */
function framesOf<T extends ChatFrame['type']>(frames: readonly ChatFrame[], type: T): Array<FrameOf<T>> {
  return frames.filter((frame): frame is FrameOf<T> => frame.type === type)
}

/** The first frame of one type (fails the test when absent). */
function findFrame<T extends ChatFrame['type']>(frames: readonly ChatFrame[], type: T): FrameOf<T> {
  const frame = frames.find((candidate): candidate is FrameOf<T> => candidate.type === type)
  expect(frame, `expected a ${type} frame`).toBeDefined()
  if (frame === undefined) throw new Error(`missing ${type} frame`)
  return frame
}

/** Streamed delta text, joined. */
function streamedText(frames: readonly ChatFrame[]): string {
  return framesOf(frames, 'delta').map((frame) => frame.text).join('')
}

/** Read the host-computed offsets of a verified citation (fails when absent). */
function offsetsOf(citation: Citation): { start: number; end: number } {
  expect(typeof citation.start, 'verified citations carry a start offset').toBe('number')
  expect(typeof citation.end, 'verified citations carry an end offset').toBe('number')
  return { start: citation.start as number, end: citation.end as number }
}

/** Stable error code of one frame (`''` for non-error frames). */
function errorCodeOf(frame: ChatFrame | undefined): string {
  return frame !== undefined && frame.type === 'error' ? frame.code : ''
}

/** Find one parser block by a text fragment. */
function blockWith(markdown: string, fragment: string): { key: string; plainText: string } {
  const model = parseMarkdown(markdown)
  const block = model.blocks.find(
    (candidate) => typeof candidate.plainText === 'string' && candidate.plainText.includes(fragment),
  )
  expect(block, `expected a block containing: ${fragment}`).toBeDefined()
  if (block === undefined) throw new Error(`missing block containing: ${fragment}`)
  return block
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** The persisted 1.0.0 chat message shape (asserted by the ported tests). */
interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  question?: string
  answer?: string
  promptVersion?: number
  citations?: Citation[]
  unverified?: Citation[]
  followups?: string[]
  model?: { provider: string; model: string }
  usage?: { inputTokens?: number; outputTokens?: number }
  annotationIds?: string[]
  knowledge?: { nodeIds: string[]; edgeIds: string[] }
  entailment?: { checked: boolean; supported: number; partial: number; unsupported: number }
  createdAt: string
}

/** The persisted `chat.json` shape. */
interface StoredChatFile {
  version: 1
  messages: StoredMessage[]
}

/** One fake store operation payload for whole-list annotation saves. */
interface SavedAnnotations {
  version?: 1
  items?: Annotation[]
  baseIds?: string[]
}

/** In-memory store with aux + annotation support. */
interface FakeStore {
  aux: Map<string, unknown>
  state: { annotations: AnnotationEnvelope }
  readMarkdown: (documentId: string) => Promise<ParsedDocument>
  get: (documentId: string) => { id: string; title: string }
  readAux: (documentId: string, name: string) => Promise<unknown>
  writeAux: (documentId: string, name: string, value: unknown) => Promise<void>
  loadAnnotations: (documentId: string) => Promise<AnnotationEnvelope>
  saveAnnotations: (documentId: string, data: SavedAnnotations) => Promise<AnnotationEnvelope>
  mutateAnnotations: (
    documentId: string,
    mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>,
  ) => Promise<AnnotationEnvelope>
  mutateAux: <T>(documentId: string, name: string, mutate: (current: T | undefined) => T | Promise<T>) => Promise<T | undefined>
}

/**
 * Build an in-memory store with aux + annotation support.
 *
 * Serializes annotation/aux read-modify-write operations on one promise chain,
 * mirroring the host store's per-document write queue, so the concurrency tests
 * are meaningful.
 */
function makeStore(options: {
  markdown?: string
  contentList?: unknown[] | null
  annotations?: Annotation[]
  readCode?: string | null
  title?: string
} = {}): FakeStore {
  const markdown = options.markdown ?? MARKDOWN
  const contentList = options.contentList ?? null
  const readCode = options.readCode ?? null
  const aux = new Map<string, unknown>()
  const state = { annotations: { version: 1 as const, items: structuredClone(options.annotations ?? []) } }
  const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))
  let chain: Promise<unknown> = Promise.resolve()
  /** Serialize one task on the store's write chain (like the real per-doc queue). */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task) as Promise<T>
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  const store: FakeStore = {
    aux,
    state,
    async readMarkdown(): Promise<ParsedDocument> {
      if (readCode !== null) {
        const error = new Error('文档尚未解析完成（Document has not been parsed yet）') as Error & { code: string }
        error.code = readCode
        throw error
      }
      return { markdown, contentList: contentList as ParsedDocument['contentList'], pages: null }
    },
    get(): { id: string; title: string } {
      return { id: DOC_ID, title: options.title ?? 'Sparse Attention for Long Documents' }
    },
    readAux(documentId: string, name: string): Promise<unknown> {
      return serial(async () => {
        const value = aux.get(`${documentId}/${name}`)
        return value === undefined ? null : clone(value)
      })
    },
    writeAux(documentId: string, name: string, value: unknown): Promise<void> {
      return serial(async () => {
        aux.set(`${documentId}/${name}`, clone(value))
      })
    },
    loadAnnotations(): Promise<AnnotationEnvelope> {
      return serial(async () => clone(state.annotations))
    },
    saveAnnotations(_documentId: string, data: SavedAnnotations): Promise<AnnotationEnvelope> {
      return serial(async () => {
        const normalized: AnnotationEnvelope = {
          version: 1,
          items: (Array.isArray(data.items) ? data.items : []).map((item) => clone(item)),
        }
        if (Array.isArray(data.baseIds)) {
          const base = new Set(data.baseIds)
          const incoming = new Set(normalized.items.map((item) => item?.id))
          for (const item of state.annotations.items) {
            if (base.has(item.id) || incoming.has(item.id)) continue
            normalized.items.push(clone(item))
          }
        }
        state.annotations = normalized
        return clone(normalized)
      })
    },
    mutateAnnotations(
      _documentId: string,
      mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>,
    ): Promise<AnnotationEnvelope> {
      return serial(async () => {
        const draft = state.annotations.items.map((item) => clone(item))
        const mutated = await mutate(draft)
        const items = Array.isArray(mutated) ? mutated : draft
        state.annotations = { version: 1, items: items.map((item) => clone(item)) }
        return clone(state.annotations)
      })
    },
    mutateAux<T>(documentId: string, name: string, mutate: (current: T | undefined) => T | Promise<T>): Promise<T | undefined> {
      return serial(async () => {
        const key = `${documentId}/${name}`
        const current = aux.has(key) ? (clone(aux.get(key)) as T) : undefined
        const next = await mutate(current)
        if (next === undefined) return undefined
        aux.set(key, clone(next))
        return clone(next)
      })
    },
  }
  return store
}

/** The harness returned by {@link makeChat}. */
interface ChatHarness {
  chat: ChatService
  store: FakeStore
  fake: FakeLlm
}

/** Options accepted by {@link makeChat}. */
interface MakeChatOptions {
  store?: FakeStore
  fake?: FakeLlm
  hostLlm?: unknown
  config?: { ai?: Partial<AiConfig> }
  onGraphDelta?: ChatServiceDeps['onGraphDelta']
  mutate?: boolean
  entailment?: FakeLlmScript | false
}

/**
 * Build a chat service over fakes.
 *
 * The citation–claim entailment pass is a second model call per answer: a
 * persistent fake-llm rule matched on its fence tag answers it (default: no
 * verdicts → citations stay verified as `unchecked`), so queued scripts keep
 * scripting the answer call. `mutate:false` omits the atomic store hooks to
 * exercise the load/save fallback.
 */
function makeChat(options: MakeChatOptions = {}): ChatHarness {
  const store = options.store ?? makeStore()
  const fake = options.fake ?? createFakeLlm()
  const config = options.config ?? {}
  const entailment = options.entailment === undefined ? { text: entailmentText([]) } : options.entailment
  if (entailment !== false) fake.match(ENTAILMENT_FENCE_TAG, entailment)
  const llm = createLlmGateway({
    getLlm: () => options.hostLlm ?? fake,
    getDefaultModel: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    config: { ai: {} },
    logger: quietLogger,
  })
  const retriever = createRetriever({ parseMarkdown, plainTextOfBlock, logger: quietLogger })
  const chat = createChatService({
    llm,
    retriever,
    // The fake implements the store subset the engine consumes; the cast keeps
    // the test double free of the full StoreApi surface.
    store: store as unknown as ChatServiceDeps['store'],
    config: {
      ai: {
        maxContextChars: 9000,
        historyTurns: 6,
        answerMaxTokens: 1024,
        maxAnnotationsPerAnswer: 5,
        ...(config.ai ?? {}),
      },
    },
    logger: quietLogger,
    loadAnnotations: (id) => store.loadAnnotations(id),
    saveAnnotations: (id, data) => store.saveAnnotations(id, data),
    ...(options.mutate === false
      ? {}
      : {
          mutateAnnotations: (id, mutate) => store.mutateAnnotations(id, mutate),
          mutateAux: (id, name, mutate) => store.mutateAux(id, name, mutate),
        }),
    onGraphDelta: options.onGraphDelta,
  })
  return { chat, store, fake }
}

/** Drain one stream into frames. */
async function collectFrames(chat: ChatService, request: ChatRequest): Promise<ChatFrame[]> {
  const frames: ChatFrame[] = []
  for await (const frame of chat.stream(request)) frames.push(frame)
  return frames
}

/** Prompt of the most recent grounded-answer call (never the entailment pass). */
function chatPrompt(fake: FakeLlm): string {
  return fake.lastCallMatching(ANSWER_FENCE_TAG)?.prompt ?? ''
}

/** A request with an optional abort signal carried Frozen-style on the object. */
type TestRequest = ChatRequest & { signal?: AbortSignal }

/** Standard question payload. */
function question(extra: Partial<TestRequest> = {}): TestRequest {
  return { documentId: DOC_ID, question: 'What method does the paper propose?', ...extra }
}

/** Parse the persisted chat.json, or null. */
function chatFile(store: FakeStore): StoredChatFile | null {
  const value = store.aux.get(`${DOC_ID}/chat.json`)
  return value === undefined ? null : (value as StoredChatFile)
}

/** Build one verified citation entry for the fixture. */
function citation(
  index: number,
  fragment: string,
  markdown: string = MARKDOWN,
  extra: Partial<FakeCitation> = {},
): FakeCitation {
  const block = blockWith(markdown, fragment)
  return {
    index,
    blockKey: block.key,
    quote: block.plainText,
    aspect: 'method',
    note: `supports claim ${index}`,
    ...extra,
  }
}

/* -------------------------------------------------------------------------- */
/* Happy path: frames, citations, annotations, persistence                    */
/* -------------------------------------------------------------------------- */

test('a grounded turn streams start → deltas → answer → graph → done and persists the turn', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const results = blockWith(MARKDOWN, '2.4x')
  const graphCalls: Array<{ documentId: string; delta: KnowledgeDelta & { question: string } }> = []
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The paper proposes block-sparse attention with learned routing [1]. It improves throughput by 2.4x [2].',
    citations: [
      { index: 1, blockKey: method.key, quote: 'We propose block-sparse attention with learned routing.', aspect: 'method', note: 'the core method' },
      { index: 2, blockKey: results.key, quote: 'improves throughput by 2.4x with equal accuracy', aspect: 'result', note: 'the main result' },
    ],
    followups: ['What is the routing network?', 'What does the benchmark measure?'],
    knowledge: {
      nodes: [
        { type: 'method', label: 'block-sparse attention', summary: 'Sparse attention with learned routing.', blockKeys: [method.key] },
      ],
      edges: [],
    },
  })
  const store = makeStore()
  const { chat } = makeChat({
    store,
    fake,
    onGraphDelta: async (documentId, delta) => {
      graphCalls.push({ documentId, delta })
      return { nodes: [{ id: 'n-1', label: 'block-sparse attention' }], edges: [] }
    },
  })
  const frames = await collectFrames(chat, question())

  const start = findFrame(frames, 'start')
  expect(start.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
  expect(start.messageId).toMatch(/^[0-9a-f-]{36}$/)
  const answer = findFrame(frames, 'answer')
  expect(answer.messageId).toBe(start.messageId)
  expect(answer.followups).toEqual(['What is the routing network?', 'What does the benchmark measure?'])

  // The streamed deltas never contain the JSON fence and add up to the answer.
  const deltas = streamedText(frames)
  expect(deltas.includes('litnotes-json')).toBe(false)
  expect(deltas.includes('```')).toBe(false)
  expect(deltas.trimEnd()).toBe(answer.markdown)
  expect(answer.markdown.includes('litnotes-json')).toBe(false)

  // Citations are verified with host-computed offsets into the block plain text.
  expect(answer.citations.length).toBe(2)
  expect(answer.unverified.length).toBe(0)
  const [first, second] = answer.citations
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  if (first === undefined || second === undefined) throw new Error('missing citations')
  expect(first.verified).toBe(true)
  expect(first.blockKey).toBe(method.key)
  expect(first.aspect).toBe('method')
  const firstOffsets = offsetsOf(first)
  expect(firstOffsets.start).toBe(0)
  expect(method.plainText.slice(firstOffsets.start, firstOffsets.end)).toBe(
    'We propose block-sparse attention with learned routing.',
  )
  expect(second.aspect).toBe('result')
  expect(second.page).toBeNull()

  // Annotations: one per verified citation, aspect-colored, with provenance.
  expect(answer.annotationIds.length).toBe(2)
  expect(store.state.annotations.items.length).toBe(2)
  expect(answer.annotationIds).toEqual(store.state.annotations.items.map((item) => item.id))
  const annotations = store.state.annotations.items
  const annotation = annotations[0]
  expect(annotation).toBeDefined()
  if (annotation === undefined) throw new Error('missing annotation')
  expect(annotation.color).toBe('sage')
  expect(annotation.origin).toBe('ai')
  expect(annotation.aspect).toBe('method')
  expect(annotation.chatId).toBe(`doc:${DOC_ID}`)
  expect(annotation.messageId).toBe(answer.messageId)
  expect(annotation.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
  const secondOffsets = offsetsOf(second)
  expect(annotations[1]?.color).toBe('sky')
  expect(annotations[1]?.start).toBe(secondOffsets.start)
  expect(annotations[1]?.end).toBe(secondOffsets.end)

  // Knowledge delta: only verified block keys survive; graph frame + callback.
  expect(graphCalls.length).toBe(1)
  expect(graphCalls[0]?.documentId).toBe(DOC_ID)
  expect(graphCalls[0]?.delta.question).toBe(question().question)
  expect(graphCalls[0]?.delta.nodes?.[0]?.blockKeys).toEqual([method.key])
  const graphFrame = findFrame(frames, 'graph')
  expect(graphFrame.delta.nodes?.[0]?.label).toBe('block-sparse attention')
  expect((graphFrame.delta.nodes?.[0] as { source?: string } | undefined)?.source).toBe('qa')

  // Persistence: user + assistant ChatMessage with model/promptVersion/usage.
  const file = chatFile(store)
  expect(file).not.toBeNull()
  if (file === null) throw new Error('missing chat file')
  expect(file.version).toBe(1)
  expect(file.messages.length).toBe(2)
  expect(file.messages[0]?.role).toBe('user')
  expect(file.messages[0]?.question).toBe(question().question)
  expect(file.messages[0]?.promptVersion).toBe(PROMPT_VERSION)
  const assistant = file.messages[1]
  expect(assistant).toBeDefined()
  if (assistant === undefined) throw new Error('missing assistant message')
  expect(assistant.role).toBe('assistant')
  expect(assistant.id).toBe(answer.messageId)
  expect(assistant.answer).toBe(answer.markdown)
  expect(assistant.citations?.length).toBe(2)
  expect(assistant.followups).toEqual(answer.followups)
  expect(assistant.annotationIds).toEqual(answer.annotationIds)
  expect(assistant.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
  expect(assistant.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  expect(assistant.knowledge?.nodeIds).toEqual(['n-1'])
  expect(assistant.knowledge?.edgeIds.length).toBe(graphFrame.delta.edges?.length ?? 0)
  expect(typeof assistant.createdAt).toBe('string')
  expect(frames.at(-1)?.type).toBe('done')
})

test('the stream holds back a fence split across chunk boundaries', async () => {
  const fake = createFakeLlm({ chunkSize: 3 })
  fake.queueAnswer({
    markdown: 'A short grounded answer [1].',
    citations: [citation(1, 'We propose block-sparse attention', MARKDOWN, { quote: 'We propose block-sparse attention' })],
  })
  const { chat } = makeChat({ fake })
  const frames = await collectFrames(chat, question())
  const deltas = streamedText(frames)
  expect(deltas.includes('```')).toBe(false)
  expect(deltas.trimEnd()).toBe(findFrame(frames, 'answer').markdown)
})

/* -------------------------------------------------------------------------- */
/* Citation verification                                                      */
/* -------------------------------------------------------------------------- */

test('quote verification: whitespace normalization and the ≥20-char prefix fallback', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'It proposes a routing method [1] [2].',
    citations: [
      // Whitespace-normalized substring: internal spacing differs from the block.
      { index: 1, blockKey: method.key, quote: 'We propose\n   block-sparse attention   with learned routing.', aspect: 'method', note: 'method' },
      // Prefix fallback: the tail drifts, the first 40 characters match.
      { index: 2, blockKey: method.key, quote: 'We propose block-sparse attention with learned routing and extra gating.', aspect: 'method', note: 'method again' },
    ],
  })
  const { chat, store } = makeChat({ fake })
  const frames = await collectFrames(chat, question())
  const answer = findFrame(frames, 'answer')
  expect(answer.citations.length).toBe(2)
  expect(answer.unverified.length).toBe(0)
  for (const verified of answer.citations) {
    expect(verified.verified).toBe(true)
    const offsets = offsetsOf(verified)
    expect(offsets.end).toBeGreaterThan(offsets.start)
    expect(offsets.end - offsets.start).toBeLessThanOrEqual(method.plainText.length)
    // Offsets address the original plain text; the highlighted slice is either
    // the whole (whitespace-normalized) quote or an accepted prefix of it.
    const highlighted = normalizeQuoteText(method.plainText.slice(offsets.start, offsets.end))
    const quoted = normalizeQuoteText(verified.quote)
    expect(quoted.startsWith(highlighted), `${highlighted} is not a prefix of ${quoted}`).toBe(true)
  }
  // Whitespace-only drift verified exactly; the drifted tail verified via prefix.
  const firstCitation = answer.citations[0]
  const secondCitation = answer.citations[1]
  if (firstCitation === undefined || secondCitation === undefined) throw new Error('missing citations')
  const firstOffsets = offsetsOf(firstCitation)
  const secondOffsets = offsetsOf(secondCitation)
  expect(normalizeQuoteText(method.plainText.slice(firstOffsets.start, firstOffsets.end))).toBe(
    normalizeQuoteText(firstCitation.quote),
  )
  expect(secondOffsets.end - secondOffsets.start).toBeLessThanOrEqual(40)
  expect(secondOffsets.end - secondOffsets.start).toBeGreaterThanOrEqual(20)
  // Both citations dedupe to the same overlapping method annotation → one created.
  expect(answer.annotationIds.length).toBe(1)
  expect(store.state.annotations.items.length).toBe(1)
})

test('invalid citations are reported as unverified and never annotated', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'Answer citing [1] [2] [3] but not the fourth.',
    citations: [
      { index: 1, blockKey: method.key, quote: 'We propose block-sparse attention with learned routing.', aspect: 'method', note: 'ok' },
      { index: 2, blockKey: 'b99:deadbeef', quote: 'not a real block', aspect: 'method', note: 'bad block' },
      { index: 3, blockKey: method.key, quote: 'This sentence does not exist in the paper at all.', aspect: 'result', note: 'bad quote' },
      { index: 4, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'no marker' },
    ],
  })
  const { chat } = makeChat({ fake })
  const frames = await collectFrames(chat, question())
  const answer = findFrame(frames, 'answer')
  expect(answer.citations.length).toBe(1)
  expect(answer.unverified.length).toBe(3)
  const reasons = answer.unverified.map((entry) => entry.reason).sort()
  expect(reasons).toEqual(['index-not-in-answer', 'quote-not-found', 'unknown-block'])
  for (const entry of answer.unverified) expect(entry.verified).toBe(false)
  expect(answer.annotationIds.length).toBe(1)
  // Only the verified citation became an annotation.
  await chat.history(DOC_ID) // flush persistence errors (none)
})

test('duplicate citation indices are reported once', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse routing [1].',
    citations: [
      { index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'first' },
      { index: 1, blockKey: method.key, quote: 'The routing network selects relevant blocks.', aspect: 'method', note: 'duplicate' },
    ],
  })
  const { chat } = makeChat({ fake })
  const answer = findFrame(await collectFrames(chat, question()), 'answer')
  expect(answer.citations.length).toBe(1)
  expect(answer.unverified.length).toBe(1)
  expect(answer.unverified[0]?.reason).toBe('duplicate-index')
})

test('verified citations get their page from the MinerU content list', async () => {
  const markdown = `# Two Page Paper

## Page One Section

Alpha alpha unique first page sentence about graphs.

## Page Two Section

Beta beta second page sentence about retrieval.
`
  const contentList = [
    { type: 'text', text: 'Alpha alpha unique first page sentence about graphs.', page_idx: 0 },
    { type: 'text', text: 'Beta beta second page sentence about retrieval.', page_idx: 1 },
  ]
  const beta = blockWith(markdown, 'Beta beta second')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The second page discusses retrieval [1].',
    citations: [{ index: 1, blockKey: beta.key, quote: 'Beta beta second page sentence about retrieval.', aspect: 'context', note: 'page 2' }],
  })
  const store = makeStore({ markdown, contentList })
  const { chat } = makeChat({ store, fake })
  const answer = findFrame(await collectFrames(chat, question()), 'answer')
  expect(answer.citations.length).toBe(1)
  expect(answer.citations[0]?.page).toBe(2)
  expect(store.state.annotations.items[0]?.color).toBe('yellow')
})

/* -------------------------------------------------------------------------- */
/* Annotation dedupe and cap                                                  */
/* -------------------------------------------------------------------------- */

test('annotation dedupe skips overlapping same-aspect ranges and keeps user notes', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const results = blockWith(MARKDOWN, '2.4x')
  const existing: Annotation = {
    id: 'existing-1',
    blockKey: method.key,
    start: 0,
    end: 20,
    quote: 'We propose block-spa',
    note: 'my own note',
    color: 'sage',
    aspect: 'method',
    origin: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const store = makeStore({ annotations: [existing] })
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'Method [1] and result [2].',
    citations: [
      { index: 1, blockKey: method.key, quote: 'We propose block-sparse attention with learned routing.', aspect: 'method', note: 'claim' },
      { index: 2, blockKey: results.key, quote: 'improves throughput by 2.4x with equal accuracy', aspect: 'result', note: 'claim' },
    ],
  })
  const { chat } = makeChat({ store, fake })
  const answer = findFrame(await collectFrames(chat, question()), 'answer')
  expect(answer.citations.length).toBe(2)
  // Only the non-overlapping result citation created a new annotation.
  expect(answer.annotationIds.length).toBe(1)
  expect(store.state.annotations.items.length).toBe(2)
  const kept = store.state.annotations.items.find((item) => item.id === existing.id)
  expect(kept?.note).toBe('my own note')
  expect(kept?.origin).toBe('user')

  // Same overlap with a different aspect is not a duplicate.
  const storeTwo = makeStore({ annotations: [{ ...existing, aspect: 'result', color: 'sky' }] })
  const fakeTwo = createFakeLlm()
  fakeTwo.queueAnswer({
    markdown: 'Method [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'claim' }],
  })
  const two = makeChat({ store: storeTwo, fake: fakeTwo })
  const answerTwo = findFrame(await collectFrames(two.chat, question()), 'answer')
  expect(answerTwo.annotationIds.length).toBe(1)
  expect(storeTwo.state.annotations.items.length).toBe(2)
})

test('at most maxAnnotationsPerAnswer verified citations become annotations', async () => {
  const fake = createFakeLlm()
  const punctuation = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
  const citations: FakeCitation[] = []
  const markers: string[] = []
  for (let index = 0; index < punctuation.length; index += 1) {
    const block = blockWith(CAP_MARKDOWN, `${punctuation[index] ?? ''} sentence`)
    citations.push({
      index: index + 1,
      blockKey: block.key,
      quote: block.plainText,
      aspect: index % 2 === 0 ? 'result' : 'method',
      note: `claim ${index + 1}`,
    })
    markers.push(`[${index + 1}]`)
  }
  fake.queueAnswer({ markdown: `Six claims ${markers.join(' ')}.`, citations })
  const store = makeStore({ markdown: CAP_MARKDOWN })
  const { chat } = makeChat({ store, fake })
  const answer = findFrame(await collectFrames(chat, question()), 'answer')
  expect(answer.citations.length).toBe(6)
  expect(answer.annotationIds.length).toBe(5)
  expect(store.state.annotations.items.length).toBe(5)

  // The cap is configurable per turn.
  const fakeTwo = createFakeLlm()
  fakeTwo.queueAnswer({ markdown: `Six claims ${markers.join(' ')}.`, citations })
  const storeTwo = makeStore({ markdown: CAP_MARKDOWN })
  const two = makeChat({ store: storeTwo, fake: fakeTwo, config: { ai: { maxAnnotationsPerAnswer: 2 } } })
  const answerTwo = findFrame(await collectFrames(two.chat, question()), 'answer')
  expect(answerTwo.citations.length).toBe(6)
  expect(answerTwo.annotationIds.length).toBe(2)
  expect(storeTwo.state.annotations.items.length).toBe(2)
})

/* -------------------------------------------------------------------------- */
/* Usage, knowledge delta and unverified evidence rules                       */
/* -------------------------------------------------------------------------- */

test('usage is forwarded in a frame and stored on the message', async () => {
  const fake = createFakeLlm()
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  fake.queue({
    text: litnotesAnswerText({
      markdown: 'A grounded answer [1].',
      citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'm' }],
    }),
    usage: { inputTokens: 1234, outputTokens: 56 },
  })
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  const frames = await collectFrames(chat, question())
  expect(findFrame(frames, 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 1234, outputTokens: 56 } })
  const assistant = chatFile(store)?.messages.at(-1)
  expect(assistant?.usage).toEqual({ inputTokens: 1234, outputTokens: 56 })
})

test('unverified evidence never creates annotations or graph knowledge', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const graphCalls: unknown[] = []
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'A fabricated claim [1].',
    citations: [
      { index: 1, blockKey: method.key, quote: 'This quote is completely fabricated and not in the block.', aspect: 'result', note: 'bad' },
    ],
    knowledge: {
      nodes: [{ type: 'insight', label: 'fabricated insight', summary: 'nope', blockKeys: [method.key] }],
      edges: [],
    },
  })
  const store = makeStore()
  const { chat } = makeChat({
    store,
    fake,
    onGraphDelta: async (documentId, delta) => {
      graphCalls.push({ documentId, delta })
      return null
    },
  })
  const frames = await collectFrames(chat, question())
  expect(frames.some((frame) => frame.type === 'graph')).toBe(false)
  expect(graphCalls.length).toBe(0)
  const answer = findFrame(frames, 'answer')
  expect(answer.citations.length).toBe(0)
  expect(answer.unverified.length).toBe(1)
  expect(answer.annotationIds.length).toBe(0)
  expect(store.state.annotations.items.length).toBe(0)
})

/* -------------------------------------------------------------------------- */
/* History, prompt context and trimming                                       */
/* -------------------------------------------------------------------------- */

test('previous conversation turns are injected into the prompt and trimmed by historyTurns', async () => {
  const seededMessages: StoredMessage[] = []
  for (const n of [1, 2, 3]) {
    seededMessages.push(
      { id: `u${n}`, role: 'user', question: `HISTORY-QUESTION-${n}`, createdAt: '2026-01-01T00:00:00.000Z' },
      {
        id: `a${n}`,
        role: 'assistant',
        question: `HISTORY-QUESTION-${n}`,
        answer: `HISTORY-ANSWER-${n}`,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    )
  }
  /** Run one turn over a fresh fake and return the prompt the model saw. */
  async function promptFor(historyTurns: number): Promise<string> {
    const fake = createFakeLlm()
    fake.queueAnswer({ markdown: 'An answer grounded in the paper.' })
    const store = makeStore()
    store.aux.set(`${DOC_ID}/chat.json`, structuredClone({ version: 1, messages: seededMessages }))
    const { chat } = makeChat({ store, fake, config: { ai: { historyTurns } } })
    await collectFrames(chat, question())
    return chatPrompt(fake)
  }

  const twoTurns = await promptFor(2)
  expect(twoTurns.includes('HISTORY-QUESTION-3')).toBe(true)
  expect(twoTurns.includes('HISTORY-QUESTION-2')).toBe(true)
  expect(twoTurns.includes('HISTORY-ANSWER-2')).toBe(true)
  expect(twoTurns.includes('HISTORY-QUESTION-1')).toBe(false)

  const oneTurn = await promptFor(1)
  expect(oneTurn.includes('HISTORY-QUESTION-3')).toBe(true)
  expect(oneTurn.includes('HISTORY-QUESTION-2')).toBe(false)

  const noTurns = await promptFor(0)
  expect(noTurns.includes('HISTORY-QUESTION-')).toBe(false)
})

test('the prompt carries the reading focus (block + selection)', async () => {
  const limitations = blockWith(MARKDOWN, 'Routing adds latency')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The limitation is latency [1].',
    citations: [citation(1, 'Routing adds latency', MARKDOWN, { quote: 'Routing adds latency on short sequences' })],
  })
  const { chat } = makeChat({ fake })
  await collectFrames(chat, question({ focus: { blockKey: limitations.key, selectionQuote: 'requires a warm-up phase' } }))
  const prompt = chatPrompt(fake)
  expect(prompt.includes('Reader focus')).toBe(true)
  expect(prompt.includes(limitations.key)).toBe(true)
  expect(prompt.includes('requires a warm-up phase')).toBe(true)
  expect(prompt.includes('Sparse Attention for Long Documents')).toBe(true)
  expect(prompt.includes('Document outline')).toBe(true)
})

test('history() reads persisted messages and clear() empties them', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse attention [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'm' }],
  })
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  await collectFrames(chat, question())
  const messages = await chat.history(DOC_ID)
  expect(messages.length).toBe(2)
  expect(messages[0]?.role).toBe('user')
  expect(messages[1]?.role).toBe('assistant')
  expect(messages[1]?.citations.length).toBe(1)

  expect(await chat.clear(DOC_ID)).toEqual({ cleared: true })
  expect(await chat.history(DOC_ID)).toEqual([])
  expect(chatFile(store)).toEqual({ version: 1, messages: [] })

  // Corrupt chat files read as an empty conversation instead of throwing.
  store.aux.set(`${DOC_ID}/chat.json`, { version: 1, messages: 'nope' })
  expect(await chat.history(DOC_ID)).toEqual([])
})

/* -------------------------------------------------------------------------- */
/* Frames for errors and aborts                                               */
/* -------------------------------------------------------------------------- */

test('llm failures emit error frames before and after the first delta', async () => {
  const unavailable = makeChat({ fake: createFakeLlm(), store: makeStore() })
  const noModelLlm = createLlmGateway({
    getLlm: () => undefined,
    getDefaultModel: () => undefined,
    config: { ai: {} },
    logger: quietLogger,
  })
  const retriever = createRetriever({ parseMarkdown, plainTextOfBlock, logger: quietLogger })
  const chatNoModel = createChatService({
    llm: noModelLlm,
    retriever,
    store: makeStore() as unknown as ChatServiceDeps['store'],
    config: { ai: {} },
    logger: quietLogger,
    loadAnnotations: async () => ({ version: 1, items: [] }),
    saveAnnotations: async () => ({ version: 1, items: [] }),
  })
  const noModelFrames = await collectFrames(chatNoModel, question())
  expect(noModelFrames.length).toBe(1)
  expect(noModelFrames[0]?.type).toBe('error')
  expect(errorCodeOf(noModelFrames[0])).toBe('llm-unavailable')

  // Failure before any delta: start frame then an error frame.
  const beforeFake = createFakeLlm()
  beforeFake.queue({ error: new Error('provider exploded') })
  const beforeStore = makeStore()
  const before = makeChat({ fake: beforeFake, store: beforeStore })
  const beforeFrames = await collectFrames(before.chat, question())
  expect(beforeFrames[0]?.type).toBe('start')
  expect(beforeFrames.at(-1)?.type).toBe('error')
  expect(errorCodeOf(beforeFrames.at(-1))).toBe('llm-failed')
  expect(beforeFrames.some((frame) => frame.type === 'answer')).toBe(false)
  expect(chatFile(beforeStore)).toBeNull()
  expect(beforeStore.state.annotations.items.length).toBe(0)
  expect(unavailable.chat.available()).toBe(true)

  // Failure after a partial delta: deltas then an error, no answer, no persist.
  const midFake = createFakeLlm()
  midFake.queue({ text: 'The paper proposes a method that', error: new Error('connection dropped'), errorAfterChunks: 1 })
  const midStore = makeStore()
  const mid = makeChat({ fake: midFake, store: midStore })
  const midFrames = await collectFrames(mid.chat, question())
  expect(midFrames[0]?.type).toBe('start')
  expect(midFrames.some((frame) => frame.type === 'delta')).toBe(true)
  expect(midFrames.at(-1)?.type).toBe('error')
  expect(errorCodeOf(midFrames.at(-1))).toBe('llm-failed')
  expect(midFrames.some((frame) => frame.type === 'answer')).toBe(false)
  expect(chatFile(midStore)).toBeNull()
})

test('request and document errors become error frames without starting a turn', async () => {
  const { chat } = makeChat({ fake: createFakeLlm() })
  const badQuestion = await collectFrames(chat, { documentId: DOC_ID, question: '   ' })
  expect(badQuestion.length).toBe(1)
  expect(errorCodeOf(badQuestion[0])).toBe('bad-request')

  const badDocument = await collectFrames(chat, { documentId: '', question: 'why?' })
  expect(errorCodeOf(badDocument[0])).toBe('bad-request')

  const reservedMode = await collectFrames(chat, question({ mode: 'library' as unknown as 'doc' }))
  const reservedLast = reservedMode.at(-1)
  expect(errorCodeOf(reservedLast)).toBe('bad-request')

  const notParsed = makeChat({ fake: createFakeLlm(), store: makeStore({ readCode: 'not-parsed' }) })
  const notParsedFrames = await collectFrames(notParsed.chat, question())
  expect(notParsedFrames.length).toBe(1)
  expect(notParsedFrames[0]?.type).toBe('error')
  expect(errorCodeOf(notParsedFrames[0])).toBe('not-parsed')

  const emptyDocument = makeChat({ fake: createFakeLlm(), store: makeStore({ markdown: '' }) })
  const emptyFrames = await collectFrames(emptyDocument.chat, question())
  expect(errorCodeOf(emptyFrames[0])).toBe('bad-request')
})

test('a completion with no visible text reports ai-failed instead of an empty answer', async () => {
  // Real bug observed live: the adapter's reasoning effort "high" consumed the
  // whole maxTokens budget on reasoning tokens, streaming no text-delta at all.
  const fake = createFakeLlm()
  fake.queue({
    chunks: [
      { type: 'reasoning-delta', text: 'chain of thought '.repeat(64) },
      { type: 'usage', usage: { inputTokens: 2939, outputTokens: 4096 } },
      { type: 'finish', reason: { kind: 'length' } },
    ],
  })
  const store = makeStore()
  const { chat } = makeChat({ fake, store })
  const frames = await collectFrames(chat, question())
  expect(frames[0]?.type).toBe('start')
  expect(frames.some((frame) => frame.type === 'answer')).toBe(false)
  const last = frames.at(-1)
  expect(last?.type).toBe('error')
  expect(errorCodeOf(last)).toBe('ai-failed')
  expect(last !== undefined && last.type === 'error' ? last.message : '').toMatch(/未生成可见回答/)
  expect(chatFile(store)).toBeNull()
  expect(store.state.annotations.items.length).toBe(0)
})

test('chat forwards the configured reasoningEffort (low by default) to the host', async () => {
  const calls: Array<{ system?: string; reasoningEffort?: string }> = []
  const answerText = litnotesAnswerText({
    markdown: 'A grounded answer [1].',
    citations: [
      { index: 1, blockKey: blockWith(MARKDOWN, 'We propose block-sparse attention').key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'm' },
    ],
  })
  function recordingHost(): { stream: (request: { system?: string; reasoningEffort?: string }) => AsyncGenerator<Record<string, unknown>> } {
    return {
      stream(request: { system?: string; reasoningEffort?: string }): AsyncGenerator<Record<string, unknown>> {
        calls.push(request)
        return (async function* generate(): AsyncGenerator<Record<string, unknown>> {
          yield { type: 'text-delta', text: answerText }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  }
  await collectFrames(makeChat({ hostLlm: recordingHost(), store: makeStore() }).chat, question())
  await collectFrames(
    makeChat({ hostLlm: recordingHost(), store: makeStore(), config: { ai: { reasoningEffort: 'off' } } }).chat,
    question(),
  )
  const chatCalls = calls.filter((call) => call.system === CHAT_SYSTEM)
  expect(chatCalls.length).toBe(2)
  expect(chatCalls[0]?.reasoningEffort).toBe('low')
  expect(chatCalls[1]?.reasoningEffort).toBe('off')
})

test('abort stops the turn without persisting or annotating', async () => {
  const fake = createFakeLlm()
  fake.queue({ text: 'abcdefghij'.repeat(10), chunkDelayMs: 2 })
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  const frames: ChatFrame[] = []
  const controller = new AbortController()
  for await (const frame of chat.stream(question(), controller.signal)) {
    frames.push(frame)
    if (frame.type === 'delta') controller.abort()
  }
  expect(frames[0]?.type).toBe('start')
  expect(frames.some((frame) => frame.type === 'delta')).toBe(true)
  expect(frames.at(-1)?.type).toBe('error')
  expect(errorCodeOf(frames.at(-1))).toBe('aborted')
  expect(frames.some((frame) => frame.type === 'answer')).toBe(false)
  expect(chatFile(store)).toBeNull()
  expect(store.state.annotations.items.length).toBe(0)
})

test('an already-aborted request never reaches the model', async () => {
  const fake = createFakeLlm()
  const { chat } = makeChat({ fake })
  const controller = new AbortController()
  controller.abort()
  const frames = await collectFrames(chat, question({ signal: controller.signal }))
  expect(frames.length).toBe(1)
  expect(errorCodeOf(frames[0])).toBe('aborted')
  expect(fake.callCount()).toBe(0)
})

/* -------------------------------------------------------------------------- */
/* Citation–claim entailment second pass (`docs/AI-SPEC.md` §5)               */
/* -------------------------------------------------------------------------- */

test('entailment verdicts mark citations, keep partial, and drop unsupported evidence', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const results = blockWith(MARKDOWN, '2.4x')
  const limitations = blockWith(MARKDOWN, 'Routing adds latency')
  const graphCalls: Array<{ nodes?: Array<{ label?: string }>; edges?: unknown[] }> = []
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is block-sparse attention [1]. It improves throughput [2]. It has no limitations [3].',
    citations: [
      { index: 1, blockKey: method.key, quote: 'We propose block-sparse attention with learned routing.', aspect: 'method', note: 'The method is block-sparse attention.' },
      { index: 2, blockKey: results.key, quote: 'improves throughput by 2.4x with equal accuracy', aspect: 'result', note: 'It improves throughput by 2.4x.' },
      { index: 3, blockKey: limitations.key, quote: 'Routing adds latency on short sequences', aspect: 'limitation', note: 'The paper reports no limitations.' },
    ],
    knowledge: {
      nodes: [
        { type: 'method', label: 'block-sparse attention', summary: 'Sparse attention with routing.', blockKeys: [method.key] },
        { type: 'finding', label: 'no limitations', summary: 'Fabricated claim.', blockKeys: [limitations.key] },
      ],
      edges: [{ from: 'block-sparse attention', to: 'no limitations', type: 'relates' }],
    },
  })
  const entailment = {
    text: entailmentText([
      { index: 1, verdict: 'supported', reason: 'The quote states the method.' },
      { index: 2, verdict: 'partial', reason: 'The quote gives the number but not the claim wording.' },
      { index: 3, verdict: 'unsupported', reason: 'The quote says routing adds latency.' },
    ]),
  }
  const store = makeStore()
  const { chat } = makeChat({
    store,
    fake,
    entailment,
    onGraphDelta: async (_documentId, delta) => {
      graphCalls.push(delta as { nodes?: Array<{ label?: string }>; edges?: unknown[] })
      return null
    },
  })
  const frames = await collectFrames(chat, question())

  // Phase frame: after the streamed answer, before the answer frame.
  const phaseAt = frames.findIndex((frame) => frame.type === 'phase')
  const answerAt = frames.findIndex((frame) => frame.type === 'answer')
  const firstDeltaAt = frames.findIndex((frame) => frame.type === 'delta')
  expect(phaseAt).not.toBe(-1)
  expect(frames[phaseAt]?.type === 'phase' ? frames[phaseAt]?.phase : '').toBe('entailment')
  expect(phaseAt).toBeGreaterThan(firstDeltaAt)
  expect(phaseAt).toBeLessThan(answerAt)

  const answer = findFrame(frames, 'answer')
  expect(answer.citations.length).toBe(2)
  const [supported, partial] = answer.citations
  expect(supported?.entailment).toBe('supported')
  expect(supported?.verified).toBe(true)
  expect(supported?.entailmentReason).toMatch(/states the method/)
  expect(partial?.entailment).toBe('partial')
  expect(partial?.verified).toBe(true)
  expect(answer.unverified.length).toBe(1)
  const rejected = answer.unverified[0]
  expect(rejected?.index).toBe(3)
  expect(rejected?.blockKey).toBe(limitations.key)
  expect(rejected?.verified).toBe(false)
  expect(rejected?.reason).toBe('entailment-unsupported')
  expect(rejected?.entailment).toBe('unsupported')
  expect(rejected?.entailmentReason).toMatch(/latency/)
  expect(rejected?.start).toBeUndefined()
  expect(rejected?.page).toBeUndefined()
  expect(answer.entailment).toEqual({ checked: true, supported: 1, partial: 1, unsupported: 1 })

  // Annotations: supported + partial only; the unsupported citation never annotates.
  expect(answer.annotationIds.length).toBe(2)
  expect(store.state.annotations.items.length).toBe(2)

  // Graph knowledge: evidence from the dropped citation is excluded.
  expect(graphCalls.length).toBe(1)
  expect(graphCalls[0]?.nodes?.map((node) => node.label)).toEqual(['block-sparse attention'])
  expect(graphCalls[0]?.edges).toEqual([])

  // The entailment call uses the dedicated prompt, fence tag and token budget.
  const entailmentCall = fake.lastCallMatching(ENTAILMENT_FENCE_TAG)
  expect(entailmentCall).toBeDefined()
  expect(entailmentCall?.maxTokens).toBe(600)
  expect(entailmentCall?.prompt).toMatch(/\[3\] \(limitation\) claim: The paper reports no limitations\./)
  expect(entailmentCall?.prompt).toMatch(/quote: "Routing adds latency on short sequences"/)

  // Persistence + history normalization keep citation-level and summary fields.
  const assistant = chatFile(store)?.messages.at(-1)
  expect(assistant?.entailment).toEqual({ checked: true, supported: 1, partial: 1, unsupported: 1 })
  expect(assistant?.citations?.[1]?.entailment).toBe('partial')
  expect(assistant?.unverified?.[0]?.reason).toBe('entailment-unsupported')
  const history = await chat.history(DOC_ID)
  const persisted = history.at(-1)
  expect(persisted?.entailment).toEqual({ checked: true, supported: 1, partial: 1, unsupported: 1 })
  expect(persisted?.citations[0]?.entailment).toBe('supported')
  expect(persisted?.citations[1]?.entailment).toBe('partial')
  expect(persisted?.unverified[0]?.entailment).toBe('unsupported')
  expect(persisted?.unverified[0]?.entailmentReason).toMatch(/latency/)
})

test('entailment fail-open: malformed output keeps citations verified as unchecked', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse routing [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'method' }],
  })
  const { chat } = makeChat({
    fake,
    entailment: { text: 'I could not decide.\n\n```litnotes-entailment\n{not valid json}\n```' },
  })
  const frames = await collectFrames(chat, question())
  expect(frames.some((frame) => frame.type === 'phase' && frame.phase === 'entailment')).toBe(true)
  const answer = findFrame(frames, 'answer')
  expect(answer.citations.length).toBe(1)
  expect(answer.citations[0]?.verified).toBe(true)
  expect(answer.citations[0]?.entailment).toBe('unchecked')
  expect(answer.unverified.length).toBe(0)
  expect(answer.entailment).toEqual({ checked: false, supported: 0, partial: 0, unsupported: 0 })
  expect(answer.annotationIds.length).toBe(1)
  expect(frames.at(-1)?.type).toBe('done')
})

test('entailment fail-open: a classifier model error never fails the answer', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse routing [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'method' }],
  })
  const store = makeStore()
  const { chat } = makeChat({ store, fake, entailment: { error: new Error('classifier exploded') } })
  const frames = await collectFrames(chat, question())
  expect(frames.some((frame) => frame.type === 'error')).toBe(false)
  const answer = findFrame(frames, 'answer')
  expect(answer.citations[0]?.entailment).toBe('unchecked')
  expect(answer.citations[0]?.verified).toBe(true)
  expect(answer.entailment).toEqual({ checked: false, supported: 0, partial: 0, unsupported: 0 })
  expect(answer.annotationIds.length).toBe(1)
  expect(chatFile(store)?.messages.length).toBe(2)
  const history = await chat.history(DOC_ID)
  expect(history.length).toBe(2)
  expect(history.at(-1)?.citations[0]?.entailment).toBe('unchecked')
  expect(history.at(-1)?.entailment).toEqual({ checked: false, supported: 0, partial: 0, unsupported: 0 })
  expect(frames.at(-1)?.type).toBe('done')
})

test('entailmentCheck:false skips the phase frame, the model call and citation fields', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse routing [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'method' }],
  })
  const store = makeStore()
  const { chat } = makeChat({ store, fake, config: { ai: { entailmentCheck: false } } })
  const frames = await collectFrames(chat, question())
  expect(frames.some((frame) => frame.type === 'phase')).toBe(false)
  expect(fake.callCount()).toBe(1)
  const answer = findFrame(frames, 'answer')
  const citationEntry = answer.citations[0]
  expect(citationEntry?.verified).toBe(true)
  expect(citationEntry !== undefined && 'entailment' in citationEntry).toBe(false)
  expect(citationEntry !== undefined && 'entailmentReason' in citationEntry).toBe(false)
  expect(answer.entailment).toEqual({ checked: false, supported: 0, partial: 0, unsupported: 0 })
  expect(answer.annotationIds.length).toBe(1)
  expect(frames.at(-1)?.type).toBe('done')
})

test('annotation creation falls back to load/save when the atomic store helper is absent', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse routing [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'method' }],
  })
  const store = makeStore()
  const { chat } = makeChat({ store, fake, mutate: false })
  const frames = await collectFrames(chat, question())
  const answer = findFrame(frames, 'answer')
  expect(answer.annotationIds.length).toBe(1)
  expect(store.state.annotations.items.length).toBe(1)
  expect(answer.annotationIds).toEqual(store.state.annotations.items.map((item) => item.id))
  // The chat turn itself also persisted through the readAux/writeAux fallback.
  expect(chatFile(store)?.messages.length).toBe(2)
})

/* -------------------------------------------------------------------------- */
/* Concurrent writers (`docs/AI-SPEC.md` §2)                                  */
/* -------------------------------------------------------------------------- */

test('interleaved concurrent chat turns persist both conversations', async () => {
  const fake = createFakeLlm()
  fake.queueAnswer({ markdown: 'Answer alpha from the paper.' })
  fake.queueAnswer({ markdown: 'Answer beta from the paper.' })
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  const first = collectFrames(chat, question({ question: 'First question?' }))
  const second = collectFrames(chat, question({ question: 'Second question?' }))
  await Promise.all([first, second])

  const file = chatFile(store)
  expect(file?.messages.length).toBe(4)
  const questions = (file?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => message.question)
    .sort()
  expect(questions).toEqual(['First question?', 'Second question?'])
  expect((file?.messages ?? []).filter((message) => message.role === 'assistant').length).toBe(2)
  expect((await chat.history(DOC_ID)).length).toBe(4)
})

test('an interleaved client annotation save keeps the user edit and the AI note', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const results = blockWith(MARKDOWN, '2.4x')
  const userNote: Annotation = {
    id: 'user-note-1',
    blockKey: method.key,
    start: 0,
    end: 10,
    quote: 'We propose',
    note: 'my note',
    color: 'sage',
    aspect: 'method',
    origin: 'user',
  }
  const store = makeStore({ annotations: [userNote] })
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'It improves throughput by 2.4x [1].',
    citations: [{ index: 1, blockKey: results.key, quote: 'improves throughput by 2.4x with equal accuracy', aspect: 'result', note: 'result claim' }],
    knowledge: { nodes: [{ type: 'finding', label: 'throughput gain', summary: '2.4x', blockKeys: [results.key] }] },
  })
  const { chat } = makeChat({ store, fake })
  const framesPromise = collectFrames(chat, question())
  // The client saves its edited list with the base id set it had loaded.
  const savePromise = store.saveAnnotations(DOC_ID, {
    version: 1,
    items: [{ ...userNote, note: 'my edited note' }],
    baseIds: [userNote.id],
  })
  const [frames] = await Promise.all([framesPromise, savePromise])

  const loaded = await store.loadAnnotations(DOC_ID)
  expect(loaded.items.length).toBe(2)
  const edited = loaded.items.find((item) => item.id === userNote.id)
  expect(edited?.note).toBe('my edited note')
  expect(edited?.origin).toBe('user')
  const aiNote = loaded.items.find((item) => item.origin === 'ai')
  expect(aiNote).toBeDefined()
  const answer = findFrame(frames, 'answer')
  expect(answer.annotationIds).toEqual([aiNote?.id])

  // Client-side deletes win for base ids; concurrent AI additions survive.
  const afterDelete = await store.saveAnnotations(DOC_ID, { version: 1, items: [], baseIds: [userNote.id] })
  expect(afterDelete.items.length).toBe(1)
  expect(afterDelete.items[0]?.id).toBe(aiNote?.id)
})

test('aborting during the entailment pass aborts the turn without persisting', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse routing [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'method' }],
  })
  const store = makeStore()
  const { chat } = makeChat({
    store,
    fake,
    // Slow classifier call so the abort lands inside the entailment request.
    entailment: { text: entailmentText([{ index: 1, verdict: 'supported', reason: 'ok' }]), delayMs: 100 },
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30)
  const frames = await collectFrames(chat, question({ signal: controller.signal }))
  clearTimeout(timer)
  expect(frames.some((frame) => frame.type === 'phase' && frame.phase === 'entailment')).toBe(true)
  expect(frames.some((frame) => frame.type === 'answer')).toBe(false)
  expect(frames.at(-1)?.type).toBe('error')
  expect(errorCodeOf(frames.at(-1))).toBe('aborted')
  expect(chatFile(store)).toBeNull()
  expect(store.state.annotations.items.length).toBe(0)
})

test('an annotation save failure never fails the answer', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const fake = createFakeLlm()
  fake.queueAnswer({
    markdown: 'The method is sparse routing [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'method' }],
  })
  const store = makeStore()
  store.mutateAnnotations = async () => {
    throw new Error('disk full')
  }
  const { chat } = makeChat({ store, fake })
  const frames = await collectFrames(chat, question())
  const answer = findFrame(frames, 'answer')
  expect(answer.annotationIds).toEqual([])
  expect(frames.some((frame) => frame.type === 'error')).toBe(false)
  expect(frames.at(-1)?.type).toBe('done')
  expect(chatFile(store)?.messages.length).toBe(2)
})

/* -------------------------------------------------------------------------- */
/* Regeneration                                                               */
/* -------------------------------------------------------------------------- */

test('regenerateOf replaces the assistant message instead of appending a turn', async () => {
  const fake = createFakeLlm()
  fake.queueAnswer({ markdown: 'First answer about the paper.' })
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  const firstFrames = await collectFrames(chat, question())
  const firstAnswer = findFrame(firstFrames, 'answer')
  const file = chatFile(store)
  expect(file?.messages.length).toBe(2)

  const regenerating = makeChat({ store, fake })
  fake.queueAnswer({ markdown: 'Regenerated answer about the paper.' })
  const frames = await collectFrames(
    regenerating.chat,
    question({ regenerateOf: firstAnswer.messageId }),
  )
  const answer = findFrame(frames, 'answer')
  expect(answer.messageId).not.toBe(firstAnswer.messageId)
  const after = chatFile(store)
  expect(after?.messages.length, 'the regenerated turn replaces the old assistant message').toBe(2)
  expect(after?.messages[1]?.id).toBe(answer.messageId)
  expect(after?.messages[1]?.answer).toBe('Regenerated answer about the paper.')
})

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

test('splitModelOutput extracts the fence, tolerates drift and ignores trailing text', () => {
  const fenced = splitModelOutput('Answer [1].\n\n```litnotes-json\n{"citations":[],"followups":["why?"]}\n```\nAfter text.')
  expect(fenced.fenceFound).toBe(true)
  expect(fenced.answer).toBe('Answer [1].')
  expect(fenced.payload).toEqual({ citations: [], followups: ['why?'] })

  const spaced = splitModelOutput('Answer.\n``` LitNotes-JSON\n{"citations":[]}\n```')
  expect(spaced.fenceFound).toBe(true)
  expect(spaced.answer).toBe('Answer.')
  expect(spaced.payload).toEqual({ citations: [] })

  const plain = splitModelOutput('Just an answer with [1].')
  expect(plain.fenceFound).toBe(false)
  expect(plain.payload).toBeNull()
  expect(plain.answer).toBe('Just an answer with [1].')

  const bareJson = splitModelOutput('Answer.\n\n```json\n{"citations":[{"index":1}],"followups":[]}\n```')
  expect((bareJson.payload as { citations: unknown[] }).citations.length).toBe(1)
  expect(bareJson.answer).toBe('Answer.')

  const malformed = splitModelOutput('Answer.\n\n```litnotes-json\n{not valid json}\n```')
  expect(malformed.payload).toBeNull()
  expect(malformed.answer).toBe('Answer.')
})

test('locateQuoteRange normalizes whitespace and maps offsets back to plainText', () => {
  const plain = 'Hello\n  world\tagain'
  const range = locateQuoteRange(plain, 'Hello world again')
  expect(range).not.toBeNull()
  if (range === null) throw new Error('quote should match')
  expect({ start: range.start, end: range.end, exact: range.exact }).toEqual({ start: 0, end: plain.length, exact: true })
  expect(plain.slice(range.start, range.end)).toBe(plain)

  const exact = locateQuoteRange('one two three', 'two')
  expect(exact).not.toBeNull()
  if (exact === null) throw new Error('quote should match')
  expect({ start: exact.start, end: exact.end, exact: exact.exact }).toEqual({ start: 4, end: 7, exact: true })
  expect(locateQuoteRange('hello world', 'Goodbye')).toBeNull()
  expect(locateQuoteRange('hello world', '')).toBeNull()
  expect(locateQuoteRange('', 'hello')).toBeNull()

  const longPlain = 'We propose block-sparse attention with learned routing.'
  const drifted = locateQuoteRange(longPlain, 'We propose block-sparse attention with learned routing and extra gating.')
  expect(drifted).not.toBeNull()
  if (drifted === null) throw new Error('quote should match via prefix')
  expect(drifted.exact).toBe(false)
  expect(drifted.start).toBe(0)
  expect(drifted.end).toBeLessThanOrEqual(40)

  expect(normalizeQuoteText('  a\n\t b\u00a0c ')).toBe('a b c')
})

test('a regenerated turn excludes the replaced answer from the prompt history', async () => {
  const fake = createFakeLlm()
  fake.queueAnswer({ markdown: 'OLD ANSWER TO REPLACE about method.' })
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  const firstFrames = await collectFrames(chat, question({ question: 'First question?' }))
  const firstAnswer = findFrame(firstFrames, 'answer')
  const file = chatFile(store)
  expect(file?.messages.length).toBe(2)

  fake.queueAnswer({ markdown: 'Fresh regenerated answer.' })
  const regenerating = makeChat({ store, fake })
  await collectFrames(regenerating.chat, question({ question: 'First question?', regenerateOf: firstAnswer.messageId }))
  const prompt = chatPrompt(fake)
  expect(prompt.includes('OLD ANSWER TO REPLACE')).toBe(false)
  expect(prompt.includes('Conversation so far')).toBe(false)
})

test('the route-owned abort signal (second argument) aborts the turn', async () => {
  const fake = createFakeLlm()
  byte: {
    // Never called: the pre-aborted signal wins before document reads.
  }
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  const controller = new AbortController()
  controller.abort()
  const frames: ChatFrame[] = []
  for await (const frame of chat.stream(question(), controller.signal)) frames.push(frame)
  expect(frames.length).toBe(1)
  expect(errorCodeOf(frames[0])).toBe('aborted')
  expect(fake.callCount()).toBe(0)
  expect(chatFile(store)).toBeNull()
})
