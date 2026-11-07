/**
 * Asynchronous MinerU/local parse task manager (typed 1.0.0 port).
 *
 * One `start()` persists `status:'parsing'` (and the parse phase) before any
 * network work begins, then runs a queued job: submit → upload → poll →
 * download → extract into `parsed/`. Concurrency is capped by
 * `config.maxConcurrentParses`; progress is persisted on each poll but
 * throttled to at most one write every two seconds.
 *
 * `cancel()` aborts the in-flight task and returns the document to
 * `status:'uploaded'` (the source is kept). `resume()` inspects every document
 * left in `status:'parsing'` after a host restart: tasks that had reached the
 * polling phase continue polling from their persisted `batchId` / `taskId`,
 * while tasks interrupted mid-submit/upload are explicitly failed because an
 * in-flight upload cannot be resumed safely.
 *
 * Page-scoped repair (`{ merge: true, pages? }`) re-parses only the requested
 * pages, splices them back with `page-merge` and restores the previous parse on
 * failure/cancel — annotations are untouched by a repair.
 *
 * After a successful reparse the manager runs the {@link ReanchorHook} (the
 * shared `reanchorDocumentAnnotations` by default) so annotations survive block
 * key/boundary changes.
 *
 * Persisted `parse.*` fields are exactly the 1.0.0 shape (including the
 * page-repair fields) so a 1.0.0 library resumes correctly.
 *
 * @module host/parse/manager
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  Annotation,
  ContentListEntry,
  DocumentMeta,
  LocalParseStats,
  ParsedDocument,
  ParseProgress,
  ParseState,
  RemoteParseState,
} from '../../shared/model.ts'
import type { ModelVersion, ParseEngine } from '../../shared/constants.ts'
import { reanchorDocumentAnnotations } from '../../shared/annotate/reanchor.ts'
import type {
  ParseManagerApi,
  ParsePlan,
  ParseRepairRequest,
  ParseStartRequest,
  ReanchorHook,
  ResolvedConfig,
  StoreApi,
} from '../contracts.ts'
import type { Logger } from '../host-services.ts'
import { WireError, requireUuid } from '../wire.ts'
import type { MineruClient, MineruFetch, MineruParams, NormalizedParsePlan } from './mineru.ts'
import {
  MineruError,
  createMineruClient,
  describeMineruError,
  failureFromApi,
  normalizeParseOptions,
} from './mineru.ts'
import { mergeRepairedPages, problemPages, toPageRanges } from './page-merge.ts'
import type { LocalEngine } from './local/engine.ts'
import type { StandardBatchRow } from './mineru.ts'
import { unzip } from './unzip.ts'

/** Hard cap for a downloaded result ZIP (MinerU archives are far smaller). */
const ZIP_MAX_BYTES = 512 * 1024 * 1024
/** Hard cap for a downloaded agent markdown document. */
const MARKDOWN_MAX_BYTES = 64 * 1024 * 1024
/** Progress writes are throttled to this interval. */
const PROGRESS_THROTTLE_MS = 2000
/** Consecutive poll transport failures tolerated before failing the task. */
const MAX_POLL_FAILURES = 6
/** Directory under a document that holds the extracted parse output. */
const PARSED_DIR_NAME = 'parsed'
/** Cancellation message persisted on a cancelled parse. */
const ABORTED_MESSAGE = '解析已取消（Cancelled）'

/** Task engine: a normalized plan never carries `auto`. */
export type TaskEngine = Exclude<ParseEngine, 'auto'>

/** The parse start request accepted by the manager. */
export type { ParsePlan, ParseRepairRequest, ParseStartRequest }

/** Configuration slice the manager reads. */
export type ParseManagerConfig = Pick<
  ResolvedConfig,
  'apiBase' | 'pollIntervalMs' | 'parseTimeoutMs' | 'maxConcurrentParses' | 'maxUploadBytes'
>

/** Dependencies of {@link createParseManager}. */
export interface CreateParseManagerOptions {
  /** On-disk library store. */
  store: StoreApi
  /** Resolved Host config (all parse limits). */
  config: ParseManagerConfig
  /** Host logger. */
  logger?: Logger
  /** Resolve the configured MinerU API token. */
  getToken?: () => Promise<string | undefined> | string | undefined
  /** Injected fetch implementation (defaults to `globalThis.fetch`). */
  fetchImpl?: MineruFetch
  /** Local (T0/T0.5) engine facade; absent profiles only allow cloud parses. */
  localEngine?: LocalEngine | null
  /**
   * Annotation re-anchor hook run after a successful (re)parse.
   *
   * Defaults to the shared {@link reanchorDocumentAnnotations} helper.
   */
  reanchor?: ReanchorHook
}

/** The manager facade; structurally extends the Lead-owned contract. */
export interface ParseManager extends ParseManagerApi {
  start: (id: string, request: ParseStartRequest) => Promise<DocumentMeta>
  cancel: (id: string) => Promise<DocumentMeta>
  resume: () => Promise<void>
  dispose: () => Promise<void>
}

/** One staged file to write under `parsed/`. */
interface StagedFile {
  rel: string
  data: Buffer
}

/** Live task state for one document. */
interface RuntimeTask {
  id: string
  engine: TaskEngine
  params: MineruParams
  resumeOnly: boolean
  controller: AbortController
  cancelled: boolean
  done: Promise<void>
  resolveDone: () => void
  promise: Promise<void> | null
  lastProgress: ParseProgress | null
  lastProgressAt: number
  remoteState: RemoteParseState
  repair?: RepairRuntimeState
}

/** Page-repair state captured when the repair task starts. */
interface RepairRuntimeState {
  targetPages: number[]
  previousParse: ParseState | null
  previousPages: number | null
}

/** Result description of one successful task. */
interface TaskSuccessResult {
  hasContentList: boolean
  pages: number | null
  title?: string
  progress?: ParseProgress | null
  provider?: string | null
  local?: LocalParseStats | null
  repair?: { pages: number[]; failedPages: number[] } | null
}

/** Outcome of one repair preparation. */
interface PreparedRepair {
  pages: number[]
  params: MineruParams
  previousParse: ParseState | null
  previousPages: number | null
}

/** Abort-shaped error recognised by the failure classifier. */
function abortError(): Error & { code: string } {
  const error = Object.assign(new Error(ABORTED_MESSAGE), { name: 'AbortError', code: 'aborted' })
  return error
}

/** Whether a thrown value represents cancellation. */
function isAbort(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const record = error as { name?: unknown; code?: unknown }
  return record.name === 'AbortError' || record.code === 'aborted'
}

/** Error message without trusting the thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

/** Abortable timeout sleep. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** First markdown heading (used as the default document title). */
function firstHeading(markdown: unknown): string | undefined {
  if (typeof markdown !== 'string') return undefined
  const match = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(markdown)
  if (match === null) return undefined
  const text = (match[1] ?? '')
    .replace(/[*_`~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text.slice(0, 300)
}

/** The title derived from the original file name (the "not renamed yet" value). */
function defaultTitleOf(meta: DocumentMeta): string {
  const original = typeof meta.originalName === 'string' ? meta.originalName : ''
  const ext = typeof meta.ext === 'string' ? meta.ext : ''
  const stem =
    ext !== '' && original.toLowerCase().endsWith(ext.toLowerCase())
      ? original.slice(0, original.length - ext.length)
      : original
  return stem.trim()
}

/** Page count implied by a content-list JSON text, or null. */
function pagesFromContentListText(text: string | null): number | null {
  if (typeof text !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    let maxPage = -1
    for (const item of parsed) {
      if (item !== null && typeof item === 'object') {
        const page = (item as { page_idx?: unknown }).page_idx
        if (typeof page === 'number' && Number.isInteger(page) && page >= 0 && page > maxPage) maxPage = page
      }
    }
    return maxPage >= 0 ? maxPage + 1 : null
  } catch {
    return null
  }
}

/** Join a parsed-relative path, refusing anything that could escape the root. */
function resolveWithin(baseDir: string, relativePath: string): string {
  const normalized = String(relativePath).replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new WireError('host-error', '解析结果包含非法路径（Unsafe path in parse result）', 500)
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new WireError('host-error', '解析结果包含非法路径（Unsafe path in parse result）', 500)
  }
  return join(baseDir, ...segments)
}

/** Whether an entry of the result ZIP should be extracted at all. */
function wantedEntry(name: string): boolean {
  if (name === 'full.md' || name.endsWith('/full.md')) return true
  if (name === 'content_list.json' || name.endsWith('_content_list.json')) return true
  if (name.startsWith('images/') && !name.endsWith('/')) return true
  return false
}

/** Read a string field from an unknown record. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a boolean field from an unknown record (undefined when absent). */
function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Project one normalized `.params` record onto the manager's task params. */
function taskParamsFromRecord(params: Record<string, unknown>): MineruParams {
  const taskParams: MineruParams = {
    fileName: readString(params, 'fileName') ?? '',
    language: readString(params, 'language') ?? 'ch',
  }
  const modelVersion = readString(params, 'modelVersion')
  if (modelVersion !== undefined) taskParams.modelVersion = modelVersion
  const pageRanges = readString(params, 'pageRanges')
  if (pageRanges !== undefined) taskParams.pageRanges = pageRanges
  const localProvider = readString(params, 'localProvider')
  if (localProvider !== undefined) taskParams.localProvider = localProvider
  const isOcr = readBoolean(params, 'isOcr')
  if (isOcr !== undefined) taskParams.isOcr = isOcr
  const enableFormula = readBoolean(params, 'enableFormula')
  if (enableFormula !== undefined) taskParams.enableFormula = enableFormula
  const enableTable = readBoolean(params, 'enableTable')
  if (enableTable !== undefined) taskParams.enableTable = enableTable
  const extraFormats = params.extraFormats
  if (Array.isArray(extraFormats)) {
    taskParams.extraFormats = extraFormats.filter((format): format is string => typeof format === 'string')
  }
  return taskParams
}

/** Reconstruct API params from persisted metadata (used by `resume()`). */
function paramsFromMeta(meta: DocumentMeta): MineruParams {
  const parse = meta.parse
  const options = parse?.options ?? null
  const params: MineruParams = {
    fileName:
      typeof meta.originalName === 'string' && meta.originalName !== ''
        ? meta.originalName
        : `source${typeof meta.ext === 'string' ? meta.ext : ''}`,
    language: typeof parse?.language === 'string' && parse.language !== '' ? parse.language : 'ch',
    isOcr: options?.isOcr === true,
    enableFormula: options?.enableFormula !== false,
    enableTable: options?.enableTable !== false,
    pageRanges: typeof options?.pageRanges === 'string' ? options.pageRanges : '',
  }
  if (parse?.engine === 'standard') {
    params.modelVersion = typeof parse.modelVersion === 'string' ? parse.modelVersion : 'vlm'
  }
  return params
}

/** Narrow a normalized plan engine to a task engine. */
function taskEngineOf(engine: ParseEngine): TaskEngine {
  if (engine === 'standard' || engine === 'agent' || engine === 'local') return engine
  throw new WireError('bad-request', 'engine 必须是 standard / agent / local（Invalid engine）', 400)
}

/** Whether a raw request record has the normalized-plan shape. */
function isPlanShape(record: Record<string, unknown>): boolean {
  const engine = record.engine
  const params = record.params
  return (
    (engine === 'standard' || engine === 'agent' || engine === 'local') &&
    params !== null &&
    typeof params === 'object' &&
    !Array.isArray(params)
  )
}

/** Whether a raw request record is a page-scoped repair request. */
function isRepairShape(record: Record<string, unknown>): boolean {
  return record.merge === true && !isPlanShape(record)
}

/** Project one raw repair request record onto the typed repair request. */
function repairRequestFromRecord(record: Record<string, unknown>): ParseRepairRequest {
  const request: ParseRepairRequest = { merge: true }
  const pages = record.pages
  if (Array.isArray(pages)) request.pages = pages.filter((page): page is number => typeof page === 'number')
  const modelVersion = record.modelVersion
  if (modelVersion === 'pipeline' || modelVersion === 'vlm') request.modelVersion = modelVersion
  const language = readString(record, 'language')
  if (language !== undefined) request.language = language
  const isOcr = readBoolean(record, 'isOcr')
  if (isOcr !== undefined) request.isOcr = isOcr
  const enableFormula = readBoolean(record, 'enableFormula')
  if (enableFormula !== undefined) request.enableFormula = enableFormula
  const enableTable = readBoolean(record, 'enableTable')
  if (enableTable !== undefined) request.enableTable = enableTable
  return request
}

/** Whether two annotation values differ in anchor-relevant fields. */
function anchorChanged(left: Annotation, right: Annotation): boolean {
  return (
    left.blockKey !== right.blockKey ||
    left.start !== right.start ||
    left.end !== right.end ||
    left.stale !== right.stale ||
    left.staleReason !== right.staleReason ||
    left.reanchored !== right.reanchored
  )
}

/**
 * Create the parse manager.
 *
 * @param options - store, config, logger, token accessor, injectable fetch,
 *   optional local engine and optional re-anchor hook.
 * @returns the manager facade.
 */
export function createParseManager(options: CreateParseManagerOptions): ParseManager {
  const { store, config, logger, getToken, fetchImpl, localEngine } = options
  if (store === undefined || store === null || typeof store.get !== 'function') {
    throw new TypeError('createParseManager: store is required')
  }
  if (config === undefined || config === null || typeof config !== 'object') {
    throw new TypeError('createParseManager: config is required')
  }
  const log: Logger = logger ?? {}
  const local = localEngine !== null && localEngine !== undefined && typeof localEngine.extract === 'function'
    ? localEngine
    : null
  const reanchorHook: ReanchorHook = typeof options.reanchor === 'function' ? options.reanchor : reanchorDocumentAnnotations
  const client: MineruClient = createMineruClient({
    getToken,
    apiBase: config.apiBase,
    fetchImpl,
    logger: log,
  })
  const maxConcurrent =
    typeof config.maxConcurrentParses === 'number' && Number.isInteger(config.maxConcurrentParses)
      ? config.maxConcurrentParses
      : 2
  const pollIntervalMs =
    typeof config.pollIntervalMs === 'number' && Number.isFinite(config.pollIntervalMs)
      ? Math.max(10, config.pollIntervalMs)
      : 3000
  const parseTimeoutMs =
    typeof config.parseTimeoutMs === 'number' && Number.isFinite(config.parseTimeoutMs)
      ? config.parseTimeoutMs
      : 30 * 60 * 1000

  /** Live tasks by document id. */
  const tasks = new Map<string, RuntimeTask>()
  /** Tasks waiting for a concurrency slot. */
  const waiting: RuntimeTask[] = []
  let active = 0
  let disposed = false
  let disposePromise: Promise<void> | undefined

  /** Throw when a task was cancelled. */
  function checkAborted(task: RuntimeTask): void {
    if (task.cancelled || task.controller.signal.aborted) throw abortError()
  }

  /** Persist one parse phase update (never throws). */
  async function persistPhase(task: RuntimeTask, patch: Partial<ParseState>): Promise<void> {
    try {
      await store.update(task.id, { parse: patch })
    } catch (error) {
      log.warn?.(`[dsh-litnotes] cannot persist parse phase for ${task.id}: ${errorMessage(error)}`)
    }
  }

  /**
   * Persist throttled progress; returns after the write completes (or is skipped).
   *
   * MinerU only reports `extract_progress` while a task is `running`, and the
   * pipeline model / OCR frequently report `extracted_pages: 0` for a long time
   * (queueing, model warm-up, whole-batch processing) before the counter moves.
   * Writing "0 / N" would make the client render a frozen 0 % bar, so a zero
   * extracted count is treated as "no page progress yet": the client shows an
   * indeterminate state with the elapsed time instead. Progress is also
   * monotonic — a late poll can never move the counter backwards.
   */
  async function persistProgress(task: RuntimeTask, progress: ParseProgress | null | undefined): Promise<void> {
    const extracted = Number(progress?.extracted)
    const total = Number(progress?.total)
    const extractedPages = Number.isFinite(extracted) && extracted > 0 ? Math.floor(extracted) : 0
    if (extractedPages === 0) return
    const totalPages = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
    const previous = task.lastProgress
    const next: ParseProgress = {
      extracted: previous === null ? extractedPages : Math.max(previous.extracted, extractedPages),
      total: previous === null ? totalPages : Math.max(previous.total, totalPages),
    }
    if (next.total < next.extracted) next.total = next.extracted
    if (previous !== null && previous.extracted === next.extracted && previous.total === next.total) return
    const now = Date.now()
    if (task.lastProgressAt !== 0 && now - task.lastProgressAt < PROGRESS_THROTTLE_MS) return
    task.lastProgress = next
    task.lastProgressAt = now
    try {
      await store.update(task.id, { parse: { progress: next } })
    } catch (error) {
      log.warn?.(`[dsh-litnotes] cannot persist progress for ${task.id}: ${errorMessage(error)}`)
    }
  }

  /**
   * Persist the upstream MinerU task state (`waiting-file` / `pending` /
   * `running` / `converting`, and the agent API's extra states) whenever it
   * changes. Terminal states are reflected by the document status and are not
   * persisted here.
   */
  async function persistRemoteState(task: RuntimeTask, state: unknown): Promise<void> {
    const next = typeof state === 'string' ? state.trim().toLowerCase() : ''
    if (next === '' || next === 'done' || next === 'failed' || next === task.remoteState) return
    task.remoteState = next as RemoteParseState
    await persistPhase(task, { remoteState: task.remoteState })
  }

  /** Validate one repair request and derive the page-ranged standard params. */
  async function prepareRepair(meta: DocumentMeta, request: ParseRepairRequest): Promise<PreparedRepair> {
    if (meta.status !== 'parsed') {
      throw new WireError(
        'repair-unavailable',
        '只有已解析的文档才能按页修复（Only parsed documents can be repaired page by page）',
        409,
      )
    }
    if (meta.parse?.engine === 'local') {
      throw new WireError(
        'repair-unavailable',
        '本地解析不支持按页修复；请整篇重新解析，或配置 Token 后整篇用云端解析（Page repair is unavailable for local parses; reparse the whole document）',
        409,
      )
    }
    let hasToken = false
    try {
      hasToken = Boolean(typeof getToken === 'function' ? await getToken() : undefined)
    } catch {
      hasToken = false
    }
    if (!hasToken) {
      throw new WireError('token-missing', '按页修复需要 MinerU Token（Page repair needs a MinerU token）', 422)
    }
    const parsed = await store.readMarkdown(meta.id)
    if (!Array.isArray(parsed.contentList) || parsed.contentList.length === 0) {
      throw new WireError(
        'repair-unavailable',
        '该文档缺少内容列表，无法按页修复，请整篇重新解析（No content list; reparse the whole document）',
        409,
      )
    }
    const requested = Array.isArray(request.pages)
      ? request.pages.map((page) => Math.floor(Number(page))).filter((page) => Number.isInteger(page) && page >= 1)
      : []
    let pages = [...new Set(requested)].sort((a, b) => a - b)
    if (pages.length === 0) pages = problemPages(parsed.contentList)
    if (pages.length === 0) {
      throw new WireError('repair-unavailable', '未检测到需要修复的页面（No pages to repair）', 409)
    }
    const params = paramsFromMeta(meta)
    params.pageRanges = toPageRanges(pages)
    if (typeof request.modelVersion === 'string') params.modelVersion = request.modelVersion
    if (typeof request.language === 'string' && request.language !== '') params.language = request.language
    if (typeof request.isOcr === 'boolean') params.isOcr = request.isOcr
    if (typeof request.enableFormula === 'boolean') params.enableFormula = request.enableFormula
    if (typeof request.enableTable === 'boolean') params.enableTable = request.enableTable
    if (params.modelVersion !== 'pipeline' && params.modelVersion !== 'vlm') params.modelVersion = 'vlm'
    return {
      pages,
      params,
      previousParse: meta.parse,
      previousPages:
        typeof meta.parse?.pages === 'number' && Number.isInteger(meta.parse.pages) && meta.parse.pages > 0
          ? meta.parse.pages
          : typeof parsed.pages === 'number' && Number.isInteger(parsed.pages) && parsed.pages > 0
            ? parsed.pages
            : null,
    }
  }

  /** Rebuild a repair task after a host restart from persisted metadata. */
  function repairTaskFromMeta(meta: DocumentMeta): RepairRuntimeState | null {
    const parse = meta.parse
    if (parse?.repairPages === undefined || parse.repairPages === null || parse.repairPages.length === 0) return null
    const restore = parse.repairRestore
    const previousParse =
      restore !== null && restore !== undefined && typeof restore === 'object'
        ? (restore as unknown as ParseState) // persisted 1.0.0 ParseState snapshot
        : null
    return {
      targetPages: parse.repairPages,
      previousParse,
      previousPages:
        typeof parse.repairPreviousPages === 'number' &&
        Number.isInteger(parse.repairPreviousPages) &&
        parse.repairPreviousPages > 0
          ? parse.repairPreviousPages
          : null,
    }
  }

  /** Build the small runtime task record. */
  function createTask(id: string, normalized: { engine: TaskEngine; params: MineruParams }): RuntimeTask {
    let resolveDone = (): void => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    return {
      id,
      engine: normalized.engine,
      params: normalized.params,
      resumeOnly: false,
      controller: new AbortController(),
      cancelled: false,
      done,
      resolveDone,
      promise: null,
      lastProgress: null,
      lastProgressAt: 0,
      remoteState: null,
    }
  }

  /** Queue a task for execution under the concurrency cap. */
  function enqueue(task: RuntimeTask): void {
    if (disposed) {
      task.resolveDone()
      return
    }
    if (active < maxConcurrent) launch(task)
    else waiting.push(task)
  }

  /** Start one task's job. */
  function launch(task: RuntimeTask): void {
    if (disposed || task.cancelled) {
      task.resolveDone()
      return
    }
    active += 1
    task.promise = (async () => {
      try {
        await runTask(task)
      } catch (error) {
        await finishFailure(task, error)
      }
    })()
    task.promise
      .catch(() => {})
      .finally(() => {
        active -= 1
        if (tasks.get(task.id) === task) tasks.delete(task.id)
        task.resolveDone()
        if (!disposed) drain()
      })
  }

  /** Fill free concurrency slots from the waiting queue. */
  function drain(): void {
    while (!disposed && active < maxConcurrent && waiting.length > 0) {
      const next = waiting.shift()
      if (next === undefined) continue
      if (next.cancelled) {
        next.resolveDone()
        continue
      }
      launch(next)
    }
  }

  /** Remove a queued (never started) task. */
  function removeWaiting(task: RuntimeTask): void {
    const index = waiting.indexOf(task)
    if (index >= 0) waiting.splice(index, 1)
  }

  /** Run one task to completion (success persists its own terminal state). */
  async function runTask(task: RuntimeTask): Promise<void> {
    if (task.resumeOnly) await resumeTask(task)
    else await executeTask(task)
  }

  /** Extract one document with the local engine into `parsed/` (never touches the network). */
  async function executeLocalTask(task: RuntimeTask): Promise<void> {
    if (local === null) {
      throw new WireError('local-missing-tool', '本地解析引擎不可用（Local parsing engine is unavailable）', 503)
    }
    const meta = store.get(task.id)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    const sourcePath = await store.sourcePath(task.id)
    checkAborted(task)
    await persistPhase(task, { phase: 'extracting' })
    const result = await local.extract({
      id: task.id,
      meta,
      sourcePath,
      params: { ...task.params },
      signal: task.controller.signal,
      onProgress: (progress) => {
        void persistProgress(task, progress)
      },
    })
    checkAborted(task)
    const markdown = typeof result.markdown === 'string' ? result.markdown : ''
    if (markdown.trim() === '') {
      throw new WireError('local-empty-text', '本地解析没有提取到文字（Local parsing extracted no text）', 422)
    }
    const files: StagedFile[] = [{ rel: 'full.md', data: Buffer.from(markdown, 'utf8') }]
    const contentList = Array.isArray(result.contentList) ? result.contentList : []
    if (contentList.length > 0) {
      files.push({ rel: 'content_list.json', data: Buffer.from(JSON.stringify(contentList, null, 2), 'utf8') })
    }
    await writeStagedParsed(task.id, files)
    const pageCount =
      typeof result.pages === 'number' && Number.isInteger(result.pages) && result.pages > 0 ? result.pages : null
    await finishSuccess(task, {
      hasContentList: contentList.length > 0,
      pages: pageCount,
      title: typeof result.title === 'string' && result.title !== '' ? result.title : firstHeading(markdown),
      progress: pageCount !== null ? { extracted: pageCount, total: pageCount } : null,
      provider: typeof result.provider === 'string' ? result.provider : null,
      local:
        result.stats !== undefined && result.stats !== null
          ? { ...result.stats, warnings: Array.isArray(result.warnings) ? result.warnings : [] }
          : null,
    })
  }

  /** Submit → upload → poll → download → extract for a fresh parse. */
  async function executeTask(task: RuntimeTask): Promise<void> {
    if (task.engine === 'local') {
      await executeLocalTask(task)
      return
    }
    const meta = store.get(task.id)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    const sourcePath = await store.sourcePath(task.id)
    const bytes = await readFile(sourcePath)
    checkAborted(task)

    if (task.engine === 'standard') {
      const created = await client.standardCreateBatch({
        fileName: task.params.fileName,
        dataId: task.id,
        options: { ...task.params },
        signal: task.controller.signal,
      })
      checkAborted(task)
      await persistPhase(task, { phase: 'uploading', batchId: created.batchId })
      await client.putBytes(created.uploadUrl, bytes, { signal: task.controller.signal })
      checkAborted(task)
      await persistPhase(task, { phase: 'polling', batchId: created.batchId })
      const outcome = await pollStandard(task, created.batchId)
      const zip = await client.downloadBytes(outcome.fullZipUrl, {
        maxBytes: ZIP_MAX_BYTES,
        signal: task.controller.signal,
      })
      checkAborted(task)
      const result = await applyStandardZip(task, zip)
      await finishSuccess(task, { ...result, progress: outcome.progress ?? task.lastProgress })
      return
    }

    const created = await client.agentCreateTask({
      fileName: task.params.fileName,
      options: { ...task.params },
      signal: task.controller.signal,
    })
    checkAborted(task)
    await persistPhase(task, { phase: 'uploading', taskId: created.taskId })
    await client.putBytes(created.uploadUrl, bytes, { signal: task.controller.signal })
    checkAborted(task)
    await persistPhase(task, { phase: 'polling', taskId: created.taskId })
    const outcome = await pollAgent(task, created.taskId)
    const markdown = await client.downloadBytes(outcome.markdownUrl, {
      maxBytes: MARKDOWN_MAX_BYTES,
      signal: task.controller.signal,
    })
    checkAborted(task)
    const result = await applyAgentMarkdown(task, markdown.toString('utf8'))
    await finishSuccess(task, { ...result, progress: outcome.progress ?? task.lastProgress })
  }

  /** Resume polling after a host restart (no re-upload). */
  async function resumeTask(task: RuntimeTask): Promise<void> {
    const meta = store.get(task.id)
    if (meta === undefined) return
    const parse = meta.parse
    if (task.engine === 'standard') {
      if (typeof parse?.batchId !== 'string' || parse.batchId === '') {
        throw new WireError('bad-request', '解析任务缺少 batchId（Missing batchId）', 400)
      }
      const outcome = await pollStandard(task, parse.batchId)
      const zip = await client.downloadBytes(outcome.fullZipUrl, {
        maxBytes: ZIP_MAX_BYTES,
        signal: task.controller.signal,
      })
      checkAborted(task)
      const result = await applyStandardZip(task, zip)
      await finishSuccess(task, { ...result, progress: outcome.progress ?? task.lastProgress })
      return
    }
    if (typeof parse?.taskId !== 'string' || parse.taskId === '') {
      throw new WireError('bad-request', '解析任务缺少 taskId（Missing taskId）', 400)
    }
    const outcome = await pollAgent(task, parse.taskId)
    const markdown = await client.downloadBytes(outcome.markdownUrl, {
      maxBytes: MARKDOWN_MAX_BYTES,
      signal: task.controller.signal,
    })
    checkAborted(task)
    const result = await applyAgentMarkdown(task, markdown.toString('utf8'))
    await finishSuccess(task, { ...result, progress: outcome.progress ?? task.lastProgress })
  }

  /** Match a batch row to this document. */
  function matchRow(results: StandardBatchRow[], task: RuntimeTask): StandardBatchRow | null {
    if (!Array.isArray(results) || results.length === 0) return null
    const byDataId = results.find((row) => row.dataId !== '' && row.dataId === task.id)
    if (byDataId !== undefined) return byDataId
    const byName = results.find((row) => row.fileName !== '' && row.fileName === task.params.fileName)
    if (byName !== undefined) return byName
    return results.length === 1 ? (results[0] ?? null) : null
  }

  /** Poll the standard batch endpoint until done / failed / timeout / cancel. */
  async function pollStandard(
    task: RuntimeTask,
    batchId: string,
  ): Promise<{ fullZipUrl: string; progress: ParseProgress | null }> {
    const deadline = Date.now() + parseTimeoutMs
    let failures = 0
    for (;;) {
      checkAborted(task)
      if (Date.now() > deadline) throw timeoutError()
      let snapshot
      try {
        snapshot = await client.standardBatchResult(batchId, { signal: task.controller.signal })
      } catch (error) {
        if (isAbort(error) || task.cancelled) throw error
        failures += 1
        if (failures >= MAX_POLL_FAILURES) throw error
        log.warn?.(`[dsh-litnotes] poll failure ${failures} for ${task.id}: ${describeMineruError(error)}`)
        await sleep(pollIntervalMs, task.controller.signal)
        continue
      }
      failures = 0
      const row = matchRow(snapshot.results, task)
      if (row !== null) {
        await persistRemoteState(task, row.state)
        if (row.progress !== null && row.progress !== undefined) await persistProgress(task, row.progress)
        if (row.state === 'done') {
          if (typeof row.fullZipUrl !== 'string' || row.fullZipUrl === '') {
            throw new WireError('host-error', '解析结果缺少下载地址（Missing result ZIP URL）', 500)
          }
          return { fullZipUrl: row.fullZipUrl, progress: row.progress ?? task.lastProgress }
        }
        if (row.state === 'failed') {
          throw failureFromApi(undefined, row.errMsg || 'MinerU 解析失败（Parse failed）')
        }
      }
      await sleep(pollIntervalMs, task.controller.signal)
    }
  }

  /** Poll the agent task endpoint until done / failed / timeout / cancel. */
  async function pollAgent(
    task: RuntimeTask,
    taskId: string,
  ): Promise<{ markdownUrl: string; progress: ParseProgress | null }> {
    const deadline = Date.now() + parseTimeoutMs
    let failures = 0
    for (;;) {
      checkAborted(task)
      if (Date.now() > deadline) throw timeoutError()
      let outcome
      try {
        outcome = await client.agentTaskResult(taskId, { signal: task.controller.signal })
      } catch (error) {
        if (isAbort(error) || task.cancelled) throw error
        failures += 1
        if (failures >= MAX_POLL_FAILURES) throw error
        log.warn?.(`[dsh-litnotes] agent poll failure ${failures} for ${task.id}: ${describeMineruError(error)}`)
        await sleep(pollIntervalMs, task.controller.signal)
        continue
      }
      failures = 0
      await persistRemoteState(task, outcome.state)
      if (outcome.progress !== null && outcome.progress !== undefined) {
        await persistProgress(task, outcome.progress)
      }
      if (outcome.state === 'done') {
        if (typeof outcome.markdownUrl !== 'string' || outcome.markdownUrl === '') {
          throw new WireError('host-error', '解析结果缺少 Markdown 地址（Missing markdown URL）', 500)
        }
        return { markdownUrl: outcome.markdownUrl, progress: outcome.progress ?? task.lastProgress }
      }
      if (outcome.state === 'failed') {
        throw failureFromApi(outcome.errCode, outcome.errMsg || 'MinerU 解析失败（Parse failed）')
      }
      await sleep(pollIntervalMs, task.controller.signal)
    }
  }

  /**
   * Final progress record for a parsed document: a terminal poll that still
   * reports `extracted_pages: 0` must not overwrite real progress with a fake
   * 0 % record (fall back to the last positive progress the polls persisted).
   */
  function finalProgress(task: RuntimeTask, progress: ParseProgress | null | undefined): ParseProgress | null {
    const extracted = Number(progress?.extracted)
    if (Number.isFinite(extracted) && extracted > 0) {
      return { extracted, total: Math.max(extracted, Number(progress?.total) || 0) }
    }
    return task.lastProgress
  }

  /** Write the staging parse directory then atomically swap it into `parsed/`. */
  async function writeStagedParsed(id: string, files: StagedFile[]): Promise<void> {
    const docDir = store.docDir(id)
    const parsedDir = join(docDir, PARSED_DIR_NAME)
    const staging = join(docDir, `.parsed-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    try {
      for (const file of files) {
        const target = resolveWithin(staging, file.rel)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.data)
      }
      await rm(parsedDir, { recursive: true, force: true })
      await rename(staging, parsedDir)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /** Extract a standard result ZIP into `parsed/` and describe it. */
  async function applyStandardZip(task: RuntimeTask, zipBuffer: Buffer): Promise<TaskSuccessResult> {
    const extracted = unzip(zipBuffer, { filter: wantedEntry })
    let markdown: string | null = null
    let contentListText: string | null = null
    let hasContentList = false
    const files: StagedFile[] = []
    for (const entry of extracted.entries) {
      if (entry.name === 'full.md' || entry.name.endsWith('/full.md')) {
        if (markdown !== null) continue
        markdown = entry.data.toString('utf8')
        files.push({ rel: 'full.md', data: entry.data })
      } else if (entry.name === 'content_list.json' || entry.name.endsWith('_content_list.json')) {
        if (hasContentList) continue
        hasContentList = true
        contentListText = entry.data.toString('utf8')
        files.push({ rel: basename(entry.name), data: entry.data })
      } else if (entry.name.startsWith('images/')) {
        files.push({ rel: entry.name, data: entry.data })
      }
    }
    if (markdown === null) {
      throw new WireError('host-error', '解析结果缺少 full.md（Parse result is missing full.md）', 500)
    }
    if (task.repair !== undefined) {
      return applyRepairZip(task, {
        markdown,
        contentListText,
        imageFiles: files.filter((file) => file.rel.startsWith('images/')),
      })
    }
    const pages = pagesFromContentListText(contentListText) ?? task.lastProgress?.total ?? null
    await writeStagedParsed(task.id, files)
    return { hasContentList, pages, title: firstHeading(markdown) }
  }

  /** Parse the repaired archive's content list and splice its pages into the old parse. */
  async function applyRepairZip(
    task: RuntimeTask,
    input: { markdown: string; contentListText: string | null; imageFiles: StagedFile[] },
  ): Promise<TaskSuccessResult> {
    const repair = task.repair
    if (repair === undefined) throw new WireError('host-error', '缺少修复状态（Missing repair state）', 500)
    let newContentList: ContentListEntry[] | null = null
    if (typeof input.contentListText === 'string' && input.contentListText.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(input.contentListText)
        if (Array.isArray(parsed)) newContentList = parsed as ContentListEntry[]
        else if (parsed !== null && typeof parsed === 'object') {
          const nested = (parsed as { content_list?: unknown }).content_list
          if (Array.isArray(nested)) newContentList = nested as ContentListEntry[]
        }
      } catch {
        newContentList = null
      }
    }
    if (!Array.isArray(newContentList) || newContentList.length === 0) {
      throw new WireError(
        'repair-unavailable',
        '修复结果缺少内容列表，无法对齐页面；请整篇重新解析（Repair result has no content list）',
        409,
      )
    }
    const previous: ParsedDocument = await store.readMarkdown(task.id)
    if (!Array.isArray(previous.contentList) || previous.contentList.length === 0) {
      throw new WireError(
        'repair-unavailable',
        '原解析稿缺少内容列表，无法按页修复（Original parse has no content list）',
        409,
      )
    }
    const merged = mergeRepairedPages({
      oldMarkdown: previous.markdown,
      oldContentList: previous.contentList,
      newMarkdown: input.markdown,
      newContentList,
      targetPages: repair.targetPages,
    })
    if (merged.replacedPages.length === 0) {
      throw new WireError(
        'repair-unavailable',
        '修复结果无法与原文对齐，请整篇重新解析（Repair result could not be aligned）',
        409,
      )
    }
    if (merged.failedPages.length > 0) {
      log.warn?.(`[dsh-litnotes] repair could not align pages ${merged.failedPages.join(',')} for ${task.id}`)
    }
    await writeStagedRepair(task.id, merged, input.imageFiles)
    return {
      hasContentList: true,
      pages: repair.previousPages ?? previous.pages ?? null,
      title: firstHeading(merged.markdown),
      repair: { pages: merged.replacedPages, failedPages: merged.failedPages },
    }
  }

  /** Write the spliced markdown/CL/images over the existing parsed directory atomically. */
  async function writeStagedRepair(
    id: string,
    merged: { markdown: string; contentList: ContentListEntry[] },
    imageFiles: StagedFile[],
  ): Promise<void> {
    const docDir = store.docDir(id)
    const parsedDir = join(docDir, PARSED_DIR_NAME)
    const staging = join(docDir, `.parsed-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    try {
      // Keep every old artifact (images, extra files) and overwrite the outputs.
      await cp(parsedDir, staging, { recursive: true, force: true })
      const names = await readdir(staging)
      for (const name of names) {
        if (name === 'content_list.json' || name.endsWith('_content_list.json')) {
          await rm(join(staging, name), { force: true })
        }
      }
      await writeFile(join(staging, 'full.md'), merged.markdown)
      await writeFile(join(staging, 'content_list.json'), JSON.stringify(merged.contentList, null, 2))
      for (const file of imageFiles) {
        const target = resolveWithin(staging, file.rel)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.data)
      }
      await rm(parsedDir, { recursive: true, force: true })
      await rename(staging, parsedDir)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /** Write the agent markdown result into `parsed/full.md` and describe it. */
  async function applyAgentMarkdown(task: RuntimeTask, markdown: string): Promise<TaskSuccessResult> {
    const text = typeof markdown === 'string' ? markdown : ''
    if (text.trim() === '') {
      throw new WireError('host-error', 'MinerU 返回了空的 Markdown（Empty markdown result）', 500)
    }
    await writeStagedParsed(task.id, [{ rel: 'full.md', data: Buffer.from(text, 'utf8') }])
    return {
      hasContentList: false,
      pages: task.lastProgress?.total ?? null,
      title: firstHeading(text),
    }
  }

  /**
   * Re-anchor existing annotations against the freshly written parse. Best
   * effort: a parse must never fail because an annotation could not be moved.
   */
  async function reanchorAfterParse(task: RuntimeTask): Promise<void> {
    try {
      const parsed = await store.readMarkdown(task.id)
      const current = await store.loadAnnotations(task.id)
      const items = Array.isArray(current.items) ? current.items : []
      if (items.length === 0) return
      const next = await reanchorHook({
        documentId: task.id,
        annotations: items,
        markdown: parsed.markdown,
        contentList: parsed.contentList,
      })
      if (!Array.isArray(next) || next.length !== items.length) return
      let changed = false
      let reanchored = 0
      let stale = 0
      for (let index = 0; index < next.length; index += 1) {
        const before = items[index]
        const after = next[index]
        if (before === undefined || after === undefined) continue
        if (anchorChanged(before, after)) changed = true
        if (after.reanchored === true) reanchored += 1
        if (after.stale === true) stale += 1
      }
      if (changed) {
        await store.saveAnnotations(task.id, { items: next })
        log.info?.(
          `[dsh-litnotes] after reparse of ${task.id}: ${reanchored} annotations re-anchored, ${stale} stale`,
        )
      }
    } catch (error) {
      log.warn?.(`[dsh-litnotes] annotation re-anchor failed for ${task.id}: ${errorMessage(error)}`)
    }
  }

  /**
   * Persist the terminal success state (and adopt the first heading as title).
   *
   * Annotations are re-anchored and persisted BEFORE the terminal
   * `status:'parsed'` write, so a poller that observes `parsed` can never read
   * stale annotation anchors/`stale` flags (regression guard).
   */
  async function finishSuccess(task: RuntimeTask, result: TaskSuccessResult): Promise<void> {
    const current = store.get(task.id)
    if (current === undefined) return
    if (task.repair !== undefined) {
      const repair = task.repair
      const previous: Partial<ParseState> = repair.previousParse ?? {}
      const repairedPages =
        typeof repair.previousPages === 'number' && Number.isInteger(repair.previousPages) && repair.previousPages > 0
          ? repair.previousPages
          : typeof previous.pages === 'number' && Number.isInteger(previous.pages)
            ? previous.pages
            : null
      await reanchorAfterParse(task)
      try {
        await store.update(task.id, {
          status: 'parsed',
          error: null,
          parse: {
            ...previous,
            phase: null,
            remoteState: null,
            taskId: null,
            batchId: null,
            progress: null,
            finishedAt: new Date().toISOString(),
            pages: repairedPages,
            hasContentList: true,
            repairPages: null,
            repairRestore: null,
            repairPreviousPages: null,
            repair: result.repair ?? null,
            repairError: null,
          },
        })
        log.info?.(`[dsh-litnotes] repaired pages [${(result.repair?.pages ?? []).join(',')}] for ${task.id}`)
      } catch (error) {
        log.warn?.(`[dsh-litnotes] cannot persist repaired state for ${task.id}: ${errorMessage(error)}`)
      }
      return
    }
    const patch: Partial<Omit<DocumentMeta, 'parse'>> & { parse: Partial<ParseState> } = {
      status: 'parsed',
      error: null,
      parse: {
        phase: null,
        remoteState: null,
        provider: typeof result.provider === 'string' && result.provider !== '' ? result.provider : null,
        local: result.local ?? null,
        finishedAt: new Date().toISOString(),
        pages: typeof result.pages === 'number' && Number.isInteger(result.pages) && result.pages > 0 ? result.pages : null,
        hasContentList: result.hasContentList === true,
        progress: finalProgress(task, result.progress) ?? null,
      },
    }
    const derived = typeof result.title === 'string' ? result.title.trim() : ''
    if (derived !== '' && current.title === defaultTitleOf(current)) patch.title = derived.slice(0, 300)
    await reanchorAfterParse(task)
    try {
      await store.update(task.id, patch)
      log.info?.(`[dsh-litnotes] parsed ${task.id} (${task.engine})`)
    } catch (error) {
      log.warn?.(`[dsh-litnotes] cannot persist parsed state for ${task.id}: ${errorMessage(error)}`)
    }
  }

  /** Persist the terminal failure/cancelled state. */
  async function finishFailure(task: RuntimeTask, error: unknown): Promise<void> {
    if (store.get(task.id) === undefined) return
    const cancelled = task.cancelled || task.controller.signal.aborted || isAbort(error)
    if (task.repair !== undefined) {
      const previous: Partial<ParseState> = task.repair.previousParse ?? {}
      const message = cancelled ? null : describeMineruError(error)
      if (message !== null) log.warn?.(`[dsh-litnotes] page repair failed for ${task.id}: ${message}`)
      try {
        await store.update(task.id, {
          status: 'parsed',
          error: null,
          parse: {
            ...previous,
            phase: null,
            remoteState: null,
            taskId: null,
            batchId: null,
            progress: null,
            finishedAt: new Date().toISOString(),
            repairPages: null,
            repairRestore: null,
            repairPreviousPages: null,
            repairError: message,
          },
        })
      } catch (persistError) {
        log.warn?.(`[dsh-litnotes] cannot persist repair failure for ${task.id}: ${errorMessage(persistError)}`)
      }
      return
    }
    try {
      if (cancelled) {
        await store.update(task.id, {
          status: 'uploaded',
          error: null,
          parse: {
            phase: null,
            remoteState: null,
            finishedAt: new Date().toISOString(),
            taskId: null,
            batchId: null,
            progress: null,
          },
        })
        return
      }
      const message = describeMineruError(error)
      log.warn?.(`[dsh-litnotes] parse failed for ${task.id}: ${message}`)
      await store.update(task.id, {
        status: 'failed',
        error: message,
        parse: { phase: null, remoteState: null, finishedAt: new Date().toISOString() },
      })
    } catch (persistError) {
      log.warn?.(`[dsh-litnotes] cannot persist failure state for ${task.id}: ${errorMessage(persistError)}`)
    }
  }

  /**
   * Start parsing one document. The caller validates user-facing preconditions
   * (see `service.startParse` / `normalizeParseOptions`); a normalized
   * `{ engine, params }` object, a page-repair request or raw client options are
   * all accepted.
   *
   * @param id - document id.
   * @param request - normalized plan, repair request or raw client options.
   * @returns the document metadata with status `parsing`.
   */
  async function start(id: string, request: ParseStartRequest): Promise<DocumentMeta> {
    if (disposed) throw new WireError('host-error', '插件正在卸载（Host is shutting down）', 500)
    await store.init()
    const docId = requireUuid(id)
    const meta = store.get(docId)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    if (tasks.has(docId)) {
      throw new WireError('conflict', '该文档已有解析任务在进行中（A parse is already running）', 409)
    }
    const requestRecord = request as unknown as Record<string, unknown>
    let normalized: { engine: TaskEngine; params: MineruParams }
    let repair: PreparedRepair | null = null
    if (isRepairShape(requestRecord)) {
      repair = await prepareRepair(meta, repairRequestFromRecord(requestRecord))
      normalized = { engine: 'standard', params: repair.params }
    } else if (isPlanShape(requestRecord)) {
      const params = requestRecord.params
      normalized = {
        engine: taskEngineOf(requestRecord.engine as ParseEngine),
        params: taskParamsFromRecord(params as Record<string, unknown>),
      }
    } else {
      // Raw client options (frozen manager compatibility path): resolve them
      // exactly like the service does before starting a task.
      let hasToken = false
      try {
        hasToken = Boolean(typeof getToken === 'function' ? await getToken() : undefined)
      } catch {
        hasToken = false
      }
      let localSupport: { supported: boolean; reason?: string } = {
        supported: false,
        reason: 'local engine unavailable',
      }
      if (local !== null && typeof local.supports === 'function') {
        try {
          localSupport = local.supports(meta) ?? localSupport
        } catch {
          /* treat as unsupported */
        }
      }
      const plan: NormalizedParsePlan = normalizeParseOptions(requestRecord, meta, {
        hasToken,
        maxUploadBytes: config.maxUploadBytes,
        localSupported: localSupport.supported === true,
        localReason: localSupport.reason,
        localMaxBytes: local?.config.maxPdfBytes ?? 0,
        autoAllowAgentFallback: true,
      })
      normalized = { engine: taskEngineOf(plan.engine), params: plan.params }
    }
    const isLocal = normalized.engine === 'local'
    const parseState: Partial<ParseState> = {
      engine: normalized.engine,
      provider: null,
      local: null,
      // 'MinerU-HTML' is an internal model id; ParseState only carries vlm/pipeline.
      modelVersion: isLocal ? null : ((normalized.params.modelVersion ?? null) as ModelVersion | null),
      language: normalized.params.language ?? 'ch',
      options: isLocal
        ? { isOcr: false, enableFormula: false, enableTable: false, pageRanges: '' }
        : {
            isOcr: normalized.params.isOcr === true,
            enableFormula: normalized.params.enableFormula !== false,
            enableTable: normalized.params.enableTable !== false,
            pageRanges: normalized.params.pageRanges ?? '',
          },
      phase: isLocal ? 'extracting' : 'submitting',
      remoteState: null,
      taskId: null,
      batchId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: repair !== null ? repair.previousPages : null,
      progress: null,
      hasContentList: repair !== null,
    }
    if (repair !== null) {
      parseState.repairPages = repair.pages
      parseState.repairRestore = repair.previousParse !== null ? { ...repair.previousParse } : null
      parseState.repairPreviousPages = repair.previousPages
    }
    const updated = await store.update(docId, { status: 'parsing', error: null, parse: parseState })
    const task = createTask(docId, normalized)
    if (repair !== null) {
      task.repair = {
        targetPages: repair.pages,
        previousParse: repair.previousParse,
        previousPages: repair.previousPages,
      }
    }
    tasks.set(docId, task)
    enqueue(task)
    return store.get(docId) ?? updated
  }

  /**
   * Cancel the document's parse task: abort the network work and return the
   * document to `status:'uploaded'` (or restore the previous parse for a
   * page repair) with its source kept.
   *
   * @param id - document id.
   * @returns the updated document metadata.
   */
  async function cancel(id: string): Promise<DocumentMeta> {
    await store.init()
    const docId = requireUuid(id)
    const meta = store.get(docId)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    if (meta.status !== 'parsing') {
      throw new WireError('bad-request', '没有正在进行的解析任务（No parse is in progress）', 409)
    }
    const task = tasks.get(docId)
    if (task !== undefined) {
      task.cancelled = true
      task.controller.abort()
      if (task.promise === null) {
        removeWaiting(task)
        tasks.delete(docId)
        task.resolveDone()
      }
    }
    if (task !== undefined && task.repair !== undefined) {
      const previous: Partial<ParseState> = task.repair.previousParse ?? {}
      return store.update(docId, {
        status: 'parsed',
        error: null,
        parse: {
          ...previous,
          phase: null,
          remoteState: null,
          taskId: null,
          batchId: null,
          progress: null,
          finishedAt: new Date().toISOString(),
          repairPages: null,
          repairRestore: null,
          repairPreviousPages: null,
          repairError: null,
        },
      })
    }
    return store.update(docId, {
      status: 'uploaded',
      error: null,
      parse: {
        phase: null,
        remoteState: null,
        taskId: null,
        batchId: null,
        progress: null,
        finishedAt: new Date().toISOString(),
      },
    })
  }

  /**
   * Resume interrupted parses after a host restart: polling-phase tasks restart
   * their poll loop from the persisted batch/task id; every other interrupted
   * phase is marked failed with a retry hint.
   *
   * @returns resolves once resumable tasks are scheduled.
   */
  async function resume(): Promise<void> {
    await store.init()
    if (disposed) return
    for (const meta of store.list()) {
      if (meta.status !== 'parsing' || tasks.has(meta.id)) continue
      const parse = meta.parse
      const engine: TaskEngine | null =
        parse?.engine === 'standard' ? 'standard' : parse?.engine === 'agent' ? 'agent' : null
      const repair = repairTaskFromMeta(meta)
      const resumable =
        parse?.phase === 'polling' &&
        engine !== null &&
        ((engine === 'standard' && typeof parse.batchId === 'string' && parse.batchId !== '') ||
          (engine === 'agent' && typeof parse.taskId === 'string' && parse.taskId !== ''))
      if (!resumable) {
        try {
          if (repair !== null) {
            const previous: Partial<ParseState> = repair.previousParse ?? {}
            await store.update(meta.id, {
              status: 'parsed',
              error: null,
              parse: {
                ...previous,
                phase: null,
                remoteState: null,
                taskId: null,
                batchId: null,
                progress: null,
                finishedAt: new Date().toISOString(),
                repairPages: null,
                repairRestore: null,
                repairPreviousPages: null,
                repairError: '按页修复被中断，请重试（Page repair was interrupted）',
              },
            })
            continue
          }
          await store.update(meta.id, {
            status: 'failed',
            error: '解析被中断，请重试（Parse interrupted, please retry）',
            parse: { phase: null, remoteState: null, finishedAt: new Date().toISOString() },
          })
        } catch (error) {
          log.warn?.(`[dsh-litnotes] cannot mark interrupted parse ${meta.id}: ${errorMessage(error)}`)
        }
        continue
      }
      if (engine === null) continue
      const task = createTask(meta.id, { engine, params: paramsFromMeta(meta) })
      if (repair !== null) task.repair = repair
      // Seed the last persisted page count so the first poll after a host
      // restart can never move the client-visible progress backwards.
      const persistedProgress = parse.progress
      if (persistedProgress !== null && persistedProgress !== undefined && typeof persistedProgress === 'object') {
        const extracted = Number(persistedProgress.extracted)
        const total = Number(persistedProgress.total)
        if (Number.isFinite(extracted) && extracted > 0) {
          task.lastProgress = {
            extracted: Math.floor(extracted),
            total: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
          }
        }
      }
      task.resumeOnly = true
      tasks.set(meta.id, task)
      log.info?.(`[dsh-litnotes] resuming ${engine} parse for ${meta.id}`)
      enqueue(task)
    }
  }

  /**
   * Abort every task and wait for their promises to settle. Idempotent.
   *
   * @returns resolves after all task work quiesced.
   */
  function dispose(): Promise<void> {
    if (disposePromise !== undefined) return disposePromise
    disposePromise = (async () => {
      disposed = true
      const all = [...tasks.values()]
      waiting.length = 0
      for (const task of all) {
        task.cancelled = true
        task.controller.abort()
      }
      for (const task of all) {
        if (task.promise === null) task.resolveDone()
      }
      await Promise.allSettled(all.map((task) => task.done))
    })()
    return disposePromise
  }

  return { start, cancel, resume, dispose }
}

/** Timeout failure used when a parse exceeds `parseTimeoutMs`. */
function timeoutError(): MineruError {
  return new MineruError('timeout', '解析超时，请重试（Parse timed out）', 0)
}
