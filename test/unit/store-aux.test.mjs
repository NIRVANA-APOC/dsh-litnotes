/**
 * Aux JSON storage + annotation provenance for the AI features
 * (docs/AI-SPEC.md §2): chat/graph files per document and the library graph.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../lib/store.js'

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-aux-'))
  const store = createStore({ dataDir })
  await store.init()
  const id = randomUUID()
  const tempPath = store.newTempPath(id)
  await writeFile(tempPath, '%PDF-1.4 aux')
  const meta = await store.createFromFile({ id, tempPath, originalName: 'aux.pdf' })
  return { dataDir, store, meta }
}

test('document aux JSON round-trips and missing files read null', async () => {
  const env = await setup()
  try {
    assert.equal(await env.store.readAux(env.meta.id, 'chat.json'), null)
    await env.store.writeAux(env.meta.id, 'chat.json', { version: 1, messages: [{ role: 'user', question: 'hi' }] })
    const chat = await env.store.readAux(env.meta.id, 'chat.json')
    assert.equal(chat.version, 1)
    assert.equal(chat.messages[0].question, 'hi')
    await env.store.writeAux(env.meta.id, 'graph.json', { nodes: [{ id: 'n1' }], edges: [] })
    assert.equal((await env.store.readAux(env.meta.id, 'graph.json')).nodes.length, 1)
  } finally {
    await env.store.dispose()
    await rm(env.dataDir, { recursive: true, force: true })
  }
})

test('aux writes reject unknown documents and unsafe names', async () => {
  const env = await setup()
  try {
    await assert.rejects(() => env.store.writeAux(randomUUID(), 'chat.json', {}), (error) => error.code === 'not-found')
    await assert.rejects(() => env.store.writeAux(env.meta.id, '../escape.json', {}), (error) => error.code === 'bad-request')
    await assert.rejects(() => env.store.readAux(env.meta.id, '/abs.json'), (error) => error.code === 'bad-request')
  } finally {
    await env.store.dispose()
    await rm(env.dataDir, { recursive: true, force: true })
  }
})

test('library aux JSON round-trips', async () => {
  const env = await setup()
  try {
    assert.equal(await env.store.readLibraryAux('library-graph.json'), null)
    await env.store.writeLibraryAux('library-graph.json', { nodes: [{ id: 'paper-1' }], edges: [] })
    const graph = await env.store.readLibraryAux('library-graph.json')
    assert.equal(graph.nodes[0].id, 'paper-1')
  } finally {
    await env.store.dispose()
    await rm(env.dataDir, { recursive: true, force: true })
  }
})

test('annotations keep AI provenance fields (origin/aspect/chatId/messageId/model)', async () => {
  const env = await setup()
  try {
    await env.store.saveAnnotations(env.meta.id, {
      version: 1,
      items: [{
        id: 'a1',
        blockKey: 'b1:deadbeef',
        start: 2,
        end: 8,
        quote: 'evidence',
        note: 'claim',
        color: 'sage',
        origin: 'ai',
        aspect: 'method',
        chatId: 'chat-1',
        messageId: 'msg-1',
        model: { provider: 'deepseek', model: 'deepseek-flash' },
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    const loaded = await env.store.loadAnnotations(env.meta.id)
    const item = loaded.items[0]
    assert.equal(item.origin, 'ai')
    assert.equal(item.aspect, 'method')
    assert.equal(item.chatId, 'chat-1')
    assert.equal(item.messageId, 'msg-1')
    assert.deepEqual(item.model, { provider: 'deepseek', model: 'deepseek-flash' })
    // invalid aspect is dropped, unknown origins are dropped
    await env.store.saveAnnotations(env.meta.id, {
      version: 1,
      items: [{ ...item, id: 'a2', origin: 'robot', aspect: 'nonsense' }],
    })
    const again = (await env.store.loadAnnotations(env.meta.id)).items[0]
    assert.equal(again.origin, undefined)
    assert.equal(again.aspect, undefined)
    assert.equal(again.color, 'sage', 'color survives')
  } finally {
    await env.store.dispose()
    await rm(env.dataDir, { recursive: true, force: true })
  }
})
