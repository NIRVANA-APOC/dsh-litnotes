/**
 * Unit tests for the lexical retriever (`lib/ai/retrieval.js`): deterministic
 * BM25-ish ranking over shared parser blocks, focus/selection inclusion,
 * neighbour expansion, context budget, page marks from MinerU's content list,
 * snippet search and cache invalidation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, plainTextOfBlock } from '../../ui/markdown.js'
import { createRetriever } from '../../lib/ai/retrieval.js'

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
function makeRetriever(options = {}) {
  return createRetriever({ parseMarkdown, plainTextOfBlock, logger: { warn() {}, debug() {} }, ...options })
}

/** Find a parser block by text fragment. */
function blockWith(markdown, fragment) {
  const model = parseMarkdown(markdown)
  const block = model.blocks.find(
    (candidate) => typeof candidate.plainText === 'string' && candidate.plainText.includes(fragment),
  )
  assert.ok(block !== undefined, `expected a block containing: ${fragment}`)
  return block
}

/** Standard retrieval input for the fixture document. */
function input(overrides = {}) {
  return { documentId: 'doc-1', markdown: MARKDOWN, ...overrides }
}

// ---------------------------------------------------------------------------
// Index building and caching
// ---------------------------------------------------------------------------

test('buildIndex returns the public block structure and caches by content signature', () => {
  let parseCalls = 0
  const retriever = makeRetriever({
    parseMarkdown: (markdown) => {
      parseCalls += 1
      return parseMarkdown(markdown)
    },
  })
  const first = retriever.buildIndex(input())
  assert.ok(first.totalBlocks >= 9)
  assert.ok(Array.isArray(first.outline) && first.outline.length >= 5)
  assert.ok(first.sections.every((section) => typeof section.text === 'string'))
  assert.equal(first.blocks.length, first.totalBlocks)
  for (const block of first.blocks) {
    assert.match(block.key, /^b\d+:[0-9a-f]{8}$/)
    assert.ok(Number.isInteger(block.index))
    assert.ok(typeof block.kind === 'string')
  }
  const blocks = retriever.blocks(input())
  assert.deepEqual(blocks.map((block) => block.key), first.blocks.map((block) => block.key))

  // Cached: a second call with the same content does not re-parse.
  retriever.buildIndex(input())
  assert.equal(parseCalls, 1)
  // Changing the markdown signature rebuilds.
  retriever.buildIndex(input({ markdown: `${MARKDOWN}\nExtra paragraph about caching.` }))
  assert.equal(parseCalls, 2)
  // Explicit invalidation rebuilds as well.
  retriever.invalidate('doc-1')
  retriever.buildIndex(input())
  assert.equal(parseCalls, 3)
})

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

test('context ranks the method paragraph first for a method question', () => {
  const retriever = makeRetriever()
  const context = retriever.context(
    input({ question: 'What routing network method does the paper propose?' }),
  )
  assert.ok(context.blocks.length > 0)
  assert.ok(context.blocks.some((block) => block.text.includes('routing network selects relevant blocks')))
  assert.ok(context.totalBlocks >= 9)
  assert.ok(context.usedChars > 0)
  // Blocks are ordered by position in the document (prompt stability).
  const indexes = context.blocks.map((block) => block.index)
  assert.deepEqual(indexes, [...indexes].sort((left, right) => left - right))
  for (const block of context.blocks) {
    assert.match(block.key, /^b\d+:[0-9a-f]{8}$/)
    assert.ok(Number.isFinite(block.score))
    assert.equal(typeof block.section, 'string')
  }
  assert.equal(context.outline.length >= 5, true)
  assert.ok(Array.isArray(context.sections))

  // The lexical search helper agrees on the best match.
  const results = retriever.search(input(), 'routing network', 5)
  assert.ok(results.length > 0)
  assert.match(results[0].text, /routing network/)
  assert.match(results[0].blockKey, /^b\d+:[0-9a-f]{8}$/)
})

test('context always includes the title/abstract head even without query terms', () => {
  const retriever = makeRetriever()
  const context = retriever.context(input({ question: 'what is the' }))
  assert.equal(context.blocks.length, 3)
  assert.ok(context.blocks.some((block) => block.text.includes('Sparse Attention for Long Documents')))
})

test('context always includes the reader focus block and selection block', () => {
  const retriever = makeRetriever()
  const focus = blockWith(MARKDOWN, 'Routing adds latency')
  const withFocus = retriever.context(input({ question: 'benchmark throughput', focusBlockKey: focus.key }))
  assert.ok(withFocus.blocks.some((block) => block.key === focus.key))
  assert.ok(withFocus.blocks.some((block) => block.text.includes('2.4x')))

  const selectionBlock = blockWith(MARKDOWN, 'requires a warm-up phase')
  const withSelection = retriever.context(
    input({ question: 'benchmark throughput', selection: { blockKey: '', quote: 'requires a warm-up phase' } }),
  )
  assert.ok(withSelection.blocks.some((block) => block.key === selectionBlock.key))

  // A selection blockKey wins over the quote search.
  const intro = blockWith(MARKDOWN, 'Sparse attention is a common solution')
  const byKey = retriever.context(
    input({ question: 'benchmark', selection: { blockKey: intro.key, quote: 'does not appear anywhere' } }),
  )
  assert.ok(byKey.blocks.some((block) => block.key === intro.key))
})

test('context honours the character budget', () => {
  const retriever = makeRetriever()
  for (const budgetChars of [500, 900, 1500]) {
    const context = retriever.context(
      input({ question: 'sparse attention routing benchmark memory accuracy', budgetChars, topK: 20 }),
    )
    assert.ok(context.blocks.length > 0)
    assert.ok(context.usedChars <= budgetChars, `usedChars ${context.usedChars} > budget ${budgetChars}`)
    for (const block of context.blocks) {
      const textLength = block.text.length
      assert.ok(textLength > 0)
    }
  }
})

test('context is deterministic and topK bounds the number of matches', () => {
  const retriever = makeRetriever()
  const request = {
    ...input({ question: 'sparse attention long documents method results limitations' }),
    topK: 12,
  }
  const first = retriever.context(request)
  const second = retriever.context(request)
  assert.deepEqual(first, second)

  const small = retriever.context({ ...request, topK: 1 })
  assert.ok(small.blocks.length <= first.blocks.length)
  assert.ok(small.blocks.some((block) => block.text.includes('Sparse Attention for Long Documents')))
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
  assert.equal(firstPage.page, 1)
  assert.equal(secondPage.page, 2)
})

test('search returns bounded snippets, respects limit and handles CJK queries', () => {
  const retriever = makeRetriever()
  const results = retriever.search(input(), '2.4x throughput LongBench', 3)
  assert.ok(results.length > 0 && results.length <= 3)
  assert.match(results[0].text, /2\.4x/)
  for (const result of results) {
    assert.ok(result.text.length <= 420)
    assert.ok(result.score > 0)
  }
  assert.deepEqual(retriever.search(input(), '   ', 5), [])
  assert.deepEqual(retriever.search(input(), 'zzzz-not-in-document', 5), [])

  const cjk = makeRetriever()
  const cjkContext = cjk.context({
    documentId: 'doc-cjk',
    markdown: CJK_MARKDOWN,
    question: '稀疏注意力的方法是什么',
  })
  assert.ok(cjkContext.blocks.some((block) => block.text.includes('稀疏注意力')))
  const cjkResults = cjk.search({ documentId: 'doc-cjk', markdown: CJK_MARKDOWN }, '路由网络', 5)
  assert.ok(cjkResults.length > 0)
  assert.match(cjkResults[0].text, /路由网络/)

  const keyword = retriever.search(input(), 'learned routing', 5)
  assert.ok(keyword[0].text.includes('learned routing'))
})

test('empty documents produce an empty context safely', () => {
  const retriever = makeRetriever()
  const empty = retriever.buildIndex({ documentId: 'doc-empty', markdown: '' })
  assert.equal(empty.totalBlocks, 0)
  assert.deepEqual(empty.blocks, [])
  const context = retriever.context({ documentId: 'doc-empty', markdown: '', question: 'anything' })
  assert.deepEqual(context.blocks, [])
  assert.equal(context.usedChars, 0)
  assert.equal(context.totalBlocks, 0)
  assert.deepEqual(retriever.search({ documentId: 'doc-empty', markdown: '' }, 'anything'), [])

  const titleOnly = retriever.buildIndex({ documentId: 'doc-title', markdown: '# Title Only' })
  assert.equal(titleOnly.totalBlocks, 1)
  const titleContext = retriever.context({ documentId: 'doc-title', markdown: '# Title Only', question: 'title?' })
  assert.equal(titleContext.blocks.length, 1)
})

test('retrieval input validation surfaces a bad-request AiError', () => {
  const retriever = makeRetriever()
  assert.throws(() => retriever.context({ documentId: '', markdown: MARKDOWN }), (error) => {
    assert.equal(error.code, 'bad-request')
    return true
  })
  assert.throws(() => retriever.search({ markdown: MARKDOWN }, 'x'), (error) => {
    assert.equal(error.code, 'bad-request')
    return true
  })
})
