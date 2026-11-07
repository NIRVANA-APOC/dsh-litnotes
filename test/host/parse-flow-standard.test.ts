/**
 * Standard (precise) MinerU API end-to-end flow:
 * upload → parse → ZIP download → extraction on disk → markdown/content list →
 * library reads.
 *
 * Ported from the parse-pipeline portion of the frozen
 * `test/e2e/standard-flow.test.mjs`; the service-surface cases of that file
 * (annotations/settings/tools/token lifecycle) belong to host-core's service
 * test port and are not duplicated here.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'
import type { DocumentMeta } from '../../src/shared/model.ts'
import { createHarness, importDocument, rejectsWithCode, requireParse, waitForStatus } from '../helpers/e2e-harness.ts'
import type { Harness } from '../helpers/e2e-harness.ts'
import {
  figureBytes,
  pdfBytes,
  standardContentList,
  standardMarkdown,
} from '../helpers/parse-fixtures.ts'

/** The captured request body of one standard batch (with mock bookkeeping fields). */
function batchRequestOf(harness: Harness): Record<string, unknown> {
  const batch = [...harness.mock.state.batches.values()][0]
  if (batch?.request === null || batch?.request === undefined) throw new Error('no captured standard batch request')
  return batch.request
}

/** Files array of a standard submit body. */
function filesOf(request: Record<string, unknown>): Array<Record<string, unknown>> {
  const files = request.files
  assert.ok(Array.isArray(files))
  return files.map((file) => {
    assert.ok(file !== null && typeof file === 'object')
    return file as Record<string, unknown>
  })
}

test('standard parse end-to-end: upload, poll, extract markdown/content-list/images', async () => {
  const harness = await createHarness()
  const doc: DocumentMeta = await importDocument(harness, { name: 'sparse-route.pdf' })

  // --- start ---------------------------------------------------------------
  const started = await harness.service.startParse(doc.id, { engine: 'standard' })
  assert.equal(started.document.status, 'parsing')
  const startedParse = requireParse(started.document)
  assert.equal(startedParse.engine, 'standard')
  assert.equal(startedParse.modelVersion, 'vlm')
  assert.equal(startedParse.language, 'ch')

  const parsed = await waitForStatus(harness.store, doc.id, 'parsed', { timeout: 10_000 })
  const parsedState = requireParse(parsed)
  assert.equal(parsed.status, 'parsed')
  assert.equal(parsed.error, null)
  assert.equal(parsedState.engine, 'standard')
  assert.equal(parsedState.phase, null)
  assert.equal(parsedState.pages, 3)
  assert.equal(parsedState.hasContentList, true)
  assert.equal(parsed.title, 'Sparse Expert Routing for Efficient Document Retrieval')

  // --- what the mock received ---------------------------------------------
  assert.equal(harness.mock.state.batches.size, 1)
  const request = batchRequestOf(harness)
  const file = filesOf(request)[0]
  assert.ok(file !== undefined)
  assert.equal(file.name, 'sparse-route.pdf')
  assert.equal(file.data_id, doc.id)
  assert.equal(request.model_version, 'vlm')
  assert.equal(request.language, 'ch')
  assert.equal(request.enable_formula, true)
  assert.equal(request.enable_table, true)
  const authHeaders = harness.mock.state.requests
    .filter((entry) => entry.path.startsWith('/api/v4/') && !entry.path.startsWith('/api/v4/upload/'))
    .map((entry) => entry.auth)
  assert.ok(authHeaders.length >= 2, 'batch create + polls were authenticated')
  for (const header of authHeaders) assert.equal(header, `Bearer ${harness.mock.token}`)
  const uploaded = harness.mock.state.lastStandardUpload()
  assert.deepEqual(uploaded, pdfBytes(), 'exactly the source bytes were uploaded')
  // The signed upload URL is used, not a relative path.
  assert.match(String(request.uploadId ?? ''), /^mock-batch-/)
  const batch = [...harness.mock.state.batches.keys()][0]
  assert.ok(batch !== undefined)
  assert.ok(harness.mock.state.requests.some((entry) => entry.path === `/api/v4/upload/${batch}`))

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
  assert.equal(listed.documents[0]?.id, doc.id)
  assert.equal(listed.documents[0]?.status, 'parsed')
  assert.equal(Object.hasOwn(listed.documents[0] ?? {}, 'sha256'), false, 'DocumentSummary omits the heavy hash')

  const full = await harness.service.getDocument(doc.id)
  assert.equal(full.document.id, doc.id)
  assert.deepEqual(full.annotations, [])
  assert.equal(full.translations.version, 1)
  assert.equal(full.translations.targetLanguage, 'zh')
  assert.deepEqual(full.translations.entries, {})
})

test('reading markdown before parse fails with not-parsed', async () => {
  const harness = await createHarness()
  const doc = await importDocument(harness)
  await rejectsWithCode(() => harness.service.readMarkdown(doc.id), 'not-parsed')
})
