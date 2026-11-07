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
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  normalizePreferences,
  resolveConfig,
  savePreferences,
} from '../../lib/config.js'

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

test('mutateAux atomically read-modify-writes document aux JSON', async () => {
  const env = await setup()
  try {
    // A missing file reads as null; the mutator writes and returns the value.
    const written = await env.store.mutateAux(env.meta.id, 'chat.json', (current) => {
      assert.equal(current, null)
      return { version: 1, messages: [{ role: 'user', question: 'hi' }] }
    })
    assert.equal(written.version, 1)
    assert.equal((await env.store.readAux(env.meta.id, 'chat.json')).messages[0].question, 'hi')

    // Interleaved read-modify-writes never lose an increment.
    await env.store.writeAux(env.meta.id, 'counter.json', { count: 0 })
    await Promise.all(
      Array.from({ length: 25 }, () =>
        env.store.mutateAux(env.meta.id, 'counter.json', (current) => ({ count: current.count + 1 })),
      ),
    )
    assert.equal((await env.store.readAux(env.meta.id, 'counter.json')).count, 25)

    // Returning undefined means "no write" and resolves undefined.
    const noWrite = await env.store.mutateAux(env.meta.id, 'counter.json', () => undefined)
    assert.equal(noWrite, undefined)
    assert.equal((await env.store.readAux(env.meta.id, 'counter.json')).count, 25)

    // A corrupt file reads as null and is repaired by the next write.
    await writeFile(join(env.store.docDir(env.meta.id), 'graph.json'), '{broken')
    const repaired = await env.store.mutateAux(env.meta.id, 'graph.json', (current) => {
      assert.equal(current, null)
      return { nodes: [], edges: [] }
    })
    assert.deepEqual(repaired, { nodes: [], edges: [] })
    assert.deepEqual(await env.store.readAux(env.meta.id, 'graph.json'), { nodes: [], edges: [] })

    // Unknown documents, unsafe names and non-function mutators reject cleanly.
    await assert.rejects(
      env.store.mutateAux(randomUUID(), 'chat.json', () => null),
      (error) => error.code === 'not-found',
    )
    await assert.rejects(
      env.store.mutateAux(env.meta.id, '../escape.json', () => null),
      (error) => error.code === 'bad-request',
    )
    await assert.rejects(
      env.store.mutateAux(env.meta.id, 'chat.json', 'not-a-function'),
      (error) => error.code === 'bad-request',
    )
  } finally {
    await env.store.dispose()
    await rm(env.dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Host config/preferences touched by this round (lib/config.js)
// There is no dedicated test/unit/config.test.mjs; the preference and ai-block
// validation lives here with the other persisted-state coverage.
// ---------------------------------------------------------------------------

test('preferences keep the margin origin filter notesFilter', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-prefs-'))
  try {
    assert.equal(DEFAULT_PREFERENCES.notesFilter, 'all')
    assert.equal('autoBuildGraph' in DEFAULT_PREFERENCES, false)

    // Unknown/invalid values fall back to the default.
    assert.equal(normalizePreferences({}).notesFilter, 'all')
    assert.equal(normalizePreferences({ notesFilter: 'ai' }).notesFilter, 'ai')
    assert.equal(normalizePreferences({ notesFilter: 'user' }).notesFilter, 'user')
    assert.equal(normalizePreferences({ notesFilter: 'bogus' }).notesFilter, 'all')
    assert.equal(normalizePreferences({ notesFilter: 42 }).notesFilter, 'all')

    // Preferences round-trip through the host-persisted file.
    const saved = await savePreferences(dataDir, { notesFilter: 'ai' })
    assert.equal(saved.notesFilter, 'ai')
    assert.equal((await loadPreferences(dataDir)).notesFilter, 'ai')
    // A later invalid update resets the field to its default, never crashes.
    assert.equal((await savePreferences(dataDir, { notesFilter: 'nope' })).notesFilter, 'all')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('ai config exposes the entailment switch and no dead autoBuildGraph key', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-config-'))
  try {
    const base = resolveConfig({ dataDir }).ai
    assert.equal(base.entailmentCheck, true, 'the entailment pass is on by default')
    assert.equal(base.entailmentMaxTokens, 600)
    assert.equal('autoBuildGraph' in base, false, 'the dead host key was removed')

    const custom = resolveConfig({
      dataDir,
      ai: { entailmentCheck: false, entailmentMaxTokens: 1234, autoBuildGraph: true },
    }).ai
    assert.equal(custom.entailmentCheck, false)
    assert.equal(custom.entailmentMaxTokens, 1234)
    assert.equal('autoBuildGraph' in custom, false)

    // Bounds are clamped; only an explicit false disables the pass.
    assert.equal(resolveConfig({ dataDir, ai: { entailmentMaxTokens: 1 } }).ai.entailmentMaxTokens, 64)
    assert.equal(resolveConfig({ dataDir, ai: { entailmentMaxTokens: 'huge' } }).ai.entailmentMaxTokens, 600)
    assert.equal(resolveConfig({ dataDir, ai: { entailmentCheck: 'false' } }).ai.entailmentCheck, true)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
