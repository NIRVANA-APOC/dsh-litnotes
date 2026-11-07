/**
 * Performance: the MiniSearch-backed lexical retriever.
 *
 * Benchmarks the three reader/AI hot paths over the canonical fixture paper:
 * cold index build (markdown → blocks → MiniSearch), warm search (agent tools
 * and quick lookups) and bounded context assembly (chat prompt building).
 *
 * Timing is recorded, not asserted; search/context correctness (hits carry
 * `blockKey`/`page`/`kind`/`score`/`snippet`, context stays inside the char
 * budget) is asserted.
 */

import { test } from 'vitest'
import { expect } from 'vitest'

import { createRetriever } from '../../src/host/ai/retrieval.ts'
import { standardContentList, standardMarkdown } from '../helpers/parse-fixtures.ts'
import { measureSync } from './perf.ts'

const markdown = standardMarkdown()
const contentList = standardContentList()
const input = { documentId: 'perf-fixture-paper', markdown, contentList }

test('retriever builds a cold index for the fixture paper', { timeout: 60_000 }, () => {
  const retriever = createRetriever()
  let totalBlocks = 0
  measureSync(
    { suite: 'retrieval', case: 'build-index', iters: 10, bytes: markdown.length, note: 'canonical fixture paper' },
    () => {
      retriever.invalidate()
      totalBlocks = retriever.buildIndex(input).totalBlocks
    },
  )
  expect(totalBlocks).toBeGreaterThan(5)
  expect(retriever.buildIndex(input).documentId).toBe('perf-fixture-paper')
})

test('retriever answers warm lexical searches', { timeout: 60_000 }, () => {
  const retriever = createRetriever()
  const index = retriever.buildIndex(input)
  const focusKey = index.blocks[3]?.key ?? ''
  const hits = retriever.search({ ...input, query: 'sparse expert routing retrieval', limit: 8 })
  measureSync(
    {
      suite: 'retrieval',
      case: 'search-warm',
      iters: 200,
      bytes: markdown.length,
      note: `indexedBlocks=${index.totalBlocks}`,
    },
    () => retriever.search({ ...input, query: 'sparse expert routing retrieval', limit: 8 }),
  )
  expect(hits.length).toBeGreaterThan(0)
  const hit = hits[0]
  expect(typeof hit?.blockKey).toBe('string')
  expect(typeof hit?.kind).toBe('string')
  expect(typeof hit?.score).toBe('number')
  expect(typeof hit?.text).toBe('string')
  expect(hit?.page === null || typeof hit?.page === 'number').toBe(true)
  expect(focusKey).not.toBe('')
})

test('retriever assembles a bounded question context', { timeout: 60_000 }, () => {
  const retriever = createRetriever()
  const index = retriever.buildIndex(input)
  const focusKey = index.blocks[3]?.key ?? ''
  const contextInput = {
    ...input,
    question: 'How does SparseRoute route tokens through expert blocks?',
    focusBlockKey: focusKey,
    topK: 10,
    budgetChars: 6_000,
  }
  const context = retriever.context(contextInput)
  measureSync(
    {
      suite: 'retrieval',
      case: 'context-assembly',
      iters: 100,
      bytes: markdown.length,
      note: 'topK=10 budgetChars=6000',
    },
    () => retriever.context(contextInput),
  )
  expect(context.blocks.length).toBeGreaterThan(0)
  expect(context.blocks.length).toBeLessThanOrEqual(40)
  expect(context.usedChars).toBeLessThanOrEqual(6_000)
  expect(context.totalBlocks).toBe(index.totalBlocks)
  expect(context.blocks.some((block) => block.key === focusKey)).toBe(true)
})
