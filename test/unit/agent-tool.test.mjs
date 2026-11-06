/**
 * Unit tests for the `mineru` agent tool (`lib/agent-tool.js`): registration
 * shape, argument mapping onto the shared service, rendered text content and
 * graceful behavior when no tool registry is available.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_NAME, registerAgentTool } from '../../lib/agent-tool.js'

/** A fake tool registry recording the registered definition. */
function makeTools() {
  const calls = []
  let disposed = false
  return {
    calls,
    get disposed() {
      return disposed
    },
    register(definition) {
      calls.push(definition)
      return () => {
        disposed = true
      }
    },
  }
}

/** A stub service recording every operation call. */
function makeService() {
  const calls = []
  const respond = (name) => async (...args) => {
    calls.push({ name, args })
    return { action: name, args }
  }
  const service = {
    calls,
    toolList: respond('toolList'),
    getStatus: async () => ({ version: '0.1.0+host', counts: { total: 0 } }),
    toolGet: respond('toolGet'),
    importUrl: respond('importUrl'),
    startParse: respond('startParse'),
    toolRead: respond('toolRead'),
    toolAnnotations: respond('toolAnnotations'),
    toolAnnotate: respond('toolAnnotate'),
    toolUnannotate: respond('toolUnannotate'),
    translate: respond('translate'),
    removeDocument: respond('removeDocument'),
    updateDocument: respond('updateDocument'),
  }
  return service
}

/** Create the tool through a fake context exposing only `tools`. */
function register(service = makeService(), ctx) {
  const tools = makeTools()
  const context = ctx ?? { get: (name) => (name === 'tools' ? tools : undefined) }
  const dispose = registerAgentTool({ ctx: context, service, config: {}, logger: { warn() {}, info() {} } })
  return { tools, dispose, service }
}

test('registers one well-formed tool definition named mineru', () => {
  const { tools } = register()
  assert.equal(tools.calls.length, 1)
  const definition = tools.calls[0]
  assert.equal(definition.name, 'mineru')
  assert.equal(TOOL_NAME, 'mineru')
  assert.equal(typeof definition.description, 'string')
  assert.ok(definition.description.length > 40)
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['action'])
  const actions = definition.parameters.properties.action.enum
  for (const action of [
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
  ]) {
    assert.ok(actions.includes(action), `action ${action} is offered`)
  }
  assert.equal(definition.output.schema.type, 'object')
  assert.equal(typeof definition.output.render, 'function')
})

test('disposer unregisters the tool', () => {
  const { tools, dispose } = register()
  assert.equal(tools.disposed, false)
  dispose()
  assert.equal(tools.disposed, true)
})

test('execute maps actions onto the shared service', async () => {
  const { tools, service } = register()
  const definition = tools.calls[0]
  const documentId = '11111111-1111-4111-8111-111111111111'

  await definition.execute({ action: 'list' }, {})
  assert.equal(service.calls.at(-1).name, 'toolList')

  await definition.execute({ action: 'get', documentId }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'toolGet', args: [documentId] })

  await definition.execute({ action: 'read', documentId, offset: 40, maxChars: 500 }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'toolRead', args: [documentId, { offset: 40, maxChars: 500 }] })

  await definition.execute({ action: 'parse', documentId, parse: { engine: 'agent' } }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'startParse', args: [documentId, { engine: 'agent' }] })

  await definition.execute({ action: 'annotate', documentId, annotation: { quote: 'hello' } }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'toolAnnotate', args: [documentId, { quote: 'hello' }] })

  await definition.execute({ action: 'unannotate', documentId, annotation: { id: 'ann-1' } }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'toolUnannotate', args: [documentId, 'ann-1'] })

  await definition.execute({ action: 'translate', text: 'hello', targetLanguage: 'zh' }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'translate', args: [{ text: 'hello', targetLanguage: 'zh' }] })

  await definition.execute({ action: 'import_url', url: 'https://example.test/paper.pdf', title: 'Paper' }, {})
  assert.deepEqual(service.calls.at(-1), {
    name: 'importUrl',
    args: [{ url: 'https://example.test/paper.pdf', title: 'Paper' }],
  })

  await definition.execute({ action: 'update', documentId, title: 'Renamed' }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'updateDocument', args: [documentId, { title: 'Renamed' }] })

  await definition.execute({ action: 'delete', documentId }, {})
  assert.deepEqual(service.calls.at(-1), { name: 'removeDocument', args: [documentId] })
})

test('execute rejects incomplete requests and unknown actions', async () => {
  const { tools } = register()
  const definition = tools.calls[0]
  await assert.rejects(definition.execute({ action: 'read' }, {}), /documentId is required/)
  await assert.rejects(definition.execute({ action: 'import_url' }, {}), /url is required/)
  await assert.rejects(definition.execute({ action: 'translate' }, {}), /text is required/)
  await assert.rejects(
    definition.execute({ action: 'unannotate', documentId: 'x' }, {}),
    /annotation\.id is required/,
  )
  await assert.rejects(definition.execute({ action: 'update', documentId: 'x' }, {}), /title is required/)
  await assert.rejects(definition.execute({ action: 'explode' }, {}), /unknown action/)
  await assert.rejects(
    definition.execute({ action: 'list' }, { signal: AbortSignal.abort() }),
    /cancelled/,
  )
})

test('render returns a model-facing text content block', async () => {
  const { tools } = register()
  const definition = tools.calls[0]

  const listValue = {
    documents: [
      {
        id: 'a',
        title: 'Attention Is All You Need',
        status: 'parsed',
        pages: 15,
        engine: 'standard',
        createdAt: '2026-01-01T00:00:00.000Z',
        error: null,
      },
    ],
    total: 1,
  }
  const blocks = definition.output.render({ action: 'list' }, listValue)
  assert.ok(Array.isArray(blocks))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /Attention Is All You Need/)
  assert.match(blocks[0].text, /id=a/)
  assert.match(blocks[0].text, /15 页/)
  assert.doesNotMatch(blocks[0].text, /undefined/)

  const readValue = {
    text: 'body text',
    offset: 0,
    nextOffset: 9,
    totalChars: 20,
    truncated: true,
  }
  const readBlocks = definition.output.render({ action: 'read' }, readValue)
  assert.match(readBlocks[0].text, /body text/)
  assert.match(readBlocks[0].text, /offset=9/)
  assert.match(readBlocks[0].text, /0–9 \/ 20/)

  const translateValue = { translation: '你好', provider: 'google', targetLanguage: 'zh' }
  assert.match(definition.output.render({ action: 'translate' }, translateValue)[0].text, /你好/)

  // Long JSON output is truncated, not returned unbounded.
  const huge = { items: 'x'.repeat(30000) }
  const hugeText = definition.output.render({ action: 'annotations' }, huge)[0].text
  assert.ok(hugeText.length < 13000)
  assert.match(hugeText, /已截断/)
})

test('gracefully degrades when no tool registry is available', () => {
  const service = makeService()
  const dispose = registerAgentTool({
    ctx: { get: () => undefined },
    service,
    config: {},
    logger: { warn() {}, info() {} },
  })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('defers registration until an optional tool registry appears', () => {
  const tools = makeTools()
  let injectCallback
  const ctx = {
    get: () => undefined,
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'])
      injectCallback = callback
      return { dispose() {} }
    },
  }
  const dispose = registerAgentTool({
    ctx,
    service: makeService(),
    config: {},
    logger: { warn() {}, info() {} },
  })
  assert.equal(typeof injectCallback, 'function')
  // Simulate the registry becoming available: the callback registers the tool.
  injectCallback({ get: (name) => (name === 'tools' ? tools : undefined) })
  assert.equal(tools.calls.length, 1)
  assert.equal(tools.calls[0].name, 'mineru')
  assert.equal(typeof dispose, 'function')
})
