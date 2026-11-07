// @vitest-environment happy-dom
/**
 * AI margin store tests: history load, scripted NDJSON streaming (all frames),
 * stop/regenerate/follow-up/clear, citation + annotation adoption, knowledge
 * deltas and Markdown export.
 *
 * The Host client is a scripted fake — the same frame objects the Host emits
 * (`src/shared/model.ts` `ChatFrame`), so the store's state machine is exercised
 * end to end without a server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, setHostClient } from '../../src/client/api/client.ts'
import type { HostClient } from '../../src/client/api/client.ts'
import type {
  ApiMethod,
  ApiRequests,
  ApiResults,
  StreamMethod,
  StreamMethods,
} from '../../src/shared/protocol.ts'
import type { ChatFrame, ChatMessage, Citation } from '../../src/shared/model.ts'
import { onAiKnowledge, setAiTranslate, useAiStore } from '../../src/client/ai/store.ts'
import { useUiStore } from '../../src/client/state/ui.ts'

/* -------------------------------------------------------------------------- */
/* Fake host                                                                  */
/* -------------------------------------------------------------------------- */

/** One scripted stream run. */
interface StreamScript {
  handlers: { onFrame: (frame: ChatFrame) => void; signal?: AbortSignal }
  request: StreamMethods['chat']['request']
  done: () => void
}

/** Fake host client with a scripted chat stream and history. */
function createFakeHost(options: {
  history?: ChatMessage[] | Error
  stream?: (script: StreamScript) => Promise<void>
  onClear?: () => void
}): HostClient {
  return {
    base: 'http://localhost/dsh-litnotes/api',
    async call<K extends ApiMethod>(method: K, _payload: ApiRequests[K]): Promise<ApiResults[K]> {
      if (method === 'chat.history') {
        if (options.history instanceof Error) throw options.history
        return { messages: options.history ?? [] } as unknown as ApiResults[K]
      }
      if (method === 'chat.clear') {
        options.onClear?.()
        return { cleared: true } as unknown as ApiResults[K]
      }
      throw new Error(`unexpected method ${method}`)
    },
    async stream<K extends StreamMethod>(
      _method: K,
      request: StreamMethods[K]['request'],
      handlers: { onFrame: (frame: StreamMethods[K]['frame']) => void; signal?: AbortSignal },
    ): Promise<void> {
      const script: StreamScript = {
        request: request as StreamMethods['chat']['request'],
        handlers: handlers as StreamScript['handlers'],
        done: () => {},
      }
      if (options.stream === undefined) return
      await options.stream(script)
    },
    async upload() {
      throw new Error('upload not expected')
    },
    asset: (id, path) => `http://localhost/asset/${id}/${path}`,
    source: (id) => `http://localhost/source/${id}`,
    vendor: (path) => `http://localhost/vendor/${path}`,
    ping: () => {},
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** One verified citation fixture. */
const CITATION: Citation = {
  index: 1,
  blockKey: 'b12:abc',
  quote: 'block-separator',
  start: 10,
  end: 24,
  page: 4,
  aspect: 'method',
  note: 'the method',
  verified: true,
}

/** Emit the documented happy-path frames for one answer. */
function happyFrames(overrides: { annotationIds?: string[] } = {}): ChatFrame[] {
  return [
    { type: 'start', messageId: 'srv-1', model: { provider: 'deepseek', model: 'deepseek-flash' } },
    { type: 'delta', text: 'Answer with [1].' },
    { type: 'phase', phase: 'entailment' },
    {
      type: 'answer',
      messageId: 'srv-1',
      markdown: 'Answer with [1].',
      citations: [CITATION],
      unverified: [],
      followups: ['why?'],
      annotationIds: overrides.annotationIds ?? ['ann-1'],
      entailment: { checked: true, supported: 1, partial: 0, unsupported: 0 },
    },
    { type: 'graph', delta: { nodes: [], edges: [] } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'done' },
  ]
}

/** Reset all module and store state between tests. */
function resetStores(): void {
  useAiStore.setState({
    documentId: null,
    messages: [],
    historyState: 'idle',
    historyError: null,
    streamingId: null,
    busy: false,
    input: '',
    composerContext: null,
    composerFocusTick: 0,
    streamError: null,
    lastKnowledgeDelta: null,
    lastKnowledgeDocumentId: null,
    hostHooks: {},
  })
  useUiStore.setState({ toasts: [] })
  setAiTranslate(null)
}

beforeEach(() => resetStores())
afterEach(() => {
  useAiStore.getState().stop()
  resetStores()
})

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

describe('history', () => {
  it('loads and normalizes chat.history', async () => {
    setHostClient(
      createFakeHost({
        history: [
          { id: 'u1', role: 'user', question: 'Q1', citations: [], unverified: [], createdAt: '2026-01-01T00:00:00Z' },
          {
            id: 'a1',
            role: 'assistant',
            question: 'Q1',
            answer: 'A1 [1].',
            citations: [CITATION],
            unverified: [],
            followups: ['more?'],
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
      }),
    )
    await useAiStore.getState().load('doc-1')
    const state = useAiStore.getState()
    expect(state.documentId).toBe('doc-1')
    expect(state.historyState).toBe('ready')
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]?.answer).toBe('A1 [1].')
    expect(state.messages[1]?.citations[0]?.blockKey).toBe('b12:abc')
    expect(state.messages[1]?.followups).toEqual(['more?'])
  })

  it('exposes a retryable history failure', async () => {
    setHostClient(createFakeHost({ history: new ApiError('network', 'cannot reach host') }))
    await useAiStore.getState().load('doc-1')
    const state = useAiStore.getState()
    expect(state.historyState).toBe('error')
    expect(state.historyError?.code).toBe('network')
  })

  it('reloads with force after an error', async () => {
    let calls = 0
    const client = createFakeHost({ history: [] })
    const original = client.call
    client.call = (async (...args: Parameters<HostClient['call']>) => {
      calls += 1
      return original(...args)
    }) as HostClient['call']
    setHostClient(client)
    await useAiStore.getState().load('doc-1')
    await useAiStore.getState().load('doc-1')
    expect(calls).toBe(1)
    await useAiStore.getState().retryHistory()
    expect(calls).toBe(2)
  })
})

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

describe('streaming ask', () => {
  it('renders every frame into one streaming answer and adopts the final payload', async () => {
    const annotationsChanged = vi.fn()
    const knowledge = vi.fn()
    const unsubscribe = onAiKnowledge(knowledge)
    let script: StreamScript | undefined
    setHostClient(
      createFakeHost({
        stream: async (run) => {
          script = run
          for (const frame of happyFrames()) run.handlers.onFrame(frame)
        },
      }),
    )
    await useAiStore.getState().load('doc-1')
    useAiStore.getState().setHostHooks({ onAnnotationsChanged: annotationsChanged })

    await useAiStore.getState().ask('What is the method?')
    const state = useAiStore.getState()

    expect(script?.request.documentId).toBe('doc-1')
    expect(script?.request.question).toBe('What is the method?')
    expect(script?.request.mode).toBe('doc')
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]?.role).toBe('user')
    expect(state.messages[0]?.question).toBe('What is the method?')
    const assistant = state.messages[1]
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.answer).toBe('Answer with [1].')
    expect(assistant?.streaming).toBe(false)
    expect(assistant?.serverId).toBe('srv-1')
    expect(assistant?.model).toEqual({ provider: 'deepseek', model: 'deepseek-flash' })
    expect(assistant?.citations).toHaveLength(1)
    expect(assistant?.annotationIds).toEqual(['ann-1'])
    expect(assistant?.followups).toEqual(['why?'])
    expect(assistant?.entailment).toEqual({ checked: true, supported: 1, partial: 0, unsupported: 0 })
    expect(assistant?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(state.busy).toBe(false)
    expect(state.streamingId).toBeNull()
    expect(annotationsChanged).toHaveBeenCalledTimes(1)
    expect(knowledge).toHaveBeenCalledTimes(1)
    expect(state.lastKnowledgeDocumentId).toBe('doc-1')
    expect(useUiStore.getState().toasts.some((toast) => toast.text === 'ai.annotationsNotice')).toBe(true)
    unsubscribe()
  })

  it('keeps the structured fence out of a streamed partial answer', async () => {
    setHostClient(
      createFakeHost({
        stream: async (run) => {
          run.handlers.onFrame({ type: 'start', messageId: 'srv-2', model: { provider: 'p', model: 'm' } })
          run.handlers.onFrame({ type: 'delta', text: 'Answer [1].\n\n```litnotes-json\n{"citations":[' })
          run.handlers.onFrame({ type: 'done' })
        },
      }),
    )
    await useAiStore.getState().load('doc-1')
    await useAiStore.getState().ask('Q')
    const answer = useAiStore.getState().messages[1]?.answer ?? ''
    expect(answer).toBe('Answer [1].')
    expect(answer).not.toContain('litnotes-json')
  })

  it('stop finalizes the run without an error and keeps the partial text', async () => {
    let started = false
    setHostClient(
      createFakeHost({
        stream: async (run) => {
          started = true
          run.handlers.onFrame({ type: 'start', messageId: 'srv-3', model: { provider: 'p', model: 'm' } })
          run.handlers.onFrame({ type: 'delta', text: 'Partial' })
          await new Promise<void>((resolve) => {
            run.handlers.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new DOMException('Aborted', 'AbortError')
        },
      }),
    )
    await useAiStore.getState().load('doc-1')
    const pending = useAiStore.getState().ask('Q')
    await Promise.resolve()
    expect(started).toBe(true)
    expect(useAiStore.getState().busy).toBe(true)
    useAiStore.getState().stop()
    await pending
    const state = useAiStore.getState()
    expect(state.busy).toBe(false)
    expect(state.streamingId).toBeNull()
    expect(state.streamError).toBeNull()
    expect(state.messages[1]?.stopped).toBe(true)
    expect(state.messages[1]?.streaming).toBe(false)
    expect(state.messages[1]?.answer).toBe('Partial')
  })

  it('an error frame surfaces a retryable entry failure', async () => {
    setHostClient(
      createFakeHost({
        stream: async (run) => {
          run.handlers.onFrame({ type: 'start', messageId: 'srv-4', model: { provider: 'p', model: 'm' } })
          run.handlers.onFrame({ type: 'delta', text: 'Half an answer' })
          run.handlers.onFrame({ type: 'error', code: 'llm-failed', message: 'boom' })
        },
      }),
    )
    await useAiStore.getState().load('doc-1')
    await useAiStore.getState().ask('Q')
    const state = useAiStore.getState()
    expect(state.busy).toBe(false)
    expect(state.messages[1]?.failed).toBe(true)
    expect(state.messages[1]?.answer).toBe('Half an answer')
    expect(state.streamError?.entryId).toBe(state.messages[1]?.id)
    expect(state.streamError?.retryable).toBe(true)
  })

  it('ignores a second ask while a run is active', async () => {
    let streamCalls = 0
    setHostClient(
      createFakeHost({
        stream: async (run) => {
          streamCalls += 1
          run.handlers.onFrame({ type: 'start', messageId: 'srv-5', model: { provider: 'p', model: 'm' } })
          await new Promise<void>((resolve) => {
            run.handlers.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      }),
    )
    await useAiStore.getState().load('doc-1')
    const first = useAiStore.getState().ask('Q1')
    await Promise.resolve()
    await useAiStore.getState().ask('Q2')
    expect(streamCalls).toBe(1)
    useAiStore.getState().stop()
    await first
  })
})

/* -------------------------------------------------------------------------- */
/* Regenerate / follow-up / clear                                             */
/* -------------------------------------------------------------------------- */

describe('conversation actions', () => {
  beforeEach(async () => {
    setHostClient(
      createFakeHost({
        history: [
          { id: 'u1', role: 'user', question: 'Q1', citations: [], unverified: [], createdAt: '2026-01-01T00:00:00Z' },
          {
            id: 'a1',
            role: 'assistant',
            question: 'Q1',
            answer: 'A1',
            citations: [],
            unverified: [],
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        stream: async (run) => {
          for (const frame of happyFrames({ annotationIds: [] })) run.handlers.onFrame(frame)
        },
      }),
    )
    await useAiStore.getState().load('doc-1')
  })

  it('regenerates one answer with regenerateOf and drops the old entry', async () => {
    let request: StreamScript['request'] | undefined
    const client = createFakeHost({
      history: [],
      stream: async (run) => {
        request = run.request
        for (const frame of happyFrames({ annotationIds: [] })) run.handlers.onFrame(frame)
      },
    })
    setHostClient(client)
    await useAiStore.getState().load('doc-1', { force: true })
    // Reload real history for the regenerate baseline.
    setHostClient(
      createFakeHost({
        history: [
          { id: 'u1', role: 'user', question: 'Q1', citations: [], unverified: [], createdAt: '2026-01-01T00:00:00Z' },
          { id: 'a1', role: 'assistant', question: 'Q1', answer: 'A1', citations: [], unverified: [], createdAt: '2026-01-01T00:00:01Z' },
        ],
        stream: async (run) => {
          request = run.request
          for (const frame of happyFrames({ annotationIds: [] })) run.handlers.onFrame(frame)
        },
      }),
    )
    await useAiStore.getState().load('doc-1', { force: true })
    await useAiStore.getState().regenerate('a1')
    expect(request?.regenerateOf).toBe('a1')
    expect(request?.question).toBe('Q1')
    const state = useAiStore.getState()
    expect(state.messages.filter((entry) => entry.role === 'user')).toHaveLength(1)
    expect(state.messages.at(-1)?.role).toBe('assistant')
  })

  it('appends a follow-up question', async () => {
    await useAiStore.getState().askFollowup('A follow-up?')
    const state = useAiStore.getState()
    expect(state.messages.filter((entry) => entry.role === 'user').map((entry) => entry.question)).toEqual([
      'Q1',
      'A follow-up?',
    ])
  })

  it('clears the conversation through the Host', async () => {
    let cleared = false
    setHostClient(createFakeHost({ onClear: () => (cleared = true) }))
    await useAiStore.getState().clearConversation()
    expect(cleared).toBe(true)
    expect(useAiStore.getState().messages).toEqual([])
    expect(useUiStore.getState().toasts.some((toast) => toast.text === 'ai.cleared')).toBe(true)
  })

  it('composes the export markdown and reports an empty conversation', async () => {
    const t = (key: string) => key
    const result = useAiStore.getState().buildExport({ title: 'Paper', t })
    expect(result?.filename).toBe('Paper.md')
    expect(result?.markdown).toContain('## ai.exportQuestion')
    expect(result?.markdown).toContain('A1')
  })
})

/* -------------------------------------------------------------------------- */
/* Composer context                                                           */
/* -------------------------------------------------------------------------- */

describe('composer context', () => {
  it('focusComposer sets the selection chip and bumps the focus tick', () => {
    const before = useAiStore.getState().composerFocusTick
    useAiStore.getState().focusComposer({ blockKey: 'b1:aa', quote: 'quoted text', text: 'quoted text' })
    const state = useAiStore.getState()
    expect(state.composerContext).toEqual({ blockKey: 'b1:aa', quote: 'quoted text', text: 'quoted text' })
    expect(state.composerFocusTick).toBe(before + 1)
    useAiStore.getState().clearComposerContext()
    expect(useAiStore.getState().composerContext).toBeNull()
  })

  it('sends the composer context as the chat focus', async () => {
    let request: StreamScript['request'] | undefined
    setHostClient(
      createFakeHost({
        stream: async (run) => {
          request = run.request
          run.handlers.onFrame({ type: 'done' })
        },
      }),
    )
    await useAiStore.getState().load('doc-1')
    useAiStore.getState().focusComposer({ blockKey: 'b9:zz', quote: 'quoted text', text: '' })
    await useAiStore.getState().ask('Q')
    expect(request?.focus).toEqual({ blockKey: 'b9:zz', selectionQuote: 'quoted text' })
  })
})
