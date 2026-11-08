/**
 * DSH agent tools over the dsh-litnotes library (docs/AI-SPEC.md §7).
 *
 * Eight focused tools share one operations layer with the Web UI (the service
 * facade in `src/host/service.ts`). Every result that points into a document
 * carries citation-ready coordinates (`documentId`, `blockKey`, `page`,
 * `quote`) so the model can show the user exactly where a claim lives; every
 * result is bounded so a tool call can never exhaust the model context.
 *
 * Tool descriptions state behaviour (what is returned, when to use the tool)
 * and keep parameter rules on the parameters themselves.
 *
 * @module host/agent-tools
 */

import type {
  Citation,
  DeepReadHighlight,
  DeepReadPoint,
  DeepReadRecord,
  DocumentMeta,
  DocumentSummary,
  GraphNode,
  KnowledgeGraph,
  ParseStartOptions,
} from '../shared/model.ts'
import type { ResolvedConfig, ServiceApi } from './contracts.ts'
import type { ContentBlock, JsonSchema, Logger, ToolDefinition, ToolsService } from './host-services.ts'
import type { ToolAnnotationInput } from './service.ts'

/** Tool names, in discovery order. */
export const LIBRARY_TOOL_NAMES: readonly string[] = Object.freeze([
  'library_search',
  'library_read',
  'library_ask',
  'library_deepread',
  'library_annotate',
  'library_translate',
  'library_graph',
  'library_manage',
])

/** Default bound for one tool result rendered back to the model. */
const RESULT_MAX_CHARS = 16000

/** Dependencies accepted by {@link registerLibraryTools}. */
export interface AgentToolsDeps {
  tools: ToolsService | undefined
  service: ServiceApi
  config: ResolvedConfig
  logger?: Logger
}

/** A JSON-schema object helper. */
function obj(properties: Record<string, unknown>, required: readonly string[] = [], description?: string): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = [...required]
  if (typeof description === 'string') schema.description = description
  return schema
}

/** A JSON-schema array helper. */
function arr(items: JsonSchema, description?: string): JsonSchema {
  const schema: JsonSchema = { type: 'array', items }
  if (typeof description === 'string') schema.description = description
  return schema
}

/** Wrap one tool value as a bounded text content block. */
function textResult(value: unknown, maxChars: number): ContentBlock[] {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    text = String(value)
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（结果已截断，请用收窄参数继续读取 / result truncated）`
  }
  return [{ type: 'text', text }]
}

/** Wrap an operation failure for tool error reporting while keeping its wire code. */
function toolError(error: unknown): Error {
  if (error instanceof Error && error.message !== '') {
    const wrapped = new Error(error.message)
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      ;(wrapped as Error & { code?: string }).code = code
    }
    return wrapped
  }
  return new Error(String(error))
}

/** Read a required non-empty string argument. */
function requireString(args: Record<string, unknown> | undefined, key: string): string {
  const value = args !== null && typeof args === 'object' ? args[key] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing required string argument: ${key}`)
  }
  return value.trim()
}

/** Read an optional non-empty string argument. */
function optionalString(args: Record<string, unknown> | undefined, key: string, max = 8000): string | undefined {
  const value = args !== null && typeof args === 'object' ? args[key] : undefined
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined
}

/** Compact document row for tool results (accepts full metadata and list rows). */
function compactDoc(document: DocumentMeta | DocumentSummary): Record<string, unknown> {
  const parse = document.parse
  return {
    documentId: document.id,
    title: document.title ?? document.originalName ?? '',
    status: document.status ?? 'uploaded',
    pages: typeof parse?.pages === 'number' && Number.isInteger(parse.pages) ? parse.pages : null,
    engine: parse?.engine ?? null,
    provider: parse?.provider ?? null,
    error: typeof document.error === 'string' && document.error !== '' ? document.error : null,
  }
}

/** Compact citation row for tool results. */
function compactCitation(citation: Citation): Record<string, unknown> {
  return {
    blockKey: citation.blockKey,
    page: citation.page ?? null,
    quote: typeof citation.quote === 'string' ? citation.quote.slice(0, 500) : '',
    aspect: citation.aspect ?? null,
    note: typeof citation.note === 'string' ? citation.note.slice(0, 300) : '',
    verified: citation.verified !== false,
  }
}

/** Compact node row for graph tool results. */
function compactNode(node: GraphNode, maxKeyCount = 3): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    summary: typeof node.summary === 'string' ? node.summary.slice(0, 300) : '',
    aspect: node.aspect ?? null,
    blockKeys: Array.isArray(node.blockKeys) ? node.blockKeys.slice(0, maxKeyCount) : [],
    ...(Array.isArray(node.documentIds) && node.documentIds.length > 0
      ? { documentIds: node.documentIds.slice(0, 6) }
      : {}),
    weight: node.weight ?? 1,
    ...(node.curated === true ? { curated: true } : {}),
    ...(node.pinned === true ? { pinned: true } : {}),
    ...(node.position !== undefined ? { position: node.position } : {}),
  }
}

/** Compact graph summary for tool results. */
function compactGraph(graph: KnowledgeGraph | null | undefined, maxNodes = 60): Record<string, unknown> {
  if (graph === null || graph === undefined || typeof graph !== 'object') {
    return { nodes: [], edges: [], stats: null }
  }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph.edges) ? graph.edges : []
  const selected = [...nodes]
    .sort((left, right) => (Number(right.weight) || 0) - (Number(left.weight) || 0))
    .slice(0, maxNodes)
  const ids = new Set(selected.map((node) => node.id))
  return {
    scope: graph.scope ?? null,
    documentId: graph.documentId ?? null,
    generatedAt: graph.generatedAt ?? null,
    overview: typeof graph.overview === 'string' ? graph.overview.slice(0, 2000) : '',
    tldr: Array.isArray(graph.tldr) ? graph.tldr.slice(0, 8) : typeof graph.tldr === 'string' ? graph.tldr.slice(0, 2000) : [],
    nodes: selected.map((node) => compactNode(node)),
    edges: edges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .slice(0, maxNodes * 2)
      .map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, label: edge.label ?? null })),
    stats: { nodes: nodes.length, edges: edges.length, shownNodes: selected.length },
  }
}

/** Compact one report point for tool results. */
function compactDeepReadPoint(point: DeepReadPoint | undefined): Record<string, unknown> {
  return {
    label: typeof point?.label === 'string' ? point.label.slice(0, 90) : '',
    detail: typeof point?.detail === 'string' ? point.detail.slice(0, 500) : '',
    blockKeys: Array.isArray(point?.blockKeys) ? point.blockKeys.slice(0, 6) : [],
    ...(point?.evidence === undefined ? {} : { evidence: point.evidence }),
  }
}

/** Compact one deep-read highlight for tool results. */
function compactDeepReadHighlight(highlight: DeepReadHighlight): Record<string, unknown> {
  return {
    annotationId: highlight.annotationId,
    blockKey: highlight.blockKey,
    page: highlight.page ?? null,
    quote: typeof highlight.quote === 'string' ? highlight.quote.slice(0, 300) : '',
    aspect: highlight.aspect,
    note: typeof highlight.note === 'string' ? highlight.note.slice(0, 400) : '',
    importance: highlight.importance,
    section: highlight.section ?? null,
    kind: highlight.kind,
  }
}

/**
 * Compact one persisted AI 精读 record for a bounded tool result.
 *
 * The report is kept whole (the engine already bounds every field); the
 * highlight list is capped so a run with dozens of annotations cannot blow up
 * the model context, and the full count stays visible.
 *
 * @param record - persisted record, or null when the paper was never deep-read.
 * @param maxHighlights - highlight rows to include (default 60).
 * @returns the compact record, or null.
 */
function compactDeepReadRecord(
  record: DeepReadRecord | null,
  maxHighlights = 60,
): Record<string, unknown> | null {
  if (record === null || typeof record !== 'object') return null
  const report = record.report ?? ({} as DeepReadRecord['report'])
  const highlights = Array.isArray(record.highlights) ? record.highlights : []
  const list = <T>(value: T[] | undefined, cap: number): T[] =>
    Array.isArray(value) ? value.slice(0, cap) : []
  return {
    documentId: record.documentId,
    generatedAt: record.generatedAt,
    language: record.language,
    model: record.model ?? null,
    promptVersion: record.promptVersion,
    stats: record.stats ?? null,
    report: {
      tldr: list(report.tldr, 5),
      problem: compactDeepReadPoint(report.problem),
      gap: compactDeepReadPoint(report.gap),
      contributions: list(report.contributions, 8).map(compactDeepReadPoint),
      method: list(report.method, 10).map(compactDeepReadPoint),
      evaluation: list(report.evaluation, 8).map(compactDeepReadPoint),
      findings: list(report.findings, 12).map(compactDeepReadPoint),
      limitations: list(report.limitations, 8).map(compactDeepReadPoint),
      openQuestions: list(report.openQuestions, 8).map(compactDeepReadPoint),
      argumentMap: list(report.argumentMap, 16),
      glossary: list(report.glossary, 12),
      readingPath: list(report.readingPath, 3),
      verdict: {
        strengths: list(report.verdict?.strengths, 8),
        weaknesses: list(report.verdict?.weaknesses, 8),
        confidence: report.verdict?.confidence ?? 'low',
      },
    },
    highlightCount: highlights.length,
    highlightsTruncated: highlights.length > maxHighlights,
    highlights: highlights.slice(0, maxHighlights).map(compactDeepReadHighlight),
  }
}

/**
 * Register every library tool on the agent context.
 *
 * @param deps - tool registry (`ctx.get('tools')`), the operation service,
 *   resolved config and optional logger.
 * @returns a disposer that unregisters the tools (no-op without a registry).
 */
export function registerLibraryTools({ tools, service, config, logger }: AgentToolsDeps): () => void {
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    logger?.info?.('[dsh-litnotes] no tools service: agent library tools are disabled')
    return () => {}
  }
  const disposers: Array<() => void> = []
  const resultMaxChars = Math.min(RESULT_MAX_CHARS, Math.max(1000, config.toolMaxChars))
  const register = (definition: ToolDefinition): void => {
    try {
      const disposer = tools.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      logger?.warn?.(
        '[dsh-litnotes] cannot register tool %s: %s',
        definition.name,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** Build the canonical output declaration for one tool. */
  const outputOf = (
    render?: (args: unknown, value: unknown) => unknown,
  ): ToolDefinition['output'] => ({
    schema: { type: 'object' },
    render: (args, value) => textResult(render === undefined ? value : render(args, value), resultMaxChars),
  })

  // -------------------------------------------------------------------------
  // library_search
  // -------------------------------------------------------------------------
  register({
    name: 'library_search',
    description:
      'Search the local literature library. Finds matching parsed passages with blockKey/page coordinates, and document titles. Use it to locate evidence, find the paper for a topic, or check what is already in the library. Returns at most `limit` passages with short snippets; follow up with library_read for detail.',
    parameters: obj(
      {
        query: { type: 'string', description: 'Words or phrases to search for (English or Chinese).' },
        scope: {
          type: 'string',
          enum: ['library', 'document'],
          description: 'Search the whole library (default) or one document (documentId required then).',
        },
        documentId: { type: 'string', description: 'Document id; set it when scope is "document".' },
        limit: { type: 'integer', description: 'Maximum passages to return, 1-100 (default 20).' },
      },
      ['query'],
    ),
    output: outputOf(),
    async execute(args) {
      try {
        return await service.searchDocuments({
          query: requireString(args, 'query'),
          scope: optionalString(args, 'scope'),
          documentId: optionalString(args, 'documentId'),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  // -------------------------------------------------------------------------
  // library_read
  // -------------------------------------------------------------------------
  register({
    name: 'library_read',
    description:
      'Read one parsed literature document. Views: "meta" = metadata, outline, annotation count and graph overview; "text" = a bounded markdown slice from `offset` (returns nextOffset); "block" = the exact text of `blockKey` (use citations from other tools); "page" = text blocks of one page. Always returns documentId/title and page/block coordinates.',
    parameters: obj(
      {
        documentId: { type: 'string', description: 'Document id from library_search or library_manage list.' },
        view: {
          type: 'string',
          enum: ['meta', 'text', 'block', 'page'],
          description: 'What to read; default text.',
        },
        offset: { type: 'integer', description: 'Character offset for view "text" (default 0).' },
        maxChars: {
          type: 'integer',
          description: 'Slice size for view "text" (default 12000; capped by the host tool limit).',
        },
        blockKey: { type: 'string', description: 'Reader block key, e.g. b12:ab12cd34, for view "block".' },
        page: { type: 'integer', description: '1-based page number for view "page".' },
      },
      ['documentId'],
    ),
    output: outputOf(),
    async execute(args) {
      const documentId = requireString(args, 'documentId')
      const view = optionalString(args, 'view') ?? 'text'
      try {
        if (view === 'meta') {
          const model = await service.documentModel(documentId)
          let graph: Record<string, unknown> | null = null
          try {
            graph = compactGraph((await service.docGraph(documentId)).graph, 20)
          } catch {
            graph = null
          }
          return {
            documentId: model.document.id,
            title: model.document.title,
            status: model.document.status,
            pages: model.document.pages,
            parse: model.document.parse,
            stats: model.stats,
            outline: model.outline.slice(0, 40),
            blocks: model.blocks.length,
            graph,
          }
        }
        if (view === 'block') {
          const result = await service.blockTexts(documentId, [requireString(args, 'blockKey')])
          return { documentId, blocks: result }
        }
        if (view === 'page') {
          const page = Math.floor(Number(args.page))
          if (!Number.isInteger(page) || page < 1) throw new Error('view "page" needs a positive page number')
          const model = await service.documentModel(documentId)
          const blocks = model.blocks.filter((block) => block.page === page).slice(0, 80)
          if (blocks.length === 0) throw new Error(`page ${page} has no blocks in the parsed text`)
          const text = blocks.map((block) => block.plainText).join('\n\n')
          return {
            documentId,
            page,
            blocks: blocks.map((block) => ({ blockKey: block.key, kind: block.kind })),
            text: text.slice(0, 12000),
            truncated: text.length > 12000,
          }
        }
        return service.toolRead(documentId, {
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
        })
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  // -------------------------------------------------------------------------
  // library_ask
  // -------------------------------------------------------------------------
  register({
    name: 'library_ask',
    description:
      'Ask the grounded reading assistant about one document. The answer is generated only from that paper, every citation carries blockKey/page/quote coordinates, and verified citations become aspect-colored annotations in the reading desk. Use it to answer "what does this paper say about X" with traceable evidence, then quote the citations to the user.',
    parameters: obj(
      {
        documentId: { type: 'string', description: 'Document id to ask about.' },
        question: { type: 'string', description: "Question, in the user's language." },
        focusBlockKey: { type: 'string', description: 'Optional reader block key the question is about.' },
      },
      ['documentId', 'question'],
    ),
    output: outputOf(),
    async execute(args) {
      try {
        const result = await service.askDocument({
          documentId: requireString(args, 'documentId'),
          question: requireString(args, 'question'),
          focusBlockKey: optionalString(args, 'focusBlockKey'),
        })
        return {
          documentId: result.documentId,
          title: result.title,
          answer: result.answer.slice(0, 8000),
          citations: result.citations.slice(0, 20).map(compactCitation),
          unverified: result.unverified.slice(0, 20).map(compactCitation),
          followups: result.followups.slice(0, 6),
          annotationIds: result.annotationIds.slice(0, 20),
          graph: result.graph,
          model: result.model,
          messageId: result.messageId,
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  // -------------------------------------------------------------------------
  // library_deepread
  // -------------------------------------------------------------------------
  register({
    name: 'library_deepread',
    description:
      'Read or run the AI 精读 (close reading) of one parsed paper. A run reads every substantive section of the whole paper (many sequential model calls, usually minutes), writes evidence-anchored annotations to the page, and persists a structured close-reading report: one-sentence conclusion, research problem, gap, contributions with evidence strength, method, evaluation, findings, limitations, open questions, argument map, glossary, reading path and verdict. action=get returns the persisted report (null when the paper has never been deep-read) without spending tokens; action=run executes the workflow now and returns the final report. Every highlight carries blockKey/page/quote coordinates you can cite.',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['get', 'run'],
          description: 'get = the persisted report only; run = execute the workflow now.',
        },
        documentId: { type: 'string', description: 'Document id of a parsed paper.' },
        language: {
          type: 'string',
          description:
            "Optional reader language id for the report and notes (e.g. zh, en, ja); omit to use the reader's default.",
        },
      },
      ['action', 'documentId'],
    ),
    output: outputOf(),
    async execute(args, exec) {
      const documentId = requireString(args, 'documentId')
      const action = requireString(args, 'action')
      try {
        if (action === 'get') {
          const { record } = await service.deepReadRecord(documentId)
          return { documentId, record: compactDeepReadRecord(record) }
        }
        if (action === 'run') {
          const language = optionalString(args, 'language', 16)
          const controller = new AbortController()
          const signal = exec?.signal ?? controller.signal
          let record: DeepReadRecord | null = null
          let progressFrames = 0
          for await (const frame of service.deepReadFrames(
            { documentId, ...(language === undefined ? {} : { language }) },
            signal,
          )) {
            if (frame.type === 'progress') progressFrames += 1
            else if (frame.type === 'report') record = frame.record
            else if (frame.type === 'error') {
              const error = new Error(frame.message || 'AI 精读失败（deep read failed）') as Error & {
                code?: string
              }
              if (typeof frame.code === 'string') error.code = frame.code
              throw error
            }
          }
          return { documentId, record: compactDeepReadRecord(record), progressFrames }
        }
        throw new Error(`unknown action: ${action}`)
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  // -------------------------------------------------------------------------
  // library_annotate
  // -------------------------------------------------------------------------
  register({
    name: 'library_annotate',
    description:
      'List, create, update or delete highlights/notes in one document. Creating one accepts a quote (located in the text) or an explicit blockKey. Aspects color the annotation: definition (yellow), method (sage), result (sky), limitation (rose), context (yellow). Returns annotation ids and block coordinates so you can reference them.',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete'],
          description: 'Operation; default list.',
        },
        documentId: { type: 'string', description: 'Document id.' },
        annotationId: {
          type: 'string',
          description: 'Annotation id for update/delete.',
        },
        origin: {
          type: 'string',
          enum: ['user', 'ai'],
          description: 'For list: filter by provenance. For create: provenance of the new annotation (default user).',
        },
        aspect: {
          type: 'string',
          enum: ['definition', 'method', 'result', 'limitation', 'context'],
          description: 'Aspect for create/update and the aspect filter for list.',
        },
        annotation: {
          type: 'object',
          description: 'Annotation payload for create/update.',
          properties: {
            blockKey: { type: 'string', description: 'Reader block key; omit to locate the annotation by quote.' },
            quote: { type: 'string', description: 'Text to annotate/locate (verbatim from the reader).' },
            start: { type: 'integer', description: 'Start offset inside the block plain text.' },
            end: { type: 'integer', description: 'End offset inside the block plain text.' },
            note: { type: 'string', description: 'Margin note text.' },
            color: {
              type: 'string',
              enum: ['yellow', 'sage', 'sky', 'rose'],
              description: 'Highlight color; the aspect color wins by default.',
            },
          },
          additionalProperties: true,
        },
      },
      ['action', 'documentId'],
    ),
    output: outputOf(),
    async execute(args) {
      const documentId = requireString(args, 'documentId')
      const action = optionalString(args, 'action') ?? 'list'
      try {
        if (action === 'list') {
          const payload = await service.getDocument(documentId)
          const origin = optionalString(args, 'origin')
          const aspect = optionalString(args, 'aspect')
          const annotations = payload.annotations.filter(
            (item) =>
              (origin === undefined || item.origin === origin) &&
              (aspect === undefined || item.aspect === aspect),
          )
          return { documentId, count: annotations.length, annotations: annotations.slice(0, 100) }
        }
        if (action === 'delete') {
          return await service.toolUnannotate(documentId, requireString(args, 'annotationId'))
        }
        const annotationInput =
          args.annotation !== null && typeof args.annotation === 'object'
            ? (args.annotation as Record<string, unknown>)
            : {}
        // Nested annotation fields win; the documented top-level `aspect` (and
        // the note/color convenience fields) are accepted as fallbacks so an
        // agent passing the top-level shape is not silently ignored.
        const payload: ToolAnnotationInput = {
          blockKey:
            typeof annotationInput.blockKey === 'string' ? annotationInput.blockKey : '',
          quote: typeof annotationInput.quote === 'string' ? annotationInput.quote : undefined,
          note:
            typeof annotationInput.note === 'string'
              ? annotationInput.note
              : optionalString(args, 'note', 20000),
          color:
            typeof annotationInput.color === 'string'
              ? annotationInput.color
              : optionalString(args, 'color', 32),
          aspect:
            typeof annotationInput.aspect === 'string'
              ? annotationInput.aspect
              : optionalString(args, 'aspect', 32),
          origin: optionalString(args, 'origin') === 'ai' ? 'ai' : 'user',
        }
        if (typeof annotationInput.start === 'number') payload.start = annotationInput.start
        if (typeof annotationInput.end === 'number') payload.end = annotationInput.end
        if (action === 'update') {
          const annotationId = optionalString(args, 'annotationId')
          if (annotationId !== undefined) payload.id = annotationId
        }
        return await service.toolAnnotate(documentId, payload)
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  // -------------------------------------------------------------------------
  // library_translate
  // -------------------------------------------------------------------------
  register({
    name: 'library_translate',
    description:
      "Translate text or specific parsed blocks of a document into the reader's target language. Pass `text` for arbitrary text, or `blockKeys` (up to 10) to translate passages identified by citations. Returns each block's page and source snippet with its translation.",
    parameters: obj(
      {
        documentId: { type: 'string', description: 'Document id (required for blockKeys).' },
        text: { type: 'string', description: 'Arbitrary text to translate; omit to translate blocks.' },
        blockKeys: arr({ type: 'string' }, 'Parsed block keys to translate (max 10).'),
        targetLanguage: { type: 'string', description: 'Target language code, e.g. zh or en.' },
        provider: { type: 'string', description: 'Optional translation provider id from library_manage status.' },
      },
      ['documentId'],
    ),
    output: outputOf(),
    async execute(args) {
      const documentId = requireString(args, 'documentId')
      const targetLanguage = optionalString(args, 'targetLanguage', 32)
      const provider = optionalString(args, 'provider', 64)
      try {
        if (typeof args.text === 'string' && args.text.trim() !== '') {
          return {
            ...(await service.translate({ text: args.text.trim().slice(0, 20000), targetLanguage, provider })),
            documentId,
          }
        }
        const keys = Array.isArray(args.blockKeys)
          ? args.blockKeys.filter((key): key is string => typeof key === 'string').slice(0, 10)
          : []
        if (keys.length === 0) throw new Error('provide text or blockKeys')
        const blocks = await service.blockTexts(documentId, keys)
        const translations: Array<Record<string, unknown>> = []
        for (const block of blocks) {
          if (block.found !== true || block.text.trim() === '') {
            translations.push({ blockKey: block.blockKey, found: false })
            continue
          }
          const value = await service.translate({
            text: block.text.slice(0, 20000),
            targetLanguage,
            provider,
          })
          translations.push({
            blockKey: block.blockKey,
            page: block.page,
            source: block.text.slice(0, 400),
            translation: value.translation,
            provider: value.provider,
          })
        }
        return { documentId, translations }
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  // -------------------------------------------------------------------------
  // library_graph
  // -------------------------------------------------------------------------
  register({
    name: 'library_graph',
    description:
      "Work with knowledge graphs. action=get: one paper's graph; search: find nodes by text; build: read the paper and extract its graph (may take a while); update: add nodes/edges; library: the whole-library graph; rebuild: regenerate the library graph from per-paper graphs. Nodes carry blockKeys that point into the text.",
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['get', 'search', 'build', 'update', 'library', 'rebuild'],
          description: 'Operation.',
        },
        documentId: { type: 'string', description: 'Document id for get/search/build/update.' },
        query: { type: 'string', description: 'Search words for action=search (searches labels and summaries).' },
        force: { type: 'boolean', description: 'For build: rebuild even if a graph exists.' },
        nodes: arr(
          { type: 'object', additionalProperties: true },
          'Nodes to add/merge (update): [{id?, type?, label, summary?, blockKeys?, aspect?, weight?, pinned?, position?}].',
        ),
        edges: arr(
          { type: 'object', additionalProperties: true },
          'Edges to add/merge (update): [{id?, from, to, type?, label?, weight?}].',
        ),
        merge: arr(
          { type: 'object', additionalProperties: true },
          'Node pairs to fold for action=update: [{"from": "<nodeId>", "into": "<nodeId>"}] (from is removed, its edges/evidence move to into).',
        ),
      },
      ['action'],
    ),
    output: outputOf(),
    async execute(args) {
      const action = requireString(args, 'action')
      try {
        if (action === 'library') return compactGraph((await service.libraryGraph()).graph, 80)
        if (action === 'rebuild') {
          let graph: KnowledgeGraph | null = null
          let progress = 0
          for await (const frame of service.libraryGraphBuildFrames(new AbortController().signal)) {
            if (frame.type === 'progress') progress += 1
            else if (frame.type === 'graph') graph = frame.graph
            else if (frame.type === 'error') throw new Error(frame.message || 'library graph rebuild failed')
          }
          return { ...compactGraph(graph, 80), progressFrames: progress }
        }
        const documentId = requireString(args, 'documentId')
        if (action === 'get') return compactGraph((await service.docGraph(documentId)).graph, 80)
        if (action === 'search') {
          const query = requireString(args, 'query').toLowerCase()
          const graph = (await service.docGraph(documentId)).graph
          const nodes = (graph.nodes ?? []).filter(
            (node) =>
              String(node.label ?? '').toLowerCase().includes(query) ||
              String(node.summary ?? '').toLowerCase().includes(query),
          )
          const ids = new Set(nodes.map((node) => node.id))
          return {
            documentId,
            query,
            nodes: nodes.slice(0, 40).map((node) => compactNode(node)),
            edges: (graph.edges ?? []).filter((edge) => ids.has(edge.from) || ids.has(edge.to)).slice(0, 80),
          }
        }
        if (action === 'build') {
          let graph: KnowledgeGraph | null = null
          let progressFrames = 0
          for await (const frame of service.graphBuildFrames(
            { documentId, force: args.force === true },
            new AbortController().signal,
          )) {
            if (frame.type === 'progress') progressFrames += 1
            else if (frame.type === 'graph') graph = frame.graph
            else if (frame.type === 'error') throw new Error(frame.message || 'graph build failed')
          }
          return { documentId, ...compactGraph(graph, 80), progressFrames }
        }
        if (action === 'update') {
          const graph = (
            await service.updateDocGraph(documentId, {
              nodes: Array.isArray(args.nodes) ? (args.nodes as never) : [],
              edges: Array.isArray(args.edges) ? (args.edges as never) : [],
              merge: Array.isArray(args.merge) ? (args.merge as never) : [],
            })
          ).graph
          return { documentId, ...compactGraph(graph, 80) }
        }
        throw new Error(`unknown action: ${action}`)
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  // -------------------------------------------------------------------------
  // library_manage
  // -------------------------------------------------------------------------
  register({
    name: 'library_manage',
    description:
      'Manage the literature library: list documents, read import/parse status, import a paper from a URL, start a parse, cancel a running parse, repair pages of an existing parse, rename a paper, or delete one. "auto" parsing prefers local extraction when the file type is supported (no token, never uploads the file); otherwise the token-free lightweight cloud API is used. A parse start returns immediately; poll action=status for progress.',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['list', 'status', 'import_url', 'parse', 'cancel', 'repair', 'update', 'delete'],
          description: 'Operation.',
        },
        documentId: { type: 'string', description: 'Document id (required except list/status/import_url).' },
        url: { type: 'string', description: 'http(s) file URL for import_url.' },
        title: { type: 'string', description: 'Optional title for import_url or update.' },
        parse: {
          type: 'object',
          description: 'Parse options for action=parse.',
          properties: {
            engine: {
              type: 'string',
              enum: ['auto', 'standard', 'local', 'agent'],
              description:
                'auto (default) picks the cheapest engine that can handle the file; local = on-device text extraction, never uploads; standard/agent use the cloud API and need a MinerU token.',
            },
            localProvider: {
              type: 'string',
              enum: ['auto', 'builtin', 'system:officeToPdf'],
              description: 'Local engine provider override (local only).',
            },
            modelVersion: { type: 'string', enum: ['pipeline', 'vlm'], description: 'Cloud model version; default vlm.' },
            language: { type: 'string', description: 'OCR language code such as ch or en; default ch.' },
            isOcr: { type: 'boolean', description: 'Force OCR.' },
            enableFormula: { type: 'boolean', description: 'Parse formulas; default true.' },
            enableTable: { type: 'boolean', description: 'Parse tables; default true.' },
            pageRanges: { type: 'string', description: 'Page selection such as "2,4-6"; empty means all pages.' },
          },
          additionalProperties: false,
        },
        pages: arr(
          { type: 'integer' },
          '1-based pages for action=repair; omit to repair the pages the host detects as unreadable.',
        ),
      },
      ['action'],
    ),
    output: outputOf(),
    async execute(args) {
      const action = requireString(args, 'action')
      try {
        if (action === 'list') {
          const value = await service.listDocuments()
          return {
            total: value.documents.length,
            documents: value.documents.slice(0, 100).map((document) => compactDoc(document)),
          }
        }
        if (action === 'status') {
          const status = await service.getStatus()
          return {
            version: status.version,
            tokenConfigured: status.tokenConfigured,
            translatorAvailable: status.translatorAvailable,
            modelAvailable: status.modelAvailable,
            dataDir: status.dataDirDisplay,
            counts: status.counts,
            ai: status.ai,
            local: status.local,
          }
        }
        if (action === 'import_url') {
          const value = await service.importUrl({
            url: requireString(args, 'url'),
            title: optionalString(args, 'title'),
          })
          return { ...compactDoc(value.document), imported: true }
        }
        const documentId = requireString(args, 'documentId')
        if (action === 'parse') {
          const parseOptions: ParseStartOptions =
            args.parse !== null && typeof args.parse === 'object' ? (args.parse as ParseStartOptions) : {}
          const value = await service.startParse(documentId, parseOptions)
          return { ...compactDoc(value.document), parsing: true }
        }
        if (action === 'repair') {
          const pages = Array.isArray(args.pages)
            ? args.pages.filter((page): page is number => typeof page === 'number')
            : undefined
          const value = await service.startParse(documentId, { merge: true, pages })
          return { ...compactDoc(value.document), repairing: true, parse: value.document.parse }
        }
        if (action === 'cancel') {
          return { ...compactDoc((await service.cancelParse(documentId)).document), cancelled: true }
        }
        if (action === 'update') {
          const title = optionalString(args, 'title')
          if (title === undefined) throw new Error('title is required for update')
          return compactDoc((await service.updateDocument(documentId, { title })).document)
        }
        if (action === 'delete') {
          await service.removeDocument(documentId)
          return { documentId, removed: true }
        }
        throw new Error(`unknown action: ${action}`)
      } catch (error) {
        throw toolError(error)
      }
    },
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* tool already disposed */
      }
    }
  }
}
