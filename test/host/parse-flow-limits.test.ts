/**
 * Parse limit preconditions: too-large (both engines), unsupported types and
 * the "only the standard engine can parse this" token requirement.
 *
 * These are the failures parse.start must reject immediately with a branchable
 * WireError instead of starting a doomed background task.
 *
 * Ported from the frozen `test/e2e/limits.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { DocumentMeta } from '../../src/shared/model.ts'
import type { ParseOptionContext } from '../../src/host/contracts.ts'
import { normalizeParseOptions } from '../../src/host/parse/mineru.ts'
import { WireError } from '../../src/host/wire.ts'
import { createHarness, importDocument, rejectsWithCode } from '../helpers/e2e-harness.ts'
import type { Harness } from '../helpers/e2e-harness.ts'
import { pdfBytes } from '../helpers/parse-fixtures.ts'

const MB = 1024 * 1024

/** Standard context info for `normalizeParseOptions`. */
function ctxInfo(hasToken: boolean): ParseOptionContext {
  return {
    hasToken,
    maxUploadBytes: 200 * MB,
    localSupported: false,
    localMaxBytes: 0,
    autoAllowAgentFallback: true,
  }
}

/** Assert a rejected parse left the document untouched and started no task. */
function assertRejectedCleanly(harness: Harness, doc: DocumentMeta, error: WireError): void {
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
  assert.equal(harness.store.get(doc.id)?.parse, null)
  assert.equal(harness.mock.state.batches.size, 0)
  assert.equal(harness.mock.state.tasks.size, 0)
  assert.equal(error.status >= 400, true)
}

test('standard engine rejects a file above the configured upload cap', async () => {
  const harness = await createHarness({ config: { maxUploadBytes: 64 * 1024 } })
  const doc = await importDocument(harness, { name: 'too-big.pdf', bytes: Buffer.alloc(70 * 1024, 0x41) })

  const error = await rejectsWithCode(() => harness.service.startParse(doc.id, { engine: 'standard' }), 'too-large', 413)
  assertRejectedCleanly(harness, doc, error)
})

test('agent engine rejects a file above its 10 MB limit', async () => {
  const harness = await createHarness() // a token is configured, but engine is explicit
  const doc = await importDocument(harness, { name: 'too-big-agent.pdf', bytes: Buffer.alloc(10 * MB + 1, 0x41) })

  const error = await rejectsWithCode(() => harness.service.startParse(doc.id, { engine: 'agent' }), 'too-large', 413)
  assertRejectedCleanly(harness, doc, error)
})

test('a file only the standard API can take asks for a token when unconfigured', async () => {
  // 11 MB: above the token-free agent limit, below the standard cap.
  const harness = await createHarness({ token: null, config: { maxUploadBytes: 200 * MB } })
  const doc = await importDocument(harness, { name: 'large-no-token.pdf', bytes: Buffer.alloc(11 * MB, 0x41) })

  const error = await rejectsWithCode(() => harness.service.startParse(doc.id, { engine: 'auto' }), 'token-missing', 401)
  assertRejectedCleanly(harness, doc, error)
})

test('a file type the agent API cannot take asks for a token when unconfigured', async () => {
  const harness = await createHarness({ token: null })
  // .doc is accepted by the standard API but not by the lightweight agent API.
  const doc = await importDocument(harness, { name: 'legacy-paper.doc', bytes: pdfBytes() })

  await rejectsWithCode(() => harness.service.startParse(doc.id, { engine: 'auto' }), 'token-missing')
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
})

test('unsupported file types are rejected at upload time', async () => {
  const harness = await createHarness()
  await rejectsWithCode(() => importDocument(harness, { name: 'notes.xyz' }), 'unsupported-type', 415)
  assert.deepEqual(harness.store.list(), [])
})

test('normalizeParseOptions rejects unsupported types per engine', () => {
  // Unknown extension: neither engine accepts it.
  assert.throws(
    () =>
      normalizeParseOptions(
        { engine: 'standard' },
        { ext: '.xyz', size: 10, originalName: 'notes.xyz' },
        ctxInfo(true),
      ),
    (error: unknown) => error instanceof WireError && error.code === 'unsupported-type',
  )
  // Known to the standard API, but the agent API only takes a subset.
  assert.throws(
    () =>
      normalizeParseOptions(
        { engine: 'agent' },
        { ext: '.doc', size: 10, originalName: 'paper.doc' },
        ctxInfo(true),
      ),
    (error: unknown) => error instanceof WireError && error.code === 'unsupported-type',
  )
  // Standard-only type without a token must point at token setup, not fail generically.
  assert.throws(
    () =>
      normalizeParseOptions(
        { engine: 'auto' },
        { ext: '.doc', size: 10, originalName: 'paper.doc' },
        ctxInfo(false),
      ),
    (error: unknown) => error instanceof WireError && error.code === 'token-missing',
  )
})

test('invalid engine / page-range options are rejected as bad-request', async () => {
  const harness = await createHarness()
  const doc = await importDocument(harness)
  await rejectsWithCode(() => harness.service.startParse(doc.id, { engine: 'magic' as never }), 'bad-request')
  await rejectsWithCode(
    () => harness.service.startParse(doc.id, { engine: 'standard', pageRanges: '0-3' }),
    'bad-request',
  )
  await rejectsWithCode(
    () => harness.service.startParse(doc.id, { engine: 'standard', pageRanges: '999' }),
    'bad-request',
  )
  assert.equal(harness.store.get(doc.id)?.status, 'uploaded')
  assert.equal(harness.mock.state.batches.size, 0)
})
