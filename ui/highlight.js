/**
 * Pure annotation/highlight helpers for the dsh-litnotes reader.
 *
 * Written as ESM for Node unit tests; `scripts/build-client.mjs` inlines it
 * after ui/markdown.js inside the client factory. It may use the shared helpers
 * defined by markdown.js (fnv1a, runsText, plainTextOfBlock, blockKey) — do not
 * redeclare them here. Every other top-level name is `hl`-prefixed so the two
 * files can share one bundle scope.
 *
 * Annotation (persisted per document by the client):
 *   { id, blockKey, start, end, quote, color:'yellow'|'sage'|'sky'|'rose',
 *     note?, createdAt, updatedAt }
 * start/end are offsets into the block's plainText, `end` exclusive.
 */

/** Annotation ink colors accepted by UI-SPEC §1. */
const HL_COLORS = Object.freeze(['yellow', 'sage', 'sky', 'rose'])

const HL_DEFAULT_COLOR = 'yellow'
/** Citation aspects accepted on annotations (mirrors docs/AI-SPEC.md §2). */
const HL_ASPECTS = new Set(['definition', 'method', 'result', 'limitation', 'context'])

/** Deterministic fallback timestamp for annotations missing one. */
const HL_EPOCH = '1970-01-01T00:00:00.000Z'

function hlIsValidColor(color) {
  return typeof color === 'string' && HL_COLORS.indexOf(color) !== -1
}

/** Copy the run's inline style flags into a render-friendly object. */
function hlRunStyles(run) {
  const styles = {}
  if (run.strong === true) styles.strong = true
  if (run.em === true) styles.em = true
  if (run.code === true) styles.code = true
  if (run.del === true) styles.del = true
  if (typeof run.link === 'string' && run.link !== '') styles.link = run.link
  return styles
}

/** Integer annotation bounds, or null when the annotation is unusable. */
function hlBounds(annotation) {
  if (annotation === null || typeof annotation !== 'object') return null
  const start = Number(annotation.start)
  const end = Number(annotation.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start: Math.trunc(start), end: Math.trunc(end) }
}

/**
 * Split runs into segments carrying the annotations that cover them.
 *
 * The output is split at every annotation boundary inside each run, so two
 * overlapping highlights produce segments whose `annotationIds` holds every
 * covering id (overlaps keep both). `color` is the first covering annotation's
 * ink color (earliest start, then id) or null for plain text. Run styles
 * (strong/em/code/del/link) are preserved on every segment of the run.
 *
 * @param {object[]} runs flat runs from markdown.js
 * @param {{id:string,start:number,end:number,color:string}[]} annotations
 * @returns {{text:string, styles:object, annotationIds:string[], color:string|null, type:string, latex?:string}[]}
 */
export function overlayRuns(runs, annotations) {
  const segments = []
  const runList = Array.isArray(runs) ? runs : []
  const annotationList = Array.isArray(annotations) ? annotations : []
  let offset = 0
  for (let r = 0; r < runList.length; r += 1) {
    const run = runList[r]
    if (run === null || typeof run !== 'object') continue
    const text = typeof run.text === 'string' ? run.text : ''
    const runStart = offset
    const runEnd = offset + text.length
    offset = runEnd
    if (text === '') continue
    const boundaries = [runStart, runEnd]
    for (let a = 0; a < annotationList.length; a += 1) {
      const bounds = hlBounds(annotationList[a])
      if (bounds === null) continue
      if (bounds.end <= runStart || bounds.start >= runEnd) continue
      boundaries.push(Math.max(runStart, bounds.start))
      boundaries.push(Math.min(runEnd, bounds.end))
    }
    boundaries.sort((left, right) => left - right)
    const styles = hlRunStyles(run)
    for (let b = 0; b + 1 < boundaries.length; b += 1) {
      const from = boundaries[b]
      const to = boundaries[b + 1]
      if (to <= from) continue
      const covering = []
      for (let a = 0; a < annotationList.length; a += 1) {
        const annotation = annotationList[a]
        const bounds = hlBounds(annotation)
        if (bounds === null) continue
        if (bounds.start < to && bounds.end > from) covering.push(annotation)
      }
      covering.sort((left, right) => {
        const startDelta = Math.trunc(Number(left.start)) - Math.trunc(Number(right.start))
        if (startDelta !== 0) return startDelta
        return String(left.id ?? '').localeCompare(String(right.id ?? ''))
      })
      const annotationIds = []
      for (let c = 0; c < covering.length; c += 1) annotationIds.push(String(covering[c].id ?? ''))
      const segment = {
        type: run.type === 'math' ? 'math' : 'text',
        text: text.slice(from - runStart, to - runStart),
        styles: Object.assign({}, styles),
        annotationIds,
        color: covering.length === 0
          ? null
          : (hlIsValidColor(covering[0].color) ? covering[0].color : HL_DEFAULT_COLOR),
      }
      if (segment.type === 'math') segment.latex = run.latex
      segments.push(segment)
    }
  }
  return segments
}

/**
 * Clamp/normalize one persisted annotation against a block's plain text.
 * Returns null when the annotation is unusable: wrong shape, offsets that don't
 * describe at least one character after clamping, a mismatched blockKey, or an
 * empty/untextable block. Never mutates the input.
 *
 * @param {object} annotation
 * @param {{key?:string, kind?:string, plainText?:string, runs?:object[]}} block
 * @returns {object|null}
 */
export function normalizeAnnotation(annotation, block) {
  if (annotation === null || typeof annotation !== 'object' || Array.isArray(annotation)) return null
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return null
  const plain = plainTextOfBlock(block)
  if (typeof plain !== 'string' || plain === '') return null
  const blockKeyValue = typeof block.key === 'string' ? block.key : ''
  if (typeof annotation.blockKey === 'string' && annotation.blockKey !== ''
    && blockKeyValue !== '' && annotation.blockKey !== blockKeyValue) {
    return null
  }
  const start = Math.max(0, Math.min(Math.trunc(Number(annotation.start)), plain.length))
  const end = Math.max(0, Math.min(Math.trunc(Number(annotation.end)), plain.length))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (end <= start) return null
  const providedQuote = typeof annotation.quote === 'string' ? annotation.quote : ''
  const id = typeof annotation.id === 'string' && annotation.id !== '' ? annotation.id : newAnnotationId()
  const color = hlIsValidColor(annotation.color) ? annotation.color : HL_DEFAULT_COLOR
  const createdAt = typeof annotation.createdAt === 'string' && annotation.createdAt !== ''
    ? annotation.createdAt
    : HL_EPOCH
  const updatedAt = typeof annotation.updatedAt === 'string' && annotation.updatedAt !== ''
    ? annotation.updatedAt
    : (typeof annotation.createdAt === 'string' && annotation.createdAt !== '' ? annotation.createdAt : HL_EPOCH)
  const out = {
    id,
    blockKey: blockKeyValue !== '' ? blockKeyValue : String(annotation.blockKey ?? ''),
    start,
    end,
    quote: providedQuote !== '' ? providedQuote : plain.slice(start, end),
    color,
    note: typeof annotation.note === 'string' ? annotation.note : '',
    createdAt,
    updatedAt,
  }
  // AI provenance survives client normalization and the whole-list save path
  // (docs/AI-SPEC.md §2): the margin spark, the "AI 批注" filter and the chat
  // provenance depend on these fields.
  if (annotation.origin === 'ai' || annotation.origin === 'user') out.origin = annotation.origin
  if (HL_ASPECTS.has(annotation.aspect)) out.aspect = annotation.aspect
  if (typeof annotation.chatId === 'string' && annotation.chatId !== '') out.chatId = annotation.chatId
  if (typeof annotation.messageId === 'string' && annotation.messageId !== '') out.messageId = annotation.messageId
  if (annotation.model !== null && typeof annotation.model === 'object'
    && typeof annotation.model.provider === 'string' && typeof annotation.model.model === 'string') {
    out.model = { provider: annotation.model.provider, model: annotation.model.model }
  }
  if (annotation.stale === true) {
    out.stale = true
    if (typeof annotation.staleReason === 'string' && annotation.staleReason !== '') {
      out.staleReason = annotation.staleReason
    }
  }
  if (annotation.reanchored === true) out.reanchored = true
  return out
}

/** Group annotations by blockKey for fast per-block rendering. */
export function groupAnnotations(annotations) {
  const map = new Map()
  if (!Array.isArray(annotations)) return map
  for (let i = 0; i < annotations.length; i += 1) {
    const annotation = annotations[i]
    if (annotation === null || typeof annotation !== 'object') continue
    const key = annotation.blockKey
    if (typeof key !== 'string' || key === '') continue
    const list = map.get(key)
    if (list === undefined) map.set(key, [annotation])
    else list.push(annotation)
  }
  return map
}

/** Whether a block kind can carry annotations (UI-SPEC reader text blocks). */
export function isAnnotatableBlock(block) {
  if (block === null || typeof block !== 'object') return false
  return block.kind === 'heading'
    || block.kind === 'paragraph'
    || block.kind === 'quote'
    || block.kind === 'list'
    || block.kind === 'table'
}

/** Create the annotation id shared by the store and the DOM. */
export function newAnnotationId() {
  const bytes = new Uint8Array(8)
  const cryptoApi = typeof globalThis === 'object' ? globalThis.crypto : undefined
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  let id = 'a'
  for (let i = 0; i < bytes.length; i += 1) id += bytes[i].toString(16).padStart(2, '0')
  return id
}
