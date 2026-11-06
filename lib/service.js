/**
 * Operations shared by the dsh-litnotes HTTP API and the `mineru` agent tool.
 *
 * One implementation, two callers: `lib/routes.js` dispatches JSON methods to
 * this service and `lib/agent-tool.js` exposes the same operations to the
 * model. Every method returns JSON-serializable data or throws {@link WireError}.
 *
 * Translation prefers the Host translator service (anonymous Google/Bing when
 * available) and falls back to the configured default LLM with a strict
 * translate-only prompt; when neither is usable it throws
 * `translate-unavailable` so the client can offer setup guidance.
 *
 * @module lib/service
 */
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, sep } from 'node:path'
import { once } from 'node:events'
import {
  HIGHLIGHT_COLORS,
  clearToken as clearStoredToken,
  getToken,
  isTokenPersistent,
  loadPreferences,
  normalizeToken,
  savePreferences,
  setToken as storeToken,
} from './config.js'
import { normalizeParseOptions } from './mineru.js'
import { extOf, isSupportedSource } from './mime.js'
import { parseMarkdown } from '../ui/markdown.js'
import { WireError, isPlainObject, requireUuid } from './wire.js'

/** Largest text accepted by one translate call. */
const MAX_TRANSLATE_CHARS = 20000
/** Anonymous translator providers usable without a Session identity. */
const ANONYMOUS_PROVIDERS = new Set(['google', 'bing'])
/** Human labels for translator provider ids. */
const PROVIDER_LABELS = Object.freeze({
  auto: '自动（Auto）',
  google: 'Google',
  bing: 'Bing',
  'deepseek-account': 'DeepSeek 账号（Account）',
  'deepseek-official': 'DeepSeek 官方（Official）',
})
/** Content-type → extension fallback used when an imported URL has no file name. */
const CONTENT_TYPE_EXTENSIONS = new Map([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jp2', '.jp2'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
  ['text/html', '.html'],
])

/** System prompt used by the LLM translation fallback. */
const LLM_TRANSLATE_SYSTEM =
  'You are a precise translation engine for academic reading. Translate the supplied text into the requested target language. Preserve formulas, citations, and paragraph structure. Output ONLY the translation, with no explanation, no quotes, and no markdown fences.'

/** Build a `not-found` error for a document. */
function documentNotFound(id) {
  return new WireError('not-found', `文档不存在（Document not found: ${id}）`, 404)
}

/** Build a `bad-request` error. */
function badRequest(message) {
  return new WireError('bad-request', message, 400)
}

/** Render the configured data directory relative to the home directory. */
function displayDataDir(dataDir) {
  try {
    const home = homedir()
    if (dataDir === home) return '~'
    if (typeof dataDir === 'string' && dataDir.startsWith(home + sep)) return `~${dataDir.slice(home.length)}`
  } catch {
    /* fall through */
  }
  return typeof dataDir === 'string' ? dataDir : ''
}

/** Strip inline markdown syntax so a quote can be located in block plain text. */
function plainInline(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Block kinds that can carry a client annotation (mirrors ui/highlight.js). */
const ANNOTATABLE_BLOCK_KINDS = new Set(['heading', 'paragraph', 'quote', 'list', 'table'])

/**
 * Locate a quote inside the document using the CLIENT's parser, returning the
 * exact `b<index>:<fnv1a(plainText)>` key and offsets the reader will anchor
 * on. Sharing `ui/markdown.js` here is deliberate: a second, approximate
 * block splitter used to drift from the client (merged blockquotes, list and
 * table plain-text differences) and silently produced unrenderable anchors.
 *
 * @param {string} markdown - parsed markdown.
 * @param {string} quote - text selected in the reader (or copied from it).
 * @returns {{ blockKey: string, start: number, end: number }} located range.
 * @throws {WireError} `bad-request` when the quote is missing or ambiguous.
 */
function locateQuote(markdown, quote) {
  const raw = String(quote ?? '')
  if (raw.trim() === '') throw badRequest('引文为空（Empty quote）')
  const candidates = []
  for (const candidate of [raw.trim(), raw.trim().replace(/\s+/g, ' '), plainInline(raw)]) {
    const value = candidate.trim()
    if (value !== '' && !candidates.includes(value)) candidates.push(value)
  }
  const model = parseMarkdown(String(markdown ?? ''))
  const blocks = Array.isArray(model.blocks) ? model.blocks : []
  const matches = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (!ANNOTATABLE_BLOCK_KINDS.has(block.kind)) continue
    const text = typeof block.plainText === 'string' ? block.plainText : ''
    if (text === '' || typeof block.key !== 'string') continue
    let foundInBlock = false
    for (const needle of candidates) {
      if (foundInBlock) break
      let from = 0
      for (;;) {
        const found = text.indexOf(needle, from)
        if (found < 0) break
        matches.push({ blockKey: block.key, start: found, end: found + needle.length })
        foundInBlock = true
        from = found + Math.max(1, needle.length)
      }
    }
  }
  if (matches.length === 0) throw badRequest('文档中未找到该引文（Quote not found in the document）')
  if (matches.length > 1) {
    throw badRequest('该引文在文档中出现多次，请提供 blockKey（Quote is ambiguous; provide a blockKey）')
  }
  const match = matches[0]
  return { blockKey: match.blockKey, start: match.start, end: match.end }
}

/** Validate an imported URL and return its normalized text. */
function normalizeImportUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw badRequest('缺少 URL（Missing url）')
  if (text.length > 4096) throw badRequest('URL 过长（URL too long）')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw badRequest('URL 格式无效（Invalid URL）')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('仅支持 http/https URL（Only http/https URLs are supported）')
  }
  return parsed.toString()
}

/** Sanitize an imported file name (strip path separators and control characters). */
function sanitizeFileName(name) {
  return String(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 255)
}

/** Resolve the imported file name from Content-Disposition, URL path, or content type. */
function fileNameFromResponse(response, targetUrl) {
  const header = typeof response?.headers?.get === 'function' ? response.headers.get('content-disposition') : ''
  let candidate = ''
  if (typeof header === 'string' && header !== '') {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
    if (star !== null) {
      try {
        candidate = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
      } catch {
        candidate = star[1].trim().replace(/^"|"$/g, '')
      }
    } else {
      const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
      if (plain !== null) candidate = plain[1].trim()
    }
  }
  if (candidate === '') {
    try {
      const pathname = new URL(targetUrl).pathname
      candidate = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '')
    } catch {
      candidate = ''
    }
  }
  candidate = sanitizeFileName(candidate)
  if (candidate === '') candidate = 'import'
  if (!isSupportedSource(candidate)) {
    const contentType =
      typeof response?.headers?.get === 'function'
        ? String(response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
        : ''
    const mapped = CONTENT_TYPE_EXTENSIONS.get(contentType)
    if (mapped !== undefined) {
      const stem = extname(candidate) === '' ? candidate : candidate.slice(0, candidate.length - extname(candidate).length)
      candidate = `${stem || 'import'}${mapped}`
    }
  }
  return candidate
}

/** Stream a fetch Response body into a freshly created file with a hard cap. */
async function writeResponseToFile(response, filePath, maxBytes) {
  await mkdir(dirname(filePath), { recursive: true })
  const stream = createWriteStream(filePath, { flags: 'wx' })
  let total = 0
  try {
    const body = response?.body
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) throw new WireError('too-large', `文件超过 ${maxBytes} 字节限制（File too large）`, 413)
        if (!stream.write(chunk)) await once(stream, 'drain')
      }
    } else if (typeof response?.arrayBuffer === 'function') {
      const buffer = Buffer.from(await response.arrayBuffer())
      total = buffer.length
      if (total > maxBytes) throw new WireError('too-large', `文件超过 ${maxBytes} 字节限制（File too large）`, 413)
      stream.write(buffer)
    } else {
      throw new WireError('bad-request', '无法读取下载内容（Cannot read download body）', 400)
    }
    await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())))
  } catch (error) {
    stream.destroy()
    throw error
  }
}

/**
 * Create the shared operation service.
 *
 * @param {{
 *   store: object,
 *   manager: object,
 *   config: { dataDir: string, maxUploadBytes: number, toolMaxChars: number, hostVersion?: string },
 *   logger?: object,
 *   getCredentials?: () => object | undefined,
 *   getTranslator?: () => object | undefined,
 *   getLlm?: () => object | undefined,
 *   getDefaultModel?: () => { provider?: string, model?: string } | undefined,
 *   hostVersion?: string,
 *   fetchImpl?: typeof fetch,
 * }} options - service dependencies.
 * @returns {object} the service facade documented in docs/HOST-INTERFACES.md.
 */
export function createService({
  store,
  manager,
  config,
  logger,
  getCredentials,
  getTranslator,
  getLlm,
  getDefaultModel,
  hostVersion,
  fetchImpl,
} = {}) {
  if (!store) throw new TypeError('createService: store is required')
  if (!manager) throw new TypeError('createService: manager is required')
  if (!config || typeof config !== 'object') throw new TypeError('createService: config is required')
  const log = logger ?? {}
  const version = typeof hostVersion === 'string' && hostVersion !== '' ? hostVersion : config.hostVersion ?? '0.0.0'
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch

  /** The credentials service (may be undefined in minimal profiles). */
  function credentials() {
    try {
      return typeof getCredentials === 'function' ? getCredentials() : undefined
    } catch {
      return undefined
    }
  }

  /** The Host translator service (may be undefined). */
  function translator() {
    try {
      return typeof getTranslator === 'function' ? getTranslator() : undefined
    } catch {
      return undefined
    }
  }

  /** The Host LLM service (may be undefined). */
  function llm() {
    try {
      return typeof getLlm === 'function' ? getLlm() : undefined
    } catch {
      return undefined
    }
  }

  /** The default model selection (may be undefined). */
  function defaultModel() {
    try {
      return typeof getDefaultModel === 'function' ? getDefaultModel() : undefined
    } catch {
      return undefined
    }
  }

  /** Ensure the library is initialized then return a document or throw not-found. */
  async function requireDocument(id) {
    await store.init()
    const docId = requireUuid(id)
    const meta = store.get(docId)
    if (meta === undefined) throw documentNotFound(docId)
    return meta
  }

  /** List translator providers pinned to the anonymous ones usable without a Session. */
  async function availableTranslatorProviders() {
    const service = translator()
    if (!service || typeof service.availableProviders !== 'function') return []
    try {
      const providers = await service.availableProviders()
      return Array.isArray(providers) ? providers.filter((provider) => typeof provider === 'string') : []
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot list translation providers: %s', error?.message ?? error)
      return []
    }
  }

  /** Throw `translate-unavailable` after both translation backends failed. */
  function translationUnavailable() {
    return new WireError(
      'translate-unavailable',
      '翻译服务不可用，请检查翻译或模型配置（Translation unavailable; check the translator or model settings）',
      503,
    )
  }

  /** Translate through the LLM fallback, collecting the streamed text. */
  async function translateWithLlm(text, targetLanguage, sourceLanguage) {
    const service = llm()
    if (!service || typeof service.stream !== 'function') throw translationUnavailable()
    const selection = defaultModel() ?? {}
    const provider = typeof selection?.provider === 'string' ? selection.provider : ''
    const model = typeof selection?.model === 'string' ? selection.model : ''
    if (provider === '' || model === '') throw translationUnavailable()
    const prompt = [
      `Target language: ${targetLanguage}`,
      sourceLanguage ? `Source language: ${sourceLanguage}` : 'Source language: auto-detect',
      '',
      text,
    ].join('\n')
    const chunks = []
    try {
      const stream = service.stream({
        provider,
        model,
        system: LLM_TRANSLATE_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0,
        maxTokens: Math.min(8192, Math.max(512, Math.ceil(text.length * 2))),
      })
      let collected = 0
      for await (const chunk of stream) {
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          chunks.push(chunk.text)
          collected += chunk.text.length
          if (collected > 200000) break
        }
      }
    } catch (error) {
      log.warn?.('[dsh-litnotes] LLM translation failed: %s', error?.message ?? error)
      throw translationUnavailable()
    }
    const translation = chunks.join('').trim()
    if (translation === '') throw translationUnavailable()
    return { translation, provider: 'llm', model, targetLanguage }
  }

  /**
   * Record a client health/event ping into the diagnostics log.
   * @param {{ clientVersion?: string, event?: string, detail?: unknown }} payload - ping payload.
   * @returns {Promise<{ ok: true, hostVersion: string, receivedAt: string }>} acknowledgement.
   */
  async function healthPing(payload = {}) {
    const event = typeof payload?.event === 'string' && payload.event !== '' ? payload.event.slice(0, 80) : 'active'
    const clientVersion =
      typeof payload?.clientVersion === 'string' && payload.clientVersion !== ''
        ? payload.clientVersion.slice(0, 120)
        : 'unknown'
    const entry = { clientVersion, event }
    if (payload?.detail !== undefined) {
      try {
        entry.detail = JSON.stringify(payload.detail).slice(0, 2000)
      } catch {
        entry.detail = 'unserializable detail'
      }
    }
    await store.appendDiagnostic(entry)
    return { ok: true, hostVersion: version, receivedAt: new Date().toISOString() }
  }

  /** Host/library status snapshot used by the client shell. */
  async function getStatus() {
    await store.init()
    const creds = credentials()
    const token = await getToken(creds)
    let tokenPersistent = false
    try {
      tokenPersistent = await isTokenPersistent(creds)
    } catch {
      tokenPersistent = false
    }
    const providers = await availableTranslatorProviders()
    const selection = defaultModel()
    const modelAvailable = Boolean(selection && typeof selection.provider === 'string' && typeof selection.model === 'string')
    const preferences = await loadPreferences(config.dataDir)
    const counts = store.stats()
    return {
      version,
      hostVersion: version,
      dataDirDisplay: displayDataDir(config.dataDir),
      tokenConfigured: token !== undefined,
      tokenPersistent,
      translatorAvailable: providers.length > 0,
      modelAvailable,
      counts,
      preferences,
      versionInfo: { host: version, node: process.version, dataDir: config.dataDir },
      configured: {
        token: token !== undefined,
        translator: providers.length > 0,
        model: modelAvailable,
        dataDir: config.dataDir,
      },
    }
  }

  /** Compact library listing (metadata without the heavy hash field / task ids). */
  async function listDocuments() {
    await store.init()
    const documents = store.list().map((meta) => {
      const summary = { ...meta }
      delete summary.sha256
      if (summary.parse !== null && typeof summary.parse === 'object') {
        const parse = summary.parse
        const options = parse.options !== null && typeof parse.options === 'object' ? parse.options : {}
        summary.parse = {
          engine: parse.engine ?? null,
          modelVersion: parse.modelVersion ?? null,
          language: parse.language ?? null,
          phase: parse.phase ?? null,
          // Upstream MinerU task state (waiting-file / pending / running /
          // converting): lets the client explain a long queue wait instead of
          // showing a stagnant progress bar.
          remoteState: typeof parse.remoteState === 'string' ? parse.remoteState : null,
          ocr: options.isOcr === true,
          pages: parse.pages ?? null,
          progress: parse.progress ?? null,
          hasContentList: parse.hasContentList === true,
          startedAt: parse.startedAt ?? null,
          finishedAt: parse.finishedAt ?? null,
        }
      }
      return summary
    })
    return { documents }
  }

  /** Full document payload: metadata + annotations + translation cache. */
  async function getDocument(id) {
    const document = await requireDocument(id)
    const [annotations, translations] = await Promise.all([
      store.loadAnnotations(document.id),
      store.loadTranslations(document.id),
    ])
    return { document, annotations, translations }
  }

  /** Rename one document (the only client-editable metadata field). */
  async function updateDocument(id, patch) {
    const document = await requireDocument(id)
    if (!isPlainObject(patch)) throw badRequest('更新内容必须是对象（Update payload must be an object）')
    const update = {}
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || patch.title.trim() === '') {
        throw badRequest('标题不能为空（Title must not be empty）')
      }
      update.title = patch.title.trim().slice(0, 300)
    }
    if (Object.keys(update).length === 0) return { document }
    const meta = await store.update(document.id, update)
    return { document: meta }
  }

  /** Delete a document and everything derived from it. */
  async function removeDocument(id) {
    const document = await requireDocument(id)
    if (document.status === 'parsing') {
      try {
        await manager.cancel(document.id)
      } catch {
        /* the directory is deleted anyway */
      }
    }
    await store.remove(document.id)
    return { removed: true }
  }

  /**
   * Download a remote document into the library, capped by `maxUploadBytes`.
   * @param {{ url: string, title?: string }} input - import request.
   * @returns {Promise<{ document: object }>} the imported document metadata.
   */
  async function importUrl(input = {}) {
    await store.init()
    const target = normalizeImportUrl(input?.url)
    const id = randomUUID()
    const tempPath = store.newTempPath(id)
    let keepTemp = false
    try {
      const response = await doFetch(target, { method: 'GET', redirect: 'follow' })
      const status = Number(response?.status ?? 200)
      if (status < 200 || status >= 300) {
        throw new WireError('bad-request', `下载失败：HTTP ${status}（Download failed）`, 400)
      }
      const contentLength = Number(response?.headers?.get?.('content-length'))
      if (Number.isFinite(contentLength) && contentLength > config.maxUploadBytes) {
        throw new WireError('too-large', `文件超过 ${config.maxUploadBytes} 字节限制（File too large）`, 413)
      }
      const fileName = fileNameFromResponse(response, target)
      if (!isSupportedSource(fileName)) {
        throw new WireError('unsupported-type', `不支持的文件类型 ${extOf(fileName) || fileName}（Unsupported file type）`, 415)
      }
      await writeResponseToFile(response, tempPath, config.maxUploadBytes)
      const title = typeof input?.title === 'string' && input.title.trim() !== '' ? input.title : undefined
      const meta = await store.createFromFile({ id, tempPath, originalName: fileName, title })
      keepTemp = true
      return { document: meta }
    } finally {
      if (!keepTemp) await rm(tempPath, { force: true }).catch(() => {})
    }
  }

  /** Start a parse after validating engine/limits preconditions. */
  async function startParse(id, options) {
    const document = await requireDocument(id)
    // `merge:true` asks for a page-scoped repair: only the listed pages (or the
    // pages the host detects as unreadable) are sent to MinerU and spliced back
    // into the existing parse, leaving every other page untouched.
    if (isPlainObject(options) && options.merge === true) {
      const repairRequest = {
        merge: true,
        pages: Array.isArray(options.pages) ? options.pages : undefined,
        modelVersion: typeof options.modelVersion === 'string' ? options.modelVersion : undefined,
        language: typeof options.language === 'string' ? options.language : undefined,
        isOcr: typeof options.isOcr === 'boolean' ? options.isOcr : undefined,
        enableFormula: typeof options.enableFormula === 'boolean' ? options.enableFormula : undefined,
        enableTable: typeof options.enableTable === 'boolean' ? options.enableTable : undefined,
      }
      const meta = await manager.start(document.id, repairRequest)
      return { document: meta }
    }
    const hasToken = (await getToken(credentials())) !== undefined
    const normalized = normalizeParseOptions(options, document, {
      hasToken,
      maxUploadBytes: config.maxUploadBytes,
    })
    const meta = await manager.start(document.id, normalized)
    return { document: meta }
  }

  /** Cancel the document's parse task. */
  async function cancelParse(id) {
    const document = await requireDocument(id)
    if (document.status !== 'parsing') {
      throw new WireError('bad-request', '没有正在进行的解析任务（No parse is in progress）', 409)
    }
    const meta = await manager.cancel(document.id)
    return { document: meta }
  }

  /** Read parsed markdown + content list + page count. */
  async function readMarkdown(id) {
    const document = await requireDocument(id)
    return store.readMarkdown(document.id)
  }

  /** Replace the complete annotation list. */
  async function saveAnnotations(id, annotations) {
    const document = await requireDocument(id)
    if (!Array.isArray(annotations)) throw badRequest('annotations 必须是数组（annotations must be an array）')
    await store.saveAnnotations(document.id, { version: 1, items: annotations })
    return { saved: true }
  }

  /** Replace the complete translation cache. */
  async function saveTranslations(id, targetLanguage, entries) {
    const document = await requireDocument(id)
    if (!isPlainObject(entries)) throw badRequest('entries 必须是对象（entries must be an object）')
    const target =
      typeof targetLanguage === 'string' && targetLanguage.trim() !== ''
        ? targetLanguage.trim().slice(0, 32)
        : (await loadPreferences(config.dataDir)).targetLanguage
    await store.saveTranslations(document.id, { version: 1, targetLanguage: target, entries })
    return { saved: true }
  }

  /**
   * Translate text: Host translator first (anonymous providers), LLM fallback.
   * @param {{ text: string, targetLanguage?: string, sourceLanguage?: string, provider?: string }} input
   * @returns {Promise<{ translation: string, provider: string, targetLanguage: string }>}
   */
  async function translate(input = {}) {
    const text = typeof input?.text === 'string' ? input.text : ''
    if (text.trim() === '') throw badRequest('缺少待翻译文本（Missing text）')
    if (text.length > MAX_TRANSLATE_CHARS) {
      throw new WireError('too-large', `文本超过 ${MAX_TRANSLATE_CHARS} 字符限制（Text too long）`, 413)
    }
    const preferences = await loadPreferences(config.dataDir)
    const target =
      typeof input?.targetLanguage === 'string' && input.targetLanguage.trim() !== ''
        ? input.targetLanguage.trim().slice(0, 32)
        : preferences.targetLanguage
    const source =
      typeof input?.sourceLanguage === 'string' && input.sourceLanguage.trim() !== ''
        ? input.sourceLanguage.trim().slice(0, 32)
        : undefined
    const requested = typeof input?.provider === 'string' && input.provider !== '' ? input.provider : undefined
    const service = translator()
    if (service && typeof service.resolve === 'function' && typeof service.translate === 'function') {
      const available = await availableTranslatorProviders()
      const wanted =
        requested !== undefined && ANONYMOUS_PROVIDERS.has(requested) && available.includes(requested)
          ? requested
          : undefined
      const chosen =
        wanted ??
        (available.includes('google') ? 'google' : available.includes('bing') ? 'bing' : undefined)
      if (chosen !== undefined) {
        try {
          const request = { text, targetLanguage: target, provider: chosen }
          if (source !== undefined) request.sourceLanguage = source
          const spec = service.resolve(request)
          const translation = await service.translate(spec)
          if (typeof translation === 'string' && translation.trim() !== '') {
            return {
              translation,
              provider: typeof spec?.provider === 'string' ? spec.provider : chosen,
              targetLanguage: target,
            }
          }
        } catch (error) {
          log.warn?.('[dsh-litnotes] translator failed: %s', error?.message ?? error)
        }
      }
    }
    return translateWithLlm(text, target, source)
  }

  /** Settings modal payload: token state, preferences, providers and defaults. */
  async function getSettings() {
    await store.init()
    const creds = credentials()
    const token = await getToken(creds)
    const providers = [{ id: 'auto', label: PROVIDER_LABELS.auto }]
    for (const id of await availableTranslatorProviders()) {
      providers.push({ id, label: PROVIDER_LABELS[id] ?? id })
    }
    const preferences = await loadPreferences(config.dataDir)
    let tokenPersistent = false
    try {
      tokenPersistent = await isTokenPersistent(creds)
    } catch {
      tokenPersistent = false
    }
    return {
      tokenConfigured: token !== undefined,
      tokenPersistent,
      currentProvider: preferences.translationProvider,
      preferences,
      providers,
      defaults: {
        engine: preferences.defaultEngine,
        modelVersion: preferences.defaultModelVersion,
        language: preferences.defaultLanguage,
        targetLanguage: preferences.targetLanguage,
        translationProvider: preferences.translationProvider,
      },
    }
  }

  /** Store the MinerU API token (durably when the credential store is writable). */
  async function setToken(token) {
    const value = normalizeToken(token)
    const persistent = await storeToken(credentials(), value)
    return { tokenConfigured: true, tokenPersistent: persistent }
  }

  /** Remove the stored MinerU API token. */
  async function clearToken() {
    await clearStoredToken(credentials())
    return { tokenConfigured: false, tokenPersistent: false }
  }

  /** Merge and persist client preferences. */
  async function updatePreferences(preferences) {
    if (!isPlainObject(preferences)) throw badRequest('preferences 必须是对象（preferences must be an object）')
    const saved = await savePreferences(config.dataDir, preferences)
    return { preferences: saved }
  }

  /** Compact library rows for the agent tool. */
  async function toolList() {
    await store.init()
    const documents = store.list().map((meta) => ({
      id: meta.id,
      title: meta.title ?? '',
      status: meta.status ?? 'uploaded',
      pages: Number.isInteger(meta.parse?.pages) ? meta.parse.pages : null,
      engine: typeof meta.parse?.engine === 'string' ? meta.parse.engine : null,
      // Live parse progress so an Agent polling `status`/`list` can report how
      // far a long pipeline/OCR parse has come (mirrors the browser payload).
      remoteState: typeof meta.parse?.remoteState === 'string' ? meta.parse.remoteState : null,
      progress: meta.parse?.progress ?? null,
      createdAt: meta.createdAt ?? null,
      error: typeof meta.error === 'string' && meta.error !== '' ? meta.error : null,
    }))
    return { documents, total: documents.length }
  }

  /** Document + annotations + translation summary for the agent tool. */
  async function toolGet(id) {
    const payload = await getDocument(id)
    const translations = payload.translations ?? {}
    return {
      document: payload.document,
      annotations: payload.annotations.items ?? [],
      translation: {
        targetLanguage: translations.targetLanguage ?? null,
        count: Object.keys(translations.entries ?? {}).length,
      },
    }
  }

  /**
   * Read a character slice of the parsed markdown.
   * @param {string} id - document id.
   * @param {{ offset?: number, maxChars?: number }} [options] - slice options.
   */
  async function toolRead(id, options = {}) {
    const document = await requireDocument(id)
    const { markdown } = await store.readMarkdown(document.id)
    const totalChars = markdown.length
    let offset = Number.isFinite(options?.offset) ? Math.floor(options.offset) : 0
    offset = Math.min(Math.max(0, offset), totalChars)
    const requested = Number.isFinite(options?.maxChars) ? Math.floor(options.maxChars) : 12000
    const maxChars = Math.min(Math.max(1, requested), config.toolMaxChars ?? 40000)
    let text = markdown.slice(offset, offset + maxChars)
    // Never end the slice in the middle of a surrogate pair.
    if (text.length > 0 && /[\uD800-\uDBFF]/.test(text[text.length - 1])) text = text.slice(0, -1)
    const nextOffset = offset + text.length
    return {
      text,
      offset,
      nextOffset,
      totalChars,
      truncated: nextOffset < totalChars,
      title: document.title ?? '',
    }
  }

  /** Annotation list for the agent tool. */
  async function toolAnnotations(id) {
    const document = await requireDocument(id)
    return { annotations: (await store.loadAnnotations(document.id)).items }
  }

  /**
   * Add one annotation. Without a `blockKey`, the `quote` is located in the
   * markdown and converted to the client's `b<index>:<hash>` key.
   * @param {string} id - document id.
   * @param {{ id?: string, blockKey?: string, start?: number, end?: number,
   *           quote?: string, note?: string, color?: string }} annotation - annotation input.
   */
  async function toolAnnotate(id, annotation) {
    const document = await requireDocument(id)
    if (!isPlainObject(annotation)) throw badRequest('annotation 必须是对象（annotation must be an object）')
    const quote = typeof annotation.quote === 'string' ? annotation.quote.slice(0, 5000) : ''
    const note = typeof annotation.note === 'string' ? annotation.note.slice(0, 20000) : ''
    const color = HIGHLIGHT_COLORS.has(annotation.color) ? annotation.color : 'yellow'
    let blockKey = typeof annotation.blockKey === 'string' ? annotation.blockKey.trim() : ''
    let start = Number.isFinite(annotation.start) ? Math.floor(annotation.start) : undefined
    let end = Number.isFinite(annotation.end) ? Math.floor(annotation.end) : undefined
    if (blockKey === '') {
      if (quote.trim() === '') {
        throw badRequest('需要提供 blockKey 或 quote（Provide blockKey or quote）')
      }
      const { markdown } = await store.readMarkdown(document.id)
      const located = locateQuote(markdown, quote)
      blockKey = located.blockKey
      start = located.start
      end = located.end
    } else if (!/^b\d+:[0-9a-f]{8}$/.test(blockKey)) {
      throw badRequest('blockKey 格式无效（Invalid blockKey）')
    }
    start = start === undefined ? 0 : Math.max(0, start)
    end = end === undefined ? start : Math.max(start, end)
    const existing = await store.loadAnnotations(document.id)
    const entry = {
      id: typeof annotation.id === 'string' && annotation.id.trim() !== '' ? annotation.id.trim() : randomUUID(),
      blockKey,
      start,
      end,
      quote,
      note,
      color,
      createdAt: new Date().toISOString(),
    }
    const items = existing.items.filter((item) => item.id !== entry.id)
    items.push(entry)
    await store.saveAnnotations(document.id, { version: 1, items })
    return { annotation: entry, count: items.length }
  }

  /**
   * Remove one annotation by id.
   * @param {string} id - document id.
   * @param {string} annotationId - annotation id.
   */
  async function toolUnannotate(id, annotationId) {
    const document = await requireDocument(id)
    if (typeof annotationId !== 'string' || annotationId.trim() === '') {
      throw badRequest('缺少 annotationId（Missing annotationId）')
    }
    const existing = await store.loadAnnotations(document.id)
    const remaining = existing.items.filter((item) => item.id !== annotationId.trim())
    if (remaining.length === existing.items.length) {
      throw new WireError('not-found', '批注不存在（Annotation not found）', 404)
    }
    await store.saveAnnotations(document.id, { version: 1, items: remaining })
    return { removed: true, count: remaining.length }
  }

  return {
    healthPing,
    getStatus,
    listDocuments,
    getDocument,
    updateDocument,
    removeDocument,
    importUrl,
    startParse,
    cancelParse,
    readMarkdown,
    saveAnnotations,
    saveTranslations,
    translate,
    getSettings,
    setToken,
    clearToken,
    updatePreferences,
    toolList,
    toolGet,
    toolRead,
    toolAnnotations,
    toolAnnotate,
    toolUnannotate,
  }
}
