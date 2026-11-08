/**
 * The AI voice in the margin — owned by the `client-ai` workstream.
 *
 * `AiMarginEntries` is rendered by the reader inside `.ln-sheet__margin` and
 * owns everything the AI contributes to that column: the filter-chip header, the
 * conversation turns sorted into document order, the streaming status rows, the
 * citation chips/cards, follow-ups, entry actions and the pinned composer.
 *
 * Contract (Lead-brokered; mirrored in `src/client/reader/api.ts`):
 *  - `documentId` — the open paper;
 *  - `orderOf(blockKey)` — reader document order, used to sort turns by their
 *    first citation block (unknown/unanchored turns sort last, in creation order);
 *  - `onJump(blockKey)` — scroll+flash a cited block in the paper;
 *  - `onAnnotationsChanged()` — called after an `answer` frame adopted new AI
 *    annotations so the reader reloads them.
 *
 * Each turn root carries `data-anchor-block="<blockKey>"` and
 * `data-created-at="<ISO>"` for the reader's tether layer. The component is
 * props-driven: it renders with no reader mounted (tests) and degrades to
 * read-only rows when the host client is unavailable.
 */

import type { ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flip, offset, shift, useFloating } from '@floating-ui/react'
import { Icon } from '../design/icons.tsx'
import { IconButton, Menu, Spinner, type MenuItem } from '../design/primitives.tsx'
import { useInjectedStyle } from '../design/use-style.ts'
import { useLibraryStore } from '../state/library.ts'
import { useSettingsStore } from '../state/settings.ts'
import { useUiStore } from '../state/ui.ts'
import { useT } from '../shell/locale-context.ts'
import {
  aiT,
  chatTurns,
  citationFlags,
  displayText,
  errorText,
  excerpt,
  formatCount,
  navAwayFromLatest,
  navCurrentMark,
  navTargetScrollTop,
  sortTurns,
  turnHasAspect,
  unverifiedBreakdown,
} from './chat.ts'
import type { ChatEntry, ChatTurn, QuestionMark } from './chat.ts'
import { AiMarkdown } from './markdown.tsx'
import { CitationCard, CitationChip } from './Citation.tsx'
import type { CitationAnchorEvent, CitationPayload } from './Citation.tsx'
import { installReaderBridge } from './reader-bridge.ts'
import { adaptTranslate } from './translate.ts'
import { setAiTranslate, useAiStore } from './store.ts'
import type { AiFailure, AiStreamError } from './store.ts'
import type { AiTranslate } from './chat.ts'
import aiCss from './styles.css'

/** Props of {@link AiMarginEntries} (the reader-owned mirror lives in `reader/api.ts`). */
export interface AiMarginEntriesProps {
  /** Open document id. */
  documentId: string
  /** Document order of a block key (`null` when unknown → sort last). */
  orderOf: (blockKey: string) => number | null
  /** Scroll+flash one block in the paper (citation click). */
  onJump: (blockKey: string) => void
  /** Reload annotations after an answer adopted new ones. */
  onAnnotationsChanged: () => void | Promise<void>
  /** Gate the entailment notice row; defaults to the `entailmentNotice` preference. */
  showEntailment?: boolean
}

/** One open citation preview card. */
interface CitationCardState {
  index: number
  citation: CitationPayload['citation']
  verified: boolean
}

/** How long a citation card survives a pointer leave (ms; frozen 1.0.0 value). */
const CARD_HIDE_DELAY = 160
/** How long one navigator flash lasts (ms; frozen 1.0.0 value). */
const NAV_FLASH_DELAY = 1200
/** Anchor line of the question navigator inside the stream (px). */
const NAV_ANCHOR_Y = 72
/** Answers longer than this get the collapse action. */
const COLLAPSE_THRESHOLD = 900

/** `prefers-reduced-motion` at call time (SSR-safe). */
function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  } catch {
    return false
  }
}

/** Virtual floating-ui reference over a measured rect. */
function rectReference(rect: DOMRect): { getBoundingClientRect: () => DOMRect } {
  return { getBoundingClientRect: () => rect }
}

/**
 * The AI margin stream: filters, turns, citation previews, navigator and
 * composer.
 *
 * @param props - see {@link AiMarginEntriesProps}.
 * @returns the margin column content owned by the AI workstream.
 */
export function AiMarginEntries(props: AiMarginEntriesProps): ReactElement {
  const { documentId, orderOf, onJump, onAnnotationsChanged, showEntailment } = props
  const t = useT()
  const tr = useMemo(() => adaptTranslate(t), [t])
  const messages = useAiStore((state) => state.messages)
  const historyState = useAiStore((state) => state.historyState)
  const historyError = useAiStore((state) => state.historyError)
  const busy = useAiStore((state) => state.busy)
  const streamingId = useAiStore((state) => state.streamingId)
  const streamError = useAiStore((state) => state.streamError)
  const marginFilter = useUiStore((state) => state.marginFilter)
  const activeAspect = useUiStore((state) => state.activeAspect)
  const status = useLibraryStore((state) => state.status)
  const document = useLibraryStore((state) => state.documents.find((entry) => entry.id === documentId))
  const preferenceEntailmentNotice = useSettingsStore((state) => state.preferences.entailmentNotice)
  const showEntailmentEnabled = showEntailment ?? preferenceEntailmentNotice

  const available = status?.ai?.available === true
  const modelLabel = status?.ai?.route?.model ?? ''

  const streamRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const stickRef = useRef(true)
  const [card, setCard] = useState<CitationCardState | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  const [currentMarkId, setCurrentMarkId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  /* ----- reader seam + store wiring ------------------------------------- */

  useInjectedStyle('ai', aiCss)

  useEffect(() => {
    installReaderBridge()
  }, [])

  useEffect(() => {
    setAiTranslate(tr)
  }, [tr])

  useEffect(() => {
    useAiStore.getState().setHostHooks({ onJump, onAnnotationsChanged })
  }, [onJump, onAnnotationsChanged])

  useEffect(() => {
    void useAiStore.getState().load(documentId)
  }, [documentId])

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    },
    [],
  )

  /* ----- ordered / filtered turns --------------------------------------- */

  const turns = useMemo(() => chatTurns(messages), [messages])
  const orderedTurns = useMemo(() => sortTurns(turns, orderOf), [turns, orderOf])
  // Navigator marks are keyed by the rendered turn (assistant id when answered),
  // so jump/current-mark queries hit real entries in document order.
  const marks = useMemo<QuestionMark[]>(
    () =>
      orderedTurns
        .filter((turn) => turn.question.trim() !== '')
        .map((turn, index) => ({
          id: turn.id,
          messageId: turn.id,
          ordinal: index + 1,
          question: displayText(turn.question),
        })),
    [orderedTurns],
  )
  const visibleTurns = useMemo(() => {
    if (marginFilter === 'ai' || marginFilter === 'user') return []
    if (activeAspect === null) return orderedTurns
    return orderedTurns.filter((turn) => {
      if (turn.assistant === null) return false
      if (turn.assistant.streaming || turn.assistant.failed) return true
      if (turn.assistant.citations.length === 0 && turn.assistant.unverified.length === 0) return true
      return turnHasAspect(turn, activeAspect)
    })
  }, [orderedTurns, marginFilter, activeAspect])

  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      if (entry !== undefined && entry.role === 'assistant') return entry.id
    }
    return ''
  }, [messages])

  /* ----- citation preview card ------------------------------------------ */

  const { refs, floatingStyles } = useFloating({
    open: card !== null,
    onOpenChange: (open) => {
      if (!open) setCard(null)
    },
    placement: 'top',
    strategy: 'fixed',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  const cancelCardHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const scheduleCardHide = useCallback(() => {
    cancelCardHide()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setCard(null)
    }, CARD_HIDE_DELAY)
  }, [cancelCardHide])

  const showCitation = useCallback(
    (event: CitationAnchorEvent, payload: CitationPayload) => {
      if (payload.citation === null) return
      cancelCardHide()
      const rect = event.currentTarget.getBoundingClientRect()
      refs.setPositionReference(rectReference(rect))
      setCard({ index: payload.index, citation: payload.citation, verified: payload.verified })
    },
    [cancelCardHide, refs],
  )

  const closeCard = useCallback(() => {
    cancelCardHide()
    setCard(null)
  }, [cancelCardHide])

  const jump = useCallback(
    (blockKey: string) => {
      closeCard()
      if (blockKey !== '') onJump(blockKey)
    },
    [closeCard, onJump],
  )

  const onCitationClick = useCallback(
    (event: CitationAnchorEvent, payload: CitationPayload) => {
      const citation = payload.citation
      if (citation === null) return
      if (citationFlags(citation, payload.verified).unsupported) {
        // A real quote that does not support the claim: explain instead of jump.
        showCitation(event, payload)
        return
      }
      if (citation.blockKey !== '') {
        jump(citation.blockKey)
        return
      }
      showCitation(event, payload)
    },
    [jump, showCitation],
  )

  /* ----- scroll: stick to bottom, navigator, back-to-latest -------------- */

  /** The element that actually scrolls the margin. On desktop the margin column
   * is an independent scroll area; in tests/minimal hosts the stream itself is
   * the scroll container. */
  const scrollHost = useCallback((): HTMLElement | null => {
    const element = streamRef.current
    if (element === null) return null
    const column = element.closest<HTMLElement>('.ln-sheet__margin')
    return column ?? element
  }, [])

  const refreshNavigator = useCallback(() => {
    const element = scrollHost()
    if (element === null || marks.length < 2) return
    const containerRect = element.getBoundingClientRect()
    const offsets: Array<{ messageId: string; top: number }> = []
    for (const node of element.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const messageId = node.getAttribute('data-message-id') ?? ''
      if (messageId === '') continue
      const rect = node.getBoundingClientRect()
      offsets.push({ messageId, top: rect.top - containerRect.top })
    }
    const index = navCurrentMark(marks, offsets, NAV_ANCHOR_Y)
    const next = index >= 0 ? (marks[index]?.id ?? null) : null
    setCurrentMarkId((previous) => (previous === next ? previous : next))
  }, [marks, scrollHost])

  const handleScroll = useCallback(() => {
    const element = scrollHost()
    if (element === null) return
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56
    const away = navAwayFromLatest(element.scrollTop, element.scrollHeight, element.clientHeight)
    setAwayFromLatest((previous) => (previous === away ? previous : away))
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      refreshNavigator()
    })
  }, [refreshNavigator, scrollHost])

  // React's onScroll only fires for the stream; the margin column may be the
  // real scroll area, so listen there too.
  useEffect(() => {
    const host = scrollHost()
    if (host === null) return undefined
    host.addEventListener('scroll', handleScroll, { passive: true })
    return () => host.removeEventListener('scroll', handleScroll)
  }, [handleScroll, scrollHost])

  useEffect(() => {
    const element = scrollHost()
    if (element === null) return
    if (stickRef.current) element.scrollTop = element.scrollHeight
    refreshNavigator()
  }, [messages, refreshNavigator, scrollHost])

  const scrollToLatest = useCallback(() => {
    const element = scrollHost()
    if (element === null) return
    stickRef.current = true
    setAwayFromLatest(false)
    element.scrollTo({ top: element.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [scrollHost])

  const jumpToQuestion = useCallback((mark: QuestionMark) => {
    const element = scrollHost()
    if (element === null) return
    const target = element.querySelector<HTMLElement>(`[data-message-id="${mark.messageId}"]`)
    if (target === null) return
    const containerRect = element.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const top = navTargetScrollTop(element.scrollTop, targetRect.top, containerRect.top, 12)
    stickRef.current = false
    element.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    setCurrentMarkId(mark.id)
    setFlashId(mark.messageId)
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null
      setFlashId(null)
    }, NAV_FLASH_DELAY)
  }, [scrollHost])

  /* ----- actions -------------------------------------------------------- */

  const copyEntry = useCallback(
    (entryId: string) => {
      void useAiStore
        .getState()
        .copyAnswer(entryId)
        .then((copied) => {
          useUiStore.getState().toast(copied ? t('ai.copied') : t('ai.copyFailed'), copied ? 'success' : 'error')
        })
    },
    [t],
  )

  const headerActions: MenuItem[] = [
    {
      id: 'export',
      label: t('ai.export'),
      icon: 'download',
      disabled: messages.length === 0,
      onSelect: () => {
        useAiStore.getState().downloadConversation({
          title: document?.title ?? '',
          modelLabel,
          t: tr,
        })
      },
    },
    { type: 'separator', id: 'sep-actions' },
    {
      id: 'clear',
      label: t('ai.clear'),
      icon: 'trash',
      danger: true,
      disabled: messages.length === 0 || busy,
      onSelect: () => {
        void useAiStore.getState().clearConversation()
      },
    },
  ]

  const questionNav =
    marks.length >= 2 ? (
      <Menu
        ariaLabel={t('ai.navLabel')}
        placement="bottom-end"
        button={(buttonProps) => (
          <button
            type="button"
            className="ln-iconbtn ln-ai__navbtn"
            aria-label={t('ai.navLabel')}
            title={t('ai.navLabel')}
            {...buttonProps}
          >
            <Icon name="list" size={16} />
            <span className="ln-ai__navcount ln-tabular">{marks.length}</span>
          </button>
        )}
        items={marks.map((mark) => ({
          id: mark.id,
          label: `${aiT(tr, 'ai.navQuestion', { index: mark.ordinal })} · ${excerpt(displayText(mark.question), 34)}`,
          icon: currentMarkId === mark.id ? 'check' : 'chevronRight',
          onSelect: () => jumpToQuestion(mark),
        }))}
      />
    ) : null

  /* ----- render --------------------------------------------------------- */

  const stateName =
    documentId === ''
      ? 'no-document'
      : historyState === 'loading' || historyState === 'idle'
        ? 'loading'
        : historyState === 'error'
          ? 'error'
          : busy
            ? 'streaming'
            : messages.length > 0
              ? 'ready'
              : 'empty'

  let stream: ReactNode
  if (documentId === '') {
    stream = <StateNote text={t('ai.noDocument')} />
  } else if (historyState === 'loading' || historyState === 'idle') {
    stream = <StateNote spinner text={t('ai.loadingHistory')} />
  } else if (historyState === 'error') {
    stream = (
      <StateNote
        tone="error"
        text={historyError === null ? t('ai.historyError') : errorText(tr, historyError)}
        action={
          <button type="button" className="ln-ai__action" onClick={() => void useAiStore.getState().retryHistory()}>
            {t('ai.retry')}
          </button>
        }
      />
    )
  } else if (messages.length === 0 && !busy) {
    stream = (
      <div className="ln-ai__empty">
        <div className="ln-ai__empty-title">
          <span className="ln-ai__spark" aria-hidden="true">
            ✦
          </span>
          <span>{available ? t('ai.emptyTitle') : t('ai.unavailableTitle')}</span>
        </div>
        <p className="ln-ai__empty-text">{available ? t('ai.emptyText') : t('ai.unavailableText')}</p>
      </div>
    )
  } else if (visibleTurns.length === 0) {
    stream = marginFilter === 'ai' || marginFilter === 'user' ? null : <StateNote text={t('ai.emptyText')} />
  } else {
    stream = (
      <div className="ln-ai__turns">
        {visibleTurns.map((turn) => (
          <TurnView
            key={turn.id}
            t={tr}
            turn={turn}
            isLatest={turn.id === lastAssistantId}
            busy={busy}
            streaming={turn.assistant !== null && turn.assistant.id === streamingId}
            flash={flashId !== null && turn.id === flashId}
            collapsed={collapsed[turn.id] === true}
            showEntailment={showEntailmentEnabled}
            streamError={streamError}
            onToggleCollapse={() =>
              setCollapsed((state) => ({ ...state, [turn.id]: state[turn.id] !== true }))
            }
            onCopy={copyEntry}
            onRegenerate={(entryId) => void useAiStore.getState().regenerate(entryId)}
            onFollowup={(question) => void useAiStore.getState().askFollowup(question)}
            onStop={() => useAiStore.getState().stop()}
            onRetry={() => void useAiStore.getState().retryStream()}
            onDismissError={() => useAiStore.getState().dismissError()}
            citationHandlers={{ t: tr, onHover: showCitation, onLeave: scheduleCardHide, onClick: onCitationClick }}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="ln-ai" data-state={stateName} data-busy={busy ? 'true' : 'false'}>
      <div className="ln-ai__head">
        <div className="ln-ai__head-actions">
          {questionNav}
          <Menu
            ariaLabel={t('action.more')}
            placement="bottom-end"
            button={(buttonProps) => (
              <button
                type="button"
                className="ln-iconbtn"
                aria-label={t('action.more')}
                title={t('action.more')}
                {...buttonProps}
              >
                <Icon name="more" size={16} />
              </button>
            )}
            items={headerActions}
          />
        </div>
      </div>
      <div
        ref={streamRef}
        className="ln-ai__stream ln-scroll"
        role="log"
        aria-label={t('ai.title')}
        onScroll={handleScroll}
      >
        {stream}
      </div>
      {awayFromLatest ? (
        <button type="button" className="ln-ai__tolatest" onClick={scrollToLatest}>
          <Icon name="chevronDown" size={13} />
          <span>{t('ai.toLatest')}</span>
        </button>
      ) : null}
      {card !== null && card.citation !== null ? (
        <CitationCard
          t={tr}
          index={card.index}
          citation={card.citation}
          verified={card.verified}
          style={floatingStyles}
          floatingRef={refs.setFloating}
          onKeep={cancelCardHide}
          onLeave={scheduleCardHide}
          onClose={closeCard}
          onJump={jump}
        />
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* State / turn rendering                                                     */
/* -------------------------------------------------------------------------- */

/** One loading/error/empty note row. */
function StateNote(props: { text: string; spinner?: boolean; tone?: 'error'; action?: ReactNode }): ReactElement {
  return (
    <div className="ln-ai__state" data-tone={props.tone}>
      {props.spinner === true ? <Spinner size={14} label={props.text} /> : null}
      <span>{props.text}</span>
      {props.action === undefined ? null : props.action}
    </div>
  )
}

/** Everything one turn needs to render. */
interface TurnViewProps {
  t: AiTranslate
  turn: ChatTurn
  isLatest: boolean
  busy: boolean
  streaming: boolean
  flash: boolean
  collapsed: boolean
  showEntailment: boolean
  streamError: AiStreamError | null
  onToggleCollapse: () => void
  onCopy: (entryId: string) => void
  onRegenerate: (entryId: string) => void
  onFollowup: (question: string) => void
  onStop: () => void
  onRetry: () => void
  onDismissError: () => void
  citationHandlers: {
    t: Parameters<typeof CitationChip>[0]['t']
    onHover: (event: CitationAnchorEvent, payload: CitationPayload) => void
    onLeave: () => void
    onClick: (event: CitationAnchorEvent, payload: CitationPayload) => void
  }
}

/** One question→answer turn in the margin stream. */
function TurnView(props: TurnViewProps): ReactElement {
  const {
    t,
    turn,
    isLatest,
    busy,
    streaming,
    flash,
    collapsed,
    showEntailment,
    streamError,
    onToggleCollapse,
    onCopy,
    onRegenerate,
    onFollowup,
    onStop,
    onRetry,
    onDismissError,
    citationHandlers,
  } = props
  const assistant: ChatEntry | null = turn.assistant
  const answer = assistant?.answer ?? ''
  const phase = assistant?.phase ?? ''
  const failed = assistant?.failed === true
  const stopped = assistant?.stopped === true
  const longAnswer = answer.length > COLLAPSE_THRESHOLD
  const thinking = streaming && answer === ''
  const statusLabel = phase === 'entailment' ? t('ai.checkingClaims') : t('ai.thinking')
  const failure: AiFailure | null =
    assistant !== null && streamError !== null && streamError.entryId === assistant.id
      ? { code: 'stream', message: streamError.message, retryable: streamError.retryable }
      : null
  const breakdown = unverifiedBreakdown(assistant?.unverified)
  const annotationCount = assistant?.annotationIds.length ?? 0

  const citationLookup = useMemo(() => {
    const lookup = new Map<number, { citation: CitationPayload['citation']; verified: boolean }>()
    for (const citation of assistant?.citations ?? []) {
      lookup.set(citation.index, { citation, verified: citation.verified !== false })
    }
    for (const citation of assistant?.unverified ?? []) {
      if (!lookup.has(citation.index)) lookup.set(citation.index, { citation, verified: false })
    }
    return lookup
  }, [assistant])

  const renderCitation = useCallback(
    (index: number): ReactElement => {
      const entry = citationLookup.get(index)
      return (
        <CitationChip
          index={index}
          citation={entry?.citation ?? null}
          verified={entry?.verified ?? false}
          t={citationHandlers.t}
          onHover={citationHandlers.onHover}
          onLeave={citationHandlers.onLeave}
          onClick={citationHandlers.onClick}
        />
      )
    },
    [citationLookup, citationHandlers],
  )

  const actions: ReactElement[] = []
  if (assistant !== null && streaming) {
    actions.push(
      <button key="stop" type="button" className="ln-ai__action" onClick={onStop}>
        <Icon name="stop" size={13} />
        <span>{t('ai.stop')}</span>
      </button>,
    )
  } else if (assistant !== null) {
    if (answer !== '') {
      actions.push(
        <button key="copy" type="button" className="ln-ai__action" onClick={() => onCopy(assistant.id)}>
          <Icon name="copy" size={13} />
          <span>{t('ai.copy')}</span>
        </button>,
      )
    }
    if (turn.question.trim() !== '') {
      actions.push(
        <button
          key="regenerate"
          type="button"
          className="ln-ai__action"
          disabled={busy}
          onClick={() => onRegenerate(assistant.id)}
        >
          <Icon name="refresh" size={13} />
          <span>{t('ai.regenerate')}</span>
        </button>,
      )
    }
    if (longAnswer) {
      actions.push(
        <button key="collapse" type="button" className="ln-ai__action" onClick={onToggleCollapse}>
          <Icon name={collapsed ? 'chevronDown' : 'chevronRight'} size={13} />
          <span>{collapsed ? t('ai.expand') : t('ai.collapse')}</span>
        </button>,
      )
    }
  }

  const entryId = assistant?.id ?? turn.id
  return (
    <article
      className={`ln-ai__turn${flash ? ' is-flash' : ''}`}
      data-kind="answer"
      data-message-id={entryId}
      data-anchor-block={turn.anchorBlockKey ?? undefined}
      data-created-at={turn.createdAt !== '' ? turn.createdAt : undefined}
      data-streaming={streaming ? 'true' : 'false'}
      data-failed={failed ? 'true' : 'false'}
    >
      {turn.question.trim() !== '' ? (
        <header className="ln-ai__question">
          <span className="ln-ai__question-label">{t('ai.questionLabel')}</span>
          <span className="ln-ai__question-text">{displayText(turn.question)}</span>
        </header>
      ) : null}
      <div className={`ln-ai__answer${collapsed ? ' is-collapsed' : ''}`}>
        {thinking ? (
          <div className="ln-ai__status" role="status" aria-live="polite" aria-label={t('ai.generating')}>
            <Spinner size={13} label={statusLabel} />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {answer !== '' ? <AiMarkdown text={answer} renderCitation={renderCitation} /> : null}
        {streaming && answer !== '' ? (
          <span className="ln-ai__caret" aria-hidden="true">
            ▍
          </span>
        ) : null}
        {streaming && phase === 'entailment' && answer !== '' ? (
          <div className="ln-ai__status" role="status" aria-live="polite">
            <Spinner size={13} label={t('ai.checkingClaims')} />
            <span>{t('ai.checkingClaims')}</span>
          </div>
        ) : null}
        {stopped ? <div className="ln-ai__notice">{t('ai.stopped')}</div> : null}
        {failure !== null && assistant !== null ? (
          <div className="ln-ai__error" role="alert">
            <span>{failure.message}</span>
            <div className="ln-ai__actions">
              {failure.retryable ? (
                <button type="button" className="ln-ai__action" onClick={onRetry}>
                  {t('ai.retry')}
                </button>
              ) : null}
              <IconButton icon="close" size={12} label={t('ai.dismiss')} onClick={onDismissError} />
            </div>
          </div>
        ) : null}
        {failed && failure === null && !streaming ? (
          <div className="ln-ai__error" role="alert">
            <span>{t('ai.errGeneric')}</span>
          </div>
        ) : null}
        {assistant !== null && !streaming && answer !== '' ? (
          <div className="ln-ai__evidence">
            {(assistant.citations.length > 0 || assistant.unverified.length > 0) && (
              <>
                <span className="ln-ai__evidence-summary">
                  {t('ai.citationsCount', { count: formatCount(assistant.citations.length + assistant.unverified.length) })}
                </span>
                {assistant.citations.map((citation, index) => (
                  <CitationChip
                    key={`verified-${citation.index}-${index}`}
                    index={citation.index}
                    citation={citation}
                    verified={citation.verified !== false}
                    t={citationHandlers.t}
                    onHover={citationHandlers.onHover}
                    onLeave={citationHandlers.onLeave}
                    onClick={citationHandlers.onClick}
                  />
                ))}
                {assistant.unverified.map((citation, index) => (
                  <CitationChip
                    key={`unverified-${citation.index}-${index}`}
                    index={citation.index}
                    citation={citation}
                    verified={false}
                    t={citationHandlers.t}
                    onHover={citationHandlers.onHover}
                    onLeave={citationHandlers.onLeave}
                    onClick={citationHandlers.onClick}
                  />
                ))}
              </>
            )}
            {showEntailment && breakdown.unsupported > 0 ? (
              <div className="ln-ai__notice ln-ai__notice--entailment">
                <span className="ln-ai__spark" aria-hidden="true">
                  ✦
                </span>
                <span>{t('ai.entailmentNotice', { count: formatCount(breakdown.unsupported) })}</span>
              </div>
            ) : null}
            {breakdown.generic > 0 ? (
              <div className="ln-ai__notice">
                <span className="ln-ai__spark" aria-hidden="true">
                  ✦
                </span>
                <span>{t('ai.unverifiedNotice', { count: formatCount(breakdown.generic) })}</span>
              </div>
            ) : null}
            {annotationCount > 0 ? (
              <div className="ln-ai__notice">
                <span className="ln-ai__spark" aria-hidden="true">
                  ✦
                </span>
                <span>{t('ai.annotationsNotice', { count: formatCount(annotationCount) })}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        {actions.length > 0 ? <div className="ln-ai__actions">{actions}</div> : null}
        {assistant !== null && isLatest && !streaming && (assistant.followups.length > 0) ? (
          <div className="ln-ai__followups" aria-label={t('ai.followups')}>
            {assistant.followups.slice(0, 3).map((followup, index) => (
              <button
                key={`followup-${index}`}
                type="button"
                className="ln-ai__followup"
                disabled={busy}
                onClick={() => onFollowup(followup)}
              >
                {displayText(followup)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}

/** Re-export the citation jump handler type used by the reader's tether layer. */
export type AiCitationPayload = CitationPayload
