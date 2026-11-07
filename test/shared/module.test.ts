/**
 * Module-contract tests for the shared reader modules (port/adaptation of
 * `.agents/baseline-1.0.0/test/reader/module.test.mjs`).
 *
 * The frozen test asserted factory-body constraints (no imports, no default
 * exports, one shared bundle scope) because 1.0.0 inlined two plain JS files
 * into the client factory. 2.0 ships real ES modules, so those assertions no
 * longer apply; the documented API surface and the parser ↔ annotation
 * round-trip remain the contract.
 */

import { test, expect } from 'vitest'

import * as annotateHighlight from '../../src/shared/annotate/highlight.ts'
import * as annotateAnchors from '../../src/shared/annotate/anchors.ts'
import * as markdownModel from '../../src/shared/markdown/model.ts'
import * as markdownParse from '../../src/shared/markdown/parse.ts'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { isAnnotatableBlock, normalizeAnnotation, overlayRuns, groupAnnotations } from '../../src/shared/annotate/highlight.ts'

test('documented model functions are exported and callable', () => {
  for (const name of ['fnv1a', 'blockKey', 'runsText', 'plainTextOfBlock', 'mdStats', 'emptyModel'] as const) {
    expect(typeof markdownModel[name], `missing model export ${name}`).toBe('function')
  }
  for (const name of ['parseMarkdown', 'appendPageMarks', 'parseInline'] as const) {
    expect(typeof markdownParse[name], `missing parse export ${name}`).toBe('function')
  }
  // Re-exported helpers keep the frozen single-import convenience.
  for (const name of ['fnv1a', 'blockKey', 'runsText', 'plainTextOfBlock', 'mdStats'] as const) {
    expect(typeof markdownParse[name], `missing parse re-export ${name}`).toBe('function')
  }
})

test('documented annotation functions are exported and callable', () => {
  for (const name of [
    'overlayRuns',
    'normalizeAnnotation',
    'groupAnnotations',
    'isAnnotatableBlock',
    'newAnnotationId',
  ] as const) {
    expect(typeof annotateHighlight[name], `missing highlight export ${name}`).toBe('function')
  }
  for (const name of [
    'normalizeQuoteText',
    'locateQuote',
    'findQuoteRange',
    'quoteContained',
    'overlaps',
    'annotationsOverlap',
    'findDuplicateAnnotation',
  ] as const) {
    expect(typeof annotateAnchors[name], `missing anchors export ${name}`).toBe('function')
  }
})

test('parsed blocks round-trip through the annotation helpers', () => {
  const model = parseMarkdown('**Claim:** routing is cheap for long queries.')
  const block = model.blocks[0]
  expect(block).toBeDefined()
  if (block === undefined) return
  expect(isAnnotatableBlock(block)).toBe(true)
  const annotation = normalizeAnnotation({ start: 2, end: 7, color: 'sky' }, block)
  expect(annotation).not.toBeNull()
  if (annotation === null) return
  const segments = overlayRuns('runs' in block ? block.runs : [], [annotation])
  expect(segments.map((segment) => segment.text).join('')).toBe(block.plainText)
  expect(segments.some((segment) => segment.annotationIds.includes(annotation.id))).toBe(true)
  const groups = groupAnnotations([annotation])
  expect(groups.get(block.key)?.length).toBe(1)
})

test('page-marked models still resolve every annotation anchor', () => {
  const model = parseMarkdown('# Title\n\nBody text for an annotation.')
  const target = model.blocks[1]
  expect(target).toBeDefined()
  if (target === undefined) return
  const annotation = normalizeAnnotation({ blockKey: target.key, start: 0, end: 4 }, target)
  expect(annotation).not.toBeNull()
  if (annotation === null || !('runs' in target)) return
  const segments = overlayRuns(target.runs, [annotation])
  expect(segments.length).toBeGreaterThan(0)
  expect(segments.map((segment) => segment.text).join('')).toBe(target.plainText)
})
