/**
 * AI grounded-chat end-to-end tests (docs/AI-SPEC.md §4/§5).
 *
 * Drives the REAL index.js + fake Cordis context (fake Host `llm`) through the
 * registered NDJSON streaming route and JSON routes:
 *
 *   POST /dsh-litnotes/api/chat          -> NDJSON: start/delta/answer/.../done
 *   POST /dsh-litnotes/api/chat.history  -> { messages: ChatMessage[] }
 *   POST /dsh-litnotes/api/chat.clear    -> { cleared: true }
 *
 * Covered: frame order + content type, the model's trailing ```litnotes-json
 * fence never leaking into streamed text, citation validation, annotation
 * creation with AI provenance, conversation persistence, request abort
 * mid-stream, and clean `ai-unavailable` failures when no model is configured.
 *
 * The engine modules land in parallel with this harness: when the grounded-chat
 * engine is not importable yet the behavioural tests skip with a clear reason
 * (route-wiring checks still run), and they run for real as soon as it lands.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  AI_ROUTES,
  createAiHarness,
  deltaText,
  envelopeValue,
  findCitationTarget,
  frameOfType,
  framesOfType,
  readChatFile,
  settleStream,
  waitForFrames,
} from './ai-harness.mjs'
import { createFakeLlm, litnotesAnswerText } from '../helpers/fake-llm.mjs'
import { waitFor } from './helpers.mjs'

const QUESTION = 'What problem does the paper address?'
const QUOTE = 'Passage retrieval is the first stage of nearly every question-answering system'

/** Skip only the engine-dependent tests while the engines are still landing. */
async function requireChatEngine(t, harness) {
  if (!(await harness.isWired())) {
    t.skip('AI routes are not wired yet')
    return false
  }
  if (!(await harness.isChatReady())) {
    t.skip('grounded-chat engine is not importable yet (lib/ai/chat.js)')
    return false
  }
  return true
}

/** Build a model answer with one verifiable citation to the fixture paper. */
function scriptedAnswer(harness) {
  const target = findCitationTarget(harness.markdown, QUOTE)
  const markdown =
    'The paper frames **passage retrieval** as the first stage of nearly every question-answering system [1]. ' +
    'It is motivated by the observation that dense encoders spend the same compute on every query.'
  const text = litnotesAnswerText({
    markdown,
    citations: [
      { index: 1, blockKey: target.blockKey, quote: target.quote, aspect: 'context', note: 'Motivation for the work.' },
    ],
    followups: ['What is the proposed method?', 'What are the limitations?'],
  })
  return { target, markdown, text }
}

test('chat streams NDJSON frames, validates citations and creates AI annotations', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireChatEngine(t, harness))) return

  const { target, markdown, text } = scriptedAnswer(harness)
  harness.llm.queue({ text, usage: { inputTokens: 1234, outputTokens: 321 } })

  const stream = harness.startStream(AI_ROUTES.chat, {
    documentId: harness.documentId,
    question: QUESTION,
    focus: { selectionQuote: 'passage retrieval' },
  })
  await settleStream(stream.settled, { label: 'chat stream' })
  const frames = stream.frames

  // --- transport ----------------------------------------------------------
  assert.equal(stream.res.state.statusCode, 200)
  assert.match(String(stream.res.state.headers['content-type']), /^application\/x-ndjson/)
  assert.equal(stream.res.state.headers['cache-control'], 'no-store')
  assert.equal(stream.res.state.writableEnded, true)
  assert.ok(frames.length >= 4, `expected several frames, got ${JSON.stringify(frames)}`)
  assert.equal(frames.every((frame) => frame !== null && typeof frame === 'object' && !('__unparsed' in frame)), true)

  // --- frame order --------------------------------------------------------
  assert.equal(frames[0].type, 'start')
  assert.equal(typeof frames[0].messageId, 'string')
  assert.ok(frames[0].model !== null && typeof frames[0].model === 'object')
  assert.equal(frameOfType(frames, 'error'), undefined, 'no error frame expected')
  assert.ok(framesOfType(frames, 'delta').length >= 1, 'answer text streamed as delta frames')
  assert.equal(frames.at(-1).type, 'done', 'the stream ends with a done frame')

  const answer = frameOfType(frames, 'answer')
  assert.ok(answer !== undefined, 'an answer frame carries the final evidence')
  const answerAt = frames.indexOf(answer)
  const firstDeltaAt = frames.findIndex((frame) => frame.type === 'delta')
  assert.ok(firstDeltaAt < answerAt, 'deltas precede the answer frame')
  assert.ok(answerAt < frames.length - 1, 'answer precedes usage/done')

  // --- streamed text never leaks the structured fence --------------------
  const streamed = deltaText(frames)
  assert.ok(streamed.includes('passage retrieval'), 'answer text was streamed')
  assert.equal(streamed.includes('```'), false, 'fence delimiters are held back')
  assert.equal(streamed.includes('"citations"'), false, 'structured JSON is not streamed as answer text')
  assert.equal(streamed.includes('litnotes-json'), false)

  // --- answer + verified citation ----------------------------------------
  assert.equal(typeof answer.markdown, 'string')
  assert.match(answer.markdown, /passage retrieval/i)
  assert.equal(answer.markdown.includes('litnotes-json'), false)
  assert.ok(Array.isArray(answer.citations) && answer.citations.length === 1)
  const citation = answer.citations[0]
  assert.equal(citation.index, 1)
  assert.equal(citation.blockKey, target.blockKey)
  assert.equal(citation.aspect, 'context')
  assert.equal(citation.verified, true)
  assert.ok(citation.quote.includes('Passage retrieval'))
  assert.equal(typeof citation.start, 'number')
  assert.equal(typeof citation.end, 'number')
  assert.ok(citation.end > citation.start)
  assert.deepEqual(answer.followups.slice(0, 2), ['What is the proposed method?', 'What are the limitations?'])
  assert.ok(Array.isArray(answer.annotationIds) && answer.annotationIds.length === 1)

  // --- annotations persisted with AI provenance --------------------------
  const annotationsFile = JSON.parse(await readFile(harness.docFile('annotations.json'), 'utf8'))
  assert.equal(annotationsFile.version, 1)
  const annotation = annotationsFile.items.find((item) => item.id === answer.annotationIds[0])
  assert.ok(annotation !== undefined, 'created annotation is persisted on disk')
  assert.equal(annotation.origin, 'ai')
  assert.equal(annotation.blockKey, target.blockKey)
  assert.equal(annotation.aspect, 'context')
  assert.equal(annotation.chatId, answer.messageId)
  assert.ok(annotation.model !== undefined && annotation.model !== null, 'annotation records the model')
  assert.equal(annotation.start >= 0, true)

  // --- chat persisted for history ----------------------------------------
  const chat = await readChatFile(harness)
  assert.ok(chat !== null && Array.isArray(chat.messages))
  assert.ok(chat.messages.length >= 1)
  const assistant = chat.messages.find((message) => message.role === 'assistant')
  assert.ok(assistant !== undefined, 'assistant message persisted')
  assert.match(String(assistant.answer), /passage retrieval/i)

  // The request asked one question: the model was called exactly once for the answer.
  assert.equal(harness.llm.callCount(), 1)
  assert.equal(harness.llm.calls[0].status, 'completed')
  assert.ok(
    harness.llm.calls[0].prompt.includes(QUESTION),
    'the question reached the model prompt',
  )
  assert.ok(harness.llm.calls[0].system !== '', 'a system prompt was supplied')
})

test('chat.history returns the persisted conversation and chat.clear empties it', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireChatEngine(t, harness))) return
  const { text } = scriptedAnswer(harness)
  harness.llm.queue({ text })
  const stream = harness.startStream(AI_ROUTES.chat, { documentId: harness.documentId, question: QUESTION })
  await settleStream(stream.settled)
  assert.equal(frameOfType(stream.frames, 'error'), undefined)

  const history = await harness.invokeJson(AI_ROUTES.history, {
    method: 'POST',
    payload: { documentId: harness.documentId },
  })
  assert.equal(history.status, 200)
  const value = envelopeValue(history, 'chat.history')
  assert.ok(Array.isArray(value.messages) && value.messages.length >= 1)
  const assistant = value.messages.find((message) => message.role === 'assistant')
  assert.ok(assistant !== undefined)
  assert.match(String(assistant.answer), /passage retrieval/i)
  assert.ok(Array.isArray(assistant.citations) && assistant.citations.length === 1)
  assert.equal(assistant.citations[0].verified, true)

  const cleared = await harness.invokeJson(AI_ROUTES.clear, {
    method: 'POST',
    payload: { documentId: harness.documentId },
  })
  assert.equal(cleared.status, 200)
  assert.deepEqual(envelopeValue(cleared, 'chat.clear'), { cleared: true })

  const after = await harness.invokeJson(AI_ROUTES.history, {
    method: 'POST',
    payload: { documentId: harness.documentId },
  })
  assert.deepEqual(envelopeValue(after, 'chat.history').messages, [])
})

test('aborting the request mid-stream closes the NDJSON response and the model call', async (t) => {
  const harness = await createAiHarness(t)
  if (!(await requireChatEngine(t, harness))) return

  // A long answer that would never finish within the test if not aborted.
  const chunks = []
  for (let index = 0; index < 500; index += 1) chunks.push({ type: 'text-delta', text: `chunk-${index} ` })
  harness.llm.queue({ chunks, chunkDelayMs: 4 })

  const stream = harness.startStream(AI_ROUTES.chat, { documentId: harness.documentId, question: 'Tell me everything.' })
  await waitForFrames(stream.res, 1, { label: 'first chat frame' })
  assert.equal(stream.res.state.writableEnded, false, 'the stream is still open before the abort')

  stream.req.abortStream()
  await settleStream(stream.settled, { label: 'aborted chat stream' })

  assert.equal(stream.res.state.writableEnded, true, 'aborted response was closed')
  await waitFor(() => harness.llm.calls.length === 1 && harness.llm.calls[0].status === 'aborted', {
    timeout: 8000,
    label: 'fake model call to be aborted',
  })
  // The route must not throw after headers; a terminal error frame is acceptable.
  const frames = stream.frames
  assert.equal(frames.every((frame) => !('__unparsed' in frame)), true)
  if (frameOfType(frames, 'error')) {
    assert.match(String(frameOfType(frames, 'error').code), /abort|ai-failed|host-error|cancel/i)
  }
})

test('chat routes fail cleanly when no LLM is configured (ai-unavailable)', async (t) => {
  const harness = await createAiHarness(t, { llm: null, defaultModel: null })
  if (!harness.hasRoute(AI_ROUTES.chat)) {
    t.skip('AI streaming routes are not wired yet')
    return
  }

  // NDJSON route: either an ai-unavailable error frame or a JSON error envelope
  // before any frame is written — never an unhandled rejection.
  const stream = harness.startStream(AI_ROUTES.chat, {
    documentId: harness.documentId,
    question: 'What is this paper about?',
  })
  await settleStream(stream.settled, { label: 'chat without llm' })
  const frames = stream.frames
  if (frames.length === 0) {
    assert.ok(stream.res.state.statusCode !== undefined, 'a JSON error response was written')
  } else {
    assert.equal(stream.res.state.statusCode, 200)
    const error = frameOfType(frames, 'error')
    assert.ok(error !== undefined, `expected an error frame, got ${JSON.stringify(frames)}`)
    assert.match(String(error.code), /ai-unavailable|llm-unavailable/)
  }
  assert.equal(stream.res.state.writableEnded, true)

  // JSON route: the shared envelope carries the branchable code + 503.
  const history = await harness.invokeJson(AI_ROUTES.history, {
    method: 'POST',
    payload: { documentId: harness.documentId },
  })
  assert.equal(history.status, 503)
  assert.equal(history.body.ok, false)
  assert.match(String(history.body.error.code), /ai-unavailable|llm-unavailable/)
})

test('chat rejects a malformed request with an error frame instead of crashing', async (t) => {
  const harness = await createAiHarness(t)
  if (!harness.hasRoute(AI_ROUTES.chat)) {
    t.skip('AI streaming routes are not wired yet')
    return
  }
  const stream = harness.startStream(AI_ROUTES.chat, { question: 'missing document id' })
  await settleStream(stream.settled, { label: 'malformed chat stream' })
  const frames = stream.frames
  if (frames.length > 0) {
    const error = frameOfType(frames, 'error')
    assert.ok(error !== undefined, `expected an error frame, got ${JSON.stringify(frames)}`)
    assert.match(String(error.code), /bad-request|not-found|ai-unavailable/)
  } else {
    assert.ok(stream.res.state.statusCode >= 400)
  }
})

test('a fake LLM wrapper can be swapped per test without shared state', async (t) => {
  const harness = await createAiHarness(t, { llm: createFakeLlm({ defaultText: 'plain' }) })
  assert.notEqual(harness.llm, undefined)
  // Sanity: the harness's fake ctx returns the injected service unchanged.
  assert.equal(harness.ctx.get('llm'), harness.llm)
  assert.equal(harness.ctx.get('agentDefaultModel'), harness.defaultModel)
  const first = harness.ctx.get('llm')
  assert.equal(first.name, 'fake-llm')
})
