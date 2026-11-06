/**
 * Agent (lightweight, token-free) MinerU flow end-to-end.
 *
 * Covers: engine auto picking the agent API when no token is stored, the signed
 * upload + poll + markdown download path, the absence of a content list, the
 * standard-engine token requirement, and resuming a persisted agent task.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, importDocument } from './harness.mjs'
import { agentMarkdown, pdfBytes, waitForStatus } from './helpers.mjs'

test('agent parse end-to-end without a token stores the markdown result', async (t) => {
  const markdown = agentMarkdown()
  const harness = await createHarness(t, { token: null, mock: { markdown } })
  const doc = await importDocument(harness, { name: 'lightweight.pdf' })

  // engine 'auto' must fall back to the agent API when no token is configured.
  const started = await harness.manager.start(doc.id, { engine: 'auto' })
  assert.equal(started.status, 'parsing')
  assert.equal(started.parse.engine, 'agent')
  assert.equal(started.parse.taskId, null) // assigned asynchronously

  const parsed = await waitForStatus(harness.store, doc.id, 'parsed', { timeout: 8000 })
  assert.equal(parsed.status, 'parsed')
  assert.equal(parsed.error, null)
  assert.equal(parsed.parse.engine, 'agent')
  assert.equal(parsed.parse.hasContentList, false)
  assert.equal(parsed.title, 'Lightweight Parsing Result')

  // The mock saw the agent create request + upload, never a standard batch.
  assert.equal(harness.mock.state.batches.size, 0, 'no standard batch for the agent engine')
  assert.equal(harness.mock.state.tasks.size, 1)
  const task = [...harness.mock.state.tasks.values()][0]
  assert.equal(task.request.file_name, 'lightweight.pdf')
  assert.equal(task.request.language, 'ch')
  assert.equal(task.request.enable_table, true)
  assert.equal(task.request.enable_formula, true)
  assert.equal(task.request.is_ocr, false)
  assert.ok(task.uploadedBytes !== null, 'upload bytes captured')
  assert.deepEqual(task.uploadedBytes, pdfBytes())

  // Only full.md is written; no content list and no image directory.
  const parsedDir = join(harness.docDir(doc.id), 'parsed')
  assert.equal(existsSync(join(parsedDir, 'full.md')), true)
  assert.equal(existsSync(join(parsedDir, 'content_list.json')), false)
  assert.equal(existsSync(join(parsedDir, 'images')), false)

  const read = await harness.store.readMarkdown(doc.id)
  assert.equal(read.markdown, markdown)
  assert.equal(read.contentList, null)
  assert.equal(read.pages, null)
})

test('agent engine still works when a token is configured', async (t) => {
  const harness = await createHarness(t, { mock: { markdown: agentMarkdown() } })
  const doc = await importDocument(harness)
  await harness.manager.start(doc.id, { engine: 'agent' })
  const parsed = await waitForStatus(harness.store, doc.id, 'parsed')
  assert.equal(parsed.parse.engine, 'agent')
  assert.equal((await harness.store.readMarkdown(doc.id)).markdown, agentMarkdown())
})

test('agent parse failure reports the upstream error code + message', async (t) => {
  const harness = await createHarness(t, {
    token: null,
    mock: { agentStates: ['running', 'failed'], agentErrMsg: 'mock agent failure: simulated page limit' },
  })
  const doc = await importDocument(harness)
  await harness.manager.start(doc.id, { engine: 'auto' })
  const failed = await waitForStatus(harness.store, doc.id, 'failed')
  assert.match(String(failed.error), /mock agent failure/)
  assert.match(String(failed.error), /30003|页数|page/i)
  assert.equal(failed.parse.phase, null)
})

test('standard engine without a token is rejected up front with token-missing', async (t) => {
  const harness = await createHarness(t, { token: null })
  const doc = await importDocument(harness)
  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'standard' }),
    (error) => error?.code === 'token-missing',
  )
  const meta = harness.store.get(doc.id)
  assert.equal(meta.status, 'uploaded', 'a rejected parse leaves the document untouched')
  assert.equal(meta.parse, null)
})

test('resume restarts a persisted polling task (agent engine)', async (t) => {
  const markdown = '# Resumed Agent Document\n\nThis content came from the persisted agent task.\n'
  const harness = await createHarness(t, { token: null, mock: { markdown } })
  const doc = await importDocument(harness, { name: 'resume-agent.pdf' })

  await harness.store.update(doc.id, {
    status: 'parsing',
    parse: {
      engine: 'agent',
      modelVersion: null,
      language: 'ch',
      options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
      phase: 'polling',
      taskId: 'resume-agent-task-1',
      batchId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pages: null,
      progress: null,
      hasContentList: false,
    },
  })
  harness.mock.state.pretendTask('resume-agent-task-1', { fileName: 'resume-agent.pdf', state: 'done' })

  await harness.manager.resume()
  const parsed = await waitForStatus(harness.store, doc.id, 'parsed')
  assert.equal(parsed.parse.engine, 'agent')
  assert.equal(parsed.parse.hasContentList, false)
  assert.equal(parsed.title, 'Resumed Agent Document')
  assert.equal((await harness.store.readMarkdown(doc.id)).markdown, markdown)
  assert.equal(harness.mock.state.pollCounts.agent, 1)
})
