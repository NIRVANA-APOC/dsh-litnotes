/**
 * Unit tests for citation aspects (`lib/ai/aspects.js`): vocabulary, aspect →
 * annotation ink mapping and defensive normalization of model output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASPECTS,
  ASPECT_COLORS,
  DEFAULT_ASPECT,
  aspectColor,
  isAspect,
  normalizeAspect,
} from '../../lib/ai/aspects.js'

test('aspect vocabulary and colors match docs/AI-SPEC.md §2', () => {
  assert.deepEqual([...ASPECTS], ['definition', 'method', 'result', 'limitation', 'context'])
  assert.deepEqual({ ...ASPECT_COLORS }, {
    definition: 'yellow',
    method: 'sage',
    result: 'sky',
    limitation: 'rose',
    context: 'yellow',
  })
  for (const aspect of ASPECTS) assert.ok(ASPECT_COLORS[aspect].match(/^(yellow|sage|sky|rose)$/))
})

test('normalizeAspect folds case/whitespace and falls back to context', () => {
  assert.equal(normalizeAspect('method'), 'method')
  assert.equal(normalizeAspect('  Method '), 'method')
  assert.equal(normalizeAspect('LIMITATION'), 'limitation')
  assert.equal(normalizeAspect('unknown-aspect'), DEFAULT_ASPECT)
  assert.equal(normalizeAspect(''), DEFAULT_ASPECT)
  assert.equal(normalizeAspect(undefined), 'context')
  assert.equal(normalizeAspect(null), 'context')
  assert.equal(normalizeAspect(42), 'context')
  assert.equal(normalizeAspect({ aspect: 'method' }), 'context')
})

test('aspectColor maps through normalization and isAspect is exact', () => {
  assert.equal(aspectColor('definition'), 'yellow')
  assert.equal(aspectColor('context'), 'yellow')
  assert.equal(aspectColor('method'), 'sage')
  assert.equal(aspectColor('result'), 'sky')
  assert.equal(aspectColor('limitation'), 'rose')
  assert.equal(aspectColor('Method'), 'sage')
  assert.equal(aspectColor('nonsense'), 'yellow')
  assert.equal(isAspect('method'), true)
  assert.equal(isAspect('Method'), false)
  assert.equal(isAspect(undefined), false)
})
