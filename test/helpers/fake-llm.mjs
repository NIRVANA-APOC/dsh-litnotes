/**
 * Fake Host `llm` service for offline dsh-litnotes AI tests.
 *
 * The Host surface consumed by `lib/ai/llm.js` (see docs/AI-SPEC.md §3):
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
 * Usage:
 *   const llm = createFakeLlm()
 *   llm.queueAnswer({ markdown: 'Answer [1]', citations: [...] })
 *   const ctx = createFakeCtx({ get: { llm, agentDefaultModel: fakeDefaultModel() } })
 *
 * Abort: `request.signal` is honoured between chunks and while waiting for
 * scripted delays; aborting rejects with an `AbortError`-named error.
 *
 * `calls` records every stream call (provider, model, system, flattened prompt,
 * maxTokens/temperature, status 'completed'|'aborted'|'errored').
 */

/** Fenced block tags used by the model output contract (docs/AI-SPEC.md §5). */
export const ANSWER_FENCE = 'litnotes-json'
export const GRAPH_FENCE = 'litnotes-graph'
export const SUMMARY_FENCE = 'litnotes-summary'

const DEFAULT_CHUNK_SIZE = 24

/* ------------------------------------------------------------------ */
/* Text / fence helpers                                                */
/* ------------------------------------------------------------------ */

/** Build a fenced JSON block exactly as the model is instructed to emit it. */
export function jsonFence(payload, tag = ANSWER_FENCE) {
  return `\`\`\`${tag}\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

/**
 * Split text into scripted `text-delta` chunks.
 * @param {string} text
 * @param {{ size?: number }} [options]
 * @returns {{ type: 'text-delta', text: string }[]}
 */
export function textDeltaChunks(text, options = {}) {
  const size = Number.isInteger(options.size) && options.size > 0 ? options.size : DEFAULT_CHUNK_SIZE
  const source = typeof text === 'string' ? text : String(text ?? '')
  const chunks = []
  for (let index = 0; index < source.length; index += size) {
    chunks.push({ type: 'text-delta', text: source.slice(index, index + size) })
  }
  return chunks
}

/**
 * Grounded chat answer: markdown with `[n]` citation markers followed by the
 * trailing ```litnotes-json fence (citations/knowledge/followups).
 *
 * @param {{
 *   markdown?: string,
 *   citations?: object[],
 *   knowledge?: { nodes?: object[], edges?: object[] },
 *   followups?: string[],
 *   includeFence?: boolean,
 * }} [answer]
 * @returns {string} the complete model output text
 */
export function litnotesAnswerText(answer = {}) {
  const { markdown = '', citations = [], knowledge, followups = [], includeFence = true } = answer
  const parts = []
  const body = String(markdown ?? '').trimEnd()
  if (body !== '') parts.push(body)
  if (includeFence) {
    /** @type {Record<string, unknown>} */
    const payload = { citations }
    if (knowledge !== undefined) payload.knowledge = knowledge
    if (Array.isArray(followups) && followups.length > 0) payload.followups = followups
    parts.push(jsonFence(payload, ANSWER_FENCE))
  }
  return `${parts.join('\n\n')}\n`
}

/**
 * Graph-extraction model output: a ```litnotes-graph fence.
 * @param {{ nodes?: object[], edges?: object[] }} [extraction]
 */
export function graphExtractionText(extraction = {}) {
  return `${jsonFence({ nodes: extraction.nodes ?? [], edges: extraction.edges ?? [] }, GRAPH_FENCE)}\n`
}

/**
 * Graph summary model output: a ```litnotes-summary fence.
 * @param {{ overview?: string, tldr?: string[], glossary?: object[] }} [summary]
 */
export function summaryText(summary = {}) {
  return `${jsonFence(
    {
      overview: summary.overview ?? '',
      tldr: summary.tldr ?? [],
      glossary: summary.glossary ?? [],
    },
    SUMMARY_FENCE,
  )}\n`
}

/**
 * A ready-made `agentDefaultModel` fake: `ctx.get('agentDefaultModel')` is
 * expected to expose `currentSelection()` (AI-SPEC §3).
 * @param {{ provider?: string, model?: string }} [selection]
 */
export function createFakeDefaultModel(selection = {}) {
  const current = { provider: selection.provider ?? 'fake-provider', model: selection.model ?? 'fake-model' }
  return {
    current,
    currentSelection() {
      return { ...current }
    },
  }
}

/* ------------------------------------------------------------------ */
/* Fake host llm service                                               */
/* ------------------------------------------------------------------ */

/** Normalize a thrown/scripted error into an Error instance. */
function toError(value, fallbackMessage) {
  if (value instanceof Error) return value
  if (value && typeof value === 'object' && typeof value.message === 'string') {
    const error = new Error(value.message)
    if (typeof value.code === 'string') error.code = value.code
    if (typeof value.name === 'string') error.name = value.name
    return error
  }
  return new Error(typeof value === 'string' && value !== '' ? value : fallbackMessage)
}

/** Whether a thrown error represents an aborted consumer. */
function abortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** Abort-aware sleep. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Concatenate the text content of one llm.stream request. */
export function flattenLlmRequest(request = {}) {
  const system = typeof request.system === 'string' ? request.system : ''
  const texts = []
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
        else if (part && typeof part.text === 'string') texts.push(part.text)
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

/** Normalize one script into {@link { chunks, delayMs, usage, finish, finishReason, error, errorAfterChunks }}. */
function normalizeScript(script, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (Array.isArray(script)) return { chunks: script.map((chunk) => ({ ...chunk })) }
  if (typeof script === 'string') return { chunks: textDeltaChunks(script, { size: chunkSize }) }
  if (script === null || typeof script !== 'object') {
    throw new TypeError('fake-llm: script must be a string, chunk array, object or function')
  }
  if (Array.isArray(script.chunks)) {
    return { ...script, chunks: script.chunks.map((chunk) => ({ ...chunk })) }
  }
  if (typeof script.text === 'string') {
    return { ...script, chunks: textDeltaChunks(script.text, { size: script.chunkSize ?? chunkSize }) }
  }
  return { ...script, chunks: [] }
}

/**
 * Create one fake Host `llm` service.
 *
 * @param {{
 *   defaultScript?: string | object[] | object | Function,
 *   defaultText?: string,
 *   chunkSize?: number,
 *   name?: string,
 * }} [options]
 * @returns {{
 *   name: string,
 *   calls: object[],
 *   queue(script: any): object,
 *   match(matcher: string | RegExp | Function, script: any): object,
 *   setDefault(script: any): object,
 *   reset(): void,
 *   callCount(): number,
 *   lastCall(): object | undefined,
 *   lastPrompt(): string,
 *   stream(request?: object): AsyncGenerator<object>,
 * }}
 */
export function createFakeLlm(options = {}) {
  const calls = []
  const queue = []
  const rules = []
  const chunkSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0 ? options.chunkSize : DEFAULT_CHUNK_SIZE
  let defaultScript = options.defaultScript
  if (defaultScript === undefined && options.defaultText !== undefined) defaultScript = { text: options.defaultText }

  /** Flatten + record one request; returns the record mutated on completion. */
  function beginCall(request) {
    const flat = flattenLlmRequest(request)
    const record = {
      provider: typeof request?.provider === 'string' ? request.provider : undefined,
      model: typeof request?.model === 'string' ? request.model : undefined,
      system: flat.system,
      prompt: flat.prompt,
      messages: flat.messages,
      maxTokens: request?.maxTokens,
      temperature: request?.temperature,
      purpose: request?.purpose,
      startedAt: new Date().toISOString(),
      status: 'running',
    }
    calls.push(record)
    return record
  }

  /** Find the script for this request. */
  function resolveScript(request, flat) {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
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
  async function* streamImpl(request = {}) {
    const flat = flattenLlmRequest(request)
    const record = beginCall(request ?? {})
    const signal = request?.signal
    try {
      if (signal?.aborted) throw abortError()
      const resolved = resolveScript(request, flat)
      if (resolved.script === undefined) {
        throw new Error(`fake-llm: no script for request (prompt starts: ${flat.prompt.slice(0, 120)})`)
      }
      let raw = resolved.script
      if (typeof raw === 'function') raw = await raw(request, flat)
      const script = normalizeScript(raw, chunkSize)
      record.matchedBy = resolved.matchedBy
      if (typeof script.delayMs === 'number' && script.delayMs > 0) await sleep(script.delayMs, signal)
      if (script.error !== undefined && !(script.errorAfterChunks > 0)) throw toError(script.error, 'fake-llm scripted failure')
      for (let index = 0; index < script.chunks.length; index += 1) {
        if (signal?.aborted) throw abortError()
        if (typeof script.chunkDelayMs === 'number' && script.chunkDelayMs > 0) await sleep(script.chunkDelayMs, signal)
        yield script.chunks[index]
        if (typeof script.errorAfterChunks === 'number' && index + 1 >= script.errorAfterChunks) {
          throw toError(script.error, 'fake-llm scripted failure after chunks')
        }
      }
      if (script.usage !== undefined) {
        yield { type: 'usage', usage: { ...script.usage } }
      }
      if (script.finish !== false) {
        yield { type: 'finish', reason: script.finishReason ?? { kind: 'stop' } }
      }
      record.status = 'completed'
    } catch (error) {
      record.status = signal?.aborted || error?.name === 'AbortError' ? 'aborted' : 'errored'
      record.error = error?.message ?? String(error)
      throw error
    } finally {
      record.finishedAt = new Date().toISOString()
      if (record.status === 'running') record.status = signal?.aborted ? 'aborted' : 'completed'
    }
  }

  const llm = {
    name: options.name ?? 'fake-llm',
    calls,
    /** Queue one script for the next unmatched call (FIFO). */
    queue(script) {
      queue.push(script)
      return llm
    },
    /** Convenience: queue a grounded answer built from {@link litnotesAnswerText}. */
    queueAnswer(answer) {
      queue.push({ text: litnotesAnswerText(answer) })
      return llm
    },
    /** Persistently answer any request whose prompt matches `matcher`. */
    match(matcher, script, matchOptions = {}) {
      rules.push({ matcher, script, once: matchOptions.once === true })
      return llm
    },
    /** Fallback script used when no rule/queue entry matches. */
    setDefault(script) {
      defaultScript = script
      return llm
    },
    reset() {
      calls.length = 0
      queue.length = 0
      rules.length = 0
      defaultScript = options.defaultScript
      if (defaultScript === undefined && options.defaultText !== undefined) defaultScript = { text: options.defaultText }
      return llm
    },
    callCount() {
      return calls.length
    },
    lastCall() {
      return calls.at(-1)
    },
    lastPrompt() {
      return calls.at(-1)?.prompt ?? ''
    },
    stream(request) {
      return streamImpl(request ?? {})
    },
  }
  return llm
}
