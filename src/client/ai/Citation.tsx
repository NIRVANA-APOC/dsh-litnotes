/**
 * Citation chips and the hover preview card for AI answers.
 *
 * The chip is the product's trust affordance: `[n]` sits inside the answer and
 * carries verified/partial/unsupported state; the card explains the evidence
 * (page, aspect, quote, claim note) and offers `跳到原文`. An
 * entailment-unsupported citation is never jumpable — the quote is real but it
 * does not support the claim, so sending the reader to the text would present it
 * as evidence.
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { Aspect } from '../../shared/constants.ts'
import type { AiCitation, AiTranslate, CitationFlags } from './chat.ts'
import { aiT, citationFlags, displayText, formatCount } from './chat.ts'

/** What a citation interaction carries. */
export interface CitationPayload {
  index: number
  citation: AiCitation | null
  verified: boolean
}

/** Handlers shared by every chip of one answer. */
export interface CitationHandlers {
  t: AiTranslate
  onHover: (event: ReactMouseEvent<HTMLElement>, payload: CitationPayload) => void
  onLeave: () => void
  onClick: (event: ReactMouseEvent<HTMLElement>, payload: CitationPayload) => void
}

/** Read one citation aspect safely (labels resolve through `aspect.*` keys). */
export function aspectLabel(t: AiTranslate, aspect: Aspect): string {
  return aiT(t, `aspect.${aspect}`)
}

/** Accessible label + title of one chip (frozen `mruAiCitationChipFor` copy). */
export function citationChipText(
  t: AiTranslate,
  index: number,
  citation: AiCitation | null,
  verified: boolean,
): { label: string; title: string } {
  const page = citation !== null && citation.page !== null && citation.page > 0 ? citation.page : 0
  const flags = citationFlags(citation, verified)
  let label: string
  if (citation === null) {
    label = aiT(t, 'ai.missingCitation', { index: formatCount(index) })
  } else if (page > 0) {
    label = aiT(t, 'ai.citationLabelPage', { index: formatCount(index), page: formatCount(page) })
  } else {
    label = aiT(t, 'ai.citationLabel', { index: formatCount(index) })
  }
  const marks: string[] = []
  if (flags.partial) marks.push(aiT(t, 'ai.entailmentPartialShort'))
  if (flags.unsupported) marks.push(aiT(t, 'ai.entailmentUnsupportedShort'))
  let title = citation === null ? label : ''
  if (marks.length > 0) {
    const suffix = marks.join(' · ')
    label = `${label} · ${suffix}`
    const quote = citation !== null && citation.quote !== '' ? displayText(citation.quote) : ''
    title = quote !== '' ? `${suffix} · ${quote}` : suffix
  }
  return { label, title }
}

/** Class names of one chip from its citation state. */
export function citationChipClass(citation: AiCitation | null, verified: boolean, flags: CitationFlags): string {
  const classes = ['ln-ai__cite']
  if (!verified || citation === null) classes.push('ln-ai__cite--unverified')
  if (citation === null) classes.push('ln-ai__cite--missing')
  if (flags.partial) classes.push('ln-ai__cite--partial')
  if (flags.unsupported) classes.push('ln-ai__cite--unsupported')
  return classes.join(' ')
}

/** Props of {@link CitationChip}. */
export interface CitationChipProps extends CitationHandlers {
  index: number
  citation: AiCitation | null
  verified: boolean
}

/**
 * One inline `[n]` citation chip.
 *
 * Hover/focus opens the preview card; click jumps to the cited block. The
 * button keeps a stable `data-index`/`data-verified` state for styling and tests.
 */
export function CitationChip({ index, citation, verified, t, onHover, onLeave, onClick }: CitationChipProps): ReactElement {
  const effectiveVerified = verified && citation !== null
  const flags = citationFlags(citation, effectiveVerified)
  const { label, title } = citationChipText(t, index, citation, effectiveVerified)
  const payload: CitationPayload = { index, citation, verified: effectiveVerified }
  return (
    <button
      type="button"
      className={citationChipClass(citation, effectiveVerified, flags)}
      data-index={index}
      data-verified={effectiveVerified ? 'true' : 'false'}
      data-entailment={citation !== null && citation.entailment !== '' ? citation.entailment : undefined}
      data-block-key={citation !== null && citation.blockKey !== '' ? citation.blockKey : undefined}
      aria-label={label}
      title={title !== '' ? title : label}
      onMouseEnter={(event) => onHover(event, payload)}
      onMouseLeave={onLeave}
      onFocus={(event) => onHover(event, payload)}
      onBlur={onLeave}
      onClick={(event) => onClick(event, payload)}
    >
      [{index}]
    </button>
  )
}

/** Props of {@link CitationCard}. */
export interface CitationCardProps {
  t: AiTranslate
  index: number
  citation: AiCitation
  verified: boolean
  style: CSSProperties
  floatingRef: (node: HTMLElement | null) => void
  onKeep: () => void
  onLeave: () => void
  onClose: () => void
  onJump: (blockKey: string) => void
}

/**
 * Hover preview card for one citation (fixed overlay, rendered in the tree).
 *
 * Shows page/aspect/claim-check meta, the verbatim quote and the claim note.
 * Jump is hidden for entailment-unsupported citations; Escape or the close
 * button dismisses.
 */
export function CitationCard(props: CitationCardProps): ReactElement {
  const { t, index, citation, verified, style, floatingRef, onKeep, onLeave, onClose, onJump } = props
  const flags = citationFlags(citation, verified)
  const meta: ReactElement[] = [
    <span key="chip" className={citationChipClass(citation, verified, flags)} data-index={index}>
      [{index}]
    </span>,
  ]
  if (citation.page !== null && citation.page > 0) {
    meta.push(
      <span key="page">
        {' · '}
        {aiT(t, 'ai.citationLabelPage', { index: formatCount(index), page: formatCount(citation.page) })}
      </span>,
    )
  }
  meta.push(
    <span key="aspect" data-aspect={citation.aspect}>
      {' · '}
      {aspectLabel(t, citation.aspect)}
    </span>,
  )
  const entailmentReason = citation.entailmentReason.trim()
  if (flags.partial) {
    meta.push(
      <span
        key="claim"
        className="ln-ai__claim ln-ai__claim--partial"
        title={entailmentReason !== '' ? displayText(entailmentReason) : undefined}
      >
        {' · '}
        {aiT(t, 'ai.claimCheck')}
        {': '}
        {aiT(t, 'ai.entailmentPartial')}
      </span>,
    )
  }
  if (!verified) {
    if (flags.unsupported) {
      meta.push(
        <span
          key="claim"
          className="ln-ai__claim ln-ai__claim--unsupported"
          title={entailmentReason !== '' ? displayText(entailmentReason) : undefined}
        >
          {' · '}
          {aiT(t, 'ai.claimCheck')}
          {': '}
          {aiT(t, 'ai.entailmentUnsupported')}
        </span>,
      )
    } else {
      meta.push(<span key="unverified">{` · ${aiT(t, 'ai.unverifiedShort')}`}</span>)
    }
  }
  return (
    <div
      ref={floatingRef}
      className="ln-ai__citecard"
      role="dialog"
      aria-label={aiT(t, 'ai.citationLabel', { index: formatCount(index) })}
      data-index={index}
      data-verified={verified ? 'true' : 'false'}
      style={style}
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
      onFocus={onKeep}
      onBlur={onLeave}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="ln-ai__citecard-meta">{meta}</div>
      {citation.quote !== '' ? <blockquote className="ln-ai__citecard-quote">{displayText(citation.quote)}</blockquote> : null}
      {citation.note !== '' ? <p className="ln-ai__citecard-note">{displayText(citation.note)}</p> : null}
      <div className="ln-ai__actions">
        {citation.blockKey !== '' && !flags.unsupported ? (
          <button type="button" className="ln-ai__action" onClick={() => onJump(citation.blockKey)}>
            {aiT(t, 'ai.jump')}
          </button>
        ) : null}
        <button
          type="button"
          className="ln-ai__action ln-ai__action--compact"
          aria-label={aiT(t, 'ai.dismiss')}
          title={aiT(t, 'ai.dismiss')}
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  )
}
