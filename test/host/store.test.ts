/**
 * Unit tests for the on-disk library store (`src/host/store/index.ts`):
 * create / update / remove, persistence across store instances, annotation
 * atomicity, parsed markdown reads, and diagnostics capping.
 *
 * Ported from the frozen 1.0.0 `.mjs` suite; assertions are unchanged except
 * where the 1.0.0 store contract names a field differently.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { expect } from 'vitest'

import { createStore, type StoreOptions } from '../../src/host/store/index.ts'
import type { Annotation } from '../../src/shared/model.ts'

/** Temporary data directories created by the current test. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

/** Create an isolated data directory. */
async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-store-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  return dataDir
}

/** Create a store that is disposed after the test. */
function makeStore(options: StoreOptions) {
  const store = createStore(options)
  cleanups.push(() => store.dispose())
  return store
}

/** One minimal annotation item with overrides. */
function annotation(overrides: Partial<Annotation> & { id: string }): Annotation {
  return {
    blockKey: 'b3:ab12cd34',
    start: 0,
    end: 5,
    quote: 'hello',
    note: '',
    color: 'sage',
    ...overrides,
  }
}

/** Create a document backed by a temp file with the given bytes. */
async function createDocument(
  store: ReturnType<typeof createStore>,
  { name = 'paper.pdf', bytes = '%PDF-1.4 test', title }: { name?: string; bytes?: string; title?: string } = {},
) {
  const id = randomUUID()
  const tempPath = store.newTempPath(id)
  await writeFile(tempPath, bytes)
  return store.createFromFile({ id, tempPath, originalName: name, title })
}

test('createFromFile hashes, sizes and stores the source atomically', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const bytes = '%PDF-1.4 hello litnotes'
  const meta = await createDocument(store, { bytes, title: 'My Paper' })
  expect(meta.schemaVersion).toBe(1)
  expect(meta.title).toBe('My Paper')
  expect(meta.originalName).toBe('paper.pdf')
  expect(meta.ext).toBe('.pdf')
  expect(meta.mime).toBe('application/pdf')
  expect(meta.size).toBe(Buffer.byteLength(bytes))
  expect(meta.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(meta.status).toBe('uploaded')
  expect(meta.error).toBeNull()
  expect(meta.parse).toBeNull()

  // The source file is inside the document directory and no temp file remains.
  const sourcePath = await store.sourcePath(meta.id)
  expect(await readFile(sourcePath, 'utf8')).toBe(bytes)
  expect(existsSync(store.newTempPath(meta.id))).toBe(false)

  const list = store.list()
  expect(list.length).toBe(1)
  expect(list[0]?.id).toBe(meta.id)
  expect(list[0]).not.toBe(meta)
  // list returns defensive copies
  list[0]!.title = 'mutated'
  expect(store.get(meta.id)?.title).toBe('My Paper')
})

test('a second store instance reloads persisted metadata', async () => {
  const dataDir = await makeDataDir()
  const first = makeStore({ dataDir })
  const meta = await createDocument(first)
  const id = meta.id
  await first.update(id, { title: 'Persisted Title' })
  await first.dispose()

  const second = makeStore({ dataDir })
  await second.init()
  const loaded = second.get(id)
  expect(loaded).toBeTruthy()
  expect(loaded?.title).toBe('Persisted Title')
  expect(second.stats().total).toBe(1)
})

test('update merges top-level fields and the parse sub-object', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const meta = await createDocument(store)
  const parsing = await store.update(meta.id, {
    status: 'parsing',
    parse: { engine: 'standard', phase: 'submitting', taskId: null, batchId: null },
  })
  expect(parsing.status).toBe('parsing')
  expect(parsing.parse?.engine).toBe('standard')
  expect(parsing.parse?.phase).toBe('submitting')

  const polling = await store.update(meta.id, { parse: { phase: 'polling', batchId: 'batch-1' } })
  expect(polling.parse?.engine).toBe('standard')
  expect(polling.parse?.phase).toBe('polling')
  expect(polling.parse?.batchId).toBe('batch-1')
  expect(polling.updatedAt >= polling.createdAt).toBe(true)

  await expect(store.update(meta.id, { status: 'bogus' as never })).rejects.toThrow(/无效的文档状态/)
  await expect(store.update('not-a-uuid', { title: 'x' })).rejects.toThrow(/无效的文档 ID/)
})

test('annotations persist atomically and concurrent saves never corrupt the file', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const meta = await createDocument(store)
  expect(await store.loadAnnotations(meta.id)).toEqual({ version: 1, items: [] })

  const item = annotation({
    id: randomUUID(),
    blockKey: 'b3:ab12cd34',
    start: 4,
    end: 12,
    quote: 'hello world',
    note: 'a note',
    color: 'sage',
  })
  await store.saveAnnotations(meta.id, { items: [item] })
  const loaded = await store.loadAnnotations(meta.id)
  expect(loaded.items.length).toBe(1)
  expect(loaded.items[0]?.blockKey).toBe('b3:ab12cd34')
  expect(loaded.items[0]?.color).toBe('sage')

  // Concurrent whole-list replacements must leave valid JSON, one winner.
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.saveAnnotations(meta.id, {
        items: [{ ...item, id: randomUUID(), note: `note-${index}` }],
      }),
    ),
  )
  const final = await store.loadAnnotations(meta.id)
  expect(final.items.length).toBe(1)
  expect(final.items[0]?.note).toMatch(/^note-\d+$/)
  const raw = await readFile(join(store.docDir(meta.id), 'annotations.json'), 'utf8')
  expect(() => JSON.parse(raw)).not.toThrow()
  expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['items', 'version'])

  // Unknown colors fall back to yellow; malformed items are dropped.
  const saved = await store.saveAnnotations(meta.id, {
    items: [
      { ...item, id: randomUUID(), color: 'neon' } as unknown as Annotation,
      { nope: true } as unknown as Annotation,
    ],
  })
  expect(saved.items.length).toBe(1)
  expect(saved.items[0]?.color).toBe('yellow')
  await expect(
    store.saveAnnotations(meta.id, { items: 'nope' as unknown as Annotation[] }),
  ).rejects.toThrow(/items 必须是数组/)
})

test('translations round-trip and invalid payloads are rejected', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const meta = await createDocument(store)
  await store.saveTranslations(meta.id, {
    version: 1,
    targetLanguage: 'zh',
    entries: { 'b0:deadbeef': '你好', 'b1:cafebabe': '世界' },
  })
  const loaded = await store.loadTranslations(meta.id)
  expect(loaded.targetLanguage).toBe('zh')
  expect(loaded.entries['b0:deadbeef']).toBe('你好')
  await expect(
    store.saveTranslations(meta.id, { entries: [] as unknown as Record<string, string> }),
  ).rejects.toThrow(/entries 必须是对象/)
})

test('readMarkdown returns markdown, content list and page count; not-parsed otherwise', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const parsed = await createDocument(store, { name: 'parsed.pdf' })
  const unparsed = await createDocument(store, { name: 'raw.pdf' })
  const parsedDir = store.parsedDir(parsed.id)
  await mkdir(join(parsedDir, 'images'), { recursive: true })
  await writeFile(join(parsedDir, 'full.md'), '# Heading\n\nBody text.')
  await writeFile(
    join(parsedDir, 'paper_content_list.json'),
    JSON.stringify([
      { type: 'text', text: 'a', page_idx: 0 },
      { type: 'text', text: 'b', page_idx: 2 },
    ]),
  )
  await writeFile(join(parsedDir, 'images', 'fig1.png'), 'png')

  const result = await store.readMarkdown(parsed.id)
  expect(result.markdown).toBe('# Heading\n\nBody text.')
  expect(result.contentList?.length).toBe(2)
  expect(result.pages).toBe(3)

  await expect(store.readMarkdown(unparsed.id)).rejects.toMatchObject({ code: 'not-parsed' })
  await expect(store.loadAnnotations('../../etc/passwd')).rejects.toMatchObject({ code: 'bad-request' })
})

test('remove deletes the directory and forgets the document', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const meta = await createDocument(store)
  const docDir = store.docDir(meta.id)
  expect(existsSync(docDir)).toBe(true)
  await store.remove(meta.id)
  expect(existsSync(docDir)).toBe(false)
  expect(store.get(meta.id)).toBeUndefined()
  expect(store.list().length).toBe(0)
  await expect(store.remove(meta.id)).rejects.toMatchObject({ code: 'not-found' })
})

test('stale temp uploads are cleaned on init but fresh ones are kept', async () => {
  const dataDir = await makeDataDir()
  const first = makeStore({ dataDir })
  const staleId = randomUUID()
  const freshId = randomUUID()
  const stalePath = first.newTempPath(staleId)
  const freshPath = first.newTempPath(freshId)
  await writeFile(stalePath, 'partial bytes')
  await writeFile(freshPath, 'in-flight bytes')
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  await utimes(stalePath, hourAgo, hourAgo)
  await first.init()
  expect(existsSync(stalePath)).toBe(false)
  expect(existsSync(freshPath)).toBe(true)
})

test('appendDiagnostic caps the log at 200 lines and never throws', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  await store.init()
  for (let index = 0; index < 205; index += 1) {
    await store.appendDiagnostic({ event: 'active', clientVersion: 'test', index })
  }
  const file = join(dataDir, 'diagnostics', 'client.log')
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  expect(lines.length).toBe(200)
  const first = JSON.parse(lines[0] ?? '{}') as { index?: number }
  const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { index?: number; at?: unknown }
  expect(first.index).toBe(5)
  expect(last.index).toBe(204)
  expect(typeof last.at).toBe('string')
})

test('ids are validated before any path is built', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  await expect(async () => store.docDir('../../etc')).rejects.toThrow(/无效的文档 ID/)
  await expect(async () => store.parsedDir('/etc/passwd')).rejects.toThrow(/无效的文档 ID/)
  await expect(async () => store.newTempPath('nope')).rejects.toThrow(/无效的文档 ID/)
  const meta = await createDocument(store)
  expect(() => store.parsedDir(randomUUID())).toThrow(/文档不存在/)
  expect(() => store.docDir('../escape')).toThrow(/无效的文档 ID/)
  expect(meta.id).toBe(meta.id.toLowerCase())
})

test('document order is newest first', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const first = await createDocument(store, { name: 'a.pdf' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await createDocument(store, { name: 'b.pdf' })
  expect(store.list().map((meta) => meta.id)).toEqual([second.id, first.id])
})

test('saveAnnotations with baseIds implements the additive 3-way merge', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const item = (id: string, note: string, extra: Partial<Annotation> = {}): Annotation =>
    annotation({ id, blockKey: 'b3:ab12cd34', start: 0, end: 5, quote: 'hello', note, ...extra })

  const meta = await createDocument(store)
  // The client starts from A + B.
  await store.saveAnnotations(meta.id, { items: [item('a', 'A'), item('b', 'B')] })

  // A concurrent AI/agent writer appends C, which is unknown to the client.
  await store.mutateAnnotations(meta.id, (items) => {
    items.push(item('c', 'AI note', { origin: 'ai', aspect: 'method' }))
    return { items } as unknown as Annotation[]
  })

  // Client edits A, deletes B, adds D and sends the base id set it had loaded.
  const persisted = await store.saveAnnotations(meta.id, {
    items: [item('a', 'A edited'), item('d', 'D')],
    baseIds: ['a', 'b'],
  })
  expect(persisted.items.map((entry) => entry.id).sort()).toEqual(['a', 'c', 'd'])
  expect(persisted.items.find((entry) => entry.id === 'a')?.note).toBe('A edited')
  expect(persisted.items.find((entry) => entry.id === 'c')?.note).toBe('AI note')
  expect(persisted.items.find((entry) => entry.id === 'b')).toBeUndefined()
  // The returned list is exactly what was persisted.
  const loaded = await store.loadAnnotations(meta.id)
  expect(loaded.items.map((entry) => entry.id).sort()).toEqual(['a', 'c', 'd'])

  // Duplicate / non-string base ids are tolerated; unknown ids never delete data.
  const again = await store.saveAnnotations(meta.id, {
    items: [item('a', 'A again')],
    baseIds: ['a', 'a', '', 42 as unknown as string, 'ghost'],
  })
  expect(again.items.map((entry) => entry.id).sort()).toEqual(['a', 'c', 'd'])

  // No baseIds (or a non-array value) keeps the replace semantics unchanged.
  const replaced = await store.saveAnnotations(meta.id, { items: [item('z', 'Z')] })
  expect(replaced.items.map((entry) => entry.id)).toEqual(['z'])
  expect((await store.loadAnnotations(meta.id)).items.map((entry) => entry.id)).toEqual(['z'])
  const legacy = await store.saveAnnotations(meta.id, {
    items: [item('y', 'Y')],
    baseIds: 'a' as unknown as string[],
  })
  expect(legacy.items.map((entry) => entry.id)).toEqual(['y'])

  // An empty base set means "the client had loaded nothing": every on-disk
  // annotation is a concurrent addition and is appended, never deleted.
  const keepUnknown = await store.saveAnnotations(meta.id, { items: [], baseIds: [] })
  expect(keepUnknown.items.map((entry) => entry.id)).toEqual(['y'])
})

test('mutateAnnotations is an atomic read-modify-write that loses no concurrent writer', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const item = (id: string): Annotation => annotation({ id, note: id })
  const meta = await createDocument(store)
  expect(await store.mutateAnnotations(meta.id, (items) => items)).toEqual({ version: 1, items: [] })

  // Interleaved appends: every writer must survive.
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.mutateAnnotations(meta.id, (items) => {
        items.push(item(`n-${index}`))
        return { items } as unknown as Annotation[]
      }),
    ),
  )
  const loaded = await store.loadAnnotations(meta.id)
  expect(loaded.items.length).toBe(20)
  expect(loaded.items.map((entry) => entry.id).sort()).toEqual(
    Array.from({ length: 20 }, (_, index) => `n-${index}`).sort(),
  )

  // A new array replaces the list; an undefined return persists in-place edits.
  const replaced = await store.mutateAnnotations(meta.id, () => [item('only')])
  expect(replaced.items.map((entry) => entry.id)).toEqual(['only'])
  const inPlace = await store.mutateAnnotations(meta.id, (items) => {
    const first = items[0]
    if (first !== undefined) first.note = 'changed in place'
    return items
  })
  expect(inPlace.items[0]?.note).toBe('changed in place')
  // Async mutators and {items} wrappers are supported.
  const asyncResult = await store.mutateAnnotations(meta.id, async (items) => {
    items.push(item('async-note'))
    return { items } as unknown as Annotation[]
  })
  expect(asyncResult.items.length).toBe(2)

  // A throwing mutator rejects without writing anything.
  await expect(
    store.mutateAnnotations(meta.id, () => {
      throw new Error('mutation failed')
    }),
  ).rejects.toThrow(/mutation failed/)
  expect((await store.loadAnnotations(meta.id)).items.length).toBe(2)

  // Corrupt annotation files read as an empty list and are repaired by the write.
  await writeFile(join(store.docDir(meta.id), 'annotations.json'), '{broken json')
  const repaired = await store.mutateAnnotations(meta.id, (items) => {
    expect(items).toEqual([])
    return [item('repaired')]
  })
  expect(repaired.items.map((entry) => entry.id)).toEqual(['repaired'])

  // Unknown documents, invalid ids and non-function mutators reject cleanly.
  await expect(store.mutateAnnotations(randomUUID(), (items) => items)).rejects.toMatchObject({
    code: 'not-found',
  })
  await expect(
    store.mutateAnnotations('../escape', (items) => items),
  ).rejects.toMatchObject({ code: 'bad-request' })
  await expect(
    store.mutateAnnotations(meta.id, 'nope' as unknown as (items: Annotation[]) => Annotation[]),
  ).rejects.toMatchObject({ code: 'bad-request' })
})

test('reads a frozen 1.0.0-format library without migrating it', async () => {
  const dataDir = await makeDataDir()
  const documentId = randomUUID()
  const documentDir = join(dataDir, 'documents', documentId)
  await mkdir(join(documentDir, 'parsed', 'images'), { recursive: true })
  // A minimal but realistic 1.0.0 `meta.json`: every parse field is present and
  // the frozen repair/progress fields must survive a round-trip untouched.
  const frozenMeta = {
    schemaVersion: 1,
    id: documentId,
    title: 'Frozen Paper',
    originalName: 'frozen.pdf',
    ext: '.pdf',
    mime: 'application/pdf',
    size: 18,
    sha256: 'a'.repeat(64),
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    status: 'parsed',
    error: null,
    parse: {
      engine: 'standard',
      provider: null,
      modelVersion: 'vlm',
      language: 'ch',
      options: { engine: 'standard', modelVersion: 'vlm', language: 'ch', isOcr: false },
      phase: null,
      remoteState: null,
      taskId: null,
      batchId: null,
      startedAt: '2025-01-01T00:00:00.000Z',
      finishedAt: '2025-01-01T00:05:00.000Z',
      pages: 13,
      progress: { extracted: 13, total: 13 },
      hasContentList: true,
      local: null,
      repairPages: [3],
      repairRestore: null,
      repairPreviousPages: 13,
      repairError: null,
      repair: { pages: [3], failedPages: [] },
    },
  }
  await writeFile(join(documentDir, 'meta.json'), `${JSON.stringify(frozenMeta, null, 2)}\n`)
  await writeFile(join(documentDir, 'source.pdf'), '%PDF-1.4 frozen')
  await writeFile(join(documentDir, 'parsed', 'full.md'), '# Frozen Paper\n\nBody text.\n')
  await writeFile(
    join(documentDir, 'parsed', 'content_list.json'),
    JSON.stringify([{ type: 'text', text: 'Body', page_idx: 0 }, { type: 'text', text: 'More', page_idx: 12 }]),
  )
  // 1.0.0 annotations carry the AI `model` provenance object.
  await writeFile(
    join(documentDir, 'annotations.json'),
    `${JSON.stringify({
      version: 1,
      items: [
        {
          id: 'ai-note',
          blockKey: 'b1:deadbeef',
          start: 0,
          end: 4,
          quote: 'Body',
          note: 'claim',
          color: 'sage',
          createdAt: '2025-01-02T00:00:00.000Z',
          origin: 'ai',
          aspect: 'method',
          chatId: 'chat-1',
          messageId: 'msg-1',
          model: { provider: 'deepseek', model: 'deepseek-flash' },
          stale: true,
          staleReason: 'quote-moved',
          reanchored: true,
        },
      ],
    }, null, 2)}\n`,
  )
  await writeFile(
    join(documentDir, 'translations.json'),
    `${JSON.stringify({ version: 1, targetLanguage: 'zh', entries: { 'b1:deadbeef': '正文' } }, null, 2)}\n`,
  )
  await writeFile(join(documentDir, 'chat.json'), `${JSON.stringify({ version: 1, messages: [{ id: 'm1', role: 'user', question: 'hi' }] }, null, 2)}\n`)
  await writeFile(join(documentDir, 'graph.json'), `${JSON.stringify({ nodes: [{ id: 'n1' }], edges: [] }, null, 2)}\n`)
  await writeFile(join(dataDir, 'library-graph.json'), `${JSON.stringify({ nodes: [{ id: 'p1' }], edges: [] }, null, 2)}\n`)
  // 1.0.0 preferences included client-owned keys that 1.0.0 drops (e.g. marginTab);
  // normalization must tolerate them without rewriting the file.
  await writeFile(
    join(dataDir, 'preferences.json'),
    `${JSON.stringify({ targetLanguage: 'en', readingMode: 'bilingual', marginTab: 'outline', libraryView: 'graph' }, null, 2)}\n`,
  )

  const store = makeStore({ dataDir })
  await store.init()
  expect(store.list().map((meta) => meta.id)).toEqual([documentId])
  expect(store.stats()).toEqual({ total: 1, parsed: 1, parsing: 0, failed: 0 })
  const meta = store.get(documentId)
  expect(meta?.title).toBe('Frozen Paper')
  expect(meta?.parse?.repair).toEqual({ pages: [3], failedPages: [] })
  expect(meta?.parse?.pages).toBe(13)

  const parsed = await store.readMarkdown(documentId)
  expect(parsed.markdown).toBe('# Frozen Paper\n\nBody text.\n')
  expect(parsed.pages).toBe(13)

  const annotations = await store.loadAnnotations(documentId)
  expect(annotations.items.length).toBe(1)
  expect(annotations.items[0]?.model).toEqual({ provider: 'deepseek', model: 'deepseek-flash' })
  expect(annotations.items[0]?.origin).toBe('ai')
  expect(annotations.items[0]?.stale).toBe(true)

  const translations = await store.loadTranslations(documentId)
  expect(translations.entries['b1:deadbeef']).toBe('正文')
  const chat = await store.readAux<{ version: number; messages: unknown[] }>(documentId, 'chat.json')
  expect(chat?.messages.length).toBe(1)
  const graph = await store.readAux<{ nodes: unknown[] }>(documentId, 'graph.json')
  expect(graph?.nodes.length).toBe(1)
  expect((await store.readLibraryAux<{ nodes: unknown[] }>('library-graph.json'))?.nodes.length).toBe(1)

  const preferences = await store.readPreferences()
  expect(preferences.targetLanguage).toBe('en')
  expect(preferences.readingMode).toBe('bilingual')
  expect(preferences.libraryView).toBe('graph')
  // The raw frozen file is untouched by reads (no migration on open).
  const preferencesRaw = await readFile(join(dataDir, 'preferences.json'), 'utf8')
  expect(preferencesRaw).toContain('marginTab')

  // A 1.0.0 write keeps the same frozen envelope shape.
  await store.saveAnnotations(documentId, { items: annotations.items })
  const annotationsRaw = await readFile(join(documentDir, 'annotations.json'), 'utf8')
  expect(Object.keys(JSON.parse(annotationsRaw) as object).sort()).toEqual(['items', 'version'])
  await store.writePreferences(preferences)
  const savedPreferences = JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')) as {
    marginTab?: string
    targetLanguage?: string
  }
  expect(savedPreferences.targetLanguage).toBe('en')
  expect('marginTab' in savedPreferences).toBe(false)
})

test('quarantined parallel writes leave readable files', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const meta = await createDocument(store)
  await Promise.all([
    store.update(meta.id, { title: 'A' }),
    store.saveAnnotations(meta.id, { items: [annotation({ id: 'a' })] }),
    store.saveTranslations(meta.id, { version: 1, targetLanguage: 'en', entries: { a: 'b' } }),
  ])
  const reloaded = makeStore({ dataDir })
  await reloaded.init()
  expect(reloaded.get(meta.id)?.title).toBe('A')
  expect((await reloaded.loadAnnotations(meta.id)).items.length).toBe(1)
  expect((await reloaded.loadTranslations(meta.id)).entries.a).toBe('b')
  // A stray directory that is not a document is ignored on init.
  await mkdir(join(dataDir, 'documents', 'not-a-document'), { recursive: true })
  const third = makeStore({ dataDir })
  await third.init()
  expect(third.stats().total).toBe(1)
  expect(await readdir(join(dataDir, 'documents'))).toContain('not-a-document')
})

test('update can reset the parse state and rejects malformed parse patches', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const meta = await createDocument(store)
  await store.update(meta.id, { parse: { engine: 'standard', pages: 3 } })
  const reset = await store.update(meta.id, { parse: null })
  expect(reset.parse).toBeNull()
  await expect(store.update(meta.id, { parse: 'nope' as never })).rejects.toMatchObject({
    code: 'bad-request',
  })
  await expect(store.update(meta.id, { title: 'x', status: 'bogus' as never })).rejects.toMatchObject({
    code: 'bad-request',
  })
})

test('createFromFile validates its inputs and cleans up on failure', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  await store.init()
  const id = randomUUID()
  await expect(
    store.createFromFile({ id, tempPath: '', originalName: 'paper.pdf' }),
  ).rejects.toMatchObject({ code: 'bad-request' })
  await expect(
    store.createFromFile({ id, tempPath: store.newTempPath(id), originalName: 'notes.txt' }),
  ).rejects.toMatchObject({ code: 'unsupported-type' })

  const tempPath = store.newTempPath(id)
  await writeFile(tempPath, '')
  await expect(store.createFromFile({ id, tempPath, originalName: 'paper.pdf' })).rejects.toMatchObject({
    code: 'bad-request',
  })
  // The failed create leaves no document directory behind.
  expect(existsSync(store.docDir(id))).toBe(false)

  const secondId = randomUUID()
  await expect(
    store.createFromFile({ id: secondId, tempPath: join(dataDir, 'missing.bin'), originalName: 'x.pdf' }),
  ).rejects.toMatchObject({ code: 'bad-request' })
  // A duplicate id is a conflict, not a silent overwrite.
  const duplicate = await createDocument(store)
  const duplicateTemp = store.newTempPath(duplicate.id)
  await writeFile(duplicateTemp, '%PDF-1.4 duplicate')
  await expect(
    store.createFromFile({ id: duplicate.id, tempPath: duplicateTemp, originalName: 'dup.pdf' }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(store.docDir(duplicate.id) + '/meta.json', 'utf8')).toContain(duplicate.id)
})

test('readMarkdown prefers the plain content_list.json and tolerates the {content_list} wrapper', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const document = await createDocument(store)
  const parsedDir = store.parsedDir(document.id)
  await mkdir(parsedDir, { recursive: true })
  await writeFile(join(parsedDir, 'full.md'), '# Title\n')
  await writeFile(join(parsedDir, 'b_content_list.json'), JSON.stringify([{ page_idx: 1 }]))
  await writeFile(join(parsedDir, 'content_list.json'), JSON.stringify({ content_list: [{ page_idx: 0 }, { page_idx: 4 }] }))
  expect((await store.readMarkdown(document.id)).pages).toBe(5)

  // A corrupt preferred file falls through to the next candidate; markdown
  // stays readable even when every content list is unreadable.
  await writeFile(join(parsedDir, 'content_list.json'), '{broken')
  await writeFile(join(parsedDir, 'a_content_list.json'), '{broken')
  const result = await store.readMarkdown(document.id)
  expect(result.markdown).toBe('# Title\n')
  expect(result.contentList).toEqual([{ page_idx: 1 }])
  await writeFile(join(parsedDir, 'b_content_list.json'), '{broken')
  expect((await store.readMarkdown(document.id)).contentList).toBeNull()
})

test('mutateAux refuses non-serializable values without touching the file', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const document = await createDocument(store)
  const circular: Record<string, unknown> = { a: 1 }
  circular.self = circular
  await expect(store.mutateAux(document.id, 'graph.json', () => circular as never)).rejects.toThrow(
    TypeError,
  )
  expect(await store.readAux(document.id, 'graph.json')).toBeUndefined()
})

test('saveAnnotations enforces the annotation cap and tolerates unknown ids', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const document = await createDocument(store)
  const items = Array.from({ length: 5001 }, (_, index) => annotation({ id: `a-${index}` }))
  await expect(store.saveAnnotations(document.id, { items })).rejects.toMatchObject({ code: 'too-large' })
  // Just under the cap is accepted; unusable entries are dropped.
  const accepted = await store.saveAnnotations(document.id, {
    items: [...items.slice(0, 4999), null as unknown as Annotation],
  })
  expect(accepted.items.length).toBe(4999)
  await expect(store.saveAnnotations(randomUUID(), { items: [] })).rejects.toMatchObject({
    code: 'not-found',
  })
})

test('metadata-derived source paths never escape the document directory', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  const document = await createDocument(store)
  // A hand-edited meta.json with a path-fragment extension must not escape.
  const metaPath = join(store.docDir(document.id), 'meta.json')
  const raw = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
  raw.ext = '../escape'
  raw.originalName = 'no-extension-name'
  await writeFile(metaPath, JSON.stringify(raw))
  const reopened = makeStore({ dataDir })
  await reopened.init()
  await expect(reopened.sourcePath(document.id)).rejects.toMatchObject({ code: 'host-error' })
})

test('writePreferences normalizes before persisting', async () => {
  const dataDir = await makeDataDir()
  const store = makeStore({ dataDir })
  await store.writePreferences({ readingMode: 'bogus', readingScale: 99, targetLanguage: 'nope' } as never)
  const loaded = await store.readPreferences()
  expect(loaded.readingMode).toBe('original')
  expect(loaded.readingScale).toBe(1)
  expect(loaded.targetLanguage).toBe('zh')
  const raw = JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')) as {
    readingMode?: string
  }
  expect(raw.readingMode).toBe('original')
})
