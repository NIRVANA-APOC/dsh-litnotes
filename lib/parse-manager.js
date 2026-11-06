/**
 * Asynchronous MinerU parse task manager for dsh-litnotes.
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
 * @module lib/parse-manager
 */
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  MineruError,
  createMineruClient,
  describeMineruError,
  failureFromApi,
  normalizeParseOptions,
} from './mineru.js'
import { WireError, requireUuid } from './wire.js'
import { unzip } from './unzip.js'
import { mergeRepairedPages, problemPages, toPageRanges } from './page-merge.js'

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

/** An abort-shaped error recognised by the failure classifier. */
function abortError() {
  const error = new Error(ABORTED_MESSAGE)
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}

/** Whether a thrown value represents cancellation. */
function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'aborted'
}

/** Abortable timeout sleep. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** First markdown heading (used as the default document title). */
function firstHeading(markdown) {
  if (typeof markdown !== 'string') return undefined
  const match = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(markdown)
  if (match === null) return undefined
  const text = match[1]
    .replace(/[*_`~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text.slice(0, 300)
}

/** The title derived from the original file name (the "not renamed yet" value). */
function defaultTitleOf(meta) {
  const original = typeof meta.originalName === 'string' ? meta.originalName : ''
  const ext = typeof meta.ext === 'string' ? meta.ext : ''
  const stem =
    ext !== '' && original.toLowerCase().endsWith(ext.toLowerCase())
      ? original.slice(0, original.length - ext.length)
      : original
  return stem.trim()
}

/** Page count implied by a content list JSON text, or null. */
function pagesFromContentListText(text) {
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    let maxPage = -1
    for (const item of parsed) {
      if (item !== null && typeof item === 'object') {
        const page = item.page_idx
        if (typeof page === 'number' && Number.isInteger(page) && page >= 0 && page > maxPage) maxPage = page
      }
    }
    return maxPage >= 0 ? maxPage + 1 : null
  } catch {
    return null
  }
}

/** Join a parsed-relative path, refusing anything that could escape the root. */
function resolveWithin(baseDir, relativePath) {
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
function wantedEntry(name) {
  if (name === 'full.md' || name.endsWith('/full.md')) return true
  if (name === 'content_list.json' || name.endsWith('_content_list.json')) return true
  if (name.startsWith('images/') && !name.endsWith('/')) return true
  return false
}

/**
 * Create the parse manager.
 *
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   config: { apiBase: string, pollIntervalMs: number, parseTimeoutMs: number,
 *             maxConcurrentParses: number, maxUploadBytes: number },
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   getToken?: () => Promise<string | undefined> | string | undefined,
 *   fetchImpl?: typeof fetch,
 * }} options - store, resolved config, logger, token accessor and injectable fetch.
 * @returns {{
 *   start(id: string, options?: object): Promise<Record<string, any>>,
 *   cancel(id: string): Promise<Record<string, any>>,
 *   resume(): Promise<void>,
 *   dispose(): Promise<void>,
 * }} the manager facade.
 */
export function createParseManager({ store, config, logger, getToken, fetchImpl } = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('createParseManager: store is required')
  if (!config || typeof config !== 'object') throw new TypeError('createParseManager: config is required')
  const log = logger ?? {}
  const client = createMineruClient({
    getToken,
    apiBase: config.apiBase,
    fetchImpl,
    logger: log,
  })
  const maxConcurrent = Number.isInteger(config.maxConcurrentParses) ? config.maxConcurrentParses : 2
  const pollIntervalMs = Number.isFinite(config.pollIntervalMs) ? Math.max(10, config.pollIntervalMs) : 3000
  const parseTimeoutMs = Number.isFinite(config.parseTimeoutMs) ? config.parseTimeoutMs : 30 * 60 * 1000

  /** @type {Map<string, any>} live tasks by document id */
  const tasks = new Map()
  /** @type {any[]} tasks waiting for a concurrency slot */
  const waiting = []
  let active = 0
  let disposed = false
  let disposePromise

  /** Throw when a task was cancelled. */
  function checkAborted(task) {
    if (task.cancelled || task.controller.signal.aborted) throw abortError()
  }

  /** Persist one parse phase update (never throws). */
  async function persistPhase(task, patch) {
    try {
      await store.update(task.id, { parse: patch })
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot persist parse phase for %s: %s', task.id, error?.message ?? error)
    }
  }

  /**
   * Persist throttled progress; returns after the write completes (or is skipped).
   *
   * MinerU only reports `extract_progress` while a task is `running`, and the
   * pipeline model / OCR frequently report `extracted_pages: 0` for a long
   * time (queueing, model warm-up, whole-batch processing) before the counter
   * moves. Writing "0 / N" would make the client render a frozen 0 % bar, so
   * a zero extracted count is treated as "no page progress yet": the client
   * shows an indeterminate state with the elapsed time instead. Progress is
   * also monotonic — a late poll can never move the counter backwards.
   */
  async function persistProgress(task, progress) {
    const extracted = Number(progress?.extracted)
    const total = Number(progress?.total)
    const extractedPages = Number.isFinite(extracted) && extracted > 0 ? Math.floor(extracted) : 0
    if (extractedPages === 0) return
    const totalPages = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
    const previous = task.lastProgress
    const next = {
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
      log.warn?.('[dsh-litnotes] cannot persist progress for %s: %s', task.id, error?.message ?? error)
    }
  }

  /**
   * Persist the upstream MinerU task state (`waiting-file` / `pending` /
   * `running` / `converting`, and the agent API's extra states) whenever it
   * changes, so the client can say what MinerU is actually doing instead of
   * showing a stagnant progress bar. Terminal states are reflected by the
   * document's own status and are not persisted here.
   */
  async function persistRemoteState(task, state) {
    const next = typeof state === 'string' ? state.trim().toLowerCase() : ''
    if (next === '' || next === 'done' || next === 'failed' || next === task.remoteState) return
    task.remoteState = next
    await persistPhase(task, { remoteState: next })
  }

  /** Validate one repair request and derive the page-ranged standard params. */
  async function prepareRepair(meta, options) {
    if (meta.status !== 'parsed') {
      throw new WireError('repair-unavailable', '只有已解析的文档才能按页修复（Only parsed documents can be repaired page by page）', 409)
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
      throw new WireError('repair-unavailable', '该文档缺少内容列表，无法按页修复，请整篇重新解析（No content list; reparse the whole document）', 409)
    }
    const requested = Array.isArray(options.pages)
      ? options.pages.map((page) => Math.floor(Number(page))).filter((page) => Number.isInteger(page) && page >= 1)
      : []
    let pages = [...new Set(requested)].sort((a, b) => a - b)
    if (pages.length === 0) pages = problemPages(parsed.contentList)
    if (pages.length === 0) {
      throw new WireError('repair-unavailable', '未检测到需要修复的页面（No pages to repair）', 409)
    }
    const base = paramsFromMeta(meta)
    const params = { ...base, pageRanges: toPageRanges(pages) }
    if (typeof options.modelVersion === 'string' && options.modelVersion !== '') params.modelVersion = options.modelVersion
    if (typeof options.language === 'string' && options.language !== '') params.language = options.language
    if (typeof options.isOcr === 'boolean') params.isOcr = options.isOcr
    if (typeof options.enableFormula === 'boolean') params.enableFormula = options.enableFormula
    if (typeof options.enableTable === 'boolean') params.enableTable = options.enableTable
    if (params.modelVersion !== 'pipeline' && params.modelVersion !== 'vlm') params.modelVersion = 'vlm'
    return {
      pages,
      params,
      previousParse: meta.parse ?? null,
      previousPages: Number.isInteger(meta.parse?.pages) && meta.parse.pages > 0
        ? meta.parse.pages
        : (Number.isInteger(parsed.pages) && parsed.pages > 0 ? parsed.pages : null),
    }
  }

  /** Rebuild a repair task after a host restart from persisted metadata. */
  function repairTaskFromMeta(meta) {
    const parse = meta.parse ?? {}
    if (!Array.isArray(parse.repairPages) || parse.repairPages.length === 0) return null
    return {
      targetPages: parse.repairPages,
      previousParse: parse.repairRestore && typeof parse.repairRestore === 'object' ? parse.repairRestore : null,
      previousPages: Number.isInteger(parse.repairPreviousPages) && parse.repairPreviousPages > 0
        ? parse.repairPreviousPages
        : null,
    }
  }

  /** Build the small runtime task record. */
  function createTask(id, normalized) {
    let resolveDone
    const done = new Promise((resolve) => {
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
  function enqueue(task) {
    if (disposed) {
      task.resolveDone()
      return
    }
    if (active < maxConcurrent) launch(task)
    else waiting.push(task)
  }

  /** Start one task's job. */
  function launch(task) {
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
  function drain() {
    while (!disposed && active < maxConcurrent && waiting.length > 0) {
      const next = waiting.shift()
      if (next.cancelled) {
        next.resolveDone()
        continue
      }
      launch(next)
    }
  }

  /** Remove a queued (never started) task. */
  function removeWaiting(task) {
    const index = waiting.indexOf(task)
    if (index >= 0) waiting.splice(index, 1)
  }

  /** Run one task to completion (success persists its own terminal state). */
  async function runTask(task) {
    if (task.resumeOnly) await resumeTask(task)
    else await executeTask(task)
  }

  /** Submit → upload → poll → download → extract for a fresh parse. */
  async function executeTask(task) {
    const meta = store.get(task.id)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    const sourcePath = await store.sourcePath(task.id)
    const bytes = await readFile(sourcePath)
    checkAborted(task)

    if (task.engine === 'standard') {
      const created = await client.standardCreateBatch({
        fileName: task.params.fileName,
        dataId: task.id,
        options: task.params,
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
      options: task.params,
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
  async function resumeTask(task) {
    const meta = store.get(task.id)
    if (meta === undefined) return
    const parse = meta.parse ?? {}
    if (task.engine === 'standard') {
      if (typeof parse.batchId !== 'string' || parse.batchId === '') {
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
    if (typeof parse.taskId !== 'string' || parse.taskId === '') {
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
  function matchRow(results, task) {
    if (!Array.isArray(results) || results.length === 0) return null
    const byDataId = results.find((row) => row.dataId !== '' && row.dataId === task.id)
    if (byDataId !== undefined) return byDataId
    const byName = results.find((row) => row.fileName !== '' && row.fileName === task.params.fileName)
    if (byName !== undefined) return byName
    return results.length === 1 ? results[0] : null
  }

  /** Poll the standard batch endpoint until done / failed / timeout / cancel. */
  async function pollStandard(task, batchId) {
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
        log.warn?.('[dsh-litnotes] poll failure %d for %s: %s', failures, task.id, describeMineruError(error))
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
  async function pollAgent(task, taskId) {
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
        log.warn?.('[dsh-litnotes] agent poll failure %d for %s: %s', failures, task.id, describeMineruError(error))
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
  function finalProgress(task, progress) {
    const extracted = Number(progress?.extracted)
    if (Number.isFinite(extracted) && extracted > 0) {
      return { extracted, total: Math.max(extracted, Number(progress?.total) || 0) }
    }
    return task.lastProgress
  }

  /** Write the staging parse directory then atomically swap it into `parsed/`. */
  async function writeStagedParsed(id, files) {
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
  async function applyStandardZip(task, zipBuffer) {
    const extracted = unzip(zipBuffer, { filter: wantedEntry })
    let markdown = null
    let contentListText = null
    let hasContentList = false
    const files = []
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
    if (task.repair) {
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
  async function applyRepairZip(task, { markdown, contentListText, imageFiles }) {
    let newContentList = null
    if (typeof contentListText === 'string' && contentListText.trim() !== '') {
      try {
        const parsed = JSON.parse(contentListText)
        if (Array.isArray(parsed)) newContentList = parsed
        else if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.content_list)) newContentList = parsed.content_list
      } catch {
        newContentList = null
      }
    }
    if (!Array.isArray(newContentList) || newContentList.length === 0) {
      throw new WireError('repair-unavailable', '修复结果缺少内容列表，无法对齐页面；请整篇重新解析（Repair result has no content list）', 409)
    }
    const previous = await store.readMarkdown(task.id)
    if (!Array.isArray(previous.contentList) || previous.contentList.length === 0) {
      throw new WireError('repair-unavailable', '原解析稿缺少内容列表，无法按页修复（Original parse has no content list）', 409)
    }
    const merged = mergeRepairedPages({
      oldMarkdown: previous.markdown,
      oldContentList: previous.contentList,
      newMarkdown: markdown,
      newContentList,
      targetPages: task.repair.targetPages,
    })
    if (merged.replacedPages.length === 0) {
      throw new WireError('repair-unavailable', '修复结果无法与原文对齐，请整篇重新解析（Repair result could not be aligned）', 409)
    }
    if (merged.failedPages.length > 0) {
      log.warn?.('[dsh-litnotes] repair could not align pages %s for %s', merged.failedPages.join(','), task.id)
    }
    await writeStagedRepair(task.id, merged, imageFiles)
    return {
      hasContentList: true,
      pages: task.repair.previousPages ?? previous.pages ?? null,
      title: firstHeading(merged.markdown),
      repair: { pages: merged.replacedPages, failedPages: merged.failedPages },
    }
  }

  /** Write the spliced markdown/CL/images over the existing parsed directory atomically. */
  async function writeStagedRepair(id, merged, imageFiles) {
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
  async function applyAgentMarkdown(task, markdown) {
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

  /** Persist the terminal success state (and adopt the first heading as title). */
  async function finishSuccess(task, result) {
    const current = store.get(task.id)
    if (current === undefined) return
    if (task.repair) {
      const previous = task.repair.previousParse && typeof task.repair.previousParse === 'object' ? task.repair.previousParse : {}
      const repairedPages = Number.isInteger(task.repair.previousPages) && task.repair.previousPages > 0
        ? task.repair.previousPages
        : (Number.isInteger(previous.pages) ? previous.pages : null)
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
        log.info?.('[dsh-litnotes] repaired pages [%s] for %s', (result.repair?.pages ?? []).join(','), task.id)
      } catch (error) {
        log.warn?.('[dsh-litnotes] cannot persist repaired state for %s: %s', task.id, error?.message ?? error)
      }
      return
    }
    const patch = {
      status: 'parsed',
      error: null,
      parse: {
        phase: null,
        remoteState: null,
        finishedAt: new Date().toISOString(),
        pages: Number.isInteger(result.pages) && result.pages > 0 ? result.pages : null,
        hasContentList: result.hasContentList === true,
        progress: finalProgress(task, result.progress) ?? null,
      },
    }
    const derived = typeof result.title === 'string' ? result.title.trim() : ''
    if (derived !== '' && current.title === defaultTitleOf(current)) patch.title = derived.slice(0, 300)
    try {
      await store.update(task.id, patch)
      log.info?.('[dsh-litnotes] parsed %s (%s)', task.id, task.engine)
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot persist parsed state for %s: %s', task.id, error?.message ?? error)
    }
  }

  /** Persist the terminal failure/cancelled state. */
  async function finishFailure(task, error) {
    if (store.get(task.id) === undefined) return
    const cancelled = task.cancelled || task.controller.signal.aborted || isAbort(error)
    if (task.repair) {
      const previous = task.repair.previousParse && typeof task.repair.previousParse === 'object' ? task.repair.previousParse : {}
      const message = cancelled ? null : describeMineruError(error)
      if (message !== null) log.warn?.('[dsh-litnotes] page repair failed for %s: %s', task.id, message)
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
        log.warn?.('[dsh-litnotes] cannot persist repair failure for %s: %s', task.id, persistError?.message ?? persistError)
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
      log.warn?.('[dsh-litnotes] parse failed for %s: %s', task.id, message)
      await store.update(task.id, {
        status: 'failed',
        error: message,
        parse: { phase: null, remoteState: null, finishedAt: new Date().toISOString() },
      })
    } catch (persistError) {
      log.warn?.('[dsh-litnotes] cannot persist failure state for %s: %s', task.id, persistError?.message ?? persistError)
    }
  }

  /** Reconstruct API params from persisted metadata (used by `resume()`). */
  function paramsFromMeta(meta) {
    const parse = meta.parse ?? {}
    const options = parse.options ?? {}
    const params = {
      fileName:
        typeof meta.originalName === 'string' && meta.originalName !== ''
          ? meta.originalName
          : `source${typeof meta.ext === 'string' ? meta.ext : ''}`,
      language: typeof parse.language === 'string' && parse.language !== '' ? parse.language : 'ch',
      isOcr: options.isOcr === true,
      enableFormula: options.enableFormula !== false,
      enableTable: options.enableTable !== false,
      pageRanges: typeof options.pageRanges === 'string' ? options.pageRanges : '',
    }
    if (parse.engine === 'standard') {
      params.modelVersion = typeof parse.modelVersion === 'string' && parse.modelVersion !== '' ? parse.modelVersion : 'vlm'
    }
    return params
  }

  /**
   * Start parsing one document. The caller validates user-facing preconditions
   * (see `service.startParse` / `normalizeParseOptions`); a normalized
   * `{ engine, params }` object or raw client options are both accepted.
   *
   * @param {string} id - document id.
   * @param {object} [options] - normalized or raw parse options.
   * @returns {Promise<Record<string, any>>} the document metadata with status `parsing`.
   */
  async function start(id, options) {
    if (disposed) throw new WireError('host-error', '插件正在卸载（Host is shutting down）', 500)
    await store.init()
    const docId = requireUuid(id)
    const meta = store.get(docId)
    if (meta === undefined) throw new WireError('not-found', '文档不存在（Document not found）', 404)
    if (tasks.has(docId)) {
      throw new WireError('conflict', '该文档已有解析任务在进行中（A parse is already running）', 409)
    }
    let normalized
    let repair = null
    if (options !== null && typeof options === 'object' && options.merge === true && !(options.params && typeof options.params === 'object')) {
      repair = await prepareRepair(meta, options)
      normalized = { engine: 'standard', params: repair.params }
    } else if (
      options !== null &&
      typeof options === 'object' &&
      (options.engine === 'standard' || options.engine === 'agent') &&
      options.params !== null &&
      typeof options.params === 'object'
    ) {
      normalized = { engine: options.engine, params: options.params }
    } else {
      let hasToken = false
      try {
        hasToken = Boolean(typeof getToken === 'function' ? await getToken() : undefined)
      } catch {
        hasToken = false
      }
      normalized = normalizeParseOptions(options, meta, {
        hasToken,
        maxUploadBytes: config.maxUploadBytes,
      })
    }
    const parseState = {
      engine: normalized.engine,
      modelVersion: normalized.params.modelVersion ?? null,
      language: normalized.params.language ?? 'ch',
      options: {
        isOcr: normalized.params.isOcr === true,
        enableFormula: normalized.params.enableFormula !== false,
        enableTable: normalized.params.enableTable !== false,
        pageRanges: normalized.params.pageRanges ?? '',
      },
      phase: 'submitting',
      remoteState: null,
      taskId: null,
      batchId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: repair ? repair.previousPages : null,
      progress: null,
      hasContentList: repair ? true : false,
    }
    if (repair) {
      parseState.repairPages = repair.pages
      parseState.repairRestore = repair.previousParse
      parseState.repairPreviousPages = repair.previousPages
    }
    const updated = await store.update(docId, { status: 'parsing', error: null, parse: parseState })
    const task = createTask(docId, normalized)
    if (repair) task.repair = { targetPages: repair.pages, previousParse: repair.previousParse, previousPages: repair.previousPages }
    tasks.set(docId, task)
    enqueue(task)
    return store.get(docId) ?? updated
  }

  /**
   * Cancel the document's parse task: abort the network work and return the
   * document to `status:'uploaded'` with its source kept.
   *
   * @param {string} id - document id.
   * @returns {Promise<Record<string, any>>} the updated document metadata.
   */
  async function cancel(id) {
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
    if (task !== undefined && task.repair) {
      const previous = task.repair.previousParse && typeof task.repair.previousParse === 'object' ? task.repair.previousParse : {}
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
   * @returns {Promise<void>} resolves once resumable tasks are scheduled.
   */
  async function resume() {
    await store.init()
    if (disposed) return
    for (const meta of store.list()) {
      if (meta.status !== 'parsing' || tasks.has(meta.id)) continue
      const parse = meta.parse ?? {}
      const engine = parse.engine === 'standard' ? 'standard' : parse.engine === 'agent' ? 'agent' : null
      const repair = repairTaskFromMeta(meta)
      const resumable =
        parse.phase === 'polling' &&
        engine !== null &&
        ((engine === 'standard' && typeof parse.batchId === 'string' && parse.batchId !== '') ||
          (engine === 'agent' && typeof parse.taskId === 'string' && parse.taskId !== ''))
      if (!resumable) {
        try {
          if (repair !== null) {
            const previous = repair.previousParse && typeof repair.previousParse === 'object' ? repair.previousParse : {}
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
          log.warn?.('[dsh-litnotes] cannot mark interrupted parse %s: %s', meta.id, error?.message ?? error)
        }
        continue
      }
      const task = createTask(meta.id, { engine, params: paramsFromMeta(meta) })
      if (repair !== null) task.repair = repair
      // Seed the last persisted page count so the first poll after a host
      // restart can never move the client-visible progress backwards.
      const persistedProgress = parse.progress
      if (persistedProgress !== null && typeof persistedProgress === 'object') {
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
      log.info?.('[dsh-litnotes] resuming %s parse for %s', engine, meta.id)
      enqueue(task)
    }
  }

  /**
   * Abort every task and wait for their promises to settle. Idempotent.
   * @returns {Promise<void>} resolves after all task work quiesced.
   */
  function dispose() {
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
function timeoutError() {
  return new MineruError('timeout', '解析超时，请重试（Parse timed out）', 0)
}
