/**
 * The `mineru` agent tool: the model-facing face of the same operation service
 * used by the browser client (`lib/service.js`).
 *
 * One JSON object result per call, rendered as compact readable text.
 * Document ids are the only handles the model needs; list → read → annotate is
 * the intended flow. Parsing is asynchronous: `parse` returns immediately and
 * the document's `status`/`parse.progress` are reported by `status`/`list`.
 *
 * @module lib/agent-tool
 */

/** Tool name; must not collide with a built-in Harness tool. */
export const TOOL_NAME = 'mineru'

/** Actions the tool accepts. */
const ACTIONS = [
  'list',
  'status',
  'get',
  'import_url',
  'parse',
  'read',
  'annotations',
  'annotate',
  'unannotate',
  'translate',
  'delete',
  'update',
]

/** Parameter schema (JSON Schema subset supported by the Harness tool registry). */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description:
        'Operation to perform. list/status/get/read first to discover documents; parse starts an async MinerU parse; read returns a bounded markdown slice.',
    },
    documentId: {
      type: 'string',
      description: 'Document uuid from list/get. Required for every action except list, status and import_url.',
    },
    url: {
      type: 'string',
      description: 'http(s) URL of a document to download into the library (import_url only). Must be ≤ the configured upload limit.',
    },
    title: {
      type: 'string',
      description: 'Optional display title (import_url, update). Defaults to the file-name stem.',
    },
    text: {
      type: 'string',
      description: 'Text to translate (translate only; ≤ 20000 characters).',
    },
    targetLanguage: {
      type: 'string',
      description: 'Translation target language tag such as zh or en (translate only; defaults to the stored preference).',
    },
    offset: {
      type: 'integer',
      description: 'Character offset to start reading from (read only; default 0).',
    },
    maxChars: {
      type: 'integer',
      description: 'Maximum characters to return (read only; default 12000, capped by the host).',
    },
    parse: {
      type: 'object',
      description: 'Parse options (parse only).',
      properties: {
        engine: {
          type: 'string',
          enum: ['auto', 'standard', 'agent'],
          description: 'auto uses the standard API when a MinerU token is configured, otherwise the token-free agent API.',
        },
        modelVersion: {
          type: 'string',
          enum: ['pipeline', 'vlm'],
          description: 'Standard API model version; default vlm.',
        },
        language: {
          type: 'string',
          description: 'OCR language code such as ch or en; default ch.',
        },
        isOcr: { type: 'boolean', description: 'Force OCR.' },
        enableFormula: { type: 'boolean', description: 'Parse formulas; default true.' },
        enableTable: { type: 'boolean', description: 'Parse tables; default true.' },
        pageRanges: {
          type: 'string',
          description: 'Page selection such as "2,4-6"; empty means all pages.',
        },
        merge: {
          type: 'boolean',
          description:
            'Page-scoped repair: re-parse only the listed pages (or the pages MinerU failed to read) and splice them '
            + 'into the existing parse; other pages and their annotations stay untouched. Requires a parsed document and a MinerU token.',
        },
        pages: {
          type: 'array',
          items: { type: 'integer' },
          description: '1-based page numbers to repair when merge is true; omitted = the host detects unreadable pages.',
        },
      },
      additionalProperties: false,
    },
    annotation: {
      type: 'object',
      description:
        'Annotation payload (annotate/unannotate). For annotate pass blockKey from a selection, or quote to locate the block by text. For unannotate pass id.',
      properties: {
        id: {
          type: 'string',
          description: 'Existing annotation id (unannotate; also targets an update on annotate).',
        },
        blockKey: {
          type: 'string',
          description: 'Reader block key of the client parser, format b<index>:<hash>. Required when quote is omitted.',
        },
        start: { type: 'integer', description: 'Start offset inside the block plain text.' },
        end: { type: 'integer', description: 'End offset inside the block plain text.' },
        quote: {
          type: 'string',
          description: 'Quoted text; with annotate it is located in the markdown to derive blockKey/start/end.',
        },
        note: { type: 'string', description: 'Margin note text.' },
        color: {
          type: 'string',
          enum: ['yellow', 'sage', 'sky', 'rose'],
          description: 'Highlight color; default yellow.',
        },
      },
      additionalProperties: false,
    },
  },
  required: ['action'],
  additionalProperties: false,
}

/** Output schema: one JSON object per call (shape varies by action). */
const OUTPUT_SCHEMA = { type: 'object' }

/** Truncate long rendered text without splitting a surrogate pair. */
function truncateText(text, limit) {
  if (text.length <= limit) return text
  let end = limit
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1
  return `${text.slice(0, end)}\n…（已截断，共 ${text.length} 字符 / truncated）`
}

/** Render a JSON value as a compact text block. */
function renderJson(value) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return truncateText(text, 12000)
}

/**
 * Format one action's canonical result for the model.
 * @param {string} action - tool action.
 * @param {Record<string, any>} value - canonical result value.
 * @returns {string} model-facing text.
 */
function renderText(action, value) {
  switch (action) {
    case 'list': {
      const rows = Array.isArray(value?.documents) ? value.documents : []
      if (rows.length === 0) return '文献库为空。先用 import_url 导入，或让用户在界面中上传文件。'
      const lines = rows.map((row, index) => {
        const pages = Number.isInteger(row.pages) ? `${row.pages} 页` : '页数未知'
        const engine = row.engine !== null && row.engine !== undefined ? `，${row.engine}` : ''
        const progress = row.status === 'parsing' && row.progress !== null && row.progress !== undefined
          && Number.isFinite(Number(row.progress.total)) && Number(row.progress.total) > 0
          ? `，进度 ${Math.max(0, Number(row.progress.extracted) || 0)}/${Number(row.progress.total)} 页`
          : ''
        const upstream = row.status === 'parsing' && typeof row.remoteState === 'string' && row.remoteState !== ''
          ? `，MinerU ${row.remoteState}`
          : ''
        const error = typeof row.error === 'string' && row.error !== '' ? `，错误：${row.error}` : ''
        return `${index + 1}. [${row.status}] ${row.title || '(未命名)'} — id=${row.id}（${pages}${engine}${progress}${upstream}${error}）`
      })
      return `共 ${rows.length} 篇文档：\n${lines.join('\n')}`
    }
    case 'read': {
      const range = `${value.offset}–${value.nextOffset} / ${value.totalChars}`
      const more = value.truncated
        ? `\n\n（仍有内容；再次调用 read，offset=${value.nextOffset}）`
        : '\n\n（已读到末尾）'
      return `${value.text}${more}\n\n字符范围：${range}`
    }
    case 'translate':
      return `${value.translation}\n\n（目标语言：${value.targetLanguage}，provider：${value.provider}）`
    case 'parse':
    case 'update':
    case 'delete':
    case 'import_url':
    case 'annotate':
    case 'unannotate': {
      const document = value?.document
      if (document) {
        const phase = document.parse?.phase
        return `文档 ${document.id}：${document.title}，状态 ${document.status}${phase ? `（${phase}）` : ''}${
          document.error ? `，错误：${document.error}` : ''
        }`
      }
      return renderJson(value)
    }
    case 'status': {
      const counts = value?.counts ?? {}
      const docs = Array.isArray(value?.documents) ? value.documents : []
      const header = `Host ${value?.version ?? ''}；文档 ${counts.total ?? docs.length} 篇（已解析 ${counts.parsed ?? 0}，解析中 ${counts.parsing ?? 0}，失败 ${counts.failed ?? 0}）；Token ${value?.tokenConfigured ? '已配置' : '未配置'}；翻译 ${value?.translatorAvailable ? '可用' : '不可用'}；默认模型 ${value?.modelAvailable ? '可用' : '不可用'}；数据目录 ${value?.dataDirDisplay ?? ''}；按页修复 ${value?.tokenConfigured ? '可用' : '需 Token'}`
      return docs.length > 0 ? `${header}\n${renderText('list', { documents: docs })}` : header
    }
    default:
      return renderJson(value)
  }
}

/**
 * Register the `mineru` agent tool.
 *
 * @param {{
 *   ctx: { get(name: string): unknown },
 *   service: object,
 *   config: { toolMaxChars?: number },
 *   logger?: { warn?: Function, info?: Function },
 * }} options - plugin context, operation service, resolved config and logger.
 * @returns {() => void} disposer that unregisters the tool (no-op without a
 *   tool registry in the profile).
 */
export function registerAgentTool({ ctx, service, config, logger } = {}) {
  if (!service) throw new TypeError('registerAgentTool: service is required')
  const log = logger ?? {}

  /** Ensure a document id argument is present. */
  function requireDocumentId(args) {
    const id = typeof args?.documentId === 'string' ? args.documentId.trim() : ''
    if (id === '') throw new Error('documentId is required for this action')
    return id
  }

  /** Execute one action against the service. */
  async function executeAction(args) {
    const action = args.action
    switch (action) {
      case 'list':
        return service.toolList()
      case 'status': {
        const [status, list] = await Promise.all([service.getStatus(), service.toolList()])
        return { ...status, documents: list.documents }
      }
      case 'get':
        return service.toolGet(requireDocumentId(args))
      case 'import_url': {
        if (typeof args.url !== 'string' || args.url.trim() === '') {
          throw new Error('url is required for import_url')
        }
        return service.importUrl({ url: args.url, title: args.title })
      }
      case 'parse':
        return service.startParse(requireDocumentId(args), args.parse ?? {})
      case 'read':
        return service.toolRead(requireDocumentId(args), {
          offset: args.offset,
          maxChars: args.maxChars,
        })
      case 'annotations':
        return service.toolAnnotations(requireDocumentId(args))
      case 'annotate':
        return service.toolAnnotate(requireDocumentId(args), args.annotation ?? {})
      case 'unannotate': {
        const annotationId =
          typeof args?.annotation?.id === 'string' && args.annotation.id.trim() !== ''
            ? args.annotation.id.trim()
            : ''
        if (annotationId === '') throw new Error('annotation.id is required for unannotate')
        return service.toolUnannotate(requireDocumentId(args), annotationId)
      }
      case 'translate': {
        if (typeof args.text !== 'string' || args.text.trim() === '') {
          throw new Error('text is required for translate')
        }
        return service.translate({ text: args.text, targetLanguage: args.targetLanguage })
      }
      case 'delete':
        return service.removeDocument(requireDocumentId(args))
      case 'update': {
        if (typeof args.title !== 'string' || args.title.trim() === '') {
          throw new Error('title is required for update')
        }
        return service.updateDocument(requireDocumentId(args), { title: args.title })
      }
      default:
        throw new Error(`unknown action: ${String(action)}`)
    }
  }

  const definition = {
    name: TOOL_NAME,
    description:
      'Manage the local literature library and read parsed papers. list shows documents; parse starts an asynchronous MinerU parse and returns immediately (use status for progress); read returns bounded markdown slices and reports nextOffset; annotate/unannotate manage highlights and margin notes.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const action = typeof _args?.action === 'string' ? _args.action : ''
        return [{ type: 'text', text: renderText(action, value) }]
      },
    },
    /**
     * Run one accepted call.
     * @param {Record<string, any>} args - schema-validated arguments.
     * @param {{ signal?: AbortSignal }} exec - execution context.
     * @returns {Promise<Record<string, any>>} canonical result object.
     */
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('cancelled')
      return executeAction(args ?? {})
    },
  }

  /** Register the definition and return its disposer. */
  function registerOn(tools) {
    const dispose = tools.register(definition)
    log.info?.('[dsh-litnotes] agent tool registered as %s', TOOL_NAME)
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        log.warn?.('[dsh-litnotes] tool disposer failed: %s', error?.message ?? error)
      }
    }
  }

  let tools
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
  } catch {
    tools = undefined
  }
  if (tools && typeof tools.register === 'function') return registerOn(tools)

  // The tool registry is an optional service: when the Host profile loads it
  // after this plugin, wait for it instead of dropping the capability.
  if (typeof ctx?.inject === 'function') {
    let fiber
    try {
      fiber = ctx.inject(['tools'], (scoped) => {
        const scopedTools = typeof scoped?.get === 'function' ? scoped.get('tools') : undefined
        if (!scopedTools || typeof scopedTools.register !== 'function') return
        const register = () => registerOn(scopedTools)
        if (typeof scoped.effect === 'function') scoped.effect(register, 'dsh-litnotes: agent tool')
        else register()
      })
    } catch (error) {
      log.warn?.('[dsh-litnotes] cannot defer agent tool registration: %s', error?.message ?? error)
      fiber = undefined
    }
    return () => {
      try {
        if (typeof fiber?.dispose === 'function') fiber.dispose()
      } catch (error) {
        log.warn?.('[dsh-litnotes] deferred tool disposer failed: %s', error?.message ?? error)
      }
    }
  }

  log.warn?.('[dsh-litnotes] tool registry unavailable; the mineru agent tool is disabled')
  return () => {}
}
