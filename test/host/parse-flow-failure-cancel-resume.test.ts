/**
 * Failure, cancellation and restart-recovery end-to-end flows.
 *
 * The mock MinerU server scripts its poll states, so a failure after one
 * running poll is deterministic; cancellation is asserted by watching the
 * mock's poll counter stop advancing; resume is asserted by pre-registering the
 * persisted batch id on a fresh mock and calling `manager.resume()`.
 *
 * Ported from the frozen `test/e2e/failure-cancel-resume.test.mjs`.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import { createHarness, importDocument, rejectsWithCode, requireParse, waitForStatus } from '../helpers/e2e-harness.ts'
import { waitFor } from '../helpers/parse-fixtures.ts'

test('standard parse failure persists status=failed + a user-facing message', async () => {
  const harness = await createHarness({
    mock: { standardStates: ['running', 'failed'], standardErrMsg: 'mock extract failed: simulated disk full' },
  })
  const doc = await importDocument(harness)

  await harness.service.startParse(doc.id, { engine: 'standard' })
  assert.equal(harness.store.get(doc.id)?.status, 'parsing')

  const failed = await waitForStatus(harness.store, doc.id, 'failed')
  assert.equal(failed.status, 'failed')
  assert.notEqual(failed.error, null)
  assert.match(String(failed.error), /mock extract failed/)
  assert.equal(requireParse(failed).phase, null)
  assert.equal(typeof requireParse(failed).finishedAt, 'string')
  assert.deepEqual(harness.store.stats(), { total: 1, parsed: 0, parsing: 0, failed: 1 })

  // A failed document keeps its source and never produces parsed output.
  assert.equal(existsSync(join(harness.docDir(doc.id), 'source.pdf')), true)
  assert.equal(existsSync(join(harness.docDir(doc.id), 'parsed', 'full.md')), false)
  assert.equal(harness.mock.state.uploads.size > 0, true, 'the source was uploaded before the failure')
})

test('parse timeout fails the task instead of polling forever', async () => {
  const harness = await createHarness({
    config: { parseTimeoutMs: 1000 },
    mock: { standardStates: ['running'] }, // repeats forever
  })
  const doc = await importDocument(harness)
  await harness.service.startParse(doc.id, { engine: 'standard' })
  const failed = await waitForStatus(harness.store, doc.id, 'failed', { timeout: 8000 })
  assert.match(String(failed.error), /超时|timed out/i)
})

test('cancel aborts polling and returns the document to uploaded', async () => {
  const harness = await createHarness({ mock: { standardStates: ['pending'] } }) // never finishes
  const doc = await importDocument(harness)
  await harness.service.startParse(doc.id, { engine: 'standard' })

  await waitFor(() => harness.mock.state.pollCounts.standard >= 1, { label: 'first mock poll' })
  assert.equal(harness.store.get(doc.id)?.status, 'parsing')

  const cancelled = await harness.service.cancelParse(doc.id)
  const cancelledParse = requireParse(cancelled.document)
  assert.equal(cancelled.document.status, 'uploaded')
  assert.equal(cancelled.document.error, null)
  assert.equal(cancelledParse.phase, null)
  assert.equal(cancelledParse.batchId, null)
  assert.equal(cancelledParse.progress, null)

  // Polling must stop: one in-flight request may land, but the count then freezes.
  const afterCancel = harness.mock.state.pollCounts.standard
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 250)
  })
  const settled = harness.mock.state.pollCounts.standard
  assert.ok(settled <= afterCancel + 1, `at most one in-flight poll may complete (${afterCancel} -> ${settled})`)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 250)
  })
  assert.equal(harness.mock.state.pollCounts.standard, settled, 'no polls after cancellation settled')
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
  assert.equal(existsSync(join(harness.docDir(doc.id), 'parsed', 'full.md')), false)
})

test('resume restarts a persisted polling task (standard engine) and parses it', async () => {
  const harness = await createHarness()
  const doc = await importDocument(harness, { name: 'resumed-paper.pdf' })

  // Simulate the persisted state a previous host process leaves behind.
  await harness.store.update(doc.id, {
    status: 'parsing',
    parse: {
      engine: 'standard',
      modelVersion: 'vlm',
      language: 'ch',
      options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
      phase: 'polling',
      taskId: null,
      batchId: 'resume-batch-1',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: null,
      progress: null,
      hasContentList: false,
    },
  })
  harness.mock.state.pretendBatch('resume-batch-1', {
    fileName: 'resumed-paper.pdf',
    dataId: doc.id,
    state: 'done',
  })

  await harness.manager.resume()
  const parsed = await waitForStatus(harness.store, doc.id, 'parsed')
  const parsedState = requireParse(parsed)
  assert.equal(parsedState.hasContentList, true)
  assert.equal(parsedState.pages, 3)
  const fullPath = join(harness.docDir(doc.id), 'parsed', 'full.md')
  assert.equal(existsSync(fullPath), true)
  assert.equal(parsed.title, 'Sparse Expert Routing for Efficient Document Retrieval')
  // Exactly one mock poll was needed; the source was downloaded from the persisted batch.
  assert.equal(harness.mock.state.pollCounts.standard, 1)
})

test('resume fails tasks interrupted before the polling phase', async () => {
  const harness = await createHarness()
  const doc = await importDocument(harness)
  await harness.store.update(doc.id, {
    status: 'parsing',
    parse: {
      engine: 'standard',
      modelVersion: 'vlm',
      language: 'ch',
      options: {},
      phase: 'uploading', // an in-flight upload cannot be resumed safely
      taskId: null,
      batchId: 'half-uploaded-batch',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: null,
      progress: null,
      hasContentList: false,
    },
  })

  await harness.manager.resume()
  const failed = await waitForStatus(harness.store, doc.id, 'failed')
  assert.match(String(failed.error), /解析被中断|interrupted/i)
  assert.equal(requireParse(failed).phase, null)
  assert.equal(harness.mock.state.pollCounts.standard, 0, 'no polling for an interrupted upload')
})

test('resume is a no-op for documents that are not parsing', async () => {
  const harness = await createHarness()
  const doc = await importDocument(harness)
  await harness.manager.resume()
  const meta = harness.store.get(doc.id)
  assert.ok(meta !== undefined)
  assert.equal(meta.status, 'uploaded')
  assert.equal(meta.error, null)
})

test('resume leaves already-parsed documents untouched', async () => {
  const harness = await createHarness()
  const doc = await importDocument(harness)
  await harness.store.update(doc.id, {
    status: 'parsed',
    parse: { engine: 'agent', phase: null, finishedAt: new Date().toISOString(), hasContentList: false },
  })
  await harness.store.update(doc.id, { title: 'Custom user title', error: null })
  await harness.manager.resume()
  assert.equal(harness.store.get(doc.id)?.status, 'parsed')
  assert.equal(harness.store.get(doc.id)?.title, 'Custom user title')
})

test('starting a parse for an unknown document is rejected', async () => {
  const harness = await createHarness()
  const { randomUUID } = await import('node:crypto')
  await rejectsWithCode(() => harness.service.startParse(randomUUID(), { engine: 'standard' }), 'not-found')
})
