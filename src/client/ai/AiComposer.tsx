/**
 * The margin composer: the fixed bottom of the reader's margin column.
 *
 * Owns the textarea, the context chip (选区, handed over by the reader selection
 * toolbar through `registerAskAI`), the send/stop controls and the
 * model-unavailable setup hint. Sending is `⌘/Ctrl+Enter`; `Shift+Enter` keeps a
 * newline; `Escape` stops a running answer. All copy is localized through
 * `useT()`.
 */

import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, Kbd } from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'
import { excerpt } from './chat.ts'
import { clearReaderSelection, useBlockExcerpt, useVisibleBlockKey } from './reader-bridge.ts'
import { useAiStore } from './store.ts'

/** Props of {@link AiComposer}. */
export interface AiComposerProps {
  /** Open document id (the store already knows it; kept for explicitness). */
  documentId: string
  /** Model availability from `status.ai.available`. */
  available: boolean
  /** Model label from `status.ai.route.model` (shown in the header). */
  modelLabel: string
  /** Jump to a block (context chip label click). */
  onJump?: (blockKey: string) => void
}

/**
 * The AI composer pinned to the bottom of the margin column.
 *
 * When the model is unavailable it renders the setup invitation instead of the
 * input, so the reader is told what to configure rather than facing a dead
 * textarea.
 */
export function AiComposer({ documentId, available, modelLabel, onJump }: AiComposerProps): ReactElement {
  const t = useT()
  const input = useAiStore((state) => state.input)
  const setInput = useAiStore((state) => state.setInput)
  const busy = useAiStore((state) => state.busy)
  const ask = useAiStore((state) => state.ask)
  const stop = useAiStore((state) => state.stop)
  const historyState = useAiStore((state) => state.historyState)
  const context = useAiStore((state) => state.composerContext)
  const focusTick = useAiStore((state) => state.composerFocusTick)
  const setAutoFocus = useAiStore((state) => state.setAutoFocus)
  const visibleBlockKey = useVisibleBlockKey()
  const autoFocusText = useBlockExcerpt(visibleBlockKey)
  const [autoCleared, setAutoCleared] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // The reader publishes the block under the reading line (`visibleBlockKey`);
  // mirror it as the composer's 本段 context unless the reader clears it or a
  // text selection takes precedence.
  useEffect(() => {
    setAutoFocus(autoCleared ? null : visibleBlockKey)
  }, [visibleBlockKey, autoCleared, setAutoFocus])

  useEffect(() => {
    setAutoCleared(false)
  }, [visibleBlockKey])

  useEffect(() => {
    if (focusTick === 0) return
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.focus()
    const length = textarea.value.length
    textarea.setSelectionRange(length, length)
  }, [focusTick])

  const canSend = available && !busy && historyState !== 'loading' && input.trim() !== ''

  const submit = (): void => {
    if (!canSend || documentId === '') return
    void ask(input)
  }

  if (!available) {
    return (
      <div className="ln-ai__composer ln-ai__composer--setup" data-available="false">
        <div className="ln-ai__setup" role="note">
          <span className="ln-ai__spark" aria-hidden="true">
            ✦
          </span>
          <div className="ln-ai__setup-text">
            <strong>{t('ai.unavailableTitle')}</strong>
            <span>{t('ai.unavailableText')}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ln-ai__composer" data-busy={busy ? 'true' : 'false'} data-available="true">
      {context !== null ? (
        <div className="ln-ai__context" role="group" aria-label={t('ai.selection')}>
          <div className="ln-ai__chip" data-kind="selection">
            <button
              type="button"
              className="ln-ai__chip-label"
              title={context.quote !== '' ? context.quote : context.blockKey}
              onClick={() => {
                if (context.blockKey !== '' && onJump !== undefined) onJump(context.blockKey)
              }}
            >
              <span className="ln-ai__chip-kind">{t('ai.selection')}</span>
              <span className="ln-ai__chip-quote">{excerpt(context.quote !== '' ? context.quote : context.blockKey, 32)}</span>
            </button>
            <IconButton
              icon="close"
              size={12}
              label={t('ai.clearContext')}
              onClick={() => clearReaderSelection()}
            />
          </div>
        </div>
      ) : autoCleared || visibleBlockKey === null || visibleBlockKey === '' ? null : (
        <div className="ln-ai__context" role="group" aria-label={t('ai.visible')}>
          <div className="ln-ai__chip" data-kind="visible">
            <button
              type="button"
              className="ln-ai__chip-label"
              title={visibleBlockKey}
              onClick={() => {
                if (onJump !== undefined) onJump(visibleBlockKey)
              }}
            >
              <span className="ln-ai__chip-kind">{t('ai.visible')}</span>
              <span className="ln-ai__chip-quote">{excerpt(autoFocusText !== '' ? autoFocusText : visibleBlockKey, 32)}</span>
            </button>
            <IconButton
              icon="close"
              size={12}
              label={t('ai.clearParagraph')}
              onClick={() => setAutoCleared(true)}
            />
          </div>
        </div>
      )}
      <div className="ln-ai__inputrow">
        <textarea
          ref={textareaRef}
          className="ln-ai__input"
          value={input}
          rows={3}
          placeholder={t('ai.placeholder')}
          aria-label={t('ai.placeholder')}
          spellCheck={false}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
              return
            }
            if (event.key === 'Escape' && busy) {
              event.preventDefault()
              stop()
            }
          }}
        />
      </div>
      <div className="ln-ai__composer-actions">
        <span className="ln-ai__hint">
          {busy ? (
            t('ai.busyHint')
          ) : (
            <>
              <Kbd>⌘/Ctrl</Kbd> + <Kbd>Enter</Kbd> {t('ai.send')}
            </>
          )}
          {modelLabel !== '' && !busy ? <span className="ln-ai__model">{t('ai.model', { model: modelLabel })}</span> : null}
        </span>
        {busy ? (
          <Button variant="quiet" size="sm" icon="stop" onClick={stop} aria-label={t('ai.stop')}>
            {t('ai.stop')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon="send"
            onClick={submit}
            disabled={!canSend}
            aria-label={t('ai.send')}
          >
            {t('ai.send')}
          </Button>
        )}
      </div>
    </div>
  )
}
