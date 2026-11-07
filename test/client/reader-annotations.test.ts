/**
 * Reader annotation helpers — port of the frozen 1.0.0 `app-stale` client rules
 * (`mruMergeAnnotations` / `mruOrphanAnnotation`) plus the origin counts the
 * margin filter chips display.
 */

import { describe, expect, it } from 'vitest'
import type { Annotation } from '../../src/shared/model.ts'
import {
  MAX_ANNOTATION_QUOTE,
  countAnnotationOrigins,
  mergeAnnotationsForSave,
  normalizeStaleAnnotation,
} from '../../src/client/reader/annotations.ts'

describe('mergeAnnotationsForSave', () => {
  it('lets the normalized edit win by id and keeps orphans untouched', () => {
    const normalized = [
      { id: 'a', blockKey: 'b1:aaa', start: 0, end: 3, quote: 'one', color: 'sage' as const, note: 'edited' },
      { id: 'b', blockKey: 'b2:bbb', start: 4, end: 8, quote: 'two', color: 'sky' as const, note: 'kept' },
    ]
    const stale = [
      { id: 'a', blockKey: '', start: 0, end: 0, quote: 'stale version', color: 'rose' as const, stale: true as const },
      { id: 'c', blockKey: '', start: 0, end: 0, quote: 'moved quote', color: 'yellow' as const, stale: true as const, staleReason: 'quote-not-found' },
      { id: 'd', blockKey: 'b9:zzz', start: 1, end: 2, quote: 'no block', color: 'yellow' as const },
    ]
    const merged = mergeAnnotationsForSave(normalized, stale)
    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged[0]?.note).toBe('edited')
    expect(merged[2]?.stale).toBe(true)
    expect(merged[2]?.staleReason).toBe('quote-not-found')
    expect(merged[3]?.blockKey).toBe('b9:zzz')
  })

  it('tolerates missing/invalid lists and skips entries without ids', () => {
    expect(mergeAnnotationsForSave(null, undefined)).toEqual([])
    expect(mergeAnnotationsForSave([], [])).toEqual([])
    const merged = mergeAnnotationsForSave(
      [
        { id: 'x', blockKey: '', start: 0, end: 1, quote: '', color: 'yellow' },
        // Internal assertion: the helper must tolerate malformed host data.
        null as unknown as Annotation,
        // Internal assertion: same.
        { note: 'no id' } as unknown as Annotation,
      ],
      [{ id: 'y', blockKey: '', start: 0, end: 0, quote: '', color: 'yellow', stale: true as const }],
    )
    expect(merged.map((item) => item.id)).toEqual(['x', 'y'])
  })
})

describe('normalizeStaleAnnotation', () => {
  it('clamps offsets, caps the quote and keeps provenance', () => {
    const out = normalizeStaleAnnotation({
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
    expect(out).not.toBeNull()
    expect(out?.id).toBe('ann-1')
    expect(out?.blockKey).toBe('b99:dead')
    expect(out?.start).toBe(0)
    expect(out?.end).toBe(9999)
    expect(out?.quote.length).toBe(MAX_ANNOTATION_QUOTE)
    expect(out?.color).toBe('yellow')
    expect(out?.note).toBe('')
    expect(out?.stale).toBe(true)
    expect(out?.staleReason).toBe('quote-not-found')
    expect(out?.reanchored).toBe(true)
    expect(out?.origin).toBe('ai')
    expect(out?.aspect).toBe('method')
    expect(out?.chatId).toBe('chat-1')
    expect(out?.messageId).toBe('msg-1')
    expect(out?.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(out?.createdAt).toBe('2026-11-06T00:00:00.000Z')
    expect(out?.updatedAt).toBe('2026-11-06T01:00:00.000Z')
  })

  it('rejects unusable entries and defaults timestamps', () => {
    expect(normalizeStaleAnnotation(null)).toBeNull()
    expect(normalizeStaleAnnotation([])).toBeNull()
    expect(normalizeStaleAnnotation({ quote: 'no id' })).toBeNull()
    const out = normalizeStaleAnnotation({ id: 'a2', quote: 'q', color: 'sage' })
    expect(out?.stale).toBe(true)
    expect(out?.color).toBe('sage')
    expect(out?.createdAt).toBe('1970-01-01T00:00:00.000Z')
    expect(out?.updatedAt).toBe(out?.createdAt)
    expect(out?.aspect).toBeUndefined()
  })
})

describe('countAnnotationOrigins', () => {
  it('counts AI provenance separately and tolerates bad input', () => {
    expect(countAnnotationOrigins(null)).toEqual({ all: 0, ai: 0, user: 0 })
    const counts = countAnnotationOrigins([
      { id: '1', blockKey: '', start: 0, end: 1, quote: '', color: 'yellow', origin: 'ai' },
      { id: '2', blockKey: '', start: 0, end: 1, quote: '', color: 'yellow', origin: 'user' },
      { id: '3', blockKey: '', start: 0, end: 1, quote: '', color: 'yellow' },
    ])
    expect(counts).toEqual({ all: 3, ai: 1, user: 2 })
  })
})
