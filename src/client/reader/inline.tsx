/**
 * Inline run renderer.
 *
 * Turns the shared flat-run model (`Run[]`) plus the annotations covering that
 * run space into React nodes. Annotation overlays come from the shared
 * `overlayRuns` helper, so the Host's stored offsets and the rendered
 * highlights can never disagree.
 *
 * Every rendered segment carries `data-off`/`data-len` (absolute offsets into
 * the block's plain text). The selection reader uses those markers to map a DOM
 * point back to an annotation offset without measuring text nodes.
 */

import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { overlayRuns } from '../../shared/annotate/highlight.ts'
import type { OverlaySegment } from '../../shared/annotate/highlight.ts'
import type { Run } from '../../shared/markdown/model.ts'
import type { AnnotationColor } from '../../shared/constants.ts'
import type { NormalizedAnnotation } from '../../shared/annotate/highlight.ts'
import { renderFormula } from './katex.ts'

/** Where a highlight click came from (the scene opens the matching slip). */
export type MarkClickHandler = (annotationId: string, event: MouseEvent<HTMLElement>) => void

/** Options accepted by {@link renderInlineRuns}. */
export interface InlineRenderOptions {
  /** Annotations covering this run space (offsets already rebased). */
  annotations: readonly NormalizedAnnotation[]
  /** Whether the KaTeX runtime is ready; math falls back to raw source until then. */
  katexReady: boolean
  /** Currently flashed annotation (outline + tether emphasis). */
  activeAnnotationId?: string | null
  /** Called when an annotated span is clicked without a live text selection. */
  onMarkClick?: MarkClickHandler
  /** Absolute plain-text offset of this run space (list items, table cells). */
  baseOffset?: number
  /** Accessible label for unrecognized-glyph placeholders. */
  unknownSymbolLabel?: string
  className?: string
}

/** One math run rendered through KaTeX with a monospace fallback. */
export function FormulaView({
  latex,
  display,
  katexReady,
  inline = false,
  className,
}: {
  latex: string
  display: boolean
  katexReady: boolean
  inline?: boolean
  className?: string
}): ReactElement {
  const base = inline ? 'ln-formula ln-formula--inline' : 'ln-formula ln-formula--display'
  const classes = className === undefined ? base : `${base} ${className}`
  const html = katexReady ? renderFormula(latex, display) : ''
  if (html !== '') {
    const props = {
      className: classes,
      'data-latex': latex,
      dangerouslySetInnerHTML: { __html: html },
    }
    return inline ? <span {...props} /> : <div {...props} />
  }
  const fallback = (
    <>
      <span className="ln-formula__delimiter" aria-hidden="true">
        {inline ? '$' : '$$'}
      </span>
      {latex}
      <span className="ln-formula__delimiter" aria-hidden="true">
        {inline ? '$' : '$$'}
      </span>
    </>
  )
  return inline
    ? <span className={`${classes} ln-formula--raw`} data-latex={latex}>{fallback}</span>
    : <div className={`${classes} ln-formula--raw`} data-latex={latex}>{fallback}</div>
}

/** Map one run's style flags onto nested inline elements (frozen order). */
function styleNode(segment: OverlaySegment, inner: ReactNode, key: string): ReactNode {
  let node = inner
  const styles = segment.styles
  if (styles.link !== undefined && styles.link !== '') {
    node = (
      <a className="ln-link" href={styles.link} target="_blank" rel="noopener noreferrer">
        {node}
      </a>
    )
  }
  if (styles.code === true) node = <code className="ln-inline-code">{node}</code>
  if (styles.del === true) node = <del>{node}</del>
  if (styles.em === true) node = <em>{node}</em>
  if (styles.strong === true) node = <strong>{node}</strong>
  void key
  return node
}

/** Render plain text, replacing unrecognized-glyph markers with an accessible box. */
function textNode(text: string, unknownSymbolLabel: string, keyPrefix: string): ReactNode {
  if (text.indexOf('\ufffd') === -1) return text
  const parts = text.split('\ufffd')
  const children: ReactNode[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? ''
    if (part !== '') children.push(part)
    if (index < parts.length - 1) {
      children.push(
        <span
          key={`${keyPrefix}-unknown-${index}`}
          className="ln-unknown-symbol"
          role="img"
          aria-label={unknownSymbolLabel}
          title={unknownSymbolLabel}
        >
          □
        </span>,
      )
    }
  }
  return children
}

/** Annotation ink class name for one mark. */
function inkName(color: AnnotationColor | null): AnnotationColor {
  return color ?? 'yellow'
}

/**
 * Render a run list with annotation overlays.
 *
 * Returns one `<span data-off data-len>` per overlay segment; annotated spans
 * wrap their content in `<mark class="ln-hl" data-ink data-id>` exactly as the
 * DESIGN-V2 §5 block contract requires.
 */
export function renderInlineRuns(
  runs: readonly Run[] | null | undefined,
  options: InlineRenderOptions,
): ReactElement[] {
  const segments = overlayRuns(Array.isArray(runs) ? runs : [], options.annotations)
  const baseOffset = options.baseOffset ?? 0
  const unknownSymbolLabel = options.unknownSymbolLabel ?? ''
  const nodes: ReactElement[] = []
  let offset = baseOffset
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) continue
    const length = segment.text.length
    const start = offset
    offset += length
    if (segment.type !== 'math' && segment.text === '') continue
    let inner: ReactNode
    if (segment.type === 'math') {
      inner = (
        <FormulaView
          latex={segment.latex ?? ''}
          display={false}
          inline
          katexReady={options.katexReady}
        />
      )
    } else {
      inner = textNode(segment.text, unknownSymbolLabel, `seg-${index}`)
    }
    inner = styleNode(segment, inner, `seg-${index}`)
    if (segment.annotationIds.length > 0) {
      const firstId = segment.annotationIds[0] ?? ''
      const active =
        options.activeAnnotationId !== undefined &&
        options.activeAnnotationId !== null &&
        segment.annotationIds.includes(options.activeAnnotationId)
      const onMarkClick = options.onMarkClick
      inner = (
        <mark
          className={`ln-hl${active ? ' is-active' : ''}`}
          data-ink={inkName(segment.color)}
          data-color={inkName(segment.color)}
          data-id={firstId}
          data-annotation-id={firstId}
          data-annotation-ids={segment.annotationIds.join(' ')}
          role="mark"
          tabIndex={onMarkClick === undefined ? undefined : 0}
          onClick={
            onMarkClick === undefined
              ? undefined
              : (event: MouseEvent<HTMLElement>) => {
                  const selection = typeof window === 'undefined' ? null : window.getSelection()
                  if (selection !== null && !selection.isCollapsed) return
                  event.stopPropagation()
                  onMarkClick(firstId, event)
                }
          }
          onKeyDown={
            onMarkClick === undefined
              ? undefined
              : (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onMarkClick(firstId, event as unknown as MouseEvent<HTMLElement>)
                }
          }
        >
          {inner}
        </mark>
      )
    }
    nodes.push(
      <span key={`seg-${index}`} data-off={start} data-len={length}>
        {inner}
      </span>,
    )
  }
  return nodes
}
