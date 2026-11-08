// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true}}
/**
 * AI 精读 panel render tests (happy-dom): idle CTA + start, running phase
 * checklist + stop, done report with evidence jumps, stats row, annotation
 * cards/collapse, copy report, rerun with force, error/retry and record-load
 * error — plus the empty-report state.
 *
 * Mounted exactly as the reader mounts it: `DeepReadPanel` with the four
 * brokered props inside the plugin's locale context, against a scripted fake
 * Host client.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeepReadPanel } from '../../src/client/ai/DeepReadPanel.tsx'
import type { DeepReadPanelProps } from '../../src/client/ai/DeepReadPanel.tsx'
import { setHostClient } from '../../src/client/api/client.ts'
import type { HostClient } from '../../src/client/api/client.ts'
import type {
  ApiMethod,
  ApiRequests,
  ApiResults,
  StreamMethod,
  StreamMethods,
} from '../../src/shared/protocol.ts'
import type {
  Annotation,
  DeepReadFrame,
  DeepReadHighlight,
  DeepReadRecord,
  DeepReadReport,
} from '../../src/shared/model.ts'
import { zh } from '../../src/client/i18n/index.ts'
import { zh as deepreadZh } from '../../src/client/i18n/deepread.ts'
import { LocaleContext, type LitnotesTranslate } from '../../src/client/shell/locale-context.ts'
import { provideLocale } from '../../src/client/shell/locale-context.ts'
import { useDeepReadStore } from '../../src/client/ai/deepread-store.ts'
import { useUiStore } from '../../src/client/state/ui.ts'

/* -------------------------------------------------------------------------- */
/* Locale                                                                     */
/* -------------------------------------------------------------------------- */

/** Interpolate `{name}` templates like the Host locale service. */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

const ZH_COPY = { ...zh, ...deepreadZh } as unknown as Record<string, string>

const fakeT = ((key: string, params?: Record<string, unknown>) =>
  interpolate(ZH_COPY[key] ?? key, params)) as unknown as LitnotesTranslate

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const HIGHLIGHTS: DeepReadHighlight[] = [
  {
    annotationId: 'ann-1',
    blockKey: 'b12:abc',
    quote: 'Scaled dot-product attention',
    start: 4,
    end: 31,
    page: 4,
    aspect: 'method',
    note: 'Attention replaces recurrence; cost grows with sequence length.',
    importance: 5,
    section: 'Method',
    kind: 'method',
  },
  {
    annotationId: 'ann-2',
    blockKey: 'b20:def',
    quote: 'BLEU 28.4 on WMT 2014 English-to-German',
    start: 0,
    end: 40,
    page: 6,
    aspect: 'result',
    note: 'The headline number; the protocol is a single run.',
    importance: 4,
    section: 'Results',
    kind: 'result',
  },
]

const REPORT: DeepReadReport = {
  tldr: ['A recurrence-free sequence model built only from attention.'],
  problem: { label: 'Long sequences are slow', detail: 'Recurrence serializes computation.', blockKeys: ['b12:abc'] },
  gap: { label: '', detail: 'No prior architecture removes recurrence entirely.', blockKeys: [] },
  contributions: [
    {
      label: 'A self-attention architecture',
      detail: 'Attention and feed-forward layers only.',
      blockKeys: ['b12:abc'],
      evidence: 'strong',
    },
  ],
  method: [{ label: 'Scaled dot-product', detail: 'Query/key/value attention with scaling.', blockKeys: ['b12:abc'] }],
  evaluation: [{ label: 'WMT 2014', detail: 'BLEU comparisons against recurrent baselines.', blockKeys: ['b20:def'] }],
  findings: [{ label: 'Faster training', detail: 'Fewer steps to a better BLEU.', blockKeys: ['b12:abc'] }],
  limitations: [{ label: 'Single-run numbers', detail: 'Seed variance is not reported.', blockKeys: ['b20:def'] }],
  openQuestions: [{ label: 'Long contexts', detail: 'Cost beyond 10k tokens is untested.', blockKeys: [] }],
  argumentMap: [{ from: 'Attention only', to: 'Lower training cost', relation: 'supports' }],
  glossary: [{ term: 'Self-attention', definition: 'Attention over one sequence.', blockKeys: ['b12:abc'] }],
  readingPath: ['Read §3.2 for the mechanism.', 'Read Table 2 for the results.'],
  verdict: {
    strengths: ['Clean architecture ablation.'],
    weaknesses: ['Narrow baseline set.'],
    confidence: 'high',
  },
}

/** One complete persisted record. */
function makeRecord(documentId = 'doc-1'): DeepReadRecord {
  return {
    version: 1,
    documentId,
    generatedAt: '2026-11-08T06:30:00.000Z',
    language: 'zh',
    model: { provider: 'deepseek', model: 'deepseek-flash' },
    promptVersion: 1,
    report: REPORT,
    highlights: HIGHLIGHTS.map((highlight) => ({ ...highlight })),
    stats: {
      sections: 6,
      sectionsRead: 6,
      chunks: 8,
      chunksRead: 8,
      candidates: 10,
      kept: 2,
      skipped: 8,
      coverage: 0.8,
      calls: 5,
      durationMs: 120_000,
      inputTokens: 1000,
      outputTokens: 200,
      truncated: false,
    },
  }
}

/** Reader annotations persisted for the two report highlights. */
const ANNOTATIONS: Annotation[] = HIGHLIGHTS.map((highlight) => ({
  id: highlight.annotationId,
  blockKey: highlight.blockKey,
  start: highlight.start,
  end: highlight.end,
  quote: highlight.quote,
  color: highlight.aspect === 'method' ? 'sage' : 'sky',
  aspect: highlight.aspect,
  note: highlight.note,
  origin: 'ai',
  chatId: 'deepread:doc-1',
  createdAt: '2026-11-08T06:30:00.000Z',
  updatedAt: '2026-11-08T06:30:00.000Z',
}))

/** One emitted happy-path run. */
function happyFrames(record: DeepReadRecord): DeepReadFrame[] {
  return [
    { type: 'start', model: { provider: 'deepseek', model: 'deepseek-flash' }, language: 'zh' },
    { type: 'progress', phase: 'mapping', done: 0, total: 1 },
    { type: 'progress', phase: 'reading', done: 1, total: 4, section: 'Introduction' },
    { type: 'progress', phase: 'synthesizing', done: 1, total: 1 },
    { type: 'report', record },
    { type: 'annotations', created: 2, highlights: record.highlights },
    { type: 'done' },
  ]
}

/* -------------------------------------------------------------------------- */
/* Fake host                                                                  */
/* -------------------------------------------------------------------------- */

/** One recorded stream call. */
interface StreamCall {
  request: StreamMethods['deepread']['request']
  handlers: { onFrame: (frame: DeepReadFrame) => void; signal?: AbortSignal }
}

/** Fake Host with the deep-read record and an optional scripted stream. */
function createFakeHost(options: {
  record?: DeepReadRecord | null | Error
  stream?: (call: StreamCall) => Promise<void>
}): { client: HostClient; calls: { records: string[]; streams: StreamCall[] } } {
  const calls = { records: [] as string[], streams: [] as StreamCall[] }
  const client: HostClient = {
    base: 'http://localhost/dsh-litnotes/api',
    async call<K extends ApiMethod>(method: K, payload: ApiRequests[K]): Promise<ApiResults[K]> {
      if (method === 'deepread.get') {
        const request = payload as ApiRequests['deepread.get']
        calls.records.push(request.documentId)
        if (options.record instanceof Error) throw options.record
        return { record: options.record ?? null } as unknown as ApiResults[K]
      }
      throw new Error(`unexpected method ${String(method)}`)
    },
    async stream<K extends StreamMethod>(
      _method: K,
      request: StreamMethods[K]['request'],
      handlers: { onFrame: (frame: StreamMethods[K]['frame']) => void; signal?: AbortSignal },
    ): Promise<void> {
      const call: StreamCall = {
        request: request as StreamMethods['deepread']['request'],
        handlers: handlers as StreamCall['handlers'],
      }
      calls.streams.push(call)
      if (options.stream === undefined) return
      await options.stream(call)
    },
    async upload() {
      throw new Error('upload not expected')
    },
    asset: () => '',
    source: () => '',
    vendor: () => '',
    ping: () => {},
  }
  return { client, calls }
}

/* -------------------------------------------------------------------------- */
/* Mount harness                                                              */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement
let root: Root
let onJump: (blockKey: string) => void
let onAnnotationsChanged: () => void | Promise<void>

function mount(overrides: Partial<DeepReadPanelProps> = {}): void {
  const props: DeepReadPanelProps = {
    documentId: 'doc-1',
    annotations: ANNOTATIONS,
    onJump,
    onAnnotationsChanged,
    ...overrides,
  }
  act(() => {
    root.render(
      <LocaleContext.Provider value={fakeT}>
        <DeepReadPanel {...props} />
      </LocaleContext.Provider>,
    )
  })
}

/** Flush one macrotask inside act (record/stream promise settlement). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Dispatch one click inside act. */
function click(element: Element | null | undefined): void {
  if (element === null || element === undefined) throw new Error('element to click is missing')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Find one button by its visible text. */
function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(text),
  )
  if (button === undefined) throw new Error(`button "${text}" is missing`)
  return button
}

/** Seed a ready/idle store state for the open document. */
function seedStore(overrides: Partial<ReturnType<typeof useDeepReadStore.getState>> = {}): void {
  useDeepReadStore.setState({
    documentId: 'doc-1',
    record: null,
    recordState: 'ready',
    runState: 'idle',
    progress: null,
    error: null,
    busy: false,
    annotationsCreated: 0,
    ...overrides,
  })
}

beforeEach(() => {
  onJump = vi.fn() as (blockKey: string) => void
  onAnnotationsChanged = vi.fn() as () => void | Promise<void>
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  provideLocale(() => 'zh')
  useUiStore.setState({ toasts: [] })
  seedStore()
})

afterEach(() => {
  useDeepReadStore.getState().stop()
  act(() => root.unmount())
  container.remove()
  setHostClient(createFakeHost({ record: null }).client)
  seedStore()
  useUiStore.setState({ toasts: [] })
})

/* -------------------------------------------------------------------------- */
/* Idle / start                                                               */
/* -------------------------------------------------------------------------- */

describe('idle CTA', () => {
  it('invites a run and starts it with the reader language', async () => {
    const record = makeRecord()
    const { client, calls } = createFakeHost({
      stream: async (call) => {
        for (const frame of happyFrames(record)) call.handlers.onFrame(frame)
      },
    })
    setHostClient(client)
    mount()
    await flush()

    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('idle')
    const cta = container.querySelector('.ln-deepread__cta')
    expect(cta?.textContent).toContain('AI 精读')
    expect(cta?.textContent).toContain('让 AI 通读全文')
    expect(cta?.textContent).toContain('会消耗 token')

    click(buttonByText('开始精读'))
    await flush()

    expect(calls.streams).toHaveLength(1)
    expect(calls.streams[0]?.request).toEqual({ documentId: 'doc-1', language: 'zh' })
    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('report')
    expect(container.querySelector('.ln-deepread__report-title')?.textContent).toBe('精读报告')
    expect(onAnnotationsChanged).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().toasts.some((toast) => toast.text.includes('生成 2 条批注'))).toBe(true)
  })

  it('streams the phase checklist, current section and stops the run', async () => {
    let emit: ((frame: DeepReadFrame) => void) | null = null
    let aborted = false
    const { client } = createFakeHost({
      stream: async (call) => {
        emit = call.handlers.onFrame
        call.handlers.signal?.addEventListener('abort', () => {
          aborted = true
        })
        await new Promise<void>((resolve) => {
          call.handlers.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    })
    setHostClient(client)
    mount()
    await flush()
    click(buttonByText('开始精读'))
    await flush()

    act(() => {
      emit?.({ type: 'progress', phase: 'reading', done: 2, total: 5, section: 'Method' })
    })
    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('running')
    const phaseLabels = [...container.querySelectorAll('.ln-deepread__phase-label')].map((node) => node.textContent)
    expect(phaseLabels).toEqual([
      '建立阅读地图',
      '逐节精读',
      '补读薄弱章节',
      '批注校订',
      '撰写报告',
      '写入原文',
    ])
    const activePhase = container.querySelector('.ln-deepread__phase[data-state="active"] .ln-deepread__phase-label')
    expect(activePhase?.textContent).toBe('逐节精读')
    expect(container.querySelector('.ln-deepread__running-section')?.textContent).toContain('Method')
    expect(container.querySelector('.ln-deepread__running-count')?.textContent).toContain('2/5')

    click(buttonByText('停止精读'))
    await flush()
    expect(aborted).toBe(true)
    expect(useDeepReadStore.getState().runState).toBe('idle')
    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('idle')
  })
})

/* -------------------------------------------------------------------------- */
/* Done report                                                                */
/* -------------------------------------------------------------------------- */

describe('done report', () => {
  it('renders the stats row, TL;DR, sections and evidence jumps', async () => {
    setHostClient(createFakeHost({ record: makeRecord() }).client)
    seedStore({ record: makeRecord(), runState: 'done' })
    mount()
    await flush()

    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('report')
    const stats = container.querySelector('.ln-deepread__stats')?.textContent ?? ''
    expect(stats).toContain('通读 6 节')
    expect(stats).toContain('生成 2 条批注')
    expect(stats).toContain('覆盖率 80%')
    expect(container.querySelector('.ln-deepread__meta')?.textContent).toContain('deepseek/deepseek-flash')
    expect(container.querySelector('.ln-deepread__meta')?.textContent).toContain('生成于')

    const tldr = container.querySelector('.ln-deepread__section--tldr')
    expect(tldr?.textContent).toContain('一句话结论')
    expect(tldr?.textContent).toContain('A recurrence-free sequence model')

    for (const section of ['problem', 'gap', 'contributions', 'method', 'evaluation', 'findings', 'limitations']) {
      expect(container.querySelector(`[data-section="${section}"]`), section).not.toBeNull()
    }
    expect(container.querySelector('[data-section="openQuestions"]')).not.toBeNull()
    expect(container.querySelector('.ln-deepread__point[data-evidence="strong"]')?.textContent).toContain('强')
    expect(container.querySelector('[data-section="argument-map"]')?.textContent).toContain('supports')
    expect(container.querySelector('[data-section="glossary"]')?.textContent).toContain('Self-attention')
    expect(container.querySelector('[data-section="reading-path"]')?.textContent).toContain('§3.2')
    expect(container.querySelector('[data-section="verdict"]')?.textContent).toContain('信心 高')

    const refs = [...container.querySelectorAll<HTMLButtonElement>('.ln-deepread__ref')]
    expect(refs.map((node) => node.textContent)).toContain('原文 p.4')
    expect(refs.map((node) => node.textContent)).toContain('原文 p.6')
    const firstRef = refs.find((node) => node.textContent === '原文 p.4')
    click(firstRef)
    expect(onJump).toHaveBeenCalledWith('b12:abc')
  })

  it('collapses the annotation cards of this run and jumps from a card', async () => {
    setHostClient(createFakeHost({ record: makeRecord() }).client)
    seedStore({ record: makeRecord(), runState: 'done' })
    mount()
    await flush()

    expect(container.querySelectorAll('.ln-deepread__card')).toHaveLength(0)
    const toggle = container.querySelector<HTMLButtonElement>('.ln-deepread__annotations-toggle')
    expect(toggle?.textContent).toContain('本次批注')
    expect(toggle?.textContent).toContain('2')
    expect(toggle?.textContent).toContain('已写入原文 2/2')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    click(toggle)
    const cards = [...container.querySelectorAll('.ln-deepread__card')]
    expect(cards).toHaveLength(2)
    const cardText = cards.map((card) => card.textContent ?? '')
    expect(cardText[0]).toContain('Scaled dot-product attention')
    expect(cardText[0]).toContain('方法')
    expect(cardText[0]).toContain('p.4')
    expect(cards[0]?.querySelector('.ln-deepread__card-jump')).not.toBeNull()
    click(cards[0]?.querySelector('.ln-deepread__card-jump'))
    expect(onJump).toHaveBeenCalledWith('b12:abc')

    click(container.querySelector('.ln-deepread__annotations-toggle'))
    expect(container.querySelectorAll('.ln-deepread__card')).toHaveLength(0)
  })

  it('copies the Markdown report', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    setHostClient(createFakeHost({ record: makeRecord() }).client)
    seedStore({ record: makeRecord(), runState: 'done' })
    mount()
    await flush()

    click(container.querySelector('[aria-label="复制报告"]'))
    await flush()
    expect(writeText).toHaveBeenCalledTimes(1)
    const markdown = String(writeText.mock.calls[0]?.[0] ?? '')
    expect(markdown).toContain('# 精读报告')
    expect(markdown).toContain('## 一句话结论')
    expect(markdown).toContain('A recurrence-free sequence model')
    expect(useUiStore.getState().toasts.some((toast) => toast.text === '报告已复制')).toBe(true)
  })

  it('renders the header without point sections when the report carries no content', async () => {
    const empty: DeepReadRecord = {
      ...makeRecord(),
      report: {
        tldr: [],
        problem: { label: '', detail: '', blockKeys: [] },
        gap: { label: '', detail: '', blockKeys: [] },
        contributions: [],
        method: [],
        evaluation: [],
        findings: [],
        limitations: [],
        openQuestions: [],
        argumentMap: [],
        glossary: [],
        readingPath: [],
        verdict: { strengths: [], weaknesses: [], confidence: 'low' },
      },
      highlights: [],
    }
    setHostClient(createFakeHost({ record: empty }).client)
    seedStore({ record: empty, runState: 'done' })
    mount()
    await flush()
    expect(container.querySelector('.ln-deepread__report-title')).not.toBeNull()
    expect(container.querySelector('[data-section="tldr"]')).toBeNull()
    expect(container.querySelector('[data-section="contributions"]')).toBeNull()
    expect(container.querySelector('.ln-deepread__annotations')).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Rerun                                                                      */
/* -------------------------------------------------------------------------- */

describe('rerun', () => {
  it('starts a forced run from the done report', async () => {
    let aborted = false
    const { client, calls } = createFakeHost({
      record: makeRecord(),
      stream: async (call) => {
        call.handlers.signal?.addEventListener('abort', () => {
          aborted = true
        })
        await new Promise<void>((resolve) => {
          call.handlers.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    })
    setHostClient(client)
    seedStore({ record: makeRecord(), runState: 'done' })
    mount()
    await flush()

    click(container.querySelector('[aria-label="重新精读"]'))
    await flush()
    expect(calls.streams).toHaveLength(1)
    expect(calls.streams[0]?.request.force).toBe(true)
    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('running')

    click(buttonByText('停止精读'))
    await flush()
    expect(aborted).toBe(true)
    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('report')
  })
})

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

describe('errors', () => {
  it('shows a run error above the previous report and retries', async () => {
    const record = makeRecord()
    const { client, calls } = createFakeHost({
      record,
      stream: async (call) => {
        for (const frame of happyFrames(record)) call.handlers.onFrame(frame)
      },
    })
    setHostClient(client)
    seedStore({ record, runState: 'error', error: '模型调用失败，重试一次。' })
    mount()
    await flush()

    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('report')
    const error = container.querySelector('.ln-deepread__error')
    expect(error?.textContent).toContain('精读没有完成')
    expect(error?.textContent).toContain('模型调用失败')
    expect(error?.textContent).toContain('上一次的精读报告仍可查看')
    expect(container.querySelector('.ln-deepread__report-title')).not.toBeNull()

    click(buttonByText('重试'))
    await flush()
    expect(calls.streams[0]?.request.force).toBe(true)
    expect(useDeepReadStore.getState().runState).toBe('done')
    expect(container.querySelector('.ln-deepread__error')).toBeNull()
  })

  it('shows an error card without a report when the first run fails', async () => {
    const record = makeRecord()
    const { client } = createFakeHost({
      stream: async (call) => {
        for (const frame of happyFrames(record)) call.handlers.onFrame(frame)
      },
    })
    setHostClient(client)
    seedStore({ runState: 'error', error: '模型不可用，检查 DSH 的默认模型配置。' })
    mount()
    await flush()

    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('error')
    const error = container.querySelector('.ln-deepread__error')
    expect(error?.textContent).toContain('模型不可用')
    expect(error?.textContent).not.toContain('上一次的精读报告')

    click(buttonByText('重试'))
    await flush()
    expect(useDeepReadStore.getState().runState).toBe('done')
    expect(container.querySelector('.ln-deepread__report-title')).not.toBeNull()
  })

  it('offers a reload when the record fetch fails', async () => {
    const { client, calls } = createFakeHost({ record: new Error('no record') })
    setHostClient(client)
    seedStore({ documentId: null, recordState: 'idle' })
    mount()
    await flush()

    expect(container.querySelector('.ln-deepread')?.getAttribute('data-state')).toBe('load-error')
    expect(container.querySelector('.ln-ai__state[data-tone="error"]')?.textContent).toContain('精读记录载入失败')
    expect(calls.records).toEqual(['doc-1'])

    click(buttonByText('重试'))
    await flush()
    expect(calls.records).toEqual(['doc-1', 'doc-1'])
  })
})
