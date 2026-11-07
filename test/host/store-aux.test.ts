/**
 * Aux JSON storage + annotation provenance for the AI features
 * (docs/AI-SPEC.md §2): chat/graph files per document and the library graph,
 * plus the per-document stale-file cleanup on store init.
 *
 * Ported from the frozen 1.0.0 `.mjs` suites. 1.0.0 contract difference: a
 * missing/corrupt aux file reads as `undefined` (the store contract types aux
 * reads as `T | undefined`) instead of the 1.0.0 `null`.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { expect } from 'vitest'

import { createStore } from '../../src/host/store/index.ts'
import type { DocumentMeta } from '../../src/shared/model.ts'

/** Temporary data directories created by the current test. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

interface ChatFile {
  version: number
  messages: Array<{ role: string; question?: string }>
}

interface GraphFile {
  nodes: Array<{ id: string }>
  edges: unknown[]
}

/** Create an isolated library with one uploaded document. */
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-aux-'))
  const store = createStore({ dataDir })
  cleanups.push(async () => {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })
  await store.init()
  const id = randomUUID()
  const tempPath = store.newTempPath(id)
  await writeFile(tempPath, '%PDF-1.4 aux')
  const meta = await store.createFromFile({ id, tempPath, originalName: 'aux.pdf' })
  return { dataDir, store, meta }
}

test('document aux JSON round-trips and missing files read undefined', async () => {
  const env = await setup()
  expect(await env.store.readAux(env.meta.id, 'chat.json')).toBeUndefined()
  await env.store.writeAux(env.meta.id, 'chat.json', {
    version: 1,
    messages: [{ role: 'user', question: 'hi' }],
  })
  const chat = await env.store.readAux<ChatFile>(env.meta.id, 'chat.json')
  expect(chat?.version).toBe(1)
  expect(chat?.messages[0]?.question).toBe('hi')
  await env.store.writeAux(env.meta.id, 'graph.json', { nodes: [{ id: 'n1' }], edges: [] })
  expect((await env.store.readAux<GraphFile>(env.meta.id, 'graph.json'))?.nodes.length).toBe(1)
})

test('aux writes reject unknown documents and unsafe names', async () => {
  const env = await setup()
  await expect(
    env.store.writeAux(randomUUID(), 'chat.json', {}),
  ).rejects.toMatchObject({ code: 'not-found' })
  await expect(
    env.store.writeAux(env.meta.id, '../escape.json' as never, {}),
  ).rejects.toMatchObject({ code: 'bad-request' })
  await expect(
    env.store.readAux(env.meta.id, '/abs.json' as never),
  ).rejects.toMatchObject({ code: 'bad-request' })
})

test('library aux JSON round-trips', async () => {
  const env = await setup()
  expect(await env.store.readLibraryAux('library-graph.json')).toBeUndefined()
  await env.store.writeLibraryAux('library-graph.json', { nodes: [{ id: 'paper-1' }], edges: [] })
  const graph = await env.store.readLibraryAux<GraphFile>('library-graph.json')
  expect(graph?.nodes[0]?.id).toBe('paper-1')
})

test('annotations keep AI provenance fields (origin/aspect/chatId/messageId/model)', async () => {
  const env = await setup()
  await env.store.saveAnnotations(env.meta.id, {
    items: [
      {
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
      },
    ],
  })
  const loaded = await env.store.loadAnnotations(env.meta.id)
  const item = loaded.items[0]
  expect(item?.origin).toBe('ai')
  expect(item?.aspect).toBe('method')
  expect(item?.chatId).toBe('chat-1')
  expect(item?.messageId).toBe('msg-1')
  expect(item?.model).toEqual({ provider: 'deepseek', model: 'deepseek-flash' })
  // invalid aspect is dropped, unknown origins are dropped
  await env.store.saveAnnotations(env.meta.id, {
    items: [{ ...item, id: 'a2', origin: 'robot', aspect: 'nonsense' } as never],
  })
  const again = (await env.store.loadAnnotations(env.meta.id)).items[0]
  expect(again?.origin).toBeUndefined()
  expect(again?.aspect).toBeUndefined()
  expect(again?.color).toBe('sage')
})

test('mutateAux atomically read-modify-writes document aux JSON', async () => {
  const env = await setup()
  // A missing file reads as undefined; the mutator writes and returns the value.
  const written = await env.store.mutateAux<ChatFile>(env.meta.id, 'chat.json', (current) => {
    expect(current).toBeUndefined()
    return { version: 1, messages: [{ role: 'user', question: 'hi' }] }
  })
  expect(written.version).toBe(1)
  expect((await env.store.readAux<ChatFile>(env.meta.id, 'chat.json'))?.messages[0]?.question).toBe('hi')

  // Interleaved read-modify-writes never lose an increment.
  await env.store.writeAux(env.meta.id, 'graph.json', { nodes: [], edges: [], count: 0 })
  await Promise.all(
    Array.from({ length: 25 }, () =>
      env.store.mutateAux<GraphFile & { count: number }>(env.meta.id, 'graph.json', (current) => ({
        nodes: current?.nodes ?? [],
        edges: current?.edges ?? [],
        count: (current?.count ?? 0) + 1,
      })),
    ),
  )
  expect(
    (await env.store.readAux<{ count: number }>(env.meta.id, 'graph.json'))?.count,
  ).toBe(25)

  // Returning undefined means "no write" and resolves undefined.
  const noWrite = await env.store.mutateAux<{ count: number }>(
    env.meta.id,
    'graph.json',
    () => undefined as never,
  )
  expect(noWrite).toBeUndefined()
  expect((await env.store.readAux<{ count: number }>(env.meta.id, 'graph.json'))?.count).toBe(25)

  // A corrupt file reads as undefined and is repaired by the next write.
  await writeFile(join(env.store.docDir(env.meta.id), 'chat.json'), '{broken')
  const repaired = await env.store.mutateAux<{ nodes: string[]; edges: string[] }>(
    env.meta.id,
    'chat.json',
    (current) => {
      expect(current).toBeUndefined()
      return { nodes: [], edges: [] }
    },
  )
  expect(repaired).toEqual({ nodes: [], edges: [] })
  expect(await env.store.readAux(env.meta.id, 'chat.json')).toEqual({ nodes: [], edges: [] })

  // Unknown documents, unsafe names and non-function mutators reject cleanly.
  await expect(
    env.store.mutateAux(randomUUID(), 'chat.json', () => null as never),
  ).rejects.toMatchObject({ code: 'not-found' })
  await expect(
    env.store.mutateAux(env.meta.id, '../escape.json' as never, () => null as never),
  ).rejects.toMatchObject({ code: 'bad-request' })
  await expect(
    env.store.mutateAux(env.meta.id, 'chat.json', 'not-a-function' as never),
  ).rejects.toMatchObject({ code: 'bad-request' })
})

test('store init removes interrupted-operation leftovers inside a document directory', async () => {
  const env = await setup()
  const dataDir = env.dataDir
  const id = randomUUID()
  const tempPath = env.store.newTempPath(id)
  await writeFile(tempPath, '%PDF-1.4 qa')
  const meta = await env.store.createFromFile({ id, tempPath, originalName: 'stale.pdf' })
  const docDir = env.store.docDir(meta.id)
  // Real artifact names produced by writeFileAtomic and writeStagedParsed.
  await writeFile(join(docDir, `.meta.json.tmp-1234-${randomUUID()}`), 'partial')
  await writeFile(join(docDir, 'upload.part'), 'partial')
  await mkdir(join(docDir, `.parsed-${randomUUID()}`), { recursive: true })
  await env.store.dispose()

  const reopened = createStore({ dataDir })
  cleanups.push(async () => {
    await reopened.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })
  await reopened.init()
  const names = await readdir(docDir)
  expect(names).not.toContain('upload.part')
  expect(names.some((name) => /^\.meta\.json\.tmp-/.test(name))).toBe(false)
  expect(names.some((name) => /^\.parsed-/.test(name))).toBe(false)
  expect((reopened.get(meta.id) as DocumentMeta).originalName).toBe('stale.pdf')
})
