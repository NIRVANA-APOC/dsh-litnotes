/**
 * Failure, cancellation and restart-recovery end-to-end flows.
 *
 * The mock MinerU server scripts its poll states, so a failure after one running
 * poll is deterministic; cancellation is asserted by watching the mock's poll
 * counter stop advancing; resume is asserted by pre-registering the persisted
 * batch id on a fresh mock and calling `manager.resume()`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, importDocument } from './harness.mjs'
import { waitFor, waitForStatus } from './helpers.mjs'

test('standard parse failure persists status=failed + a user-facing message', async (t) => {
  const harness = await createHarness(t, {
    mock: { standardStates: ['running', 'failed'], standardErrMsg: 'mock extract failed: simulated disk full' },
  })
  const doc = await importDocument(harness)

  await harness.manager.start(doc.id, { engine: 'standard' })
  assert.equal(harness.store.get(doc.id)?.status, 'parsing')

  const failed = await waitForStatus(harness.store, doc.id, 'failed')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error === null || failed.error === undefined, false)
  assert.match(String(failed.error), /mock extract failed/)
  assert.equal(failed.parse.phase, null)
  assert.equal(typeof failed.parse.finishedAt, 'string')
  assert.deepEqual(harness.store.stats(), { total: 1, parsed: 0, parsing: 0, failed: 1 })

  // A failed document keeps its source and never produces parsed output.
  assert.equal(existsSync(join(harness.docDir(doc.id), 'source.pdf')), true)
  assert.equal(existsSync(join(harness.docDir(doc.id), 'parsed', 'full.md')), false)
  assert.equal(harness.mock.state.uploads.size > 0, true, 'the source was uploaded before the failure')
})

test('parse timeout fails the task instead of polling forever', async (t) => {
  const harness = await createHarness(t, {
    config: { parseTimeoutMs: 1000 },
    mock: { standardStates: ['running'] }, // repeats forever
  })
  const doc = await importDocument(harness)
  await harness.manager.start(doc.id, { engine: 'standard' })
  const failed = await waitForStatus(harness.store, doc.id, 'failed', { timeout: 8000 })
  assert.match(String(failed.error), /超时|timed out/i)
})

test('cancel aborts polling and returns the document to uploaded', async (t) => {
  const harness = await createHarness(t, { mock: { standardStates: ['pending'] } }) // never finishes
  const doc = await importDocument(harness)
  await harness.manager.start(doc.id, { engine: 'standard' })

  await waitFor(() => harness.mock.state.pollCounts.standard >= 1, { label: 'first mock poll' })
  assert.equal(harness.store.get(doc.id)?.status, 'parsing')

  const cancelled = await harness.manager.cancel(doc.id)
  assert.equal(cancelled.status, 'uploaded')
  assert.equal(cancelled.error, null)
  assert.equal(cancelled.parse.phase, null)
  assert.equal(cancelled.parse.batchId, null)
  assert.equal(cancelled.parse.progress, null)

  // Polling must stop: one in-flight request may land, but the count then freezes.
  const afterCancel = harness.mock.state.pollCounts.standard
  await new Promise((resolve) => setTimeout(resolve, 250))
  const settled = harness.mock.state.pollCounts.standard
  assert.ok(settled <= afterCancel + 1, `at most one in-flight poll may complete (${afterCancel} -> ${settled})`)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(harness.mock.state.pollCounts.standard, settled, 'no polls after cancellation settled')
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
  assert.equal(existsSync(join(harness.docDir(doc.id), 'parsed', 'full.md')), false)
})

test('resume restarts a persisted polling task (standard engine) and parses it', async (t) => {
  const harness = await createHarness(t)
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
  assert.equal(parsed.parse.hasContentList, true)
  assert.equal(parsed.parse.pages, 3)
  const fullPath = join(harness.docDir(doc.id), 'parsed', 'full.md')
  assert.equal(existsSync(fullPath), true)
  assert.equal(parsed.title, 'Sparse Expert Routing for Efficient Document Retrieval')
  // Exactly one mock poll was needed; the source was downloaded from the persisted batch.
  assert.equal(harness.mock.state.pollCounts.standard, 1)
})

test('resume fails tasks interrupted before the polling phase', async (t) => {
  const harness = await createHarness(t)
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
  assert.equal(failed.parse.phase, null)
  assert.equal(harness.mock.state.pollCounts.standard, 0, 'no polling for an interrupted upload')
})

test('resume is a no-op for documents that are not parsing', async (t) => {
  const harness = await createHarness(t)
  const doc = await importDocument(harness)
  await harness.manager.resume()
  const meta = harness.store.get(doc.id)
  assert.equal(meta.status, 'uploaded')
  assert.equal(meta.error, null)
})

test('resume leaves already-parsed documents untouched', async (t) => {
  const harness = await createHarness(t)
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
