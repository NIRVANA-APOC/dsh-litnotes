/**
 * Pure-helper tests for stale/orphan annotation handling after a reparse
 * (user-reported bug: annotations lost their anchors). The helpers live in
 * ui/app.js, so they are extracted and evaluated in isolation here; the render
 * harness covers the UI + save wiring.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8')

function loadHelpers() {
  const start = app.indexOf('/**\n * Build the whole-list `annotations.save` payload')
  assert.ok(start >= 0, 'merge helper block must exist in ui/app.js')
  const end = app.indexOf('/** Whether the model contains any formula', start)
  assert.ok(end > start, 'merge helper block terminator must exist')
  const source = `
    const MRU_MAX_QUOTE = 2000;
    const MRU_COLORS = ['yellow', 'sage', 'sky', 'rose'];
    const MRU_ASPECT_LEGEND = [
      { aspect: 'definition' }, { aspect: 'context' }, { aspect: 'method' },
      { aspect: 'result' }, { aspect: 'limitation' },
    ];
    ${app.slice(start, end)}
    ;({ mruMergeAnnotations, mruOrphanAnnotation })
  `
  return vm.runInNewContext(source, { Date, Number, Math, Array, Object, String })
}

test('merge: normalized edits win by id, orphans survive untouched', () => {
  const { mruMergeAnnotations } = loadHelpers()
  const normalized = [
    { id: 'a', color: 'sage', note: 'edited', blockKey: 'b1:aaa' },
    { id: 'b', color: 'sky', note: 'kept', blockKey: 'b2:bbb' },
  ]
  const orphans = [
    { id: 'a', color: 'rose', note: 'stale version', stale: true }, // replaced by normalized
    { id: 'c', quote: 'moved quote', stale: true, staleReason: 'quote-not-found' },
    { id: 'd', quote: 'no block', blockKey: 'b9:zzz' },
  ]
  const merged = mruMergeAnnotations(normalized, orphans)
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c', 'd'])
  assert.equal(merged[0].note, 'edited', 'normalized version must win')
  assert.equal(merged[0].stale, undefined)
  assert.equal(merged[2].stale, true)
  assert.equal(merged[2].staleReason, 'quote-not-found')
  assert.equal(merged[3].blockKey, 'b9:zzz')
})

test('merge: tolerates missing/invalid lists and skips entries without ids', () => {
  const { mruMergeAnnotations } = loadHelpers()
  assert.deepEqual(mruMergeAnnotations(null, undefined), [])
  assert.deepEqual(mruMergeAnnotations([], []), [])
  const merged = mruMergeAnnotations(
    [{ id: 'x', note: 'ok' }, null, { note: 'no id' }, { id: '' }],
    [null, { id: 'y', stale: true }, { stale: true }],
  )
  assert.deepEqual(merged.map((item) => item.id), ['x', 'y'])
})

test('orphan normalization: clamps offsets, caps quote, keeps provenance', () => {
  const { mruOrphanAnnotation } = loadHelpers()
  const out = mruOrphanAnnotation({
    id: 'ann-1',
    blockKey: 'b99:dead',
    start: -5,
    end: 9999,
    quote: 'x'.repeat(4000),
    color: 'not-a-color',
    note: 42,
    stale: true,
    staleReason: 'quote-not-found',
    reanchored: true,
    origin: 'ai',
    aspect: 'method',
    chatId: 'chat-1',
    messageId: 'msg-1',
    model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T01:00:00.000Z',
  })
  assert.ok(out)
  assert.equal(out.id, 'ann-1')
  assert.equal(out.blockKey, 'b99:dead')
  assert.equal(out.start, 0)
  assert.equal(out.end, 9999)
  assert.equal(out.quote.length, 2000)
  assert.equal(out.color, 'yellow')
  assert.equal(out.note, '')
  assert.equal(out.stale, true)
  assert.equal(out.staleReason, 'quote-not-found')
  assert.equal(out.reanchored, true)
  assert.equal(out.origin, 'ai')
  assert.equal(out.aspect, 'method')
  assert.equal(out.chatId, 'chat-1')
  assert.equal(out.messageId, 'msg-1')
  assert.deepEqual({ ...out.model }, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(out.createdAt, '2026-11-06T00:00:00.000Z')
  assert.equal(out.updatedAt, '2026-11-06T01:00:00.000Z')
})

test('orphan normalization: rejects invalid entries and defaults timestamps', () => {
  const { mruOrphanAnnotation } = loadHelpers()
  assert.equal(mruOrphanAnnotation(null), null)
  assert.equal(mruOrphanAnnotation([]), null)
  assert.equal(mruOrphanAnnotation({ quote: 'no id' }), null)
  const out = mruOrphanAnnotation({ id: 'a2', quote: 'q', color: 'sage' })
  assert.equal(out.stale, true, 'orphans are always stale for the UI')
  assert.equal(out.color, 'sage')
  assert.equal(out.createdAt, '1970-01-01T00:00:00.000Z')
  assert.equal(out.updatedAt, out.createdAt)
  assert.equal(out.aspect, undefined)
})
