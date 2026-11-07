/**
 * Unit tests for the grounded chat service (`lib/ai/chat.js`): NDJSON frame
 * sequence, fence hold-back, citation verification (whitespace normalization,
 * prefix fallback, invalid blocks), annotation creation/dedupe/caps, chat.json
 * persistence, history trimming, knowledge deltas, error frames and aborts.
 *
 * Everything is in-memory: a fake Host llm (test/helpers/fake-llm.mjs) and a
 * fake store aux API — no temp dirs, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, plainTextOfBlock } from '../../ui/markdown.js'
import { createFakeLlm, litnotesAnswerText } from '../helpers/fake-llm.mjs'
import { createLlmGateway } from '../../lib/ai/llm.js'
import { createRetriever } from '../../lib/ai/retrieval.js'
import {
  createChatService,
  locateQuoteRange,
  normalizeQuoteText,
  splitModelOutput,
} from '../../lib/ai/chat.js'
import { PROMPT_VERSION } from '../../lib/ai/prompts.js'

const quietLogger = { debug() {}, warn() {}, error() {} }
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

/** Find one parser block by a text fragment. */
function blockWith(markdown, fragment) {
  const model = parseMarkdown(markdown)
  const block = model.blocks.find(
    (candidate) => typeof candidate.plainText === 'string' && candidate.plainText.includes(fragment),
  )
  assert.ok(block !== undefined, `expected a block containing: ${fragment}`)
  return block
}

/** Build an in-memory store with aux + annotation support. */
function makeStore({ markdown = MARKDOWN, contentList = null, annotations = [], readCode = null, title } = {}) {
  const aux = new Map()
  const state = { annotations: { version: 1, items: structuredClone(annotations) } }
  const store = {
    aux,
    state,
    async readMarkdown() {
      if (readCode !== null) {
        const error = new Error('文档尚未解析完成（Document has not been parsed yet）')
        error.code = readCode
        throw error
      }
      return { markdown, contentList, pages: null }
    },
    get() {
      return { id: DOC_ID, title: title ?? 'Sparse Attention for Long Documents' }
    },
    async readAux(id, name) {
      const value = aux.get(`${id}/${name}`)
      return value === undefined ? null : structuredClone(value)
    },
    async writeAux(id, name, value) {
      aux.set(`${id}/${name}`, structuredClone(value))
    },
    async loadAnnotations() {
      return structuredClone(state.annotations)
    },
    async saveAnnotations(id, data) {
      state.annotations = structuredClone(data)
      return structuredClone(state.annotations)
    },
  }
  return store
}

/** Build a chat service over fakes. */
function makeChat({ store = makeStore(), fake = createFakeLlm(), hostLlm, config = {}, onGraphDelta } = {}) {
  const llm = createLlmGateway({
    getLlm: () => hostLlm ?? fake,
    getDefaultModel: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    config: { ai: {} },
    logger: quietLogger,
  })
  const retriever = createRetriever({ parseMarkdown, plainTextOfBlock, logger: quietLogger })
  const chat = createChatService({
    llm,
    retriever,
    store,
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
    onGraphDelta,
  })
  return { chat, store, fake }
}

/** Drain one stream into frames. */
async function collectFrames(chat, request) {
  const frames = []
  for await (const frame of chat.stream(request)) frames.push(frame)
  return frames
}

/** Standard question payload. */
function question(extra = {}) {
  return { documentId: DOC_ID, question: 'What method does the paper propose?', ...extra }
}

/** Parse the persisted chat.json, or null. */
function chatFile(store) {
  return store.aux.get(`${DOC_ID}/chat.json`) ?? null
}

/** Build one verified citation entry for the fixture. */
function citation(index, fragment, markdown = MARKDOWN, extra = {}) {
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

// ---------------------------------------------------------------------------
// Happy path: frames, citations, annotations, persistence
// ---------------------------------------------------------------------------

test('a grounded turn streams start → deltas → answer → graph → done and persists the turn', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const results = blockWith(MARKDOWN, '2.4x')
  const graphCalls = []
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

  assert.equal(frames[0].type, 'start')
  assert.deepEqual(frames[0].model, { provider: 'fake-provider', model: 'fake-model' })
  assert.match(frames[0].messageId, /^[0-9a-f-]{36}$/)
  const answer = frames.find((frame) => frame.type === 'answer')
  assert.ok(answer !== undefined)
  assert.equal(answer.messageId, frames[0].messageId)
  assert.deepEqual(answer.followups, ['What is the routing network?', 'What does the benchmark measure?'])

  // The streamed deltas never contain the JSON fence and add up to the answer.
  const deltas = frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text)
  const streamed = deltas.join('')
  assert.equal(streamed.includes('litnotes-json'), false)
  assert.equal(streamed.includes('```'), false)
  assert.equal(streamed.trimEnd(), answer.markdown)
  assert.equal(answer.markdown.includes('litnotes-json'), false)

  // Citations are verified with host-computed offsets into the block plain text.
  assert.equal(answer.citations.length, 2)
  assert.equal(answer.unverified.length, 0)
  const [first, second] = answer.citations
  assert.equal(first.verified, true)
  assert.equal(first.blockKey, method.key)
  assert.equal(first.aspect, 'method')
  assert.equal(first.start, 0)
  assert.equal(method.plainText.slice(first.start, first.end), 'We propose block-sparse attention with learned routing.')
  assert.equal(second.aspect, 'result')
  assert.equal(second.page, null)

  // Annotations: one per verified citation, aspect-colored, with provenance.
  assert.equal(answer.annotationIds.length, 2)
  assert.equal(store.state.annotations.items.length, 2)
  assert.deepEqual(answer.annotationIds, store.state.annotations.items.map((item) => item.id))
  const annotations = store.state.annotations.items
  assert.equal(annotations[0].color, 'sage')
  assert.equal(annotations[0].origin, 'ai')
  assert.equal(annotations[0].aspect, 'method')
  assert.equal(annotations[0].chatId, `doc:${DOC_ID}`)
  assert.equal(annotations[0].messageId, answer.messageId)
  assert.deepEqual(annotations[0].model, { provider: 'fake-provider', model: 'fake-model' })
  assert.equal(annotations[1].color, 'sky')
  assert.equal(annotations[1].start, second.start)
  assert.equal(annotations[1].end, second.end)

  // Knowledge delta: only verified block keys survive; graph frame + callback.
  assert.equal(graphCalls.length, 1)
  assert.equal(graphCalls[0].documentId, DOC_ID)
  assert.equal(graphCalls[0].delta.question, question().question)
  assert.deepEqual(graphCalls[0].delta.nodes[0].blockKeys, [method.key])
  const graphFrame = frames.find((frame) => frame.type === 'graph')
  assert.ok(graphFrame !== undefined)
  assert.equal(graphFrame.delta.nodes[0].label, 'block-sparse attention')
  assert.equal(graphFrame.delta.nodes[0].source, 'qa')

  // Persistence: user + assistant ChatMessage with model/promptVersion/usage.
  const file = chatFile(store)
  assert.equal(file.version, 1)
  assert.equal(file.messages.length, 2)
  assert.equal(file.messages[0].role, 'user')
  assert.equal(file.messages[0].question, question().question)
  assert.equal(file.messages[0].promptVersion, PROMPT_VERSION)
  const assistant = file.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.id, answer.messageId)
  assert.equal(assistant.markdown, undefined)
  assert.equal(assistant.answer, answer.markdown)
  assert.equal(assistant.citations.length, 2)
  assert.deepEqual(assistant.followups, answer.followups)
  assert.deepEqual(assistant.annotationIds, answer.annotationIds)
  assert.deepEqual(assistant.model, { provider: 'fake-provider', model: 'fake-model' })
  assert.deepEqual(assistant.usage, { inputTokens: 0, outputTokens: 0 })
  assert.deepEqual(assistant.knowledge.nodeIds, ['n-1'])
  assert.equal(
    assistant.knowledge.edgeIds.length,
    frames.find((frame) => frame.type === 'graph').delta.edges.length,
  )
  assert.equal(typeof assistant.createdAt, 'string')
  assert.equal(frames.at(-1).type, 'done')
})

test('the stream holds back a fence split across chunk boundaries', async () => {
  const fake = createFakeLlm({ chunkSize: 3 })
  fake.queueAnswer({
    markdown: 'A short grounded answer [1].',
    citations: [citation(1, 'We propose block-sparse attention', MARKDOWN, { quote: 'We propose block-sparse attention' })],
  })
  const { chat } = makeChat({ fake })
  const frames = await collectFrames(chat, question())
  const deltas = frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text)
  assert.equal(deltas.join('').includes('```'), false)
  assert.equal(deltas.join('').trimEnd(), frames.find((frame) => frame.type === 'answer').markdown)
})

// ---------------------------------------------------------------------------
// Citation verification
// ---------------------------------------------------------------------------

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
  const answer = frames.find((frame) => frame.type === 'answer')
  assert.equal(answer.citations.length, 2)
  assert.equal(answer.unverified.length, 0)
  for (const verified of answer.citations) {
    assert.equal(verified.verified, true)
    assert.ok(verified.end > verified.start)
    assert.ok(verified.end - verified.start <= method.plainText.length)
    // Offsets address the original plain text; the highlighted slice is either
    // the whole (whitespace-normalized) quote or an accepted prefix of it.
    const highlighted = normalizeQuoteText(method.plainText.slice(verified.start, verified.end))
    const quoted = normalizeQuoteText(verified.quote)
    assert.ok(quoted.startsWith(highlighted), `${highlighted} is not a prefix of ${quoted}`)
  }
  // Whitespace-only drift verified exactly; the drifted tail verified via prefix.
  const highlightedFirst = normalizeQuoteText(method.plainText.slice(answer.citations[0].start, answer.citations[0].end))
  assert.equal(highlightedFirst, normalizeQuoteText(answer.citations[0].quote))
  assert.ok(answer.citations[1].end - answer.citations[1].start <= 40)
  assert.ok(answer.citations[1].end - answer.citations[1].start >= 20)
  // Both citations dedupe to the same overlapping method annotation → one created.
  assert.equal(answer.annotationIds.length, 1)
  assert.equal(store.state.annotations.items.length, 1)
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
  const answer = frames.find((frame) => frame.type === 'answer')
  assert.equal(answer.citations.length, 1)
  assert.equal(answer.unverified.length, 3)
  const reasons = answer.unverified.map((entry) => entry.reason).sort()
  assert.deepEqual(reasons, ['index-not-in-answer', 'quote-not-found', 'unknown-block'])
  for (const entry of answer.unverified) assert.equal(entry.verified, false)
  assert.equal(answer.annotationIds.length, 1)
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
  const answer = (await collectFrames(chat, question())).find((frame) => frame.type === 'answer')
  assert.equal(answer.citations.length, 1)
  assert.equal(answer.unverified.length, 1)
  assert.equal(answer.unverified[0].reason, 'duplicate-index')
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
  const answer = (await collectFrames(chat, question())).find((frame) => frame.type === 'answer')
  assert.equal(answer.citations.length, 1)
  assert.equal(answer.citations[0].page, 2)
  assert.equal(store.state.annotations.items[0].color, 'yellow', 'context aspect is yellow')
})

// ---------------------------------------------------------------------------
// Annotation dedupe and cap
// ---------------------------------------------------------------------------

test('annotation dedupe skips overlapping same-aspect ranges and keeps user notes', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const results = blockWith(MARKDOWN, '2.4x')
  const existing = {
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
  const answer = (await collectFrames(chat, question())).find((frame) => frame.type === 'answer')
  assert.equal(answer.citations.length, 2)
  // Only the non-overlapping result citation created a new annotation.
  assert.equal(answer.annotationIds.length, 1)
  assert.equal(store.state.annotations.items.length, 2)
  const kept = store.state.annotations.items.find((item) => item.id === existing.id)
  assert.equal(kept.note, 'my own note', 'existing user note is never overwritten')
  assert.equal(kept.origin, 'user')

  // Same overlap with a different aspect is not a duplicate.
  const storeTwo = makeStore({
    annotations: [{ ...existing, aspect: 'result', color: 'sky' }],
  })
  const fakeTwo = createFakeLlm()
  fakeTwo.queueAnswer({
    markdown: 'Method [1].',
    citations: [{ index: 1, blockKey: method.key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'claim' }],
  })
  const two = makeChat({ store: storeTwo, fake: fakeTwo })
  const answerTwo = (await collectFrames(two.chat, question())).find((frame) => frame.type === 'answer')
  assert.equal(answerTwo.annotationIds.length, 1)
  assert.equal(storeTwo.state.annotations.items.length, 2)
})

test('at most maxAnnotationsPerAnswer verified citations become annotations', async () => {
  const fake = createFakeLlm()
  const punctuation = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
  const citations = []
  const markers = []
  for (let index = 0; index < punctuation.length; index += 1) {
    const word = punctuation[index]
    const block = blockWith(CAP_MARKDOWN, `${word} sentence`)
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
  const answer = (await collectFrames(chat, question())).find((frame) => frame.type === 'answer')
  assert.equal(answer.citations.length, 6, 'all verified citations stay in the frame')
  assert.equal(answer.annotationIds.length, 5, 'default cap is 5')
  assert.equal(store.state.annotations.items.length, 5)

  // The cap is configurable per turn.
  const fakeTwo = createFakeLlm()
  fakeTwo.queueAnswer({ markdown: `Six claims ${markers.join(' ')}.`, citations })
  const storeTwo = makeStore({ markdown: CAP_MARKDOWN })
  const two = makeChat({ store: storeTwo, fake: fakeTwo, config: { ai: { maxAnnotationsPerAnswer: 2 } } })
  const answerTwo = (await collectFrames(two.chat, question())).find((frame) => frame.type === 'answer')
  assert.equal(answerTwo.citations.length, 6)
  assert.equal(answerTwo.annotationIds.length, 2)
  assert.equal(storeTwo.state.annotations.items.length, 2)
})

// ---------------------------------------------------------------------------
// Usage, knowledge delta and unverified evidence rules
// ---------------------------------------------------------------------------

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
  const usage = frames.find((frame) => frame.type === 'usage')
  assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 1234, outputTokens: 56 } })
  const assistant = chatFile(store).messages.at(-1)
  assert.deepEqual(assistant.usage, { inputTokens: 1234, outputTokens: 56 })
})

test('unverified evidence never creates annotations or graph knowledge', async () => {
  const method = blockWith(MARKDOWN, 'We propose block-sparse attention')
  const graphCalls = []
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
  assert.equal(frames.some((frame) => frame.type === 'graph'), false)
  assert.equal(graphCalls.length, 0)
  const answer = frames.find((frame) => frame.type === 'answer')
  assert.equal(answer.citations.length, 0)
  assert.equal(answer.unverified.length, 1)
  assert.equal(answer.annotationIds.length, 0)
  assert.equal(store.state.annotations.items.length, 0)
})

// ---------------------------------------------------------------------------
// History, prompt context and trimming
// ---------------------------------------------------------------------------

test('previous conversation turns are injected into the prompt and trimmed by historyTurns', async () => {
  const seededMessages = []
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
  async function promptFor(historyTurns) {
    const fake = createFakeLlm()
    fake.queueAnswer({ markdown: 'An answer grounded in the paper.' })
    const store = makeStore()
    store.aux.set(`${DOC_ID}/chat.json`, structuredClone({ version: 1, messages: seededMessages }))
    const { chat } = makeChat({ store, fake, config: { ai: { historyTurns } } })
    await collectFrames(chat, question())
    return fake.lastPrompt()
  }

  const twoTurns = await promptFor(2)
  assert.ok(twoTurns.includes('HISTORY-QUESTION-3'))
  assert.ok(twoTurns.includes('HISTORY-QUESTION-2'))
  assert.ok(twoTurns.includes('HISTORY-ANSWER-2'))
  assert.equal(twoTurns.includes('HISTORY-QUESTION-1'), false)

  const oneTurn = await promptFor(1)
  assert.ok(oneTurn.includes('HISTORY-QUESTION-3'))
  assert.equal(oneTurn.includes('HISTORY-QUESTION-2'), false)

  const noTurns = await promptFor(0)
  assert.equal(noTurns.includes('HISTORY-QUESTION-'), false)
})

test('the prompt carries the reading focus (block + selection)', async () => {
  const limitations = blockWith(MARKDOWN, 'Routing adds latency')
  const fake = createFakeLlm()
  fake.queueAnswer({ markdown: 'The limitation is latency [1].', citations: [citation(1, 'Routing adds latency', MARKDOWN, { quote: 'Routing adds latency on short sequences' })] })
  const { chat } = makeChat({ fake })
  await collectFrames(
    chat,
    question({
      focus: { blockKey: limitations.key, selectionQuote: 'requires a warm-up phase' },
    }),
  )
  const prompt = fake.lastPrompt()
  assert.ok(prompt.includes('Reader focus'))
  assert.ok(prompt.includes(limitations.key))
  assert.ok(prompt.includes('requires a warm-up phase'))
  assert.ok(prompt.includes('Sparse Attention for Long Documents'))
  assert.ok(prompt.includes('Document outline'))
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
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].citations.length, 1)

  assert.deepEqual(await chat.clear(DOC_ID), { cleared: true })
  assert.deepEqual(await chat.history(DOC_ID), [])
  assert.deepEqual(chatFile(store), { version: 1, messages: [] })

  // Corrupt chat files read as an empty conversation instead of throwing.
  store.aux.set(`${DOC_ID}/chat.json`, { version: 1, messages: 'nope' })
  assert.deepEqual(await chat.history(DOC_ID), [])
})

// ---------------------------------------------------------------------------
// Frames for errors and aborts
// ---------------------------------------------------------------------------

test('llm failures emit error frames before and after the first delta', async () => {
  const unavailable = makeChat({ fake: createFakeLlm(), store: makeStore() })
  const llm = createLlmGateway({
    getLlm: () => undefined,
    getDefaultModel: () => undefined,
    config: { ai: {} },
    logger: quietLogger,
  })
  const retriever = createRetriever({ parseMarkdown, plainTextOfBlock, logger: quietLogger })
  const chatNoModel = createChatService({
    llm,
    retriever,
    store: makeStore(),
    config: { ai: {} },
    logger: quietLogger,
    loadAnnotations: async () => [],
    saveAnnotations: async () => undefined,
  })
  const noModelFrames = await collectFrames(chatNoModel, question())
  assert.equal(noModelFrames.length, 1)
  assert.equal(noModelFrames[0].type, 'error')
  assert.equal(noModelFrames[0].code, 'llm-unavailable')

  // Failure before any delta: start frame then an error frame.
  const beforeFake = createFakeLlm()
  beforeFake.queue({ error: new Error('provider exploded') })
  const beforeStore = makeStore()
  const before = makeChat({ fake: beforeFake, store: beforeStore })
  const beforeFrames = await collectFrames(before.chat, question())
  assert.equal(beforeFrames[0].type, 'start')
  assert.equal(beforeFrames.at(-1).type, 'error')
  assert.equal(beforeFrames.at(-1).code, 'llm-failed')
  assert.equal(beforeFrames.some((frame) => frame.type === 'answer'), false)
  assert.equal(chatFile(beforeStore), null)
  assert.equal(beforeStore.state.annotations.items.length, 0)
  assert.equal(unavailable.chat.available(), true)

  // Failure after a partial delta: deltas then an error, no answer, no persist.
  const midFake = createFakeLlm()
  midFake.queue({ text: 'The paper proposes a method that', error: new Error('connection dropped'), errorAfterChunks: 1 })
  const midStore = makeStore()
  const mid = makeChat({ fake: midFake, store: midStore })
  const midFrames = await collectFrames(mid.chat, question())
  assert.equal(midFrames[0].type, 'start')
  assert.ok(midFrames.some((frame) => frame.type === 'delta'))
  assert.equal(midFrames.at(-1).type, 'error')
  assert.equal(midFrames.at(-1).code, 'llm-failed')
  assert.equal(midFrames.some((frame) => frame.type === 'answer'), false)
  assert.equal(chatFile(midStore), null)
})

test('request and document errors become error frames without starting a turn', async () => {
  const { chat } = makeChat({ fake: createFakeLlm() })
  const badQuestion = await collectFrames(chat, { documentId: DOC_ID, question: '   ' })
  assert.equal(badQuestion.length, 1)
  assert.equal(badQuestion[0].code, 'bad-request')

  const badDocument = await collectFrames(chat, { documentId: '', question: 'why?' })
  assert.equal(badDocument[0].code, 'bad-request')

  const reservedMode = await collectFrames(chat, question({ mode: 'library' }))
  assert.equal(reservedMode.at(-1).code, 'bad-request')

  const notParsed = makeChat({ fake: createFakeLlm(), store: makeStore({ readCode: 'not-parsed' }) })
  const notParsedFrames = await collectFrames(notParsed.chat, question())
  assert.equal(notParsedFrames.length, 1)
  assert.equal(notParsedFrames[0].type, 'error')
  assert.equal(notParsedFrames[0].code, 'not-parsed')

  const emptyDocument = makeChat({ fake: createFakeLlm(), store: makeStore({ markdown: '' }) })
  const emptyFrames = await collectFrames(emptyDocument.chat, question())
  assert.equal(emptyFrames[0].code, 'bad-request')
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
  assert.equal(frames[0].type, 'start')
  assert.equal(frames.some((frame) => frame.type === 'answer'), false)
  assert.equal(frames.some((frame) => frame.type === 'answer' && frame.markdown === ''), false)
  assert.equal(frames.at(-1).type, 'error')
  assert.equal(frames.at(-1).code, 'ai-failed')
  assert.match(frames.at(-1).message, /未生成可见回答/)
  assert.equal(chatFile(store), null)
  assert.equal(store.state.annotations.items.length, 0)
})

test('chat forwards the configured reasoningEffort (low by default) to the host', async () => {
  const calls = []
  const answerText = litnotesAnswerText({
    markdown: 'A grounded answer [1].',
    citations: [
      { index: 1, blockKey: blockWith(MARKDOWN, 'We propose block-sparse attention').key, quote: 'We propose block-sparse attention', aspect: 'method', note: 'm' },
    ],
  })
  function recordingHost() {
    return {
      stream(request) {
        calls.push(request)
        return (async function* generate() {
          yield { type: 'text-delta', text: answerText }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  }
  await collectFrames(makeChat({ hostLlm: recordingHost(), store: makeStore() }).chat, question())
  assert.equal(calls[0].reasoningEffort, 'low')
  await collectFrames(
    makeChat({
      hostLlm: recordingHost(),
      store: makeStore(),
      config: { ai: { reasoningEffort: 'off' } },
    }).chat,
    question(),
  )
  assert.equal(calls[1].reasoningEffort, 'off')
})

test('abort stops the turn without persisting or annotating', async () => {
  const fake = createFakeLlm()
  fake.queue({ text: 'abcdefghij'.repeat(10), chunkDelayMs: 2 })
  const store = makeStore()
  const { chat } = makeChat({ store, fake })
  const frames = []
  const controller = new AbortController()
  for await (const frame of chat.stream(question({ signal: controller.signal }))) {
    frames.push(frame)
    if (frame.type === 'delta') controller.abort()
  }
  assert.equal(frames[0].type, 'start')
  assert.ok(frames.some((frame) => frame.type === 'delta'))
  assert.equal(frames.at(-1).type, 'error')
  assert.equal(frames.at(-1).code, 'aborted')
  assert.equal(frames.some((frame) => frame.type === 'answer'), false)
  assert.equal(chatFile(store), null)
  assert.equal(store.state.annotations.items.length, 0)
})

test('an already-aborted request never reaches the model', async () => {
  const fake = createFakeLlm()
  const { chat } = makeChat({ fake })
  const controller = new AbortController()
  controller.abort()
  const frames = await collectFrames(chat, question({ signal: controller.signal }))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].code, 'aborted')
  assert.equal(fake.callCount(), 0)
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('splitModelOutput extracts the fence, tolerates drift and ignores trailing text', () => {
  const fenced = splitModelOutput('Answer [1].\n\n```litnotes-json\n{"citations":[],"followups":["why?"]}\n```\nAfter text.')
  assert.equal(fenced.fenceFound, true)
  assert.equal(fenced.answer, 'Answer [1].')
  assert.deepEqual(fenced.payload, { citations: [], followups: ['why?'] })

  const spaced = splitModelOutput('Answer.\n``` LitNotes-JSON\n{"citations":[]}\n```')
  assert.equal(spaced.fenceFound, true)
  assert.equal(spaced.answer, 'Answer.')
  assert.deepEqual(spaced.payload, { citations: [] })

  const plain = splitModelOutput('Just an answer with [1].')
  assert.equal(plain.fenceFound, false)
  assert.equal(plain.payload, null)
  assert.equal(plain.answer, 'Just an answer with [1].')

  const bareJson = splitModelOutput('Answer.\n\n```json\n{"citations":[{"index":1}],"followups":[]}\n```')
  assert.equal(bareJson.payload.citations.length, 1)
  assert.equal(bareJson.answer, 'Answer.')

  const malformed = splitModelOutput('Answer.\n\n```litnotes-json\n{not valid json}\n```')
  assert.equal(malformed.payload, null)
  assert.equal(malformed.answer, 'Answer.')
})

test('locateQuoteRange normalizes whitespace and maps offsets back to plainText', () => {
  const plain = 'Hello\n  world\tagain'
  const range = locateQuoteRange(plain, 'Hello world again')
  assert.deepEqual(
    { start: range.start, end: range.end, exact: range.exact },
    { start: 0, end: plain.length, exact: true },
  )
  assert.equal(plain.slice(range.start, range.end), plain)

  const exact = locateQuoteRange('one two three', 'two')
  assert.deepEqual({ start: exact.start, end: exact.end, exact: exact.exact }, { start: 4, end: 7, exact: true })
  assert.equal(locateQuoteRange('hello world', 'Goodbye'), null)
  assert.equal(locateQuoteRange('hello world', ''), null)
  assert.equal(locateQuoteRange('', 'hello'), null)

  const longPlain = 'We propose block-sparse attention with learned routing.'
  const drifted = locateQuoteRange(longPlain, 'We propose block-sparse attention with learned routing and extra gating.')
  assert.ok(drifted !== null)
  assert.equal(drifted.exact, false)
  assert.equal(drifted.start, 0)
  assert.ok(drifted.end <= 40)

  assert.equal(normalizeQuoteText('  a\n\t b\u00a0c '), 'a b c')
})
