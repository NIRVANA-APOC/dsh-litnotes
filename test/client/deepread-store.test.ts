// @vitest-environment happy-dom
/**
 * AI 精读 store tests: record load/adopt/error, scripted NDJSON frames
 * (start/progress/report/annotations/usage/done/error), stop/abort, retry,
 * dismiss, document switching and the pure report helpers.
 *
 * The Host client is a scripted fake emitting exactly the frames the Host
 * emits (`src/shared/model.ts` `DeepReadFrame`); no server and no real fetch.
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
import type {
  DeepReadFrame,
  DeepReadHighlight,
  DeepReadRecord,
  DeepReadReport,
  DeepReadRequest,
} from '../../src/shared/model.ts'
import type { AiTranslate } from '../../src/client/ai/chat.ts'
import {
  blockPageMap,
  buildDeepReadMarkdown,
  deepReadErrorMessage,
  evidenceRefs,
  reportPointGroups,
} from '../../src/client/ai/deepread.ts'
import { setDeepReadTranslate, useDeepReadStore } from '../../src/client/ai/deepread-store.ts'
import { provideLocale } from '../../src/client/shell/locale-context.ts'
import { zh as deepreadZh } from '../../src/client/i18n/deepread.ts'
import { useUiStore } from '../../src/client/state/ui.ts'

/* -------------------------------------------------------------------------- */
/* Locale                                                                     */
/* -------------------------------------------------------------------------- */

/** Interpolate `{name}` templates the way the Host locale service does. */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

const ZH_COPY = deepreadZh as unknown as Record<string, string>

/** String-keyed translate over the real zh deep-read dictionary. */
const fakeT: AiTranslate = (key, params) => interpolate(ZH_COPY[key] ?? key, params)

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
    note: 'Attention replaces recurrence; the cost depends on sequence length.',
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
    note: 'The headline number; it depends on the reported single-run protocol.',
    importance: 4,
    section: 'Results',
    kind: 'result',
  },
]

const REPORT: DeepReadReport = {
  tldr: ['The paper proposes a recurrence-free sequence model built on attention.'],
  problem: { label: 'Modeling long sequences', detail: 'Recurrent models serialize computation.', blockKeys: ['b12:abc'] },
  gap: { label: '', detail: 'No prior work removes recurrence entirely.', blockKeys: ['b20:def'] },
  contributions: [
    {
      label: 'Self-attention architecture',
      detail: 'A transformer built only from attention and feed-forward layers.',
      blockKeys: ['b12:abc'],
      evidence: 'strong',
    },
  ],
  method: [
    { label: 'Scaled dot-product', detail: 'Query/key/value attention with scaling.', blockKeys: ['b12:abc'] },
  ],
  evaluation: [
    { label: 'WMT 2014', detail: 'BLEU comparison against recurrent baselines.', blockKeys: ['b20:def'] },
  ],
  findings: [
    { label: 'Faster training', detail: 'Attention trains in fewer steps.', blockKeys: ['b12:abc'] },
  ],
  limitations: [
    { label: 'Single-run numbers', detail: 'Variance across seeds is not reported.', blockKeys: ['b20:def'] },
  ],
  openQuestions: [
    { label: 'Longer contexts', detail: 'Cost at 10k tokens remains untested.', blockKeys: [] },
  ],
  argumentMap: [{ from: 'Attention only', to: 'Lower BLEU cost', relation: 'supports' }],
  glossary: [{ term: 'Self-attention', definition: 'Attention over one sequence.', blockKeys: ['b12:abc'] }],
  readingPath: ['Read §3.2 for the attention mechanism.', 'Read Table 2 for the results.'],
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

/* -------------------------------------------------------------------------- */
/* Fake host                                                                  */
/* -------------------------------------------------------------------------- */

/** One recorded `deepread` stream call. */
interface StreamCall {
  request: DeepReadRequest
  handlers: { onFrame: (frame: DeepReadFrame) => void; signal?: AbortSignal }
}

/** Recorded fake-host traffic. */
interface Calls {
  records: string[]
  streams: StreamCall[]
}

/** Options of the scripted fake host. */
interface FakeHostOptions {
  record?: DeepReadRecord | null | ((documentId: string) => DeepReadRecord | null)
  recordError?: Error
  stream?: (call: StreamCall) => Promise<void>
}

/** Build a Host client whose only implemented methods are the deep-read pair. */
function createFakeHost(options: FakeHostOptions = {}): { client: HostClient; calls: Calls } {
  const calls: Calls = { records: [], streams: [] }
  const client: HostClient = {
    base: 'http://localhost/dsh-litnotes/api',
    async call<K extends ApiMethod>(method: K, payload: ApiRequests[K]): Promise<ApiResults[K]> {
      if (method === 'deepread.get') {
        const request = payload as ApiRequests['deepread.get']
        calls.records.push(request.documentId)
        if (options.recordError !== undefined) throw options.recordError
        const record =
          typeof options.record === 'function'
            ? options.record(request.documentId)
            : options.record === undefined
              ? null
              : options.record
        return { record } as unknown as ApiResults[K]
      }
      throw new Error(`unexpected method ${String(method)}`)
    },
    async stream<K extends StreamMethod>(
      _method: K,
      request: StreamMethods[K]['request'],
      handlers: {
        onFrame: (frame: StreamMethods[K]['frame']) => void
        signal?: AbortSignal
      },
    ): Promise<void> {
      const call: StreamCall = {
        request: request as DeepReadRequest,
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

/** Emit the documented happy-path frames for one finished run. */
function happyFrames(record: DeepReadRecord, created = 2): DeepReadFrame[] {
  return [
    { type: 'start', model: { provider: 'deepseek', model: 'deepseek-flash' }, language: 'zh' },
    { type: 'progress', phase: 'mapping', done: 0, total: 1 },
    { type: 'progress', phase: 'reading', done: 2, total: 4, section: 'Introduction' },
    { type: 'progress', phase: 'synthesizing', done: 1, total: 1 },
    { type: 'report', record },
    { type: 'annotations', created, highlights: record.highlights },
    { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } },
    { type: 'done' },
  ]
}

/** A stream that never finishes until its signal aborts. */
function hangingStream(call: StreamCall): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    call.handlers.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function resetStore(): void {
  useDeepReadStore.setState({
    documentId: null,
    record: null,
    recordState: 'idle',
    runState: 'idle',
    progress: null,
    error: null,
    busy: false,
    annotationsCreated: 0,
  })
  useDeepReadStore.getState().setHostHooks({})
  setDeepReadTranslate(fakeT)
  useUiStore.setState({ toasts: [] })
  provideLocale(() => 'en')
}

beforeEach(() => resetStore())
afterEach(() => {
  useDeepReadStore.getState().stop()
  resetStore()
})

/* -------------------------------------------------------------------------- */
/* Record load                                                                */
/* -------------------------------------------------------------------------- */

describe('record load', () => {
  it('adopts a cached record from deepread.get', async () => {
    const record = makeRecord('doc-1')
    const { client, calls } = createFakeHost({ record })
    setHostClient(client)
    await useDeepReadStore.getState().load('doc-1')
    const state = useDeepReadStore.getState()
    expect(calls.records).toEqual(['doc-1'])
    expect(state.documentId).toBe('doc-1')
    expect(state.recordState).toBe('ready')
    expect(state.runState).toBe('done')
    expect(state.record?.documentId).toBe('doc-1')
    expect(state.record?.highlights).toHaveLength(2)
    expect(state.busy).toBe(false)
  })

  it('keeps the idle CTA when the paper was never deep-read', async () => {
    setHostClient(createFakeHost({ record: null }).client)
    await useDeepReadStore.getState().load('doc-1')
    const state = useDeepReadStore.getState()
    expect(state.recordState).toBe('ready')
    expect(state.record).toBeNull()
    expect(state.runState).toBe('idle')
  })

  it('settles a host failure as a record error instead of throwing', async () => {
    setHostClient(createFakeHost({ recordError: new ApiError('network', 'cannot reach host') }).client)
    await expect(useDeepReadStore.getState().load('doc-1')).resolves.toBeUndefined()
    const state = useDeepReadStore.getState()
    expect(state.recordState).toBe('error')
    expect(state.record).toBeNull()
    expect(state.error).toBeNull()
  })

  it('dedupes a repeated load of the same document', async () => {
    const { client, calls } = createFakeHost({ record: makeRecord('doc-1') })
    setHostClient(client)
    await useDeepReadStore.getState().load('doc-1')
    await useDeepReadStore.getState().load('doc-1')
    expect(calls.records).toEqual(['doc-1'])
  })

  it('normalizes a malformed record instead of dropping it', async () => {
    const corrupt = { documentId: 'doc-1' } as unknown as DeepReadRecord
    setHostClient(createFakeHost({ record: corrupt }).client)
    await useDeepReadStore.getState().load('doc-1')
    const record = useDeepReadStore.getState().record
    expect(record).not.toBeNull()
    expect(record?.report.tldr).toEqual([])
    expect(record?.report.contributions).toEqual([])
    expect(record?.highlights).toEqual([])
    expect(record?.stats.coverage).toBe(0)
  })

  it('drops the previous record when switching documents', async () => {
    const { client } = createFakeHost({
      record: (documentId) => (documentId === 'doc-1' ? makeRecord('doc-1') : null),
    })
    setHostClient(client)
    await useDeepReadStore.getState().load('doc-1')
    await useDeepReadStore.getState().load('doc-2')
    const state = useDeepReadStore.getState()
    expect(state.documentId).toBe('doc-2')
    expect(state.record).toBeNull()
    expect(state.runState).toBe('idle')
  })
})

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

describe('streaming run', () => {
  it('applies every frame, sends the reader language, notifies and toasts', async () => {
    provideLocale(() => 'zh')
    const record = makeRecord('doc-1')
    const annotationsChanged = vi.fn()
    useDeepReadStore.getState().setHostHooks({ onAnnotationsChanged: annotationsChanged })
    const { client, calls } = createFakeHost({
      stream: async (call) => {
        for (const frame of happyFrames(record)) call.handlers.onFrame(frame)
      },
    })
    setHostClient(client)

    await useDeepReadStore.getState().start('doc-1')
    const state = useDeepReadStore.getState()

    expect(calls.streams).toHaveLength(1)
    expect(calls.streams[0]?.request).toEqual({ documentId: 'doc-1', language: 'zh' })
    expect(state.documentId).toBe('doc-1')
    expect(state.runState).toBe('done')
    expect(state.recordState).toBe('ready')
    expect(state.record?.documentId).toBe('doc-1')
    expect(state.annotationsCreated).toBe(2)
    expect(state.progress).toBeNull()
    expect(state.busy).toBe(false)
    expect(state.error).toBeNull()
    expect(annotationsChanged).toHaveBeenCalledTimes(1)
    const toasts = useUiStore.getState().toasts.map((toast) => toast.text)
    expect(toasts.some((text) => text.includes('精读完成：生成 2 条批注'))).toBe(true)
  })

  it('renders progress mid-run and stop aborts a run that had no record', async () => {
    let emit: ((frame: DeepReadFrame) => void) | null = null
    let aborted = false
    const { client } = createFakeHost({
      stream: async (call) => {
        emit = call.handlers.onFrame
        call.handlers.signal?.addEventListener('abort', () => {
          aborted = true
        })
        await hangingStream(call)
      },
    })
    setHostClient(client)
    const pending = useDeepReadStore.getState().start('doc-1')
    await Promise.resolve()
    expect(useDeepReadStore.getState().runState).toBe('running')
    expect(useDeepReadStore.getState().busy).toBe(true)

    const send = (frame: DeepReadFrame): void => emit?.(frame)
    send({ type: 'progress', phase: 'reading', done: 2, total: 5, section: 'Method' })
    expect(useDeepReadStore.getState().progress).toEqual({
      phase: 'reading',
      done: 2,
      total: 5,
      section: 'Method',
    })

    useDeepReadStore.getState().stop()
    await pending
    const state = useDeepReadStore.getState()
    expect(aborted).toBe(true)
    expect(state.busy).toBe(false)
    expect(state.runState).toBe('idle')
    expect(state.record).toBeNull()
    expect(state.progress).toBeNull()
    expect(state.error).toBeNull()
  })

  it('keeps a previous record when a forced rerun is stopped', async () => {
    const record = makeRecord('doc-1')
    setHostClient(
      createFakeHost({
        record,
        stream: async (call) => {
          await hangingStream(call)
        },
      }).client,
    )
    await useDeepReadStore.getState().load('doc-1')
    const pending = useDeepReadStore.getState().start('doc-1', { force: true })
    await Promise.resolve()
    useDeepReadStore.getState().stop()
    await pending
    const state = useDeepReadStore.getState()
    expect(state.record?.documentId).toBe('doc-1')
    expect(state.runState).toBe('done')
    expect(state.busy).toBe(false)
  })

  it('surfaces an error frame as localized copy', async () => {
    const { client } = createFakeHost({
      stream: async (call) => {
        call.handlers.onFrame({ type: 'start', model: { provider: 'p', model: 'm' }, language: 'zh' })
        call.handlers.onFrame({ type: 'error', code: 'llm-failed', message: 'boom' })
      },
    })
    setHostClient(client)
    await useDeepReadStore.getState().start('doc-1')
    const state = useDeepReadStore.getState()
    expect(state.runState).toBe('error')
    expect(state.error).toBe(ZH_COPY['deepread.error.llmFailed'])
    expect(state.busy).toBe(false)
    expect(state.progress).toBeNull()
  })

  it('normalizes a thrown transport failure into the same error state', async () => {
    const { client } = createFakeHost({
      stream: async () => {
        throw new ApiError('network', 'cannot reach host')
      },
    })
    setHostClient(client)
    await useDeepReadStore.getState().start('doc-1')
    const state = useDeepReadStore.getState()
    expect(state.runState).toBe('error')
    expect(state.error).toBe(ZH_COPY['deepread.error.network'])
  })

  it('retries with force and dismisses the error', async () => {
    const record = makeRecord('doc-1')
    let runs = 0
    const { client, calls } = createFakeHost({
      record,
      stream: async (call) => {
        runs += 1
        if (runs === 1) {
          call.handlers.onFrame({ type: 'error', code: 'llm-failed', message: '' })
          return
        }
        for (const frame of happyFrames(record)) call.handlers.onFrame(frame)
      },
    })
    setHostClient(client)
    await useDeepReadStore.getState().load('doc-1')
    await useDeepReadStore.getState().start('doc-1')
    expect(useDeepReadStore.getState().runState).toBe('error')
    expect(useDeepReadStore.getState().record).not.toBeNull()

    useDeepReadStore.getState().dismissError()
    expect(useDeepReadStore.getState().error).toBeNull()
    expect(useDeepReadStore.getState().runState).toBe('done')

    // Recreate the failure to exercise retry from the error state.
    useDeepReadStore.setState({ runState: 'error', error: 'boom' })
    await useDeepReadStore.getState().retry()
    expect(calls.streams).toHaveLength(2)
    expect(calls.streams[1]?.request.force).toBe(true)
    expect(useDeepReadStore.getState().runState).toBe('done')
  })

  it('uses the record highlight count for a cached replay without annotation frames', async () => {
    const record = makeRecord('doc-1')
    const { client } = createFakeHost({
      stream: async (call) => {
        call.handlers.onFrame({ type: 'progress', phase: 'mapping', done: 0, total: 1 })
        call.handlers.onFrame({ type: 'progress', phase: 'done', done: 1, total: 1 })
        call.handlers.onFrame({ type: 'report', record })
        call.handlers.onFrame({ type: 'done' })
      },
    })
    setHostClient(client)
    useUiStore.setState({ toasts: [] })
    await useDeepReadStore.getState().start('doc-1', { force: true })
    const state = useDeepReadStore.getState()
    expect(state.annotationsCreated).toBe(2)
    expect(useUiStore.getState().toasts.some((toast) => toast.text.includes('2 条批注'))).toBe(true)
  })

  it('abandons an in-flight run when the document switches', async () => {
    let aborted = false
    const { client } = createFakeHost({
      record: (documentId) => (documentId === 'doc-2' ? makeRecord('doc-2') : null),
      stream: async (call) => {
        call.handlers.signal?.addEventListener('abort', () => {
          aborted = true
        })
        await hangingStream(call)
      },
    })
    setHostClient(client)
    const pending = useDeepReadStore.getState().start('doc-1')
    await Promise.resolve()
    await useDeepReadStore.getState().load('doc-2')
    await pending
    const state = useDeepReadStore.getState()
    expect(aborted).toBe(true)
    expect(state.documentId).toBe('doc-2')
    expect(state.record?.documentId).toBe('doc-2')
    expect(state.runState).toBe('done')
    expect(state.busy).toBe(false)
  })

  it('ignores a start without a document id', async () => {
    const { client, calls } = createFakeHost()
    setHostClient(client)
    await useDeepReadStore.getState().start('')
    expect(calls.streams).toHaveLength(0)
    expect(useDeepReadStore.getState().runState).toBe('idle')
  })
})

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

describe('deep-read helpers', () => {
  it('builds the blockKey → page map and deduped evidence refs', () => {
    const record = makeRecord('doc-1')
    const pages = blockPageMap(record)
    expect(pages.get('b12:abc')).toBe(4)
    expect(pages.get('b20:def')).toBe(6)
    const refs = evidenceRefs(['b12:abc', 'b12:abc', '', 'missing', 'b20:def'], pages)
    expect(refs).toEqual([
      { blockKey: 'b12:abc', page: 4 },
      { blockKey: 'missing', page: null },
      { blockKey: 'b20:def', page: 6 },
    ])
  })

  it('groups report sections in order and omits empty ones', () => {
    const groups = reportPointGroups(REPORT)
    expect(groups.map((group) => group.id)).toEqual([
      'problem',
      'gap',
      'contributions',
      'method',
      'evaluation',
      'findings',
      'limitations',
      'openQuestions',
    ])
    const noGap: DeepReadReport = {
      ...REPORT,
      gap: { label: '', detail: '', blockKeys: [] },
      openQuestions: [],
    }
    expect(reportPointGroups(noGap).map((group) => group.id)).not.toContain('gap')
    expect(reportPointGroups(noGap).map((group) => group.id)).not.toContain('openQuestions')
  })

  it('maps failure codes to localized copy and passes unknown messages through', () => {
    expect(deepReadErrorMessage(fakeT, 'llm-unavailable', '')).toBe(ZH_COPY['deepread.error.llmUnavailable'])
    expect(deepReadErrorMessage(fakeT, 'aborted', '')).toBe(ZH_COPY['deepread.error.aborted'])
    expect(deepReadErrorMessage(fakeT, 'weird-code', 'host says no')).toBe('host says no')
    expect(deepReadErrorMessage(fakeT, 'weird-code', '')).toBe(ZH_COPY['deepread.error.generic'])
  })

  it('exports the report and annotation cards as Markdown', () => {
    const result = buildDeepReadMarkdown(makeRecord('doc-1'), { t: fakeT })
    expect(result).not.toBeNull()
    expect(result?.filename).toBe('deepread-report.md')
    const markdown = result?.markdown ?? ''
    expect(markdown).toContain('# 精读报告')
    expect(markdown).toContain('## 一句话结论')
    expect(markdown).toContain('The paper proposes a recurrence-free sequence model built on attention.')
    expect(markdown).toContain('## 核心贡献')
    expect(markdown).toContain('**Self-attention architecture**')
    expect(markdown).toContain('原文 p.4')
    expect(markdown).toContain('## 本次批注')
    expect(markdown).toContain('Scaled dot-product attention')
    expect(markdown).toContain('模型')
    expect(buildDeepReadMarkdown(null, { t: fakeT })).toBeNull()
  })

  it('uses the paper title in the export heading and filename when given', () => {
    const result = buildDeepReadMarkdown(makeRecord('doc-1'), { title: 'Attention Is All You Need', t: fakeT })
    expect(result?.filename).toBe('Attention Is All You Need.md')
    expect(result?.markdown).toContain('# Attention Is All You Need — 精读报告')
  })
})
