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
 * concurrent HTTP calls can never interleave two writes of the same file.
 *
 * All id-taking methods validate the id as UUID-shaped before building a path.
 *
 * @module lib/store
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { HIGHLIGHT_COLORS } from './config.js'
import { extOf, isSupportedSource, mimeForPath } from './mime.js'
import { WireError, requireUuid } from './wire.js'

/** Document statuses. */
const STATUSES = new Set(['uploaded', 'parsing', 'parsed', 'failed'])
/** Cap on stored annotations per document. */
const MAX_ANNOTATIONS = 5000
/** Cap on stored translation entries per document. */
const MAX_TRANSLATIONS = 50000
/** Cap on the diagnostics log. */
const MAX_DIAGNOSTIC_LINES = 200
/** Partial uploads older than this are considered leftovers from a previous process. */
const STALE_TEMP_MS = 10 * 60 * 1000
/** UUID shape used for directory names. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Clone a JSON-serializable value (metadata never contains class instances). */
function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/** Build a `not-found` WireError for a document id. */
function notFound(id) {
  return new WireError('not-found', `文档不存在（Document not found: ${id}）`, 404)
}

/** Build a `bad-request` WireError. */
function badRequest(message) {
  return new WireError('bad-request', message, 400)
}

/** Atomic UTF-8 write: unique tmp file in the destination directory, then rename. */
async function writeFileAtomic(filePath, text) {
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

/** Serialize per-document metadata/annotation writes onto a promise chain. */
function makeDocQueue() {
  const tails = new Map()
  return {
    /**
     * Run `task` after every previously queued task for `id` settles.
     * The returned promise reflects this task's own outcome.
     * @template T
     * @param {string} id - document id.
     * @param {() => Promise<T>} task - work to serialize.
     * @returns {Promise<T>} task result.
     */
    run(id, task) {
      const previous = tails.get(id) ?? Promise.resolve()
      const run = previous.then(task)
      const tail = run.then(
        () => undefined,
        () => undefined,
      )
      tails.set(id, tail)
      tail.then(() => {
        if (tails.get(id) === tail) tails.delete(id)
      })
      return run
    },
    /** Snapshot of currently pending write chains. */
    pending() {
      return [...tails.values()]
    },
    /** Number of documents with pending writes. */
    size() {
      return tails.size
    },
  }
}

/** Largest parsed markdown / content-list file accepted from disk. */
const MAX_PARSED_FILE_BYTES = 64 * 1024 * 1024
/** Largest persisted annotation / translation document accepted from disk. */
const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024
/** Largest diagnostics log accepted before it is reset. */
const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024

/** Read one UTF-8 file, refusing files above `maxBytes` (bounded read). */
async function readFileCapped(filePath, maxBytes) {
  const info = await stat(filePath)
  if (info.size > maxBytes) {
    throw new WireError('too-large', '文件超过读取上限（File exceeds the read limit）', 413, { limit: maxBytes })
  }
  return readFile(filePath, 'utf8')
}

/** Hash and size a file without buffering it entirely. */
async function hashAndSize(filePath) {
  const hash = createHash('sha256')
  let size = 0
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return { size, sha256: hash.digest('hex') }
}

/** File-name stem without its extension. */
function stemOf(fileName) {
  const base = basename(fileName)
  const ext = extOf(base)
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length)
  return stem.trim() === '' ? base : stem
}

/** Validate and clamp one stored annotation item; returns null when unusable. */
/** Citation aspects accepted on annotations (mirrors docs/AI-SPEC.md §2). */
const AI_ASPECTS = new Set(['definition', 'method', 'result', 'limitation', 'context'])

/** Validate one aux JSON file name (`chat.json`, `graph.json`, …). */
const AUX_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,64}$/i

/** Resolve one aux file path inside a document directory. */
function auxPath(docDirectory, name) {
  if (typeof name !== 'string' || !AUX_NAME_PATTERN.test(name)) {
    throw badRequest(`无效的辅助文件名（Invalid aux file name）: ${String(name)}`)
  }
  return join(docDirectory, name)
}

function normalizeAnnotationItem(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const blockKey = typeof item.blockKey === 'string' ? item.blockKey.trim() : ''
  if (blockKey === '') return null
  const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  let start = finite(item.start)
  let end = finite(item.end)
  if (start === undefined) start = 0
  if (end === undefined) end = start
  start = Math.max(0, Math.floor(start))
  end = Math.max(start, Math.floor(end))
  const out = {
    id: typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : randomUUID(),
    blockKey,
    start,
    end,
    quote: typeof item.quote === 'string' ? item.quote.slice(0, 5000) : '',
    note: typeof item.note === 'string' ? item.note.slice(0, 20000) : '',
    color: HIGHLIGHT_COLORS.has(item.color) ? item.color : 'yellow',
  }
  if (typeof item.createdAt === 'string' && item.createdAt !== '') out.createdAt = item.createdAt
  else out.createdAt = new Date().toISOString()
  // AI provenance (see docs/AI-SPEC.md §2): never drop it when a client or the
  // chat service rewrites the annotation list.
  if (item.origin === 'user' || item.origin === 'ai') out.origin = item.origin
  if (typeof item.aspect === 'string' && AI_ASPECTS.has(item.aspect)) out.aspect = item.aspect
  if (typeof item.chatId === 'string' && item.chatId !== '') out.chatId = item.chatId.slice(0, 200)
  if (typeof item.messageId === 'string' && item.messageId !== '') out.messageId = item.messageId.slice(0, 200)
  if (item.model !== null && typeof item.model === 'object' && typeof item.model.provider === 'string'
    && typeof item.model.model === 'string') {
    out.model = { provider: item.model.provider.slice(0, 100), model: item.model.model.slice(0, 100) }
  }
  return out
}

/** Normalize an untrusted annotation list into the persisted shape. */
function normalizeAnnotations(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw badRequest('annotations 必须是对象（annotations must be an object）')
  }
  if (!Array.isArray(data.items)) throw badRequest('annotations.items 必须是数组（annotations.items must be an array）')
  if (data.items.length > MAX_ANNOTATIONS) {
    throw new WireError('too-large', `批注数量超过 ${MAX_ANNOTATIONS} 条限制（Too many annotations）`, 413)
  }
  const items = []
  for (const item of data.items) {
    const normalized = normalizeAnnotationItem(item)
    if (normalized !== null) items.push(normalized)
  }
  return { version: 1, items }
}

/** Normalize the persisted translations document. */
function normalizeTranslations(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw badRequest('translations 必须是对象（translations must be an object）')
  }
  const targetLanguage =
    typeof data.targetLanguage === 'string' && data.targetLanguage.trim() !== ''
      ? data.targetLanguage.trim().slice(0, 32)
      : 'zh'
  const rawEntries = data.entries
  if (rawEntries === null || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    throw badRequest('translations.entries 必须是对象（translations.entries must be an object）')
  }
  const entries = {}
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
 * Create the library store.
 *
 * @param {{ dataDir: string, logger?: { warn?: Function, info?: Function, error?: Function } }} options
 *   resolved data directory and optional logger.
 * @returns {{
 *   init(): Promise<void>, list(): Record<string, any>[], get(id: string): Record<string, any> | undefined,
 *   has(id: string): boolean, docDir(id: string): string, sourcePath(id: string): Promise<string>,
 *   parsedDir(id: string): string, newTempPath(id: string): string,
 *   createFromFile(input: { id: string, tempPath: string, originalName: string, title?: string }): Promise<Record<string, any>>,
 *   update(id: string, patch: Record<string, any>): Promise<Record<string, any>>,
 *   remove(id: string): Promise<boolean>,
 *   readMarkdown(id: string): Promise<{ markdown: string, contentList: object[] | null, pages: number | null }>,
 *   loadAnnotations(id: string): Promise<{ version: 1, items: object[] }>,
 *   saveAnnotations(id: string, data: object): Promise<{ version: 1, items: object[] }>,
 *   loadTranslations(id: string): Promise<{ version: 1, targetLanguage: string, entries: Record<string, string> }>,
 *   saveTranslations(id: string, data: object): Promise<object>,
 *   stats(): { total: number, parsed: number, parsing: number, failed: number },
 *   appendDiagnostic(entry: Record<string, unknown>): Promise<void>,
 *   dispose(): Promise<void>,
 * }} the store facade; every method may be called before `init()` resolves
 *   because they share its promise.
 */
export function createStore({ dataDir, logger } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('createStore: a non-empty dataDir is required')
  }
  const log = logger ?? {}
  const rootDir = dataDir
  const documentsDir = join(rootDir, 'documents')
  const tmpDir = join(rootDir, 'tmp')
  const diagnosticsDir = join(rootDir, 'diagnostics')
  const diagnosticsFile = join(diagnosticsDir, 'client.log')

  /** @type {Map<string, Record<string, any>>} */
  const metas = new Map()
  const queue = makeDocQueue()
  /** @type {Promise<void> | undefined} */
  let initPromise
  let diagnosticChain = Promise.resolve()
  let disposePromise

  /** Ensure the directory tree exists and the metadata index is loaded. */
  async function init() {
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
            const meta = JSON.parse(await readFile(metaPath, 'utf8'))
            if (meta === null || typeof meta !== 'object' || meta.id !== dirent.name) {
              log.warn?.('[dsh-litnotes] ignoring malformed metadata for %s', dirent.name)
              continue
            }
            if (!STATUSES.has(meta.status)) meta.status = 'uploaded'
            metas.set(dirent.name, meta)
            await cleanDocDir(join(documentsDir, dirent.name))
          } catch (error) {
            log.warn?.('[dsh-litnotes] cannot read metadata for %s: %s', dirent.name, error?.message ?? error)
          }
        }
      })().catch((error) => {
        initPromise = undefined
        throw error
      })
    }
    return initPromise
  }

  /**
   * Remove leftovers of an interrupted operation inside one document directory:
   * partial uploads (`*.part`), extraction spill files (`*.tmp`) and temporary
   * sibling directories named `tmp-*` / `.tmp-*`. Never throws: a stale file is
   * cosmetic, and one unreadable document must not blank the library.
   *
   * @param {string} dir - absolute document directory.
   * @returns {Promise<void>} resolves after the best-effort cleanup.
   */
  async function cleanDocDir(dir) {
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
          // (`.parsed-<uuid>`) and legacy temp siblings.
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
  async function cleanTempDir() {
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
  function has(id) {
    return metas.has(id)
  }

  /** Return the metadata record after validation, or throw `not-found`. */
  function requireMeta(id) {
    const docId = requireUuid(id)
    const meta = metas.get(docId)
    if (meta === undefined) throw notFound(docId)
    return meta
  }

  /** Absolute document directory (id must be UUID-shaped). */
  function docDir(id) {
    return join(documentsDir, requireUuid(id))
  }

  /** Absolute parsed directory (does not create it). */
  function parsedDir(id) {
    requireMeta(id)
    return join(docDir(id), 'parsed')
  }

  /** Absolute path of the stored original file. */
  async function sourcePath(id) {
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
  async function writeMeta(docId, meta) {
    await writeFileAtomic(join(docDir(docId), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }

  /**
   * Create a document from an uploaded temp file.
   * @param {{ id: string, tempPath: string, originalName: string, title?: string }} input
   * @returns {Promise<Record<string, any>>} the created metadata.
   */
  async function createFromFile({ id, tempPath, originalName, title }) {
    await init()
    const docId = requireUuid(id)
    if (typeof tempPath !== 'string' || tempPath === '') throw badRequest('缺少临时文件路径（Missing temp path）')
    if (typeof originalName !== 'string' || originalName.trim() === '') {
      throw badRequest('缺少文件名（Missing file name）')
    }
    const fileName = originalName.trim().slice(0, 255)
    const ext = extOf(fileName)
    if (!isSupportedSource(fileName)) {
      throw new WireError('unsupported-type', `不支持的文件类型 ${ext || fileName}（Unsupported file type）`, 415)
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
          if (error?.code === 'EXDEV') {
            await copyFile(tempPath, target)
            await rm(tempPath, { force: true }).catch(() => {})
          } else {
            throw error
          }
        }
        const now = new Date().toISOString()
        const meta = {
          schemaVersion: 1,
          id: docId,
          title: typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 300) : stemOf(fileName),
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
  function newTempPath(id) {
    const target = join(tmpDir, `${requireUuid(id)}.part`)
    try {
      mkdirSync(tmpDir, { recursive: true })
    } catch {
      /* createFromFile/init will surface a real filesystem error later */
    }
    return target
  }

  /** List metadata records newest first (defensive copies). */
  function list() {
    return [...metas.values()]
      .map((meta) => clone(meta))
      .sort((a, b) => {
        const left = typeof a.createdAt === 'string' ? a.createdAt : ''
        const right = typeof b.createdAt === 'string' ? b.createdAt : ''
        return right.localeCompare(left) || String(b.id).localeCompare(String(a.id))
      })
  }

  /** Look up one metadata record (defensive copy). */
  function get(id) {
    try {
      const docId = requireUuid(id)
      const meta = metas.get(docId)
      return meta === undefined ? undefined : clone(meta)
    } catch {
      return undefined
    }
  }

  /** Shallow-merge metadata; a `parse` patch merges into the existing parse state. */
  async function update(id, patch) {
    await init()
    const docId = requireUuid(id)
    if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw badRequest('更新内容必须是对象（Update payload must be an object）')
    }
    if (patch.status !== undefined && !STATUSES.has(patch.status)) {
      throw badRequest('无效的文档状态（Invalid document status）')
    }
    return queue.run(docId, async () => {
      const current = metas.get(docId)
      if (current === undefined) throw notFound(docId)
      const next = {
        ...current,
        ...patch,
        id: current.id,
        schemaVersion: current.schemaVersion ?? 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      }
      if (patch.parse !== undefined) {
        if (patch.parse === null) {
          next.parse = null
        } else if (typeof patch.parse === 'object' && !Array.isArray(patch.parse)) {
          next.parse = { ...(current.parse ?? {}), ...patch.parse }
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
  async function remove(id) {
    await init()
    const docId = requireUuid(id)
    return queue.run(docId, async () => {
      if (!metas.has(docId)) throw notFound(docId)
      await rm(docDir(docId), { recursive: true, force: true })
      metas.delete(docId)
      return true
    })
  }

  /** Number of pages implied by a content list. */
  function pagesOf(contentList) {
    if (!Array.isArray(contentList)) return null
    let maxPage = -1
    for (const item of contentList) {
      if (item !== null && typeof item === 'object') {
        const page = item.page_idx
        if (typeof page === 'number' && Number.isInteger(page) && page >= 0 && page > maxPage) maxPage = page
      }
    }
    return maxPage >= 0 ? maxPage + 1 : null
  }

  /** Read parsed markdown + content list; throws `not-parsed` when absent. */
  async function readMarkdown(id) {
    await init()
    const meta = requireMeta(id)
    const dir = join(docDir(meta.id), 'parsed')
    let markdown
    try {
      markdown = await readFileCapped(join(dir, 'full.md'), MAX_PARSED_FILE_BYTES)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new WireError('not-parsed', '文档尚未解析完成（Document has not been parsed yet）', 409)
      }
      throw error
    }
    let contentList = null
    try {
      const names = await readdir(dir)
      const candidates = names
        .filter((name) => name === 'content_list.json' || name.endsWith('_content_list.json'))
        .sort((a, b) => (a === 'content_list.json' ? -1 : b === 'content_list.json' ? 1 : a.localeCompare(b)))
      for (const name of candidates) {
        try {
          const parsed = JSON.parse(await readFileCapped(join(dir, name), MAX_PARSED_FILE_BYTES))
          if (Array.isArray(parsed)) {
            contentList = parsed
            break
          }
          if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.content_list)) {
            contentList = parsed.content_list
            break
          }
        } catch (error) {
          log.warn?.('[dsh-litnotes] cannot parse %s: %s', name, error?.message ?? error)
        }
      }
    } catch {
      /* no parsed directory listing: content list stays null */
    }
    const pages = pagesOf(contentList) ?? (Number.isInteger(meta.parse?.pages) ? meta.parse.pages : null)
    return { markdown, contentList, pages }
  }

  /** Read persisted annotations; corrupt/missing files read as an empty list. */
  async function loadAnnotations(id) {
    await init()
    const meta = requireMeta(id)
    try {
      const parsed = JSON.parse(
        await readFileCapped(join(docDir(meta.id), 'annotations.json'), MAX_STATE_FILE_BYTES),
      )
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
        return normalizeAnnotations(parsed)
      }
    } catch {
      /* missing or corrupt: empty list */
    }
    return { version: 1, items: [] }
  }

  /** Persist the complete annotation list for one document. */
  async function saveAnnotations(id, data) {
    await init()
    const docId = requireUuid(id)
    const normalized = normalizeAnnotations(data)
    return queue.run(docId, async () => {
      const meta = metas.get(docId)
      if (meta === undefined) throw notFound(docId)
      await writeFileAtomic(join(docDir(docId), 'annotations.json'), `${JSON.stringify(normalized, null, 2)}\n`)
      return clone(normalized)
    })
  }

  /** Read the persisted translation cache; corrupt/missing files read empty. */
  async function loadTranslations(id) {
    await init()
    const meta = requireMeta(id)
    try {
      const parsed = JSON.parse(
        await readFileCapped(join(docDir(meta.id), 'translations.json'), MAX_STATE_FILE_BYTES),
      )
      if (parsed !== null && typeof parsed === 'object') return normalizeTranslations(parsed)
    } catch {
      /* missing or corrupt: empty cache */
    }
    return { version: 1, targetLanguage: 'zh', entries: {} }
  }

  /** Persist the complete translation cache for one document. */
  async function saveTranslations(id, data) {
    await init()
    const docId = requireUuid(id)
    const normalized = normalizeTranslations(data)
    return queue.run(docId, async () => {
      const meta = metas.get(docId)
      if (meta === undefined) throw notFound(docId)
      await writeFileAtomic(join(docDir(docId), 'translations.json'), `${JSON.stringify(normalized, null, 2)}\n`)
      return clone(normalized)
    })
  }

  /** Aggregate library counts. */
  function stats() {
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

  /** Dedicated write chain for library-level aux JSON files. */
  let libraryQueue = Promise.resolve()

  /** Run one library-level write after every earlier write settled. */
  function libraryWrite(task) {
    const run = libraryQueue.then(task, task)
    libraryQueue = run.catch(() => {})
    return run
  }

  /**
   * Read one JSON aux file of a document (`chat.json`, `graph.json`, …).
   *
   * @param {string} id - document id.
   * @param {string} name - aux file name.
   * @returns {Promise<unknown | null>} parsed JSON, or null when missing/corrupt.
   */
  async function readAux(id, name) {
    await init()
    const meta = requireMeta(id)
    try {
      const text = await readFileCapped(auxPath(docDir(meta.id), name), MAX_STATE_FILE_BYTES)
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /**
   * Persist one JSON aux file of a document atomically.
   *
   * @param {string} id - document id.
   * @param {string} name - aux file name.
   * @param {unknown} value - JSON-serializable value.
   * @returns {Promise<void>} resolves after the write.
   */
  async function writeAux(id, name, value) {
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
   * Read one library-level aux JSON file (`library-graph.json`, …).
   * @param {string} name - aux file name.
   * @returns {Promise<unknown | null>} parsed JSON, or null when missing/corrupt.
   */
  async function readLibraryAux(name) {
    await init()
    try {
      const text = await readFileCapped(auxPath(rootDir, name), MAX_STATE_FILE_BYTES)
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /**
   * Persist one library-level aux JSON file atomically.
   * @param {string} name - aux file name.
   * @param {unknown} value - JSON-serializable value.
   * @returns {Promise<void>} resolves after the write.
   */
  function writeLibraryAux(name, value) {
    const target = auxPath(rootDir, name)
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_STATE_FILE_BYTES) {
      return Promise.reject(new WireError('too-large', '辅助数据超过大小限制（Aux data too large）', 413))
    }
    return libraryWrite(async () => {
      await init()
      await writeFileAtomic(target, text)
    })
  }

  /**
   * Append one JSON line to the diagnostics log, capped to the newest
   * {@link MAX_DIAGNOSTIC_LINES} lines. Never throws.
   *
   * @param {Record<string, unknown>} entry - diagnostic entry.
   * @returns {Promise<void>} resolves after the write attempt.
   */
  function appendDiagnostic(entry) {
    const line = JSON.stringify({ ...entry, at: entry?.at ?? new Date().toISOString() })
    diagnosticChain = diagnosticChain.then(async () => {
      const filePath = diagnosticsFile
      let lines = []
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
    diagnosticChain = diagnosticChain.catch((error) => {
      log.warn?.('[dsh-litnotes] diagnostics write failed: %s', error?.message ?? error)
    })
    return diagnosticChain
  }

  /** Await pending writes; idempotent. */
  function dispose() {
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
    loadTranslations,
    saveTranslations,
    stats,
    readAux,
    writeAux,
    readLibraryAux,
    writeLibraryAux,
    appendDiagnostic,
    dispose,
  }
}
