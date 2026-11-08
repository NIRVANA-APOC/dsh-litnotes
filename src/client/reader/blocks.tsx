/**
 * Block renderers for the reading sheet.
 *
 * One component per block kind of the shared paper model; the wrapper always
 * carries `data-block-key` (the scroll/flash/jump target), `data-kind` and — for
 * annotatable blocks — `data-plain-length` (the annotation offset space, per the
 * DESIGN-V2 §5 block contract). Annotated ranges render as
 * `<mark class="ln-hl" data-ink data-id>`.
 *
 * Rendering is memoized per block with a comparator that only allows a re-render
 * when that block's own annotations/translation/hover/flash state changed, so
 * scrolling and hovering a note never re-renders the whole paper.
 */

import { memo } from 'react'
import type { ReactElement } from 'react'
import type { LitnotesTranslate } from '../shell/locale-context.ts'
import type { ReadingMode } from '../../shared/constants.ts'
import type { Block, ListBlock, TableBlock } from '../../shared/markdown/model.ts'
import type { NormalizedAnnotation } from '../../shared/annotate/highlight.ts'
import type { TranslationEnvelope } from '../../shared/model.ts'
import { getHostClient } from '../api/client.ts'
import { Button, IconButton, cx } from '../design/primitives.tsx'
import { FormulaView, renderInlineRuns } from './inline.tsx'
import type { MarkClickHandler } from './inline.tsx'
import { TranslationBlock } from './translation.tsx'
import type { TranslationJob } from './store.ts'

/** Everything a block needs from the scene (one object per render, memo-guarded). */
export interface BlockRenderContext {
  documentId: string
  t: LitnotesTranslate
  mode: ReadingMode
  katexReady: boolean
  annotationsByBlock: Map<string, NormalizedAnnotation[]>
  translations: TranslationEnvelope
  translationJobs: Record<string, TranslationJob>
  translationProviders: Record<string, string>
  /** Precomputed section numerals keyed by heading block key. */
  headingNumbers: Map<string, string>
  activeAnnotationId: string | null
  hoveredAnnotationId: string | null
  hoveredBlockKey: string | null
  flashBlockKey: string | null
  unknownSymbolLabel: string
  onMarkClick: MarkClickHandler
  onTranslateBlock: (blockKey: string) => void
  onAnnotateBlock: (blockKey: string) => void
  onAskBlock: (blockKey: string) => void
  onRetryTranslation: (blockKey: string) => void
  onOutlineJump: (blockKey: string) => void
}

/** Class names for one block wrapper (`ln-block ln-block--<kind>` + state). */
function blockClass(
  block: Block,
  ctx: BlockRenderContext,
  kindClass: string,
  extra?: string,
): string {
  const flash = ctx.flashBlockKey === block.key
  const hover = ctx.hoveredBlockKey === block.key
  return cx('ln-block', kindClass, extra, flash && 'is-flash', hover && 'is-hover-source')
}

/** Per-block hover tools: translate / annotate / ask (DESIGN-V2 §6). */
function BlockTools({
  blockKey,
  t,
  translated,
  pending,
  onTranslate,
  onAnnotate,
  onAsk,
}: {
  blockKey: string
  t: LitnotesTranslate
  translated: boolean
  pending: boolean
  onTranslate: (blockKey: string) => void
  onAnnotate: (blockKey: string) => void
  onAsk: (blockKey: string) => void
}): ReactElement {
  const label = pending ? t('read.block.translating') : t('read.block.translate')
  return (
    <div className="ln-block__tools" data-tools-for={blockKey}>
      <IconButton
        icon="translate"
        label={label}
        size={14}
        disabled={pending}
        tone={translated ? 'signal' : 'default'}
        onClick={() => onTranslate(blockKey)}
      />
      <IconButton
        icon="note"
        label={t('read.block.annotate')}
        size={14}
        onClick={() => onAnnotate(blockKey)}
      />
      <Button
        variant="ghost"
        size="sm"
        icon="sparkle"
        className="ln-block__tool-ai"
        title={t('read.block.ask')}
        onClick={() => onAsk(blockKey)}
      >
        {t('read.block.ask')}
      </Button>
    </div>
  )
}

/** The translation slot under one block. */
function BlockTranslation({
  ctx,
  block,
  extraClass,
}: {
  ctx: BlockRenderContext
  block: Block
  extraClass?: string
}): ReactElement | null {
  const translation = ctx.translations.entries[block.key]
  const value = typeof translation === 'string' && translation !== '' ? translation : null
  const node = (
    <TranslationBlock
      t={ctx.t}
      block={block}
      mode={ctx.mode}
      translation={value}
      job={ctx.translationJobs[block.key]}
      provider={ctx.translationProviders[block.key]}
      katexReady={ctx.katexReady}
      onRetry={(key) => ctx.onRetryTranslation(key)}
    />
  )
  if (node === null || extraClass === undefined) return node
  return <div className={extraClass}>{node}</div>
}

/* -------------------------------------------------------------------------- */
/* Block kinds                                                                */
/* -------------------------------------------------------------------------- */

/** One list item's annotations rebased into the item's own run space. */
function itemAnnotations(
  annotations: readonly NormalizedAnnotation[],
  itemStart: number,
  itemLength: number,
): NormalizedAnnotation[] {
  const out: Array<NormalizedAnnotation & { start: number; end: number }> = []
  for (const annotation of annotations) {
    if (annotation.end <= itemStart || annotation.start >= itemStart + itemLength) continue
    out.push({ ...annotation, start: annotation.start - itemStart, end: annotation.end - itemStart })
  }
  return out
}

/** Render one list block (per-<li> offset mapping, frozen contract). */
function ListBlockView({
  block,
  ctx,
  listClass,
}: {
  block: ListBlock
  ctx: BlockRenderContext
  listClass: string
}): ReactElement {
  const annotations = ctx.annotationsByBlock.get(block.key) ?? []
  let cursor = 0
  const items = block.items.map((item, index) => {
    const itemLength = item.plainText.length
    const itemStart = cursor
    cursor += itemLength
    return (
      <li key={`item-${index}`} className="ln-list__item">
        {renderInlineRuns(item.runs, {
          annotations: itemAnnotations(annotations, itemStart, itemLength),
          katexReady: ctx.katexReady,
          activeAnnotationId: ctx.activeAnnotationId,
          onMarkClick: ctx.onMarkClick,
          baseOffset: itemStart,
          unknownSymbolLabel: ctx.unknownSymbolLabel,
        })}
      </li>
    )
  })
  const tag =
    block.ordered === true ? (
      <ol className={listClass} start={block.start ?? undefined}>
        {items}
      </ol>
    ) : (
      <ul className={listClass}>{items}</ul>
    )
  return tag
}

/** Render one table block with per-cell offset mapping (frozen contract). */
function TableBlockView({ block, ctx }: { block: TableBlock; ctx: BlockRenderContext }): ReactElement {
  const annotations = ctx.annotationsByBlock.get(block.key) ?? []
  // The parser flattens the table into one plain-text space: head cells first,
  // then body rows left to right with a single space between cells.
  let cellCursor = 0
  const renderCell = (
    cell: TableBlock['head'][number],
    cellIndex: number,
    isHeader: boolean,
  ): ReactElement => {
    const cellText = cell.plainText
    const cellStart = cellCursor
    cellCursor += cellText.length + 1
    const cellAnnotations = annotations
      .map((annotation) => ({
        ...annotation,
        start: annotation.start - cellStart,
        end: annotation.end - cellStart,
      }))
      .filter((annotation) => annotation.end > 0 && annotation.start < cellText.length)
    const CellTag = isHeader || cell.header ? 'th' : 'td'
    return (
      <CellTag
        key={`cell-${cellIndex}`}
        colSpan={cell.colspan > 1 ? cell.colspan : undefined}
        rowSpan={cell.rowspan > 1 ? cell.rowspan : undefined}
        style={cell.align === null || cell.align === undefined ? undefined : { textAlign: cell.align }}
      >
        {renderInlineRuns(cell.runs, {
          annotations: cellAnnotations,
          katexReady: ctx.katexReady,
          activeAnnotationId: ctx.activeAnnotationId,
          onMarkClick: ctx.onMarkClick,
          baseOffset: cellStart,
          unknownSymbolLabel: ctx.unknownSymbolLabel,
        })}
      </CellTag>
    )
  }
  return (
    <div className="ln-table__wrap">
      <table className="ln-table">
        {block.head.length > 0 ? (
          <thead>
            <tr>{block.head.map((cell, index) => renderCell(cell, index, true))}</tr>
          </thead>
        ) : null}
        {block.rows.length > 0 ? (
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {row.map((cell, cellIndex) => renderCell(cell, cellIndex, false))}
              </tr>
            ))}
          </tbody>
        ) : null}
      </table>
      {block.caption !== '' ? <div className="ln-table__caption">{block.caption}</div> : null}
    </div>
  )
}

/** Tools + translation slot wrapper shared by the text block kinds. */
function TextBlockChrome({
  ctx,
  block,
  translated,
  pending,
}: {
  ctx: BlockRenderContext
  block: Block
  translated: boolean
  pending: boolean
}): ReactElement {
  return (
    <>
      <BlockTools
        blockKey={block.key}
        t={ctx.t}
        translated={translated}
        pending={pending}
        onTranslate={ctx.onTranslateBlock}
        onAnnotate={ctx.onAnnotateBlock}
        onAsk={ctx.onAskBlock}
      />
      <BlockTranslation ctx={ctx} block={block} />
    </>
  )
}

/** Render one reading block. */
export function BlockView({ block, ctx }: { block: Block; ctx: BlockRenderContext }): ReactElement | null {
  const annotations = ctx.annotationsByBlock.get(block.key)
  const hasTranslation =
    typeof ctx.translations.entries[block.key] === 'string' && ctx.translations.entries[block.key] !== ''
  const job = ctx.translationJobs[block.key]
  const pending = job !== undefined && job.state === 'pending'
  const inline = (baseOffset = 0): ReactElement[] =>
    renderInlineRuns('runs' in block ? block.runs : [], {
      annotations: annotations ?? [],
      katexReady: ctx.katexReady,
      activeAnnotationId: ctx.activeAnnotationId,
      onMarkClick: ctx.onMarkClick,
      baseOffset,
      unknownSymbolLabel: ctx.unknownSymbolLabel,
    })

  switch (block.kind) {
    case 'heading': {
      const level = Math.min(4, Math.max(1, block.level))
      const numeral = ctx.headingNumbers.get(block.key) ?? ''
      const Tag = (`h${Math.min(level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5')
      return (
        <div
          className={blockClass(block, ctx, `ln-block--head ln-block--h${level}`)}
          data-block-key={block.key}
          data-kind="head"
          data-plain-length={block.plainText.length}
          id={`block-${block.key}`}
        >
          {numeral !== '' ? (
            <span className="ln-h__numeral" aria-hidden="true">
              {numeral}
            </span>
          ) : null}
          <button
            type="button"
            className="ln-gutter-tick"
            title={block.plainText}
            aria-label={ctx.t('read.controls.outline', {})}
            tabIndex={-1}
            onClick={() => ctx.onOutlineJump(block.key)}
          />
          <Tag className={`ln-h ln-h--${level}`}>{inline()}</Tag>
          <TextBlockChrome ctx={ctx} block={block} translated={hasTranslation} pending={pending} />
        </div>
      )
    }
    case 'paragraph': {
      const translatedMode = ctx.mode === 'translated'
      const showSourceFallback = translatedMode && !hasTranslation && job === undefined
      return (
        <div
          className={blockClass(
            block,
            ctx,
            'ln-block--p',
            translatedMode && hasTranslation ? 'has-translation' : undefined,
          )}
          data-block-key={block.key}
          data-kind="para"
          data-plain-length={block.plainText.length}
        >
          {translatedMode ? null : <p className="ln-para__text">{inline()}</p>}
          {showSourceFallback ? (
            <div className="ln-para__translation is-source-fallback">{inline()}</div>
          ) : (
            <BlockTranslation ctx={ctx} block={block} />
          )}
          <BlockTools
            blockKey={block.key}
            t={ctx.t}
            translated={hasTranslation}
            pending={pending}
            onTranslate={ctx.onTranslateBlock}
            onAnnotate={ctx.onAnnotateBlock}
            onAsk={ctx.onAskBlock}
          />
        </div>
      )
    }
    case 'quote': {
      const translatedMode = ctx.mode === 'translated'
      const showSourceFallback = translatedMode && !hasTranslation && job === undefined
      return (
        <blockquote
          className={blockClass(block, ctx, 'ln-block--quote')}
          data-block-key={block.key}
          data-kind="quote"
          data-plain-length={block.plainText.length}
        >
          {translatedMode ? null : <p className="ln-para__text">{inline()}</p>}
          {showSourceFallback ? (
            <div className="ln-para__translation is-source-fallback">{inline()}</div>
          ) : (
            <BlockTranslation ctx={ctx} block={block} />
          )}
          <BlockTools
            blockKey={block.key}
            t={ctx.t}
            translated={hasTranslation}
            pending={pending}
            onTranslate={ctx.onTranslateBlock}
            onAnnotate={ctx.onAnnotateBlock}
            onAsk={ctx.onAskBlock}
          />
        </blockquote>
      )
    }
    case 'list': {
      return (
        <div
          className={blockClass(block, ctx, 'ln-block--list')}
          data-block-key={block.key}
          data-kind="list"
          data-plain-length={block.plainText.length}
        >
          <ListBlockView
            block={block}
            ctx={ctx}
            listClass={`ln-list${block.ordered ? ' ln-list--ordered' : ''}`}
          />
          <TextBlockChrome ctx={ctx} block={block} translated={hasTranslation} pending={pending} />
        </div>
      )
    }
    case 'code':
      return (
        <div
          className={blockClass(block, ctx, 'ln-block--code')}
          data-block-key={block.key}
          data-kind="code"
          data-plain-length={block.plainText.length}
        >
          <pre className="ln-code">
            <code>{block.code}</code>
          </pre>
        </div>
      )
    case 'formula':
      return (
        <div
          className={blockClass(block, ctx, 'ln-block--formula')}
          data-block-key={block.key}
          data-kind="formula"
          data-plain-length={block.plainText.length}
        >
          <FormulaView latex={block.latex} display katexReady={ctx.katexReady} />
        </div>
      )
    case 'figure': {
      const src = /^(?:https?:|data:)/i.test(block.src)
        ? block.src
        : getHostClient().asset(ctx.documentId, block.src)
      return (
        <figure
          className={blockClass(block, ctx, 'ln-block--figure')}
          data-block-key={block.key}
          data-kind="figure"
        >
          <span className="ln-figure__img-wrap">
            <img className="ln-figure__img" src={src} alt={block.alt} loading="lazy" />
          </span>
          {block.caption !== '' ? <figcaption className="ln-figure__caption">{block.caption}</figcaption> : null}
        </figure>
      )
    }
    case 'table':
      return (
        <div
          className={blockClass(block, ctx, 'ln-block--table')}
          data-block-key={block.key}
          data-kind="table"
          data-plain-length={block.plainText.length}
        >
          <TableBlockView block={block} ctx={ctx} />
        </div>
      )
    case 'page':
      return (
        <div className="ln-pagemark" data-page={block.page} data-block-key={block.key}>
          <span className="ln-pagemark__folio ln-tabular">{block.page}</span>
        </div>
      )
    case 'rule':
      return <hr className="ln-hr" />
    default:
      return null
  }
}

/** Whether two contexts agree for one specific block (memo comparator). */
function blockPropsEqual(
  previous: { block: Block; ctx: BlockRenderContext },
  next: { block: Block; ctx: BlockRenderContext },
): boolean {
  if (previous.block !== next.block) return false
  const before = previous.ctx
  const after = next.ctx
  if (
    before.mode !== after.mode ||
    before.katexReady !== after.katexReady ||
    before.documentId !== after.documentId ||
    before.unknownSymbolLabel !== after.unknownSymbolLabel ||
    before.t !== after.t
  ) {
    return false
  }
  const key = previous.block.key
  if (before.annotationsByBlock !== after.annotationsByBlock) {
    if (before.annotationsByBlock.get(key) !== after.annotationsByBlock.get(key)) return false
  }
  if (before.translations.entries[key] !== after.translations.entries[key]) return false
  if (before.translationJobs[key] !== after.translationJobs[key]) return false
  if (before.translationProviders[key] !== after.translationProviders[key]) return false
  if (previous.block.kind === 'heading' && before.headingNumbers !== after.headingNumbers) {
    if (before.headingNumbers.get(key) !== after.headingNumbers.get(key)) return false
  }
  if (before.activeAnnotationId !== after.activeAnnotationId) {
    const annotations = after.annotationsByBlock.get(key) ?? []
    const hit = annotations.some((annotation) => annotation.id === after.activeAnnotationId)
    if (hit) return false
  }
  if (before.flashBlockKey !== after.flashBlockKey) {
    if (before.flashBlockKey === key || after.flashBlockKey === key) return false
  }
  if (before.hoveredBlockKey !== after.hoveredBlockKey) {
    if (before.hoveredBlockKey === key || after.hoveredBlockKey === key) return false
  }
  if (before.hoveredAnnotationId !== after.hoveredAnnotationId) {
    const annotations = after.annotationsByBlock.get(key) ?? []
    if (annotations.some((annotation) => annotation.id === after.hoveredAnnotationId)) return false
  }
  if (
    before.onMarkClick !== after.onMarkClick ||
    before.onTranslateBlock !== after.onTranslateBlock ||
    before.onAnnotateBlock !== after.onAnnotateBlock ||
    before.onAskBlock !== after.onAskBlock ||
    before.onRetryTranslation !== after.onRetryTranslation ||
    before.onOutlineJump !== after.onOutlineJump
  ) {
    return false
  }
  return true
}

/** Memoized block renderer used by the paper (one re-render per changed block). */
export const MemoBlockView = memo(BlockView, blockPropsEqual)

/**
 * Section numerals in document order (`3`, `3.1`, `3.1.2`) for the hanging
 * gutter numerals of the sheet headings.
 */
export function computeHeadingNumbers(
  blocks: readonly Block[],
  skipKey: string | null = null,
): Map<string, string> {
  const counters: number[] = [0, 0, 0, 0]
  const numbers = new Map<string, string>()
  for (const block of blocks) {
    if (block.kind === 'page' || block.kind === 'rule') continue
    if (block.kind !== 'heading') continue
    if (skipKey !== null && block.key === skipKey) continue
    const level = Math.min(4, Math.max(1, block.level))
    counters[level - 1] = (counters[level - 1] ?? 0) + 1
    for (let deeper = level; deeper < counters.length; deeper += 1) counters[deeper] = 0
    const parts: number[] = []
    for (let index = 0; index < level; index += 1) {
      const value = counters[index]
      if (value === undefined || value === 0) continue
      parts.push(value)
    }
    numbers.set(block.key, parts.join('.'))
  }
  return numbers
}
