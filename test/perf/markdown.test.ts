/**
 * Performance: the shared markdown → paper-model parser.
 *
 * Benchmarks `parseMarkdown` from `src/shared/markdown/parse.ts` on the canonical
 * MinerU result markdown (`test/fixtures/paper.md`, the same 6.4 KB fixture the
 * parse-pipeline tests use) and on a synthetic 20× concatenation of it that
 * approximates a large real paper. A short `parseInline` case covers the
 * paragraph-level hot path used by the reader.
 *
 * Timing is recorded, not asserted; functional integrity (block keys, outline,
 * stats) is asserted so a broken parser fails loudly even if it is fast.
 */

import { test } from 'vitest'
import { expect } from 'vitest'

import { parseInline, parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { standardMarkdown } from '../helpers/parse-fixtures.ts'
import { measureSync } from './perf.ts'

const paper = standardMarkdown()
/** 20× the fixture: ~128 KB of MinerU markdown, a large-but-real paper size. */
const largePaper = Array.from({ length: 20 }, () => paper).join('\n\n')
/** One long inline paragraph exercising emphasis / math / code run parsing. */
const inlineParagraph =
  'The **block-separator tree** is a `canonical` decomposition where $x_i = \\sum_{j=1}^{n} y_j$, ' +
  'so *redundancy* is detected by comparing subtree signatures; see [BEE](https://example.org/bee) ' +
  'and the caption in Figure 2. '

test('parse the canonical fixture paper markdown', () => {
  const sample = measureSync(
    { suite: 'markdown', case: 'parse-fixture-paper', iters: 50, bytes: paper.length, note: 'test/fixtures/paper.md' },
    () => parseMarkdown(paper),
  )
  expect(sample.iters).toBe(50)
  const model = parseMarkdown(paper)
  expect(model.blocks.length).toBeGreaterThan(5)
  expect(model.stats.blocks).toBe(model.blocks.length)
  expect(model.stats.chars).toBeGreaterThan(1_000)
  expect(model.outline.length).toBeGreaterThan(0)
  // Block keys are deterministic for identical input and unique per block.
  expect(model.blocks[0]?.key).toBe(parseMarkdown(paper).blocks[0]?.key)
  expect(new Set(model.blocks.map((block) => block.key)).size).toBe(model.blocks.length)
})

test('parse a large (20× fixture) paper markdown', () => {
  const sample = measureSync(
    { suite: 'markdown', case: 'parse-large-paper', iters: 10, bytes: largePaper.length, note: 'fixture paper ×20' },
    () => parseMarkdown(largePaper),
  )
  expect(sample.iters).toBe(10)
  const model = parseMarkdown(largePaper)
  expect(model.blocks.length).toBeGreaterThan(20 * (parseMarkdown(paper).blocks.length - 2))
  expect(model.stats.chars).toBeGreaterThan(20 * 1_000)
})

test('parse inline runs for a long paragraph', () => {
  const sample = measureSync(
    { suite: 'markdown', case: 'parse-inline-paragraph', iters: 500, bytes: inlineParagraph.length },
    () => parseInline(inlineParagraph),
  )
  expect(sample.iters).toBe(500)
  const runs = parseInline(inlineParagraph)
  expect(runs.length).toBeGreaterThan(5)
  expect(runs.some((run) => run.type === 'math')).toBe(true)
})
