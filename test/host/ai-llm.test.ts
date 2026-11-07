/**
 * Unit tests for the Host LLM gateway (`src/host/ai/llm.ts`): route resolution
 * (config override → agent default model), chunk normalization, bounded
 * one-shot completion, abort handling, the token-estimate/context-budget
 * behaviour and the AiError taxonomy.
 */

import { describe, expect, test } from 'vitest'
import {
  AiError,
  createLlmGateway,
  type LlmCompleteRequest,
  type LlmGateway,
} from '../../src/host/ai/llm.ts'
import { createFakeDefaultModel, createFakeLlm, type FakeLlm } from '../helpers/fake-llm.ts'
import type { AiStreamChunk } from '../../src/host/contracts.ts'

const quietLogger = { debug(): void {}, warn(): void {}, error(): void {} }
const DEFAULT_SELECTION = { provider: 'fake-provider', model: 'fake-model' }

/** Collect an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T> | AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

/** Gateway deps helper. */
interface GatewayOptions {
  fake?: FakeLlm | undefined
  getLlm?: (() => unknown) | undefined
  getDefaultModel?: (() => unknown) | undefined
  getTokenMeter?: (() => unknown) | undefined
  config?: { ai: Partial<import('../../src/host/contracts.ts').AiConfig> }
  logger?: typeof quietLogger
}

/** Build a gateway over a fake host llm (or undefined for "not mounted"). */
function makeGateway(options: GatewayOptions = {}): LlmGateway {
  return createLlmGateway({
    getLlm: options.getLlm ?? (() => options.fake),
    getDefaultModel: options.getDefaultModel ?? (() => DEFAULT_SELECTION),
    getTokenMeter: options.getTokenMeter,
    config: options.config ?? { ai: {} },
    logger: options.logger ?? quietLogger,
  })
}

/** A fake llm with one queued script and a gateway around it. */
function fakeWith(script?: Parameters<FakeLlm['queue']>[0]): { fake: FakeLlm; gateway: LlmGateway } {
  const fake = createFakeLlm()
  if (script !== undefined) fake.queue(script)
  return { fake, gateway: makeGateway({ fake }) }
}

/** A minimal valid stream request. */
function streamRequest(extra: Partial<LlmCompleteRequest> = {}): LlmCompleteRequest {
  return {
    system: 'system prompt',
    messages: [{ role: 'user', content: 'hello model' }],
    ...extra,
  }
}

/** Narrow collected chunks to deltas. */
function deltas(chunks: readonly AiStreamChunk[]): Array<Extract<AiStreamChunk, { type: 'delta' }>> {
  return chunks.filter((chunk): chunk is Extract<AiStreamChunk, { type: 'delta' }> => chunk.type === 'delta')
}

// ---------------------------------------------------------------------------
// Route and availability
// ---------------------------------------------------------------------------

describe('route and availability', () => {
  test('route: config override wins over the agent default model', () => {
    const fake = createFakeLlm()
    expect(makeGateway({ fake }).route()).toEqual(DEFAULT_SELECTION)

    const overridden = makeGateway({ fake, config: { ai: { provider: 'config-provider', model: 'config-model' } } })
    expect(overridden.route()).toEqual({ provider: 'config-provider', model: 'config-model' })

    // A partial override is ignored (both fields are required).
    const partial = makeGateway({ fake, config: { ai: { provider: 'only-provider', model: '' } } })
    expect(partial.route()).toEqual(DEFAULT_SELECTION)
  })

  test('route: accepts the agentDefaultModel service shape and plain getters', () => {
    const fake = createFakeLlm()
    const service = createFakeDefaultModel({ provider: 'agent-p', model: 'agent-m' })
    expect(makeGateway({ fake, getDefaultModel: () => service }).route()).toEqual({
      provider: 'agent-p',
      model: 'agent-m',
    })
    expect(makeGateway({ fake, getDefaultModel: () => ({ provider: 'p', model: 'm' }) }).route()).toEqual({
      provider: 'p',
      model: 'm',
    })
    expect(makeGateway({ fake, getDefaultModel: () => undefined }).route()).toBeNull()
    expect(
      makeGateway({
        fake,
        getDefaultModel: () => {
          throw new Error('no service')
        },
      }).route(),
    ).toBeNull()
    expect(makeGateway({ fake, getDefaultModel: () => ({ provider: 'p', model: '' }) }).route()).toBeNull()
  })

  test('available(): requires both a route and a host llm stream', () => {
    const fake = createFakeLlm()
    expect(makeGateway({ fake }).available()).toBe(true)
    expect(makeGateway({ getLlm: () => undefined }).available()).toBe(false)
    expect(makeGateway({ fake, getDefaultModel: () => undefined }).available()).toBe(false)
    expect(makeGateway({ getLlm: () => ({}) }).available()).toBe(false)
    expect(makeGateway({ getLlm: () => ({ stream: 'nope' }) }).available()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// streamText normalization
// ---------------------------------------------------------------------------

describe('streamText normalization', () => {
  test('normalizes deltas, usage and finish and clamps options', async () => {
    const { fake, gateway } = fakeWith({ text: 'hello world', usage: { inputTokens: 11, outputTokens: 7 } })
    const chunks = await collect(
      gateway.streamText(streamRequest({ maxTokens: 99999, temperature: 5, purpose: 'chat' })),
    )
    expect(deltas(chunks).map((chunk) => chunk.text).join('')).toBe('hello world')
    expect(chunks.find((chunk) => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 11, outputTokens: 7 },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    const call = fake.lastCall()
    expect(call).toBeDefined()
    expect(call?.provider).toBe('fake-provider')
    expect(call?.model).toBe('fake-model')
    expect(call?.system).toBe('system prompt')
    expect(call?.maxTokens).toBe(16384)
    expect(call?.temperature).toBe(2)
    expect(call?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello model' }] }])
  })

  test('forwards finish reasons and synthesizes one when absent', async () => {
    const lengthLimited = fakeWith({ text: 'x', finishReason: { kind: 'length' } })
    const first = await collect(lengthLimited.gateway.streamText(streamRequest()))
    expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'length' } })

    const noFinish = createFakeLlm()
    noFinish.queue({
      chunks: [{ type: 'text-delta', text: 'x' }, { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }],
      finish: false,
    })
    const second = await collect(makeGateway({ fake: noFinish }).streamText(streamRequest()))
    expect(second.filter((chunk) => chunk.type !== 'delta').map((chunk) => chunk.type)).toEqual(['usage', 'finish'])
    expect(second.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  test('ignores unknown host chunk types and normalizes string content', async () => {
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
    expect(chunks.map((chunk) => chunk.type)).toEqual(['delta', 'finish'])
    expect(fake.lastCall()?.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ])
  })
})

// ---------------------------------------------------------------------------
// Context budget via the Host token meter
// ---------------------------------------------------------------------------

describe('context budget', () => {
  test('estimateTokens uses the injected Host tokenMeter, then the char heuristic', () => {
    expect(makeGateway({ fake: createFakeLlm() }).estimateTokens('abcdefgh')).toBe(2)
    const metered = makeGateway({
      fake: createFakeLlm(),
      getTokenMeter: () => ({
        estimateMessage: (message: { content: Array<{ text: string }> }) => message.content[0]?.text.length ?? 0,
      }),
    })
    expect(metered.estimateTokens('abcdefgh')).toBe(8)
    // A throwing estimator falls back to the heuristic instead of failing calls.
    const broken = makeGateway({
      fake: createFakeLlm(),
      getTokenMeter: () => ({
        estimateMessage: () => {
          throw new Error('meter exploded')
        },
      }),
    })
    expect(broken.estimateTokens('abcdefgh')).toBe(2)
  })

  test('a prompt over the estimated context budget is context-too-large (no host call)', async () => {
    const fake = createFakeLlm()
    const gateway = makeGateway({
      fake,
      getTokenMeter: () => ({ estimateMessage: () => 1_000_000 }),
    })
    await expect(collect(gateway.streamText(streamRequest()))).rejects.toMatchObject({
      code: 'context-too-large',
    })
    expect(fake.callCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Errors and aborts
// ---------------------------------------------------------------------------

describe('errors and aborts', () => {
  test('throws llm-unavailable without a host llm or without a route', async () => {
    const noService = makeGateway({ getLlm: () => undefined })
    await expect(collect(noService.streamText(streamRequest()))).rejects.toBeInstanceOf(AiError)
    await expect(collect(noService.streamText(streamRequest()))).rejects.toMatchObject({
      code: 'llm-unavailable',
    })
    const noRoute = makeGateway({ fake: createFakeLlm(), getDefaultModel: () => undefined })
    await expect(collect(noRoute.streamText(streamRequest()))).rejects.toThrow(/模型|model/i)
    await expect(collect(noRoute.streamText(streamRequest()))).rejects.toMatchObject({ code: 'llm-unavailable' })
  })

  test('maps host failures to llm-failed without leaking the prompt', async () => {
    const before = fakeWith({ error: new Error('provider exploded') })
    await expect(collect(before.gateway.streamText(streamRequest()))).rejects.toMatchObject({
      code: 'llm-failed',
      detail: expect.stringMatching(/provider exploded/),
    })

    const mid = fakeWith({
      text: '0123456789abcdef',
      chunkSize: 8,
      error: new Error('mid-stream'),
      errorAfterChunks: 1,
    })
    const seen: AiStreamChunk[] = []
    await expect(
      (async () => {
        for await (const chunk of mid.gateway.streamText(streamRequest())) seen.push(chunk)
      })(),
    ).rejects.toMatchObject({ code: 'llm-failed', detail: expect.stringMatching(/mid-stream/) })
    expect(deltas(seen)).toHaveLength(1)
    expect(JSON.stringify(seen).includes('system prompt')).toBe(false)
  })

  test('honours abort signals before and during generation', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const { fake, gateway } = fakeWith('never sent')
    await expect(
      collect(gateway.streamText(streamRequest({ signal: preAborted.signal }))),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(fake.callCount()).toBe(0)

    const controller = new AbortController()
    const delayed = createFakeLlm()
    delayed.queue({ text: 'abcdefghij'.repeat(4), chunkDelayMs: 2 })
    const delayedGateway = makeGateway({ fake: delayed })
    const seen: AiStreamChunk[] = []
    await expect(
      (async () => {
        for await (const chunk of delayedGateway.streamText(streamRequest({ signal: controller.signal }))) {
          seen.push(chunk)
          controller.abort()
        }
      })(),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(seen.some((chunk) => chunk.type === 'delta')).toBe(true)
  })

  test('empty or invalid requests are bad-request', async () => {
    const { gateway } = fakeWith('unused')
    await expect(collect(gateway.streamText({ messages: [] }))).rejects.toMatchObject({ code: 'bad-request' })
    await expect(collect(gateway.streamText({}))).rejects.toThrow(/提示内容|prompt/i)
  })

  test('always pins reasoningEffort: low default, config value, per-request override', async () => {
    const calls: Array<Record<string, unknown>> = []
    const recordingLlm = {
      stream(request: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
        calls.push(request)
        return (async function* generate(): AsyncGenerator<Record<string, unknown>> {
          yield { type: 'text-delta', text: 'ok' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    // The DeepSeek adapter defaults to effort "high", which can spend the whole
    // completion budget on reasoning tokens and produce an empty visible answer.
    const plain = makeGateway({ getLlm: () => recordingLlm, config: { ai: {} } })
    await collect(plain.streamText(streamRequest()))
    expect(calls[0]?.reasoningEffort).toBe('low')

    const configured = makeGateway({ getLlm: () => recordingLlm, config: { ai: { reasoningEffort: 'high' } } })
    await collect(configured.streamText(streamRequest()))
    expect(calls[1]?.reasoningEffort).toBe('high')

    const overridden = makeGateway({ getLlm: () => recordingLlm, config: { ai: { reasoningEffort: 'high' } } })
    await collect(overridden.streamText(streamRequest({ reasoningEffort: 'max' })))
    expect(calls[2]?.reasoningEffort).toBe('max')

    // Invalid per-request values fall back to the configured effort.
    await collect(overridden.streamText(streamRequest({ reasoningEffort: 'ultra' })))
    expect(calls[3]?.reasoningEffort).toBe('high')

    // Invalid config values fall back to the safe default.
    const invalidConfig = makeGateway({ getLlm: () => recordingLlm, config: { ai: { reasoningEffort: 'turbo' } } })
    await collect(invalidConfig.streamText(streamRequest()))
    expect(calls[4]?.reasoningEffort).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// completeText
// ---------------------------------------------------------------------------

describe('completeText', () => {
  test('collects a bounded string', async () => {
    const fake = createFakeLlm()
    fake.setDefault({ text: 'abcdefghij', chunkSize: 4 })
    const gateway = makeGateway({ fake })
    expect(await gateway.completeText(streamRequest())).toBe('abcdefghij')
    expect(await gateway.completeText(streamRequest({ maxChars: 5 }))).toBe('abcde')
    expect((await gateway.completeText(streamRequest({ maxChars: 3 }))).length).toBe(3)

    const failing = fakeWith({ error: new Error('nope') })
    await expect(failing.gateway.completeText(streamRequest())).rejects.toMatchObject({ code: 'llm-failed' })
  })

  test('never calls the host when the request is rejected', async () => {
    const fake = createFakeLlm()
    const gateway = makeGateway({ fake })
    await expect(collect(gateway.streamText({ messages: [] }))).rejects.toMatchObject({ code: 'bad-request' })
    expect(fake.callCount()).toBe(0)
  })
})
