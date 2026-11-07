/**
 * Standard (precise) MinerU API end-to-end flow plus the complete service
 * surface the browser client and the agent tool consume:
 * upload → parse → ZIP download → extraction on disk → markdown/content list →
 * library list, annotations, translations, settings, translations and tools.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHarness, importDocument } from './harness.mjs'
import {
  figureBytes,
  pdfBytes,
  standardContentList,
  standardMarkdown,
  waitForStatus,
} from './helpers.mjs'

test('standard parse end-to-end: upload, poll, extract markdown/content-list/images', async (t) => {
  const harness = await createHarness(t)
  const doc = await importDocument(harness, { name: 'sparse-route.pdf' })

  // --- start ---------------------------------------------------------------
  const started = await harness.service.startParse(doc.id, { engine: 'standard' })
  assert.equal(started.document.status, 'parsing')
  assert.equal(started.document.parse.engine, 'standard')
  assert.equal(started.document.parse.modelVersion, 'vlm')
  assert.equal(started.document.parse.language, 'ch')

  const parsed = await waitForStatus(harness.store, doc.id, 'parsed', { timeout: 10_000 })
  assert.equal(parsed.status, 'parsed')
  assert.equal(parsed.error, null)
  assert.equal(parsed.parse.engine, 'standard')
  assert.equal(parsed.parse.phase, null)
  assert.equal(parsed.parse.pages, 3)
  assert.equal(parsed.parse.hasContentList, true)
  assert.equal(parsed.title, 'Sparse Expert Routing for Efficient Document Retrieval')

  // --- what the mock received ---------------------------------------------
  assert.equal(harness.mock.state.batches.size, 1)
  const batch = [...harness.mock.state.batches.values()][0]
  assert.equal(batch.request.files[0].name, 'sparse-route.pdf')
  assert.equal(batch.request.files[0].data_id, doc.id)
  assert.equal(batch.request.model_version, 'vlm')
  assert.equal(batch.request.language, 'ch')
  assert.equal(batch.request.enable_formula, true)
  assert.equal(batch.request.enable_table, true)
  const authHeaders = harness.mock.state.requests
    .filter((request) => request.path.startsWith('/api/v4/') && !request.path.startsWith('/api/v4/upload/'))
    .map((request) => request.auth)
  assert.ok(authHeaders.length >= 2, 'batch create + polls were authenticated')
  for (const header of authHeaders) assert.equal(header, `Bearer ${harness.mock.token}`)
  const uploaded = harness.mock.state.lastStandardUpload()
  assert.deepEqual(uploaded, pdfBytes(), 'exactly the source bytes were uploaded')
  // The signed upload URL is used, not a relative path.
  assert.match(batch.request.uploadId ?? '', /^mock-batch-/)
  assert.ok(harness.mock.state.requests.some((request) => request.path === `/api/v4/upload/${batch.batchId}`))

  // --- what landed on disk -------------------------------------------------
  const parsedDir = join(harness.docDir(doc.id), 'parsed')
  assert.equal(existsSync(join(parsedDir, 'full.md')), true)
  assert.equal(existsSync(join(parsedDir, 'sample_content_list.json')), true)
  assert.equal(existsSync(join(parsedDir, 'images', 'fig1.svg')), true)
  assert.equal(existsSync(join(parsedDir, 'layout.json')), false, 'unwanted ZIP entries are not extracted')
  assert.equal(existsSync(join(parsedDir, 'paper.pdf')), false, 'the original source is not re-extracted')

  assert.equal(await readFile(join(parsedDir, 'full.md'), 'utf8'), standardMarkdown())
  assert.deepEqual(
    JSON.parse(await readFile(join(parsedDir, 'sample_content_list.json'), 'utf8')),
    standardContentList(),
  )
  assert.deepEqual(await readFile(join(parsedDir, 'images', 'fig1.svg')), figureBytes())

  // --- reads through the service ------------------------------------------
  const read = await harness.service.readMarkdown(doc.id)
  assert.equal(read.markdown, standardMarkdown())
  assert.ok(Array.isArray(read.contentList) && read.contentList.length > 30)
  assert.equal(read.pages, 3)

  const listed = await harness.service.listDocuments()
  assert.equal(listed.documents.length, 1)
  assert.equal(listed.documents[0].id, doc.id)
  assert.equal(listed.documents[0].status, 'parsed')
  assert.equal(listed.documents[0].sha256, undefined, 'DocSummary omits the heavy hash')

  const full = await harness.service.getDocument(doc.id)
  assert.equal(full.document.id, doc.id)
  assert.deepEqual(full.annotations, { version: 1, items: [] })
  assert.equal(full.translations.version, 1)
  assert.equal(full.translations.targetLanguage, 'zh')
  assert.deepEqual(full.translations.entries, {})
})

test('service annotations, translations and document reads round-trip', async (t) => {
  const harness = await createHarness(t)
  const doc = await importDocument(harness)
  await harness.service.startParse(doc.id, { engine: 'standard' })
  await waitForStatus(harness.store, doc.id, 'parsed', { timeout: 10_000 })

  // --- annotations ---------------------------------------------------------
  const annotations = [
    {
      id: 'ann-1',
      blockKey: 'b4:1a2b3c4d',
      start: 6,
      end: 25,
      quote: 'Dense retrieval models',
      note: '这是一条页边批注。',
      color: 'yellow',
    },
    {
      id: 'ann-2',
      blockKey: 'b8:deadbeef',
      start: 0,
      end: 10,
      quote: 'Passage retrieval',
      note: '',
      color: 'sage',
    },
  ]
  const savedAnnotations = await harness.service.saveAnnotations(doc.id, annotations)
  assert.equal(savedAnnotations.saved, true)
  assert.equal(savedAnnotations.items.length, 2, 'saveAnnotations returns the persisted merged list')
  const afterSave = await harness.service.getDocument(doc.id)
  assert.equal(afterSave.annotations.version, 1)
  assert.equal(afterSave.annotations.items.length, 2)
  const first = afterSave.annotations.items.find((item) => item.id === 'ann-1')
  assert.equal(first.blockKey, 'b4:1a2b3c4d')
  assert.equal(first.start, 6)
  assert.equal(first.end, 25)
  assert.equal(first.quote, 'Dense retrieval models')
  assert.equal(first.note, '这是一条页边批注。')
  assert.equal(first.color, 'yellow')
  assert.equal(typeof first.createdAt, 'string')
  // persisted on disk, readable through the store
  assert.equal((await harness.store.loadAnnotations(doc.id)).items.length, 2)
  const onDisk = JSON.parse(await readFile(join(harness.docDir(doc.id), 'annotations.json'), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.items.length, 2)

  // --- translations --------------------------------------------------------
  const entries = { 'b8:deadbeef': '段落检索几乎是所有问答系统的第一阶段。' }
  assert.deepEqual(await harness.service.saveTranslations(doc.id, 'zh', entries), { saved: true })
  const afterTranslate = await harness.service.getDocument(doc.id)
  assert.equal(afterTranslate.translations.targetLanguage, 'zh')
  assert.deepEqual(afterTranslate.translations.entries, entries)

  // --- rename --------------------------------------------------------------
  const renamed = await harness.service.updateDocument(doc.id, { title: '自定义标题' })
  assert.equal(renamed.document.title, '自定义标题')
  assert.equal((await harness.service.listDocuments()).documents[0].title, '自定义标题')

  // --- remove --------------------------------------------------------------
  assert.deepEqual(await harness.service.removeDocument(doc.id), { removed: true })
  assert.equal(harness.store.get(doc.id), undefined)
  assert.equal(existsSync(harness.docDir(doc.id)), false)
  assert.deepEqual((await harness.service.listDocuments()).documents, [])
})

test('service settings, status, preferences and token lifecycle', async (t) => {
  const harness = await createHarness(t)
  const doc = await importDocument(harness)

  const status = await harness.service.getStatus()
  assert.equal(status.version, 'test+host')
  assert.equal(status.tokenConfigured, true)
  assert.deepEqual(status.counts, { total: 1, parsed: 0, parsing: 0, failed: 0 })
  assert.equal(status.dataDirDisplay, harness.dataDir)
  assert.equal(status.configured.dataDir, harness.dataDir)

  const settings = await harness.service.getSettings()
  assert.equal(settings.tokenConfigured, true)
  assert.equal(settings.providers[0].id, 'auto')
  assert.ok(settings.providers.some((provider) => provider.id === 'google'))
  assert.equal(settings.preferences.targetLanguage, 'zh')
  assert.equal(settings.defaults.engine, 'auto')

  const updated = await harness.service.updatePreferences({ readingScale: 1.12, targetLanguage: 'en' })
  assert.equal(updated.preferences.readingScale, 1.12)
  assert.equal(updated.preferences.targetLanguage, 'en')
  // Preferences survive on disk in the data dir root.
  const prefsOnDisk = JSON.parse(await readFile(join(harness.dataDir, 'preferences.json'), 'utf8'))
  assert.equal(prefsOnDisk.readingScale, 1.12)

  const set = await harness.service.setToken('fresh-token-12345678')
  assert.equal(set.tokenConfigured, true)
  assert.equal((await harness.service.getStatus()).tokenConfigured, true)
  assert.deepEqual(await harness.service.clearToken(), { tokenConfigured: false, tokenPersistent: false })
  assert.equal((await harness.service.getStatus()).tokenConfigured, false)

  // --- diagnostics log -----------------------------------------------------
  const ping = await harness.service.healthPing({ clientVersion: 'e2e-client', event: 'active' })
  assert.equal(ping.ok, true)
  assert.equal(ping.hostVersion, 'test+host')
  assert.match(ping.receivedAt, /^\d{4}-\d{2}-\d{2}T/)
  const diagPath = join(harness.dataDir, 'diagnostics', 'client.log')
  assert.equal(existsSync(diagPath), true)
  assert.match(await readFile(diagPath, 'utf8'), /e2e-client/)
  void doc
})

test('translate uses the host translator and reports provider/target', async (t) => {
  const harness = await createHarness(t)
  const result = await harness.service.translate({ text: 'Attention is all you need.', targetLanguage: 'zh' })
  assert.equal(result.provider, 'google')
  assert.equal(result.targetLanguage, 'zh')
  assert.match(result.translation, /Attention is all you need/)
  assert.ok(harness.translator.requested.length >= 1)
  // The translator was resolved with the anonymous provider, per docs/ARCH.md §8.
  assert.equal(harness.translator.requested[0].provider, 'google')

  await assert.rejects(
    () => harness.service.translate({ text: '   ' }),
    (error) => error?.code === 'bad-request',
  )
})

test('translate-unavailable when neither translator nor LLM is usable', async (t) => {
  const harness = await createHarness(t, { translator: null })
  await assert.rejects(
    () => harness.service.translate({ text: 'Hello world', targetLanguage: 'zh' }),
    (error) => error?.code === 'translate-unavailable',
  )
})

test('reading markdown before parse fails with not-parsed', async (t) => {
  const harness = await createHarness(t)
  const doc = await importDocument(harness)
  await assert.rejects(
    () => harness.service.readMarkdown(doc.id),
    (error) => error?.code === 'not-parsed',
  )
})

test('tool helpers: list/read/annotate/unannotate operate on the same library', async (t) => {
  const harness = await createHarness(t)
  const doc = await importDocument(harness, { title: 'Tool Test Paper' })
  await harness.manager.start(doc.id, { engine: 'standard' })
  await waitForStatus(harness.store, doc.id, 'parsed', { timeout: 10_000 })

  const list = await harness.service.toolList()
  assert.equal(list.total, 1)
  assert.equal(list.documents[0].id, doc.id)
  assert.equal(list.documents[0].status, 'parsed')
  assert.equal(list.documents[0].pages, 3)
  assert.equal(list.documents[0].engine, 'standard')

  const slice = await harness.service.toolRead(doc.id, { offset: 0, maxChars: 120 })
  assert.equal(slice.offset, 0)
  assert.equal(slice.text, standardMarkdown().slice(0, 120))
  assert.equal(slice.totalChars, standardMarkdown().length)
  assert.equal(slice.truncated, true)
  const tail = await harness.service.toolRead(doc.id, { offset: slice.totalChars - 10, maxChars: 120 })
  assert.equal(tail.truncated, false)

  const annotate = await harness.service.toolAnnotate(doc.id, {
    quote: 'Dense retrieval models store one embedding per document',
    note: 'agent-authored note',
    color: 'sky',
  })
  assert.match(annotate.annotation.blockKey, /^b\d+:[0-9a-f]{8}$/)
  assert.equal(annotate.annotation.note, 'agent-authored note')
  assert.equal(annotate.count, 1)

  const annotations = await harness.service.toolAnnotations(doc.id)
  assert.equal(annotations.annotations.length, 1)
  assert.equal(annotations.annotations[0].blockKey, annotate.annotation.blockKey)

  const unannotate = await harness.service.toolUnannotate(doc.id, annotate.annotation.id)
  assert.equal(unannotate.removed, true)
  assert.equal(unannotate.count, 0)
  await assert.rejects(
    () => harness.service.toolUnannotate(doc.id, annotate.annotation.id),
    (error) => error?.code === 'not-found',
  )
})
