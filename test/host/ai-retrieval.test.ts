/**
 * Unit tests for the lexical retriever (`src/host/ai/retrieval.ts`):
 * deterministic MiniSearch ranking over shared parser blocks, focus/selection
 * inclusion, neighbour expansion, context budget, page marks from MinerU's
 * content list, snippet search, CJK segmentation and cache invalidation.
 */

import { expect, test } from 'vitest'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { plainTextOfBlock } from '../../src/shared/markdown/model.ts'
import {
  createRetriever,
  type Retriever,
  type RetrieverContextInput,
} from '../../src/host/ai/retrieval.ts'

const MARKDOWN = `# Sparse Attention for Long Documents

## Abstract

We study efficient attention for long documents. Our sparse attention method reduces memory by 60% while keeping accuracy.

## 1 Introduction

Transformers are expensive for long documents. Sparse attention is a common solution.

## 2 Method

We propose block-sparse attention with learned routing. The routing network selects relevant blocks for each query token.

## 3 Results

On the LongBench benchmark our method improves throughput by 2.4x with equal accuracy.

## 4 Limitations

Routing adds latency on short sequences and requires a warm-up phase.
`

const CJK_MARKDOWN = `# 高效阅读

## 摘要

我们提出一种稀疏注意力方法，用于长文档的高效理解。

## 方法

该方法使用路由网络选择相关文本块，从而降低计算开销。
`

/** A retriever over the real parser. */
function makeRetriever(options: Parameters<typeof createRetriever>[0] = {}): Retriever {
  return createRetriever({ parseMarkdown, plainTextOfBlock, logger: { warn(): void {}, debug(): void {} }, ...options })
}

/** Find a parser block by text fragment. */
function blockWith(markdown: string, fragment: string): { key: string; plainText: string } {
  const model = parseMarkdown(markdown)
  const block = model.blocks.find(
    (candidate) => typeof candidate.plainText === 'string' && candidate.plainText.includes(fragment),
  )
  expect(block, `expected a block containing: ${fragment}`).toBeDefined()
  return block as { key: string; plainText: string }
}

/** Standard retrieval input for the fixture document. */
function input(overrides: Partial<RetrieverContextInput> = {}): RetrieverContextInput {
  return { documentId: 'doc-1', markdown: MARKDOWN, ...overrides }
}

// ---------------------------------------------------------------------------
// Index building and caching
// ---------------------------------------------------------------------------

test('buildIndex returns the public block structure and caches by content signature', () => {
  let parseCalls = 0
  const retriever = makeRetriever({
    parseMarkdown: (markdown: string) => {
      parseCalls += 1
      return parseMarkdown(markdown)
    },
  })
  const first = retriever.buildIndex(input())
  expect(first.totalBlocks).toBeGreaterThanOrEqual(9)
  expect(Array.isArray(first.outline) && first.outline.length >= 5).toBe(true)
  expect(first.sections.every((section) => typeof section === 'string')).toBe(true)
  expect(first.blocks.length).toBe(first.totalBlocks)
  for (const block of first.blocks) {
    expect(block.key).toMatch(/^b\d+:[0-9a-f]{8}$/)
    expect(Number.isInteger(block.index)).toBe(true)
    expect(typeof block.kind).toBe('string')
  }
  const blocks = retriever.blocks(input())
  expect(blocks.map((block) => block.key)).toEqual(first.blocks.map((block) => block.key))

  // Cached: a second call with the same content does not re-parse.
  retriever.buildIndex(input())
  expect(parseCalls).toBe(1)
  // Changing the markdown signature rebuilds.
  retriever.buildIndex(input({ markdown: `${MARKDOWN}\nExtra paragraph about caching.` }))
  expect(parseCalls).toBe(2)
  // Explicit invalidation rebuilds as well.
  retriever.invalidate('doc-1')
  retriever.buildIndex(input())
  expect(parseCalls).toBe(3)
})

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

test('context ranks the method paragraph for a method question', () => {
  const retriever = makeRetriever()
  const context = retriever.context(input({ question: 'What routing network method does the paper propose?' }))
  expect(context.blocks.length).toBeGreaterThan(0)
  expect(context.blocks.some((block) => block.text.includes('routing network selects relevant blocks'))).toBe(true)
  expect(context.totalBlocks).toBeGreaterThanOrEqual(9)
  expect(context.usedChars).toBeGreaterThan(0)
  // Blocks are ordered by position in the document (prompt stability).
  const indexes = context.blocks.map((block) => block.index)
  expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
  for (const block of context.blocks) {
    expect(block.key).toMatch(/^b\d+:[0-9a-f]{8}$/)
    expect(Number.isFinite(block.score)).toBe(true)
    expect(typeof block.section).toBe('string')
  }
  expect(context.outline.length >= 5).toBe(true)
  expect(Array.isArray(context.sections)).toBe(true)

  // The lexical search helper agrees on the best match.
  const results = retriever.search({ ...input(), query: 'routing network', limit: 5 })
  expect(results.length).toBeGreaterThan(0)
  expect(results[0]?.text).toMatch(/routing network/)
  expect(results[0]?.blockKey).toMatch(/^b\d+:[0-9a-f]{8}$/)
})

test('context always includes the title/abstract head even without query terms', () => {
  const retriever = makeRetriever()
  const context = retriever.context(input({ question: 'what is the' }))
  expect(context.blocks.length).toBe(3)
  expect(context.blocks.some((block) => block.text.includes('Sparse Attention for Long Documents'))).toBe(true)
})

test('context always includes the reader focus block and selection block', () => {
  const retriever = makeRetriever()
  const focus = blockWith(MARKDOWN, 'Routing adds latency')
  const withFocus = retriever.context(input({ question: 'benchmark throughput', focusBlockKey: focus.key }))
  expect(withFocus.blocks.some((block) => block.key === focus.key)).toBe(true)
  expect(withFocus.blocks.some((block) => block.text.includes('2.4x'))).toBe(true)

  const selectionBlock = blockWith(MARKDOWN, 'requires a warm-up phase')
  const withSelection = retriever.context(
    input({ question: 'benchmark throughput', selection: { blockKey: '', quote: 'requires a warm-up phase' } }),
  )
  expect(withSelection.blocks.some((block) => block.key === selectionBlock.key)).toBe(true)

  // A selection blockKey wins over the quote search.
  const intro = blockWith(MARKDOWN, 'Sparse attention is a common solution')
  const byKey = retriever.context(
    input({ question: 'benchmark', selection: { blockKey: intro.key, quote: 'does not appear anywhere' } }),
  )
  expect(byKey.blocks.some((block) => block.key === intro.key)).toBe(true)
})

test('context honours the character budget', () => {
  const retriever = makeRetriever()
  for (const budgetChars of [500, 900, 1500]) {
    const context = retriever.context(
      input({ question: 'sparse attention routing benchmark memory accuracy', budgetChars, topK: 20 }),
    )
    expect(context.blocks.length).toBeGreaterThan(0)
    expect(context.usedChars, `usedChars ${context.usedChars} > budget ${budgetChars}`).toBeLessThanOrEqual(budgetChars)
    for (const block of context.blocks) expect(block.text.length).toBeGreaterThan(0)
  }
})

test('context is deterministic and topK bounds the number of matches', () => {
  const retriever = makeRetriever()
  const request = input({ question: 'sparse attention long documents method results limitations', topK: 12 })
  const first = retriever.context(request)
  const second = retriever.context(request)
  expect(first).toEqual(second)

  const small = retriever.context({ ...request, topK: 1 })
  expect(small.blocks.length).toBeLessThanOrEqual(first.blocks.length)
  expect(small.blocks.some((block) => block.text.includes('Sparse Attention for Long Documents'))).toBe(true)
})

test('context derives page numbers from the MinerU content list', () => {
  const markdown = `# Two Page Paper

## Page One Section

Alpha alpha unique first page sentence about graphs.

## Page Two Section

Beta beta second page sentence about retrieval.
`
  const contentList = [
    { type: 'text', text: 'Alpha alpha unique first page sentence about graphs.', page_idx: 0 },
    { type: 'text', text: 'Beta beta second page sentence about retrieval.', page_idx: 1 },
  ]
  const retriever = makeRetriever()
  const blocks = retriever.blocks({ documentId: 'doc-pages', markdown, contentList })
  const firstPage = blocks.find((block) => block.text.includes('Alpha alpha unique'))
  const secondPage = blocks.find((block) => block.text.includes('Beta beta second'))
  expect(firstPage?.page).toBe(1)
  expect(secondPage?.page).toBe(2)
})

test('search returns bounded snippets, respects limit and handles CJK queries', () => {
  const retriever = makeRetriever()
  const results = retriever.search({ ...input(), query: '2.4x throughput LongBench', limit: 3 })
  expect(results.length).toBeGreaterThan(0)
  expect(results.length).toBeLessThanOrEqual(3)
  expect(results[0]?.text).toMatch(/2\.4x/)
  for (const result of results) {
    expect(result.text.length).toBeLessThanOrEqual(420)
    expect(result.score).toBeGreaterThan(0)
  }
  expect(retriever.search({ ...input(), query: '   ', limit: 5 })).toEqual([])
  expect(retriever.search({ ...input(), query: 'zzzz-not-in-document', limit: 5 })).toEqual([])

  const cjk = makeRetriever()
  const cjkContext = cjk.context({
    documentId: 'doc-cjk',
    markdown: CJK_MARKDOWN,
    question: '稀疏注意力的方法是什么',
  })
  expect(cjkContext.blocks.some((block) => block.text.includes('稀疏注意力'))).toBe(true)
  const cjkResults = cjk.search({ documentId: 'doc-cjk', markdown: CJK_MARKDOWN, query: '路由网络', limit: 5 })
  expect(cjkResults.length).toBeGreaterThan(0)
  expect(cjkResults[0]?.text).toMatch(/路由网络/)

  const keyword = retriever.search({ ...input(), query: 'learned routing', limit: 5 })
  expect(keyword[0]?.text.includes('learned routing')).toBe(true)
})

test('empty documents produce an empty context safely', () => {
  const retriever = makeRetriever()
  const empty = retriever.buildIndex({ documentId: 'doc-empty', markdown: '' })
  expect(empty.totalBlocks).toBe(0)
  expect(empty.blocks).toEqual([])
  const context = retriever.context({ documentId: 'doc-empty', markdown: '', question: 'anything' })
  expect(context.blocks).toEqual([])
  expect(context.usedChars).toBe(0)
  expect(context.totalBlocks).toBe(0)
  expect(retriever.search({ documentId: 'doc-empty', markdown: '', query: 'anything' })).toEqual([])

  const titleOnly = retriever.buildIndex({ documentId: 'doc-title', markdown: '# Title Only' })
  expect(titleOnly.totalBlocks).toBe(1)
  const titleContext = retriever.context({ documentId: 'doc-title', markdown: '# Title Only', question: 'title?' })
  expect(titleContext.blocks.length).toBe(1)
})

test('retrieval input validation surfaces a bad-request AiError', () => {
  const retriever = makeRetriever()
  try {
    retriever.context({ documentId: '', markdown: MARKDOWN })
    throw new Error('expected a bad-request error')
  } catch (error) {
    expect((error as { code?: string }).code).toBe('bad-request')
  }
  try {
    // @ts-expect-error - runtime payload without a documentId is a bad request
    retriever.search({ markdown: MARKDOWN, query: 'x' })
    throw new Error('expected a bad-request error')
  } catch (error) {
    expect((error as { code?: string }).code).toBe('bad-request')
  }
})
