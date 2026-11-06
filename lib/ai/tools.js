/**
 * DSH agent tools over the dsh-litnotes library (docs/AI-SPEC.md §7).
 *
 * Seven focused tools share one operations layer with the Web UI (the service
 * bridge in `lib/service.js`). Every result that points into a document carries
 * citation-ready coordinates (`documentId`, `blockKey`, `page`, `quote`) so the
 * model can show the user exactly where a claim lives.
 *
 * @module lib/ai/tools
 */

/** Tool names, in discovery order. */
export const LIBRARY_TOOL_NAMES = Object.freeze([
  'library_search',
  'library_read',
  'library_ask',
  'library_annotate',
  'library_translate',
  'library_graph',
  'library_manage',
])

/** Bound for one tool result rendered back to the model. */
const RESULT_MAX_CHARS = 16000

/** A JSON-schema object helper. */
function obj(properties, required = [], description) {
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  if (typeof description === 'string') schema.description = description
  return schema
}

/** A JSON-schema array helper. */
function arr(items, description) {
  const schema = { type: 'array', items }
  if (typeof description === 'string') schema.description = description
  return schema
}

/** Wrap one tool value as a bounded text content block. */
function textResult(value, maxChars = RESULT_MAX_CHARS) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（结果已截断，请用收窄参数继续读取 / result truncated）`
  }
  return [{ type: 'text', text }]
}

/** Throw a plain Error with the wire message for tool failure reporting. */
function toolError(error) {
  if (error && typeof error.message === 'string' && error.message !== '') {
    const wrapped = new Error(error.message)
    if (typeof error.code === 'string') wrapped.code = error.code
    return wrapped
  }
  return new Error(String(error))
}

/** Read a required non-empty string argument. */
function requireString(args, key) {
  const value = args !== null && typeof args === 'object' ? args[key] : undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`missing required string argument: ${key}`)
  return value.trim()
}

/** Read an optional string argument. */
function optionalString(args, key, max = 8000) {
  const value = args !== null && typeof args === 'object' ? args[key] : undefined
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined
}

/** Compact document row for tool results. */
function compactDoc(document) {
  return {
    documentId: document.id,
    title: document.title ?? document.originalName ?? '',
    status: document.status ?? 'uploaded',
    pages: Number.isInteger(document.parse?.pages) ? document.parse.pages : null,
    engine: document.parse?.engine ?? null,
    error: typeof document.error === 'string' && document.error !== '' ? document.error : null,
  }
}

/** Compact citation row for tool results. */
function compactCitation(citation) {
  if (citation === null || typeof citation !== 'object') return null
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
function compactNode(node, maxKeyCount = 3) {
  if (node === null || typeof node !== 'object') return null
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    summary: typeof node.summary === 'string' ? node.summary.slice(0, 300) : '',
    aspect: node.aspect ?? null,
    blockKeys: Array.isArray(node.blockKeys) ? node.blockKeys.slice(0, maxKeyCount) : [],
    documentIds: Array.isArray(node.documentIds) ? node.documentIds.slice(0, 6) : undefined,
    weight: node.weight ?? 1,
  }
}

/** Compact graph summary for tool results. */
function compactGraph(graph, maxNodes = 60) {
  if (graph === null || typeof graph !== 'object') return { nodes: [], edges: [], stats: null }
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
    tldr: Array.isArray(graph.tldr)
      ? graph.tldr.slice(0, 8)
      : (typeof graph.tldr === 'string' ? graph.tldr.slice(0, 2000) : []),
    nodes: selected.map((node) => compactNode(node)),
    edges: edges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .slice(0, maxNodes * 2)
      .map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, label: edge.label ?? null })),
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      shownNodes: selected.length,
    },
  }
}

/**
 * Register every library tool on the agent context.
 *
 * @param {{
 *   tools: { register: Function } | undefined,
 *   service: ReturnType<import('../service.js').createService>,
 *   config: Record<string, any>,
 *   logger?: Record<string, Function>,
 * }} deps - host wiring (`tools` comes from ctx.get('tools'), never a
 *   bare ctx property: Cordis rejects undeclared service access).
 * @returns {() => void} disposer that unregisters the tools.
 */
export function registerLibraryTools({ tools, service, config, logger } = {}) {
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    logger?.info?.('[dsh-litnotes] no tools service: agent library tools are disabled')
    return () => {}
  }
  const disposers = []
  const register = (definition) => {
    try {
      const disposer = tools.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      logger?.warn?.('[dsh-litnotes] cannot register tool %s: %s', definition.name, error?.message ?? error)
    }
  }

  const outputOf = (render) => ({
    schema: { type: 'object' },
    render: (args, value) => textResult(render === undefined ? value : render(args, value)),
  })

  // -------------------------------------------------------------------------
  // library_search
  // -------------------------------------------------------------------------
  register({
    name: 'library_search',
    description:
      'Search the local literature library. Finds matching parsed passages (with blockKey/page coordinates), and document titles. Use it to locate evidence, find the paper for a topic, or check what is already in the library. Returns at most `limit` passages with short snippets; follow up with library_read or library_ask for detail.',
    parameters: obj({
      query: { type: 'string', description: 'Words or phrases to search for (English or Chinese).' },
      scope: {
        type: 'string',
        enum: ['library', 'document'],
        description: "Search the whole library (default) or one document (requires documentId).",
      },
      documentId: { type: 'string', description: 'Document id when scope is "document".' },
      limit: { type: 'integer', description: 'Maximum passages to return, 1-50 (default 20).' },
    }, ['query']),
    output: outputOf(),
    async execute(args) {
      try {
        return await service.searchDocuments({
          query: requireString(args, 'query'),
          scope: optionalString(args, 'scope'),
          documentId: optionalString(args, 'documentId'),
          limit: args?.limit,
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
      'Read one literature document. Views: "meta" = metadata, outline, annotation count and graph overview; "text" = a bounded markdown slice from `offset` (returns nextOffset); "block" = the exact text of `blockKey` (use citations from other tools); "page" = text blocks of one page. Always returns documentId/title and page/block coordinates when available.',
    parameters: obj({
      documentId: { type: 'string', description: 'Document id from library_search or library_manage list.' },
      view: {
        type: 'string',
        enum: ['meta', 'text', 'block', 'page'],
        description: 'What to read; default text.',
      },
      offset: { type: 'integer', description: 'Character offset for view "text" (default 0).' },
      maxChars: { type: 'integer', description: 'Slice size for view "text" (default 12000, capped).' },
      blockKey: { type: 'string', description: 'Reader block key, e.g. b12:ab12cd34, for view "block".' },
      page: { type: 'integer', description: '1-based page number for view "page".' },
    }, ['documentId']),
    output: outputOf(),
    async execute(args) {
      const documentId = requireString(args, 'documentId')
      const view = optionalString(args, 'view') ?? 'text'
      try {
        if (view === 'meta') {
          const model = await service.documentModel(documentId)
          let graph = null
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
          const page = Math.floor(Number(args?.page))
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
        return { documentId, ...(await service.toolRead(documentId, { offset: args?.offset, maxChars: args?.maxChars })) }
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
      'Ask the grounded reading assistant about one document. The answer is generated only from that paper, every citation carries blockKey/page/quote coordinates, and verified citations automatically become aspect-colored annotations in the reading desk. Use it to answer "what does this paper say about X" with traceable evidence, then quote the citations to the user.',
    parameters: obj({
      documentId: { type: 'string', description: 'Document id to ask about.' },
      question: { type: 'string', description: 'Question, in the user\'s language.' },
      focusBlockKey: { type: 'string', description: 'Optional reader block key the question is about.' },
    }, ['documentId', 'question']),
    output: outputOf((args, value) => ({
      document: value.document,
      answer: value.answer,
      citations: value.citations,
      followups: value.followups,
      annotationIds: value.annotationIds,
      model: value.model,
      citationCount: value.citations.length,
      unverifiedCount: value.unverified.length,
    })),
    async execute(args) {
      try {
        const result = await service.askDocument({
          documentId: requireString(args, 'documentId'),
          question: requireString(args, 'question'),
          focusBlockKey: optionalString(args, 'focusBlockKey'),
        })
        return {
          ...result,
          citations: result.citations.slice(0, 20).map(compactCitation).filter(Boolean),
          answer: result.answer.slice(0, 8000),
          document: result.document,
        }
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
    parameters: obj({
      action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Operation.' },
      documentId: { type: 'string', description: 'Document id.' },
      annotationId: { type: 'string', description: 'Annotation id for update/delete.' },
      origin: { type: 'string', enum: ['user', 'ai'], description: 'Filter for list; provenance for create.' },
      aspect: { type: 'string', enum: ['definition', 'method', 'result', 'limitation', 'context'], description: 'Aspect (create/update).' },
      annotation: {
        type: 'object',
        description: 'Annotation payload for create/update.',
        properties: {
          blockKey: { type: 'string', description: 'Reader block key; omit to locate by quote.' },
          quote: { type: 'string', description: 'Text to annotate/locate.' },
          start: { type: 'integer', description: 'Start offset inside the block plain text.' },
          end: { type: 'integer', description: 'End offset inside the block plain text.' },
          note: { type: 'string', description: 'Note/claim text.' },
          color: { type: 'string', enum: ['yellow', 'sage', 'sky', 'rose'], description: 'Highlight color; aspect wins by default.' },
          aspect: { type: 'string', enum: ['definition', 'method', 'result', 'limitation', 'context'], description: 'Aspect.' },
        },
        additionalProperties: true,
      },
    }, ['action', 'documentId']),
    output: outputOf(),
    async execute(args) {
      const documentId = requireString(args, 'documentId')
      const action = requireString(args, 'action')
      try {
        if (action === 'list') {
          const payload = await service.getDocument(documentId)
          const origin = optionalString(args, 'origin')
          const aspect = optionalString(args, 'aspect')
          const annotations = (payload.annotations.items ?? []).filter((item) => (
            (origin === undefined || item.origin === origin)
            && (aspect === undefined || item.aspect === aspect)
          ))
          return { documentId, count: annotations.length, annotations: annotations.slice(0, 100) }
        }
        if (action === 'delete') {
          return await service.toolUnannotate(documentId, requireString(args, 'annotationId'))
        }
        const payload = args?.annotation !== null && typeof args?.annotation === 'object' ? { ...args.annotation } : {}
        if (action === 'update') {
          if (typeof payload.id !== 'string' || payload.id === '') payload.id = requireString(args, 'annotationId')
        }
        if (typeof payload.aspect !== 'string' && typeof args?.aspect === 'string') payload.aspect = args.aspect
        payload.origin = optionalString(args, 'origin') === 'ai' ? 'ai' : 'user'
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
      'Translate text or specific parsed blocks of a document into the reader\'s target language. Pass `text` for arbitrary text, or `blockKeys` (up to 10) to translate passages identified by citations. Uses the host translation service with the default model as fallback.',
    parameters: obj({
      documentId: { type: 'string', description: 'Document id (required for blockKeys).' },
      text: { type: 'string', description: 'Arbitrary text to translate.' },
      blockKeys: arr({ type: 'string' }, 'Parsed block keys to translate (max 10).'),
      targetLanguage: { type: 'string', description: 'Target language code, e.g. zh or en.' },
      provider: { type: 'string', description: 'Optional translation provider id.' },
    }, ['documentId']),
    output: outputOf(),
    async execute(args) {
      const documentId = requireString(args, 'documentId')
      const targetLanguage = optionalString(args, 'targetLanguage', 32)
      const provider = optionalString(args, 'provider', 64)
      try {
        if (typeof args?.text === 'string' && args.text.trim() !== '') {
          return { ...(await service.translate({ text: args.text.trim().slice(0, 20000), targetLanguage, provider })), documentId }
        }
        const keys = Array.isArray(args?.blockKeys) ? args.blockKeys.filter((key) => typeof key === 'string').slice(0, 10) : []
        if (keys.length === 0) throw new Error('provide text or blockKeys')
        const blocks = await service.blockTexts(documentId, keys)
        const translations = []
        for (const block of blocks) {
          if (block.found !== true || block.text.trim() === '') {
            translations.push({ blockKey: block.blockKey, found: false })
            continue
          }
          const value = await service.translate({ text: block.text.slice(0, 20000), targetLanguage, provider })
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
      'Work with knowledge graphs. action=get: one paper\'s graph; search: find nodes by text; build: AI reads the paper and extracts its graph (async stream consumed here, may take a while); update: add nodes/edges; library: the whole-library graph; rebuild: regenerate the library graph from per-paper graphs. Nodes carry blockKeys that point into the text.',
    parameters: obj({
      action: { type: 'string', enum: ['get', 'search', 'build', 'update', 'library', 'rebuild'], description: 'Operation.' },
      documentId: { type: 'string', description: 'Document id for get/search/build/update.' },
      query: { type: 'string', description: 'Search words for action=search (searches labels and summaries).' },
      force: { type: 'boolean', description: 'For build: rebuild even if a graph exists.' },
      nodes: arr({ type: 'object', additionalProperties: true }, 'Nodes to add/merge (update).'),
      edges: arr({ type: 'object', additionalProperties: true }, 'Edges to add/merge (update).'),
    }, ['action']),
    output: outputOf(),
    async execute(args) {
      const action = requireString(args, 'action')
      try {
        if (action === 'library') return compactGraph((await service.libraryGraph()).graph, 80)
        if (action === 'rebuild') {
          let graph = null
          let progress = 0
          for await (const frame of service.libraryGraphBuildFrames()) {
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
          const nodes = (graph.nodes ?? []).filter((node) => (
            String(node.label ?? '').toLowerCase().includes(query)
            || String(node.summary ?? '').toLowerCase().includes(query)
          ))
          const ids = new Set(nodes.map((node) => node.id))
          return {
            documentId,
            query,
            nodes: nodes.slice(0, 40).map((node) => compactNode(node)),
            edges: (graph.edges ?? []).filter((edge) => ids.has(edge.from) || ids.has(edge.to)).slice(0, 80),
          }
        }
        if (action === 'build') {
          let graph = null
          let progressFrames = 0
          for await (const frame of service.graphBuildFrames({ documentId, force: args?.force === true })) {
            if (frame.type === 'progress') progressFrames += 1
            else if (frame.type === 'graph') graph = frame.graph
            else if (frame.type === 'error') throw new Error(frame.message || 'graph build failed')
          }
          return { documentId, ...compactGraph(graph, 80), progressFrames }
        }
        if (action === 'update') {
          const graph = (await service.updateDocGraph(documentId, {
            nodes: Array.isArray(args?.nodes) ? args.nodes : [],
            edges: Array.isArray(args?.edges) ? args.edges : [],
          })).graph
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
      'Manage the literature library: list documents, read import/parse status, import a paper from a URL, start a MinerU parse (optionally page-scoped repair), cancel a running parse, rename a paper, or delete one. Parsing needs a MinerU token for the precise API; the token-free lightweight API is used automatically when none is configured.',
    parameters: obj({
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
          engine: { type: 'string', enum: ['auto', 'standard', 'agent'] },
          modelVersion: { type: 'string', enum: ['pipeline', 'vlm'] },
          language: { type: 'string' },
          isOcr: { type: 'boolean' },
          enableFormula: { type: 'boolean' },
          enableTable: { type: 'boolean' },
          pageRanges: { type: 'string', description: 'e.g. "2,4-6".' },
        },
        additionalProperties: false,
      },
      pages: arr({ type: 'integer' }, '1-based pages for action=repair (omitted = host detects unreadable pages).'),
    }, ['action']),
    output: outputOf(),
    async execute(args) {
      const action = requireString(args, 'action')
      try {
        if (action === 'list') {
          const value = await service.listDocuments()
          return { total: value.documents.length, documents: value.documents.slice(0, 100).map(compactDoc) }
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
          }
        }
        if (action === 'import_url') {
          const value = await service.importUrl({ url: requireString(args, 'url'), title: optionalString(args, 'title') })
          return { ...compactDoc(value.document), imported: true }
        }
        const documentId = requireString(args, 'documentId')
        if (action === 'parse') {
          const value = await service.startParse(documentId, args?.parse !== null && typeof args?.parse === 'object' ? args.parse : {})
          return { ...compactDoc(value.document), parsing: true }
        }
        if (action === 'repair') {
          const value = await service.startParse(documentId, {
            merge: true,
            pages: Array.isArray(args?.pages) ? args.pages : undefined,
          })
          return { ...compactDoc(value.document), repairing: true, parse: value.document.parse }
        }
        if (action === 'cancel') return { ...compactDoc((await service.cancelParse(documentId)).document), cancelled: true }
        if (action === 'update') {
          const patch = {}
          if (typeof args?.title === 'string' && args.title.trim() !== '') patch.title = args.title.trim()
          return compactDoc((await service.updateDocument(documentId, patch)).document)
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
