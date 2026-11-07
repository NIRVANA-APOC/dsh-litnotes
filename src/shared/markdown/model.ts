/**
 * Shared paper model: the reading-block contract used by the Host and the Client.
 *
 * This is the TypeScript port of the frozen 1.0.0 contract documented at the top
 * of `.agents/baseline-1.0.0/ui/markdown.js`:
 *
 *   const model = parseMarkdown(markdown)
 *   model.blocks   Block[]
 *   model.outline  OutlineEntry[]   [{ key, level, text, blockIndex }]
 *   model.stats    ModelStats       { blocks, headings, chars, words }
 *
 * Every text-bearing block exposes a stable `key` (`b<index>:<hash>`) and a
 * `plainText` cache; annotations are character offsets into that plain text, so
 * `plainText` MUST equal `runsText(runs)` for every block that has `runs`.
 *
 * Invariants (docs/UI-SPEC.md §3.5):
 *  - `index` equals the position in `blocks` for `parseMarkdown()` output.
 *  - `key` hashes the block's canonical text, so keys are deterministic for a
 *    given markdown.
 *  - `appendPageMarks()` is annotation-stable: original blocks keep their exact
 *    `index`/`key`; synthetic page blocks carry `page:<page>:<slot>` keys.
 *  - Annotatable kinds are heading / paragraph / quote / list / table.
 *
 * Deviations from the frozen JS shape (documented so consumers agree):
 *  - every block carries `page: number | null` (the 1-based display page, `null`
 *    until page marks are applied). The frozen page-mark design only inserted
 *    marker blocks; the extra field is a 2.0 convenience for retrieval/tool
 *    results and is filled in by `appendPageMarks()`.
 *  - `code`/`formula`/`figure` blocks also carry `plainText` (code source, latex,
 *    or `''` for figures) so consumers can treat every non-page block uniformly.
 *    The canonical key text is unchanged (`mdKeyText` rule below).
 *  - page blocks intentionally carry no `plainText` (frozen contract + tests).
 *
 * This module is environment-neutral: no `node:` imports, no DOM access.
 */

// ---------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------

/** Inline style flags a run may carry (frozen contract). */
export interface RunStyle {
  strong?: true
  em?: true
  code?: true
  del?: true
  /** Link target when the run is inside a link (empty links are dropped). */
  link?: string
}

/** One flat text run; `text` contributes to the block's `plainText`. */
export interface TextRun extends RunStyle {
  type: 'text'
  text: string
}

/**
 * One inline math run.
 *
 * `text` keeps the raw source (`$…$` / `\(…\)`) so plain-text offsets stay
 * identical to the source, while `latex` is what KaTeX renders client-side.
 * Math runs never carry `code`/`link` (frozen contract).
 */
export interface MathRun {
  type: 'math'
  text: string
  latex: string
  strong?: true
  em?: true
  del?: true
}

/** One inline run of a block's plain-text offset space. */
export type Run = TextRun | MathRun

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Every block kind the reader understands. */
export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'code'
  | 'formula'
  | 'figure'
  | 'table'
  | 'page'
  | 'rule'

/** Alignment of one table cell (pipe tables only; HTML cells leave it unset). */
export type CellAlign = 'left' | 'center' | 'right'

/** One table cell; `plainText` equals `runsText(runs)`. */
export interface TableCell {
  runs: Run[]
  plainText: string
  colspan: number
  rowspan: number
  header: boolean
  /** Pipe-table alignment; HTML tables omit the property (frozen contract). */
  align?: CellAlign | null
}

/** One list item: its own run space, concatenated into the block run space. */
export interface ListItem {
  runs: Run[]
  plainText: string
}

/** Fields shared by every block (page blocks narrow `kind`/`page`/`plainText`). */
export interface BlockBase {
  /** Position of the block in `blocks` at parse time (never the array index after page marks). */
  index: number
  /** Stable annotation anchor: `b<index>:<fnv1a(canonical text)>` or `page:<page>:<slot>`. */
  key: string
  /** Block kind discriminator. */
  kind: BlockKind
  /** 1-based display page, `null` until `appendPageMarks()` has been applied. */
  page: number | null
  /**
   * Canonical plain text (annotation offset space).
   *
   * Every block carries the field so consumers can treat the model uniformly;
   * page marks, rules and figures carry `''` (the frozen contract omitted the
   * property on those blocks entirely).
   */
  plainText: string
}

/** Fields shared by every block that contributes to the annotation offset space. */
export interface TextualBlock extends BlockBase {
  runs: Run[]
  /** Canonical plain text: `runsText(runs)`; annotation offsets address this string. */
  plainText: string
}

export interface HeadingBlock extends TextualBlock {
  kind: 'heading'
  /** Clamped to 1..4 (the reader styles h1–h4; h5/h6 clamp to 4). */
  level: number
}

export interface ParagraphBlock extends TextualBlock {
  kind: 'paragraph'
}

/**
 * Ordered/unordered list.
 *
 * The block-level run space is the exact concatenation of the item run spaces
 * (no separator) so the client maps per-`<li>` DOM offsets by cumulative item
 * lengths; therefore `plainText === items.map(item => item.plainText).join('')`.
 */
export interface ListBlock extends TextualBlock {
  kind: 'list'
  ordered: boolean
  /** Ordered-list starting number, `null` for unordered lists. */
  start: number | null
  items: ListItem[]
}

export interface QuoteBlock extends TextualBlock {
  kind: 'quote'
}

export interface CodeBlock extends BlockBase {
  kind: 'code'
  /** Fence info first token; `'text'` when the fence has no info string. */
  lang: string
  /** Code body without the closing fence newline. */
  code: string
  /** Equal to `code` (uniform `plainText` field; never part of the offset space). */
  plainText: string
}

export interface FormulaBlock extends BlockBase {
  kind: 'formula'
  /** LaTeX body without the `$$` / `\[` wrappers. */
  latex: string
  display: true
  /** Equal to `latex` (uniform `plainText` field). */
  plainText: string
}

export interface FigureBlock extends BlockBase {
  kind: 'figure'
  /** Image source exactly as authored (usually `images/…`). */
  src: string
  alt: string
  /** Caption mirrored from a caption-like alt/title, or `''`. */
  caption: string
  /** Figures are not in the annotation offset space: always `''`. */
  plainText: string
}

export interface TableBlock extends TextualBlock {
  kind: 'table'
  /** Header cells (`thead` first row, or the first row of `th` cells). */
  head: TableCell[]
  rows: TableCell[][]
  caption: string
}

/** Synthetic page marker inserted by `appendPageMarks()` (display-only). */
export interface PageMark extends BlockBase {
  kind: 'page'
  /** 1-based display page. */
  page: number
  /** Page marks carry no text (frozen contract); the uniform base field is `''`. */
  plainText: ''
}

export interface RuleBlock extends BlockBase {
  kind: 'rule'
  plainText: ''
}

/** One reading block of a parsed paper. */
export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | QuoteBlock
  | CodeBlock
  | FormulaBlock
  | FigureBlock
  | TableBlock
  | PageMark
  | RuleBlock

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One heading in document order; resolves to a heading block by `key`. */
export interface OutlineEntry {
  key: string
  level: number
  text: string
  blockIndex: number
}

/** Model statistics (prose only: code/formula/figure/page/rule are excluded). */
export interface ModelStats {
  blocks: number
  headings: number
  chars: number
  words: number
}

/** The complete parsed paper model. */
export interface PaperModel {
  blocks: Block[]
  outline: OutlineEntry[]
  stats: ModelStats
}

/** Empty, well-formed model (used for empty input and as a safe default). */
export function emptyModel(): PaperModel {
  return { blocks: [], outline: [], stats: { blocks: 0, headings: 0, chars: 0, words: 0 } }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a as 8 lowercase hex characters.
 *
 * Tolerates `null`/`undefined` (hashes the empty string) because it is applied
 * to on-disk data of unknown quality.
 */
export function fnv1a(text: string | null | undefined): string {
  const value = typeof text === 'string' ? text : ''
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Stable annotation anchor for one text-bearing block: `b<index>:<hash>`. */
export function blockKey(index: number, plainText: string): string {
  return `b${index}:${fnv1a(plainText)}`
}

/**
 * Concatenate a run list into the canonical plain-text offset space.
 *
 * Only runs with a string `text` contribute; the result must equal the owning
 * block's `plainText` cache for every block that carries runs.
 */
export function runsText(runs: readonly Run[] | null | undefined): string {
  if (!Array.isArray(runs)) return ''
  let out = ''
  for (const run of runs) {
    if (run !== null && typeof run === 'object' && typeof run.text === 'string') out += run.text
  }
  return out
}

/**
 * Plain text of any block, tolerating partial/legacy data:
 * `plainText` first, then the run space, then the code/latex payloads.
 */
export function plainTextOfBlock(block: unknown): string {
  if (block === null || typeof block !== 'object') return ''
  const candidate = block as {
    kind?: unknown
    plainText?: unknown
    runs?: unknown
    code?: unknown
    latex?: unknown
  }
  if (typeof candidate.plainText === 'string') return candidate.plainText
  if (Array.isArray(candidate.runs)) return runsText(candidate.runs as Run[])
  if (candidate.kind === 'code') return typeof candidate.code === 'string' ? candidate.code : ''
  if (candidate.kind === 'formula') return typeof candidate.latex === 'string' ? candidate.latex : ''
  return ''
}

/** Kinds whose `plainText` counts toward `stats.chars` / `stats.words`. */
const TEXT_KINDS: Readonly<Record<string, true>> = Object.freeze({
  heading: true,
  paragraph: true,
  quote: true,
  list: true,
  table: true,
})

/**
 * Compute model statistics from a finished block list.
 *
 * `chars` sums `plainText` lengths and `words` counts non-empty whitespace runs
 * for the annotatable text kinds only; code, formulas, figures, page marks and
 * rules are excluded (frozen contract).
 */
export function mdStats(blocks: readonly Block[] | null | undefined): ModelStats {
  const list: readonly unknown[] = Array.isArray(blocks) ? blocks : []
  let chars = 0
  let words = 0
  let headings = 0
  for (const candidate of list) {
    if (candidate === null || typeof candidate !== 'object') continue
    const block = candidate as { kind?: unknown; plainText?: unknown }
    if (block.kind === 'heading') headings += 1
    if (typeof block.kind !== 'string' || TEXT_KINDS[block.kind] !== true) continue
    const text = typeof block.plainText === 'string' ? block.plainText : ''
    chars += text.length
    const trimmed = text.trim()
    if (trimmed !== '') words += trimmed.split(/\s+/).length
  }
  return { blocks: list.length, headings, chars, words }
}

/** Canonical text hashed into a block key (mirrors the frozen `mdKeyText`). */
export function keyTextOf(block: Block | (Partial<Block> & { kind?: unknown })): string {
  const kind = (block as { kind?: unknown }).kind
  switch (kind) {
    case 'heading':
    case 'paragraph':
    case 'quote':
    case 'list':
    case 'table':
      return typeof (block as { plainText?: unknown }).plainText === 'string'
        ? (block as { plainText: string }).plainText
        : ''
    case 'code':
      return typeof (block as { code?: unknown }).code === 'string' ? (block as { code: string }).code : ''
    case 'formula':
      return typeof (block as { latex?: unknown }).latex === 'string' ? (block as { latex: string }).latex : ''
    case 'figure': {
      const figure = block as { alt?: unknown; src?: unknown }
      return (figure.alt === '' ? '' : String(figure.alt)) + '|' + String(figure.src)
    }
    case 'page':
      return 'page:' + String((block as { page?: unknown }).page)
    default:
      return ''
  }
}

/**
 * Assign `index`/`key`, append one block and register its outline entry.
 *
 * Every text-bearing block's plain text is finalised here (callers build runs
 * first); the function mutates the block in place, exactly like the frozen
 * parser, and returns it.
 */
export function appendBlock(blocks: Block[], outline: OutlineEntry[], block: Block): Block {
  const index = blocks.length
  const mutable = block as Block & { index: number; key: string }
  mutable.index = index
  mutable.key = blockKey(index, keyTextOf(block))
  blocks.push(block)
  if (block.kind === 'heading') {
    outline.push({ key: block.key, level: block.level, text: block.plainText, blockIndex: index })
  }
  return block
}
