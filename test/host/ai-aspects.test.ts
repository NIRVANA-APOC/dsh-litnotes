/**
 * Unit tests for citation aspects (`src/host/ai/aspects.ts`): vocabulary,
 * aspect → annotation ink mapping and defensive normalization of model output.
 */

import { describe, expect, test } from 'vitest'
import {
  ASPECTS,
  ASPECT_COLORS,
  DEFAULT_ASPECT,
  aspectColor,
  isAspect,
  normalizeAspect,
} from '../../src/host/ai/aspects.ts'

test('aspect vocabulary and colors match docs/AI-SPEC.md §2', () => {
  expect([...ASPECTS]).toEqual(['definition', 'method', 'result', 'limitation', 'context'])
  expect({ ...ASPECT_COLORS }).toEqual({
    definition: 'yellow',
    method: 'sage',
    result: 'sky',
    limitation: 'rose',
    context: 'yellow',
  })
  for (const aspect of ASPECTS) expect(ASPECT_COLORS[aspect]).toMatch(/^(yellow|sage|sky|rose)$/)
})

describe('normalizeAspect', () => {
  test('folds case/whitespace and falls back to context', () => {
    expect(normalizeAspect('method')).toBe('method')
    expect(normalizeAspect('  Method ')).toBe('method')
    expect(normalizeAspect('LIMITATION')).toBe('limitation')
    expect(normalizeAspect('unknown-aspect')).toBe(DEFAULT_ASPECT)
    expect(normalizeAspect('')).toBe(DEFAULT_ASPECT)
    expect(normalizeAspect(undefined)).toBe('context')
    expect(normalizeAspect(null)).toBe('context')
    expect(normalizeAspect(42)).toBe('context')
    expect(normalizeAspect({ aspect: 'method' })).toBe('context')
  })
})

describe('aspectColor and isAspect', () => {
  test('maps through normalization and checks exactness', () => {
    expect(aspectColor('definition')).toBe('yellow')
    expect(aspectColor('context')).toBe('yellow')
    expect(aspectColor('method')).toBe('sage')
    expect(aspectColor('result')).toBe('sky')
    expect(aspectColor('limitation')).toBe('rose')
    expect(aspectColor('Method')).toBe('sage')
    expect(aspectColor('nonsense')).toBe('yellow')
    expect(isAspect('method')).toBe(true)
    expect(isAspect('Method')).toBe(false)
    expect(isAspect(undefined)).toBe(false)
  })
})
