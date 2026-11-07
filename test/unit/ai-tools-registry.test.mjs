/**
 * Registration and dispatch tests for the seven library tools
 * (docs/AI-SPEC.md §7). Uses a fake tool registry + fake service so the test
 * does not need the full host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIBRARY_TOOL_NAMES, registerLibraryTools } from '../../lib/ai/tools.js'

/** Fake tool registry capturing definitions. */
function makeTools() {
  const definitions = new Map()
  const disposed = []
  return {
    definitions,
    disposed,
    register(definition) {
      definitions.set(definition.name, definition)
      return () => {
        disposed.push(definition.name)
        definitions.delete(definition.name)
      }
    },
  }
}

/** Fake service with recorded calls. */
function makeService(overrides = {}) {
  const calls = []
  const record = (name, value) => (...args) => {
    calls.push({ name, args })
    return Promise.resolve(typeof value === 'function' ? value(...args) : value)
  }
  return {
    calls,
    searchDocuments: record('searchDocuments', { matches: [], scanned: { documents: 0, blocks: 0 } }),
    documentModel: record('documentModel', {
      document: { id: 'doc-1', title: 'Paper', status: 'parsed', pages: 3, parse: {} },
      markdown: '# Paper',
      blocks: [{ key: 'b0:deadbeef', index: 0, kind: 'heading', page: 1, plainText: 'Paper' }],
      outline: [],
      stats: {},
    }),
    toolRead: record('toolRead', { text: 'slice', offset: 0, nextOffset: 5, totalChars: 5, truncated: false }),
    blockTexts: record('blockTexts', [{ blockKey: 'b0:deadbeef', found: true, page: 1, kind: 'heading', text: 'Paper' }]),
    getDocument: record('getDocument', { document: { id: 'doc-1' }, annotations: { items: [] }, translations: {} }),
    translate: record('translate', { translation: '译文', provider: 'google', targetLanguage: 'zh' }),
    askDocument: record('askDocument', {
      document: { id: 'doc-1', title: 'Paper' },
      answer: 'answer [1]',
      citations: [{ blockKey: 'b0:deadbeef', quote: 'Paper', page: 1, aspect: 'method', note: 'claim', verified: true }],
      unverified: [],
      followups: [],
      annotationIds: ['a1'],
      graph: null,
      model: { provider: 'deepseek', model: 'deepseek-flash' },
    }),
    docGraph: record('docGraph', { graph: { nodes: [{ id: 'n1', type: 'concept', label: 'BEE', summary: 's', blockKeys: ['b0:deadbeef'], weight: 2 }], edges: [], stats: {} } }),
    updateDocGraph: record('updateDocGraph', { graph: { nodes: [], edges: [], stats: {} } }),
    libraryGraph: record('libraryGraph', { graph: { nodes: [], edges: [], stats: {} } }),
    graphBuildFrames: () => (async function* frames() {
      yield { type: 'progress', phase: 'reading', done: 1, total: 2 }
      yield { type: 'graph', graph: { nodes: [{ id: 'n1', type: 'concept', label: 'BEE', summary: '', blockKeys: [], weight: 1 }], edges: [] } }
    })(),
    libraryGraphBuildFrames: () => (async function* frames() {
      yield { type: 'progress', phase: 'aggregating', done: 1, total: 1 }
      yield { type: 'graph', graph: { nodes: [], edges: [], stats: {} } }
    })(),
    toolAnnotate: record('toolAnnotate', { annotation: { id: 'a1' }, count: 1 }),
    toolUnannotate: record('toolUnannotate', { removed: true, count: 0 }),
    listDocuments: record('listDocuments', { documents: [] }),
    getStatus: record('getStatus', { version: '0.2.0+host', tokenConfigured: true, dataDirDisplay: '~/.dsh/litnotes', counts: {}, ai: { available: false } }),
    startParse: record('startParse', { document: { id: 'doc-1', status: 'parsing' } }),
    cancelParse: record('cancelParse', { document: { id: 'doc-1', status: 'uploaded' } }),
    importUrl: record('importUrl', { document: { id: 'doc-1', title: 'New' } }),
    updateDocument: record('updateDocument', { document: { id: 'doc-1', title: 'Renamed' } }),
    removeDocument: record('removeDocument', { removed: true }),
    ...overrides,
  }
}

/** Extract the plain text of a tool result block list. */
function resultText(blocks) {
  return blocks.map((block) => block.text ?? '').join('\n')
}

/** Invoke one registered tool and parse the rendered JSON result. */
async function run(tools, name, args) {
  const definition = tools.definitions.get(name)
  assert.ok(definition, `tool ${name} registered`)
  const value = await definition.execute(args)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks[0].type === 'text')
  return { value, text: resultText(blocks) }
}

test('all seven library tools register and dispose cleanly', () => {
  const tools = makeTools()
  const dispose = registerLibraryTools({ tools, service: makeService(), config: {} })
  assert.deepEqual([...tools.definitions.keys()].sort(), [...LIBRARY_TOOL_NAMES].sort())
  for (const name of LIBRARY_TOOL_NAMES) {
    const definition = tools.definitions.get(name)
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }
  dispose()
  assert.equal(tools.definitions.size, 0)
  assert.equal(tools.disposed.length, 7)
})

test('registration is a no-op when the tools service is missing', () => {
  const dispose = registerLibraryTools({ tools: undefined, service: makeService(), config: {} })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('search/read/ask/annotate/translate/graph/manage dispatch through the service', async () => {
  const tools = makeTools()
  const service = makeService()
  registerLibraryTools({ tools, service, config: {} })

  const search = await run(tools, 'library_search', { query: 'BEE' })
  assert.equal(search.value.matches.length, 0)
  assert.equal(service.calls.find((call) => call.name === 'searchDocuments').args[0].query, 'BEE')

  const read = await run(tools, 'library_read', { documentId: 'doc-1', view: 'meta' })
  assert.equal(read.value.documentId, 'doc-1')
  assert.equal(service.calls.find((call) => call.name === 'documentModel').args[0], 'doc-1')

  const ask = await run(tools, 'library_ask', { documentId: 'doc-1', question: 'What is BEE?' })
  assert.equal(ask.value.citations.length, 1)
  assert.equal(ask.value.answer.includes('answer'), true)

  const annotate = await run(tools, 'library_annotate', {
    action: 'create',
    documentId: 'doc-1',
    annotation: { quote: 'Paper', aspect: 'method' },
  })
  assert.equal(annotate.value.count, 1)

  const translate = await run(tools, 'library_translate', { documentId: 'doc-1', text: 'hello' })
  assert.equal(translate.value.translation, '译文')

  const graph = await run(tools, 'library_graph', { action: 'build', documentId: 'doc-1' })
  assert.equal(graph.value.nodes.length, 1)
  assert.equal(graph.value.progressFrames, 1)

  const manage = await run(tools, 'library_manage', { action: 'status' })
  assert.equal(manage.value.dataDir, '~/.dsh/litnotes')
})

test('tool failures surface as plain errors with the wire message', async () => {
  const tools = makeTools()
  const service = makeService({
    searchDocuments: async () => {
      const error = new Error('查询不能为空（query must not be empty）')
      error.code = 'bad-request'
      throw error
    },
  })
  registerLibraryTools({ tools, service, config: {} })
  await assert.rejects(
    () => tools.definitions.get('library_search').execute({ query: 'x' }),
    (error) => error.message.includes('查询不能为空'),
  )
  await assert.rejects(
    () => tools.definitions.get('library_manage').execute({ action: 'nonsense', documentId: 'doc-1' }),
    (error) => error.message.includes('unknown action'),
  )
})
