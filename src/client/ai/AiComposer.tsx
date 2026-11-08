/**
 * The margin composer: the fixed bottom of the reader's margin column.
 *
 * Owns the textarea, the explicit context chip (a text selection or one
 * paragraph, handed over by the reader through `registerAskAI`), the
 * send/stop controls and the model-unavailable setup hint. Without an explicit
 * context the Host answers over the whole document (the default chip is 全文).
 * Sending is `⌘/Ctrl+Enter`; `Shift+Enter` keeps a newline; `Escape` stops a
 * running answer. All copy is localized through `useT()`.
 */

import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import { Button, IconButton, Kbd } from '../design/primitives.tsx'
import { useLibraryStore } from '../state/library.ts'
import { useT } from '../shell/locale-context.ts'
import { excerpt } from './chat.ts'
import { clearReaderSelection } from './reader-bridge.ts'
import { QUICK_PROMPT_KEYS } from './quick-prompts.ts'
import { useAiStore } from './store.ts'

/** Props of {@link AiComposer}. */
export interface AiComposerProps {
  /** Open document id (the store already knows it; kept for explicitness). */
  documentId: string
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
export function AiComposer({ documentId, onJump }: AiComposerProps): ReactElement {
  const t = useT()
  const status = useLibraryStore((state) => state.status)
  const available = status?.ai?.available === true
  const modelLabel = status?.ai?.route?.model ?? ''
  const input = useAiStore((state) => state.input)
  const setInput = useAiStore((state) => state.setInput)
  const busy = useAiStore((state) => state.busy)
  const ask = useAiStore((state) => state.ask)
  const stop = useAiStore((state) => state.stop)
  const historyState = useAiStore((state) => state.historyState)
  const context = useAiStore((state) => state.composerContext)
  const focusTick = useAiStore((state) => state.composerFocusTick)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

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
      {busy ? null : (
        <div className="ln-ai__quickrow" role="group" aria-label={t('ai.quickLabel')}>
          {QUICK_PROMPT_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="ln-ai__quickchip"
              onClick={() => void useAiStore.getState().ask(t(key))}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
      {context === null ? (
        <div className="ln-ai__context" role="group" aria-label={t('ai.document')}>
          <div className="ln-ai__chip" data-kind="document">
            <span className="ln-ai__chip-label" title={t('ai.documentHint')}>
              <span className="ln-ai__chip-kind">{t('ai.document')}</span>
            </span>
          </div>
        </div>
      ) : (
        <div
          className="ln-ai__context"
          role="group"
          aria-label={context.kind === 'paragraph' ? t('ai.paragraph') : t('ai.selection')}
        >
          <div className="ln-ai__chip" data-kind={context.kind === 'paragraph' ? 'paragraph' : 'selection'}>
            <button
              type="button"
              className="ln-ai__chip-label"
              title={context.quote !== '' ? context.quote : context.blockKey}
              onClick={() => {
                if (context.blockKey !== '' && onJump !== undefined) onJump(context.blockKey)
              }}
            >
              <span className="ln-ai__chip-kind">
                {context.kind === 'paragraph' ? t('ai.paragraph') : t('ai.selection')}
              </span>
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
