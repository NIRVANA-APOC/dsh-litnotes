/**
 * Operations shared by the dsh-litnotes HTTP API and the agent tools.
 *
 * One implementation, two callers: `src/host/routes.ts` dispatches JSON methods
 * to this service and `src/host/agent-tools.ts` exposes the same operations to
 * the model. Every method returns JSON-serializable data or throws
 * {@link WireError}.
 *
 * Translation prefers the Host translator service (anonymous Google/Bing when
 * available) and falls back to the configured default LLM with a strict
 * translate-only prompt; when neither is usable it throws
 * `translate-unavailable` so the client can offer setup guidance.
 *
 * The AI engines (grounded chat + knowledge graphs), the parse-option policy
 * and the local extraction engine are injected: this module never imports a
 * concrete implementation, it only calls the contracts.
 *
 * @module host/service
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, sep } from 'node:path'

import { ANNOTATION_COLORS, ASPECT_COLORS } from '../shared/constants.ts'
import type { AnnotationColor } from '../shared/constants.ts'
import type { Block } from '../shared/markdown/model.ts'
import type {
  AiStatus,
  Annotation,
  ChatFrame,
  ChatMessage,
  ChatRequest,
  Citation,
  ContentListEntry,
  DocumentMeta,
  DocumentSummary,
  GraphBuildFrame,
  GraphPatch,
  KnowledgeDelta,
  KnowledgeGraph,
  LibraryGraphFrame,
  ModelRoute,
  ParseStartOptions,
  ParsedDocument,
  Preferences,
  SettingsValue,
  StatusValue,
  TranslateValue,
  TranslationEnvelope,
} from '../shared/model.ts'
import type {
  AiServicesApi,
  BlockText,
  DescribeMineruError,
  DocumentModel,
  LocalEngineApi,
  NormalizeParseOptions,
  ParseManagerApi,
  ParseRepairRequest,
  ResolvedConfig,
  SearchHit,
  SearchResult,
  ServiceApi,
  StoreApi,
  ToolDocumentRow,
} from './contracts.ts'
import {
  clearToken as clearStoredToken,
  getToken,
  isTokenPersistent,
  loadPreferences,
  normalizeToken,
  savePreferences,
  setToken as storeToken,
  type CredentialsLike,
} from './config.ts'
import type {
  LlmService,
  Logger,
  ModelSelection,
  TranslationProviderId,
  TranslationRequest,
  TranslatorService,
} from './host-services.ts'
import { extOf, isSupportedSource } from './mime.ts'
import { appendPageMarks, parseMarkdown } from '../shared/markdown/parse.ts'
import { isPlainObject, requireUuid, WireError } from './wire.ts'

/** Largest text accepted by one translate call. */
const MAX_TRANSLATE_CHARS = 20000
/** Anonymous translator providers usable without a Session identity. */
const ANONYMOUS_PROVIDERS: ReadonlySet<string> = new Set(['google', 'bing'])
/** Human labels for translator provider ids. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  auto: '自动（Auto）',
  google: 'Google',
  bing: 'Bing',
  'deepseek-account': 'DeepSeek 账号（Account）',
  'deepseek-official': 'DeepSeek 官方（Official）',
})
/** Content-type → extension fallback used when an imported URL has no file name. */
const CONTENT_TYPE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
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

/**
 * Dependencies of the shared operation service.
 *
 * Optional capabilities use getter functions so the composition root can mount
 * them later in the plugin lifecycle without restarting the service.
 */
export interface ServiceDeps {
  store: StoreApi
  manager: ParseManagerApi
  config: ResolvedConfig
  logger?: Logger
  getCredentials?: () => CredentialsLike | undefined
  getTranslator?: () => TranslatorService | undefined
  getLlm?: () => LlmService | undefined
  getDefaultModel?: () => ModelSelection | undefined
  /** Local (T0/T0.5) extraction engine, absent when the profile cannot use it. */
  localEngine?: LocalEngineApi | null
  /** Lazily-created AI bundle factory. */
  getAi?: () => Promise<AiServicesApi>
  /** Engine/limit policy for a fresh parse (owned by the parse module). */
  normalizeParseOptions: NormalizeParseOptions
  /** Human-facing MinerU failure mapping (never leaks the token). */
  describeMineruError?: DescribeMineruError
  fetchImpl?: typeof fetch
  hostVersion?: string
}

/** Quote-located annotation input accepted by `toolAnnotate`. */
export interface ToolAnnotationInput {
  id?: string
  blockKey?: string
  start?: number
  end?: number
  quote?: string
  note?: string
  color?: string
  aspect?: string
  origin?: string
  chatId?: string
  messageId?: string
  model?: unknown
}

/** Block kinds that can carry a client annotation (mirrors the reader). */
const ANNOTATABLE_BLOCK_KINDS: ReadonlySet<string> = new Set([
  'heading',
  'paragraph',
  'quote',
  'list',
  'table',
])

/** A parser block whose `plainText` is the annotation offset space. */
type AnnotatableBlock = Extract<Block, { kind: 'heading' | 'paragraph' | 'quote' | 'list' | 'table' }>

/**
 * Whether a parser block can carry a client annotation.
 *
 * @param block - parser block.
 * @returns true for heading / paragraph / quote / list / table blocks.
 */
function isAnnotatableBlock(block: Block): block is AnnotatableBlock {
  return ANNOTATABLE_BLOCK_KINDS.has(block.kind)
}

/** Build a `not-found` error for a document. */
function documentNotFound(id: string): WireError {
  return new WireError('not-found', `文档不存在（Document not found: ${id}）`, 404)
}

/** Build a `bad-request` error. */
function badRequest(message: string): WireError {
  return new WireError('bad-request', message, 400)
}

/** Render the configured data directory relative to the home directory. */
function displayDataDir(dataDir: string): string {
  try {
    const home = homedir()
    if (dataDir === home) return '~'
    if (typeof dataDir === 'string' && dataDir.startsWith(home + sep)) {
      return `~${dataDir.slice(home.length)}`
    }
  } catch {
    /* fall through */
  }
  return typeof dataDir === 'string' ? dataDir : ''
}

/** Strip inline markdown syntax so a quote can be located in block plain text. */
function plainInline(text: string): string {
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

/**
 * Locate a quote inside the document using the shared (reader) parser,
 * returning the exact `b<index>:<fnv1a(plainText)>` key and offsets the reader
 * will anchor on.
 *
 * Sharing one parser with the reader is deliberate: a second, approximate block
 * splitter used to drift from the client (merged blockquotes, list and table
 * plain-text differences) and silently produced unrenderable anchors.
 *
 * @param markdown - parsed markdown.
 * @param quote - text selected in the reader (or copied from it).
 * @returns the located block key and offsets.
 * @throws {WireError} `bad-request` when the quote is missing or ambiguous.
 */
function locateQuote(markdown: string, quote: unknown): { blockKey: string; start: number; end: number } {
  const raw = String(quote ?? '')
  if (raw.trim() === '') throw badRequest('引文为空（Empty quote）')
  const candidates: string[] = []
  for (const candidate of [raw.trim(), raw.trim().replace(/\s+/g, ' '), plainInline(raw)]) {
    const value = candidate.trim()
    if (value !== '' && !candidates.includes(value)) candidates.push(value)
  }
  const model = parseMarkdown(String(markdown ?? ''))
  const blocks = model.blocks
  const matches: Array<{ blockKey: string; start: number; end: number }> = []
  for (const block of blocks) {
    if (!isAnnotatableBlock(block)) continue
    const text = block.plainText
    if (text === '') continue
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
  // `noUncheckedIndexedAccess`: the length checks above guarantee the entry.
  if (match === undefined) throw badRequest('文档中未找到该引文（Quote not found in the document）')
  return match
}

/** Validate an imported URL and return its normalized text. */
function normalizeImportUrl(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw badRequest('缺少 URL（Missing url）')
  if (text.length > 4096) throw badRequest('URL 过长（URL too long）')
  let parsed: URL
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
function sanitizeFileName(name: string): string {
  return String(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 255)
}

/** Resolve the imported file name from Content-Disposition, URL path, or content type. */
function fileNameFromResponse(response: Response, targetUrl: string): string {
  const header = typeof response.headers?.get === 'function' ? response.headers.get('content-disposition') : ''
  let candidate = ''
  if (typeof header === 'string' && header !== '') {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
    if (star !== null) {
      try {
        candidate = decodeURIComponent((star[1] ?? '').trim().replace(/^"|"$/g, ''))
      } catch {
        candidate = (star[1] ?? '').trim().replace(/^"|"$/g, '')
      }
    } else {
      const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
      if (plain !== null) candidate = (plain[1] ?? '').trim()
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
    const contentType = String(response.headers?.get('content-type') ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? ''
    const mapped = CONTENT_TYPE_EXTENSIONS.get(contentType)
    if (mapped !== undefined) {
      const ext = extname(candidate)
      const stem = ext === '' ? candidate : candidate.slice(0, candidate.length - ext.length)
      candidate = `${stem || 'import'}${mapped}`
    }
  }
  return candidate
}

/** Stream a fetch Response body into a freshly created file with a hard cap. */
async function writeResponseToFile(response: Response, filePath: string, maxBytes: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const stream = createWriteStream(filePath, { flags: 'wx' })
  let total = 0
  try {
    const body = response.body
    if (body !== null && typeof body.getReader === 'function') {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value ?? new Uint8Array())
        total += chunk.length
        if (total > maxBytes) {
          throw new WireError('too-large', `文件超过 ${maxBytes} 字节限制（File too large）`, 413)
        }
        if (!stream.write(chunk)) await once(stream, 'drain')
      }
    } else if (typeof response.arrayBuffer === 'function') {
      const buffer = Buffer.from(await response.arrayBuffer())
      total = buffer.length
      if (total > maxBytes) {
        throw new WireError('too-large', `文件超过 ${maxBytes} 字节限制（File too large）`, 413)
      }
      stream.write(buffer)
    } else {
      throw new WireError('bad-request', '无法读取下载内容（Cannot read download body）', 400)
    }
    await new Promise<void>((resolvePromise, reject) =>
      stream.end((error?: Error | null) => (error ? reject(error) : resolvePromise())),
    )
  } catch (error) {
    stream.destroy()
    throw error
  }
}

/**
 * One reading block with page number and annotation-ready plain text.
 */
interface ToolBlock {
  key: string
  index: number
  kind: string
  page: number | null
  plainText: string
}

/**
 * Parse a document into blocks with best-effort page numbers using the shared
 * (reader) parser.
 *
 * @param markdown - parsed markdown.
 * @param contentList - MinerU content list (used for page marks).
 * @returns blocks, outline and stats.
 */
function modelBlocks(
  markdown: string,
  contentList: ContentListEntry[] | null,
): {
  blocks: ToolBlock[]
  outline: Array<{ key: string; level: number; text: string }>
  stats: { blocks: number; headings: number; chars: number; words: number }
} {
  let model = parseMarkdown(String(markdown ?? ''))
  if (Array.isArray(contentList) && contentList.length > 0) {
    try {
      model = appendPageMarks(model, contentList)
    } catch {
      /* page marks are best effort */
    }
  }
  const blocks: ToolBlock[] = []
  let page: number | null = null
  for (const block of model.blocks) {
    if (block.kind === 'page') {
      page = Number(block.page) || page
      continue
    }
    blocks.push({
      key: block.key,
      index: block.index,
      kind: block.kind,
      page,
      plainText: block.plainText,
    })
  }
  const outline = model.outline.map((entry) => ({
    key: entry.key,
    level: entry.level,
    text: entry.text,
  }))
  return { blocks, outline, stats: model.stats }
}

/**
 * Create the shared operation service.
 *
 * @param deps - store, parse manager, resolved config and optional services.
 * @returns the service facade documented in docs/HOST-INTERFACES.md.
 */
export function createService(deps: ServiceDeps): ServiceApi {
  const { store, manager, config, logger } = deps
  if (store === undefined || store === null) throw new TypeError('createService: store is required')
  if (manager === undefined || manager === null) throw new TypeError('createService: manager is required')
  if (config === undefined || config === null || typeof config !== 'object') {
    throw new TypeError('createService: config is required')
  }
  const log: Logger = logger ?? {}
  const version =
    typeof deps.hostVersion === 'string' && deps.hostVersion !== ''
      ? deps.hostVersion
      : (config.hostVersion ?? '0.0.0')
  const doFetch: typeof fetch = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch
  const local: LocalEngineApi | null =
    deps.localEngine !== undefined && deps.localEngine !== null && typeof deps.localEngine.snapshot === 'function'
      ? deps.localEngine
      : null
  if (typeof deps.normalizeParseOptions !== 'function') {
    throw new TypeError('createService: normalizeParseOptions is required')
  }
  const normalizeParseOptions = deps.normalizeParseOptions

  /** Local engine capability snapshot (null when unavailable in this profile). */
  function localSnapshot(): ReturnType<LocalEngineApi['snapshot']> | null {
    if (local === null) return null
    try {
      return local.snapshot()
    } catch (error) {
      log.warn?.(
        '[dsh-litnotes] local engine snapshot failed: %s',
        error instanceof Error ? error.message : String(error),
      )
      return null
    }
  }

  /** Resolve whether the local engine can parse one document (never throws). */
  function localSupportOf(meta: DocumentMeta): {
    supported: boolean
    provider: string | null
    reason?: string
  } {
    if (local === null || typeof local.supports !== 'function') {
      return { supported: false, provider: null, reason: 'local engine unavailable' }
    }
    try {
      return local.supports(meta) ?? { supported: false, provider: null, reason: 'local engine unavailable' }
    } catch (error) {
      log.warn?.(
        '[dsh-litnotes] local engine probe failed: %s',
        error instanceof Error ? error.message : String(error),
      )
      return { supported: false, provider: null, reason: 'local engine probe failed' }
    }
  }

  /** The credentials service (may be undefined in minimal profiles). */
  function credentials(): CredentialsLike | undefined {
    try {
      return typeof deps.getCredentials === 'function' ? deps.getCredentials() : undefined
    } catch {
      return undefined
    }
  }

  /** The Host translator service (may be undefined). */
  function translator(): TranslatorService | undefined {
    try {
      return typeof deps.getTranslator === 'function' ? deps.getTranslator() : undefined
    } catch {
      return undefined
    }
  }

  /** The Host LLM service (may be undefined). */
  function llm(): LlmService | undefined {
    try {
      return typeof deps.getLlm === 'function' ? deps.getLlm() : undefined
    } catch {
      return undefined
    }
  }

  /** The default model selection (may be undefined). */
  function defaultModel(): ModelSelection | undefined {
    try {
      return typeof deps.getDefaultModel === 'function' ? deps.getDefaultModel() : undefined
    } catch {
      return undefined
    }
  }

  /** The AI bundle factory (may be undefined). */
  async function ai(): Promise<AiServicesApi> {
    if (typeof deps.getAi !== 'function') {
      throw new WireError('ai-unavailable', 'AI 服务不可用（AI service unavailable）', 503)
    }
    try {
      return await deps.getAi()
    } catch (error) {
      throw new WireError(
        'ai-unavailable',
        `AI 引擎加载失败：${error instanceof Error ? error.message : String(error)}`,
        503,
      )
    }
  }

  /** Ensure the library is initialized then return a document or throw not-found. */
  async function requireDocument(id: string): Promise<DocumentMeta> {
    await store.init()
    const docId = requireUuid(id)
    const meta = store.get(docId)
    if (meta === undefined) throw documentNotFound(docId)
    return meta
  }

  /** Translator provider ids available in this profile (anonymous ones first). */
  async function availableTranslatorProviders(): Promise<string[]> {
    const service = translator()
    if (service === undefined || typeof service.availableProviders !== 'function') return []
    try {
      const providers = await service.availableProviders()
      return Array.isArray(providers) ? [...providers] : []
    } catch (error) {
      log.warn?.(
        '[dsh-litnotes] cannot list translation providers: %s',
        error instanceof Error ? error.message : String(error),
      )
      return []
    }
  }

  /** Throw `translate-unavailable` after both translation backends failed. */
  function translationUnavailable(): WireError {
    return new WireError(
      'translate-unavailable',
      '翻译服务不可用，请检查翻译或模型配置（Translation unavailable; check the translator or model settings）',
      503,
    )
  }

  /** Translate through the LLM fallback, collecting the streamed text. */
  async function translateWithLlm(
    text: string,
    targetLanguage: string,
    sourceLanguage: string | undefined,
  ): Promise<{ translation: string; provider: 'llm'; model: string; targetLanguage: string }> {
    const service = llm()
    if (service === undefined || typeof service.stream !== 'function') throw translationUnavailable()
    const selection: ModelSelection | undefined = defaultModel()
    const provider = typeof selection?.provider === 'string' ? selection.provider : ''
    const model = typeof selection?.model === 'string' ? selection.model : ''
    if (provider === '' || model === '') throw translationUnavailable()
    const prompt = [
      `Target language: ${targetLanguage}`,
      sourceLanguage ? `Source language: ${sourceLanguage}` : 'Source language: auto-detect',
      '',
      text,
    ].join('\n')
    const chunks: string[] = []
    try {
      const stream = await service.stream({
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
      log.warn?.(
        '[dsh-litnotes] LLM translation failed: %s',
        error instanceof Error ? error.message : String(error),
      )
      throw translationUnavailable()
    }
    const translation = chunks.join('').trim()
    if (translation === '') throw translationUnavailable()
    return { translation, provider: 'llm', model, targetLanguage }
  }

  /**
   * Record a client health/event ping into the diagnostics log.
   *
   * @param payload - ping payload (`clientVersion`, `event`, `detail`).
   * @returns acknowledgement with the host version and receipt time.
   */
  async function healthPing(
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; hostVersion: string; receivedAt: string }> {
    const event =
      typeof payload.event === 'string' && payload.event !== '' ? payload.event.slice(0, 80) : 'active'
    const clientVersion =
      typeof payload.clientVersion === 'string' && payload.clientVersion !== ''
        ? payload.clientVersion.slice(0, 120)
        : 'unknown'
    const entry: Record<string, unknown> = { clientVersion, event }
    if (payload.detail !== undefined) {
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
  async function getStatus(): Promise<StatusValue> {
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
    const modelAvailable = Boolean(
      selection !== undefined &&
        typeof selection.provider === 'string' &&
        typeof selection.model === 'string',
    )
    const preferences = await loadPreferences(store)
    const counts = store.stats()
    const aiStatusValue = await aiStatus()
    return {
      hostVersion: version,
      version,
      dataDirDisplay: displayDataDir(config.dataDir),
      tokenConfigured: token !== undefined,
      tokenPersistent,
      translatorAvailable: providers.length > 0,
      modelAvailable,
      counts,
      preferences,
      local: localSnapshot(),
      ai: aiStatusValue,
    }
  }

  /** Compact library listing (metadata without the heavy hash field / task ids). */
  async function listDocuments(): Promise<{ documents: DocumentSummary[] }> {
    await store.init()
    const documents = store.list().map((meta): DocumentSummary => {
      const parse = meta.parse
      const options = parse?.options !== null && typeof parse?.options === 'object' ? parse.options : null
      // The list row carries only the fields the library card renders (the
      // frozen 1.0.0 wire format); full parse state stays on `library.get`.
      return {
        schemaVersion: meta.schemaVersion,
        id: meta.id,
        title: meta.title,
        originalName: meta.originalName,
        ext: meta.ext,
        mime: meta.mime,
        size: meta.size,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        status: meta.status,
        error: meta.error,
        parse:
          parse === null
            ? null
            : {
                engine: parse.engine,
                provider: parse.provider,
                local: parse.local,
                modelVersion: parse.modelVersion,
                language: parse.language,
                phase: parse.phase,
                remoteState: parse.remoteState,
                ocr: options?.isOcr === true,
                pages: parse.pages,
                progress: parse.progress,
                hasContentList: parse.hasContentList === true,
                startedAt: parse.startedAt,
                finishedAt: parse.finishedAt,
              },
      }
    })
    return { documents }
  }

  /** Full document payload: metadata + annotations + translation cache. */
  async function getDocument(id: string): Promise<{
    document: DocumentMeta
    annotations: Annotation[]
    translations: TranslationEnvelope
  }> {
    const document = await requireDocument(id)
    const [annotations, translations] = await Promise.all([
      store.loadAnnotations(document.id),
      store.loadTranslations(document.id),
    ])
    return { document, annotations: annotations.items, translations }
  }

  /** Rename one document (the only client-editable metadata field). */
  async function updateDocument(id: string, patch: { title?: string }): Promise<{ document: DocumentMeta }> {
    const document = await requireDocument(id)
    if (!isPlainObject(patch)) throw badRequest('更新内容必须是对象（Update payload must be an object）')
    const update: { title?: string } = {}
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
  async function removeDocument(id: string): Promise<{ removed: true }> {
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
   *
   * @param input - import request.
   * @returns the imported document metadata.
   */
  async function importUrl(input: { url: string; title?: string }): Promise<{ document: DocumentMeta }> {
    await store.init()
    const target = normalizeImportUrl(input.url)
    const id = randomUUID()
    const tempPath = store.newTempPath(id)
    let keepTemp = false
    try {
      const response = await doFetch(target, { method: 'GET', redirect: 'follow' })
      const status = Number(response.status ?? 200)
      if (status < 200 || status >= 300) {
        throw new WireError('bad-request', `下载失败：HTTP ${status}（Download failed）`, 400)
      }
      const contentLength = Number(response.headers?.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > config.maxUploadBytes) {
        throw new WireError(
          'too-large',
          `文件超过 ${config.maxUploadBytes} 字节限制（File too large）`,
          413,
        )
      }
      const fileName = fileNameFromResponse(response, target)
      if (!isSupportedSource(fileName)) {
        throw new WireError(
          'unsupported-type',
          `不支持的文件类型 ${extOf(fileName) || fileName}（Unsupported file type）`,
          415,
        )
      }
      await writeResponseToFile(response, tempPath, config.maxUploadBytes)
      const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title : undefined
      const meta = await store.createFromFile({ id, tempPath, originalName: fileName, title })
      keepTemp = true
      return { document: meta }
    } finally {
      if (!keepTemp) await rm(tempPath, { force: true }).catch(() => {})
    }
  }

  /**
   * Start a parse after validating engine/limits preconditions.
   *
   * `merge: true` asks for a page-scoped repair: only the listed pages (or the
   * pages the host detects as unreadable) are sent to MinerU and spliced back
   * into the existing parse, leaving every other page untouched.
   *
   * @param id - document id.
   * @param options - parse options or a page-scoped repair request.
   * @returns the updated document metadata.
   */
  async function startParse(
    id: string,
    options: ParseStartOptions,
  ): Promise<{ document: DocumentMeta }> {
    const document = await requireDocument(id)
    const requested: Record<string, unknown> = isPlainObject(options)
      ? (options as unknown as Record<string, unknown>)
      : {}
    if (requested.merge === true) {
      const rawPages = requested.pages
      const rawModelVersion = requested.modelVersion
      const repairRequest: ParseRepairRequest = {
        merge: true,
        pages: Array.isArray(rawPages) ? rawPages.filter((page): page is number => typeof page === 'number') : undefined,
        // Repair options come from the wire: only accepted enum values pass on.
        modelVersion:
          rawModelVersion === 'pipeline' || rawModelVersion === 'vlm' ? rawModelVersion : undefined,
        language: typeof requested.language === 'string' ? requested.language : undefined,
        isOcr: typeof requested.isOcr === 'boolean' ? requested.isOcr : undefined,
        enableFormula: typeof requested.enableFormula === 'boolean' ? requested.enableFormula : undefined,
        enableTable: typeof requested.enableTable === 'boolean' ? requested.enableTable : undefined,
      }
      const meta = await manager.start(document.id, repairRequest)
      return { document: meta }
    }
    const hasToken = (await getToken(credentials())) !== undefined
    const preferences = await loadPreferences(store)
    const localSupport = localSupportOf(document)
    const normalized = normalizeParseOptions(options, document, {
      hasToken,
      maxUploadBytes: config.maxUploadBytes,
      localSupported: localSupport.supported === true,
      localReason: localSupport.reason,
      localMaxBytes: local?.config.maxPdfBytes ?? 0,
      autoAllowAgentFallback: preferences.autoAllowAgentFallback !== false,
    })
    const meta = await manager.start(document.id, normalized)
    return { document: meta }
  }

  /** Cancel the document's parse task. */
  async function cancelParse(id: string): Promise<{ document: DocumentMeta }> {
    const document = await requireDocument(id)
    if (document.status !== 'parsing') {
      throw new WireError('bad-request', '没有正在进行的解析任务（No parse is in progress）', 409)
    }
    const meta = await manager.cancel(document.id)
    return { document: meta }
  }

  /** Read parsed markdown + content list + page count. */
  async function readMarkdown(id: string): Promise<ParsedDocument> {
    const document = await requireDocument(id)
    return store.readMarkdown(document.id)
  }

  /**
   * Save the complete annotation list for one document.
   *
   * When `baseIds` is supplied (the annotation ids the client had loaded before
   * editing), the store performs an additive 3-way merge so concurrent AI/agent
   * annotations are never lost; without it the historical whole-list replace
   * semantics apply.
   *
   * @param id - document id.
   * @param annotations - the client's annotation list.
   * @param baseIds - concurrency baseline ids.
   * @returns the persisted merged items.
   */
  async function saveAnnotations(
    id: string,
    annotations: Annotation[],
    baseIds?: string[],
  ): Promise<{ saved: true; items: Annotation[] }> {
    const document = await requireDocument(id)
    if (!Array.isArray(annotations)) {
      throw badRequest('annotations 必须是数组（annotations must be an array）')
    }
    const data: { items: Annotation[]; baseIds?: string[] } = {
      items: annotations,
    }
    if (Array.isArray(baseIds)) data.baseIds = baseIds
    const persisted = await store.saveAnnotations(document.id, data)
    return { saved: true, items: Array.isArray(persisted.items) ? persisted.items : [] }
  }

  /** Replace the complete translation cache. */
  async function saveTranslations(
    id: string,
    targetLanguage: string,
    entries: Record<string, string>,
  ): Promise<{ saved: true }> {
    const document = await requireDocument(id)
    if (!isPlainObject(entries)) throw badRequest('entries 必须是对象（entries must be an object）')
    const target =
      typeof targetLanguage === 'string' && targetLanguage.trim() !== ''
        ? targetLanguage.trim().slice(0, 32)
        : (await loadPreferences(store)).targetLanguage
    await store.saveTranslations(document.id, { version: 1, targetLanguage: target, entries })
    return { saved: true }
  }

  /**
   * Translate text: Host translator first (anonymous providers), LLM fallback.
   *
   * @param input - text, target language and optional routing.
   * @returns translation, provider id and resolved target language.
   */
  async function translate(input: {
    text: string
    targetLanguage?: string
    sourceLanguage?: string
    provider?: string
  }): Promise<TranslateValue> {
    const text = typeof input.text === 'string' ? input.text : ''
    if (text.trim() === '') throw badRequest('缺少待翻译文本（Missing text）')
    if (text.length > MAX_TRANSLATE_CHARS) {
      throw new WireError('too-large', `文本超过 ${MAX_TRANSLATE_CHARS} 字符限制（Text too long）`, 413)
    }
    const preferences = await loadPreferences(store)
    const target =
      typeof input.targetLanguage === 'string' && input.targetLanguage.trim() !== ''
        ? input.targetLanguage.trim().slice(0, 32)
        : preferences.targetLanguage
    const source =
      typeof input.sourceLanguage === 'string' && input.sourceLanguage.trim() !== ''
        ? input.sourceLanguage.trim().slice(0, 32)
        : undefined
    const requested = typeof input.provider === 'string' && input.provider !== '' ? input.provider : undefined
    const service = translator()
    if (service !== undefined && typeof service.resolve === 'function' && typeof service.translate === 'function') {
      const available = await availableTranslatorProviders()
      const wanted =
        requested !== undefined && ANONYMOUS_PROVIDERS.has(requested) && available.includes(requested)
          ? requested
          : undefined
      const chosen =
        wanted ?? (available.includes('google') ? 'google' : available.includes('bing') ? 'bing' : undefined)
      if (chosen !== undefined) {
        try {
          const request: TranslationRequest = {
            text,
            targetLanguage: target,
            // Provider ids come straight from the translator's own list.
            provider: chosen as TranslationProviderId,
          }
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
          log.warn?.(
            '[dsh-litnotes] translator failed: %s',
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }
    return translateWithLlm(text, target, source)
  }

  /** Settings modal payload: token state, preferences, providers and defaults. */
  async function getSettings(): Promise<SettingsValue> {
    await store.init()
    const creds = credentials()
    const token = await getToken(creds)
    const providers: Array<{ id: string; label: string }> = [{ id: 'auto', label: PROVIDER_LABELS.auto ?? 'auto' }]
    for (const id of await availableTranslatorProviders()) {
      providers.push({ id, label: PROVIDER_LABELS[id] ?? id })
    }
    const preferences = await loadPreferences(store)
    let tokenPersistent = false
    try {
      tokenPersistent = await isTokenPersistent(creds)
    } catch {
      tokenPersistent = false
    }
    return {
      tokenConfigured: token !== undefined,
      tokenPersistent,
      preferences,
      local: localSnapshot(),
      providers,
      defaults: {
        engine: preferences.defaultEngine,
        modelVersion: preferences.defaultModelVersion,
        language: preferences.defaultLanguage,
        targetLanguage: preferences.targetLanguage,
        translationProvider: preferences.translationProvider,
        autoAllowAgentFallback: preferences.autoAllowAgentFallback,
        localProvider: 'auto',
      },
    }
  }

  /** Store the MinerU API token (durably when the credential store is writable). */
  async function setToken(token: string): Promise<{ tokenConfigured: true; tokenPersistent: boolean }> {
    const value = normalizeToken(token)
    const persistent = await storeToken(credentials(), value)
    return { tokenConfigured: true, tokenPersistent: persistent }
  }

  /** Remove the stored MinerU API token. */
  async function clearToken(): Promise<{ tokenConfigured: false; tokenPersistent: boolean }> {
    await clearStoredToken(credentials())
    return { tokenConfigured: false, tokenPersistent: false }
  }

  /** Merge and persist client preferences. */
  async function updatePreferences(patch: Partial<Preferences>): Promise<{ preferences: Preferences }> {
    if (!isPlainObject(patch)) throw badRequest('preferences 必须是对象（preferences must be an object）')
    const saved = await savePreferences(store, patch)
    return { preferences: saved }
  }

  /** Compact library rows for the agent tools. */
  async function toolList(): Promise<{ documents: ToolDocumentRow[] }> {
    await store.init()
    const documents = store.list().map((meta): ToolDocumentRow => {
      const parse = meta.parse
      return {
        documentId: meta.id,
        title: meta.title ?? '',
        status: meta.status ?? 'uploaded',
        pages: typeof parse?.pages === 'number' && Number.isInteger(parse.pages) ? parse.pages : null,
        engine: typeof parse?.engine === 'string' ? parse.engine : null,
        provider: typeof parse?.provider === 'string' ? parse.provider : null,
        // Live parse progress so an Agent polling `status`/`list` can report how
        // far a long pipeline/OCR parse has come (mirrors the browser payload).
        remoteState: typeof parse?.remoteState === 'string' ? parse.remoteState : null,
        progress: parse?.progress ?? null,
        createdAt: meta.createdAt ?? '',
        error: typeof meta.error === 'string' && meta.error !== '' ? meta.error : null,
      }
    })
    return { documents }
  }

  /** Document + annotations + translation cache for the agent tools. */
  async function toolGet(id: string): Promise<{
    document: DocumentMeta
    annotations: Annotation[]
    translations: TranslationEnvelope
  }> {
    return getDocument(id)
  }

  /**
   * Read a character slice of the parsed markdown.
   *
   * @param id - document id.
   * @param options - slice options.
   */
  async function toolRead(
    id: string,
    options: { offset?: number; maxChars?: number },
  ): Promise<{
    documentId: string
    title: string
    offset: number
    markdown: string
    nextOffset: number | null
    totalChars: number
    truncated: boolean
  }> {
    const document = await requireDocument(id)
    const { markdown } = await store.readMarkdown(document.id)
    const totalChars = markdown.length
    const requestedOffset = options?.offset
    let offset = typeof requestedOffset === 'number' && Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0
    offset = Math.min(Math.max(0, offset), totalChars)
    const requestedChars = options?.maxChars
    const requested = typeof requestedChars === 'number' && Number.isFinite(requestedChars) ? Math.floor(requestedChars) : 12000
    const maxChars = Math.min(Math.max(1, requested), config.toolMaxChars ?? 40000)
    let text = markdown.slice(offset, offset + maxChars)
    // Never end the slice in the middle of a surrogate pair.
    if (text.length > 0 && /[\uD800-\uDBFF]/.test(text[text.length - 1] ?? '')) text = text.slice(0, -1)
    const nextOffset = offset + text.length
    return {
      documentId: document.id,
      title: document.title ?? '',
      offset,
      markdown: text,
      nextOffset,
      totalChars,
      truncated: nextOffset < totalChars,
    }
  }

  /** Annotation list for the agent tools. */
  async function toolAnnotations(
    id: string,
  ): Promise<{ documentId: string; annotations: Annotation[] }> {
    const document = await requireDocument(id)
    return { documentId: document.id, annotations: (await store.loadAnnotations(document.id)).items }
  }

  /**
   * Add one annotation. Without a `blockKey`, the `quote` is located in the
   * markdown and converted to the reader's `b<index>:<hash>` key.
   *
   * @param id - document id.
   * @param annotation - annotation input.
   */
  async function toolAnnotate(
    id: string,
    annotation: ToolAnnotationInput,
  ): Promise<{ annotation: Annotation; created: boolean }> {
    const document = await requireDocument(id)
    if (!isPlainObject(annotation)) throw badRequest('annotation 必须是对象（annotation must be an object）')
    const quote = typeof annotation.quote === 'string' ? annotation.quote.slice(0, 5000) : ''
    const note = typeof annotation.note === 'string' ? annotation.note.slice(0, 20000) : ''
    const aspect =
      typeof annotation.aspect === 'string' && Object.hasOwn(ASPECT_COLORS, annotation.aspect)
        ? (annotation.aspect as keyof typeof ASPECT_COLORS)
        : undefined
    const color =
      typeof annotation.color === 'string' && (ANNOTATION_COLORS as readonly string[]).includes(annotation.color)
        ? annotation.color
        : aspect !== undefined
          ? ASPECT_COLORS[aspect]
          : 'yellow'
    const origin = annotation.origin === 'ai' ? 'ai' : 'user'
    let blockKey = typeof annotation.blockKey === 'string' ? annotation.blockKey.trim() : ''
    let start = typeof annotation.start === 'number' && Number.isFinite(annotation.start) ? Math.floor(annotation.start) : undefined
    let end = typeof annotation.end === 'number' && Number.isFinite(annotation.end) ? Math.floor(annotation.end) : undefined
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
    // A caller-supplied blockKey must exist in the current parse; a stale key
    // would save an annotation the reader can never render.
    if (document.status === 'parsed') {
      try {
        const parsed = await store.readMarkdown(document.id)
        const keys = new Set(modelBlocks(parsed.markdown, parsed.contentList).blocks.map((block) => block.key))
        if (keys.size > 0 && !keys.has(blockKey)) {
          throw badRequest('blockKey 不存在于当前解析稿（blockKey not found in the current parse）')
        }
      } catch (error) {
        if (error instanceof WireError && error.code === 'bad-request') throw error
        /* not-parsed or unreadable parse: keep the annotation writable */
      }
    }
    const annotationId =
      typeof annotation.id === 'string' && annotation.id.trim() !== '' ? annotation.id.trim() : randomUUID()
    let entry: Annotation | null = null
    let created = false
    // Atomic read-modify-write through the store queue: a concurrent AI/agent
    // annotation cannot be lost between the read and the write.
    const persisted = await store.mutateAnnotations(document.id, (items) => {
      const previous = items.find((item) => item.id === annotationId)
      created = previous === undefined
      const widthRange = { start, end }
      entry = {
        id: annotationId,
        blockKey,
        start: widthRange.start,
        end: widthRange.end,
        quote,
        note,
        color: (annotation.color === undefined && previous?.color !== undefined
          ? previous.color
          : color) as AnnotationColor,
        origin: annotation.origin === undefined && previous?.origin !== undefined ? previous.origin : origin,
        ...(aspect !== undefined
          ? { aspect }
          : previous?.aspect !== undefined
            ? { aspect: previous.aspect }
            : {}),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
      }
      if (typeof annotation.chatId === 'string' && annotation.chatId !== '') {
        entry.chatId = annotation.chatId.slice(0, 200)
      }
      if (typeof annotation.messageId === 'string' && annotation.messageId !== '') {
        entry.messageId = annotation.messageId.slice(0, 200)
      }
      const modelCandidate = annotation.model
      if (
        isPlainObject(modelCandidate) &&
        typeof modelCandidate.provider === 'string' &&
        typeof modelCandidate.model === 'string'
      ) {
        entry.model = { provider: modelCandidate.provider, model: modelCandidate.model }
      }
      const next = items.filter((item) => item.id !== annotationId)
      next.push(entry)
      return next
    })
    if (entry === null) throw new WireError('host-error', '批注写入失败（Annotation write failed）', 500)
    void persisted
    return { annotation: entry, created }
  }

  /**
   * Remove one annotation by id (atomic read-modify-write, so concurrent
   * AI/agent additions are never erased by a stale whole-list save).
   *
   * @param id - document id.
   * @param annotationId - annotation id.
   */
  async function toolUnannotate(id: string, annotationId: string): Promise<{ removed: boolean }> {
    const document = await requireDocument(id)
    if (typeof annotationId !== 'string' || annotationId.trim() === '') {
      throw badRequest('缺少 annotationId（Missing annotationId）')
    }
    const target = annotationId.trim()
    let removed = false
    await store.mutateAnnotations(document.id, (items) => {
      const remaining = items.filter((item) => item.id !== target)
      if (remaining.length === items.length) return items
      removed = true
      return remaining
    })
    if (!removed) {
      throw new WireError('not-found', '批注不存在（Annotation not found）', 404)
    }
    return { removed: true }
  }

  // -------------------------------------------------------------------------
  // AI bridge (docs/AI-SPEC.md §3/§4): the service exposes the AI engines to
  // routes and tools behind one `ai-unavailable` error when they cannot load.
  // -------------------------------------------------------------------------

  /** Resolve the AI bundle even when no LLM route is configured (read-only use). */
  async function tolerantBundle(): Promise<AiServicesApi> {
    if (typeof deps.getAi !== 'function') {
      throw new WireError('ai-unavailable', 'AI 服务不可用（AI service unavailable）', 503)
    }
    return ai()
  }

  /** Resolve the AI bundle or throw the wire error the client can branch on. */
  async function aiBundle(): Promise<AiServicesApi> {
    const bundle = await ai()
    if (bundle.available === false) {
      throw new WireError('ai-unavailable', '当前配置没有可用的语言模型（No LLM route available）', 503)
    }
    return bundle
  }

  /** Resolve the knowledge-graph engine (read-only access works without an LLM route). */
  async function graphBundle(): Promise<AiServicesApi> {
    const bundle = await tolerantBundle()
    if (bundle.graph === undefined || bundle.graph === null) {
      throw new WireError('ai-unavailable', '知识图谱引擎不可用（Knowledge-graph engine unavailable）', 503)
    }
    return bundle
  }

  /** Resolve a bundle for operations that call a model (build/rebuild/ask). */
  async function modelBundle(): Promise<AiServicesApi> {
    const bundle = await aiBundle()
    if (bundle.graph === undefined || bundle.graph === null) {
      throw new WireError('ai-unavailable', '知识图谱引擎不可用（Knowledge-graph engine unavailable）', 503)
    }
    return bundle
  }

  /** Persisted chat history for one document. */
  async function chatHistory(documentId: string): Promise<{ messages: ChatMessage[] }> {
    const document = await requireDocument(documentId)
    const bundle = await tolerantBundle()
    return { messages: await bundle.chat.history(document.id) }
  }

  /** Clear the conversation for one document. */
  async function chatClear(documentId: string): Promise<{ cleared: true }> {
    const document = await requireDocument(documentId)
    const bundle = await tolerantBundle()
    await bundle.chat.clear(document.id)
    return { cleared: true }
  }

  /** Stream one grounded answer as NDJSON frames (the route consumes this). */
  async function* chatFrames(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatFrame> {
    const payload: Record<string, unknown> = isPlainObject(request) ? { ...request } : {}
    const document = await requireDocument(String(payload.documentId ?? ''))
    const bundle = await aiBundle()
    yield* bundle.chat.stream({ ...(payload as unknown as ChatRequest), documentId: document.id }, signal)
  }

  /** Stream a per-document graph build. */
  async function* graphBuildFrames(
    request: { documentId: string; force?: boolean },
    signal: AbortSignal,
  ): AsyncGenerator<GraphBuildFrame> {
    const document = await requireDocument(request.documentId)
    const bundle = await modelBundle()
    yield* bundle.graph.buildDocGraph(document.id, { force: request.force === true, signal })
  }

  /** Stream a library-graph rebuild. */
  async function* libraryGraphBuildFrames(
    signal: AbortSignal,
  ): AsyncGenerator<LibraryGraphFrame> {
    const bundle = await modelBundle()
    yield* bundle.graph.rebuildLibraryGraph({ signal })
  }

  /** Read one document's knowledge graph. */
  async function docGraph(documentId: string): Promise<{ graph: KnowledgeGraph }> {
    const document = await requireDocument(documentId)
    const bundle = await graphBundle()
    return { graph: await bundle.graph.docGraph(document.id) }
  }

  /** Merge user/agent supplied nodes, edges and curation merges into a document graph. */
  async function updateDocGraph(
    documentId: string,
    patch: GraphPatch,
  ): Promise<{ graph: KnowledgeGraph }> {
    const document = await requireDocument(documentId)
    const bundle = await graphBundle()
    const nodes = isPlainObject(patch) && Array.isArray(patch.nodes) ? patch.nodes : []
    const edges = isPlainObject(patch) && Array.isArray(patch.edges) ? patch.edges : []
    const merge = isPlainObject(patch) && Array.isArray(patch.merge) ? patch.merge : []
    return { graph: await bundle.graph.updateDocGraph(document.id, { nodes, edges, merge }) }
  }

  /** Read the library-wide knowledge graph. */
  async function libraryGraph(): Promise<{ graph: KnowledgeGraph }> {
    const bundle = await graphBundle()
    return { graph: await bundle.graph.libraryGraph() }
  }

  /** Ask the reading assistant one question and collect its final answer. */
  async function askDocument(input: {
    documentId: string
    question: string
    focusBlockKey?: string
  }): Promise<{
    documentId: string
    title: string
    answer: string
    citations: Citation[]
    unverified: Citation[]
    followups: string[]
    annotationIds: string[]
    graph: KnowledgeDelta | null
    model: ModelRoute | null
    messageId: string
  }> {
    const document = await requireDocument(input.documentId)
    const text = typeof input.question === 'string' ? input.question.trim() : ''
    if (text === '') throw badRequest('问题不能为空（question must not be empty）')
    const payload: ChatRequest = {
      documentId: document.id,
      question: text.slice(0, 8000),
    }
    if (typeof input.focusBlockKey === 'string' && input.focusBlockKey !== '') {
      payload.focus = { blockKey: input.focusBlockKey }
    }
    let answerFrame: Extract<ChatFrame, { type: 'answer' }> | null = null
    let errorFrame: Extract<ChatFrame, { type: 'error' }> | null = null
    let graphDelta: KnowledgeDelta | null = null
    let model: ModelRoute | null = null
    const controller = new AbortController()
    for await (const frame of chatFrames(payload, controller.signal)) {
      if (frame === null || typeof frame !== 'object') continue
      if (frame.type === 'start') model = frame.model
      else if (frame.type === 'answer') answerFrame = frame
      else if (frame.type === 'graph') graphDelta = frame.delta ?? null
      else if (frame.type === 'error') errorFrame = frame
    }
    if (errorFrame !== null) {
      throw new WireError(
        errorFrame.code || 'ai-failed',
        errorFrame.message || 'AI 生成失败（AI failed）',
        502,
      )
    }
    if (answerFrame === null) throw new WireError('ai-failed', 'AI 没有返回结果（Empty AI answer）', 502)
    if (typeof answerFrame.markdown !== 'string' || answerFrame.markdown.trim() === '') {
      throw new WireError(
        'ai-failed',
        'AI 没有生成可见回答（推理过程可能已用尽 token 预算）。请重试，或调高 ai.answerMaxTokens / 降低 ai.reasoningEffort。'
          + '（AI produced no visible answer; raise ai.answerMaxTokens or lower ai.reasoningEffort.）',
        502,
      )
    }
    return {
      documentId: document.id,
      title: document.title ?? '',
      answer: answerFrame.markdown.slice(0, 20000),
      citations: Array.isArray(answerFrame.citations) ? answerFrame.citations : [],
      unverified: Array.isArray(answerFrame.unverified) ? answerFrame.unverified : [],
      followups: Array.isArray(answerFrame.followups) ? answerFrame.followups : [],
      annotationIds: Array.isArray(answerFrame.annotationIds) ? answerFrame.annotationIds : [],
      graph: graphDelta,
      model,
      messageId: answerFrame.messageId,
    }
  }

  /** Token set used by the local lexical search (ASCII words + CJK bigrams). */
  function searchTokens(text: string): Set<string> {
    const normalized = String(text ?? '').toLowerCase()
    const tokens = new Set<string>()
    for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) tokens.add(match[0])
    const cjk = normalized.replace(/[^\u4e00-\u9fff]+/g, ' ')
    for (const run of cjk.split(/\s+/)) {
      if (run.length < 2) continue
      for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
    }
    return tokens
  }

  /**
   * Local lexical search across parsed documents (works without an LLM).
   *
   * @param request - query, scope, optional document id and result limit.
   * @returns matching passages with coordinates.
   */
  async function searchDocuments(request: {
    query: string
    scope?: string
    documentId?: string
    limit?: number
  }): Promise<SearchResult> {
    const query = typeof request.query === 'string' ? request.query.trim() : ''
    if (query === '') throw badRequest('查询不能为空（query must not be empty）')
    const limit = Math.min(100, Math.max(1, Math.floor(Number(request.limit) || 20)))
    const scope: 'library' | 'document' = request.scope === 'document' ? 'document' : 'library'
    const queryTokens = searchTokens(query)
    if (queryTokens.size === 0) throw badRequest('查询过于简单（query has no searchable tokens）')
    let documents: DocumentSummary[]
    if (scope === 'document') {
      const document = await requireDocument(String(request.documentId ?? ''))
      documents = [{ ...document } as DocumentSummary]
    } else {
      documents = (await listDocuments()).documents.filter((doc) => doc.status === 'parsed').slice(0, 200)
    }
    const matches: SearchHit[] = []
    let scannedBlocks = 0
    for (const doc of documents) {
      let parsed: ParsedDocument
      try {
        parsed = await store.readMarkdown(doc.id)
      } catch {
        continue
      }
      const { blocks } = modelBlocks(parsed.markdown, parsed.contentList)
      const titleTokens = searchTokens(doc.title ?? '')
      for (const block of blocks) {
        if (block.plainText === '') continue
        scannedBlocks += 1
        const tokens = searchTokens(block.plainText)
        let score = 0
        for (const token of queryTokens) {
          if (tokens.has(token)) score += 1
          if (titleTokens.has(token)) score += 0.5
        }
        if (score <= 0) continue
        const lowered = block.plainText.toLowerCase()
        const loweredQuery = query.toLowerCase()
        const at = lowered.indexOf(loweredQuery)
        const start = at >= 0 ? Math.max(0, at - 60) : 0
        const snippet = block.plainText.slice(start, start + 320)
        matches.push({
          documentId: doc.id,
          title: doc.title ?? doc.originalName ?? '',
          blockKey: block.key,
          page: block.page,
          kind: block.kind,
          score: Math.round(score * 100) / 100,
          snippet: snippet + (block.plainText.length > start + 320 ? '…' : ''),
        })
      }
    }
    matches.sort((left, right) => right.score - left.score)
    return {
      query,
      scope,
      matches: matches.slice(0, limit),
      scanned: { documents: documents.length, blocks: scannedBlocks },
      truncated: matches.length > limit,
    }
  }

  /** Blocks of one document with page numbers (for tools). */
  async function documentModel(documentId: string): Promise<DocumentModel> {
    const document = await requireDocument(documentId)
    const parsed = await store.readMarkdown(document.id)
    const model = modelBlocks(parsed.markdown, parsed.contentList)
    return {
      document: {
        id: document.id,
        title: document.title,
        status: document.status,
        pages: parsed.pages ?? document.parse?.pages ?? null,
        parse: document.parse ?? null,
      },
      markdown: parsed.markdown,
      blocks: model.blocks,
      outline: model.outline,
      stats: { ...model.stats, blocks: model.blocks.length },
    }
  }

  /** Text of specific blocks (for the translate/read tools). */
  async function blockTexts(documentId: string, blockKeys: string[]): Promise<BlockText[]> {
    const wanted = Array.isArray(blockKeys) ? blockKeys.map((key) => String(key)) : []
    if (wanted.length === 0) throw badRequest('blockKeys 不能为空（blockKeys must not be empty）')
    if (wanted.length > 20) throw badRequest('一次最多读取 20 个 block（At most 20 blocks at once）')
    const model = await documentModel(documentId)
    const byKey = new Map(model.blocks.map((block) => [block.key, block]))
    return wanted.map((key): BlockText => {
      const block = byKey.get(key)
      return block === undefined
        ? { blockKey: key, found: false, page: null, kind: null, text: '' }
        : { blockKey: key, found: true, page: block.page, kind: block.kind, text: block.plainText.slice(0, 20000) }
    })
  }

  /** Whether an AI route is configured (cheap: gateway availability only). */
  async function aiStatus(): Promise<AiStatus> {
    try {
      const bundle = await aiBundle()
      return {
        available: true,
        graph: bundle.graph !== undefined && bundle.graph !== null,
        route: typeof bundle.llm.route === 'function' ? bundle.llm.route() : null,
        retriever: Boolean(bundle.retriever),
      }
    } catch (error) {
      const reason =
        error instanceof WireError && typeof error.code === 'string' ? error.code : 'ai-unavailable'
      return { available: false, graph: false, route: null, retriever: false, reason }
    }
  }

  return {
    ASPECT_COLORS,
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
    aiStatus,
    chatHistory,
    chatClear,
    chatFrames,
    graphBuildFrames,
    libraryGraphBuildFrames,
    docGraph,
    updateDocGraph,
    libraryGraph,
    askDocument,
    searchDocuments,
    documentModel,
    blockTexts,
    toolList,
    toolGet,
    toolRead,
    toolAnnotations,
    toolAnnotate,
    toolUnannotate,
  }
}
