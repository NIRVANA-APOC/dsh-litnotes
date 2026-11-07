/**
 * Compact answer renderer for the AI margin.
 *
 * Model answers are Markdown. This module renders that Markdown with
 * **markdown-it** configured `html:false` (model output can never inject HTML —
 * task rule: no raw HTML execution), and layers two product behaviours on top of
 * the token stream:
 *
 *  - inline `[n]` markers become citation chips (`renderCitation`) without
 *    touching code spans or fenced blocks (the frozen `citationMarkers` rules);
 *  - `$…$`, `$$…$$`, `\(…\)` and `\[…\]` become KaTeX formulas through the
 *    lazily-loaded vendored runtime (`formula.tsx`).
 *
 * The renderer is intentionally compact: headings, paragraphs, lists,
 * blockquotes, code, tables, links, rules, math and citations — the shapes a
 * grounded reading answer actually produces. Images render as their alt text
 * because answer images carry no reliable asset provenance.
 */

import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { Fragment, useMemo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Formula } from './formula.tsx'
import { citationMarkers } from './chat.ts'

/** The single parser instance (stateless; `html:false` drops raw HTML). */
const parser = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
  typographer: false,
})

/* -------------------------------------------------------------------------- */
/* Math splitting                                                             */
/* -------------------------------------------------------------------------- */

/** One literal or math span of inline text. */
type MathPart = { type: 'text'; text: string } | { type: 'math'; latex: string; display: boolean }

/** Find the closing `$` of an inline math run, or -1. */
function findInlineDollar(text: string, from: number): number {
  let index = from
  while (index < text.length) {
    const character = text.charAt(index)
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '$') {
      const content = text.slice(from, index)
      if (content !== '' && content.indexOf('\n') === -1 && !/^\s|\s$/.test(content)) return index
      return -1
    }
    index += 1
  }
  return -1
}

/** A whole paragraph that is one display formula (`$$…$$` or `\[…\]`). */
function parseDisplayMath(source: string): string | null {
  const trimmed = source.trim()
  if (trimmed.length > 4 && trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2).trim()
  }
  if (trimmed.length > 4 && trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) {
    return trimmed.slice(2, -2).trim()
  }
  return null
}

/**
 * Split inline text into literal and math spans.
 *
 * Conservative by design so currency and prose stay literal: `$5 and $10` is
 * text, `$x$` is math; `$$…$$` and `\[…\]` are display runs.
 *
 * @param text - plain inline text from a markdown-it text token.
 * @returns ordered literal/math parts.
 */
export function splitMath(text: string): MathPart[] {
  const parts: MathPart[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') {
      parts.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }
  let index = 0
  while (index < text.length) {
    const character = text.charAt(index)
    const next = text.charAt(index + 1)
    if (character === '\\' && (next === '$' || next === '(' || next === '[' || next === ')' || next === ']')) {
      if (next === '(') {
        const close = text.indexOf('\\)', index + 2)
        if (close !== -1) {
          flush()
          parts.push({ type: 'math', latex: text.slice(index + 2, close), display: false })
          index = close + 2
          continue
        }
      } else if (next === '[') {
        const close = text.indexOf('\\]', index + 2)
        if (close !== -1) {
          flush()
          parts.push({ type: 'math', latex: text.slice(index + 2, close), display: true })
          index = close + 2
          continue
        }
      } else if (next === '$') {
        buffer += '$'
        index += 2
        continue
      }
      buffer += character
      index += 1
      continue
    }
    if (character === '$') {
      if (next === '$') {
        const close = text.indexOf('$$', index + 2)
        if (close !== -1) {
          flush()
          parts.push({ type: 'math', latex: text.slice(index + 2, close), display: true })
          index = close + 2
          continue
        }
      } else {
        const close = findInlineDollar(text, index + 1)
        if (close !== -1) {
          flush()
          parts.push({ type: 'math', latex: text.slice(index + 1, close), display: false })
          index = close + 1
          continue
        }
      }
    }
    buffer += character
    index += 1
  }
  flush()
  return parts
}

/* -------------------------------------------------------------------------- */
/* Token-tree rendering                                                       */
/* -------------------------------------------------------------------------- */

/** Per-render context: stable keys and the citation sink. */
interface RenderContext {
  key: number
  renderCitation: (index: number) => ReactElement
}

/** Next stable key for a rendered node. */
function nextKey(context: RenderContext): string {
  context.key += 1
  return `md-${context.key}`
}

/** One open inline style frame (strong/em/link) while walking inline children. */
interface InlineFrame {
  tag: 'strong' | 'em' | 's' | 'a'
  href: string
  children: ReactNode[]
}

/** Render the literal/citation/math spans of one text token. */
function renderTextToken(text: string, context: RenderContext): ReactNode[] {
  const nodes: ReactNode[] = []
  for (const part of splitMath(text)) {
    if (part.type === 'math') {
      nodes.push(<Formula key={nextKey(context)} latex={part.latex} display={part.display} />)
      continue
    }
    for (const marker of citationMarkers(part.text)) {
      if (marker.type === 'citation') {
        nodes.push(
          <Fragment key={nextKey(context)}>{context.renderCitation(marker.index)}</Fragment>,
        )
      } else if (marker.text !== '') {
        nodes.push(marker.text)
      }
    }
  }
  return nodes
}

/** Wrap one inline frame's children in its element. */
function wrapInlineFrame(frame: InlineFrame, context: RenderContext): ReactNode {
  if (frame.tag === 'a') {
    if (frame.href === '') return <Fragment key={nextKey(context)}>{frame.children}</Fragment>
    return (
      <a
        key={nextKey(context)}
        className="ln-ai__link"
        href={frame.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {frame.children}
      </a>
    )
  }
  const Tag = frame.tag === 's' ? 's' : frame.tag
  return (
    <Tag key={nextKey(context)} className={frame.tag === 'strong' ? 'ln-ai__strong' : undefined}>
      {frame.children}
    </Tag>
  )
}

/** Render the flat inline token list (text, emphasis, code, links, breaks). */
function renderInline(children: readonly Token[], context: RenderContext): ReactNode[] {
  const output: ReactNode[] = []
  const stack: InlineFrame[] = []
  const push = (node: ReactNode): void => {
    if (stack.length > 0) stack[stack.length - 1]?.children.push(node)
    else output.push(node)
  }
  for (const token of children) {
    switch (token.type) {
      case 'text':
        for (const node of renderTextToken(token.content, context)) push(node)
        break
      case 'code_inline':
        push(
          <code key={nextKey(context)} className="ln-ai__inline-code">
            {token.content}
          </code>,
        )
        break
      case 'softbreak':
        push(' ')
        break
      case 'hardbreak':
        push(<br key={nextKey(context)} />)
        break
      case 'image':
        push(<span key={nextKey(context)} className="ln-ai__image-alt">{token.content}</span>)
        break
      case 'strong_open':
        stack.push({ tag: 'strong', href: '', children: [] })
        break
      case 'em_open':
        stack.push({ tag: 'em', href: '', children: [] })
        break
      case 's_open':
        stack.push({ tag: 's', href: '', children: [] })
        break
      case 'link_open':
        stack.push({ tag: 'a', href: token.attrGet('href') ?? '', children: [] })
        break
      case 'strong_close':
      case 'em_close':
      case 's_close':
      case 'link_close': {
        const frame = stack.pop()
        if (frame !== undefined) push(wrapInlineFrame(frame, context))
        break
      }
      case 'html_inline':
        if (token.content !== '') push(token.content)
        break
      default:
        if (token.content !== '') push(token.content)
        break
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame !== undefined) push(wrapInlineFrame(frame, context))
  }
  return output
}

/** Build the element for one opening block token with its rendered children. */
function blockElement(token: Token, children: ReactNode[]): ReactNode {
  switch (token.type) {
    case 'paragraph_open':
      return <p className="ln-ai__paragraph">{children}</p>
    case 'heading_open': {
      const level = token.tag === 'h1' ? 1 : token.tag === 'h3' ? 3 : token.tag === 'h4' ? 4 : token.tag === 'h5' ? 5 : token.tag === 'h6' ? 6 : 2
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag className="ln-ai__heading" data-level={level}>
          {children}
        </Tag>
      )
    }
    case 'blockquote_open':
      return <blockquote className="ln-ai__quote">{children}</blockquote>
    case 'bullet_list_open':
      return <ul className="ln-ai__list">{children}</ul>
    case 'ordered_list_open': {
      const start = Number(token.attrGet('start') ?? '1')
      return (
        <ol className="ln-ai__list" start={Number.isFinite(start) && start > 1 ? start : undefined}>
          {children}
        </ol>
      )
    }
    case 'list_item_open':
      return <li className="ln-ai__list-item">{children}</li>
    case 'table_open':
      return (
        <div className="ln-ai__table-wrap">
          <table className="ln-ai__table">{children}</table>
        </div>
      )
    case 'thead_open':
      return <thead>{children}</thead>
    case 'tbody_open':
      return <tbody>{children}</tbody>
    case 'tr_open':
      return <tr>{children}</tr>
    case 'th_open':
      return <th>{children}</th>
    case 'td_open':
      return <td>{children}</td>
    case 'strong_open':
    case 'em_open':
      return <span>{children}</span>
    default:
      return <Fragment>{children}</Fragment>
  }
}

/** Render one leaf token (inline content, code, rule). */
function leafElement(token: Token, context: RenderContext): ReactNode {
  if (token.type === 'inline') return <Fragment>{renderInline(token.children ?? [], context)}</Fragment>
  if (token.type === 'fence' || token.type === 'code_block') {
    const language = token.type === 'fence' ? token.info.trim().split(/\s+/)[0] ?? '' : ''
    return (
      <pre className="ln-ai__code" data-language={language !== '' ? language : undefined}>
        <code>{token.content}</code>
      </pre>
    )
  }
  if (token.type === 'hr') return <hr className="ln-ai__rule" />
  if (token.type === 'html_block') return <p className="ln-ai__paragraph">{token.content}</p>
  return null
}

/** Render a block token range until `stopType` (or the end). */
function renderBlocks(
  tokens: readonly Token[],
  start: number,
  stopType: string | null,
  context: RenderContext,
): { nodes: ReactNode[]; next: number } {
  const nodes: ReactNode[] = []
  let index = start
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) {
      index += 1
      continue
    }
    if (stopType !== null && token.type === stopType) return { nodes, next: index + 1 }
    if (token.nesting === -1) {
      index += 1
      continue
    }
    if (token.nesting === 1) {
      // A paragraph that is exactly one display formula renders as a block.
      if (token.type === 'paragraph_open') {
        const inline = tokens[index + 1]?.type === 'inline' ? tokens[index + 1] : undefined
        const latex = inline === undefined ? null : parseDisplayMath(inline.content)
        if (latex !== null) {
          const closeIndex = tokens[index + 2]?.type === 'paragraph_close' ? index + 3 : index + 2
          nodes.push(<Formula key={nextKey(context)} latex={latex} display />)
          index = closeIndex
          continue
        }
      }
      const closeType = token.type.replace(/_open$/, '_close')
      const inner = renderBlocks(tokens, index + 1, closeType, context)
      nodes.push(<Fragment key={nextKey(context)}>{blockElement(token, inner.nodes)}</Fragment>)
      index = inner.next
      continue
    }
    const leaf = leafElement(token, context)
    if (leaf !== null) nodes.push(<Fragment key={nextKey(context)}>{leaf}</Fragment>)
    index += 1
  }
  return { nodes, next: index }
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

/** Props of {@link AiMarkdown}. */
export interface AiMarkdownProps {
  /** Answer markdown (already stripped of the structured fence). */
  text: string
  /** Build one citation chip for an inline `[n]` marker. */
  renderCitation: (index: number) => ReactElement
  className?: string
}

/**
 * Render one model answer as themed Markdown with citation chips and formulas.
 *
 * Parsing is memoized on the answer text, so streaming only re-parses when the
 * text actually changes.
 */
export function AiMarkdown({ text, renderCitation, className }: AiMarkdownProps): ReactElement {
  const tokens = useMemo(() => parser.parse(text, {}), [text])
  const rendered = useMemo(
    () => renderBlocks(tokens, 0, null, { key: 0, renderCitation }),
    [tokens, renderCitation],
  )
  return <div className={className === undefined ? 'ln-ai__markdown' : `ln-ai__markdown ${className}`}>{rendered.nodes}</div>
}
