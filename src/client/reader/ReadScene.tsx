/**
 * The reading scene — sheet, gutter, paper and margin (DESIGN-V2 §5–6).
 *
 * Structure:
 *
 *   .ln-reader
 *     .ln-reader__scroll          single scroll container (scroll restore here)
 *       .ln-sheet
 *         .ln-sheet__gutter       section ticks live in the heading blocks
 *         .ln-sheet__paper        title block + blocks (`data-block-key`)
 *         .ln-sheet__margin       margin head + AI stream + reader notes
 *     .ln-tether-layer            fixed 1px provenance hairlines
 *     .ln-selbar / .ln-selcard / .ln-noteeditor
 *
 * The store owns data/lifecycle; this component owns DOM concerns: scroll
 * restore, jump+flash, selection → offsets, tether geometry, overlay state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { DocumentSummary } from '../../shared/model.ts'
import type { AnnotationColor, Aspect } from '../../shared/constants.ts'
import { isAnnotatableBlock } from '../../shared/annotate/highlight.ts'
import type { NormalizedAnnotation } from '../../shared/annotate/highlight.ts'
import type { Block } from '../../shared/markdown/model.ts'
import { getHostClient } from '../api/client.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { Button, Spinner, ProgressBar } from '../design/primitives.tsx'
import { useInjectedStyle } from '../design/use-style.ts'
import { useT } from '../shell/locale-context.ts'
import { engineLabelKey, formatNumber } from '../shell/format.ts'
import { useKatexReady } from './katex.ts'
import { BlockRenderContext, MemoBlockView, computeHeadingNumbers } from './blocks.tsx'
import { findBlock } from './model-cache.ts'
import { readSelection, blocksByKey, clearBrowserSelection } from './selection.ts'
import type { ReaderSelection } from './selection.ts'
import { MarginNotes, NoteEditor } from './notes.tsx'
import type { NoteEditorState } from './notes.tsx'
import { SelectionToolbar } from './selection-bar.tsx'
import { SelectionTranslationCard } from './translation.tsx'
import type { SelectionTranslationState } from './translation.tsx'
import { Tethers } from './tethers.tsx'
import { AiMarginEntries } from './margin-ai.tsx'
import { askAI } from './api.ts'
import { orderOf, refreshAnnotations, useReaderStore } from './store.ts'
import { copyText } from './clipboard.ts'
import READER_CSS from './styles.css'

/** Props supplied by the shell: the open document. */
export interface ReadSceneProps {
  document: DocumentSummary
}

/** Escape a value for use inside a quoted CSS attribute selector. */
function escapeAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/** Format a note/document timestamp compactly (Intl, platform). */
function formatDate(iso: string | undefined): string {
  if (iso === undefined || iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** The reading scene. */
export function ReadScene({ document }: ReadSceneProps): ReactElement {
  useInjectedStyle('reader', READER_CSS)
  const t = useT()

  /* ---- store slices -------------------------------------------------- */
  const phase = useReaderStore((state) => state.phase)
  const storeError = useReaderStore((state) => state.error)
  const storeDocument = useReaderStore((state) => state.document)
  const model = useReaderStore((state) => state.model)
  const pages = useReaderStore((state) => state.pages)
  const annotations = useReaderStore((state) => state.annotations)
  const staleAnnotations = useReaderStore((state) => state.staleAnnotations)
  const annotationsByBlock = useReaderStore((state) => state.annotationsByBlock)
  const droppedAnnotations = useReaderStore((state) => state.droppedAnnotations)
  const translations = useReaderStore((state) => state.translations)
  const translationJobs = useReaderStore((state) => state.translationJobs)
  const translationProviders = useReaderStore((state) => state.translationProviders)
  const translateAll = useReaderStore((state) => state.translateAll)
  const activeAnnotationId = useReaderStore((state) => state.activeAnnotationId)
  const restoreBlockKey = useReaderStore((state) => state.restoreBlockKey)
  const jumpRequest = useReaderStore((state) => state.jumpRequest)
  const notice = useReaderStore((state) => state.notice)

  /* ---- shell slices -------------------------------------------------- */
  const preferences = useSettingsStore((state) => state.preferences)
  const marginOpen = useUiStore((state) => state.marginOpen)
  const marginFilter = useUiStore((state) => state.marginFilter)
  const activeAspect = useUiStore((state) => state.activeAspect)
  const katexReady = useKatexReady()

  /* ---- DOM refs ------------------------------------------------------ */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const paperRef = useRef<HTMLDivElement | null>(null)
  const marginRef = useRef<HTMLElement | null>(null)
  const documentRef = useRef(document)
  documentRef.current = document
  const openedFor = useRef<string | null>(null)
  const restoredFor = useRef<string | null>(null)
  const handledJump = useRef(0)
  const flashTimer = useRef<number | null>(null)
  const scrollFrame = useRef<number | null>(null)

  /* ---- transient UI state -------------------------------------------- */
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [selCard, setSelCard] = useState<SelectionTranslationState | null>(null)
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null)
  const [flashBlockKey, setFlashBlockKey] = useState<string | null>(null)
  const [hovered, setHovered] = useState<{ annotationId: string | null; blockKey: string | null }>({
    annotationId: null,
    blockKey: null,
  })
  const selCardBase = useRef<ReaderSelection | null>(null)
  const selSeq = useRef(0)
  const selCache = useRef(new Map<string, { translation: string; provider: string }>())

  const activeDocument = storeDocument !== null && storeDocument.id === document.id ? storeDocument : document
  const title = activeDocument.title !== '' ? activeDocument.title : activeDocument.originalName

  /* ---- notices → toasts ---------------------------------------------- */
  const toast = useCallback((text: string, tone: 'info' | 'success' | 'warn' | 'error'): void => {
    useUiStore.getState().toast(text, tone)
  }, [])

  useEffect(() => {
    if (notice === null) return
    useUiStore.getState().toast(t(notice.key, notice.params), notice.tone)
    useReaderStore.getState().clearNotice()
  }, [notice, t])

  /* ---- open / close the document ------------------------------------- */
  useEffect(() => {
    const target = documentRef.current
    openedFor.current = target.id
    void useReaderStore.getState().open(target)
    return () => {
      // Only close the store when this scene still owns the open document
      // (StrictMode double-invocation must not close the newer open).
      if (openedFor.current === target.id) {
        openedFor.current = null
        useReaderStore.getState().close()
      }
    }
  }, [document.id])

  /* ---- page-mark preference changes rebuild the view model ------------ */
  const showPageMarks = preferences.showPageMarks
  useEffect(() => {
    if (useReaderStore.getState().phase === 'ready') useReaderStore.getState().rebuildModel()
  }, [showPageMarks])

  /* ---- outline numbers + skip the duplicated title heading ----------- */
  const headingNumbers = useMemo(() => computeHeadingNumbers(model.blocks), [model])
  const skipKey = useMemo(() => {
    const target = title.trim().toLowerCase()
    if (target === '') return null
    for (const block of model.blocks) {
      if (block.kind === 'page' || block.kind === 'rule') continue
      if (block.kind === 'heading' && block.level === 1 && block.plainText.trim().toLowerCase() === target) {
        return block.key
      }
      break
    }
    return null
  }, [model, title])

  /* ---- scroll: restore the reading position -------------------------- */
  const scrollToBlock = useCallback(
    (
      blockKey: string,
      options: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition; flash?: boolean } = {},
    ): boolean => {
      const paper = paperRef.current
      if (paper === null) return false
      let element: HTMLElement | null = null
      try {
        element = paper.querySelector<HTMLElement>(`[data-block-key="${escapeAttr(blockKey)}"]`)
      } catch {
        element = null
      }
      if (element === null) return false
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({
          block: options.block ?? 'center',
          behavior: options.behavior ?? 'smooth',
        })
      } else if (scrollRef.current !== null) {
        scrollRef.current.scrollTop = element.offsetTop
      }
      if (options.flash !== false) {
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
        setFlashBlockKey(blockKey)
        flashTimer.current = window.setTimeout(() => {
          flashTimer.current = null
          setFlashBlockKey(null)
        }, 1200)
      }
      return true
    },
    [],
  )

  useEffect(() => {
    if (phase !== 'ready') return
    if (restoredFor.current === document.id) return
    restoredFor.current = document.id
    if (restoreBlockKey !== null) {
      scrollToBlock(restoreBlockKey, { behavior: 'auto', block: 'start', flash: false })
    } else if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = 0
    }
  }, [phase, restoreBlockKey, document.id, scrollToBlock])

  /* ---- scroll: jump requests (citations, graph→source, outline) ----- */
  useEffect(() => {
    if (phase !== 'ready' || jumpRequest === null) return
    if (jumpRequest.documentId !== null && jumpRequest.documentId !== document.id) return
    if (jumpRequest.seq <= handledJump.current) return
    handledJump.current = jumpRequest.seq
    scrollToBlock(jumpRequest.blockKey, {
      behavior: 'smooth',
      block: 'center',
      flash: jumpRequest.flash,
    })
  }, [phase, jumpRequest, document.id, scrollToBlock])

  /* ---- scroll: read-position tracking (IntersectionObserver) --------- */
  useEffect(() => {
    if (phase !== 'ready') return undefined
    const paper = paperRef.current
    const scroller = scrollRef.current
    if (paper === null || scroller === null) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback: throttled scan of the rendered blocks.
      let last = 0
      const onScroll = (): void => {
        const now = Date.now()
        if (now - last < 500) return
        last = now
        const threshold = scroller.getBoundingClientRect().top + 96
        const elements = paper.querySelectorAll<HTMLElement>('[data-block-key]')
        for (const element of Array.from(elements)) {
          const rect = element.getBoundingClientRect()
          if (rect.top <= threshold && rect.bottom > threshold) {
            const key = element.getAttribute('data-block-key')
            if (key !== null) useReaderStore.getState().recordPosition(key)
            break
          }
          if (rect.top > threshold) break
        }
      }
      scroller.addEventListener('scroll', onScroll, { passive: true })
      return () => scroller.removeEventListener('scroll', onScroll)
    }
    const visible = new Set<Element>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target)
          else visible.delete(entry.target)
        }
        let bestKey: string | null = null
        let bestRank = Number.POSITIVE_INFINITY
        for (const element of visible) {
          const key = element.getAttribute('data-block-key')
          if (key === null) continue
          const rank = orderOf(key) ?? Number.POSITIVE_INFINITY
          if (rank < bestRank) {
            bestRank = rank
            bestKey = key
          }
        }
        if (bestKey !== null) useReaderStore.getState().recordPosition(bestKey)
      },
      { root: scroller, rootMargin: '-12% 0px -70% 0px', threshold: 0 },
    )
    const elements = paper.querySelectorAll<HTMLElement>('[data-block-key]')
    for (const element of Array.from(elements)) observer.observe(element)
    return () => observer.disconnect()
  }, [phase, model])

  /* ---- scroll: dismiss detached overlays ----------------------------- */
  const handleScroll = useCallback((): void => {
    if (scrollFrame.current !== null) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null
      setSelection((current) => (current === null ? current : null))
      setSelCard((current) => (current === null ? current : null))
    })
  }, [])

  /* ---- selection capture --------------------------------------------- */
  const blocksIndex = useMemo(() => blocksByKey(model.blocks), [model])

  const captureSelection = useCallback(
    (source: 'mouse' | 'keyboard'): void => {
      const paper = paperRef.current
      if (paper === null) return
      let info: ReaderSelection | null = null
      try {
        info = readSelection(paper, blocksIndex, source)
      } catch {
        info = null
      }
      if (info === null) return
      const overlapping = annotations
        .filter(
          (annotation) =>
            annotation.blockKey === info.blockKey &&
            annotation.start < info.end &&
            annotation.end > info.start,
        )
        .map((annotation) => annotation.id)
      setSelection(overlapping.length > 0 ? { ...info, annotationIds: overlapping } : info)
      setSelCard(null)
      setNoteEditor(null)
    },
    [annotations, blocksIndex],
  )

  const handleMouseUp = useCallback((): void => {
    window.setTimeout(() => captureSelection('mouse'), 0)
  }, [captureSelection])

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      const key = event.key
      const selectionKey =
        key === 'Shift' ||
        key.startsWith('Arrow') ||
        key === 'Home' ||
        key === 'End' ||
        key === 'PageUp' ||
        key === 'PageDown'
      if (!selectionKey) return
      window.setTimeout(() => captureSelection('keyboard'), 0)
    },
    [captureSelection],
  )

  /* ---- block callbacks ----------------------------------------------- */
  const translateBlock = useCallback((blockKey: string): void => {
    void useReaderStore.getState().translateBlock(blockKey)
  }, [])
  const retryTranslation = useCallback((blockKey: string): void => {
    void useReaderStore.getState().retryTranslation(blockKey)
  }, [])
  const outlineJump = useCallback((blockKey: string): void => {
    useReaderStore.getState().requestJump(blockKey, { flash: false })
  }, [])

  const annotateBlock = useCallback((blockKey: string): void => {
    const store = useReaderStore.getState()
    const block = findBlock(store.model, blockKey)
    if (block === null || !isAnnotatableBlock(block)) return
    const paper = paperRef.current
    let rect: DOMRect | null = null
    if (paper !== null) {
      try {
        rect = paper
          .querySelector<HTMLElement>(`[data-block-key="${escapeAttr(blockKey)}"]`)
          ?.getBoundingClientRect() ?? null
      } catch {
        rect = null
      }
    }
    const text = block.plainText
    setSelection(null)
    setSelCard(null)
    setNoteEditor({
      mode: 'create',
      annotationId: null,
      blockKey,
      start: 0,
      end: Math.min(text.length, 2000),
      quote: text.slice(0, 2000),
      note: '',
      color: 'yellow',
      aspect: '',
      origin: 'user',
      rect,
    })
  }, [])

  const askBlock = useCallback((blockKey: string): void => {
    const block = findBlock(useReaderStore.getState().model, blockKey)
    if (block === null || typeof block.plainText !== 'string') return
    askAI({ blockKey, quote: block.plainText.slice(0, 2000), text: block.plainText })
  }, [])

  const handleMarkClick = useCallback((annotationId: string): void => {
    useReaderStore.getState().setActiveAnnotation(annotationId)
    const margin = marginRef.current
    if (margin === null) return
    try {
      margin
        .querySelector<HTMLElement>(`[data-annotation-id="${escapeAttr(annotationId)}"]`)
        ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    } catch {
      // scrolling is an enhancement only
    }
  }, [])

  /* ---- note editor --------------------------------------------------- */
  const editAnnotation = useCallback((annotation: NormalizedAnnotation): void => {
    const margin = marginRef.current
    let rect: DOMRect | null = null
    if (margin !== null) {
      try {
        rect =
          margin
            .querySelector<HTMLElement>(`[data-annotation-id="${escapeAttr(annotation.id)}"]`)
            ?.getBoundingClientRect() ?? null
      } catch {
        rect = null
      }
    }
    setSelection(null)
    setSelCard(null)
    setNoteEditor({
      mode: 'edit',
      annotationId: annotation.id,
      blockKey: annotation.blockKey,
      start: annotation.start,
      end: annotation.end,
      quote: annotation.quote,
      note: annotation.note ?? '',
      color: annotation.color,
      aspect: annotation.aspect ?? '',
      origin: annotation.origin ?? 'user',
      rect,
    })
    useReaderStore.getState().setActiveAnnotation(annotation.id)
  }, [])

  const deleteAnnotation = useCallback(
    (annotation: NormalizedAnnotation): void => {
      useReaderStore.getState().deleteAnnotation(annotation.id)
      toast(t('sel.deleted'), 'info')
    },
    [t, toast],
  )

  const deleteStaleAnnotation = useCallback(
    (annotation: NormalizedAnnotation): void => {
      useReaderStore.getState().deleteAnnotation(annotation.id)
      toast(t('sel.deleted'), 'info')
    },
    [t, toast],
  )

  const focusAnnotation = useCallback((annotation: NormalizedAnnotation): void => {
    useReaderStore.getState().setActiveAnnotation(annotation.id)
    const paper = paperRef.current
    if (paper === null) return
    let element: HTMLElement | null = null
    try {
      element =
        paper.querySelector<HTMLElement>(`[data-annotation-id="${escapeAttr(annotation.id)}"]`) ??
        paper.querySelector<HTMLElement>(`[data-block-key="${escapeAttr(annotation.blockKey)}"]`)
    } catch {
      element = null
    }
    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [])

  const saveNote = useCallback((): void => {
    const editor = noteEditor
    if (editor === null) return
    const store = useReaderStore.getState()
    if (editor.mode === 'edit' && editor.annotationId !== null) {
      const patch: { note: string; color?: AnnotationColor; aspect?: Aspect } = { note: editor.note }
      if (editor.origin !== 'ai') {
        patch.color = editor.color
        if (editor.aspect !== '') patch.aspect = editor.aspect
      }
      store.updateAnnotation(editor.annotationId, patch)
    } else {
      store.addAnnotation({
        blockKey: editor.blockKey,
        start: editor.start,
        end: editor.end,
        quote: editor.quote,
        color: editor.color,
        aspect: editor.aspect === '' ? undefined : editor.aspect,
        note: editor.note,
      })
    }
    clearBrowserSelection()
    setNoteEditor(null)
    toast(t('sel.noteSaved'), 'success')
  }, [noteEditor, t, toast])

  const deleteFromEditor = useCallback((): void => {
    const editor = noteEditor
    if (editor === null) return
    if (editor.annotationId !== null) {
      useReaderStore.getState().deleteAnnotation(editor.annotationId)
      toast(t('sel.deleted'), 'info')
    }
    clearBrowserSelection()
    setNoteEditor(null)
  }, [noteEditor, t, toast])

  /* ---- selection toolbar actions ------------------------------------- */
  const highlightSelection = useCallback(
    (color: AnnotationColor): void => {
      const current = selection
      if (current === null) return
      useReaderStore.getState().addAnnotation({
        blockKey: current.blockKey,
        start: current.start,
        end: current.end,
        quote: current.quote,
        color,
      })
      clearBrowserSelection()
      setSelection(null)
      toast(t('sel.added'), 'success')
    },
    [selection, t, toast],
  )

  const noteFromSelection = useCallback((): void => {
    const current = selection
    if (current === null) return
    clearBrowserSelection()
    setSelection(null)
    setNoteEditor({
      mode: 'create',
      annotationId: null,
      blockKey: current.blockKey,
      start: current.start,
      end: current.end,
      quote: current.quote,
      note: '',
      color: 'yellow',
      aspect: '',
      origin: 'user',
      rect: current.rect,
    })
  }, [selection])

  const askAboutSelection = useCallback((): void => {
    const current = selection
    if (current === null) return
    askAI({ blockKey: current.blockKey, quote: current.quote, text: current.quote })
    clearBrowserSelection()
    setSelection(null)
  }, [selection])

  const removeHighlights = useCallback(
    (ids: string[]): void => {
      useReaderStore.getState().removeAnnotations(ids)
      clearBrowserSelection()
      setSelection(null)
      toast(t('sel.deleted'), 'info')
    },
    [t, toast],
  )

  const copySelection = useCallback((): void => {
    const current = selection
    if (current === null) return
    void copyText(current.quote).then((ok) => {
      toast(ok ? t('toast.copied') : t('err.generic'), ok ? 'success' : 'error')
    })
  }, [selection, t, toast])

  const requestSelectionTranslation = useCallback(
    (base: ReaderSelection): void => {
      const sequence = (selSeq.current += 1)
      const cacheKey = `${base.blockKey}:${base.start}:${base.end}:${base.quote.slice(0, 160)}`
      selCardBase.current = base
      const cached = selCache.current.get(cacheKey)
      if (cached !== undefined) {
        setSelCard({
          state: 'done',
          quote: base.quote,
          translation: cached.translation,
          provider: cached.provider,
          rect: base.rect,
        })
        return
      }
      setSelCard({
        state: 'loading',
        quote: base.quote,
        translation: '',
        provider: '',
        rect: base.rect,
      })
      const settings = useSettingsStore.getState().preferences
      void getHostClient()
        .call('translate', {
          text: base.quote,
          targetLanguage: settings.targetLanguage,
          provider: settings.translationProvider,
        })
        .then((value) => {
          if (sequence !== selSeq.current) return
          const translation = typeof value.translation === 'string' ? value.translation : ''
          if (translation === '') throw new Error('empty translation')
          selCache.current.set(cacheKey, { translation, provider: value.provider })
          setSelCard({
            state: 'done',
            quote: base.quote,
            translation,
            provider: value.provider,
            rect: base.rect,
          })
        })
        .catch(() => {
          if (sequence !== selSeq.current) return
          setSelCard({
            state: 'error',
            quote: base.quote,
            translation: '',
            provider: '',
            rect: base.rect,
          })
        })
    },
    [],
  )

  const translateSelection = useCallback((): void => {
    const current = selection
    if (current === null) return
    clearBrowserSelection()
    setSelection(null)
    requestSelectionTranslation(current)
  }, [requestSelectionTranslation, selection])

  const retrySelectionTranslation = useCallback((): void => {
    const base = selCardBase.current
    if (base === null) return
    selCache.current.delete(`${base.blockKey}:${base.start}:${base.end}:${base.quote.slice(0, 160)}`)
    requestSelectionTranslation(base)
  }, [requestSelectionTranslation])

  const copyTranslation = useCallback((): void => {
    const card = selCard
    if (card === null || card.translation === '') return
    void copyText(card.translation).then((ok) => {
      toast(ok ? t('toast.copied') : t('err.generic'), ok ? 'success' : 'error')
    })
  }, [selCard, t, toast])

  /* ---- jump / AI margin callbacks ------------------------------------ */
  const handleJump = useCallback((blockKey: string): void => {
    useReaderStore.getState().requestJump(blockKey, { flash: true })
  }, [])
  const handleAnnotationsChanged = useCallback((): void => {
    void refreshAnnotations()
  }, [])

  /* ---- hover cross-highlighting -------------------------------------- */
  const hoverAnnotation = useCallback((annotationId: string | null, blockKey: string | null): void => {
    setHovered({ annotationId, blockKey })
  }, [])

  const handleMarginOver = useCallback((event: ReactMouseEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement | null
    if (target === null || typeof target.closest !== 'function') return
    const entry = target.closest<HTMLElement>('[data-anchor-block]')
    if (entry === null) return
    setHovered({
      annotationId: entry.dataset.anchorId ?? null,
      blockKey: entry.dataset.anchorBlock ?? null,
    })
  }, [])

  const handleMarginLeave = useCallback((): void => {
    setHovered({ annotationId: null, blockKey: null })
  }, [])

  /* ---- block render context ------------------------------------------ */
  const blockContext = useMemo<BlockRenderContext>(
    () => ({
      documentId: document.id,
      t,
      mode: preferences.readingMode,
      katexReady,
      annotationsByBlock,
      translations,
      translationJobs,
      translationProviders,
      headingNumbers,
      activeAnnotationId,
      hoveredAnnotationId: hovered.annotationId,
      hoveredBlockKey: hovered.blockKey,
      flashBlockKey,
      unknownSymbolLabel: t('read.unknownSymbol'),
      onMarkClick: handleMarkClick,
      onTranslateBlock: translateBlock,
      onAnnotateBlock: annotateBlock,
      onAskBlock: askBlock,
      onRetryTranslation: retryTranslation,
      onOutlineJump: outlineJump,
    }),
    [
      document.id,
      t,
      preferences.readingMode,
      katexReady,
      annotationsByBlock,
      translations,
      translationJobs,
      translationProviders,
      headingNumbers,
      activeAnnotationId,
      hovered,
      flashBlockKey,
      handleMarkClick,
      translateBlock,
      annotateBlock,
      askBlock,
      retryTranslation,
      outlineJump,
    ],
  )

  /* ---- render -------------------------------------------------------- */
  const readerStyle = {
    ['--ln-read-scale' as string]: String(preferences.readingScale),
    ['--ln-measure' as string]: `${preferences.readingMeasure}px`,
    ['--ln-margin-width' as string]: `${preferences.marginWidth}px`,
  } as CSSProperties

  const metaParts: string[] = []
  if (activeDocument.originalName !== '') metaParts.push(activeDocument.originalName)
  const ext = activeDocument.ext.replace(/^\./, '').toUpperCase()
  if (ext !== '') metaParts.push(ext)
  if (pages !== null && pages > 0) metaParts.push(t('status.pages', { count: pages }))
  if (model.stats.words > 0) metaParts.push(t('status.words', { count: formatNumber(model.stats.words) }))
  const engine = activeDocument.parse?.engine ?? null
  if (engine !== null) metaParts.push(t(engineLabelKey(engine) as 'status.engine.none'))
  const created = formatDate(activeDocument.createdAt)
  if (created !== '') metaParts.push(created)

  const blocks: ReactElement[] = []
  if (phase === 'ready') {
    for (let index = 0; index < model.blocks.length; index += 1) {
      const block: Block | undefined = model.blocks[index]
      if (block === undefined) continue
      if (skipKey !== null && block.key === skipKey) continue
      blocks.push(<MemoBlockView key={block.key !== '' ? block.key : `block-${index}`} block={block} ctx={blockContext} />)
    }
  }

  const tethersRevision =
    annotations.length * 131 + staleAnnotations.length * 37 + model.blocks.length

  return (
    <div
      className="ln-reader"
      data-mode={preferences.readingMode}
      data-phase={phase}
      data-margin={marginOpen ? 'open' : 'closed'}
      style={readerStyle}
    >
      <div className="ln-reader__scroll ln-scroll" ref={scrollRef} onScroll={handleScroll}>
        <article className="ln-sheet">
          <div className="ln-sheet__gutter" aria-hidden="true" />
          <div className="ln-sheet__paper" ref={paperRef}>
            <header className="ln-paper__titleblock">
              <h1 className="ln-paper__title">{title}</h1>
              <p className="ln-paper__meta ln-tabular">{metaParts.join(' · ')}</p>
              <div className="ln-paper__rule" aria-hidden="true" />
            </header>
            {phase === 'ready' ? (
              <div
                className="ln-paper__body"
                onMouseUp={handleMouseUp}
                onKeyUp={handleKeyUp}
              >
                {blocks.length === 0 ? (
                  <p className="ln-reader__empty">{t('read.emptyDoc')}</p>
                ) : (
                  blocks
                )}
              </div>
            ) : phase === 'error' ? (
              <div className="ln-reader__state" role="status">
                <p>{t('read.loadFailed')}</p>
                <p className="ln-reader__stateDetail">{storeError ?? ''}</p>
                <Button variant="ghost" icon="refresh" onClick={() => void useReaderStore.getState().open(document)}>
                  {t('read.retry')}
                </Button>
              </div>
            ) : (
              <div className="ln-reader__state" role="status" aria-busy="true">
                <Spinner size={18} label={t('read.loading')} />
                <p>{t('read.loading')}</p>
              </div>
            )}
          </div>
          {marginOpen ? (
            <aside
              className="ln-sheet__margin"
              ref={marginRef}
              aria-label={t('margin.title')}
              onMouseOver={handleMarginOver}
              onMouseLeave={handleMarginLeave}
            >
              <div className="ln-margin__head">
                <span className="ln-margin__title">{t('margin.title')}</span>
                <span className="ln-margin__count ln-tabular">
                  {t('margin.notesCount', { count: annotations.length + staleAnnotations.length })}
                </span>
              </div>
              {translateAll !== null && translateAll.running ? (
                <div className="ln-translateall" role="status">
                  <ProgressBar
                    value={translateAll.done}
                    total={translateAll.total}
                    label={t('read.translation.progress', {
                      done: translateAll.done,
                      total: translateAll.total,
                    })}
                  />
                  <div className="ln-translateall__row">
                    <span>
                      {t('read.translation.progress', {
                        done: translateAll.done,
                        total: translateAll.total,
                      })}
                    </span>
                    <button
                      type="button"
                      className="ln-link-btn"
                      onClick={() => useReaderStore.getState().cancelTranslateAll()}
                    >
                      {t('read.translation.cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="ln-margin__ai">
                <AiMarginEntries
                  documentId={document.id}
                  orderOf={orderOf}
                  onJump={handleJump}
                  onAnnotationsChanged={handleAnnotationsChanged}
                />
              </div>
              <MarginNotes
                t={t}
                annotations={annotations}
                staleAnnotations={staleAnnotations}
                droppedAnnotations={droppedAnnotations}
                marginFilter={marginFilter}
                activeAspect={activeAspect}
                activeAnnotationId={activeAnnotationId}
                orderOf={orderOf}
                onHover={hoverAnnotation}
                onActivate={focusAnnotation}
                onEdit={editAnnotation}
                onDelete={deleteAnnotation}
                onDeleteStale={deleteStaleAnnotation}
                onClearFilters={() => {
                  const ui = useUiStore.getState()
                  ui.setMarginFilter('all')
                  if (activeAspect !== null) ui.toggleAspect(activeAspect)
                }}
              />
            </aside>
          ) : null}
        </article>
      </div>

      <Tethers
        scrollRef={scrollRef}
        paperRef={paperRef}
        marginRef={marginRef}
        activeAnnotationId={activeAnnotationId}
        hoveredAnnotationId={hovered.annotationId}
        hoveredBlockKey={hovered.blockKey}
        revision={tethersRevision}
        enabled={marginOpen}
      />

      {selection !== null ? (
        <SelectionToolbar
          t={t}
          selection={selection}
          onHighlight={highlightSelection}
          onNote={noteFromSelection}
          onAsk={askAboutSelection}
          onTranslate={translateSelection}
          onRemoveHighlight={removeHighlights}
          onCopy={copySelection}
        />
      ) : null}

      {selCard !== null ? (
        <SelectionTranslationCard
          t={t}
          card={selCard}
          katexReady={katexReady}
          onRetry={retrySelectionTranslation}
          onClose={() => setSelCard(null)}
          onCopy={copyTranslation}
        />
      ) : null}

      {noteEditor !== null ? (
        <NoteEditor
          t={t}
          editor={noteEditor}
          onChange={(patch) => setNoteEditor((current) => (current === null ? current : { ...current, ...patch }))}
          onSave={saveNote}
          onCancel={() => {
            clearBrowserSelection()
            setNoteEditor(null)
          }}
          onDelete={deleteFromEditor}
        />
      ) : null}
    </div>
  )
}
