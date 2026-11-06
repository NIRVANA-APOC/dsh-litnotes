/**
 * Model gateway over the Host `llm` service for dsh-litnotes.
 *
 * The host exposes an optional LLM service and a default model selection:
 *
 *     const llm = ctx.get('llm')                                  // { stream(options) }
 *     const selection = ctx.get('agentDefaultModel')?.currentSelection()
 *     // → { provider, model, reasoningEffort? }
 *
 * The gateway hides those optional dependencies behind one small async API:
 * a route resolved from config override or the agent default, a normalized
 * delta/usage/finish stream, a bounded one-shot completion and a stable
 * {@link AiError} taxonomy. No prompt text or user data is logged here; only
 * provider/model, sizes and the safe part of an error message are recorded.
 *
 * Host stream chunks consumed (docs/AI-SPEC.md §3, test/helpers/fake-llm.mjs):
 *
 *     { type: 'text-delta', text: '…' }
 *     { type: 'usage', usage: { inputTokens, outputTokens } }
 *     { type: 'finish', reason: { kind: 'stop'|'length'|'error' } }
 *
 * @module lib/ai/llm
 */

/** Error codes emitted by the AI engine (plus host/retrieval codes passed through). */
export const AI_ERROR_CODES = Object.freeze([
  'llm-unavailable',
  'llm-failed',
  'context-too-large',
  'aborted',
  'bad-request',
])

/** Hard cap on output tokens requested from the host. */
const MAX_OUTPUT_TOKENS = 8192
/** Hard cap on a single collected completion (characters). */
const MAX_COMPLETE_CHARS = 400000
/** Default bounded completion size (characters). */
const DEFAULT_COMPLETE_CHARS = 120000
/** Hard cap on one streamed completion; beyond it the stream stops with `length`. */
const MAX_STREAM_CHARS = 800000
/** Safe-error detail cap. */
const DETAIL_MAX_CHARS = 300

/** Friendly UI-safe message per code (English + Chinese, no internals). */
const CODE_MESSAGES = Object.freeze({
  'llm-unavailable': '语言模型服务不可用（LLM service unavailable）',
  'llm-failed': '模型调用失败（LLM request failed）',
  'context-too-large': '上下文超出模型限制（Context is too large）',
  aborted: '已停止（Aborted）',
  'bad-request': '请求无效（Invalid request）',
})

/**
 * Structured AI failure. `code` is stable for the UI and the agent tools;
 * `detail` holds an optional bounded, non-sensitive diagnostic.
 */
export class AiError extends Error {
  /**
   * @param {string} code - one of {@link AI_ERROR_CODES} (unknown codes are kept).
   * @param {string} [message] - user-facing message.
   * @param {unknown} [detail] - bounded diagnostic detail.
   */
  constructor(code, message, detail) {
    const normalizedCode = typeof code === 'string' && code !== '' ? code : 'llm-failed'
    super(
      typeof message === 'string' && message !== ''
        ? message
        : CODE_MESSAGES[normalizedCode] ?? CODE_MESSAGES['llm-failed'],
    )
    this.name = 'AiError'
    this.code = normalizedCode
    if (detail !== undefined) this.detail = detail
  }
}

/** Clamp a finite integer into range, returning `fallback` for invalid input. */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.min(max, Math.max(min, Math.floor(parsed)))
    }
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Clamp a finite number into range, returning `fallback` for invalid input. */
function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Call a zero-arg dependency getter safely (the host service may be absent). */
function safeGet(getter) {
  if (typeof getter !== 'function') return undefined
  try {
    return getter()
  } catch {
    return undefined
  }
}

/** Bounded, whitespace-collapsed error detail; never includes prompt text. */
function safeDetail(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}…` : text
}

/** Whether an error represents a consumer/turn abort rather than a model failure. */
function isAbort(error, signal) {
  if (signal !== undefined && signal !== null && signal.aborted === true) return true
  const name = typeof error?.name === 'string' ? error.name : ''
  const code = typeof error?.code === 'string' ? error.code : ''
  return name === 'AbortError' || code === 'ABORT_ERR'
}

/** Map any host stream failure onto the stable AiError taxonomy. */
function mapStreamFailure(error, signal) {
  if (error instanceof AiError) return error
  if (isAbort(error, signal)) return new AiError('aborted', CODE_MESSAGES.aborted)
  return new AiError('llm-failed', CODE_MESSAGES['llm-failed'], safeDetail(error?.message ?? String(error)))
}

/** Normalize one host `usage` payload to `{ inputTokens, outputTokens }`. */
function normalizeUsage(raw) {
  const usage = raw !== null && typeof raw === 'object' ? raw : {}
  const count = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  const input = count(
    usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens,
  )
  const output = count(
    usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens,
  )
  return { inputTokens: input, outputTokens: output }
}

/** Normalize a finish reason (string or `{ kind }`) to `{ kind }`. */
function normalizeReason(reason) {
  if (typeof reason === 'string' && reason !== '') return { kind: reason }
  if (reason !== null && typeof reason === 'object') {
    if (typeof reason.kind === 'string' && reason.kind !== '') return { kind: reason.kind }
    if (typeof reason.type === 'string' && reason.type !== '') return { kind: reason.type }
  }
  return { kind: 'stop' }
}

/** Normalize the caller's message list into the Host `{ role, content:[…] }` shape. */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
    const content = []
    if (typeof message.content === 'string') {
      content.push({ type: 'text', text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') content.push({ type: 'text', text: part })
        else if (part !== null && typeof part === 'object' && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text })
        }
      }
    }
    if (content.length > 0) out.push({ role, content })
  }
  return out
}

/**
 * Create the model gateway.
 *
 * @param {{
 *   getLlm?: () => ({ stream?: Function } | undefined),
 *   getDefaultModel?: (() => unknown) | ({ currentSelection?: Function } | undefined),
 *   logger?: { debug?: Function, warn?: Function, error?: Function },
 *   config?: { ai?: { provider?: string, model?: string } },
 * }} [options] - host service getters, logger and resolved plugin config.
 * @returns {{
 *   available(): boolean,
 *   route(): { provider: string, model: string } | null,
 *   streamText(request: object): AsyncGenerator<object>,
 *   completeText(request: object): Promise<string>,
 * }} the gateway facade.
 */
export function createLlmGateway({ getLlm, getDefaultModel, logger, config } = {}) {
  const log = logger ?? {}

  /** The Host LLM service, read lazily on every call (`ctx.get('llm')`). */
  function llmService() {
    const service = safeGet(getLlm)
    return service !== null && typeof service === 'object' ? service : undefined
  }

  /**
   * Extract `{ provider, model }` from any supported default-selection shape:
   * a selection object, an agentDefaultModel service with `currentSelection()`,
   * or a getter function returning either.
   */
  function normalizeSelection(value) {
    let candidate = value
    if (candidate !== null && typeof candidate === 'object' && typeof candidate.currentSelection === 'function') {
      try {
        candidate = candidate.currentSelection()
      } catch {
        return null
      }
    }
    if (candidate === null || typeof candidate !== 'object') return null
    const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
    const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
    return provider === '' || model === '' ? null : { provider, model }
  }

  /** Config override (`config.ai.provider` + `config.ai.model`); empty means default. */
  function configRoute() {
    const ai = config !== null && typeof config === 'object' ? config.ai : undefined
    if (ai === null || typeof ai !== 'object') return null
    const provider = typeof ai.provider === 'string' ? ai.provider.trim() : ''
    const model = typeof ai.model === 'string' ? ai.model.trim() : ''
    return provider === '' || model === '' ? null : { provider, model }
  }

  /** Resolved route: explicit config override first, then the agent default model. */
  function route() {
    const override = configRoute()
    if (override !== null) return override
    return normalizeSelection(safeGet(getDefaultModel))
  }

  /** Whether a route and a streaming host service are both available. */
  function available() {
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
   * @param {{
   *   system?: string,
   *   messages?: Array<{ role?: string, content?: string | object[] }>,
   *   signal?: AbortSignal,
   *   maxTokens?: number,
   *   temperature?: number,
   *   purpose?: string,
   *   maxChars?: number,
   * }} [request] - completion request; `purpose` is for logging only.
   * @returns {AsyncGenerator<object>} normalized stream chunks.
   */
  async function* streamText(request = {}) {
    const signal = request?.signal
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
    const messages = normalizeMessages(request?.messages)
    if (messages.length === 0) {
      throw new AiError('bad-request', '缺少提示内容（Missing prompt messages）')
    }
    const options = {
      provider: resolved.provider,
      model: resolved.model,
      messages,
    }
    if (typeof request?.system === 'string' && request.system !== '') options.system = request.system
    const maxTokens = clampInt(request?.maxTokens, 1, MAX_OUTPUT_TOKENS, undefined)
    if (maxTokens !== undefined) options.maxTokens = maxTokens
    const temperature = clampNumber(request?.temperature, 0, 2, undefined)
    if (temperature !== undefined) options.temperature = temperature
    if (signal !== undefined && signal !== null) options.signal = signal
    log.debug?.(
      '[dsh-litnotes] llm stream (%s/%s purpose=%s maxTokens=%s)',
      resolved.provider,
      resolved.model,
      typeof request?.purpose === 'string' ? request.purpose : 'chat',
      maxTokens ?? 'default',
    )

    let iterator
    try {
      iterator = service.stream(options)
      // The host may return the async iterable directly or through a promise.
      if (iterator !== null && typeof iterator === 'object' && typeof iterator.then === 'function') {
        iterator = await iterator
      }
      if (iterator === null || typeof iterator !== 'object'
        || (typeof iterator[Symbol.asyncIterator] !== 'function'
          && typeof iterator[Symbol.iterator] !== 'function')) {
        throw new AiError('llm-failed', CODE_MESSAGES['llm-failed'], 'host stream is not iterable')
      }
    } catch (error) {
      throw mapStreamFailure(error, signal)
    }

    /** @type {{ kind: string } | null} */
    let finish = null
    /** @type {{ inputTokens: number, outputTokens: number } | null} */
    let usage = null
    let collected = 0
    try {
      for await (const chunk of iterator) {
        if (signal !== undefined && signal !== null && signal.aborted === true) {
          throw new AiError('aborted', CODE_MESSAGES.aborted)
        }
        if (chunk === null || typeof chunk !== 'object') continue
        const type = typeof chunk.type === 'string' ? chunk.type : ''
        if (type === 'text-delta' || type === 'text') {
          const text = typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta === 'string' ? chunk.delta : ''
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
          throw new AiError(
            'llm-failed',
            CODE_MESSAGES['llm-failed'],
            safeDetail(chunk.message ?? chunk.error ?? chunk.detail),
          )
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
   * @param {{ maxChars?: number, signal?: AbortSignal, [key: string]: unknown }} [request]
   *   the {@link streamText} request plus an optional collection cap.
   * @returns {Promise<string>} collected text (never longer than `maxChars`).
   * @throws {AiError} on unavailable route, model failure or abort.
   */
  async function completeText(request = {}) {
    const maxChars = clampInt(request?.maxChars, 1, MAX_COMPLETE_CHARS, DEFAULT_COMPLETE_CHARS)
    const parts = []
    let total = 0
    const streamRequest = { ...request }
    delete streamRequest.maxChars
    for await (const chunk of streamText(streamRequest)) {
      if (chunk?.type !== 'delta' || typeof chunk.text !== 'string') continue
      const remaining = maxChars - total
      if (remaining <= 0) break
      const text = chunk.text.length > remaining ? chunk.text.slice(0, remaining) : chunk.text
      parts.push(text)
      total += text.length
      if (total >= maxChars) break
    }
    return parts.join('')
  }

  return { available, route, streamText, completeText }
}
