/**
 * Model gateway over the Host `llm` service for dsh-litnotes.
 *
 * The Host exposes an optional LLM service and a default model selection:
 *
 *     const llm = ctx.get('llm')                                  // { stream(options) }
 *     const selection = ctx.get('agentDefaultModel')?.currentSelection()
 *     // → { provider, model, reasoningEffort? }
 *
 * The gateway hides those optional dependencies behind one small async API:
 * a route resolved from a config override or the agent default, a normalized
 * delta/usage/finish stream, a bounded one-shot completion and a stable
 * {@link AiError} taxonomy. No prompt text or user data is logged here; only
 * provider/model, sizes and the safe part of an error message are recorded.
 *
 * The Host `tokenMeter` (when the profile mounts it) supplies the estimate used
 * for the prompt context budget; the fallback is a character heuristic so the
 * engine also works on hosts without the service.
 *
 * Host stream chunks consumed (`docs/AI-SPEC.md` §3):
 *
 *     { type: 'text-delta', text: '…' }
 *     { type: 'usage', usage: { inputTokens, outputTokens } }
 *     { type: 'finish', reason: { kind: 'stop' | 'length' | 'error' } }
 *
 * @module host/ai/llm
 */

import type {
  LlmGatewayApi,
  AiStreamChunk,
  AiChatMessage,
} from '../contracts.ts'
import type {
  AgentDefaultModelService,
  LlmService,
  LlmStreamChunk,
  ModelSelection,
  TokenMeterService,
} from '../host-services.ts'
import type { AiConfig } from '../contracts.ts'
import type { Logger } from '../host-services.ts'

/** Stable error codes emitted by the AI engine (plus wire codes passed through). */
export const AI_ERROR_CODES: readonly string[] = Object.freeze([
  'llm-unavailable',
  'llm-failed',
  'ai-failed',
  'context-too-large',
  'aborted',
  'bad-request',
])

/** Reasoning efforts the Host adapter accepts, weakest first. */
const REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max'])
/** Default reasoning effort for utility/reading calls (`config.ai.reasoningEffort`). */
const DEFAULT_REASONING_EFFORT = 'low'
/** Hard cap on output tokens requested from the host. */
const MAX_OUTPUT_TOKENS = 16384
/** Hard cap on a single collected completion (characters). */
const MAX_COMPLETE_CHARS = 400000
/** Default bounded completion size (characters). */
const DEFAULT_COMPLETE_CHARS = 120000
/** Hard cap on one streamed completion; beyond it the stream stops with `length`. */
const MAX_STREAM_CHARS = 800000
/** Safe-error detail cap. */
const DETAIL_MAX_CHARS = 300
/**
 * Prompt context budget in estimated tokens. The engine prompts are already
 * bounded by their character budgets (`ai.maxContextChars`, graph chunk caps);
 * this is the safety valve that turns a pathological request into a stable
 * `context-too-large` error instead of a Host failure. `tokenMeter` is used to
 * estimate when the Host mounts it.
 */
const MAX_PROMPT_TOKENS = 64000
/** Fallback estimate when no Host token meter is mounted: ~chars per token. */
const FALLBACK_CHARS_PER_TOKEN = 4

/** Friendly UI-safe message per code (English + Chinese, no internals). */
const CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'llm-unavailable': '语言模型服务不可用（LLM service unavailable）',
  'llm-failed': '模型调用失败（LLM request failed）',
  'ai-failed': 'AI 未生成可见回答（AI produced no visible answer）',
  'context-too-large': '上下文超出模型限制（Context is too large）',
  aborted: '已停止（Aborted）',
  'bad-request': '请求无效（Invalid request）',
})

/**
 * Structured AI failure. `code` is stable for the UI and the agent tools;
 * `detail` holds an optional bounded, non-sensitive diagnostic.
 */
export class AiError extends Error {
  /** Stable engine/wire code (one of {@link AI_ERROR_CODES}, unknown kept). */
  readonly code: string
  /** Optional bounded, non-sensitive diagnostic detail. */
  readonly detail: string | undefined

  /**
   * @param code - stable error code (unknown codes are kept).
   * @param message - user-facing message; defaults from the code.
   * @param detail - bounded diagnostic detail.
   */
  constructor(code: string, message?: string, detail?: unknown) {
    const normalizedCode = typeof code === 'string' && code !== '' ? code : 'llm-failed'
    super(
      typeof message === 'string' && message !== ''
        ? message
        : (CODE_MESSAGES[normalizedCode] ?? CODE_MESSAGES['llm-failed'] ?? '模型调用失败（LLM request failed）'),
    )
    this.name = 'AiError'
    this.code = normalizedCode
    this.detail = safeDetail(detail)
  }
}

/** Whether a value is one of this engine's structured failures. */
export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError
}

/** One model message accepted by the gateway (normalized before dispatch). */
export interface LlmMessageInput {
  role?: string | undefined
  content?: string | readonly (string | { type?: unknown; text?: unknown })[] | undefined
}

/** One prompt passed to the gateway; mirrors the Host request shape. */
export interface LlmStreamRequest {
  system?: string | undefined
  messages?: readonly (LlmMessageInput | AiChatMessage)[] | undefined
  signal?: AbortSignal | undefined
  maxTokens?: number | undefined
  temperature?: number | undefined
  purpose?: string | undefined
  reasoningEffort?: string | undefined
}

/** A bounded one-shot completion request. */
export interface LlmCompleteRequest extends LlmStreamRequest {
  maxChars?: number | undefined
}

/**
 * The gateway facade: the frozen contract API (with its request shapes widened
 * to the message/content forms the Host accepts) plus the token-estimate helper
 * used for the prompt context budget.
 */
export type LlmGateway = Omit<LlmGatewayApi, 'streamText' | 'completeText'> & {
  streamText: (request?: LlmStreamRequest) => AsyncGenerator<AiStreamChunk>
  completeText: (request?: LlmCompleteRequest) => Promise<string>
  /**
   * Estimated token count of one text, using the Host token meter when mounted
   * and the character heuristic otherwise. Used for the prompt context budget.
   */
  estimateTokens: (text: string) => number
}

/** Host services the gateway reads lazily on every call. */
export interface LlmGatewayDeps {
  getLlm?: (() => unknown) | undefined
  getDefaultModel?: (() => unknown) | undefined
  getTokenMeter?: (() => unknown) | undefined
  logger?: Logger | undefined
  config?: { ai?: Partial<AiConfig> | undefined } | undefined
}

/** Clamp a finite integer into range, returning `fallback` for invalid input. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number
function clampInt(value: unknown, min: number, max: number, fallback: undefined): number | undefined
function clampInt(value: unknown, min: number, max: number, fallback?: number): number | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.min(max, Math.max(min, Math.floor(parsed)))
    return fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Clamp a finite number into range, returning `fallback` for invalid input. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number
function clampNumber(value: unknown, min: number, max: number, fallback: undefined): number | undefined
function clampNumber(value: unknown, min: number, max: number, fallback?: number): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Call a dependency getter safely (the Host service may be absent). */
function safeGet(getter: (() => unknown) | undefined): unknown {
  if (typeof getter !== 'function') return undefined
  try {
    return getter()
  } catch {
    return undefined
  }
}

/** Bounded, whitespace-collapsed error detail; never includes prompt text. */
function safeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}…` : text
}

/** Whether an error represents a consumer/turn abort rather than a model failure. */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal !== undefined && signal.aborted === true) return true
  if (error === null || typeof error !== 'object') return false
  const name = 'name' in error && typeof error.name === 'string' ? error.name : ''
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  return name === 'AbortError' || code === 'ABORT_ERR' || code === 'aborted'
}

/** Map any host stream failure onto the stable {@link AiError} taxonomy. */
function mapStreamFailure(error: unknown, signal: AbortSignal | undefined): AiError {
  if (error instanceof AiError) return error
  if (isAbort(error, signal)) return new AiError('aborted', CODE_MESSAGES.aborted)
  const message =
    error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error)
  return new AiError('llm-failed', CODE_MESSAGES['llm-failed'], message)
}

/** Normalize one host `usage` payload to `{ inputTokens, outputTokens }`. */
function normalizeUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  const usage = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  return {
    inputTokens: count(
      usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens,
    ),
    outputTokens: count(
      usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens,
    ),
  }
}

/** Normalize a finish reason (string or `{ kind }`) to `{ kind }`. */
function normalizeReason(reason: unknown): { kind: string } {
  if (typeof reason === 'string' && reason !== '') return { kind: reason }
  if (reason !== null && typeof reason === 'object') {
    const record = reason as Record<string, unknown>
    if (typeof record.kind === 'string' && record.kind !== '') return { kind: record.kind }
    if (typeof record.type === 'string' && record.type !== '') return { kind: record.type }
  }
  return { kind: 'stop' }
}

/** One normalized Host request message (`{ role, content:[{type:'text',text}] }`). */
interface HostRequestMessage {
  role: 'system' | 'user' | 'assistant'
  content: Array<{ type: 'text'; text: string }>
}

/** Normalize the caller's message list into the Host request shape. */
function normalizeMessages(messages: readonly (LlmMessageInput | AiChatMessage)[] | undefined): HostRequestMessage[] {
  if (!Array.isArray(messages)) return []
  const out: HostRequestMessage[] = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
    const content: Array<{ type: 'text'; text: string }> = []
    if (typeof message.content === 'string') {
      content.push({ type: 'text', text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') content.push({ type: 'text', text: part })
        else if (
          part !== null &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          content.push({ type: 'text', text: (part as { text: string }).text })
        }
      }
    }
    if (content.length > 0) out.push({ role, content })
  }
  return out
}

/** Narrow an unknown Host service value to the `llm` surface we consume. */
function asLlmService(value: unknown): LlmService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const stream = (value as { stream?: unknown }).stream
  return typeof stream === 'function' ? (value as LlmService) : undefined
}

/** Narrow an unknown Host service value to the default-model surface. */
function asDefaultModel(value: unknown): AgentDefaultModelService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return typeof (value as { currentSelection?: unknown }).currentSelection === 'function'
    ? (value as AgentDefaultModelService)
    : undefined
}

/** Narrow an unknown Host service value to the token-meter surface. */
function asTokenMeter(value: unknown): TokenMeterService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return typeof (value as { estimateMessage?: unknown }).estimateMessage === 'function'
    ? (value as TokenMeterService)
    : undefined
}

/** Extract `{ provider, model }` from any supported selection shape. */
function normalizeSelection(value: unknown): ModelSelection | null {
  let candidate: unknown = value
  const service = asDefaultModel(candidate)
  if (service !== undefined) {
    try {
      candidate = service.currentSelection()
    } catch {
      return null
    }
  }
  if (candidate === null || typeof candidate !== 'object') return null
  const record = candidate as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  return provider === '' || model === '' ? null : { provider, model }
}

/**
 * Create the model gateway.
 *
 * @param deps - host service getters, logger and the resolved plugin config.
 * @returns the gateway facade.
 */
export function createLlmGateway(deps: LlmGatewayDeps = {}): LlmGateway {
  const log = deps.logger ?? {}
  const config = deps.config

  /** The Host LLM service, read lazily on every call (`ctx.get('llm')`). */
  function llmService(): LlmService | undefined {
    return asLlmService(safeGet(deps.getLlm))
  }

  /** The Host token meter, read lazily on every call (`ctx.get('tokenMeter')`). */
  function tokenMeter(): TokenMeterService | undefined {
    return asTokenMeter(safeGet(deps.getTokenMeter))
  }

  /** Config override (`config.ai.provider` + `config.ai.model`); empty means default. */
  function configRoute(): ModelSelection | null {
    const ai = config !== undefined && config !== null ? config.ai : undefined
    if (ai === null || typeof ai !== 'object') return null
    const provider = typeof ai.provider === 'string' ? ai.provider.trim() : ''
    const model = typeof ai.model === 'string' ? ai.model.trim() : ''
    return provider === '' || model === '' ? null : { provider, model }
  }

  /** Resolved route: explicit config override first, then the agent default model. */
  function route(): ModelSelection | null {
    const override = configRoute()
    if (override !== null) return override
    return normalizeSelection(safeGet(deps.getDefaultModel))
  }

  /**
   * Reasoning effort for this call: per-request > `config.ai.reasoningEffort` >
   * `'low'`. The DeepSeek adapter's own default is `'high'`, which burns the
   * completion budget on reasoning tokens before any visible text — the wrong
   * trade-off for grounded reading calls (a real bug: empty answers at the
   * maxTokens cap). Reading/utility calls therefore always pin an effort.
   */
  function reasoningEffortFor(requested: string | undefined): string {
    if (typeof requested === 'string' && REASONING_EFFORTS.includes(requested)) return requested
    const ai = config !== undefined && config !== null ? config.ai : undefined
    if (
      ai !== null &&
      typeof ai === 'object' &&
      typeof ai.reasoningEffort === 'string' &&
      REASONING_EFFORTS.includes(ai.reasoningEffort)
    ) {
      return ai.reasoningEffort
    }
    return DEFAULT_REASONING_EFFORT
  }

  /** Estimated tokens of one text (Host token meter, or the char heuristic). */
  function estimateTokens(text: string): number {
    const value = typeof text === 'string' ? text : ''
    const meter = tokenMeter()
    if (meter !== undefined) {
      try {
        const estimate = meter.estimateMessage({
          role: 'user',
          content: [{ type: 'text', text: value }],
        })
        if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0) {
          return Math.ceil(estimate)
        }
      } catch {
        /* fall through to the heuristic: an estimator must never fail a call */
      }
    }
    return Math.ceil(value.length / FALLBACK_CHARS_PER_TOKEN)
  }

  /** Estimated prompt tokens of one request (system + user/assistant text). */
  function estimateRequestTokens(system: string, messages: readonly HostRequestMessage[]): number {
    let total = system === '' ? 0 : estimateTokens(system)
    for (const message of messages) {
      for (const part of message.content) total += estimateTokens(part.text)
    }
    return total
  }

  /** Whether a route and a streaming host service are both available. */
  function available(): boolean {
    if (route() === null) return false
    const service = llmService()
    return service !== undefined && typeof service.stream === 'function'
  }

  /**
   * Stream one completion.
   *
   * Yields `{ type:'delta', text }` for each text chunk, then
   * `{ type:'usage', usage }` when the host reports token usage and finally
   * `{ type:'finish', reason:{ kind } }`. Never throws for host/abort failures;
   * throws a stable {@link AiError} instead.
   *
   * @param request - completion request; `purpose` is for logging only.
   * @returns normalized stream chunks.
   */
  async function* streamText(request: LlmStreamRequest = {}): AsyncGenerator<AiStreamChunk> {
    const signal = request.signal
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      throw new AiError('aborted', CODE_MESSAGES.aborted)
    }
    const service = llmService()
    if (service === undefined || typeof service.stream !== 'function') {
      throw new AiError('llm-unavailable', CODE_MESSAGES['llm-unavailable'])
    }
    const resolved = route()
    if (resolved === null) {
      throw new AiError('llm-unavailable', '还没有配置可用的模型（No default model is configured）')
    }
    const messages = normalizeMessages(request.messages)
    if (messages.length === 0) {
      throw new AiError('bad-request', '缺少提示内容（Missing prompt messages）')
    }
    const system = typeof request.system === 'string' ? request.system : ''
    // Context budget: the prompts are already bounded by their own character
    // budgets; the estimator turns a pathological prompt into a stable error.
    if (estimateRequestTokens(system, messages) > MAX_PROMPT_TOKENS) {
      throw new AiError(
        'context-too-large',
        CODE_MESSAGES['context-too-large'],
        `estimated prompt exceeds ${MAX_PROMPT_TOKENS} tokens`,
      )
    }
    const options: Parameters<LlmService['stream']>[0] = {
      provider: resolved.provider,
      model: resolved.model,
      messages,
    }
    if (system !== '') options.system = system
    const maxTokens = clampInt(request.maxTokens, 1, MAX_OUTPUT_TOKENS, undefined)
    if (maxTokens !== undefined) options.maxTokens = maxTokens
    const temperature = clampNumber(request.temperature, 0, 2, undefined)
    if (temperature !== undefined) options.temperature = temperature
    options.reasoningEffort = reasoningEffortFor(request.reasoningEffort)
    if (signal !== undefined && signal !== null) options.signal = signal
    log.debug?.(
      '[dsh-litnotes] llm stream (%s/%s purpose=%s maxTokens=%s effort=%s)',
      resolved.provider,
      resolved.model,
      typeof request.purpose === 'string' ? request.purpose : 'chat',
      maxTokens ?? 'default',
      options.reasoningEffort,
    )

    let iterator: AsyncIterable<LlmStreamChunk> | Iterable<LlmStreamChunk>
    try {
      const result: unknown = service.stream(options)
      const awaited = result !== null && typeof result === 'object' && 'then' in result
        ? await (result as Promise<unknown>)
        : result
      if (
        awaited === null ||
        typeof awaited !== 'object' ||
        (typeof (awaited as AsyncIterable<LlmStreamChunk>)[Symbol.asyncIterator] !== 'function' &&
          typeof (awaited as Iterable<LlmStreamChunk>)[Symbol.iterator] !== 'function')
      ) {
        throw new AiError('llm-failed', CODE_MESSAGES['llm-failed'], 'host stream is not iterable')
      }
      iterator = awaited as AsyncIterable<LlmStreamChunk> | Iterable<LlmStreamChunk>
    } catch (error) {
      throw mapStreamFailure(error, signal)
    }

    let finish: { kind: string } | null = null
    let usage: { inputTokens: number; outputTokens: number } | null = null
    let collected = 0
    try {
      for await (const rawChunk of iterator) {
        if (signal !== undefined && signal !== null && signal.aborted === true) {
          throw new AiError('aborted', CODE_MESSAGES.aborted)
        }
        if (rawChunk === null || typeof rawChunk !== 'object') continue
        const chunk = rawChunk as LlmStreamChunk & Record<string, unknown>
        const type = typeof chunk.type === 'string' ? chunk.type : ''
        if (type === 'text-delta' || type === 'text') {
          const text =
            typeof chunk.text === 'string'
              ? chunk.text
              : typeof chunk.delta === 'string'
                ? chunk.delta
                : ''
          if (text === '') continue
          collected += text.length
          yield { type: 'delta', text }
          if (collected > MAX_STREAM_CHARS) {
            finish = { kind: 'length' }
            break
          }
          continue
        }
        if (type === 'usage') {
          usage = normalizeUsage(chunk.usage)
          continue
        }
        if (type === 'finish') {
          finish = normalizeReason(chunk.reason)
          if (chunk.usage !== undefined) usage = normalizeUsage(chunk.usage)
          break
        }
        if (type === 'error') {
          const failure: unknown =
            chunk.failure !== null && typeof chunk.failure === 'object'
              ? chunk.failure
              : (chunk as Record<string, unknown>)
          const failureMessage =
            failure !== null && typeof failure === 'object' && 'message' in failure
              ? failure.message
              : undefined
          throw new AiError('llm-failed', CODE_MESSAGES['llm-failed'], failureMessage)
        }
        // Unknown chunk types (block-start, reasoning, …) are ignored on purpose.
      }
    } catch (error) {
      throw mapStreamFailure(error, signal)
    }
    if (usage !== null) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish ?? { kind: 'stop' } }
  }

  /**
   * Collect one completion into a bounded string.
   *
   * @param request - the {@link streamText} request plus an optional cap.
   * @returns collected text (never longer than `maxChars`).
   * @throws {AiError} on an unavailable route, model failure or abort.
   */
  async function completeText(request: LlmCompleteRequest = {}): Promise<string> {
    const maxChars = clampInt(request.maxChars, 1, MAX_COMPLETE_CHARS, DEFAULT_COMPLETE_CHARS)
    const streamRequest: LlmStreamRequest = { ...request }
    delete (streamRequest as LlmCompleteRequest).maxChars
    const parts: string[] = []
    let total = 0
    for await (const chunk of streamText(streamRequest)) {
      if (chunk.type !== 'delta') continue
      const remaining = maxChars - total
      if (remaining <= 0) break
      const text = chunk.text.length > remaining ? chunk.text.slice(0, remaining) : chunk.text
      parts.push(text)
      total += text.length
      if (total >= maxChars) break
    }
    return parts.join('')
  }

  return { available, route, estimateTokens, streamText, completeText }
}
