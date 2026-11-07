/**
 * Pure-helper port of the frozen 1.0.0 client chat contract
 * (`test/client/chat-helpers.test.mjs` + `chat-nav.test.mjs`):
 * answer/fence splitting, inline citation marker scanning (including
 * code/escape exclusions), history normalization, citation entailment flags and
 * conversation export markdown.
 *
 * The helpers are the contract the store, the renderer and the export rely on;
 * rendering is covered by `ai-render.test.tsx`.
 */

import { describe, expect, it } from 'vitest'
import type { ChatEntry } from '../../src/client/ai/chat.ts'
import {
  aspectLegendItems,
  citationFlags,
  citationMarkers,
  exportMarkdown,
  navAwayFromLatest,
  navCurrentMark,
  navTargetScrollTop,
  normalizeMessages,
  parseAnswer,
  questionMarks,
  unverifiedBreakdown,
} from '../../src/client/ai/chat.ts'

/* ========================================================================== */
/* citationMarkers                                                           */
/* ========================================================================== */

describe('citation markers', () => {
  it('keeps plain text as one literal part', () => {
    expect(citationMarkers('No markers here.')).toEqual([
      { type: 'text', text: 'No markers here.', start: 0, end: 16 },
    ])
    expect(citationMarkers('')).toEqual([])
    expect(citationMarkers(null)).toEqual([])
  })

  it('splits literal text and [n] markers with offsets', () => {
    expect(citationMarkers('See [1] and [2].')).toEqual([
      { type: 'text', text: 'See ', start: 0, end: 4 },
      { type: 'citation', index: 1, text: '[1]', start: 4, end: 7 },
      { type: 'text', text: ' and ', start: 7, end: 12 },
      { type: 'citation', index: 2, text: '[2]', start: 12, end: 15 },
      { type: 'text', text: '.', start: 15, end: 16 },
    ])
  })

  it('treats adjacent and multi-digit markers as citations', () => {
    const parts = citationMarkers('[1][12][999]')
    expect(parts.map((part) => part.type)).toEqual(['citation', 'citation', 'citation'])
    expect(parts.map((part) => (part.type === 'citation' ? part.index : null))).toEqual([1, 12, 999])
  })

  it('keeps invalid marker shapes literal', () => {
    const text = '[0] [01] [1234] [a] [] [1](https://example.com) [2]: definition'
    expect(citationMarkers(text)).toEqual([{ type: 'text', text, start: 0, end: text.length }])
  })

  it('keeps escaped brackets literal', () => {
    const text = String.raw`A \[1] escaped, B [2] cited.`
    const parts = citationMarkers(text)
    expect(parts.map((part) => part.type)).toEqual(['text', 'citation', 'text'])
    expect(parts[1]?.type === 'citation' ? parts[1].index : null).toBe(2)
    expect(parts[0]?.text).toBe(String.raw`A \[1] escaped, B `)
  })

  it('skips inline code spans', () => {
    const parts = citationMarkers('Use `code [1]` and ``[2]`` but cite [3].')
    expect(parts.map((part) => (part.type === 'citation' ? part.index : part.text))).toEqual([
      'Use `code [1]` and ``[2]`` but cite ',
      3,
      '.',
    ])
  })

  it('skips fenced code blocks (backtick and tilde)', () => {
    const text = [
      'Before [1].',
      '',
      '```js',
      'const x = [2]',
      '```',
      '',
      '~~~',
      '[3]',
      '~~~',
      '',
      'After [4].',
    ].join('\n')
    const citations = citationMarkers(text)
      .filter((part) => part.type === 'citation')
      .map((part) => (part.type === 'citation' ? part.index : -1))
    expect(citations).toEqual([1, 4])
    const literal = citationMarkers(text)
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
    expect(literal).toContain('const x = [2]')
    expect(literal).toContain('[3]')
  })

  it('closes fenced blocks only with the same fence character', () => {
    const text = ['```', '[1]', '~~~', '[2]', '```', '[3]'].join('\n')
    const citations = citationMarkers(text)
      .filter((part) => part.type === 'citation')
      .map((part) => (part.type === 'citation' ? part.index : -1))
    expect(citations).toEqual([3])
  })

  it('preserves line breaks in literal parts and offsets', () => {
    const text = 'first [1]\nsecond line\n\n[2] third'
    const parts = citationMarkers(text)
    const literal = parts
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
    expect(literal).toBe('first \nsecond line\n\n third')
    for (const part of parts) expect(text.slice(part.start, part.end)).toBe(part.text)
  })
})

/* ========================================================================== */
/* parseAnswer                                                               */
/* ========================================================================== */

const ANSWER = 'Answer with [1] and **markdown**.'

describe('parse answer', () => {
  it('leaves markdown untouched without a fence', () => {
    expect(parseAnswer(ANSWER)).toEqual({ answer: ANSWER, data: null, hasFence: false })
    expect(parseAnswer(null)).toEqual({ answer: '', data: null, hasFence: false })
    expect(parseAnswer(undefined)).toEqual({ answer: '', data: null, hasFence: false })
  })

  it('strips and parses a trailing litnotes-json fence', () => {
    const text = `${ANSWER}\n\n\`\`\`litnotes-json\n${JSON.stringify(
      { citations: [{ index: 1, blockKey: 'b1:aa', quote: 'q' }], followups: ['why?'], knowledge: { nodes: [], edges: [] } },
      null,
      2,
    )}\n\`\`\`\n`
    const result = parseAnswer(text)
    expect(result.hasFence).toBe(true)
    expect(result.answer).toBe(ANSWER)
    const data = result.data as { citations?: Array<{ blockKey?: string }>; followups?: string[] } | null
    expect(data?.citations?.[0]?.blockKey).toBe('b1:aa')
    expect(data?.followups).toEqual(['why?'])
  })

  it('normalizes CRLF and fence info casing', () => {
    const text = `${ANSWER}\r\n\r\n\`\`\`LiTnOtEs-JsOn\r\n{"a":1}\r\n\`\`\`\r\n`
    expect(parseAnswer(text)).toEqual({ answer: ANSWER, data: { a: 1 }, hasFence: true })
  })

  it('accepts tilde fences', () => {
    const text = `${ANSWER}\n\n~~~litnotes-json\n{"x":"y"}\n~~~\n`
    expect(parseAnswer(text)).toEqual({ answer: ANSWER, data: { x: 'y' }, hasFence: true })
  })

  it('strips an unclosed trailing fence (stream safety)', () => {
    const text = `${ANSWER}\n\n\`\`\`litnotes-json\n{"citations":[`
    expect(parseAnswer(text)).toEqual({ answer: ANSWER, data: null, hasFence: true })
  })

  it('strips malformed JSON but yields no data', () => {
    const text = `${ANSWER}\n\n\`\`\`litnotes-json\nnot json at all\n\`\`\``
    expect(parseAnswer(text)).toEqual({ answer: ANSWER, data: null, hasFence: true })
  })

  it('recovers prose and trailing commas inside the fence', () => {
    const text = `${ANSWER}\n\n\`\`\`litnotes-json\nHere is the payload: {"citations":[{"index":1,}],}\n\`\`\``
    const result = parseAnswer(text)
    expect(result.hasFence).toBe(true)
    const data = result.data as { citations?: Array<{ index?: number }> } | null
    expect(data?.citations?.[0]?.index).toBe(1)
  })

  it('yields no data for a non-object payload', () => {
    const text = `${ANSWER}\n\n\`\`\`litnotes-json\n[1,2,3]\n\`\`\``
    expect(parseAnswer(text)).toEqual({ answer: ANSWER, data: null, hasFence: true })
  })

  it('keeps a fence with trailing text as ordinary markdown', () => {
    const text = `${ANSWER}\n\n\`\`\`litnotes-json\n{"a":1}\n\`\`\`\nnot trailing`
    const result = parseAnswer(text)
    expect(result.hasFence).toBe(false)
    expect(result.data).toBeNull()
    expect(result.answer).toContain('litnotes-json')
    expect(result.answer).toContain('not trailing')
  })

  it('preserves an earlier code fence', () => {
    const code = '```js\nconst answer = 42\n```'
    const text = `Intro.\n\n${code}\n\n${ANSWER}\n\n\`\`\`litnotes-json\n{"a":1}\n\`\`\``
    const result = parseAnswer(text)
    expect(result.hasFence).toBe(true)
    expect(result.answer).toContain(code)
    expect(result.answer.endsWith(ANSWER)).toBe(true)
  })

  it('treats a four-space indented fence as literal markdown', () => {
    const text = `${ANSWER}\n\n    \`\`\`litnotes-json\n    {"a":1}\n    \`\`\``
    const result = parseAnswer(text)
    expect(result.hasFence).toBe(false)
    expect(result.answer).toContain('litnotes-json')
  })

  it('yields no data for an empty fence body', () => {
    const text = `${ANSWER}\n\n\`\`\`litnotes-json\n\`\`\``
    expect(parseAnswer(text)).toEqual({ answer: ANSWER, data: null, hasFence: true })
  })
})

/* ========================================================================== */
/* normalizeMessages                                                         */
/* ========================================================================== */

const FENCED_ANSWER = `${ANSWER}\n\n\`\`\`litnotes-json\n${JSON.stringify({
  citations: [{ index: 1, blockKey: 'b1:aa', quote: 'fenced quote', aspect: 'method' }],
  followups: ['fenced follow-up'],
})}\n\`\`\``

describe('normalize messages', () => {
  it('accepts tolerant input wrappers', () => {
    expect(normalizeMessages(undefined)).toEqual([])
    expect(normalizeMessages(null)).toEqual([])
    expect(normalizeMessages('nope')).toEqual([])
    expect(normalizeMessages({ messages: 'nope' })).toEqual([])
    const raw = [{ id: 'u1', question: 'Q' }]
    expect(normalizeMessages(raw)).toHaveLength(1)
    expect(normalizeMessages({ messages: raw })).toHaveLength(1)
    expect(normalizeMessages({ items: raw })).toHaveLength(1)
    expect(normalizeMessages({ value: { messages: raw } })).toHaveLength(1)
  })

  it('normalizes roles, questions, ids and defaults', () => {
    const messages = normalizeMessages([
      null,
      'nope',
      { id: 'u1', question: 'Q1' },
      { id: 'u2', role: 'user', question: '   ' },
      { id: 'a1', role: 'assistant', question: 'Q1', answer: 'A1' },
      { role: 'assistant', answer: 'A2' },
      { role: 'assistant', answer: '' },
      { role: 'system', content: 'fallback question' },
    ])
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'user'])
    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1', 'history-5', 'history-6', 'history-7'])
    expect(messages[0]?.question).toBe('Q1')
    expect(messages[1]?.answer).toBe('A1')
    expect(messages[2]?.answer).toBe('A2')
    expect(messages[4]?.question).toBe('fallback question')
    for (const message of messages) {
      expect(message.createdAt).toBe('')
      expect(message.citations).toEqual([])
      expect(message.unverified).toEqual([])
      expect(message.followups).toEqual([])
      expect(message.annotationIds).toEqual([])
      expect(message.knowledge).toEqual({ nodeIds: [], edgeIds: [] })
      expect(message.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
      expect(message.model).toBeNull()
    }
  })

  it('normalizes citations, unverified citations and metadata', () => {
    const messages = normalizeMessages({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          question: 'Q',
          answer: 'A [1] [2].',
          citations: [
            { index: '2', blockKey: ' b1:aa ', quote: 'q', page: '3', aspect: 'result', start: '4', end: '8', note: 'n', verified: true },
            { index: 0, blockKey: 'b2:bb', quote: 'q2' },
            { index: 'bad', quote: '' },
            'nope',
          ],
          unverified: [{ index: 1, blockKey: 'b3:cc', quote: 'uq', verified: true }],
          followups: [' f1 ', '', 4, 'f2'],
          annotationIds: ['ann1', '', 3],
          knowledge: { nodeIds: ['n1', 2], edgeIds: ['e1'] },
          usage: { inputTokens: '12', outputTokens: 3 },
          model: { provider: 'deepseek', model: 'flash' },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    expect(messages).toHaveLength(1)
    const message = messages[0]
    expect(message?.citations).toEqual([
      {
        index: 2,
        blockKey: 'b1:aa',
        quote: 'q',
        start: 4,
        end: 8,
        page: 3,
        aspect: 'result',
        note: 'n',
        verified: true,
        entailment: '',
        entailmentReason: '',
        reason: '',
      },
      {
        index: 2,
        blockKey: 'b2:bb',
        quote: 'q2',
        start: null,
        end: null,
        page: null,
        aspect: 'context',
        note: '',
        verified: true,
        entailment: '',
        entailmentReason: '',
        reason: '',
      },
    ])
    expect(message?.unverified).toEqual([
      {
        index: 1,
        blockKey: 'b3:cc',
        quote: 'uq',
        start: null,
        end: null,
        page: null,
        aspect: 'context',
        note: '',
        verified: false,
        entailment: '',
        entailmentReason: '',
        reason: '',
      },
    ])
    expect(message?.followups).toEqual(['f1', 'f2'])
    expect(message?.annotationIds).toEqual(['ann1'])
    expect(message?.knowledge).toEqual({ nodeIds: ['n1'], edgeIds: ['e1'] })
    expect(message?.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
    expect(message?.model).toEqual({ provider: 'deepseek', model: 'flash' })
    expect(message?.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('strips a trailing litnotes-json fence and uses it only when fields are missing', () => {
    const messages = normalizeMessages([
      { id: 'a1', role: 'assistant', question: 'Q', answer: FENCED_ANSWER },
      { id: 'a2', role: 'assistant', question: 'Q', answer: FENCED_ANSWER, citations: [] },
    ])
    expect(messages[0]?.answer).toBe(ANSWER)
    expect(messages[0]?.citations[0]?.blockKey).toBe('b1:aa')
    expect(messages[0]?.citations[0]?.aspect).toBe('method')
    expect(messages[0]?.followups).toEqual(['fenced follow-up'])
    expect(messages[1]?.citations).toEqual([])
    expect(messages[1]?.followups).toEqual(['fenced follow-up'])
    expect(messages[1]?.answer).toBe(ANSWER)
  })

  it('makes duplicate ids unique and never mutates the input', () => {
    const raw = {
      messages: [
        { id: 'same', role: 'user', question: 'Q1' },
        { id: 'same', role: 'assistant', question: 'Q1', answer: 'A' },
      ],
    }
    const snapshot = JSON.stringify(raw)
    const messages = normalizeMessages(raw)
    expect(messages[0]?.id).not.toBe(messages[1]?.id)
    expect(JSON.stringify(raw)).toBe(snapshot)
  })

  it('preserves citation entailment fields', () => {
    const messages = normalizeMessages([
      {
        id: 'a1',
        role: 'assistant',
        question: 'Q',
        answer: 'A [1] [2].',
        citations: [
          { index: 1, blockKey: 'b1:aa', quote: 'q1', entailment: 'partial', entailmentReason: 'quote hedges the claim' },
          { index: 2, blockKey: 'b2:bb', quote: 'q2', entailment: 'supported' },
          { index: 3, blockKey: 'b3:cc', quote: 'q3', entailment: 'bogus' },
        ],
        unverified: [
          { index: 2, blockKey: 'b2:bb', quote: 'q2', reason: 'entailment-unsupported', entailment: 'unsupported', entailmentReason: 'claim too strong' },
          { index: 4, blockKey: 'b4:dd', quote: 'q4', reason: 'quote-not-found' },
        ],
      },
    ])
    const message = messages[0]
    expect(message?.citations[0]?.entailment).toBe('partial')
    expect(message?.citations[0]?.entailmentReason).toBe('quote hedges the claim')
    expect(message?.citations[1]?.entailment).toBe('supported')
    expect(message?.citations[1]?.entailmentReason).toBe('')
    expect(message?.citations[2]?.entailment).toBe('')
    expect(message?.unverified[0]?.reason).toBe('entailment-unsupported')
    expect(message?.unverified[0]?.entailment).toBe('unsupported')
    expect(message?.unverified[0]?.entailmentReason).toBe('claim too strong')
    expect(message?.unverified[1]?.reason).toBe('quote-not-found')
    expect(message?.unverified[1]?.entailment).toBe('')
  })
})

/* ========================================================================== */
/* Entailment flags                                                          */
/* ========================================================================== */

describe('citation flags', () => {
  it('flags partial and entailment-unsupported verdicts', () => {
    expect(citationFlags({ entailment: 'partial' } as never, true)).toEqual({ partial: true, unsupported: false })
    expect(citationFlags({ entailment: 'supported' } as never, true)).toEqual({ partial: false, unsupported: false })
    expect(citationFlags({ entailment: 'unchecked' } as never, true)).toEqual({ partial: false, unsupported: false })
    expect(citationFlags(null, false)).toEqual({ partial: false, unsupported: false })
    expect(citationFlags({ entailment: 'unsupported', reason: 'entailment-unsupported' } as never, false)).toEqual({
      partial: false,
      unsupported: true,
    })
    expect(citationFlags({ reason: 'entailment-unsupported' } as never, false)).toEqual({ partial: false, unsupported: true })
    expect(citationFlags({ entailment: 'unsupported' } as never, false)).toEqual({ partial: false, unsupported: true })
    expect(citationFlags({ reason: 'quote-missing' } as never, false)).toEqual({ partial: false, unsupported: false })
    expect(citationFlags({ reason: 'entailment-unsupported' } as never, true)).toEqual({
      partial: false,
      unsupported: false,
    })
  })

  it('splits unverified citations into entailment rejections and other reasons', () => {
    expect(unverifiedBreakdown(null)).toEqual({ unsupported: 0, generic: 0, total: 0 })
    expect(unverifiedBreakdown([])).toEqual({ unsupported: 0, generic: 0, total: 0 })
    expect(
      unverifiedBreakdown([
        { reason: 'entailment-unsupported', entailment: 'unsupported' },
        { reason: 'quote-missing' },
        { entailment: 'unsupported' },
      ] as never),
    ).toEqual({ unsupported: 2, generic: 1, total: 3 })
  })
})

/* ========================================================================== */
/* exportMarkdown                                                            */
/* ========================================================================== */

const EXPORT_ZH: Record<string, string> = {
  'ai.exportTitle': 'AI 对话',
  'ai.exportModel': '模型',
  'ai.exportTime': '导出时间',
  'ai.exportQuestion': '问题 {index}',
  'ai.exportAnswer': '回答 {index}',
  'ai.exportCitation': '引用',
  'ai.exportUnverified': '未通过校验',
  'aspect.definition': '定义',
  'aspect.context': '背景',
  'aspect.method': '方法',
  'aspect.result': '结果',
  'aspect.limitation': '局限',
}

const EXPORT_EN: Record<string, string> = {
  'ai.exportTitle': 'AI conversation',
  'ai.exportModel': 'Model',
  'ai.exportTime': 'Exported',
  'ai.exportQuestion': 'Question {index}',
  'ai.exportAnswer': 'Answer {index}',
  'ai.exportCitation': 'Citation',
  'ai.exportUnverified': 'Unverified',
  'aspect.definition': 'Definition',
  'aspect.context': 'Context',
  'aspect.method': 'Method',
  'aspect.result': 'Result',
  'aspect.limitation': 'Limitation',
}

/** Translate fake over one dictionary with `{param}` interpolation. */
function fakeT(dictionary: Record<string, string>): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template = typeof dictionary[key] === 'string' ? (dictionary[key] as string) : key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}

const EXPORTED_AT = new Date(2026, 10, 7, 11, 35).toISOString()

const EXPORT_MESSAGES = [
  { id: 'u1', role: 'user', question: '方法是什么？' },
  {
    id: 'a1',
    role: 'assistant',
    question: '方法是什么？',
    answer: '注意力机制 [1]。',
    citations: [
      {
        index: 1,
        blockKey: 'b1:aa',
        quote: 'Scaled dot-product attention',
        page: 3,
        aspect: 'method',
        note: '提出缩放点积注意力',
        verified: true,
      },
    ],
    unverified: [
      {
        index: 2,
        blockKey: 'b2:bb',
        quote: 'a bad quote',
        page: 5,
        aspect: 'result',
        note: '不支持的论点',
        verified: false,
        reason: 'no-match',
      },
    ],
  },
]

describe('export markdown', () => {
  it('formats zh with model/time front matter and citation lines', () => {
    const result = exportMarkdown(EXPORT_MESSAGES, {
      title: '论文标题',
      modelLabel: 'deepseek-flash',
      exportedAt: EXPORTED_AT,
      t: fakeT(EXPORT_ZH),
    })
    expect(result).toEqual({
      filename: '论文标题.md',
      markdown: [
        '# 论文标题 — AI 对话',
        '',
        '- 模型: deepseek-flash',
        '- 导出时间: 2026-11-07 11:35',
        '',
        '## 问题 1',
        '方法是什么？',
        '',
        '## 回答 1',
        '注意力机制 [1]。',
        '',
        '### 引用',
        '- [1] · p.3 · 方法 · Scaled dot-product attention · 提出缩放点积注意力',
        '- [2] · p.5 · 结果 · a bad quote · 不支持的论点 · 未通过校验',
        '',
      ].join('\n'),
    })
  })

  it('localizes only the framing copy in en', () => {
    const result = exportMarkdown(EXPORT_MESSAGES, {
      title: 'Paper title',
      modelLabel: 'deepseek-flash',
      exportedAt: EXPORTED_AT,
      t: fakeT(EXPORT_EN),
    })
    expect(result).toEqual({
      filename: 'Paper title.md',
      markdown: [
        '# Paper title — AI conversation',
        '',
        '- Model: deepseek-flash',
        '- Exported: 2026-11-07 11:35',
        '',
        '## Question 1',
        '方法是什么？',
        '',
        '## Answer 1',
        '注意力机制 [1]。',
        '',
        '### Citation',
        '- [1] · p.3 · Method · Scaled dot-product attention · 提出缩放点积注意力',
        '- [2] · p.5 · Result · a bad quote · 不支持的论点 · Unverified',
        '',
      ].join('\n'),
    })
  })

  it('returns null for empty or unusable conversations', () => {
    const t = fakeT(EXPORT_ZH)
    expect(exportMarkdown([], { t })).toBeNull()
    expect(exportMarkdown(null, { t })).toBeNull()
    expect(exportMarkdown(undefined, { t })).toBeNull()
    expect(exportMarkdown({ messages: [] }, { t })).toBeNull()
    expect(exportMarkdown([null, 'nope', { role: 'user', question: '   ' }], { t })).toBeNull()
    expect(exportMarkdown([], null)).toBeNull()
  })

  it('numbers turns and degrades missing metadata cleanly', () => {
    const result = exportMarkdown(
      [
        { id: 'u1', role: 'user', question: 'Q1' },
        { id: 'a1', role: 'assistant', question: 'Q1', answer: 'A1' },
        { id: 'u2', role: 'user', question: 'Q2' },
        { id: 'a2', role: 'assistant', question: 'Q2', answer: 'A2 [1]', citations: [{ index: 1, blockKey: 'b1:aa', quote: 'q' }] },
      ],
      { exportedAt: EXPORTED_AT, t: fakeT(EXPORT_ZH) },
    )
    expect(result?.filename).toBe('ai-conversation.md')
    expect(result?.markdown).toMatch(/^# AI 对话\n\n- 导出时间: 2026-11-07 11:35\n\n/u)
    expect(result?.markdown).toContain('## 问题 1\nQ1\n\n## 回答 1\nA1')
    expect(result?.markdown).toContain('## 问题 2\nQ2\n\n## 回答 2\nA2 [1]')
    expect(result?.markdown).toContain('### 引用\n- [1] · 背景 · q')
  })

  it('normalizes raw history payloads and fenced answers', () => {
    const fenced =
      'Answer [1].\n\n```litnotes-json\n' +
      JSON.stringify({ citations: [{ index: 1, blockKey: 'b1:aa', quote: 'quoted', page: 2, aspect: 'method' }] }) +
      '\n```'
    const result = exportMarkdown(
      {
        messages: [
          { id: 'u1', role: 'user', question: 'Q' },
          { id: 'a1', role: 'assistant', question: 'Q', answer: fenced },
        ],
      },
      { title: 'T', exportedAt: EXPORTED_AT, t: fakeT(EXPORT_ZH) },
    )
    expect(result?.markdown).toContain('## 回答 1\nAnswer [1].\n')
    expect(result?.markdown).toContain('- [1] · p.2 · 方法 · quoted')
    expect(result?.markdown).not.toContain('litnotes-json')
  })

  it('sanitizes the download filename', () => {
    const t = fakeT(EXPORT_ZH)
    const messages = [{ id: 'u1', role: 'user', question: 'Q' }]
    const filename = (title: string): string | undefined => exportMarkdown(messages, { title, exportedAt: EXPORTED_AT, t })?.filename
    expect(filename('Attention/Is: All*You? Need')).toBe('Attention Is All You Need.md')
    expect(filename('a\nb\tc')).toBe('a b c.md')
    expect(filename('   ')).toBe('ai-conversation.md')
    expect(filename('...')).toBe('ai-conversation.md')
    expect(filename('A'.repeat(120))).toBe(`${'A'.repeat(80)}.md`)
  })
})

/* ========================================================================== */
/* Question navigator helpers                                                */
/* ========================================================================== */

/** Build the tiny message shape the navigator needs (frozen test parity). */
function navMessages(items: Array<{ id: string; role: 'user' | 'assistant'; question: string; answer?: string }>): ChatEntry[] {
  return items as unknown as ChatEntry[]
}

describe('question navigator', () => {
  it('builds one mark per user message with ordinal and question text', () => {
    const marks = questionMarks(
      navMessages([
        { id: 'm1', role: 'user', question: 'What is the method?' },
        { id: 'm2', role: 'assistant', question: 'What is the method?', answer: 'It is…' },
        { id: 'm3', role: 'user', question: 'What are the limits?' },
        { id: 'm4', role: 'assistant', question: 'What are the limits?', answer: 'It…' },
        { id: 'm5', role: 'user', question: '   ' },
        { id: '', role: 'user', question: 'no id' },
      ]),
    )
    expect(marks.map((mark) => mark.messageId)).toEqual(['m1', 'm3', 'm5'])
    expect(marks.map((mark) => mark.ordinal)).toEqual([1, 2, 3])
    expect(marks[0]?.question).toBe('What is the method?')
    expect(questionMarks(null)).toEqual([])
    expect(questionMarks([])).toEqual([])
  })

  it('resolves the current mark as the last question at or above the anchor line', () => {
    const marks = questionMarks(
      navMessages([
        { id: 'u1', role: 'user', question: 'Q1' },
        { id: 'a1', role: 'assistant', question: 'Q1', answer: 'A1' },
        { id: 'u2', role: 'user', question: 'Q2' },
        { id: 'a2', role: 'assistant', question: 'Q2', answer: 'A2' },
        { id: 'u3', role: 'user', question: 'Q3' },
      ]),
    )
    const offsets = [
      { messageId: 'u1', top: 0 },
      { messageId: 'a1', top: 120 },
      { messageId: 'u2', top: 400 },
      { messageId: 'a2', top: 520 },
      { messageId: 'u3', top: 900 },
    ]
    expect(navCurrentMark(marks, offsets, 300)).toBe(0)
    expect(navCurrentMark(marks, offsets, 420)).toBe(1)
    expect(navCurrentMark(marks, offsets, 999)).toBe(2)
    expect(navCurrentMark(marks, offsets, -10)).toBe(-1)
    expect(navCurrentMark(marks, [], 100)).toBe(-1)
    expect(navCurrentMark([], offsets, 100)).toBe(-1)
    expect(navCurrentMark(marks, offsets, Number.NaN)).toBe(-1)
  })

  it('reports away-from-latest only past the threshold', () => {
    expect(navAwayFromLatest(0, 1000, 400)).toBe(true)
    expect(navAwayFromLatest(600, 1000, 400)).toBe(false)
    expect(navAwayFromLatest(450, 1000, 400, 120)).toBe(true)
    expect(navAwayFromLatest(470, 1000, 400, 120)).toBe(true)
    expect(navAwayFromLatest(480, 1000, 400, 120)).toBe(false)
    expect(navAwayFromLatest(Number.NaN, 1000, 400)).toBe(false)
  })

  it('computes the target scrollTop with padding', () => {
    expect(navTargetScrollTop(100, 500, 100)).toBe(488)
    expect(navTargetScrollTop(0, 0, 0, 12)).toBe(0)
    expect(navTargetScrollTop(50, 100, 300)).toBe(0)
    expect(navTargetScrollTop(Number.NaN, 50, 0)).toBe(38)
  })

  it('resolves aspect legend items through the reader aspect keys', () => {
    const untranslated = aspectLegendItems(null)
    expect(untranslated.map((item) => item.aspect)).toEqual(['definition', 'context', 'method', 'result', 'limitation'])
    expect(untranslated.map((item) => item.label)).toEqual([
      'aspect.definition',
      'aspect.context',
      'aspect.method',
      'aspect.result',
      'aspect.limitation',
    ])
    const dictionary: Record<string, string> = {
      'aspect.definition': '定义',
      'aspect.context': '背景',
      'aspect.method': '方法',
      'aspect.result': '结果',
      'aspect.limitation': '局限',
    }
    const items = aspectLegendItems((key: string) => dictionary[key] ?? key)
    expect(items.map((item) => item.label)).toEqual(['定义', '背景', '方法', '结果', '局限'])
  })
})
