// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true}}
/**
 * AI margin render tests (happy-dom): question/answer turns, inline citation
 * chips with click→jump and hover preview, entailment notices, follow-ups,
 * actions, streaming status/stop, filter chips with counts, document-order
 * anchoring and the composer.
 *
 * Mounted exactly as the reader mounts it: `AiMarginEntries` with the four
 * brokered props inside the plugin's locale context, against a scripted fake
 * Host client.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiMarginEntries, type AiMarginEntriesProps } from '../../src/client/ai/AiMarginEntries.tsx'
import { setHostClient } from '../../src/client/api/client.ts'
import type { HostClient } from '../../src/client/api/client.ts'
import type { ApiMethod, ApiRequests, ApiResults, StreamMethod, StreamMethods } from '../../src/shared/protocol.ts'
import type { ChatFrame, ChatMessage, Citation, DocumentSummary, Preferences, StatusValue } from '../../src/shared/model.ts'
import { DEFAULT_PREFERENCES } from '../../src/shared/preferences.ts'
import { zh } from '../../src/client/i18n/index.ts'
import { LocaleContext, type LitnotesTranslate } from '../../src/client/shell/locale-context.ts'
import { useLibraryStore } from '../../src/client/state/library.ts'
import { useReaderStore } from '../../src/client/reader/store.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import { useAiStore } from '../../src/client/ai/store.ts'

/* -------------------------------------------------------------------------- */
/* Locale                                                                     */
/* -------------------------------------------------------------------------- */

/** Interpolate `{name}` templates. */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

const zhCopy = zh as unknown as Record<string, string>
const fakeT = ((key: string, params?: Record<string, unknown>) =>
  interpolate(zhCopy[key] ?? key, params)) as unknown as LitnotesTranslate

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PREFERENCES: Preferences = { ...DEFAULT_PREFERENCES }

const STATUS: StatusValue = {
  version: '2.0.0',
  hostVersion: '2.0.0+host',
  dataDirDisplay: '~/.dsh/litnotes',
  tokenConfigured: false,
  tokenPersistent: true,
  translatorAvailable: true,
  modelAvailable: true,
  counts: { total: 1, parsed: 1, parsing: 0, failed: 0 },
  preferences: PREFERENCES,
  local: null,
  ai: { available: true, graph: true, route: { provider: 'deepseek', model: 'deepseek-flash' }, retriever: true },
}

const DOCUMENT: DocumentSummary = {
  schemaVersion: 1,
  id: 'doc-1',
  title: 'Attention Is All You Need',
  originalName: 'attention.pdf',
  ext: '.pdf',
  mime: 'application/pdf',
  size: 1024,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  status: 'parsed',
  error: null,
  parse: null,
}

const CITATION: Citation = {
  index: 1,
  blockKey: 'b12:abc',
  quote: 'Scaled dot-product attention',
  start: 4,
  end: 31,
  page: 4,
  aspect: 'method',
  note: 'the proposed method',
  verified: true,
  entailment: 'supported',
}

const UNSUPPORTED: Citation = {
  index: 2,
  blockKey: 'b20:def',
  quote: 'the quote does not support the claim',
  start: 0,
  end: 10,
  page: 6,
  aspect: 'result',
  note: '',
  verified: false,
  reason: 'entailment-unsupported',
  entailment: 'unsupported',
  entailmentReason: 'claim too strong',
}

/** Two-turn history with a citation and an unsupported citation. */
function history(): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', question: 'What is the method?', citations: [], unverified: [], createdAt: '2026-01-01T00:00:00Z' },
    {
      id: 'a1',
      role: 'assistant',
      question: 'What is the method?',
      answer: 'The method is scaled dot-product attention [1].',
      citations: [CITATION],
      unverified: [UNSUPPORTED],
      followups: ['Why does it work?'],
      annotationIds: ['ann-1'],
      entailment: { checked: true, supported: 1, partial: 0, unsupported: 1 },
      createdAt: '2026-01-01T00:00:01Z',
    },
  ]
}

/** Fake host with chat history and an optional scripted stream. */
function createFakeHost(options: {
  history?: ChatMessage[]
  stream?: (script: {
    request: StreamMethods['chat']['request']
    handlers: { onFrame: (frame: ChatFrame) => void; signal?: AbortSignal }
  }) => Promise<void>
  preferences?: Preferences
}): HostClient {
  return {
    base: 'http://localhost/dsh-litnotes/api',
    async call<K extends ApiMethod>(method: K, payload: ApiRequests[K]): Promise<ApiResults[K]> {
      if (method === 'chat.history') return { messages: options.history ?? [] } as unknown as ApiResults[K]
      if (method === 'chat.clear') return { cleared: true } as unknown as ApiResults[K]
      if (method === 'settings.update') {
        const request = payload as { preferences?: Preferences }
        return { preferences: request.preferences ?? options.preferences ?? PREFERENCES } as unknown as ApiResults[K]
      }
      throw new Error(`unexpected method ${method}`)
    },
    async stream<K extends StreamMethod>(
      _method: K,
      request: StreamMethods[K]['request'],
      handlers: { onFrame: (frame: StreamMethods[K]['frame']) => void; signal?: AbortSignal },
    ): Promise<void> {
      if (options.stream === undefined) return
      await options.stream({
        request: request as StreamMethods['chat']['request'],
        handlers: handlers as { onFrame: (frame: ChatFrame) => void; signal?: AbortSignal },
      })
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

/** Happy-path frames for one answer. */
function happyFrames(annotationIds: string[] = []): ChatFrame[] {
  return [
    { type: 'start', messageId: 'srv-1', model: { provider: 'deepseek', model: 'deepseek-flash' } },
    { type: 'delta', text: 'Streamed answer' },
    {
      type: 'answer',
      messageId: 'srv-1',
      markdown: 'Streamed answer',
      citations: [CITATION],
      unverified: [],
      followups: [],
      annotationIds,
      entailment: { checked: true, supported: 1, partial: 0, unsupported: 0 },
    },
    { type: 'done' },
  ]
}

/* -------------------------------------------------------------------------- */
/* Mount harness                                                              */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement
let root: Root
let onJump: ReturnType<typeof vi.fn>
let onAnnotationsChanged: ReturnType<typeof vi.fn>

/** Order map the reader would provide for the fixture block keys. */
const ORDER: Record<string, number> = { 'b12:abc': 3, 'b20:def': 7, 'b1:first': 1, 'b2:second': 2 }

function orderOf(blockKey: string): number | null {
  return ORDER[blockKey] ?? null
}

function mount(overrides: Partial<AiMarginEntriesProps> = {}): void {
  const props: AiMarginEntriesProps = {
    documentId: 'doc-1',
    orderOf,
    onJump,
    onAnnotationsChanged,
    ...overrides,
  }
  act(() => {
    root.render(
      <LocaleContext.Provider value={fakeT}>
        <AiMarginEntries {...props} />
      </LocaleContext.Provider>,
    )
  })
}

/** Flush one macrotask inside act (history/stream promise settlement). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Set a controlled input value the way a user does. */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Dispatch one click inside act. */
function click(element: Element | null | undefined): void {
  if (element === null || element === undefined) throw new Error('element to click is missing')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  onJump = vi.fn()
  onAnnotationsChanged = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
  useUiStore.setState({ marginFilter: 'all', activeAspect: null, toasts: [] })
  useLibraryStore.setState({ status: STATUS, documents: [DOCUMENT], loaded: true })
  useReaderStore.setState({ annotations: [], selectionContext: null })
})

afterEach(() => {
  useAiStore.getState().stop()
  act(() => root.unmount())
  container.remove()
  setHostClient(createFakeHost({ history: [] }))
})

/* -------------------------------------------------------------------------- */
/* Turns / citations / entailment                                             */
/* -------------------------------------------------------------------------- */

describe('margin entries', () => {
  it('renders a history turn with citation chips, entailment notice and follow-ups', async () => {
    setHostClient(createFakeHost({ history: history() }))
    mount()
    await flush()

    const turns = container.querySelectorAll('.ln-ai__turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]?.getAttribute('data-anchor-block')).toBe('b12:abc')
    expect(container.querySelector('.ln-ai__question-text')?.textContent).toContain('What is the method?')
    expect(container.querySelector('.ln-ai__markdown')?.textContent).toContain('scaled dot-product attention')
    // Inline chip + evidence chip for citation 1, evidence chip for citation 2.
    expect(container.querySelectorAll('.ln-ai__cite')).toHaveLength(3)
    const entailment = container.querySelector('.ln-ai__notice--entailment')
    expect(entailment).not.toBeNull()
    expect(entailment?.textContent).toContain('条引文与论点不符')
    expect(container.querySelector('.ln-ai__followup')?.textContent).toBe('Why does it work?')
    expect(container.querySelector('.ln-ai__evidence')?.textContent).toContain('已在原文标注 1 处引用')
    const actionLabels = [...container.querySelectorAll('.ln-ai__action')].map((node) => node.textContent ?? '')
    expect(actionLabels.some((label) => label.includes('复制答案'))).toBe(true)
    expect(actionLabels.some((label) => label.includes('重新生成'))).toBe(true)
  })

  it('jumps on a verified citation chip click', async () => {
    setHostClient(createFakeHost({ history: history() }))
    mount()
    await flush()
    const chip = container.querySelector('.ln-ai__cite[data-index="1"]')
    click(chip)
    expect(onJump).toHaveBeenCalledWith('b12:abc')
  })

  it('opens the preview card instead of jumping for an entailment-unsupported citation', async () => {
    setHostClient(createFakeHost({ history: history() }))
    mount()
    await flush()
    const chip = container.querySelector('.ln-ai__cite[data-index="2"]')
    click(chip)
    expect(onJump).not.toHaveBeenCalled()
    const card = container.querySelector('.ln-ai__citecard')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('引文未支持该论点')
    expect(card?.textContent).toContain('the quote does not support the claim')
    expect(card?.querySelector('.ln-ai__action')?.textContent).not.toBe('跳到原文')
  })

  it('shows the citation preview card on hover with page and aspect', async () => {
    setHostClient(createFakeHost({ history: history() }))
    mount()
    await flush()
    const chip = container.querySelector('.ln-ai__cite[data-index="1"]')
    act(() => {
      chip?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const card = container.querySelector('.ln-ai__citecard')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('第 4 页')
    expect(card?.textContent).toContain('方法')
    expect(card?.textContent).toContain('Scaled dot-product attention')
  })

  it('sorts turns by document order of their first citation', async () => {
    const reversed: ChatMessage[] = [
      { id: 'u1', role: 'user', question: 'Second section', citations: [], unverified: [], createdAt: '2026-01-01T00:00:00Z' },
      {
        id: 'a1',
        role: 'assistant',
        question: 'Second section',
        answer: 'Later [1].',
        citations: [{ ...CITATION, blockKey: 'b2:second' }],
        unverified: [],
        createdAt: '2026-01-01T00:00:01Z',
      },
      { id: 'u2', role: 'user', question: 'First section', citations: [], unverified: [], createdAt: '2026-01-01T00:00:02Z' },
      {
        id: 'a2',
        role: 'assistant',
        question: 'First section',
        answer: 'Earlier [1].',
        citations: [{ ...CITATION, blockKey: 'b1:first' }],
        unverified: [],
        createdAt: '2026-01-01T00:00:03Z',
      },
    ]
    setHostClient(createFakeHost({ history: reversed }))
    mount()
    await flush()
    const anchors = [...container.querySelectorAll('.ln-ai__turn')].map((node) => node.getAttribute('data-anchor-block'))
    expect(anchors).toEqual(['b1:first', 'b2:second'])
  })

  it('renders quick prompts in the empty state and asks with the prompt', async () => {
    let question = ''
    setHostClient(
      createFakeHost({
        history: [],
        stream: async ({ request, handlers }) => {
          question = request.question
          for (const frame of happyFrames()) handlers.onFrame(frame)
        },
      }),
    )
    mount()
    await flush()
    const prompts = [...container.querySelectorAll('.ln-ai__prompt')]
    expect(prompts.length).toBeGreaterThan(0)
    click(prompts[0])
    await flush()
    expect(question).toBe('总结全文')
    expect(container.querySelectorAll('.ln-ai__turn')).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Filter chips                                                               */
/* -------------------------------------------------------------------------- */

describe('margin filter chips', () => {
  it('shows chat and annotation counts and hides AI entries on a notes filter', async () => {
    useReaderStore.setState({
      annotations: [
        { id: 'n1', blockKey: 'b1:x', start: 0, end: 1, quote: 'a', color: 'yellow', origin: 'ai', note: '', createdAt: '', updatedAt: '' },
        { id: 'n2', blockKey: 'b1:x', start: 2, end: 3, quote: 'b', color: 'sage', origin: 'user', note: '', createdAt: '', updatedAt: '' },
        { id: 'n3', blockKey: 'b1:x', start: 3, end: 4, quote: 'c', color: 'rose', note: '', createdAt: '', updatedAt: '' },
      ],
    } as never)
    setHostClient(createFakeHost({ history: history() }))
    mount()
    await flush()

    const chip = (label: string): HTMLButtonElement | undefined =>
      [...container.querySelectorAll<HTMLButtonElement>('.ln-ai__filters .ln-chip')].find((node) =>
        (node.textContent ?? '').startsWith(label),
      )
    expect(chip('全部')?.textContent).toBe('全部4')
    expect(chip('对话')?.textContent).toBe('对话1')
    expect(chip('AI 批注')?.textContent).toBe('AI 批注1')
    expect(chip('我的批注')?.textContent).toBe('我的批注2')

    click(chip('AI 批注'))
    expect(useUiStore.getState().marginFilter).toBe('ai')
    await flush()
    expect(container.querySelectorAll('.ln-ai__turn')).toHaveLength(0)

    click(chip('对话'))
    await flush()
    expect(useUiStore.getState().marginFilter).toBe('chat')
    expect(container.querySelectorAll('.ln-ai__turn')).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Composer                                                                   */
/* -------------------------------------------------------------------------- */

describe('composer', () => {
  it('sends with mod+Enter and clears the input', async () => {
    let question = ''
    setHostClient(
      createFakeHost({
        history: [],
        stream: async ({ request, handlers }) => {
          question = request.question
          for (const frame of happyFrames()) handlers.onFrame(frame)
        },
      }),
    )
    mount()
    await flush()
    const textarea = container.querySelector<HTMLTextAreaElement>('.ln-ai__input')
    expect(textarea).not.toBeNull()
    setTextareaValue(textarea as HTMLTextAreaElement, 'What is the method?')
    act(() => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await flush()
    expect(question).toBe('What is the method?')
    expect(container.querySelectorAll('.ln-ai__turn')).toHaveLength(1)
    const after = container.querySelector<HTMLTextAreaElement>('.ln-ai__input')
    expect(after?.value).toBe('')
  })

  it('shows the setup invitation when the model is unavailable', async () => {
    useLibraryStore.setState({
      status: { ...STATUS, ai: { available: false, graph: true, route: null, retriever: true } },
    })
    setHostClient(createFakeHost({ history: [] }))
    mount()
    await flush()
    expect(container.querySelector('.ln-ai__composer--setup')).not.toBeNull()
    expect(container.querySelector('.ln-ai__setup')?.textContent).toContain('AI 模型尚未就绪')
    expect(container.querySelector('.ln-ai__input')).toBeNull()
  })

  it('streams into the turn and stops through the composer', async () => {
    let emit: ((frame: ChatFrame) => void) | null = null
    setHostClient(
      createFakeHost({
        history: [],
        stream: async ({ handlers }) => {
          emit = handlers.onFrame
          await new Promise<void>((resolve) => {
            handlers.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new DOMException('Aborted', 'AbortError')
        },
      }),
    )
    mount()
    await flush()
    const textarea = container.querySelector<HTMLTextAreaElement>('.ln-ai__input')
    setTextareaValue(textarea as HTMLTextAreaElement, 'Q')
    act(() => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await flush()
    expect(emit).not.toBeNull()
    act(() => {
      emit?.({ type: 'start', messageId: 'srv-live', model: { provider: 'p', model: 'm' } })
      emit?.({ type: 'delta', text: 'Partial text' })
    })
    expect(container.querySelector('.ln-ai__markdown')?.textContent).toContain('Partial text')
    expect(container.querySelector('.ln-ai__caret')).not.toBeNull()
    expect(container.querySelector('.ln-ai__composer')?.getAttribute('data-busy')).toBe('true')

    const stopButton = [...container.querySelectorAll<HTMLButtonElement>('.ln-ai__composer button')].find((button) =>
      (button.textContent ?? '').includes('停止'),
    )
    click(stopButton)
    await flush()
    expect(container.querySelector('.ln-ai__composer')?.getAttribute('data-busy')).toBe('false')
    expect(container.querySelector('.ln-ai__notice')?.textContent).toContain('已停止生成')
  })

  it('notifies the reader after an answer adopts annotations', async () => {
    setHostClient(
      createFakeHost({
        history: [],
        stream: async ({ handlers }) => {
          for (const frame of happyFrames(['ann-1'])) handlers.onFrame(frame)
        },
      }),
    )
    mount()
    await flush()
    await act(async () => {
      await useAiStore.getState().ask('Q')
    })
    expect(onAnnotationsChanged).toHaveBeenCalledTimes(1)
  })
})
