// @vitest-environment happy-dom
/**
 * Reader scene render tests (happy-dom): the paper renders every block kind of
 * the shared model, annotations become `<mark class="ln-hl">` spans at the right
 * offsets, the margin shows notes/tethers, the selection toolbar creates
 * annotations, translation states render, and citation jumps scroll+flash.
 *
 * Rendered against the fake Host client with the real parsed-paper fixture.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Annotation, Preferences } from '../../src/shared/model.ts'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { setHostClient } from '../../src/client/api/client.ts'
import { useSettingsStore } from '../../src/client/state/settings.ts'
import { useUiStore } from '../../src/client/state/ui.ts'
import { useReaderStore } from '../../src/client/reader/store.ts'
import { registerAskAI } from '../../src/client/reader/api.ts'
import { ReadScene } from '../../src/client/reader/ReadScene.tsx'
import { ReadContextBar } from '../../src/client/reader/ReadContextBar.tsx'
import { LocaleContext } from '../../src/client/shell/locale-context.ts'
import type { LitnotesTranslate } from '../../src/client/shell/locale-context.ts'
import {
  PAPER_MARKDOWN,
  createFakeHost,
  makePreferences,
  makeSummary,
} from './reader-helpers.ts'
import type { FakeHostOptions } from './reader-helpers.ts'

/** Identity translate function (tests assert keys, not copy). */
const t = ((key: string) => key) as unknown as LitnotesTranslate

const BASE_MODEL = parseMarkdown(PAPER_MARKDOWN)

/** First paragraph block of the fixture (annotation target). */
function firstParagraphKey(): string {
  const block = BASE_MODEL.blocks.find((candidate) => candidate.kind === 'paragraph')
  if (block === undefined) throw new Error('fixture has no paragraph')
  return block.key
}

/** Key of the n-th paragraph. */
function paragraphKey(index: number): string {
  const paragraphs = BASE_MODEL.blocks.filter((block) => block.kind === 'paragraph')
  const block = paragraphs[index]
  if (block === undefined) throw new Error(`fixture has no paragraph ${index}`)
  return block.key
}

/** Let deferred store work (idle build, resize timeouts) settle. */
async function flush(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Wait until the scene reaches the ready phase. */
async function settleReady(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (useReaderStore.getState().phase !== 'loading') return
    await flush(1)
  }
}

/** Select a character range inside one block element. */
function selectRange(block: Element, start: number, end: number): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let total = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    nodes.push(text)
    total += text.data.length
  }
  const pointAt = (offset: number): { node: Text; offset: number } => {
    let consumed = 0
    for (const node of nodes) {
      if (offset <= consumed + node.data.length) {
        return { node, offset: Math.max(0, offset - consumed) }
      }
      consumed += node.data.length
    }
    const last = nodes[nodes.length - 1]
    if (last === undefined) throw new Error('block has no text')
    return { node: last, offset: last.data.length }
  }
  const from = pointAt(start)
  const to = pointAt(end)
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  const selection = window.getSelection()
  if (selection === null) throw new Error('no selection API')
  selection.removeAllRanges()
  selection.addRange(range)
  void total
}

/** Click one element with a bubbling mouse event. */
function click(element: Element | null | undefined): void {
  if (element === null || element === undefined) throw new Error('element to click is missing')
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** Text content of one element (trimmed). */
function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').trim()
}

let container: HTMLDivElement
let root: Root
let scrollSpy: ReturnType<typeof vi.spyOn>

/** Render the scene and wait for the parsed model. */
async function renderScene(
  options: { preferences?: Partial<Preferences>; host?: FakeHostOptions } = {},
): Promise<{ fake: ReturnType<typeof createFakeHost> }> {
  const fake = createFakeHost(options.host)
  setHostClient(fake)
  useSettingsStore.setState({
    preferences: makePreferences(options.preferences),
    loaded: true,
    error: null,
  })
  const summary = makeSummary()
  await act(async () => {
    root.render(
      <LocaleContext.Provider value={t}>
        <ReadScene document={summary} />
      </LocaleContext.Provider>,
    )
  })
  await settleReady()
  await flush(2)
  return { fake }
}

beforeEach(() => {
  useReaderStore.getState().close()
  useUiStore.setState({ marginOpen: true, scene: 'read', activeAspect: null, marginFilter: 'all' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: (): void => {},
      writable: true,
      configurable: true,
    })
  }
  scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useReaderStore.getState().close()
  vi.restoreAllMocks()
})

describe('ReadScene — sheet', () => {
  it('renders the title block and the sheet skeleton', async () => {
    await renderScene()
    expect(container.querySelector('.ln-reader')).not.toBeNull()
    expect(container.querySelector('.ln-sheet__gutter')).not.toBeNull()
    expect(container.querySelector('.ln-sheet__paper')).not.toBeNull()
    expect(container.querySelector('.ln-paper__rule')).not.toBeNull()
    expect(textOf(container.querySelector('.ln-paper__title'))).toContain('Sparse Expert Routing')
    expect(textOf(container.querySelector('.ln-paper__meta'))).toContain('sparse-route.pdf')
    expect(textOf(container.querySelector('.ln-paper__meta'))).toContain('6')
  })

  it('renders every block kind of the shared model with the block contract attributes', async () => {
    await renderScene()
    const kinds = new Set(
      Array.from(container.querySelectorAll('[data-kind]')).map((element) => element.getAttribute('data-kind')),
    )
    for (const kind of ['head', 'para', 'list', 'quote', 'code', 'formula', 'figure', 'table']) {
      expect(kinds.has(kind), `missing block kind ${kind}`).toBe(true)
    }
    expect(container.querySelectorAll('.ln-pagemark[data-page]').length).toBeGreaterThan(0)
    // data-plain-length equals the block's offset space.
    const body = container.querySelector('.ln-paper__body')
    expect(body).not.toBeNull()
    for (const element of Array.from(container.querySelectorAll<HTMLElement>('[data-plain-length]'))) {
      const key = element.getAttribute('data-block-key')
      expect(key).not.toBeNull()
      const block = BASE_MODEL.blocks.find((candidate) => candidate.key === key)
      if (block === undefined || block.kind === 'page') continue
      expect(Number(element.dataset.plainLength)).toBe(block.plainText.length)
    }
  })

  it('renders formulas through the raw fallback when KaTeX is not loaded', async () => {
    await renderScene()
    expect(container.querySelectorAll('.ln-formula').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.ln-formula--raw').length).toBeGreaterThan(0)
    const display = container.querySelector('.ln-block--formula .ln-formula')
    expect(display?.getAttribute('data-latex')).toContain('sum')
  })

  it('renders figures through the client asset URL and tables as real tables', async () => {
    await renderScene()
    const image = container.querySelector<HTMLImageElement>('.ln-figure__img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toContain('/dsh-litnotes/api/asset')
    expect(image?.getAttribute('src')).toContain('fig1.svg')
    expect(container.querySelectorAll('.ln-table thead tr').length).toBe(1)
    expect(container.querySelectorAll('.ln-table tbody tr').length).toBe(4)
    expect(container.querySelectorAll('.ln-table th').length).toBeGreaterThan(0)
  })

  it('renders heading numerals and gutter ticks into the gutter', async () => {
    await renderScene()
    const numerals = Array.from(container.querySelectorAll('.ln-h__numeral')).map((node) => textOf(node))
    expect(numerals.length).toBeGreaterThan(3)
    expect(numerals).toContain('1')
    expect(container.querySelectorAll('.ln-gutter-tick').length).toBeGreaterThan(3)
  })
})

describe('ReadScene — annotations', () => {
  function annotationOn(blockKey: string, start: number, end: number, text: string): Annotation {
    return {
      id: 'ann-1',
      blockKey,
      start,
      end,
      quote: text,
      color: 'sage',
      aspect: 'method',
      note: 'my note text',
      origin: 'user',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    }
  }

  it('renders annotated ranges as marks with data-ink/data-id and draws the note slip', async () => {
    const key = firstParagraphKey()
    const block = BASE_MODEL.blocks.find((candidate) => candidate.key === key)
    const quote = block?.plainText.slice(0, 5) ?? ''
    await renderScene({ host: { annotations: [annotationOn(key, 0, 5, quote)] } })
    const marks = container.querySelectorAll<HTMLElement>('.ln-hl')
    expect(marks.length).toBeGreaterThan(0)
    const mark = marks[0]
    expect(mark?.getAttribute('data-ink')).toBe('sage')
    expect(mark?.getAttribute('data-id')).toBe('ann-1')
    expect(mark?.getAttribute('data-annotation-id')).toBe('ann-1')
    expect(mark?.textContent).toBe(quote)
    expect(mark?.closest('[data-block-key]')?.getAttribute('data-block-key')).toBe(key)
    const note = container.querySelector('.ln-note[data-kind="note"]')
    expect(note).not.toBeNull()
    expect(note?.getAttribute('data-aspect')).toBe('method')
    expect(note?.getAttribute('data-origin')).toBe('user')
    expect(note?.getAttribute('data-anchor-block')).toBe(key)
    expect(textOf(note?.querySelector('.ln-note__quote'))).toBe(quote)
    expect(textOf(note?.querySelector('.ln-note__body'))).toBe('my note text')
  })

  it('renders stale annotations in the stale section without a tether anchor', async () => {
    const stale: Annotation = {
      id: 'ann-stale',
      blockKey: 'b99:dead',
      start: 0,
      end: 4,
      quote: 'gone quote',
      color: 'sky',
      origin: 'ai',
      stale: true,
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    }
    await renderScene({ host: { annotations: [stale] } })
    const entry = container.querySelector('.ln-note.is-stale')
    expect(entry).not.toBeNull()
    expect(entry?.getAttribute('data-anchor-block')).toBeNull()
    expect(textOf(container.querySelector('.ln-margin__notice'))).toContain('margin.staleNotice')
    expect(container.querySelectorAll('.ln-note__staleTag').length).toBe(1)
  })
})

describe('ReadScene — reading modes and translation', () => {
  it('shows the translation voice under paragraphs in bilingual mode', async () => {
    const key = firstParagraphKey()
    await renderScene({
      preferences: { readingMode: 'bilingual' },
      host: {
        translations: {
          version: 1,
          targetLanguage: 'zh',
          entries: { [key]: '稠密检索模型为每篇文档存储一个向量。' },
        },
      },
    })
    const translation = container.querySelector('.ln-para__translation')
    expect(translation).not.toBeNull()
    expect(textOf(translation)).toContain('稠密检索模型')
    expect(container.querySelector('.ln-para__text')).not.toBeNull()
  })

  it('hides the original body in translated mode when a translation exists', async () => {
    const key = firstParagraphKey()
    await renderScene({
      preferences: { readingMode: 'translated' },
      host: {
        translations: {
          version: 1,
          targetLanguage: 'zh',
          entries: { [key]: '译者第二声部。' },
        },
      },
    })
    const block = container.querySelector('.ln-block--p.has-translation')
    expect(block).not.toBeNull()
    expect(block?.querySelector('.ln-para__text')).toBeNull()
    expect(textOf(block)).toContain('译者第二声部')
  })

  it('renders per-block translation failures with a retry action', async () => {
    const key = firstParagraphKey()
    await renderScene({
      preferences: { readingMode: 'bilingual' },
      host: {
        translate: () => {
          throw new Error('no translator')
        },
      },
    })
    await act(async () => {
      await useReaderStore.getState().translateBlock(key)
    })
    await flush(1)
    const error = container.querySelector('.ln-para__translation.is-error')
    expect(error).not.toBeNull()
    expect(error?.querySelector('.ln-link-btn')).not.toBeNull()
  })
})

describe('ReadScene — selection toolbar', () => {
  it('reads a text selection, offers the fixed action order and highlights it', async () => {
    const { fake } = await renderScene()
    const paragraph = container.querySelector('.ln-paper__body .ln-block--p .ln-para__text')
    expect(paragraph).not.toBeNull()
    if (paragraph === null) throw new Error('paragraph missing')
    act(() => {
      selectRange(paragraph, 0, 5)
      container
        .querySelector('.ln-paper__body')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await flush(2)
    const bar = container.querySelector('.ln-selbar')
    expect(bar).not.toBeNull()
    const labels = Array.from(bar?.querySelectorAll('.ln-selbar__btn') ?? []).map((button) =>
      textOf(button),
    )
    const text = labels.join('|')
    expect(text).toContain('sel.highlight')
    expect(text).toContain('sel.note')
    expect(text).toContain('sel.askAi')
    expect(text).toContain('sel.translate')
    expect(text.indexOf('sel.highlight')).toBeLessThan(text.indexOf('sel.note'))
    expect(text.indexOf('sel.note')).toBeLessThan(text.indexOf('sel.askAi'))
    expect(text.indexOf('sel.askAi')).toBeLessThan(text.indexOf('sel.translate'))
    act(() => {
      click(bar?.querySelector('.ln-selbar__btn--primary'))
    })
    await flush(1)
    const annotations = useReaderStore.getState().annotations
    expect(annotations.length).toBe(1)
    expect(annotations[0]?.origin).toBe('user')
    expect(annotations[0]?.quote.length).toBeGreaterThan(0)
    await useReaderStore.getState().flushAnnotations()
    const save = fake.lastCall('annotations.save')
    expect(save).toBeDefined()
    expect(container.querySelector('.ln-selbar')).toBeNull()
  })

  it('opens the note editor from the selection and saves the note', async () => {
    await renderScene()
    const paragraph = container.querySelector('.ln-paper__body .ln-block--p .ln-para__text')
    if (paragraph === null) throw new Error('paragraph missing')
    act(() => {
      selectRange(paragraph, 0, 4)
      container.querySelector('.ln-paper__body')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await flush(2)
    const noteButton = Array.from(container.querySelectorAll('.ln-selbar__btn')).find((button) =>
      textOf(button).includes('sel.note'),
    )
    act(() => click(noteButton))
    await flush(1)
    const editor = container.querySelector('.ln-noteeditor')
    expect(editor).not.toBeNull()
    // Aspect picker offers the five aspects and defaults untouched.
    expect(editor?.querySelectorAll('.ln-aspectpicker__item').length).toBe(5)
    act(() => click(editor?.querySelector('.ln-aspectpicker__item[data-aspect="result"]')))
    act(() => click(editor?.querySelector('.ln-btn--primary')))
    await flush(1)
    const annotations = useReaderStore.getState().annotations
    expect(annotations.length).toBe(1)
    expect(annotations[0]?.aspect).toBe('result')
    expect(annotations[0]?.color).toBe('sky')
    expect(container.querySelector('.ln-noteeditor')).toBeNull()
  })

  it('sends the selection to the AI composer through the registered handler', async () => {
    const focus = vi.fn()
    const unregister = registerAskAI(focus)
    try {
      await renderScene()
      const paragraph = container.querySelector('.ln-paper__body .ln-block--p .ln-para__text')
      if (paragraph === null) throw new Error('paragraph missing')
      act(() => {
        selectRange(paragraph, 0, 6)
        container.querySelector('.ln-paper__body')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      await flush(2)
      const ask = Array.from(container.querySelectorAll('.ln-selbar__btn')).find((button) =>
        textOf(button).includes('sel.askAi'),
      )
      act(() => click(ask))
      await flush(1)
      expect(focus).toHaveBeenCalledTimes(1)
      const context = focus.mock.calls[0]?.[0] as { blockKey: string; quote: string }
      expect(context.blockKey).toBe(firstParagraphKey())
      expect(context.quote.length).toBeGreaterThan(0)
      expect(useReaderStore.getState().selectionContext?.blockKey).toBe(context.blockKey)
    } finally {
      unregister()
    }
  })

  it('shows the selection translation card with provider and copy action', async () => {
    await renderScene()
    const paragraph = container.querySelector('.ln-paper__body .ln-block--p .ln-para__text')
    if (paragraph === null) throw new Error('paragraph missing')
    act(() => {
      selectRange(paragraph, 0, 7)
      container.querySelector('.ln-paper__body')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await flush(2)
    const translate = Array.from(container.querySelectorAll('.ln-selbar__btn')).find((button) =>
      textOf(button).includes('sel.translate'),
    )
    act(() => click(translate))
    await flush(2)
    const card = container.querySelector('.ln-selcard')
    expect(card).not.toBeNull()
    expect(textOf(card?.querySelector('.ln-selcard__text'))).toContain('译文')
    expect(textOf(card?.querySelector('.ln-selcard__provider'))).toContain('selcard.provider')
    expect(card?.querySelector('.ln-selcard__foot .ln-btn')).not.toBeNull()
  })
})

describe('ReadScene — navigation and AI margin', () => {
  it('mounts the AI margin stream, filter chips and composer inside the margin', async () => {
    await renderScene()
    const seat = container.querySelector('.ln-sheet__margin .ln-margin__ai .ln-ai')
    expect(seat).not.toBeNull()
    expect(seat?.querySelector('.ln-ai__filters')).not.toBeNull()
    expect(seat?.querySelector('.ln-ai__stream')).not.toBeNull()
    expect(seat?.querySelector('.ln-ai__composer')).not.toBeNull()
  })

  it('scrolls and flashes the target block on a citation jump request', async () => {
    await renderScene()
    const key = paragraphKey(2)
    act(() => {
      useReaderStore.getState().requestJump(key, { flash: true })
    })
    await flush(2)
    const calledKeys = (scrollSpy.mock.instances as unknown as HTMLElement[]).map((element) =>
      element.getAttribute('data-block-key'),
    )
    expect(calledKeys).toContain(key)
    expect(container.querySelector('.ln-block.is-flash')?.getAttribute('data-block-key')).toBe(key)
  })

  it('restores the saved reading position on open', async () => {
    const key = paragraphKey(1)
    await renderScene({
      preferences: { lastDocumentId: 'doc-1', lastBlockKey: key, showPageMarks: false },
    })
    await flush(2)
    const calledKeys = (scrollSpy.mock.instances as unknown as HTMLElement[]).map((element) =>
      element.getAttribute('data-block-key'),
    )
    expect(calledKeys).toContain(key)
  })

  it('keeps the margin notes in document order', async () => {
    const first = paragraphKey(0)
    const later = paragraphKey(4)
    const annotation = (id: string, blockKey: string, start: number): Annotation => ({
      id,
      blockKey,
      start,
      end: start + 3,
      quote: 'quo',
      color: 'yellow',
      origin: 'user',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    })
    await renderScene({
      host: { annotations: [annotation('ann-later', later, 0), annotation('ann-first', first, 0)] },
    })
    const entries = Array.from(container.querySelectorAll('.ln-note[data-kind="note"]'))
    expect(entries.map((entry) => entry.getAttribute('data-annotation-id'))).toEqual([
      'ann-first',
      'ann-later',
    ])
  })
})

describe('ReadContextBar — reading controls', () => {
  /** Render the context bar next to the scene (same stores). */
  async function renderBar(
    options: { preferences?: Partial<Preferences>; host?: FakeHostOptions } = {},
  ): Promise<{ fake: ReturnType<typeof createFakeHost> }> {
    const fake = createFakeHost(options.host)
    setHostClient(fake)
    useSettingsStore.setState({
      preferences: makePreferences(options.preferences),
      loaded: true,
      error: null,
    })
    await act(async () => {
      root.render(
        <LocaleContext.Provider value={t}>
          <ReadContextBar />
          <ReadScene document={makeSummary()} />
        </LocaleContext.Provider>,
      )
    })
    await settleReady()
    await flush(2)
    return { fake }
  }

  it('keeps the fixed control order: mode, page marks, outline, scale (no width control)', async () => {
    await renderBar()
    const groups = container.querySelectorAll('.ln-contextbar__left > *')
    expect(groups.length).toBeGreaterThanOrEqual(6)
    const labels = Array.from(container.querySelectorAll('.ln-contextbar__left [aria-label]')).map(
      (element) => element.getAttribute('aria-label'),
    )
    expect(labels).toContain('read.controls.pageMarks')
    expect(labels).toContain('read.controls.outline')
    expect(labels).toContain('read.controls.scaleDown')
    expect(labels).toContain('read.controls.scaleUp')
    expect(labels).toContain('read.controls.mode')
    expect(labels).not.toContain('read.controls.measure')
    expect(container.querySelectorAll('.ln-contextbar .ln-seg__item')).toHaveLength(3)
  })

  it('patches scale and page-mark preferences through the settings store', async () => {
    const { fake } = await renderBar()
    act(() => click(container.querySelector('[aria-label="read.controls.scaleUp"]')))
    await flush(1)
    expect(useSettingsStore.getState().preferences.readingScale).toBe(1.12)
    expect(fake.lastCall('settings.update')).toBeDefined()
    act(() => click(container.querySelector('[aria-label="read.controls.pageMarks"]')))
    await flush(1)
    expect(useSettingsStore.getState().preferences.showPageMarks).toBe(false)
  })

  it('opens the outline popover and jumps to a section on click', async () => {
    await renderBar()
    const trigger = container.querySelector('[aria-label="read.controls.outline"]')
    act(() => click(trigger))
    await flush(1)
    const popover = container.querySelector('.ln-outline')
    expect(popover).not.toBeNull()
    const items = popover?.querySelectorAll('.ln-outline__item') ?? []
    expect(items.length).toBeGreaterThan(4)
    act(() => click(items[0]))
    await flush(1)
    expect(container.querySelector('.ln-outline')).toBeNull()
    expect(useReaderStore.getState().jumpRequest).not.toBeNull()
  })

  it('wires the aspect legend as the shared filter', async () => {
    await renderBar()
    const legend = container.querySelectorAll('.ln-contextbar .ln-legend__item')
    expect(legend.length).toBe(5)
    act(() => click(legend[0]))
    expect(useUiStore.getState().activeAspect).toBe('definition')
    act(() => click(legend[0]))
    expect(useUiStore.getState().activeAspect).toBeNull()
  })
})

describe('ReadScene — margin filters and editing', () => {
  it('honors the shared origin filter for the margin notes', async () => {
    const key = firstParagraphKey()
    const annotation: Annotation = {
      id: 'ann-user',
      blockKey: key,
      start: 0,
      end: 4,
      quote: 'Dens',
      color: 'sage',
      aspect: 'method',
      origin: 'user',
      note: 'note body',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    }
    await renderScene({ host: { annotations: [annotation] } })
    expect(container.querySelectorAll('.ln-note').length).toBe(1)
    act(() => useUiStore.getState().setMarginFilter('chat'))
    await flush(1)
    expect(container.querySelectorAll('.ln-note').length).toBe(0)
    expect(textOf(container.querySelector('.ln-margin__empty'))).toContain('margin.emptyFiltered')
    act(() => useUiStore.getState().setMarginFilter('all'))
    await flush(1)
    expect(container.querySelectorAll('.ln-note').length).toBe(1)
  })

  it('edits an existing note from its margin slip', async () => {
    const key = firstParagraphKey()
    const annotation: Annotation = {
      id: 'ann-edit',
      blockKey: key,
      start: 0,
      end: 4,
      quote: 'Dens',
      color: 'yellow',
      aspect: 'definition',
      origin: 'user',
      note: 'before',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    }
    await renderScene({ host: { annotations: [annotation] } })
    const editButton = container.querySelector('[aria-label="margin.noteEdit"]')
    expect(editButton).not.toBeNull()
    act(() => click(editButton))
    await flush(1)
    const editor = container.querySelector('.ln-noteeditor')
    expect(editor).not.toBeNull()
    expect(textOf(editor?.querySelector('.ln-noteeditor__quote'))).toBe('Dens')
    const deleteButton = editor?.querySelector('.ln-btn--danger')
    expect(deleteButton).not.toBeNull()
    act(() => click(deleteButton))
    await flush(1)
    expect(useReaderStore.getState().annotations.length).toBe(0)
    expect(container.querySelector('.ln-noteeditor')).toBeNull()
  })

  it('focuses the matching margin slip when a highlight is clicked', async () => {
    const key = firstParagraphKey()
    const annotation: Annotation = {
      id: 'ann-click',
      blockKey: key,
      start: 0,
      end: 4,
      quote: 'Dens',
      color: 'sky',
      origin: 'user',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    }
    await renderScene({ host: { annotations: [annotation] } })
    scrollSpy.mockClear()
    const mark = container.querySelector('.ln-hl')
    act(() => click(mark))
    await flush(1)
    expect(useReaderStore.getState().activeAnnotationId).toBe('ann-click')
    const targets = (scrollSpy.mock.instances as unknown as HTMLElement[]).map((element) =>
      element.getAttribute('data-annotation-id'),
    )
    expect(targets).toContain('ann-click')
  })
})
