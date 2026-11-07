/**
 * Translation surfaces.
 *
 *  - `RichText` renders machine-translated text the same way the paper renders
 *    source runs (markdown emphasis/code/links + KaTeX formulas), because the
 *    translator keeps LaTeX source in its output and plain-text rendering left
 *    every formula as raw `$…$` (frozen 1.0.0 fix).
 *  - `TranslationBlock` is the quiet second voice under a paragraph in
 *    bilingual mode, with inline pending/error+retry states per block.
 *  - `SelectionTranslationCard` is the translator's slip for a text selection
 *    (`翻译` in the selection toolbar) with copy/retry/close.
 */

import type { ReactElement } from 'react'
import type { LitnotesTranslate } from '../shell/locale-context.ts'
import { parseMarkdown } from '../../shared/markdown/parse.ts'
import type { Block, PaperModel, Run } from '../../shared/markdown/model.ts'
import type { ReadingMode } from '../../shared/constants.ts'
import { IconButton, Spinner } from '../design/primitives.tsx'
import { FormulaView, renderInlineRuns } from './inline.tsx'
import { useRectFloating } from './floating.ts'
import type { TranslationJob } from './store.ts'

/** Select a translation entry for one block. */
function translationOf(
  entries: Record<string, string>,
  blockKey: string,
): string | null {
  const entry = entries[blockKey]
  return typeof entry === 'string' && entry !== '' ? entry : null
}

/** Plain display text of a translated markdown string. */
function displayText(value: string): string {
  return String(value ?? '').replace(/\ufffd/g, '□')
}

/**
 * Render translated markdown as rich reading content.
 *
 * Formulas go through KaTeX (raw fallback while loading); tables degrade to
 * one line per row (a translated table row is only worth reading as text).
 */
export function RichText({
  text,
  katexReady,
  className = 'ln-rich',
}: {
  text: string
  katexReady: boolean
  className?: string
}): ReactElement {
  let model: PaperModel | null
  try {
    model = parseMarkdown(text)
  } catch {
    model = null
  }
  const blocks = model === null ? [] : model.blocks
  if (blocks.length === 0) return <span className={className}>{displayText(text)}</span>
  const nodes: ReactElement[] = []
  const inline = (runs: readonly Run[] | null | undefined): ReactElement[] =>
    renderInlineRuns(runs, { annotations: [], katexReady })
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
      case 'quote':
        nodes.push(
          <p key={`rich-${index}`} className="ln-rich__p">
            {inline(block.runs)}
          </p>,
        )
        break
      case 'list':
        block.items.forEach((item, itemIndex) => {
          nodes.push(
            <p key={`rich-${index}-${itemIndex}`} className="ln-rich__item">
              <span className="ln-rich__bullet" aria-hidden="true">
                ·
              </span>
              {inline(item.runs)}
            </p>,
          )
        })
        break
      case 'formula':
        nodes.push(
          <FormulaView
            key={`rich-${index}`}
            latex={block.latex}
            display
            katexReady={katexReady}
          />,
        )
        break
      case 'code':
        nodes.push(
          <pre key={`rich-${index}`} className="ln-code ln-rich__code">
            <code>{block.code}</code>
          </pre>,
        )
        break
      case 'table': {
        const rows = block.head.length > 0 ? [block.head, ...block.rows] : block.rows
        rows.forEach((row, rowIndex) => {
          const value = row
            .map((cell) => cell.plainText)
            .filter((cellText) => cellText !== '')
            .join('  ')
          if (value !== '') {
            nodes.push(
              <p key={`rich-${index}-${rowIndex}`} className="ln-rich__p">
                {value}
              </p>,
            )
          }
        })
        break
      }
      default:
        break
    }
  })
  if (nodes.length === 0) return <span className={className}>{displayText(text)}</span>
  return <div className={className}>{nodes}</div>
}

/** Props of the per-block translation slot. */
export interface TranslationBlockProps {
  t: LitnotesTranslate
  block: Block
  mode: ReadingMode
  translation: string | null
  job: TranslationJob | undefined
  provider: string | undefined
  katexReady: boolean
  onRetry: (blockKey: string) => void
}

/**
 * The quiet translation voice under one block (bilingual / translated modes).
 *
 * `null` when the mode is original; a pending spinner while translating; a
 * retry action on failure (failures never block reading).
 */
export function TranslationBlock({
  t,
  block,
  mode,
  translation,
  job,
  provider,
  katexReady,
  onRetry,
}: TranslationBlockProps): ReactElement | null {
  if (mode === 'original') return null
  const text = translation !== null && translation !== '' ? translation : null
  if (text !== null) {
    const pending = job !== undefined && job.state === 'pending'
    return (
      <div
        className={`ln-para__translation${pending ? ' is-pending' : ''}`}
        data-block-translation={block.key}
      >
        <RichText text={text} katexReady={katexReady} />
        {provider !== undefined && provider !== '' ? (
          <span className="ln-para__provider">{t('read.translation.provider', { provider })}</span>
        ) : null}
      </div>
    )
  }
  if (job !== undefined && job.state === 'pending') {
    return (
      <div className="ln-para__translation is-pending" role="status" data-block-translation={block.key}>
        <Spinner size={12} label={t('read.translation.pending')} />
        <span className="ln-para__pendingText">{t('read.translation.pending')}</span>
      </div>
    )
  }
  if (job !== undefined && job.state === 'error') {
    return (
      <div className="ln-para__translation is-error" role="status" data-block-translation={block.key}>
        <span className="ln-para__errorText">{t('read.translation.failed')}</span>
        <button type="button" className="ln-link-btn" onClick={() => onRetry(block.key)}>
          {t('read.translation.retry')}
        </button>
      </div>
    )
  }
  return null
}

/** State of the selection translation card. */
export interface SelectionTranslationState {
  state: 'loading' | 'done' | 'error'
  quote: string
  translation: string
  provider: string
  /** Viewport rectangle of the selection the card is anchored to. */
  rect: DOMRect
}

/** Props of {@link SelectionTranslationCard}. */
export interface SelectionTranslationCardProps {
  t: LitnotesTranslate
  card: SelectionTranslationState
  katexReady: boolean
  onRetry: () => void
  onClose: () => void
  onCopy: () => void
}

/** The floating translation card for a text selection. */
export function SelectionTranslationCard({
  t,
  card,
  katexReady,
  onRetry,
  onClose,
  onCopy,
}: SelectionTranslationCardProps): ReactElement {
  const { setFloating, floatingStyles } = useRectFloating(card.rect, 'bottom-start')
  return (
    <div
      ref={setFloating}
      style={floatingStyles}
      className="ln-selcard"
      role="dialog"
      aria-label={t('selcard.label')}
    >
      <div className="ln-selcard__head">
        <span className="ln-selcard__label">{t('selcard.label')}</span>
        <IconButton icon="close" label={t('selcard.close')} size={15} onClick={onClose} />
      </div>
      <p className="ln-selcard__src">{displayText(card.quote)}</p>
      <div className="ln-selcard__body">
        {card.state === 'loading' ? <Spinner size={16} label={t('action.loading')} /> : null}
        {card.state === 'error' ? (
          <p className="ln-selcard__error">
            {t('selcard.error')}
            <button type="button" className="ln-link-btn" onClick={onRetry}>
              {t('selcard.retry')}
            </button>
          </p>
        ) : null}
        {card.state === 'done' ? (
          <div className="ln-selcard__text">
            <RichText text={card.translation} katexReady={katexReady} />
          </div>
        ) : null}
      </div>
      <div className="ln-selcard__foot">
        <span className="ln-selcard__provider">
          {card.state === 'done' && card.provider !== ''
            ? t('selcard.provider', { provider: card.provider })
            : ''}
        </span>
        <button
          type="button"
          className="ln-btn ln-btn--ghost ln-btn--sm"
          disabled={card.state !== 'done' || card.translation === ''}
          onClick={onCopy}
        >
          {t('selcard.copy')}
        </button>
      </div>
    </div>
  )
}

/** Select the translation text for one block (exported for the scene/test use). */
export { translationOf }
