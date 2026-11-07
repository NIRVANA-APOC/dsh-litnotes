// @vitest-environment happy-dom
/**
 * Reader store unit tests — load/parse lifecycle, annotation normalization +
 * whole-list saves with the `baseIds` merge baseline, AI refresh, translation
 * jobs and reading-position persistence. Exercised against the fake Host client
 * (no network, no DOM rendering).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Preferences } from '../../src/shared/model.ts'
import type { PaperModel } from '../../src/shared/markdown/model.ts'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { setHostClient } from '../../src/client/api/client.ts'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import {
  jumpToBlock,
  orderOf,
  refreshAnnotations,
  useReaderStore,
} from '../../src/client/reader/store.ts'
import {
  PAPER_CONTENT_LIST,
  PAPER_MARKDOWN,
  createFakeHost,
  makePreferences,
  makeSummary,
} from './reader-helpers.ts'
import type { FakeHostOptions } from './reader-helpers.ts'

/** Base (page-mark-free) model of the fixture paper. */
const BASE_MODEL: PaperModel = parseMarkdown(PAPER_MARKDOWN)

/** Key of the n-th paragraph. */
function paragraphKey(index: number): string {
  const paragraphs = BASE_MODEL.blocks.filter((block) => block.kind === 'paragraph')
  const block = paragraphs[index]
  if (block === undefined) throw new Error(`fixture has no paragraph ${index}`)
  return block.key
}

/** Open the store against a fresh fake host and settle the deferred build. */
async function openStore(
  options: FakeHostOptions = {},
  prefOverrides: Partial<Preferences> = {},
): Promise<{ fake: ReturnType<typeof createFakeHost>; state: ReturnType<typeof useReaderStore.getState> }> {
  const fake = createFakeHost(options)
  setHostClient(fake)
  useSettingsStore.setState({ preferences: makePreferences(prefOverrides), loaded: true, error: null })
  const opened = useReaderStore.getState().open(makeSummary())
  await vi.runAllTimersAsync()
  await opened
  return { fake, state: useReaderStore.getState() }
}

beforeEach(() => {
  vi.useFakeTimers()
  useReaderStore.getState().close()
  useUiStore.setState({ currentDocumentId: null, scene: 'read' })
})

afterEach(() => {
  useReaderStore.getState().close()
  vi.useRealTimers()
})

describe('reader store — open', () => {
  it('loads markdown and library.get in parallel and builds the shared model', async () => {
    const { fake, state } = await openStore()
    expect(state.phase).toBe('ready')
    expect(state.documentId).toBe('doc-1')
    expect(state.model.stats.words).toBeGreaterThan(500)
    expect(state.model.outline.length).toBeGreaterThan(5)
    expect(fake.lastCall('document.markdown')).toBeDefined()
    expect(fake.lastCall('library.get')).toBeDefined()
    expect(fake.calls.filter((call) => call.method === 'document.markdown').length).toBe(1)
  })

  it('applies page marks by preference and rebuilds when the preference flips', async () => {
    const { state } = await openStore({}, { showPageMarks: true })
    expect(state.model.blocks.some((block) => block.kind === 'page')).toBe(true)
    // Page marks never shift the original annotation anchors.
    expect(state.model.blocks.filter((block) => block.kind === 'page').length).toBeGreaterThan(1)
    const originalKeys = BASE_MODEL.blocks.map((block) => block.key)
    for (const key of originalKeys) expect(state.documentOrder.has(key)).toBe(true)
    useSettingsStore.setState({ preferences: makePreferences({ showPageMarks: false }) })
    useReaderStore.getState().rebuildModel()
    expect(useReaderStore.getState().model.blocks.some((block) => block.kind === 'page')).toBe(false)
  })

  it('normalizes annotations, keeps orphaned ones stale and flags unusable ones as dropped', async () => {
    const paragraph = paragraphKey(0)
    const { state } = await openStore({
      annotations: [
        { id: 'ann-normal', blockKey: paragraph, start: 0, end: 5, quote: 'Dense', color: 'sage', aspect: 'method', origin: 'user' },
        { id: 'ann-stale-key', blockKey: 'b99:dead', start: 0, end: 4, quote: 'gone', color: 'sky', origin: 'ai' },
        { id: 'ann-flagged', blockKey: paragraph, start: 0, end: 4, quote: 'gone', color: 'rose', stale: true, origin: 'user' },
      ],
    })
    expect(state.phase).toBe('ready')
    expect(state.annotations.map((annotation) => annotation.id)).toEqual(['ann-normal'])
    expect(state.staleAnnotations.map((annotation) => annotation.id).sort()).toEqual([
      'ann-flagged',
      'ann-stale-key',
    ])
    expect(state.annotationsByBlock.get(paragraph)?.length).toBe(1)
    expect(state.droppedAnnotations).toBe(0)
  })

  it('reports a failed load as phase=error without throwing', async () => {
    const fake = createFakeHost()
    const original = fake.call
    const failing = {
      ...fake,
      call: (method: Parameters<typeof fake.call>[0], payload: Parameters<typeof fake.call>[1]) => {
        if (method === 'document.markdown') return Promise.reject(new Error('boom'))
        return original(method, payload as never)
      },
    }
    setHostClient(failing as typeof fake)
    useSettingsStore.setState({ preferences: makePreferences(), loaded: true })
    const opened = useReaderStore.getState().open(makeSummary())
    await vi.runAllTimersAsync()
    await opened
    expect(useReaderStore.getState().phase).toBe('error')
    expect(useReaderStore.getState().error).toContain('boom')
  })
})

describe('reader store — annotations', () => {
  it('adds an annotation and saves the whole list with the baseIds merge baseline', async () => {
    const paragraph = paragraphKey(0)
    const existing = {
      id: 'ann-existing',
      blockKey: paragraph,
      start: 0,
      end: 5,
      quote: 'Dense',
      color: 'yellow' as const,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }
    const { fake } = await openStore({ annotations: [existing] })
    const store = useReaderStore.getState()
    const added = store.addAnnotation({
      blockKey: paragraph,
      start: 3,
      end: 9,
      quote: 'Dense ',
      color: 'sage',
    })
    expect(added).not.toBeNull()
    expect(added?.origin).toBe('user')
    await vi.advanceTimersByTimeAsync(900)
    const save = fake.lastCall('annotations.save')
    expect(save).toBeDefined()
    const payload = save?.payload as {
      id: string
      annotations: Array<{ id: string }>
      baseIds: string[]
    }
    expect(payload.id).toBe('doc-1')
    expect(payload.annotations.map((annotation) => annotation.id)).toContain('ann-existing')
    expect(payload.annotations.map((annotation) => annotation.id)).toContain(added?.id)
    expect(payload.baseIds).toContain('ann-existing')
  })

  it('clamps annotation offsets to the block plain text and rejects empty ranges', async () => {
    const paragraph = paragraphKey(0)
    await openStore()
    const store = useReaderStore.getState()
    const block = BASE_MODEL.blocks.find((candidate) => candidate.key === paragraph)
    const length = block?.plainText.length ?? 0
    const clamped = store.addAnnotation({
      blockKey: paragraph,
      start: -10,
      end: length + 100,
      quote: 'all',
      color: 'sky',
    })
    expect(clamped?.start).toBe(0)
    expect(clamped?.end).toBe(length)
    expect(
      store.addAnnotation({ blockKey: paragraph, start: 5, end: 5, quote: '', color: 'sky' }),
    ).toBeNull()
    expect(
      store.addAnnotation({ blockKey: 'missing', start: 0, end: 3, quote: 'x', color: 'sky' }),
    ).toBeNull()
  })

  it('keeps stale annotations in the save payload (never erases a note)', async () => {
    const stale = {
      id: 'ann-stale',
      blockKey: 'b99:dead',
      start: 0,
      end: 4,
      quote: 'gone',
      color: 'sky' as const,
      origin: 'ai' as const,
      stale: true,
    }
    const { fake } = await openStore({ annotations: [stale] })
    expect(useReaderStore.getState().staleAnnotations.map((item) => item.id)).toEqual(['ann-stale'])
    useReaderStore.getState().addAnnotation({
      blockKey: paragraphKey(0),
      start: 0,
      end: 3,
      quote: 'Den',
      color: 'yellow',
    })
    await vi.advanceTimersByTimeAsync(900)
    const payload = fake.lastCall('annotations.save')?.payload as {
      annotations: Array<{ id: string }>
      baseIds: string[]
    }
    expect(payload.annotations.map((item) => item.id)).toContain('ann-stale')
    expect(payload.baseIds).toContain('ann-stale')
  })

  it('adopts Host-merged concurrent additions returned by annotations.save', async () => {
    const paragraph = paragraphKey(1)
    const concurrent = {
      id: 'ann-concurrent',
      blockKey: paragraph,
      start: 0,
      end: 6,
      quote: 'Dense ',
      color: 'sky' as const,
      aspect: 'result' as const,
      origin: 'ai' as const,
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    }
    const { state } = await openStore({
      mergeAnnotations: (items) => [...items, concurrent],
    })
    expect(state.annotations.length).toBe(0)
    useReaderStore.getState().addAnnotation({
      blockKey: paragraph,
      start: 0,
      end: 4,
      quote: 'Dens',
      color: 'yellow',
    })
    await vi.advanceTimersByTimeAsync(900)
    const annotations = useReaderStore.getState().annotations
    expect(annotations.some((annotation) => annotation.id === 'ann-concurrent')).toBe(true)
    const concurrentEntry = annotations.find((annotation) => annotation.id === 'ann-concurrent')
    expect(concurrentEntry?.origin).toBe('ai')
    expect(concurrentEntry?.aspect).toBe('result')
  })

  it('refreshes annotations from the Host after the AI margin reports new ones', async () => {
    const paragraph = paragraphKey(2)
    const { fake } = await openStore()
    const injected = {
      id: 'ann-ai',
      blockKey: paragraph,
      start: 0,
      end: 5,
      quote: 'When ',
      color: 'sage' as const,
      aspect: 'method' as const,
      origin: 'ai' as const,
      createdAt: '2026-11-03T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z',
    }
    fake.setAnnotations([injected])
    await refreshAnnotations()
    expect(useReaderStore.getState().annotations.map((annotation) => annotation.id)).toEqual(['ann-ai'])
  })

  it('updates and deletes annotations through the same debounced save', async () => {
    const paragraph = paragraphKey(0)
    const existing = {
      id: 'ann-edit',
      blockKey: paragraph,
      start: 0,
      end: 5,
      quote: 'Dense',
      color: 'yellow' as const,
      note: '',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }
    const { fake } = await openStore({ annotations: [existing] })
    useReaderStore.getState().updateAnnotation('ann-edit', { note: 'my note', color: 'sage' })
    expect(useReaderStore.getState().annotations[0]?.note).toBe('my note')
    await vi.advanceTimersByTimeAsync(900)
    const saved = fake.lastCall('annotations.save')?.payload as {
      annotations: Array<{ id: string; note?: string }>
    }
    expect(saved.annotations[0]?.note).toBe('my note')
    useReaderStore.getState().deleteAnnotation('ann-edit')
    await vi.advanceTimersByTimeAsync(900)
    const afterDelete = fake.lastCall('annotations.save')?.payload as {
      annotations: Array<{ id: string }>
      baseIds: string[]
    }
    expect(afterDelete.annotations.some((annotation) => annotation.id === 'ann-edit')).toBe(false)
    expect(afterDelete.baseIds).toContain('ann-edit')
  })
})

describe('reader store — translations', () => {
  it('translates one block, records provider provenance and batches the save', async () => {
    const paragraph = paragraphKey(0)
    await openStore()
    await useReaderStore.getState().translateBlock(paragraph)
    const state = useReaderStore.getState()
    expect(typeof state.translations.entries[paragraph]).toBe('string')
    expect(state.translationProviders[paragraph]).toBe('google')
    expect(state.translationJobs[paragraph]).toBeUndefined()
    // Translating in original mode reveals the bilingual voice.
    expect(useSettingsStore.getState().preferences.readingMode).toBe('bilingual')
    await vi.advanceTimersByTimeAsync(1100)
    const { getHostClient } = await import('../../src/client/api/client.ts')
    const host = getHostClient() as ReturnType<typeof createFakeHost>
    const save = host.lastCall('translations.save')
    expect(save).toBeDefined()
    const payload = save?.payload as { entries: Record<string, string>; targetLanguage: string }
    expect(Object.keys(payload.entries)).toContain(paragraph)
    expect(payload.targetLanguage).toBe('zh')
  })

  it('marks a failed block translation as retryable and reports the failure', async () => {
    const paragraph = paragraphKey(0)
    await openStore({
      translate: () => {
        throw new Error('translate unavailable')
      },
    })
    await useReaderStore.getState().translateBlock(paragraph)
    const state = useReaderStore.getState()
    expect(state.translationJobs[paragraph]?.state).toBe('error')
    expect(state.notice?.key).toBe('read.error.translation')
    expect(state.translations.entries[paragraph]).toBeUndefined()
  })

  it('translates the whole paper with a progress state and a completion notice', async () => {
    await openStore({
      markdown: 'First paragraph here.\n\nSecond paragraph follows.\n\nThird one closes.',
    })
    await useReaderStore.getState().translateAllBlocks()
    const state = useReaderStore.getState()
    expect(state.translateAll).toBeNull()
    expect(Object.keys(state.translations.entries).length).toBe(3)
    expect(state.notice?.key).toBe('read.translation.done')
    await vi.advanceTimersByTimeAsync(1200)
  })

  it('does nothing (with a notice) when everything is already translated', async () => {
    const markdown = 'Only paragraph here.'
    const onlyBlock = parseMarkdown(markdown).blocks[0]
    if (onlyBlock === undefined) throw new Error('fixture block missing')
    await openStore({
      markdown,
      translations: {
        version: 1,
        targetLanguage: 'zh',
        entries: { [onlyBlock.key]: '已完成' },
      },
    })
    await useReaderStore.getState().translateAllBlocks()
    expect(useReaderStore.getState().notice?.key).toBe('read.translation.empty')
  })
})

describe('reader store — navigation', () => {
  it('exposes document order, jump requests and reading-position persistence', async () => {
    const paragraph = paragraphKey(3)
    const { fake } = await openStore()
    expect(orderOf(paragraph)).toBeTypeOf('number')
    expect(orderOf('missing')).toBeNull()
    jumpToBlock(paragraph)
    const request = useReaderStore.getState().jumpRequest
    expect(request?.blockKey).toBe(paragraph)
    expect(request?.flash).toBe(true)
    // Recording a position persists `lastBlockKey` host-side (throttled).
    useReaderStore.getState().recordPosition(paragraph)
    await vi.advanceTimersByTimeAsync(700)
    const update = fake.lastCall('settings.update')?.payload as {
      preferences: { lastBlockKey: string | null }
    }
    expect(update.preferences.lastBlockKey).toBe(paragraph)
  })

  it('restores the saved position synchronously for the document the host remembers', async () => {
    const paragraph = paragraphKey(2)
    const fake = createFakeHost()
    setHostClient(fake)
    useSettingsStore.setState({
      preferences: makePreferences({
        lastDocumentId: 'doc-restore',
        lastBlockKey: paragraph,
        showPageMarks: false,
      }),
      loaded: true,
    })
    const opened = useReaderStore.getState().open(makeSummary({ id: 'doc-restore' }))
    await vi.runAllTimersAsync()
    await opened
    expect(useReaderStore.getState().restoreBlockKey).toBe(paragraph)
  })

  it('keeps a per-document position in session memory ahead of the host preference', async () => {
    const first = paragraphKey(1)
    const second = paragraphKey(4)
    await openStore()
    useReaderStore.getState().recordPosition(second)
    // Simulate a document switch back to the same paper.
    useReaderStore.getState().close()
    const fake = createFakeHost()
    setHostClient(fake)
    useSettingsStore.setState({ preferences: makePreferences({ lastBlockKey: first, lastDocumentId: 'doc-1' }), loaded: true })
    const opened = useReaderStore.getState().open(makeSummary())
    await vi.runAllTimersAsync()
    await opened
    expect(useReaderStore.getState().restoreBlockKey).toBe(second)
  })
})

describe('reader store — lifecycle', () => {
  it('close() flushes and resets the store', async () => {
    await openStore()
    useReaderStore.getState().close()
    const state = useReaderStore.getState()
    expect(state.phase).toBe('empty')
    expect(state.documentId).toBeNull()
    expect(state.model.blocks.length).toBe(0)
    expect(state.annotations.length).toBe(0)
  })

  it('uses the fixture content list to place page marks', async () => {
    await openStore()
    const pages = useReaderStore.getState().model.blocks.filter((block) => block.kind === 'page')
    expect(pages.length).toBeGreaterThan(0)
    expect(PAPER_CONTENT_LIST.length).toBeGreaterThan(10)
    expect(useReaderStore.getState().pages).toBe(6)
  })
})
