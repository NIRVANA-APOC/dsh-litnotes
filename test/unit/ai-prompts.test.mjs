/**
 * Unit tests for the centralized prompt text (`lib/ai/prompts.js`): the
 * `litnotes-json` contract, context-block format, history/focus rendering and
 * the graph/summary prompt builders used by the other engines.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANSWER_FENCE_OPEN,
  ANSWER_FENCE_TAG,
  CHAT_SYSTEM,
  ENTAILMENT_FENCE_OPEN,
  ENTAILMENT_FENCE_TAG,
  ENTAILMENT_SYSTEM,
  ENTAILMENT_VERDICTS,
  GRAPH_EXTRACTION_SYSTEM,
  GRAPH_FENCE_TAG,
  GRAPH_SUMMARY_PROMPT,
  LIBRARY_CONSOLIDATION_PROMPT,
  PROMPT_VERSION,
  SUMMARY_FENCE_TAG,
  chatUserPrompt,
  entailmentPrompt,
  formatContextBlock,
  graphExtractionPrompt,
  graphSummaryUserPrompt,
  libraryConsolidationUserPrompt,
  parseEntailmentOutput,
} from '../../lib/ai/prompts.js'

test('prompt version and fence tags are the documented contract', () => {
  assert.equal(PROMPT_VERSION, 2, 'bumped when the entailment pass landed')
  assert.equal(ANSWER_FENCE_TAG, 'litnotes-json')
  assert.equal(GRAPH_FENCE_TAG, 'litnotes-graph')
  assert.equal(SUMMARY_FENCE_TAG, 'litnotes-summary')
  assert.equal(ENTAILMENT_FENCE_TAG, 'litnotes-entailment')
  assert.equal(ANSWER_FENCE_OPEN, '```litnotes-json')
  assert.equal(ENTAILMENT_FENCE_OPEN, '```litnotes-entailment')
  assert.deepEqual([...ENTAILMENT_VERDICTS], ['supported', 'partial', 'unsupported'])
})

test('CHAT_SYSTEM teaches grounding, citations, aspects and the JSON fence', () => {
  assert.match(CHAT_SYSTEM, /Answer ONLY from the context blocks/)
  assert.match(CHAT_SYSTEM, /verbatim/i)
  assert.match(CHAT_SYSTEM, /\[1\]/)
  assert.match(CHAT_SYSTEM, /```litnotes-json/)
  for (const aspect of ['definition', 'method', 'result', 'limitation', 'context']) {
    assert.ok(CHAT_SYSTEM.includes(`"${aspect}"`), `expected aspect ${aspect} in CHAT_SYSTEM`)
  }
  assert.match(CHAT_SYSTEM, /language of the reader's question/)
  assert.match(CHAT_SYSTEM, /do not guess|Do not guess/)
})

test('formatContextBlock renders [[key]] (page N) text', () => {
  assert.equal(
    formatContextBlock({ key: 'b12:ab12cd34', page: 3, text: 'Sparse attention.' }),
    '[[b12:ab12cd34]] (page 3) Sparse attention.',
  )
  assert.equal(
    formatContextBlock({ key: 'b1:0000abcd', page: null, text: 'No page.' }),
    '[[b1:0000abcd]] (page unknown) No page.',
  )
  assert.equal(formatContextBlock({}), '[[]] (page unknown) ')
})

test('chatUserPrompt includes context, outline, history, focus and question', () => {
  const context = {
    blocks: [
      { key: 'b0:11111111', page: 1, text: 'Sparse Attention for Long Documents' },
      { key: 'b4:22222222', page: 2, text: 'We propose block-sparse attention with learned routing.' },
    ],
    outline: [
      { key: 'b0:11111111', level: 1, text: 'Sparse Attention for Long Documents' },
      { key: 'b2:33333333', level: 2, text: '2 Method' },
    ],
    usedChars: 120,
    totalBlocks: 9,
  }
  const prompt = chatUserPrompt(
    context,
    'What is the method?',
    [{ question: 'What does the paper study?', answer: 'Efficient attention.' }],
    { title: 'Sparse Attention for Long Documents', focusBlockKey: 'b4:22222222', selectionQuote: 'learned routing' },
  )
  assert.match(prompt, /^Paper: Sparse Attention for Long Documents/m)
  assert.match(prompt, /Document outline/)
  assert.match(prompt, /- Sparse Attention for Long Documents/)
  assert.match(prompt, /- 2 Method/)
  assert.match(prompt, /Conversation so far/)
  assert.match(prompt, /Reader: What does the paper study\?/)
  assert.match(prompt, /Assistant: Efficient attention\./)
  assert.match(prompt, /\[\[b0:11111111\]\] \(page 1\) Sparse Attention for Long Documents/)
  assert.match(prompt, /\[\[b4:22222222\]\] \(page 2\) We propose block-sparse attention/)
  assert.match(prompt, /Reader focus/)
  assert.match(prompt, /learned routing/)
  assert.match(prompt, /Question:\nWhat is the method\?/)
  assert.match(prompt, /litnotes-json/)
  assert.ok(prompt.length < 60000)
})

test('chatUserPrompt handles empty context and empty history', () => {
  const prompt = chatUserPrompt({ blocks: [], outline: [] }, 'Why?', [])
  assert.match(prompt, /no context blocks were retrieved/)
  assert.match(prompt, /Question:\nWhy\?/)
  assert.doesNotMatch(prompt, /Conversation so far/)
})

test('graph prompts expose the graph/summary fences and bounded builders', () => {
  assert.match(GRAPH_EXTRACTION_SYSTEM, /```litnotes-graph/)
  for (const type of ['concept', 'method', 'finding', 'definition', 'limitation', 'section']) {
    assert.ok(GRAPH_EXTRACTION_SYSTEM.includes(type), `expected node type ${type}`)
  }
  assert.match(GRAPH_SUMMARY_PROMPT, /```litnotes-summary/)
  assert.match(GRAPH_SUMMARY_PROMPT, /overview/)
  assert.match(GRAPH_SUMMARY_PROMPT, /tldr/)
  assert.match(GRAPH_SUMMARY_PROMPT, /glossary/)
  assert.match(LIBRARY_CONSOLIDATION_PROMPT, /Markdown overview/)
  assert.match(LIBRARY_CONSOLIDATION_PROMPT, /Never invent papers/)

  const fromString = graphExtractionPrompt('We propose sparse attention.', {
    title: 'Paper',
    section: '2 Method',
    index: 2,
    total: 4,
  })
  assert.match(fromString, /Paper: Paper/)
  assert.match(fromString, /Section: 2 Method/)
  assert.match(fromString, /Chunk: 2 of 4/)
  assert.match(fromString, /We propose sparse attention\./)
  assert.match(fromString, /litnotes-graph/)

  const fromBlocks = graphExtractionPrompt(
    { blocks: [{ key: 'b3:abcd1234', text: 'Routing selects blocks.' }] },
    { documentTitle: 'Paper' },
  )
  assert.match(fromBlocks, /\[\[b3:abcd1234\]\] Routing selects blocks\./)

  const summary = graphSummaryUserPrompt({
    title: 'Paper',
    outline: [{ level: 1, text: 'Introduction' }],
    nodes: [{ type: 'method', label: 'sparse attention', summary: 'Sparse attention.', blockKeys: ['b3:abcd1234'] }],
  })
  assert.match(summary, /Section headings/)
  assert.match(summary, /\[method\] sparse attention/)
  assert.match(summary, /litnotes-summary/)

  const library = libraryConsolidationUserPrompt({
    overview: 'A library about attention.',
    papers: [{ title: 'Paper A', year: 2024 }],
    topics: [{ label: 'attention', weight: 3, documentIds: ['d1', 'd2'] }],
  })
  assert.match(library, /Papers:/)
  assert.match(library, /- Paper A \(2024\)/)
  assert.match(library, /- attention — 3 — 2 paper\(s\)/)
})

test('ENTAILMENT_SYSTEM teaches the verdict vocabulary and fence contract', () => {
  assert.match(ENTAILMENT_SYSTEM, /```litnotes-entailment/)
  for (const verdict of ['supported', 'partial', 'unsupported']) {
    assert.ok(ENTAILMENT_SYSTEM.includes(`"${verdict}"`), `expected verdict ${verdict}`)
  }
  assert.match(ENTAILMENT_SYSTEM, /untrusted DATA/i)
  assert.match(ENTAILMENT_SYSTEM, /Judge only the supplied quote/)
  assert.match(ENTAILMENT_SYSTEM, /No text outside the/)
})

test('entailmentPrompt renders numbered claims with their quoted evidence', () => {
  const prompt = entailmentPrompt([
    { index: 1, aspect: 'method', note: 'The method is block-sparse attention.', quote: 'We propose block-sparse attention.' },
    { index: 2, aspect: 'result', note: 'It improves throughput by 2.4x.', quote: 'improves throughput by 2.4x with equal accuracy' },
  ])
  assert.match(prompt, /\[1\] \(method\) claim: The method is block-sparse attention\./)
  assert.match(prompt, /quote: "We propose block-sparse attention\."/)
  assert.match(prompt, /\[2\] \(result\) claim: It improves throughput by 2\.4x\./)
  assert.match(prompt, /litnotes-entailment/)
  assert.ok(prompt.length < 40000)

  // Empty / malformed input still yields a usable prompt.
  const empty = entailmentPrompt([])
  assert.match(empty, /no citations to verify/)
  assert.match(entailmentPrompt(null), /no citations to verify/)
  assert.match(entailmentPrompt([{ index: 0, quote: 'x' }, null, { quote: 'no index' }]), /no citations to verify/)

  // Very long quotes are bounded.
  const long = entailmentPrompt([{ index: 1, note: 'n', quote: 'x'.repeat(10000) }])
  assert.ok(long.length < 40000)
  assert.ok(!long.includes('x'.repeat(1600)), 'quote rendering is bounded')
})

test('parseEntailmentOutput parses the verdict fence tolerantly', () => {
  const tagged = parseEntailmentOutput(
    'Checking.\n\n```litnotes-entailment\n{"results":[{"index":1,"verdict":"supported","reason":"direct"},{"index":2,"verdict":"PARTIAL"},{"index":3,"verdict":"unsupported"}]}\n```\n',
  )
  assert.deepEqual(tagged, {
    results: [
      { index: 1, verdict: 'supported', reason: 'direct' },
      { index: 2, verdict: 'partial', reason: '' },
      { index: 3, verdict: 'unsupported', reason: '' },
    ],
  })

  // Case/space tolerant tag, bare json fence fallback and bare object fallback.
  assert.equal(parseEntailmentOutput('``` LitNotes-Entailment\n{"results":[]}\n```').results.length, 0)
  const fencedJson = parseEntailmentOutput('```json\n{"results":[{"index":"7","verdict":"supported","reason":"x"}]}\n```')
  assert.deepEqual(fencedJson.results, [{ index: 7, verdict: 'supported', reason: 'x' }])
  const bare = parseEntailmentOutput('verdicts: {"results":[{"index":1,"verdict":"partial"}]}')
  assert.deepEqual(bare.results, [{ index: 1, verdict: 'partial', reason: '' }])

  // Invalid model output fails open (null) so the caller can mark 'unchecked'.
  assert.equal(parseEntailmentOutput(''), null)
  assert.equal(parseEntailmentOutput(null), null)
  assert.equal(parseEntailmentOutput('no json here'), null)
  assert.equal(parseEntailmentOutput('```litnotes-entailment\n{not json}\n```'), null)
  assert.equal(parseEntailmentOutput('```litnotes-entailment\n{"citations":[]}\n```'), null)

  // Invalid entries are dropped; a valid-but-empty list is still "checked".
  const mixed = parseEntailmentOutput(
    '```litnotes-entailment\n{"results":[{"index":0,"verdict":"supported"},{"index":2,"verdict":"maybe"},"nope",{"index":3,"verdict":"unsupported","reason":"r"}]}\n```',
  )
  assert.deepEqual(mixed.results, [{ index: 3, verdict: 'unsupported', reason: 'r' }])
})
