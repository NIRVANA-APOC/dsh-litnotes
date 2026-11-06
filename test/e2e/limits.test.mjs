/**
 * Parse limit preconditions: too-large (both engines), unsupported types and the
 * "only the standard engine can parse this" token requirement.
 *
 * These are the failures parse.start must reject immediately with a branchable
 * WireError instead of starting a doomed background task.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeParseOptions } from '../../lib/mineru.js'
import { createHarness, importDocument } from './harness.mjs'
import { pdfBytes } from './helpers.mjs'

const MB = 1024 * 1024

/** Assert a rejected parse left the document untouched and started no task. */
function assertRejectedCleanly(harness, doc, error) {
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
  assert.equal(harness.store.get(doc.id)?.parse, null)
  assert.equal(harness.mock.state.batches.size, 0)
  assert.equal(harness.mock.state.tasks.size, 0)
  assert.equal(error.status >= 400, true)
}

test('standard engine rejects a file above the configured upload cap', async (t) => {
  const harness = await createHarness(t, { config: { maxUploadBytes: 64 * 1024 } })
  const doc = await importDocument(harness, { name: 'too-big.pdf', bytes: Buffer.alloc(70 * 1024, 0x41) })

  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'standard' }),
    (error) => {
      assert.equal(error.code, 'too-large')
      assert.equal(error.status, 413)
      assertRejectedCleanly(harness, doc, error)
      return true
    },
  )
})

test('agent engine rejects a file above its 10 MB limit', async (t) => {
  const harness = await createHarness(t) // a token is configured, but engine is explicit
  const doc = await importDocument(harness, { name: 'too-big-agent.pdf', bytes: Buffer.alloc(10 * MB + 1, 0x41) })

  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'agent' }),
    (error) => {
      assert.equal(error.code, 'too-large')
      assert.equal(error.status, 413)
      assertRejectedCleanly(harness, doc, error)
      return true
    },
  )
})

test('a file only the standard API can take asks for a token when unconfigured', async (t) => {
  // 11 MB: above the token-free agent limit, below the standard cap.
  const harness = await createHarness(t, { token: null, config: { maxUploadBytes: 200 * MB } })
  const doc = await importDocument(harness, { name: 'large-no-token.pdf', bytes: Buffer.alloc(11 * MB, 0x41) })

  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'auto' }),
    (error) => {
      assert.equal(error.code, 'token-missing')
      assert.equal(error.status, 401)
      assertRejectedCleanly(harness, doc, error)
      return true
    },
  )
})

test('a file type the agent API cannot take asks for a token when unconfigured', async (t) => {
  const harness = await createHarness(t, { token: null })
  // .doc is accepted by the standard API but not by the lightweight agent API.
  const doc = await importDocument(harness, { name: 'legacy-paper.doc', bytes: pdfBytes() })

  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'auto' }),
    (error) => error.code === 'token-missing',
  )
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
})

test('unsupported file types are rejected at upload time', async (t) => {
  const harness = await createHarness(t)
  await assert.rejects(
    () => importDocument(harness, { name: 'notes.xyz' }),
    (error) => error?.code === 'unsupported-type' && error?.status === 415,
  )
  assert.deepEqual(harness.store.list(), [])
})

test('normalizeParseOptions rejects unsupported types per engine', () => {
  // Unknown extension: neither engine accepts it.
  assert.throws(
    () => normalizeParseOptions({ engine: 'standard' }, { ext: '.xyz', size: 10, originalName: 'notes.xyz' }, { hasToken: true }),
    (error) => error?.code === 'unsupported-type',
  )
  // Known to the standard API, but the agent API only takes a subset.
  assert.throws(
    () => normalizeParseOptions({ engine: 'agent' }, { ext: '.doc', size: 10, originalName: 'paper.doc' }, { hasToken: true }),
    (error) => error?.code === 'unsupported-type',
  )
  // Standard-only type without a token must point at token setup, not fail generically.
  assert.throws(
    () => normalizeParseOptions({ engine: 'auto' }, { ext: '.doc', size: 10, originalName: 'paper.doc' }, { hasToken: false }),
    (error) => error?.code === 'token-missing',
  )
})

test('invalid engine / page-range options are rejected as bad-request', async (t) => {
  const harness = await createHarness(t)
  const doc = await importDocument(harness)
  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'magic' }),
    (error) => error?.code === 'bad-request',
  )
  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'standard', pageRanges: '0-3' }),
    (error) => error?.code === 'bad-request',
  )
  await assert.rejects(
    () => harness.service.startParse(doc.id, { engine: 'standard', pageRanges: '999' }),
    (error) => error?.code === 'bad-request',
  )
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
  assert.equal(harness.mock.state.batches.size, 0)
})
