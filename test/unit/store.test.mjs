/**
 * Unit tests for the on-disk library store (`lib/store.js`): create / update /
 * remove, persistence across store instances, annotation atomicity, parsed
 * markdown reads, and diagnostics capping.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../lib/store.js'

/** Create an isolated data directory. */
async function makeDataDir() {
  return mkdtemp(join(tmpdir(), 'dsh-litnotes-store-'))
}

/** Create a document backed by a temp file with the given bytes. */
async function createDocument(store, dataDir, { name = 'paper.pdf', bytes = '%PDF-1.4 test', title } = {}) {
  const id = randomUUID()
  const tempPath = store.newTempPath(id)
  await writeFile(tempPath, bytes)
  const meta = await store.createFromFile({ id, tempPath, originalName: name, title })
  return meta
}

test('createFromFile hashes, sizes and stores the source atomically', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    const bytes = '%PDF-1.4 hello mineru'
    const meta = await createDocument(store, dataDir, { bytes, title: 'My Paper' })
    assert.equal(meta.schemaVersion, 1)
    assert.equal(meta.title, 'My Paper')
    assert.equal(meta.originalName, 'paper.pdf')
    assert.equal(meta.ext, '.pdf')
    assert.equal(meta.mime, 'application/pdf')
    assert.equal(meta.size, Buffer.byteLength(bytes))
    assert.equal(meta.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(meta.status, 'uploaded')
    assert.equal(meta.error, null)

    // The source file is inside the document directory and no temp file remains.
    const sourcePath = await store.sourcePath(meta.id)
    assert.equal(await readFile(sourcePath, 'utf8'), bytes)
    assert.equal(existsSync(store.newTempPath(meta.id)), false)

    const list = store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, meta.id)
    assert.notEqual(list[0], meta, 'list returns defensive copies')
    list[0].title = 'mutated'
    assert.equal(store.get(meta.id).title, 'My Paper')
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a second store instance reloads persisted metadata', async () => {
  const dataDir = await makeDataDir()
  const first = createStore({ dataDir })
  let id
  try {
    const meta = await createDocument(first, dataDir)
    id = meta.id
    await first.update(id, { title: 'Persisted Title' })
  } finally {
    await first.dispose()
  }
  const second = createStore({ dataDir })
  try {
    await second.init()
    const meta = second.get(id)
    assert.ok(meta)
    assert.equal(meta.title, 'Persisted Title')
    assert.equal(second.stats().total, 1)
  } finally {
    await second.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('update merges top-level fields and the parse sub-object', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    const meta = await createDocument(store, dataDir)
    const parsing = await store.update(meta.id, {
      status: 'parsing',
      parse: { engine: 'standard', phase: 'submitting', taskId: null, batchId: null },
    })
    assert.equal(parsing.status, 'parsing')
    assert.equal(parsing.parse.engine, 'standard')
    assert.equal(parsing.parse.phase, 'submitting')

    const polling = await store.update(meta.id, { parse: { phase: 'polling', batchId: 'batch-1' } })
    assert.equal(polling.parse.engine, 'standard', 'previous parse fields are preserved')
    assert.equal(polling.parse.phase, 'polling')
    assert.equal(polling.parse.batchId, 'batch-1')
    assert.ok(polling.updatedAt >= polling.createdAt, 'updatedAt is not older than createdAt')

    await assert.rejects(store.update(meta.id, { status: 'bogus' }), /无效的文档状态/)
    await assert.rejects(store.update('not-a-uuid', { title: 'x' }), /无效的文档 ID/)
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('annotations persist atomically and concurrent saves never corrupt the file', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    const meta = await createDocument(store, dataDir)
    const empty = await store.loadAnnotations(meta.id)
    assert.deepEqual(empty, { version: 1, items: [] })

    const item = {
      id: randomUUID(),
      blockKey: 'b3:ab12cd34',
      start: 4,
      end: 12,
      quote: 'hello world',
      note: 'a note',
      color: 'sage',
    }
    await store.saveAnnotations(meta.id, { version: 1, items: [item] })
    const loaded = await store.loadAnnotations(meta.id)
    assert.equal(loaded.items.length, 1)
    assert.equal(loaded.items[0].blockKey, 'b3:ab12cd34')
    assert.equal(loaded.items[0].color, 'sage')

    // Concurrent whole-list replacements must leave valid JSON, one winner.
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.saveAnnotations(meta.id, {
          version: 1,
          items: [{ ...item, id: randomUUID(), note: `note-${index}` }],
        }),
      ),
    )
    const final = await store.loadAnnotations(meta.id)
    assert.equal(final.items.length, 1)
    assert.match(final.items[0].note, /^note-\d+$/)
    const raw = await readFile(join(store.docDir(meta.id), 'annotations.json'), 'utf8')
    assert.doesNotThrow(() => JSON.parse(raw))
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['items', 'version'])

    // Unknown colors fall back to yellow; malformed items are dropped.
    const saved = await store.saveAnnotations(meta.id, {
      version: 1,
      items: [{ ...item, id: randomUUID(), color: 'neon' }, { nope: true }],
    })
    assert.equal(saved.items.length, 1)
    assert.equal(saved.items[0].color, 'yellow')
    await assert.rejects(store.saveAnnotations(meta.id, { items: 'nope' }), /items 必须是数组/)
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('translations round-trip and invalid payloads are rejected', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    const meta = await createDocument(store, dataDir)
    await store.saveTranslations(meta.id, {
      version: 1,
      targetLanguage: 'zh',
      entries: { 'b0:deadbeef': '你好', 'b1:cafebabe': '世界' },
    })
    const loaded = await store.loadTranslations(meta.id)
    assert.equal(loaded.targetLanguage, 'zh')
    assert.equal(loaded.entries['b0:deadbeef'], '你好')
    await assert.rejects(store.saveTranslations(meta.id, { entries: [] }), /entries 必须是对象/)
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('readMarkdown returns markdown, content list and page count; not-parsed otherwise', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    const parsed = await createDocument(store, dataDir, { name: 'parsed.pdf' })
    const unparsed = await createDocument(store, dataDir, { name: 'raw.pdf' })
    const parsedDir = store.parsedDir(parsed.id)
    const { mkdir } = await import('node:fs/promises')
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
    assert.equal(result.markdown, '# Heading\n\nBody text.')
    assert.equal(result.contentList.length, 2)
    assert.equal(result.pages, 3)

    await assert.rejects(store.readMarkdown(unparsed.id), (error) => {
      assert.equal(error.code, 'not-parsed')
      return true
    })
    await assert.rejects(store.loadAnnotations('../../etc/passwd'), (error) => {
      assert.equal(error.code, 'bad-request')
      return true
    })
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('remove deletes the directory and forgets the document', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    const meta = await createDocument(store, dataDir)
    const docDir = store.docDir(meta.id)
    assert.equal(existsSync(docDir), true)
    await store.remove(meta.id)
    assert.equal(existsSync(docDir), false)
    assert.equal(store.get(meta.id), undefined)
    assert.equal(store.list().length, 0)
    await assert.rejects(store.remove(meta.id), (error) => {
      assert.equal(error.code, 'not-found')
      return true
    })
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('stale temp uploads are cleaned on init but fresh ones are kept', async () => {
  const dataDir = await makeDataDir()
  const first = createStore({ dataDir })
  const staleId = randomUUID()
  const freshId = randomUUID()
  const stalePath = first.newTempPath(staleId)
  const freshPath = first.newTempPath(freshId)
  try {
    await writeFile(stalePath, 'partial bytes')
    await writeFile(freshPath, 'in-flight bytes')
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const { utimes } = await import('node:fs/promises')
    await utimes(stalePath, hourAgo, hourAgo)
    await first.init()
    assert.equal(existsSync(stalePath), false)
    assert.equal(existsSync(freshPath), true)
  } finally {
    await first.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('appendDiagnostic caps the log at 200 lines and never throws', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    await store.init()
    for (let index = 0; index < 205; index += 1) {
      await store.appendDiagnostic({ event: 'active', clientVersion: 'test', index })
    }
    const file = join(dataDir, 'diagnostics', 'client.log')
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 200)
    const first = JSON.parse(lines[0])
    const last = JSON.parse(lines[lines.length - 1])
    assert.equal(first.index, 5)
    assert.equal(last.index, 204)
    assert.equal(typeof last.at, 'string')
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('ids are validated before any path is built', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    await assert.rejects(async () => store.docDir('../../etc'), /无效的文档 ID/)
    await assert.rejects(async () => store.parsedDir('/etc/passwd'), /无效的文档 ID/)
    await assert.rejects(async () => store.newTempPath('nope'), /无效的文档 ID/)
    const meta = await createDocument(store, dataDir)
    assert.throws(() => store.parsedDir(randomUUID()), (error) => {
      assert.equal(error.code, 'not-found')
      return true
    })
    assert.throws(() => store.docDir('../escape'), /无效的文档 ID/)
    assert.equal(meta.id, meta.id.toLowerCase())
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('document order is newest first', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  try {
    const first = await createDocument(store, dataDir, { name: 'a.pdf' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await createDocument(store, dataDir, { name: 'b.pdf' })
    const ids = store.list().map((meta) => meta.id)
    assert.deepEqual(ids, [second.id, first.id])
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('saveAnnotations with baseIds implements the additive 3-way merge', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  /** One minimal annotation item. */
  const item = (id, note, extra = {}) => ({
    id,
    blockKey: 'b3:ab12cd34',
    start: 0,
    end: 5,
    quote: 'hello',
    note,
    color: 'sage',
    ...extra,
  })
  try {
    const meta = await createDocument(store, dataDir)
    // The client starts from A + B.
    await store.saveAnnotations(meta.id, { version: 1, items: [item('a', 'A'), item('b', 'B')] })

    // A concurrent AI/agent writer appends C, which is unknown to the client.
    await store.mutateAnnotations(meta.id, (items) => {
      items.push(item('c', 'AI note', { origin: 'ai', aspect: 'method' }))
      return { items }
    })

    // Client edits A, deletes B, adds D and sends the base id set it had loaded.
    const persisted = await store.saveAnnotations(meta.id, {
      version: 1,
      items: [item('a', 'A edited'), item('d', 'D')],
      baseIds: ['a', 'b'],
    })
    assert.deepEqual(persisted.items.map((entry) => entry.id).sort(), ['a', 'c', 'd'])
    assert.equal(persisted.items.find((entry) => entry.id === 'a').note, 'A edited')
    assert.equal(persisted.items.find((entry) => entry.id === 'c').note, 'AI note', 'concurrent addition survives')
    assert.equal(persisted.items.find((entry) => entry.id === 'b'), undefined, 'base-id deletion wins')
    // The returned list is exactly what was persisted.
    const loaded = await store.loadAnnotations(meta.id)
    assert.deepEqual(loaded.items.map((entry) => entry.id).sort(), ['a', 'c', 'd'])

    // Duplicate / non-string base ids are tolerated; unknown ids never delete data.
    const again = await store.saveAnnotations(meta.id, {
      version: 1,
      items: [item('a', 'A again')],
      baseIds: ['a', 'a', '', 42, 'ghost'],
    })
    assert.deepEqual(again.items.map((entry) => entry.id).sort(), ['a', 'c', 'd'])

    // No baseIds (or a non-array value) keeps the replace semantics unchanged.
    const replaced = await store.saveAnnotations(meta.id, { version: 1, items: [item('z', 'Z')] })
    assert.deepEqual(replaced.items.map((entry) => entry.id), ['z'])
    assert.deepEqual((await store.loadAnnotations(meta.id)).items.map((entry) => entry.id), ['z'])
    const legacy = await store.saveAnnotations(meta.id, { version: 1, items: [item('y', 'Y')], baseIds: 'a' })
    assert.deepEqual(legacy.items.map((entry) => entry.id), ['y'])

    // An empty base set means "the client had loaded nothing": every on-disk
    // annotation is a concurrent addition and is appended, never deleted.
    const keepUnknown = await store.saveAnnotations(meta.id, { version: 1, items: [], baseIds: [] })
    assert.deepEqual(keepUnknown.items.map((entry) => entry.id), ['y'])
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('mutateAnnotations is an atomic read-modify-write that loses no concurrent writer', async () => {
  const dataDir = await makeDataDir()
  const store = createStore({ dataDir })
  /** One minimal annotation item. */
  const item = (id) => ({ id, blockKey: 'b3:ab12cd34', start: 0, end: 5, quote: 'hello', note: id, color: 'sage' })
  try {
    const meta = await createDocument(store, dataDir)
    assert.deepEqual(await store.mutateAnnotations(meta.id, (items) => items), { version: 1, items: [] })

    // Interleaved appends: every writer must survive.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.mutateAnnotations(meta.id, (items) => {
          items.push(item(`n-${index}`))
          return { items }
        }),
      ),
    )
    const loaded = await store.loadAnnotations(meta.id)
    assert.equal(loaded.items.length, 20)
    assert.deepEqual(
      loaded.items.map((entry) => entry.id).sort(),
      Array.from({ length: 20 }, (_, index) => `n-${index}`).sort(),
    )

    // A new array replaces the list; an undefined return persists in-place edits.
    const replaced = await store.mutateAnnotations(meta.id, () => [item('only')])
    assert.deepEqual(replaced.items.map((entry) => entry.id), ['only'])
    const inPlace = await store.mutateAnnotations(meta.id, (items) => {
      items[0].note = 'changed in place'
    })
    assert.equal(inPlace.items[0].note, 'changed in place')
    // Async mutators and {items} wrappers are supported.
    const asyncResult = await store.mutateAnnotations(meta.id, async (items) => {
      items.push(item('async-note'))
      return { items }
    })
    assert.equal(asyncResult.items.length, 2)

    // A throwing mutator rejects without writing anything.
    await assert.rejects(
      store.mutateAnnotations(meta.id, () => {
        throw new Error('mutation failed')
      }),
      /mutation failed/,
    )
    assert.equal((await store.loadAnnotations(meta.id)).items.length, 2)

    // Corrupt annotation files read as an empty list and are repaired by the write.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(store.docDir(meta.id), 'annotations.json'), '{broken json')
    const repaired = await store.mutateAnnotations(meta.id, (items) => {
      assert.deepEqual(items, [])
      return [item('repaired')]
    })
    assert.deepEqual(repaired.items.map((entry) => entry.id), ['repaired'])

    // Unknown documents, invalid ids and non-function mutators reject cleanly.
    await assert.rejects(store.mutateAnnotations(randomUUID(), (items) => items), (error) => error.code === 'not-found')
    await assert.rejects(store.mutateAnnotations('../escape', (items) => items), (error) => error.code === 'bad-request')
    await assert.rejects(store.mutateAnnotations(meta.id, 'nope'), (error) => error.code === 'bad-request')
  } finally {
    await store.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})
