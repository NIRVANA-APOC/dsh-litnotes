/**
 * Fake Host `llm` service for offline dsh-litnotes AI tests.
 *
 * The Host surface consumed by `src/host/ai/llm.ts` / `docs/AI-SPEC.md` §3:
 *
 *     const llm = ctx.get('llm')
 *     for await (const chunk of llm.stream({
 *       provider, model, system,
 *       messages: [{ role: 'user', content: [{ type: 'text', text: '…' }] }],
 *       maxTokens, temperature, signal,
 *     })) { … }
 *
 * StreamChunk shapes emitted by this fake:
 *   { type: 'text-delta', text: '…' }
 *   { type: 'usage', usage: { inputTokens, outputTokens } }        (optional)
 *   { type: 'finish', reason: { kind: 'stop' | 'length' | 'error' } }
 *
 * Scripts
 * -------
 * A script is one of:
 *   - string                    -> streamed as small `text-delta` chunks
 *   - array of StreamChunks     -> streamed verbatim
 *   - { text?, chunks?, chunkSize?, delayMs?, chunkDelayMs?, usage?,
 *       finish?: false, finishReason?, error?, errorAfterChunks? }
 *   - function(request, flat)   -> any of the above (may be async)
 *
 * Script resolution order for each call:
 *   1. persistent `match(matcher, script)` rules — first match wins;
 *      `matcher` is a substring of the flattened prompt, a RegExp, or a
 *      `(request, flat) => boolean` function.
 *   2. FIFO `queue(script)` entries (one call each).
 *   3. `defaultScript` / `defaultText` fallback.
 *   No script -> the stream throws loudly, so a missing script is a test bug,
 *   never a silent empty answer.
 *
 * Abort: `request.signal` is honoured between chunks and while waiting for
 * scripted delays; aborting rejects with an `AbortError`-named error.
 *
 * `calls` records every stream call (provider, model, system, flattened prompt,
 * maxTokens/temperature, status 'completed'|'aborted'|'errored').
 *
 * @module test/helpers/fake-llm
 */

/** Fenced block tags used by the model output contract (`docs/AI-SPEC.md` §5). */
export const ANSWER_FENCE = 'litnotes-json'
export const GRAPH_FENCE = 'litnotes-graph'
export const SUMMARY_FENCE = 'litnotes-summary'
export const ENTAILMENT_FENCE = 'litnotes-entailment'

const DEFAULT_CHUNK_SIZE = 24

// ---------------------------------------------------------------------------
// Text / fence helpers
// ---------------------------------------------------------------------------

/** Build a fenced JSON block exactly as the model is instructed to emit it. */
export function jsonFence(payload: unknown, tag: string = ANSWER_FENCE): string {
  return `\`\`\`${tag}\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

/** Split text into scripted `text-delta` chunks. */
export function textDeltaChunks(
  text: string,
  options: { size?: number } = {},
): Array<{ type: 'text-delta'; text: string }> {
  const size = Number.isInteger(options.size) && (options.size as number) > 0 ? (options.size as number) : DEFAULT_CHUNK_SIZE
  const source = typeof text === 'string' ? text : String(text ?? '')
  const chunks: Array<{ type: 'text-delta'; text: string }> = []
  for (let index = 0; index < source.length; index += size) {
    chunks.push({ type: 'text-delta', text: source.slice(index, index + size) })
  }
  return chunks
}

/** One model citation in the output contract. */
export interface FakeCitation {
  index?: number
  blockKey?: string
  quote?: string
  aspect?: string
  note?: string
}

/** Grounded chat answer: markdown with `[n]` markers + the trailing JSON fence. */
export interface FakeAnswerInput {
  markdown?: string
  citations?: readonly FakeCitation[] | undefined
  knowledge?: unknown
  followups?: readonly string[] | undefined
  includeFence?: boolean
}

/** Grounded chat answer: markdown with `[n]` citation markers followed by the trailing JSON fence. */
export function litnotesAnswerText(answer: FakeAnswerInput = {}): string {
  const markdown = answer.markdown ?? ''
  const citations = answer.citations ?? []
  const followups = answer.followups ?? []
  const includeFence = answer.includeFence !== false
  const parts: string[] = []
  const body = String(markdown).trimEnd()
  if (body !== '') parts.push(body)
  if (includeFence) {
    const payload: Record<string, unknown> = { citations }
    if (answer.knowledge !== undefined) payload.knowledge = answer.knowledge
    if (Array.isArray(followups) && followups.length > 0) payload.followups = followups
    parts.push(jsonFence(payload, ANSWER_FENCE))
  }
  return `${parts.join('\n\n')}\n`
}

/** Graph-extraction model output: a ```litnotes-graph fence. */
export function graphExtractionText(
  extraction: { nodes?: readonly unknown[]; edges?: readonly unknown[] } = {},
): string {
  return `${jsonFence({ nodes: extraction.nodes ?? [], edges: extraction.edges ?? [] }, GRAPH_FENCE)}\n`
}

/** Graph summary model output: a ```litnotes-summary fence. */
export function summaryText(
  summary: { overview?: string; tldr?: readonly string[]; glossary?: readonly unknown[] } = {},
): string {
  return `${jsonFence(
    {
      overview: summary.overview ?? '',
      tldr: summary.tldr ?? [],
      glossary: summary.glossary ?? [],
    },
    SUMMARY_FENCE,
  )}\n`
}

/** Citation–claim entailment model output: a ```litnotes-entailment fence. */
export function entailmentText(
  results: ReadonlyArray<{ index?: number; verdict?: string; reason?: string }> = [],
): string {
  const normalized = results.map((entry) => ({
    index: entry.index,
    verdict: entry.verdict,
    reason: entry.reason ?? '',
  }))
  return `${jsonFence({ results: normalized }, ENTAILMENT_FENCE)}\n`
}

/** AI 精读 fence tags (`docs/AI-SPEC.md` §5.3). */
export const DEEPREAD_MAP_FENCE = 'litnotes-deepread-map'
export const DEEPREAD_FENCE = 'litnotes-deepread'
export const DEEPREAD_JUDGE_FENCE = 'litnotes-deepread-judge'
export const DEEPREAD_REPORT_FENCE = 'litnotes-deepread-report'

/** Reading-map model output: a ```litnotes-deepread-map fence. */
export function deepReadMapText(payload: Record<string, unknown> = {}): string {
  return `${jsonFence(payload, DEEPREAD_MAP_FENCE)}\n`
}

/** Section/gap close-reading model output: a ```litnotes-deepread fence. */
export function deepReadSectionText(
  payload: {
    role?: string
    summary?: string
    annotations?: readonly unknown[]
    points?: readonly unknown[]
  } = {},
): string {
  return `${jsonFence(
    {
      role: payload.role ?? 'other',
      summary: payload.summary ?? '',
      annotations: payload.annotations ?? [],
      points: payload.points ?? [],
    },
    DEEPREAD_FENCE,
  )}\n`
}

/** Annotation adjudication model output: a ```litnotes-deepread-judge fence. */
export function deepReadJudgeText(
  results: ReadonlyArray<{ id?: number; score?: number; reason?: string }> = [],
): string {
  return `${jsonFence(
    {
      results: results.map((entry) => ({
        id: entry.id,
        score: entry.score,
        reason: entry.reason ?? '',
      })),
    },
    DEEPREAD_JUDGE_FENCE,
  )}\n`
}

/** Report synthesis model output: a ```litnotes-deepread-report fence. */
export function deepReadReportText(payload: Record<string, unknown> = {}): string {
  return `${jsonFence(payload, DEEPREAD_REPORT_FENCE)}\n`
}

/** A ready-made `agentDefaultModel` fake: exposes `currentSelection()`. */
export interface FakeDefaultModel {
  current: { provider: string; model: string }
  currentSelection: () => { provider: string; model: string }
}

/** A ready-made `agentDefaultModel` fake (`ctx.get('agentDefaultModel')`). */
export function createFakeDefaultModel(
  selection: { provider?: string; model?: string } = {},
): FakeDefaultModel {
  const current = {
    provider: selection.provider ?? 'fake-provider',
    model: selection.model ?? 'fake-model',
  }
  return {
    current,
    currentSelection(): { provider: string; model: string } {
      return { ...current }
    },
  }
}

// ---------------------------------------------------------------------------
// Fake host llm service
// ---------------------------------------------------------------------------

/** One raw Host stream chunk (only the shapes the fake can emit). */
export type FakeStreamChunk =
  | { type: 'text-delta'; text: string; index?: number }
  | { type: 'text'; text: string }
  | { type: 'delta'; delta: string }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'finish'; reason: { kind: string; failure?: unknown } }
  | { type: 'error'; failure?: { message?: string; code?: string } }
  | { type: string; [key: string]: unknown }

/** A scripted usage payload. */
export interface FakeUsage {
  inputTokens?: number
  outputTokens?: number
}

/** Object-form fake script. */
export interface FakeScriptObject {
  text?: string
  chunks?: readonly FakeStreamChunk[]
  chunkSize?: number
  delayMs?: number
  chunkDelayMs?: number
  usage?: FakeUsage
  finish?: boolean
  finishReason?: { kind: string } | string
  error?: unknown
  errorAfterChunks?: number
}

/** One model request the fake accepts (only fields it inspects). */
export interface FakeLlmRequest {
  provider?: string
  model?: string
  system?: string
  messages?: ReadonlyArray<{
    role?: string
    content?: string | ReadonlyArray<string | { type?: unknown; text?: unknown }>
  }>
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  purpose?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** Flattened request view handed to matcher functions/scripts. */
export interface FlatLlmRequest {
  system: string
  messages: FakeLlmRequest['messages']
  userText: string
  prompt: string
}

/** A script: string, chunk list, object or (async) factory. */
export type FakeLlmScript =
  | string
  | readonly FakeStreamChunk[]
  | FakeScriptObject
  | ((request: FakeLlmRequest, flat: FlatLlmRequest) => FakeLlmScript | Promise<FakeLlmScript>)

/** Persistent match rule. */
export interface FakeLlmMatchRule {
  matcher: string | RegExp | ((request: FakeLlmRequest, flat: FlatLlmRequest) => boolean)
  script: FakeLlmScript
  once: boolean
}

/** One recorded `llm.stream` call. */
export interface FakeLlmCall {
  provider: string | undefined
  model: string | undefined
  system: string
  prompt: string
  messages: FakeLlmRequest['messages']
  maxTokens: number | undefined
  temperature: number | undefined
  reasoningEffort: string | undefined
  purpose: string | undefined
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'aborted' | 'errored'
  error?: string
  matchedBy?: 'rule' | 'queue' | 'default'
}

/** The fake Host `llm` service facade used by the engine tests. */
export interface FakeLlm {
  name: string
  calls: FakeLlmCall[]
  queue: (script: FakeLlmScript) => FakeLlm
  queueAnswer: (answer: FakeScriptObject & FakeAnswerInput) => FakeLlm
  match: (
    matcher: FakeLlmMatchRule['matcher'],
    script: FakeLlmScript,
    options?: { once?: boolean },
  ) => FakeLlm
  setDefault: (script: FakeLlmScript) => FakeLlm
  reset: () => FakeLlm
  callCount: () => number
  lastCall: () => FakeLlmCall | undefined
  lastPrompt: () => string
  callsMatching: (needle: string) => FakeLlmCall[]
  lastCallMatching: (needle: string) => FakeLlmCall | undefined
  stream: (request?: FakeLlmRequest) => AsyncGenerator<FakeStreamChunk>
}

/** Options accepted by {@link createFakeLlm}. */
export interface FakeLlmOptions {
  defaultScript?: FakeLlmScript
  defaultText?: string
  chunkSize?: number
  name?: string
}

/** Normalize a thrown/scripted error into an Error instance. */
function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value
  if (value !== null && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    const error = new Error(value.message)
    if ('code' in value && typeof value.code === 'string') (error as Error & { code: string }).code = value.code
    if ('name' in value && typeof value.name === 'string') error.name = value.name
    return error
  }
  return new Error(typeof value === 'string' && value !== '' ? value : fallbackMessage)
}

/** Build an abort error matching the host/consumer convention. */
function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  ;(error as Error & { code: string }).code = 'ABORT_ERR'
  return error
}

/** Abort-aware sleep. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const cleanup = (): void => signal?.removeEventListener?.('abort', onAbort)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Concatenate the text content of one llm.stream request. */
export function flattenLlmRequest(request: FakeLlmRequest = {}): FlatLlmRequest {
  const system = typeof request.system === 'string' ? request.system : ''
  const texts: string[] = []
  const messages = Array.isArray(request.messages) ? request.messages : []
  for (const message of messages) {
    const content = message?.content
    if (typeof content === 'string') {
      texts.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') texts.push(part)
        else if (part !== null && typeof part === 'object' && typeof part.text === 'string') texts.push(part.text)
      }
    }
  }
  return {
    system,
    messages,
    userText: texts.join('\n'),
    prompt: [system, ...texts].filter((part) => part !== '').join('\n\n'),
  }
}

/** Normalized script shape the generator consumes. */
interface NormalizedScript {
  chunks: FakeStreamChunk[]
  delayMs?: number
  chunkDelayMs?: number
  usage?: FakeUsage
  finish?: boolean
  finishReason?: { kind: string } | string
  error?: unknown
  errorAfterChunks?: number
}

/** Normalize one script into the generator's normalized shape. */
function normalizeScript(script: FakeLlmScript, chunkSize: number = DEFAULT_CHUNK_SIZE): NormalizedScript {
  if (typeof script === 'string') return { chunks: textDeltaChunks(script, { size: chunkSize }) }
  if (Array.isArray(script)) {
    const chunks = (script as readonly FakeStreamChunk[]).map((chunk) => ({ ...chunk }))
    return { chunks }
  }
  if (script === null || typeof script !== 'object') {
    throw new TypeError('fake-llm: script must be a string, chunk array, object or function')
  }
  const object = script as FakeScriptObject
  if (Array.isArray(object.chunks)) {
    const chunks = (object.chunks as readonly FakeStreamChunk[]).map((chunk) => ({ ...chunk }))
    return { ...object, chunks }
  }
  if (typeof object.text === 'string') {
    return { ...object, chunks: textDeltaChunks(object.text, { size: object.chunkSize ?? chunkSize }) }
  }
  return { ...object, chunks: [] }
}

/**
 * Create one fake Host `llm` service.
 *
 * @param options - default script/text, chunk size and display name.
 * @returns the fake service plus script/call helpers.
 */
export function createFakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  const calls: FakeLlmCall[] = []
  const queue: FakeLlmScript[] = []
  const rules: FakeLlmMatchRule[] = []
  const chunkSize =
    Number.isInteger(options.chunkSize) && (options.chunkSize as number) > 0
      ? (options.chunkSize as number)
      : DEFAULT_CHUNK_SIZE
  let defaultScript: FakeLlmScript | undefined = options.defaultScript
  if (defaultScript === undefined && options.defaultText !== undefined) {
    defaultScript = { text: options.defaultText }
  }

  /** Flatten + record one request; returns the record mutated on completion. */
  function beginCall(request: FakeLlmRequest): FakeLlmCall {
    const flat = flattenLlmRequest(request)
    const record: FakeLlmCall = {
      provider: typeof request.provider === 'string' ? request.provider : undefined,
      model: typeof request.model === 'string' ? request.model : undefined,
      system: flat.system,
      prompt: flat.prompt,
      messages: flat.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      reasoningEffort: request.reasoningEffort,
      purpose: request.purpose,
      startedAt: new Date().toISOString(),
      status: 'running',
    }
    calls.push(record)
    return record
  }

  /** Find the script for this request. */
  function resolveScript(
    request: FakeLlmRequest,
    flat: FlatLlmRequest,
  ): { script: FakeLlmScript | undefined; matchedBy: 'rule' | 'queue' | 'default' | 'none' } {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
      if (rule === undefined) continue
      let matched = false
      if (typeof rule.matcher === 'function') matched = Boolean(rule.matcher(request, flat))
      else if (rule.matcher instanceof RegExp) matched = rule.matcher.test(flat.prompt)
      else matched = flat.prompt.includes(String(rule.matcher))
      if (!matched) continue
      if (rule.once) rules.splice(index, 1)
      return { script: rule.script, matchedBy: 'rule' }
    }
    if (queue.length > 0) return { script: queue.shift(), matchedBy: 'queue' }
    if (defaultScript !== undefined) return { script: defaultScript, matchedBy: 'default' }
    return { script: undefined, matchedBy: 'none' }
  }

  /** Async-generator implementation behind `stream`. */
  async function* streamImpl(request: FakeLlmRequest = {}): AsyncGenerator<FakeStreamChunk> {
    const flat = flattenLlmRequest(request)
    const record = beginCall(request)
    const signal = request.signal
    try {
      if (signal?.aborted) throw abortError()
      const resolved = resolveScript(request, flat)
      if (resolved.script === undefined) {
        throw new Error(`fake-llm: no script for request (prompt starts: ${flat.prompt.slice(0, 120)})`)
      }
      let raw: FakeLlmScript | Awaited<ReturnType<Extract<FakeLlmScript, (...args: never[]) => unknown>>>
      raw = resolved.script
      if (typeof raw === 'function') raw = await (raw as (request: FakeLlmRequest, flat: FlatLlmRequest) => FakeLlmScript | Promise<FakeLlmScript>)(request, flat)
      const script = normalizeScript(raw as FakeLlmScript, chunkSize)
      if (resolved.matchedBy !== 'none') record.matchedBy = resolved.matchedBy
      if (typeof script.delayMs === 'number' && script.delayMs > 0) await sleep(script.delayMs, signal)
      if (script.error !== undefined && !((script.errorAfterChunks ?? 0) > 0)) {
        throw toError(script.error, 'fake-llm scripted failure')
      }
      for (let index = 0; index < script.chunks.length; index += 1) {
        if (signal?.aborted) throw abortError()
        if (typeof script.chunkDelayMs === 'number' && script.chunkDelayMs > 0) {
          await sleep(script.chunkDelayMs, signal)
        }
        const chunk = script.chunks[index]
        if (chunk !== undefined) yield chunk
        if (typeof script.errorAfterChunks === 'number' && index + 1 >= script.errorAfterChunks) {
          throw toError(script.error, 'fake-llm scripted failure after chunks')
        }
      }
      if (script.usage !== undefined) {
        yield { type: 'usage', usage: { ...script.usage } }
      }
      if (script.finish !== false) {
        yield {
          type: 'finish',
          reason: script.finishReason !== undefined && typeof script.finishReason === 'object'
            ? script.finishReason
            : { kind: typeof script.finishReason === 'string' ? script.finishReason : 'stop' },
        }
      }
      record.status = 'completed'
    } catch (error) {
      record.status = signal?.aborted || (error as { name?: string })?.name === 'AbortError' ? 'aborted' : 'errored'
      record.error = (error as Error)?.message ?? String(error)
      throw error
    } finally {
      record.finishedAt = new Date().toISOString()
      if (record.status === 'running') record.status = signal?.aborted ? 'aborted' : 'completed'
    }
  }

  const llm: FakeLlm = {
    name: options.name ?? 'fake-llm',
    calls,
    /** Queue one script for the next unmatched call (FIFO). */
    queue(script: FakeLlmScript): FakeLlm {
      queue.push(script)
      return llm
    },
    /** Convenience: queue a grounded answer built from {@link litnotesAnswerText}. */
    queueAnswer(answer: FakeScriptObject & FakeAnswerInput): FakeLlm {
      queue.push({ text: litnotesAnswerText(answer) })
      return llm
    },
    /** Persistently answer any request whose prompt matches `matcher`. */
    match(
      matcher: FakeLlmMatchRule['matcher'],
      script: FakeLlmScript,
      matchOptions: { once?: boolean } = {},
    ): FakeLlm {
      rules.push({ matcher, script, once: matchOptions.once === true })
      return llm
    },
    /** Fallback script used when no rule/queue entry matches. */
    setDefault(script: FakeLlmScript): FakeLlm {
      defaultScript = script
      return llm
    },
    reset(): FakeLlm {
      calls.length = 0
      queue.length = 0
      rules.length = 0
      defaultScript = options.defaultScript
      if (defaultScript === undefined && options.defaultText !== undefined) {
        defaultScript = { text: options.defaultText }
      }
      return llm
    },
    callCount(): number {
      return calls.length
    },
    lastCall(): FakeLlmCall | undefined {
      return calls.length > 0 ? calls[calls.length - 1] : undefined
    },
    lastPrompt(): string {
      return calls.length > 0 ? (calls[calls.length - 1]?.prompt ?? '') : ''
    },
    /** Recorded calls whose flattened system+prompt contains `needle` (in call order). */
    callsMatching(needle: string): FakeLlmCall[] {
      return calls.filter((call) => `${call.system}\n${call.prompt}`.includes(String(needle)))
    },
    /** Last recorded call matching `needle`, or `undefined`. */
    lastCallMatching(needle: string): FakeLlmCall | undefined {
      const matches = llm.callsMatching(needle)
      return matches.length > 0 ? matches[matches.length - 1] : undefined
    },
    stream(request: FakeLlmRequest = {}): AsyncGenerator<FakeStreamChunk> {
      return streamImpl(request)
    },
  }
  return llm
}
