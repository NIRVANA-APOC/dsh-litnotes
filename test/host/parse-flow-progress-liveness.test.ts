/**
 * Regression tests for the reported "parsing progress freezes when pipeline or
 * OCR is enabled" bug (ported from `test/e2e/progress-liveness.test.mjs`).
 *
 * The real MinerU standard API only fills `extract_progress` while a task is
 * `running`, and the pipeline model / OCR keep reporting `extracted_pages: 0`
 * for a long time (queue + model warm-up). Persisting "0 / N" made the client
 * paint a frozen 0 % bar, so the Host now:
 *
 *  - persists the upstream MinerU task state (`parse.remoteState`) so the
 *    client can say "queued" / "parsing" / "converting" instead of nothing;
 *  - never persists a page progress record until at least one page was really
 *    extracted, and never lets the counter regress.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ParseProgress, ParseState } from '../../src/shared/model.ts'
import { createHarness, importDocument, requireParse, waitForStatus } from '../helpers/e2e-harness.ts'
import { waitFor } from '../helpers/parse-fixtures.ts'

/** Structural shape of one captured `parse` update patch. */
type ParsePatch = Partial<ParseState>

test('pipeline/OCR parse exposes the upstream phase and never persists a fake 0 % progress', async () => {
  const harness = await createHarness({
    mock: {
      // MinerU sits in the queue for a while, then reports two running polls
      // (the first one with extracted_pages: 0, like pipeline/OCR warm-up).
      standardStates: ['pending', 'pending', 'running', 'running', 'converting', 'done'],
      progressStates: ['running'],
      extractedScript: [0, 2],
      totalPages: 6,
    },
    config: { pollIntervalMs: 40 },
  })
  const doc = await importDocument(harness)

  /** Record every parse patch so writes and regressions are visible. */
  const parsePatches: ParsePatch[] = []
  const originalUpdate = harness.store.update.bind(harness.store)
  harness.store.update = async (id, patch) => {
    const parsePatch: unknown = patch.parse
    if (parsePatch !== null && typeof parsePatch === 'object' && !Array.isArray(parsePatch)) {
      parsePatches.push(structuredClone(parsePatch) as ParsePatch)
    }
    return originalUpdate(id, patch)
  }

  const started = await harness.service.startParse(doc.id, {
    engine: 'standard',
    modelVersion: 'pipeline',
    isOcr: true,
  })
  assert.equal(started.document.status, 'parsing')
  assert.equal(requireParse(started.document).modelVersion, 'pipeline')
  assert.equal(requireParse(started.document).options?.isOcr, true)

  // While MinerU is queued the client must be able to name the phase and must
  // not receive a "0 / 6" progress record (which would paint a frozen 0 % bar).
  const queued = await waitFor(
    () => {
      const meta = harness.store.get(doc.id)
      return meta !== undefined && meta.parse?.remoteState === 'pending' ? meta : undefined
    },
    { label: 'upstream pending state', timeout: 5000 },
  )
  assert.equal(requireParse(queued).progress, null)
  const queuedRow = (await harness.service.listDocuments()).documents.find((row) => row.id === doc.id)
  assert.ok(queuedRow !== undefined)
  assert.equal(queuedRow.parse?.remoteState, 'pending')
  assert.equal(queuedRow.parse?.options?.isOcr, true)
  assert.equal(queuedRow.parse?.modelVersion, 'pipeline')
  assert.equal(queuedRow.parse?.progress, null)
  assert.equal(queuedRow.parse?.startedAt, requireParse(queued).startedAt, 'startedAt lets the client tick an elapsed timer')

  const parsed = await waitForStatus(harness.store, doc.id, 'parsed', { timeout: 10_000 })
  assert.equal(requireParse(parsed).remoteState, null, 'the upstream phase is cleared on completion')

  // No "0 / N" progress was ever persisted, and the counter never regressed.
  const progressWrites: ParseProgress[] = parsePatches
    .filter((patch): patch is ParsePatch & { progress: ParseProgress } => patch.progress !== undefined && patch.progress !== null)
    .map((patch) => patch.progress)
  assert.ok(progressWrites.length >= 1, 'real page progress is still persisted')
  for (const write of progressWrites) {
    assert.ok(write.extracted > 0, `unexpected 0-page progress write: ${JSON.stringify(write)}`)
  }
  const extractedHistory = progressWrites.map((write) => write.extracted)
  for (let index = 1; index < extractedHistory.length; index += 1) {
    const current = extractedHistory[index] ?? 0
    const previous = extractedHistory[index - 1] ?? 0
    assert.ok(current >= previous, `progress regressed: ${extractedHistory.join(' -> ')}`)
  }
  assert.deepEqual(requireParse(parsed).progress, { extracted: 2, total: 6 })

  // The upstream phases were recorded in order, and cleared at the end.
  const states = parsePatches
    .filter((patch): patch is ParsePatch & { remoteState: string } => typeof patch.remoteState === 'string')
    .map((patch) => patch.remoteState)
  assert.ok(states.includes('pending'), `expected the queued phase, got ${states.join(',')}`)
  assert.ok(states.includes('running'), `expected the running phase, got ${states.join(',')}`)
  assert.ok(states.indexOf('pending') < states.indexOf('running'))
  assert.ok(states.includes('converting'), `expected the converting phase, got ${states.join(',')}`)
})

test('cancel clears the upstream phase and progress of a queued pipeline parse', async () => {
  const harness = await createHarness({
    mock: { standardStates: ['pending'] }, // never finishes
    config: { pollIntervalMs: 20 },
  })
  const doc = await importDocument(harness)
  await harness.service.startParse(doc.id, { engine: 'standard', modelVersion: 'pipeline', isOcr: true })
  await waitFor(
    () => {
      const meta = harness.store.get(doc.id)
      return meta !== undefined && meta.parse?.remoteState === 'pending' ? meta : undefined
    },
    { label: 'upstream pending state', timeout: 5000 },
  )

  const cancelled = await harness.service.cancelParse(doc.id)
  const cancelledParse = requireParse(cancelled.document)
  assert.equal(cancelled.document.status, 'uploaded')
  assert.equal(cancelledParse.remoteState, null)
  assert.equal(cancelledParse.progress, null)
  assert.equal(cancelledParse.phase, null)
})
