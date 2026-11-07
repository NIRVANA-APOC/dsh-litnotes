/**
 * Normalization of the persisted annotation / translation documents.
 *
 * These functions are the write barrier of the library store: every value that
 * reaches disk has passed through them, so a hostile or hand-edited client
 * payload can never grow the files without bound or smuggle unknown fields into
 * the frozen 1.0.0 JSON contract.
 *
 * The on-disk shape is fixed by docs/AI-SPEC.md §2: annotation `model`
 * provenance is an object (`{ provider, model }`), which is why the stored
 * annotation type widens the shared model's `model` field.
 *
 * @module host/store/normalize
 */

import { randomUUID } from 'node:crypto'

import { ANNOTATION_COLORS, ASPECTS } from '../../shared/constants.ts'
import type { AnnotationColor } from '../../shared/constants.ts'
import type { Annotation, AnnotationEnvelope, TranslationEnvelope } from '../../shared/model.ts'
import { WireError } from '../wire.ts'

/** Cap on stored annotations per document. */
export const MAX_ANNOTATIONS = 5000
/** Cap on stored translation entries per document. */
export const MAX_TRANSLATIONS = 50000
/** Cap on the diagnostics log. */
export const MAX_DIAGNOSTIC_LINES = 200
/** Largest parsed markdown / content-list file accepted from disk. */
export const MAX_PARSED_FILE_BYTES = 64 * 1024 * 1024
/** Largest persisted annotation / translation / aux document accepted from disk. */
export const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024
/** Largest diagnostics log accepted before it is reset. */
export const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024
/** Partial uploads older than this are leftovers from a previous process. */
export const STALE_TEMP_MS = 10 * 60 * 1000
/** UUID shape used for directory names. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Validate one aux JSON file name (`chat.json`, `graph.json`, …). */
const AUX_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,64}$/i

/** Citation aspects accepted on annotations (mirrors docs/AI-SPEC.md §2). */
const AI_ASPECTS: ReadonlySet<string> = new Set(ASPECTS)
/** Accepted annotation ink colors. */
const HIGHLIGHT_COLORS: ReadonlySet<string> = new Set(ANNOTATION_COLORS)

/** AI provenance recorded on an annotation in the frozen on-disk format. */
export interface AnnotationModel {
  provider: string
  model: string
}

/**
 * Persisted annotation shape.
 *
 * The shared model types `Annotation.model` as a string, but the frozen 1.0.0
 * format (and `ui/highlight.js`) stores an object; the store preserves it.
 */
export type StoredAnnotation = Omit<Annotation, 'model'> & { model?: AnnotationModel }

/** Build a `not-found` WireError for a document id. */
export function notFound(id: string): WireError {
  return new WireError('not-found', `文档不存在（Document not found: ${id}）`, 404)
}

/** Build a `bad-request` WireError. */
export function badRequest(message: string): WireError {
  return new WireError('bad-request', message, 400)
}

/** Extract a Node.js error code without trusting the thrown value shape. */
export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Finite number or undefined (rejects NaN/Infinity). */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Bound and deduplicate the optional client `baseIds` of an annotation save.
 *
 * The base id set is the list of annotation ids the client had loaded when it
 * edited the list; it enables the additive 3-way merge in `saveAnnotations`.
 * Non-array payloads mean "replace semantics" (`null`).
 *
 * @param value - raw `data.baseIds`.
 * @returns bounded base ids, or null for replace semantics.
 */
export function normalizeBaseIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const id = candidate.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= MAX_ANNOTATIONS) break
  }
  return ids
}

/**
 * Validate and clamp one stored annotation item.
 *
 * @param item - untrusted item from the client or a reparse rewrite.
 * @returns a persistence-ready annotation, or null when it has no block key.
 */
export function normalizeAnnotationItem(item: unknown): StoredAnnotation | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const source = item as Record<string, unknown>
  const blockKey = typeof source.blockKey === 'string' ? source.blockKey.trim() : ''
  if (blockKey === '') return null
  let start = finite(source.start)
  let end = finite(source.end)
  if (start === undefined) start = 0
  if (end === undefined) end = start
  start = Math.max(0, Math.floor(start))
  end = Math.max(start, Math.floor(end))
  const color: AnnotationColor =
    typeof source.color === 'string' && HIGHLIGHT_COLORS.has(source.color)
      ? (source.color as AnnotationColor)
      : 'yellow'
  const out: StoredAnnotation = {
    id: typeof source.id === 'string' && source.id.trim() !== '' ? source.id.trim() : randomUUID(),
    blockKey,
    start,
    end,
    quote: typeof source.quote === 'string' ? source.quote.slice(0, 5000) : '',
    note: typeof source.note === 'string' ? source.note.slice(0, 20000) : '',
    color,
  }
  out.createdAt =
    typeof source.createdAt === 'string' && source.createdAt !== ''
      ? source.createdAt
      : new Date().toISOString()
  // AI provenance (docs/AI-SPEC.md §2): never drop it when a client or the chat
  // service rewrites the annotation list.
  if (source.origin === 'user' || source.origin === 'ai') out.origin = source.origin
  if (typeof source.aspect === 'string' && AI_ASPECTS.has(source.aspect)) {
    out.aspect = source.aspect as StoredAnnotation['aspect']
  }
  if (typeof source.chatId === 'string' && source.chatId !== '') out.chatId = source.chatId.slice(0, 200)
  if (typeof source.messageId === 'string' && source.messageId !== '') {
    out.messageId = source.messageId.slice(0, 200)
  }
  if (
    source.model !== null &&
    typeof source.model === 'object' &&
    !Array.isArray(source.model) &&
    typeof (source.model as { provider?: unknown }).provider === 'string' &&
    typeof (source.model as { model?: unknown }).model === 'string'
  ) {
    const model = source.model as { provider: string; model: string }
    out.model = { provider: model.provider.slice(0, 100), model: model.model.slice(0, 100) }
  }
  // Re-anchor bookkeeping (shared reanchor helpers): a client save must not
  // erase the fact that an annotation could not be relocated after a reparse.
  if (source.stale === true) {
    out.stale = true
    if (typeof source.staleReason === 'string' && source.staleReason !== '') {
      out.staleReason = source.staleReason.slice(0, 80)
    }
  }
  if (source.reanchored === true) out.reanchored = true
  return out
}

/**
 * Normalize an untrusted annotation list into the persisted shape.
 *
 * @param data - candidate `{ items }` document.
 * @returns `{ version: 1, items }` ready to serialize.
 * @throws {WireError} `bad-request` for a malformed envelope, `too-large` above
 *   the annotation cap.
 */
export function normalizeAnnotations(data: unknown): { version: 1; items: StoredAnnotation[] } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw badRequest('annotations 必须是对象（annotations must be an object）')
  }
  const items = (data as { items?: unknown }).items
  if (!Array.isArray(items)) {
    throw badRequest('annotations.items 必须是数组（annotations.items must be an array）')
  }
  if (items.length > MAX_ANNOTATIONS) {
    throw new WireError(
      'too-large',
      `批注数量超过 ${MAX_ANNOTATIONS} 条限制（Too many annotations）`,
      413,
    )
  }
  const normalized: StoredAnnotation[] = []
  for (const item of items) {
    const candidate = normalizeAnnotationItem(item)
    if (candidate !== null) normalized.push(candidate)
  }
  return { version: 1, items: normalized }
}

/**
 * Normalize the persisted translations document.
 *
 * @param data - untrusted `{ targetLanguage, entries }` document.
 * @returns the persistence-ready translation envelope.
 * @throws {WireError} `bad-request` for a malformed envelope.
 */
export function normalizeTranslations(data: unknown): TranslationEnvelope {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw badRequest('translations 必须是对象（translations must be an object）')
  }
  const source = data as { targetLanguage?: unknown; entries?: unknown }
  const targetLanguage =
    typeof source.targetLanguage === 'string' && source.targetLanguage.trim() !== ''
      ? source.targetLanguage.trim().slice(0, 32)
      : 'zh'
  const rawEntries = source.entries
  if (rawEntries === null || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    throw badRequest('translations.entries 必须是对象（translations.entries must be an object）')
  }
  const entries: Record<string, string> = {}
  let count = 0
  for (const [key, value] of Object.entries(rawEntries)) {
    if (typeof value !== 'string') continue
    if (key === '' || key.length > 512) continue
    entries[key] = value.slice(0, 20000)
    count += 1
    if (count >= MAX_TRANSLATIONS) break
  }
  return { version: 1, targetLanguage, entries }
}

/**
 * Validate one aux JSON file name before any path is built.
 *
 * @param name - candidate file name.
 * @returns the accepted name.
 * @throws {WireError} `bad-request` for names outside the aux grammar.
 */
export function requireAuxName(name: unknown): string {
  if (typeof name !== 'string' || !AUX_NAME_PATTERN.test(name)) {
    throw badRequest(`无效的辅助文件名（Invalid aux file name）: ${String(name)}`)
  }
  return name
}

/**
 * Wrap persisted annotation items in the frozen on-disk envelope.
 *
 * @param items - persisted annotation items.
 * @returns `{ version: 1, items }`.
 */
export function annotationEnvelope(items: StoredAnnotation[]): AnnotationEnvelope {
  return { version: 1, items }
}
