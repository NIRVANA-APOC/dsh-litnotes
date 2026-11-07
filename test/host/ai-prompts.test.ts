/**
 * Unit tests for the centralized prompt text (`src/host/ai/prompts.ts`): the
 * `litnotes-json` contract, context-block format, history/focus rendering and
 * the graph/summary/libraries prompt builders used by the other engines.
 */

import { describe, expect, test } from 'vitest'
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
} from '../../src/host/ai/prompts.ts'

test('prompt version and fence tags are the documented contract', () => {
  expect(PROMPT_VERSION).toBe(2)
  expect(ANSWER_FENCE_TAG).toBe('litnotes-json')
  expect(GRAPH_FENCE_TAG).toBe('litnotes-graph')
  expect(SUMMARY_FENCE_TAG).toBe('litnotes-summary')
  expect(ENTAILMENT_FENCE_TAG).toBe('litnotes-entailment')
  expect(ANSWER_FENCE_OPEN).toBe('```litnotes-json')
  expect(ENTAILMENT_FENCE_OPEN).toBe('```litnotes-entailment')
  expect([...ENTAILMENT_VERDICTS]).toEqual(['supported', 'partial', 'unsupported'])
})

describe('CHAT_SYSTEM', () => {
  test('teaches grounding, citations, aspects and the JSON fence', () => {
    expect(CHAT_SYSTEM).toMatch(/Answer ONLY from the context blocks/)
    expect(CHAT_SYSTEM).toMatch(/verbatim/i)
    expect(CHAT_SYSTEM).toMatch(/\[1\]/)
    expect(CHAT_SYSTEM).toMatch(/```litnotes-json/)
    for (const aspect of ['definition', 'method', 'result', 'limitation', 'context']) {
      expect(CHAT_SYSTEM.includes(`"${aspect}"`), `expected aspect ${aspect} in CHAT_SYSTEM`).toBe(true)
    }
    expect(CHAT_SYSTEM).toMatch(/language of the reader's question/)
    expect(CHAT_SYSTEM).toMatch(/do not guess|Do not guess/)
  })
})

describe('context rendering', () => {
  test('formatContextBlock renders [[key]] (page N) text', () => {
    expect(formatContextBlock({ key: 'b12:ab12cd34', page: 3, text: 'Sparse attention.' })).toBe(
      '[[b12:ab12cd34]] (page 3) Sparse attention.',
    )
    expect(formatContextBlock({ key: 'b1:0000abcd', page: null, text: 'No page.' })).toBe(
      '[[b1:0000abcd]] (page unknown) No page.',
    )
    expect(formatContextBlock({})).toBe('[[]] (page unknown) ')
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
    expect(prompt).toMatch(/^Paper: Sparse Attention for Long Documents/m)
    expect(prompt).toMatch(/Document outline/)
    expect(prompt).toMatch(/- Sparse Attention for Long Documents/)
    expect(prompt).toMatch(/- 2 Method/)
    expect(prompt).toMatch(/Conversation so far/)
    expect(prompt).toMatch(/Reader: What does the paper study\?/)
    expect(prompt).toMatch(/Assistant: Efficient attention\./)
    expect(prompt).toMatch(/\[\[b0:11111111\]\] \(page 1\) Sparse Attention for Long Documents/)
    expect(prompt).toMatch(/\[\[b4:22222222\]\] \(page 2\) We propose block-sparse attention/)
    expect(prompt).toMatch(/Reader focus/)
    expect(prompt).toMatch(/learned routing/)
    expect(prompt).toMatch(/Question:\nWhat is the method\?/)
    expect(prompt).toMatch(/litnotes-json/)
    expect(prompt.length).toBeLessThan(60000)
  })

  test('chatUserPrompt handles empty context and empty history', () => {
    const prompt = chatUserPrompt({ blocks: [], outline: [] }, 'Why?', [])
    expect(prompt).toMatch(/no context blocks were retrieved/)
    expect(prompt).toMatch(/Question:\nWhy\?/)
    expect(prompt).not.toMatch(/Conversation so far/)
  })
})

describe('graph and library prompts', () => {
  test('expose the graph/summary fences and bounded builders', () => {
    expect(GRAPH_EXTRACTION_SYSTEM).toMatch(/```litnotes-graph/)
    for (const type of ['concept', 'method', 'finding', 'definition', 'limitation', 'section']) {
      expect(GRAPH_EXTRACTION_SYSTEM.includes(type), `expected node type ${type}`).toBe(true)
    }
    expect(GRAPH_SUMMARY_PROMPT).toMatch(/```litnotes-summary/)
    expect(GRAPH_SUMMARY_PROMPT).toMatch(/overview/)
    expect(GRAPH_SUMMARY_PROMPT).toMatch(/tldr/)
    expect(GRAPH_SUMMARY_PROMPT).toMatch(/glossary/)
    expect(LIBRARY_CONSOLIDATION_PROMPT).toMatch(/Markdown overview/)
    expect(LIBRARY_CONSOLIDATION_PROMPT).toMatch(/Never invent papers/)

    const fromString = graphExtractionPrompt('We propose sparse attention.', {
      title: 'Paper',
      section: '2 Method',
      index: 2,
      total: 4,
    })
    expect(fromString).toMatch(/Paper: Paper/)
    expect(fromString).toMatch(/Section: 2 Method/)
    expect(fromString).toMatch(/Chunk: 2 of 4/)
    expect(fromString).toMatch(/We propose sparse attention\./)
    expect(fromString).toMatch(/litnotes-graph/)

    const fromBlocks = graphExtractionPrompt(
      { blocks: [{ key: 'b3:abcd1234', text: 'Routing selects blocks.' }] },
      { documentTitle: 'Paper' },
    )
    expect(fromBlocks).toMatch(/\[\[b3:abcd1234\]\] Routing selects blocks\./)

    const fromLines = graphExtractionPrompt({ lines: ['[[b3:abcd1234]] Routing selects blocks.'] }, { title: 'Paper' })
    expect(fromLines).toMatch(/\[\[b3:abcd1234\]\] Routing selects blocks\./)

    const summary = graphSummaryUserPrompt({
      title: 'Paper',
      outline: [{ level: 1, text: 'Introduction' }],
      nodes: [{ type: 'method', label: 'sparse attention', summary: 'Sparse attention.', blockKeys: ['b3:abcd1234'] }],
    })
    expect(summary).toMatch(/Section headings/)
    expect(summary).toMatch(/\[method\] sparse attention/)
    expect(summary).toMatch(/litnotes-summary/)

    const library = libraryConsolidationUserPrompt({
      overview: 'A library about attention.',
      papers: [{ title: 'Paper A', year: 2024 }],
      topics: [{ label: 'attention', weight: 3, documentIds: ['d1', 'd2'] }],
    })
    expect(library).toMatch(/Papers:/)
    expect(library).toMatch(/- Paper A \(2024\)/)
    expect(library).toMatch(/- attention — 3 — 2 paper\(s\)/)
  })
})

describe('ENTAILMENT_SYSTEM', () => {
  test('teaches the verdict vocabulary and fence contract', () => {
    expect(ENTAILMENT_SYSTEM).toMatch(/```litnotes-entailment/)
    for (const verdict of ['supported', 'partial', 'unsupported']) {
      expect(ENTAILMENT_SYSTEM.includes(`"${verdict}"`), `expected verdict ${verdict}`).toBe(true)
    }
    expect(ENTAILMENT_SYSTEM).toMatch(/untrusted DATA/i)
    expect(ENTAILMENT_SYSTEM).toMatch(/Judge only the supplied quote/)
    expect(ENTAILMENT_SYSTEM).toMatch(/No text outside the/)
  })
})

describe('entailmentPrompt', () => {
  test('renders numbered claims with their quoted evidence', () => {
    const prompt = entailmentPrompt([
      { index: 1, aspect: 'method', note: 'The method is block-sparse attention.', quote: 'We propose block-sparse attention.' },
      { index: 2, aspect: 'result', note: 'It improves throughput by 2.4x.', quote: 'improves throughput by 2.4x with equal accuracy' },
    ])
    expect(prompt).toMatch(/\[1\] \(method\) claim: The method is block-sparse attention\./)
    expect(prompt).toMatch(/quote: "We propose block-sparse attention\."/)
    expect(prompt).toMatch(/\[2\] \(result\) claim: It improves throughput by 2\.4x\./)
    expect(prompt).toMatch(/litnotes-entailment/)
    expect(prompt.length).toBeLessThan(40000)

    // Empty / malformed input still yields a usable prompt.
    const empty = entailmentPrompt([])
    expect(empty).toMatch(/no citations to verify/)
    expect(entailmentPrompt(null)).toMatch(/no citations to verify/)
    expect(entailmentPrompt([{ index: 0, quote: 'x' }, null, { quote: 'no index' }])).toMatch(/no citations to verify/)

    // Very long quotes are bounded.
    const long = entailmentPrompt([{ index: 1, note: 'n', quote: 'x'.repeat(10000) }])
    expect(long.length).toBeLessThan(40000)
    expect(long.includes('x'.repeat(1600))).toBe(false)
  })
})

describe('parseEntailmentOutput', () => {
  test('parses the verdict fence tolerantly', () => {
    const tagged = parseEntailmentOutput(
      'Checking.\n\n```litnotes-entailment\n{"results":[{"index":1,"verdict":"supported","reason":"direct"},{"index":2,"verdict":"PARTIAL"},{"index":3,"verdict":"unsupported"}]}\n```\n',
    )
    expect(tagged).toEqual({
      results: [
        { index: 1, verdict: 'supported', reason: 'direct' },
        { index: 2, verdict: 'partial', reason: '' },
        { index: 3, verdict: 'unsupported', reason: '' },
      ],
    })

    // Case/space tolerant tag, bare json fence fallback and bare object fallback.
    expect(parseEntailmentOutput('``` LitNotes-Entailment\n{"results":[]}\n```')?.results.length).toBe(0)
    const fencedJson = parseEntailmentOutput('```json\n{"results":[{"index":"7","verdict":"supported","reason":"x"}]}\n```')
    expect(fencedJson?.results).toEqual([{ index: 7, verdict: 'supported', reason: 'x' }])
    const bare = parseEntailmentOutput('verdicts: {"results":[{"index":1,"verdict":"partial"}]}')
    expect(bare?.results).toEqual([{ index: 1, verdict: 'partial', reason: '' }])

    // Invalid model output fails open (null) so the caller can mark 'unchecked'.
    expect(parseEntailmentOutput('')).toBeNull()
    expect(parseEntailmentOutput(null)).toBeNull()
    expect(parseEntailmentOutput('no json here')).toBeNull()
    expect(parseEntailmentOutput('```litnotes-entailment\n{not json}\n```')).toBeNull()
    expect(parseEntailmentOutput('```litnotes-entailment\n{"citations":[]}\n```')).toBeNull()

    // Invalid entries are dropped; a valid-but-empty list is still "checked".
    const mixed = parseEntailmentOutput(
      '```litnotes-entailment\n{"results":[{"index":0,"verdict":"supported"},{"index":2,"verdict":"maybe"},"nope",{"index":3,"verdict":"unsupported","reason":"r"}]}\n```',
    )
    expect(mixed?.results).toEqual([{ index: 3, verdict: 'unsupported', reason: 'r' }])
  })
})
