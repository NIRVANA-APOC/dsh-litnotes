/**
 * Unit tests for the Host LLM gateway (`lib/ai/llm.js`): route resolution
 * (config override → agent default model), chunk normalization, bounded
 * one-shot completion, abort handling and the AiError taxonomy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AiError, createLlmGateway } from '../../lib/ai/llm.js'
import { createFakeDefaultModel, createFakeLlm } from '../helpers/fake-llm.mjs'

const quietLogger = { debug() {}, warn() {}, error() {} }
const DEFAULT_SELECTION = { provider: 'fake-provider', model: 'fake-model' }

/** Collect an async iterable into an array. */
async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

/** Build a gateway over a fake host llm (or undefined for "not mounted"). */
function makeGateway({ fake, getLlm, getDefaultModel, config = { ai: {} }, logger = quietLogger } = {}) {
  return createLlmGateway({
    getLlm: getLlm ?? (() => fake),
    getDefaultModel: getDefaultModel ?? (() => DEFAULT_SELECTION),
    config,
    logger,
  })
}

/** A fake llm with one queued script and a gateway around it. */
function fakeWith(script) {
  const fake = createFakeLlm()
  if (script !== undefined) fake.queue(script)
  return { fake, gateway: makeGateway({ fake }) }
}

/** A minimal valid stream request. */
function streamRequest(extra = {}) {
  return {
    system: 'system prompt',
    messages: [{ role: 'user', content: 'hello model' }],
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Route and availability
// ---------------------------------------------------------------------------

test('route: config override wins over the agent default model', () => {
  const fake = createFakeLlm()
  const agentDefault = makeGateway({ fake })
  assert.deepEqual(agentDefault.route(), DEFAULT_SELECTION)

  const overridden = makeGateway({
    fake,
    config: { ai: { provider: 'config-provider', model: 'config-model' } },
  })
  assert.deepEqual(overridden.route(), { provider: 'config-provider', model: 'config-model' })

  // A partial override is ignored (both fields are required).
  const partial = makeGateway({ fake, config: { ai: { provider: 'only-provider', model: '' } } })
  assert.deepEqual(partial.route(), DEFAULT_SELECTION)
})

test('route: accepts the agentDefaultModel service shape and plain getters', () => {
  const fake = createFakeLlm()
  const service = createFakeDefaultModel({ provider: 'agent-p', model: 'agent-m' })
  assert.deepEqual(
    makeGateway({ fake, getDefaultModel: () => service }).route(),
    { provider: 'agent-p', model: 'agent-m' },
  )
  assert.deepEqual(
    makeGateway({ fake, getDefaultModel: () => ({ provider: 'p', model: 'm' }) }).route(),
    { provider: 'p', model: 'm' },
  )
  assert.equal(makeGateway({ fake, getDefaultModel: () => undefined }).route(), null)
  assert.equal(
    makeGateway({
      fake,
      getDefaultModel: () => {
        throw new Error('no service')
      },
    }).route(),
    null,
  )
  assert.equal(
    makeGateway({ fake, getDefaultModel: () => ({ provider: 'p', model: '' }) }).route(),
    null,
  )
})

test('available(): requires both a route and a host llm stream', () => {
  const fake = createFakeLlm()
  assert.equal(makeGateway({ fake }).available(), true)
  assert.equal(makeGateway({ getLlm: () => undefined }).available(), false)
  assert.equal(makeGateway({ fake, getDefaultModel: () => undefined }).available(), false)
  assert.equal(makeGateway({ getLlm: () => ({}) }).available(), false)
  assert.equal(makeGateway({ getLlm: () => ({ stream: 'nope' }) }).available(), false)
})

// ---------------------------------------------------------------------------
// streamText normalization
// ---------------------------------------------------------------------------

test('streamText normalizes deltas, usage and finish and clamps options', async () => {
  const { fake, gateway } = fakeWith({ text: 'hello world', usage: { inputTokens: 11, outputTokens: 7 } })
  const chunks = await collect(
    gateway.streamText(streamRequest({ maxTokens: 99999, temperature: 5, purpose: 'chat' })),
  )
  assert.equal(
    chunks.filter((chunk) => chunk.type === 'delta').map((chunk) => chunk.text).join(''),
    'hello world',
  )
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })

  const call = fake.lastCall()
  assert.equal(call.provider, 'fake-provider')
  assert.equal(call.model, 'fake-model')
  assert.equal(call.system, 'system prompt')
  assert.equal(call.maxTokens, 16384, 'maxTokens is clamped to the hard cap')
  assert.equal(call.temperature, 2, 'temperature is clamped')
  assert.deepEqual(call.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello model' }] }])
})

test('streamText forwards finish reasons and synthesizes one when absent', async () => {
  const lengthLimited = fakeWith({ text: 'x', finishReason: { kind: 'length' } })
  const first = await collect(lengthLimited.gateway.streamText(streamRequest()))
  assert.deepEqual(first.at(-1), { type: 'finish', reason: { kind: 'length' } })

  const noFinish = createFakeLlm()
  noFinish.queue({
    chunks: [{ type: 'text-delta', text: 'x' }, { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }],
    finish: false,
  })
  const second = await collect(makeGateway({ fake: noFinish }).streamText(streamRequest()))
  assert.deepEqual(second.filter((chunk) => chunk.type !== 'delta').map((chunk) => chunk.type), ['usage', 'finish'])
  assert.deepEqual(second.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('streamText ignores unknown host chunk types and normalizes string content', async () => {
  const fake = createFakeLlm()
  fake.queue({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', text: 'ok' },
      { type: 'reasoning-delta', text: 'internal' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const gateway = makeGateway({ fake })
  const chunks = await collect(
    gateway.streamText({
      messages: [
        { role: 'assistant', content: 'prior answer' },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    }),
  )
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['delta', 'finish'],
  )
  assert.deepEqual(fake.lastCall().messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ])
})

// ---------------------------------------------------------------------------
// Errors and aborts
// ---------------------------------------------------------------------------

test('streamText throws llm-unavailable without a host llm or without a route', async () => {
  const noService = makeGateway({ getLlm: () => undefined })
  await assert.rejects(collect(noService.streamText(streamRequest())), (error) => {
    assert.ok(error instanceof AiError)
    assert.equal(error.code, 'llm-unavailable')
    return true
  })
  const noRoute = makeGateway({ fake: createFakeLlm(), getDefaultModel: () => undefined })
  await assert.rejects(collect(noRoute.streamText(streamRequest())), /模型|model/i)
  await assert.rejects(collect(noRoute.streamText(streamRequest())), (error) => {
    assert.equal(error.code, 'llm-unavailable')
    return true
  })
})

test('streamText maps host failures to llm-failed without leaking the prompt', async () => {
  const before = fakeWith({ error: new Error('provider exploded') })
  await assert.rejects(collect(before.gateway.streamText(streamRequest())), (error) => {
    assert.ok(error instanceof AiError)
    assert.equal(error.code, 'llm-failed')
    assert.match(error.detail, /provider exploded/)
    return true
  })

  const mid = fakeWith({ text: '0123456789abcdef', chunkSize: 8, error: new Error('mid-stream'), errorAfterChunks: 1 })
  const seen = []
  await assert.rejects(
    (async () => {
      for await (const chunk of mid.gateway.streamText(streamRequest())) seen.push(chunk)
    })(),
    (error) => {
      assert.equal(error.code, 'llm-failed')
      assert.match(error.detail, /mid-stream/)
      return true
    },
  )
  assert.equal(seen.filter((chunk) => chunk.type === 'delta').length, 1)
  assert.equal(JSON.stringify(seen).includes('system prompt'), false)
})

test('streamText honours abort signals before and during generation', async () => {
  const preAborted = new AbortController()
  preAborted.abort()
  const { fake, gateway } = fakeWith('never sent')
  await assert.rejects(
    collect(gateway.streamText(streamRequest({ signal: preAborted.signal }))),
    (error) => {
      assert.equal(error.code, 'aborted')
      return true
    },
  )
  assert.equal(fake.callCount(), 0)

  const controller = new AbortController()
  const delayed = createFakeLlm()
  delayed.queue({ text: 'abcdefghij'.repeat(4), chunkDelayMs: 2 })
  const delayedGateway = makeGateway({ fake: delayed })
  const seen = []
  await assert.rejects(
    (async () => {
      for await (const chunk of delayedGateway.streamText(streamRequest({ signal: controller.signal }))) {
        seen.push(chunk)
        controller.abort()
      }
    })(),
    (error) => {
      assert.equal(error.code, 'aborted')
      return true
    },
  )
  assert.ok(seen.some((chunk) => chunk.type === 'delta'))
})

test('empty or invalid requests are bad-request', async () => {
  const { gateway } = fakeWith('unused')
  await assert.rejects(collect(gateway.streamText({ messages: [] })), (error) => {
    assert.equal(error.code, 'bad-request')
    return true
  })
  await assert.rejects(collect(gateway.streamText({})), /提示内容|prompt/i)
})

test('streamText always pins reasoningEffort: low default, config value, per-request override', async () => {
  const calls = []
  const recordingLlm = {
    stream(request) {
      calls.push(request)
      return (async function* generate() {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  // The DeepSeek adapter defaults to effort "high", which can spend the whole
  // completion budget on reasoning tokens and produce an empty visible answer.
  const plain = makeGateway({ getLlm: () => recordingLlm, config: { ai: {} } })
  await collect(plain.streamText(streamRequest()))
  assert.equal(calls[0].reasoningEffort, 'low')

  const configured = makeGateway({ getLlm: () => recordingLlm, config: { ai: { reasoningEffort: 'high' } } })
  await collect(configured.streamText(streamRequest()))
  assert.equal(calls[1].reasoningEffort, 'high')

  const overridden = makeGateway({ getLlm: () => recordingLlm, config: { ai: { reasoningEffort: 'high' } } })
  await collect(overridden.streamText(streamRequest({ reasoningEffort: 'max' })))
  assert.equal(calls[2].reasoningEffort, 'max')

  // Invalid per-request values fall back to the configured effort.
  await collect(overridden.streamText(streamRequest({ reasoningEffort: 'ultra' })))
  assert.equal(calls[3].reasoningEffort, 'high')

  // Invalid config values fall back to the safe default.
  const invalidConfig = makeGateway({ getLlm: () => recordingLlm, config: { ai: { reasoningEffort: 'turbo' } } })
  await collect(invalidConfig.streamText(streamRequest()))
  assert.equal(calls[4].reasoningEffort, 'low')
})

// ---------------------------------------------------------------------------
// completeText
// ---------------------------------------------------------------------------

test('completeText collects a bounded string', async () => {
  const fake = createFakeLlm()
  fake.setDefault({ text: 'abcdefghij', chunkSize: 4 })
  const gateway = makeGateway({ fake })
  assert.equal(await gateway.completeText(streamRequest()), 'abcdefghij')
  assert.equal(await gateway.completeText(streamRequest({ maxChars: 5 })), 'abcde')
  assert.equal((await gateway.completeText(streamRequest({ maxChars: 3 }))).length, 3)

  const failing = fakeWith({ error: new Error('nope') })
  await assert.rejects(failing.gateway.completeText(streamRequest()), (error) => {
    assert.equal(error.code, 'llm-failed')
    return true
  })
})

test('streamText does not call the host when the request is rejected', async () => {
  const fake = createFakeLlm()
  const gateway = makeGateway({ fake })
  await assert.rejects(collect(gateway.streamText({ messages: [] })), (error) => {
    assert.equal(error.code, 'bad-request')
    return true
  })
  assert.equal(fake.callCount(), 0)
})
