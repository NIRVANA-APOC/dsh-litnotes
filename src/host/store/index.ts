/**
 * On-disk literature library for dsh-litnotes.
 *
 * Layout (docs/ARCH.md §3):
 *
 *     <dataDir>/documents/<uuid>/meta.json          document metadata (source of truth)
 *     <dataDir>/documents/<uuid>/source.<ext>       uploaded original
 *     <dataDir>/documents/<uuid>/parsed/full.md     MinerU markdown
 *     <dataDir>/documents/<uuid>/annotations.json   client-owned annotations
 *     <dataDir>/documents/<uuid>/translations.json  client-owned translation cache
 *     <dataDir>/tmp/<id>.part                       in-flight uploads
 *     <dataDir>/diagnostics/client.log              client diagnostics (capped)
 *
 * There is no separate index file: scanning `documents/*​/meta.json` is the
 * library index, which makes crash recovery trivial. Every JSON write is
 * atomic (tmp + rename) and serialized per document through a promise queue so
 * concurrent HTTP calls and AI writers can never interleave two writes of the
 * same file.
 *
 * All id-taking methods validate the id as UUID-shaped before building a path.
 * Reads tolerate the frozen 1.0.0 formats: a pre-parse `meta.json` may carry
 * `parse: null`, and corrupt annotation/translation/aux files read as empty.
 *
 * @module host/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type {
  Annotation,
  ContentListEntry,
  DocumentMeta,
  ParseState,
  Preferences,
  TranslationEnvelope,
} from '../../shared/model.ts'
import type { DocumentStatus, ParsedDocument } from '../../shared/model.ts'
import { normalizePreferences } from '../../shared/preferences.ts'
import type { DocumentAuxName, LibraryAuxName, StoreApi } from '../contracts.ts'
import type { Logger } from '../host-services.ts'
import { extOf, isSupportedSource, mimeForPath } from '../mime.ts'
import { requireUuid, WireError } from '../wire.ts'
import {
  MAX_ANNOTATIONS,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_LINES,
  MAX_PARSED_FILE_BYTES,
  MAX_STATE_FILE_BYTES,
  STALE_TEMP_MS,
  UUID_PATTERN,
  annotationEnvelope,
  badRequest,
  errorCode,
  normalizeAnnotations,
  normalizeBaseIds,
  normalizeTranslations,
  notFound,
  requireAuxName,
  type StoredAnnotation,
} from './normalize.ts'
import { makeDocQueue, makeSerialChain } from './queue.ts'

/** Document statuses. */
const STATUSES: ReadonlySet<string> = new Set<DocumentStatus>([
  'uploaded',
  'parsing',
  'parsed',
  'failed',
])

/** Options accepted by {@link createStore}. */
export interface StoreOptions {
  dataDir: string
  logger?: Logger
}

/** Clone a JSON-serializable value (metadata never contains class instances). */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Atomic UTF-8 write: unique tmp file in the destination directory, then rename. */
async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, filePath)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Read one UTF-8 file, refusing files above `maxBytes` (bounded read). */
async function readFileCapped(filePath: string, maxBytes: number): Promise<string> {
  const info = await stat(filePath)
  if (info.size > maxBytes) {
    throw new WireError('too-large', '文件超过读取上限（File exceeds the read limit）', 413, {
      limit: maxBytes,
    })
  }
  return readFile(filePath, 'utf8')
}

/** Hash and size a file without buffering it entirely. */
async function hashAndSize(filePath: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolvePromise())
  })
  return { size, sha256: hash.digest('hex') }
}

/** File-name stem without its extension. */
function stemOf(fileName: string): string {
  const base = basename(fileName)
  const ext = extOf(base)
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length)
  return stem.trim() === '' ? base : stem
}

/** Number of pages implied by a content list. */
function pagesOf(contentList: unknown): number | null {
  if (!Array.isArray(contentList)) return null
  let maxPage = -1
  for (const item of contentList) {
    if (item !== null && typeof item === 'object') {
      const page = (item as { page_idx?: unknown }).page_idx
      if (typeof page === 'number' && Number.isInteger(page) && page >= 0 && page > maxPage) {
        maxPage = page
      }
    }
  }
  return maxPage >= 0 ? maxPage + 1 : null
}

/** Resolve one aux file path inside a document or library directory. */
function auxPath(baseDirectory: string, name: string): string {
  return join(baseDirectory, requireAuxName(name))
}

/**
 * Create the library store.
 *
 * @param options - resolved data directory and optional logger.
 * @returns the store facade; every method may be called before `init()`
 *   resolves because they share its promise.
 */
export function createStore({ dataDir, logger }: StoreOptions): StoreApi {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('createStore: a non-empty dataDir is required')
  }
  const log: Logger = logger ?? {}
  const rootDir = dataDir
  const documentsDir = join(rootDir, 'documents')
  const tmpDir = join(rootDir, 'tmp')
  const diagnosticsDir = join(rootDir, 'diagnostics')
  const diagnosticsFile = join(diagnosticsDir, 'client.log')

  const metas = new Map<string, DocumentMeta>()
  const queue = makeDocQueue()
  const libraryQueue = makeSerialChain()
  let initPromise: Promise<void> | undefined
  let diagnosticChain: Promise<void> = Promise.resolve()
  let disposePromise: Promise<void> | undefined

  /** Ensure the directory tree exists and the metadata index is loaded. */
  async function init(): Promise<void> {
    if (initPromise === undefined) {
      initPromise = (async () => {
        await mkdir(documentsDir, { recursive: true })
        await mkdir(tmpDir, { recursive: true })
        await mkdir(diagnosticsDir, { recursive: true })
        await cleanTempDir()
        const dirents = await readdir(documentsDir, { withFileTypes: true })
        for (const dirent of dirents) {
          if (!dirent.isDirectory()) continue
          if (!UUID_PATTERN.test(dirent.name)) {
            log.warn?.('[dsh-litnotes] ignoring non-uuid library directory %s', dirent.name)
            continue
          }
          const metaPath = join(documentsDir, dirent.name, 'meta.json')
          try {
            const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf8'))
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              log.warn?.('[dsh-litnotes] ignoring malformed metadata for %s', dirent.name)
              continue
            }
            const meta = parsed as DocumentMeta
            if (meta.id !== dirent.name) {
              log.warn?.('[dsh-litnotes] ignoring malformed metadata for %s', dirent.name)
              continue
            }
            if (!STATUSES.has(meta.status)) meta.status = 'uploaded'
            metas.set(dirent.name, meta)
            await cleanDocDir(join(documentsDir, dirent.name))
          } catch (error) {
            log.warn?.(
              '[dsh-litnotes] cannot read metadata for %s: %s',
              dirent.name,
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      })().catch((error: unknown) => {
        initPromise = undefined
        throw error
      })
    }
    return initPromise
  }

  /**
   * Remove leftovers of an interrupted operation inside one document directory:
   * partial uploads (`*.part`), extraction spill files (`*.tmp`) and temporary
   * sibling directories named `tmp-*` / `.tmp-*`. Never throws.
   *
   * @param dir - absolute document directory.
   */
  async function cleanDocDir(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      try {
        if (entry.isFile()) {
          // Partial uploads (`*.part`) and atomic-write spills whose rename
          // never completed (`.meta.json.tmp-<pid>-<uuid>`).
          if (/\.(?:part|tmp)$/i.test(entry.name) || /^\..+\.tmp-\d+-/i.test(entry.name)) {
            await rm(join(dir, entry.name), { force: true })
          }
        } else if (entry.isDirectory()) {
          // Staging parse trees that were never atomically swapped in
          // (`.parsed-<uuid>`) and temp siblings from an interrupted operation.
          if (/^\.parsed-/i.test(entry.name) || /^\.?tmp[-_]/i.test(entry.name)) {
            await rm(join(dir, entry.name), { recursive: true, force: true })
          }
        }
      } catch {
        /* stale leftovers are best-effort */
      }
    }
  }

  /**
   * Remove stale partial uploads from a previous process. Only entries older
   * than {@link STALE_TEMP_MS} are removed so an upload that started while a
   * host boot was still initializing cannot be deleted underneath itself.
   */
  async function cleanTempDir(): Promise<void> {
    let dirents
    try {
      dirents = await readdir(tmpDir, { withFileTypes: true })
    } catch {
      return
    }
    const cutoff = Date.now() - STALE_TEMP_MS
    for (const dirent of dirents) {
      const target = join(tmpDir, dirent.name)
      try {
        const info = await stat(target)
        if (info.mtimeMs >= cutoff) continue
      } catch {
        continue
      }
      await rm(target, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Whether an in-memory metadata record exists for the id. */
  function has(id: string): boolean {
    return metas.has(id)
  }

  /** Return the metadata record after validation, or throw `not-found`. */
  function requireMeta(id: string): DocumentMeta {
    const docId = requireUuid(id)
    const meta = metas.get(docId)
    if (meta === undefined) throw notFound(docId)
    return meta
  }

  /** Absolute document directory (id must be UUID-shaped). */
  function docDir(id: string): string {
    return join(documentsDir, requireUuid(id))
  }

  /** Absolute parsed directory (does not create it). */
  function parsedDir(id: string): string {
    requireMeta(id)
    return join(docDir(id), 'parsed')
  }

  /** Absolute path of the stored original file. */
  async function sourcePath(id: string): Promise<string> {
    await init()
    const meta = requireMeta(id)
    // The extension comes from meta.json and is host-written, but never trust
    // a stored path fragment: an odd value must not escape the document dir.
    const ext = /^\.[a-z0-9]{1,10}$/i.test(meta.ext) ? meta.ext.toLowerCase() : extOf(meta.originalName)
    if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) {
      throw new WireError('host-error', '文档元数据无效（Invalid document metadata）', 500)
    }
    const filePath = join(docDir(meta.id), `source${ext}`)
    try {
      await stat(filePath)
    } catch {
      throw notFound(meta.id)
    }
    return filePath
  }

  /** Persist metadata atomically for one document. */
  async function writeMeta(docId: string, meta: DocumentMeta): Promise<void> {
    await writeFileAtomic(join(docDir(docId), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }

  /**
   * Create a document from an uploaded temp file.
   *
   * @param input - generated id, uploaded temp path, original file name and
   *   optional display title.
   * @returns the created metadata.
   */
  async function createFromFile(input: {
    id: string
    tempPath: string
    originalName: string
    title?: string
  }): Promise<DocumentMeta> {
    await init()
    const docId = requireUuid(input.id)
    const tempPath = input.tempPath
    const originalName = input.originalName
    if (typeof tempPath !== 'string' || tempPath === '') {
      throw badRequest('缺少临时文件路径（Missing temp path）')
    }
    if (typeof originalName !== 'string' || originalName.trim() === '') {
      throw badRequest('缺少文件名（Missing file name）')
    }
    const fileName = originalName.trim().slice(0, 255)
    const ext = extOf(fileName)
    if (!isSupportedSource(fileName)) {
      throw new WireError(
        'unsupported-type',
        `不支持的文件类型 ${ext || fileName}（Unsupported file type）`,
        415,
      )
    }
    return queue.run(docId, async () => {
      if (metas.has(docId)) throw new WireError('conflict', '文档 ID 冲突（Document id conflict）', 409)
      const dir = docDir(docId)
      await mkdir(dir, { recursive: true })
      try {
        let fileStats
        try {
          fileStats = await stat(tempPath)
        } catch {
          throw badRequest('上传文件不完整（Upload incomplete）')
        }
        if (!fileStats.isFile()) throw badRequest('上传内容不是文件（Upload is not a file）')
        if (fileStats.size === 0) throw badRequest('文件为空（Empty file）')
        const { size, sha256 } = await hashAndSize(tempPath)
        const target = join(dir, `source${ext}`)
        try {
          await rename(tempPath, target)
        } catch (error) {
          if (errorCode(error) === 'EXDEV') {
            await copyFile(tempPath, target)
            await rm(tempPath, { force: true }).catch(() => {})
          } else {
            throw error
          }
        }
        const now = new Date().toISOString()
        const meta: DocumentMeta = {
          schemaVersion: 1,
          id: docId,
          title:
            typeof input.title === 'string' && input.title.trim() !== ''
              ? input.title.trim().slice(0, 300)
              : stemOf(fileName),
          originalName: fileName,
          ext,
          mime: mimeForPath(fileName),
          size,
          sha256,
          createdAt: now,
          updatedAt: now,
          status: 'uploaded',
          error: null,
          parse: null,
        }
        await writeMeta(docId, meta)
        metas.set(docId, meta)
        return clone(meta)
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    })
  }

  /** A unique temp path for an in-flight upload (parent directory is created). */
  function newTempPath(id: string): string {
    const target = join(tmpDir, `${requireUuid(id)}.part`)
    try {
      mkdirSync(tmpDir, { recursive: true })
    } catch {
      /* createFromFile/init will surface a real filesystem error later */
    }
    return target
  }

  /** List metadata records newest first (defensive copies). */
  function list(): DocumentMeta[] {
    return [...metas.values()]
      .map((meta) => clone(meta))
      .sort((a, b) => {
        const left = typeof a.createdAt === 'string' ? a.createdAt : ''
        const right = typeof b.createdAt === 'string' ? b.createdAt : ''
        return right.localeCompare(left) || String(b.id).localeCompare(String(a.id))
      })
  }

  /** Look up one metadata record (defensive copy). */
  function get(id: string): DocumentMeta | undefined {
    try {
      const docId = requireUuid(id)
      const meta = metas.get(docId)
      return meta === undefined ? undefined : clone(meta)
    } catch {
      return undefined
    }
  }

  /** Shallow-merge metadata; a `parse` patch merges into the existing parse state. */
  async function update(
    id: string,
    patch: Partial<Omit<DocumentMeta, 'parse'>> & { parse?: Partial<ParseState> | null },
  ): Promise<DocumentMeta> {
    await init()
    const docId = requireUuid(id)
    const rawPatch: unknown = patch
    if (rawPatch === null || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
      throw badRequest('更新内容必须是对象（Update payload must be an object）')
    }
    if (patch.status !== undefined && !STATUSES.has(patch.status)) {
      throw badRequest('无效的文档状态（Invalid document status）')
    }
    return queue.run(docId, async () => {
      const current = metas.get(docId)
      if (current === undefined) throw notFound(docId)
      // Apply only top-level fields; `parse` is merged field-by-field below and
      // the identity/version fields always come from the stored metadata.
      const topLevelPatch: Record<string, unknown> = { ...patch }
      delete topLevelPatch.parse
      delete topLevelPatch.id
      delete topLevelPatch.schemaVersion
      delete topLevelPatch.createdAt
      const next = {
        ...current,
        ...topLevelPatch,
        id: current.id,
        schemaVersion: 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      } as DocumentMeta
      const patchParse: unknown = patch.parse
      if (patchParse !== undefined) {
        if (patchParse === null) {
          next.parse = null
        } else if (typeof patchParse === 'object' && !Array.isArray(patchParse)) {
          // Sparse merge of the parse state: 1.0.0 updates patch only the
          // fields they change, so the stored object may be partial.
          next.parse = { ...(current.parse ?? {}), ...(patchParse as Partial<ParseState>) } as ParseState
        } else {
          throw badRequest('parse 更新必须是对象（parse patch must be an object）')
        }
      }
      await writeMeta(docId, next)
      metas.set(docId, next)
      return clone(next)
    })
  }

  /** Delete a document directory and forget it. */
  async function remove(id: string): Promise<void> {
    await init()
    const docId = requireUuid(id)
    await queue.run(docId, async () => {
      if (!metas.has(docId)) throw notFound(docId)
      await rm(docDir(docId), { recursive: true, force: true })
      metas.delete(docId)
    })
  }

  /** Read parsed markdown + content list; throws `not-parsed` when absent. */
  async function readMarkdown(id: string): Promise<ParsedDocument> {
    await init()
    const meta = requireMeta(id)
    const dir = join(docDir(meta.id), 'parsed')
    let markdown: string
    try {
      markdown = await readFileCapped(join(dir, 'full.md'), MAX_PARSED_FILE_BYTES)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new WireError('not-parsed', '文档尚未解析完成（Document has not been parsed yet）', 409)
      }
      throw error
    }
    let contentList: ContentListEntry[] | null = null
    try {
      const names = await readdir(dir)
      const candidates = names
        .filter((name) => name === 'content_list.json' || name.endsWith('_content_list.json'))
        .sort((a, b) =>
          a === 'content_list.json' ? -1 : b === 'content_list.json' ? 1 : a.localeCompare(b),
        )
      for (const name of candidates) {
        try {
          const parsed: unknown = JSON.parse(await readFileCapped(join(dir, name), MAX_PARSED_FILE_BYTES))
          if (Array.isArray(parsed)) {
            contentList = parsed as ContentListEntry[]
            break
          }
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { content_list?: unknown }).content_list)
          ) {
            contentList = (parsed as { content_list: ContentListEntry[] }).content_list
            break
          }
        } catch (error) {
          log.warn?.(
            '[dsh-litnotes] cannot parse %s: %s',
            name,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    } catch {
      /* no parsed directory listing: content list stays null */
    }
    const metaPages = meta.parse?.pages
    const pages =
      pagesOf(contentList) ??
      (typeof metaPages === 'number' && Number.isInteger(metaPages) ? metaPages : null)
    return { markdown, contentList, pages }
  }

  /**
   * Read + normalize `annotations.json` for an already-validated document id.
   * Corrupt/missing files read as an empty list (never throws).
   *
   * @param docId - validated document id.
   * @returns normalized annotation items.
   */
  async function readAnnotationItems(docId: string): Promise<StoredAnnotation[]> {
    try {
      const parsed: unknown = JSON.parse(
        await readFileCapped(join(docDir(docId), 'annotations.json'), MAX_STATE_FILE_BYTES),
      )
      if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
        return normalizeAnnotations(parsed).items
      }
    } catch {
      /* missing or corrupt: empty list */
    }
    return []
  }

  /** Read persisted annotations; corrupt/missing files read as an empty list. */
  async function loadAnnotations(id: string) {
    await init()
    const meta = requireMeta(id)
    return annotationEnvelope(await readAnnotationItems(meta.id))
  }

  /**
   * Persist the complete annotation list for one document.
   *
   * Additive 3-way merge: when `data.baseIds` is a string array (the ids the
   * client had loaded before editing), the incoming items are authoritative for
   * those base ids (an edit wins, a deletion wins), while any on-disk annotation
   * whose id is neither in `baseIds` nor among the incoming items is appended —
   * concurrent AI/agent additions are never lost. Without `baseIds` the old
   * replace semantics apply unchanged.
   *
   * @param id - document id.
   * @param data - annotation list plus optional concurrency baseline.
   * @returns the persisted merged list.
   */
  async function saveAnnotations(
    id: string,
    data: { items?: Annotation[]; baseIds?: string[] },
  ): Promise<{ version: 1; items: Annotation[] }> {
    await init()
    const docId = requireUuid(id)
    const normalized = normalizeAnnotations(data)
    const baseIds = normalizeBaseIds(data.baseIds)
    return queue.run(docId, async () => {
      const meta = metas.get(docId)
      if (meta === undefined) throw notFound(docId)
      let persisted = normalized
      if (baseIds !== null) {
        const base = new Set(baseIds)
        const incoming = new Set(normalized.items.map((item) => item.id))
        const appended: StoredAnnotation[] = []
        for (const item of await readAnnotationItems(docId)) {
          if (base.has(item.id) || incoming.has(item.id)) continue
          appended.push(item)
        }
        if (appended.length > 0) {
          persisted = { version: 1, items: normalized.items.concat(appended).slice(0, MAX_ANNOTATIONS) }
        }
      }
      await writeFileAtomic(
        join(docDir(docId), 'annotations.json'),
        `${JSON.stringify(persisted, null, 2)}\n`,
      )
      return annotationEnvelope(persisted.items)
    })
  }

  /**
   * Atomically read-modify-write the annotation list for one document.
   *
   * Serialized on the document's write queue, so concurrent writers (the chat
   * engine creating AI annotations, the agent tools, the client's whole-list
   * saves) can never lose each other's edits. `mutate(items)` receives a
   * defensive copy and returns the new list; mutating in place and returning
   * the same array is also supported, as is the frozen 1.0.0 `{ items }`
   * wrapper or an `undefined` return for in-place edits.
   *
   * @param id - document id.
   * @param mutate - synchronous or asynchronous mutator.
   * @returns the persisted list.
   */
  async function mutateAnnotations(
    id: string,
    mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>,
  ): Promise<{ version: 1; items: Annotation[] }> {
    await init()
    const docId = requireUuid(id)
    if (typeof mutate !== 'function') {
      throw badRequest('mutate 必须是函数（mutate must be a function）')
    }
    return queue.run(docId, async () => {
      if (metas.get(docId) === undefined) throw notFound(docId)
      const draft = (await readAnnotationItems(docId)).map((item) => clone(item)) as unknown as Annotation[]
      const mutated: unknown = await mutate(draft)
      const candidate: Annotation[] = Array.isArray(mutated)
        ? mutated
        : mutated !== null &&
            typeof mutated === 'object' &&
            Array.isArray((mutated as { items?: unknown }).items)
          ? ((mutated as { items: Annotation[] }).items)
          : draft
      const normalized = normalizeAnnotations({ version: 1, items: candidate })
      await writeFileAtomic(
        join(docDir(docId), 'annotations.json'),
        `${JSON.stringify(normalized, null, 2)}\n`,
      )
      return annotationEnvelope(normalized.items)
    })
  }

  /** Read the persisted translation cache; corrupt/missing files read empty. */
  async function loadTranslations(id: string): Promise<TranslationEnvelope> {
    await init()
    const meta = requireMeta(id)
    try {
      const parsed: unknown = JSON.parse(
        await readFileCapped(join(docDir(meta.id), 'translations.json'), MAX_STATE_FILE_BYTES),
      )
      if (parsed !== null && typeof parsed === 'object') return normalizeTranslations(parsed)
    } catch {
      /* missing or corrupt: empty cache */
    }
    return { version: 1, targetLanguage: 'zh', entries: {} }
  }

  /** Persist the complete translation cache for one document. */
  async function saveTranslations(
    id: string,
    data: Partial<TranslationEnvelope>,
  ): Promise<TranslationEnvelope> {
    await init()
    const docId = requireUuid(id)
    const normalized = normalizeTranslations(data)
    return queue.run(docId, async () => {
      const meta = metas.get(docId)
      if (meta === undefined) throw notFound(docId)
      await writeFileAtomic(
        join(docDir(docId), 'translations.json'),
        `${JSON.stringify(normalized, null, 2)}\n`,
      )
      return clone(normalized)
    })
  }

  /** Aggregate library counts. */
  function stats(): { total: number; parsed: number; parsing: number; failed: number } {
    let parsed = 0
    let parsing = 0
    let failed = 0
    for (const meta of metas.values()) {
      if (meta.status === 'parsed') parsed += 1
      else if (meta.status === 'parsing') parsing += 1
      else if (meta.status === 'failed') failed += 1
    }
    return { total: metas.size, parsed, parsing, failed }
  }

  /**
   * Read one JSON aux file of a document (`chat.json`, `graph.json`).
   *
   * @param id - document id.
   * @param name - aux file name.
   * @returns parsed JSON, or undefined when missing/corrupt.
   */
  async function readAux<T>(id: string, name: DocumentAuxName): Promise<T | undefined> {
    await init()
    const meta = requireMeta(id)
    // Validate the name before reading so a traversal attempt is an error, not
    // a silent "missing file".
    const target = auxPath(docDir(meta.id), name)
    try {
      const text = await readFileCapped(target, MAX_STATE_FILE_BYTES)
      return JSON.parse(text) as T
    } catch {
      return undefined
    }
  }

  /**
   * Persist one JSON aux file of a document atomically.
   *
   * @param id - document id.
   * @param name - aux file name.
   * @param value - JSON-serializable value.
   */
  async function writeAux(id: string, name: DocumentAuxName, value: unknown): Promise<void> {
    await init()
    const docId = requireUuid(id)
    const target = auxPath(docDir(docId), name)
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_STATE_FILE_BYTES) {
      throw new WireError('too-large', '辅助数据超过大小限制（Aux data too large）', 413)
    }
    return queue.run(docId, async () => {
      if (metas.get(docId) === undefined) throw notFound(docId)
      await writeFileAtomic(target, text)
    })
  }

  /**
   * Atomically read-modify-write one JSON aux file of a document.
   *
   * Runs inside the per-document write queue, so concurrent chat turns (each
   * appending its own messages) can never lose one another's writes. A missing
   * or corrupt file reads as `undefined`; `mutate(current)` returning
   * `undefined` means "no write" (the promise resolves `undefined`).
   *
   * @param id - document id.
   * @param name - aux file name (`chat.json`, `graph.json`).
   * @param mutate - mutator.
   * @returns the written JSON value, or undefined for no write.
   */
  async function mutateAux<T>(
    id: string,
    name: DocumentAuxName,
    mutate: (current: T | undefined) => T | Promise<T>,
  ): Promise<T> {
    await init()
    const docId = requireUuid(id)
    requireAuxName(name)
    if (typeof mutate !== 'function') {
      throw badRequest('mutate 必须是函数（mutate must be a function）')
    }
    return queue.run(docId, async () => {
      if (metas.get(docId) === undefined) throw notFound(docId)
      const target = auxPath(docDir(docId), name)
      let current: T | undefined
      try {
        current = JSON.parse(await readFileCapped(target, MAX_STATE_FILE_BYTES)) as T
      } catch {
        current = undefined
      }
      const next: unknown = await mutate(current)
      if (next === undefined) {
        // Frozen 1.0.0 semantics: returning undefined means "no write". The
        // contract return type cannot express it, so the no-write path is cast.
        return undefined as unknown as T
      }
      const serialized = JSON.stringify(next, null, 2)
      if (serialized === undefined) {
        throw badRequest('辅助数据不可序列化（Aux data is not JSON-serializable）')
      }
      const text = `${serialized}\n`
      if (Buffer.byteLength(text) > MAX_STATE_FILE_BYTES) {
        throw new WireError('too-large', '辅助数据超过大小限制（Aux data too large）', 413)
      }
      await writeFileAtomic(target, text)
      return clone(next) as T
    })
  }

  /**
   * Read one library-level aux JSON file (`library-graph.json`).
   *
   * @param name - aux file name.
   * @returns parsed JSON, or undefined when missing/corrupt.
   */
  async function readLibraryAux<T>(name: LibraryAuxName): Promise<T | undefined> {
    await init()
    const target = auxPath(rootDir, name)
    try {
      const text = await readFileCapped(target, MAX_STATE_FILE_BYTES)
      return JSON.parse(text) as T
    } catch {
      return undefined
    }
  }

  /**
   * Persist one library-level aux JSON file atomically.
   *
   * @param name - aux file name.
   * @param value - JSON-serializable value.
   */
  async function writeLibraryAux(name: LibraryAuxName, value: unknown): Promise<void> {
    const target = auxPath(rootDir, name)
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_STATE_FILE_BYTES) {
      throw new WireError('too-large', '辅助数据超过大小限制（Aux data too large）', 413)
    }
    return libraryQueue.run(async () => {
      await init()
      await writeFileAtomic(target, text)
    })
  }

  /**
   * Read `<dataDir>/preferences.json`, normalized over the defaults.
   * A missing or corrupt file yields the defaults rather than an error.
   *
   * @returns complete preferences.
   */
  async function readPreferences(): Promise<Preferences> {
    await init()
    try {
      const filePath = join(rootDir, 'preferences.json')
      const info = await stat(filePath)
      if (info.size <= 1024 * 1024) {
        return normalizePreferences(JSON.parse(await readFile(filePath, 'utf8')))
      }
    } catch {
      /* missing or oversized: defaults */
    }
    return normalizePreferences({})
  }

  /**
   * Persist the complete preference object.
   *
   * @param preferences - normalized preferences.
   */
  async function writePreferences(preferences: Preferences): Promise<void> {
    const normalized = normalizePreferences(preferences)
    await init()
    await writeFileAtomic(join(rootDir, 'preferences.json'), `${JSON.stringify(normalized, null, 2)}\n`)
  }

  /**
   * Append one JSON line to the diagnostics log, capped to the newest
   * {@link MAX_DIAGNOSTIC_LINES} lines. Never throws.
   *
   * @param entry - diagnostic entry.
   */
  function appendDiagnostic(entry: Record<string, unknown>): Promise<void> {
    const at = entry.at ?? new Date().toISOString()
    const line = JSON.stringify({ ...entry, at }) ?? '{}'
    diagnosticChain = diagnosticChain.then(async () => {
      const filePath = diagnosticsFile
      let lines: string[] = []
      try {
        const info = await stat(filePath)
        if (info.size <= MAX_DIAGNOSTIC_BYTES) {
          const text = await readFile(filePath, 'utf8')
          lines = text.split('\n').filter((value) => value.trim() !== '')
        }
      } catch {
        lines = []
      }
      lines.push(line)
      while (lines.length > MAX_DIAGNOSTIC_LINES) lines.shift()
      await writeFileAtomic(filePath, `${lines.join('\n')}\n`)
    })
    diagnosticChain = diagnosticChain.catch((error: unknown) => {
      log.warn?.(
        '[dsh-litnotes] diagnostics write failed: %s',
        error instanceof Error ? error.message : String(error),
      )
    })
    return diagnosticChain
  }

  /** Await pending writes; idempotent. */
  function dispose(): Promise<void> {
    if (disposePromise !== undefined) return disposePromise
    disposePromise = (async () => {
      try {
        await initPromise
      } catch {
        /* initialization already failed and was reported */
      }
      for (let round = 0; round < 100 && queue.size() > 0; round += 1) {
        await Promise.allSettled([...queue.pending(), diagnosticChain])
      }
      await diagnosticChain
    })()
    return disposePromise
  }

  return {
    init,
    list,
    get,
    has,
    docDir,
    sourcePath,
    parsedDir,
    newTempPath,
    createFromFile,
    update,
    remove,
    readMarkdown,
    loadAnnotations,
    saveAnnotations,
    mutateAnnotations,
    loadTranslations,
    saveTranslations,
    readAux,
    writeAux,
    mutateAux,
    readLibraryAux,
    writeLibraryAux,
    readPreferences,
    writePreferences,
    appendDiagnostic,
    stats,
    dispose,
  }
}
