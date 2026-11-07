/**
 * Pure-helper tests for ui/chat.js: answer/fence splitting, inline citation
 * marker scanning (including code/escape exclusions), history normalization,
 * citation entailment flags and conversation export markdown.
 * The component itself is not rendered here; the exported helpers are the
 * contract the rest of the client relies on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mruAiCitationFlags,
  mruAiCitationMarkers,
  mruAiExportMarkdown,
  mruAiNormalizeMessages,
  mruAiParseAnswer,
  mruAiUnverifiedBreakdown,
} from '../../ui/chat.js'

/* ========================================================================== */
/* mruAiCitationMarkers                                                       */
/* ========================================================================== */

test('citation markers: plain text stays one literal part', () => {
  const parts = mruAiCitationMarkers('No markers here.')
  assert.deepEqual(parts, [{ type: 'text', text: 'No markers here.', start: 0, end: 16 }])
  assert.deepEqual(mruAiCitationMarkers(''), [])
  assert.deepEqual(mruAiCitationMarkers(null), [])
})

test('citation markers: splits literal text and [n] markers with offsets', () => {
  const parts = mruAiCitationMarkers('See [1] and [2].')
  assert.deepEqual(parts, [
    { type: 'text', text: 'See ', start: 0, end: 4 },
    { type: 'citation', index: 1, text: '[1]', start: 4, end: 7 },
    { type: 'text', text: ' and ', start: 7, end: 12 },
    { type: 'citation', index: 2, text: '[2]', start: 12, end: 15 },
    { type: 'text', text: '.', start: 15, end: 16 },
  ])
})

test('citation markers: adjacent and multi-digit markers are citations', () => {
  const parts = mruAiCitationMarkers('[1][12][999]')
  assert.deepEqual(parts.map((part) => part.type), ['citation', 'citation', 'citation'])
  assert.deepEqual(parts.map((part) => part.index), [1, 12, 999])
})

test('citation markers: invalid shapes stay literal', () => {
  const text = '[0] [01] [1234] [a] [] [1](https://example.com) [2]: definition'
  const parts = mruAiCitationMarkers(text)
  assert.deepEqual(parts, [{ type: 'text', text, start: 0, end: text.length }])
})

test('citation markers: escaped brackets are literal', () => {
  const text = String.raw`A \[1] escaped, B [2] cited.`
  const parts = mruAiCitationMarkers(text)
  assert.deepEqual(parts.map((part) => part.type), ['text', 'citation', 'text'])
  assert.equal(parts[1].index, 2)
  assert.equal(parts[0].text, String.raw`A \[1] escaped, B `)
})

test('citation markers: inline code spans are skipped', () => {
  const text = 'Use `code [1]` and ``[2]`` but cite [3].'
  const parts = mruAiCitationMarkers(text)
  assert.deepEqual(parts.map((part) => (part.type === 'citation' ? part.index : part.text)), [
    'Use `code [1]` and ``[2]`` but cite ',
    3,
    '.',
  ])
})

test('citation markers: fenced code blocks are skipped (backtick and tilde)', () => {
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
  const parts = mruAiCitationMarkers(text)
  const citations = parts.filter((part) => part.type === 'citation').map((part) => part.index)
  assert.deepEqual(citations, [1, 4])
  const literal = parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
  assert.match(literal, /const x = \[2\]/)
  assert.match(literal, /\[3\]/)
})

test('citation markers: fenced blocks close only with the same fence character', () => {
  const text = ['```', '[1]', '~~~', '[2]', '```', '[3]'].join('\n')
  const citations = mruAiCitationMarkers(text)
    .filter((part) => part.type === 'citation')
    .map((part) => part.index)
  assert.deepEqual(citations, [3])
})

test('citation markers: line breaks are preserved in literal parts', () => {
  const text = 'first [1]\nsecond line\n\n[2] third'
  const parts = mruAiCitationMarkers(text)
  const literal = parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
  assert.equal(literal, 'first \nsecond line\n\n third')
  // Offsets still point into the original string.
  for (const part of parts) {
    assert.equal(text.slice(part.start, part.end), part.text)
  }
})

/* ========================================================================== */
/* mruAiParseAnswer                                                           */
/* ========================================================================== */

const ANSWER = 'Answer with [1] and **markdown**.'

test('parse answer: no fence leaves markdown untouched', () => {
  assert.deepEqual(mruAiParseAnswer(ANSWER), {
    answer: ANSWER,
    data: null,
    hasFence: false,
  })
  assert.deepEqual(mruAiParseAnswer(null), { answer: '', data: null, hasFence: false })
  assert.deepEqual(mruAiParseAnswer(undefined), { answer: '', data: null, hasFence: false })
})

test('parse answer: trailing litnotes-json fence is stripped and parsed', () => {
  const text = `${ANSWER}\n\n\`\`\`litnotes-json\n${JSON.stringify({
    citations: [{ index: 1, blockKey: 'b1:aa', quote: 'q' }],
    followups: ['why?'],
    knowledge: { nodes: [], edges: [] },
  }, null, 2)}\n\`\`\`\n`
  const result = mruAiParseAnswer(text)
  assert.equal(result.hasFence, true)
  assert.equal(result.answer, ANSWER)
  assert.equal(result.data.citations[0].blockKey, 'b1:aa')
  assert.deepEqual(result.data.followups, ['why?'])
})

test('parse answer: CRLF and fence info casing are normalized', () => {
  const text = `${ANSWER}\r\n\r\n\`\`\`LiTnOtEs-JsOn\r\n{"a":1}\r\n\`\`\`\r\n`
  const result = mruAiParseAnswer(text)
  assert.deepEqual(result, { answer: ANSWER, data: { a: 1 }, hasFence: true })
})

test('parse answer: tilde fences work', () => {
  const text = `${ANSWER}\n\n~~~litnotes-json\n{"x":"y"}\n~~~\n`
  const result = mruAiParseAnswer(text)
  assert.deepEqual(result, { answer: ANSWER, data: { x: 'y' }, hasFence: true })
})

test('parse answer: an unclosed trailing fence is stripped (stream safety)', () => {
  const text = `${ANSWER}\n\n\`\`\`litnotes-json\n{"citations":[`
  const result = mruAiParseAnswer(text)
  assert.deepEqual(result, { answer: ANSWER, data: null, hasFence: true })
})

test('parse answer: malformed JSON is stripped but yields no data', () => {
  const text = `${ANSWER}\n\n\`\`\`litnotes-json\nnot json at all\n\`\`\``
  const result = mruAiParseAnswer(text)
  assert.deepEqual(result, { answer: ANSWER, data: null, hasFence: true })
})

test('parse answer: prose and trailing commas inside the fence are recovered', () => {
  const text = `${ANSWER}\n\n\`\`\`litnotes-json\nHere is the payload: {"citations":[{"index":1,}],}\n\`\`\``
  const result = mruAiParseAnswer(text)
  assert.equal(result.hasFence, true)
  assert.equal(result.data.citations[0].index, 1)
})

test('parse answer: a non-object payload yields no data', () => {
  const text = `${ANSWER}\n\n\`\`\`litnotes-json\n[1,2,3]\n\`\`\``
  assert.deepEqual(mruAiParseAnswer(text), { answer: ANSWER, data: null, hasFence: true })
})

test('parse answer: a fence with trailing text is not the structured suffix', () => {
  const text = `${ANSWER}\n\n\`\`\`litnotes-json\n{"a":1}\n\`\`\`\nnot trailing`
  const result = mruAiParseAnswer(text)
  assert.equal(result.hasFence, false)
  assert.equal(result.data, null)
  assert.match(result.answer, /litnotes-json/)
  assert.match(result.answer, /not trailing/)
})

test('parse answer: an earlier code fence is preserved', () => {
  const code = '```js\nconst answer = 42\n```'
  const text = `Intro.\n\n${code}\n\n${ANSWER}\n\n\`\`\`litnotes-json\n{"a":1}\n\`\`\``
  const result = mruAiParseAnswer(text)
  assert.equal(result.hasFence, true)
  assert.ok(result.answer.includes(code))
  assert.ok(result.answer.endsWith(ANSWER))
})

test('parse answer: a four-space indented fence is literal Markdown, not a fence', () => {
  const text = `${ANSWER}\n\n    \`\`\`litnotes-json\n    {"a":1}\n    \`\`\``
  const result = mruAiParseAnswer(text)
  assert.equal(result.hasFence, false)
  assert.match(result.answer, /litnotes-json/)
})

test('parse answer: an empty fence body yields no data', () => {
  const text = `${ANSWER}\n\n\`\`\`litnotes-json\n\`\`\``
  assert.deepEqual(mruAiParseAnswer(text), { answer: ANSWER, data: null, hasFence: true })
})

/* ========================================================================== */
/* mruAiNormalizeMessages                                                     */
/* ========================================================================== */

const FENCED_ANSWER = `${ANSWER}\n\n\`\`\`litnotes-json\n${JSON.stringify({
  citations: [{ index: 1, blockKey: 'b1:aa', quote: 'fenced quote', aspect: 'method' }],
  followups: ['fenced follow-up'],
})}\n\`\`\``

test('normalize messages: tolerant input wrappers', () => {
  assert.deepEqual(mruAiNormalizeMessages(undefined), [])
  assert.deepEqual(mruAiNormalizeMessages(null), [])
  assert.deepEqual(mruAiNormalizeMessages('nope'), [])
  assert.deepEqual(mruAiNormalizeMessages({ messages: 'nope' }), [])
  const raw = [{ id: 'u1', question: 'Q' }]
  assert.equal(mruAiNormalizeMessages(raw).length, 1)
  assert.equal(mruAiNormalizeMessages({ messages: raw }).length, 1)
  assert.equal(mruAiNormalizeMessages({ items: raw }).length, 1)
  assert.equal(mruAiNormalizeMessages({ value: { messages: raw } }).length, 1)
})

test('normalize messages: roles, questions, ids and defaults', () => {
  const messages = mruAiNormalizeMessages([
    null,
    'nope',
    { id: 'u1', question: 'Q1' },
    { id: 'u2', role: 'user', question: '   ' },
    { id: 'a1', role: 'assistant', question: 'Q1', answer: 'A1' },
    { role: 'assistant', answer: 'A2' },
    { role: 'assistant', answer: '' },
    { role: 'system', content: 'fallback question' },
  ])
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'assistant', 'user'])
  assert.deepEqual(messages.map((message) => message.id), ['u1', 'a1', 'history-5', 'history-6', 'history-7'])
  assert.equal(messages[0].question, 'Q1')
  assert.equal(messages[1].answer, 'A1')
  assert.equal(messages[2].answer, 'A2')
  assert.equal(messages[4].question, 'fallback question')
  for (const message of messages) {
    assert.equal(message.createdAt, '')
    assert.deepEqual(message.citations, [])
    assert.deepEqual(message.unverified, [])
    assert.deepEqual(message.followups, [])
    assert.deepEqual(message.annotationIds, [])
    assert.deepEqual(message.knowledge, { nodeIds: [], edgeIds: [] })
    assert.deepEqual(message.usage, { inputTokens: 0, outputTokens: 0 })
    assert.equal(message.model, null)
  }
})

test('normalize messages: citations, unverified citations, metadata', () => {
  const messages = mruAiNormalizeMessages({
    messages: [{
      id: 'a1',
      role: 'assistant',
      question: 'Q',
      answer: 'A [1] [2].',
      citations: [
        {
          index: '2', blockKey: ' b1:aa ', quote: 'q', page: '3', aspect: 'result',
          start: '4', end: '8', note: 'n', verified: true,
        },
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
    }],
  })
  assert.equal(messages.length, 1)
  const message = messages[0]
  assert.deepEqual(message.citations, [
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
  assert.deepEqual(message.unverified, [{
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
  }])
  assert.deepEqual(message.followups, ['f1', 'f2'])
  assert.deepEqual(message.annotationIds, ['ann1'])
  assert.deepEqual(message.knowledge, { nodeIds: ['n1'], edgeIds: ['e1'] })
  assert.deepEqual(message.usage, { inputTokens: 12, outputTokens: 3 })
  assert.deepEqual(message.model, { provider: 'deepseek', model: 'flash' })
  assert.equal(message.createdAt, '2026-01-01T00:00:00.000Z')
})

test('normalize messages: a trailing litnotes-json fence is stripped and used only when fields are missing', () => {
  const messages = mruAiNormalizeMessages([
    { id: 'a1', role: 'assistant', question: 'Q', answer: FENCED_ANSWER },
    { id: 'a2', role: 'assistant', question: 'Q', answer: FENCED_ANSWER, citations: [] },
  ])
  assert.equal(messages[0].answer, ANSWER)
  assert.equal(messages[0].citations.length, 1)
  assert.equal(messages[0].citations[0].blockKey, 'b1:aa')
  assert.equal(messages[0].citations[0].aspect, 'method')
  assert.deepEqual(messages[0].followups, ['fenced follow-up'])
  // An explicit empty array is authoritative (the host already filtered it).
  assert.deepEqual(messages[1].citations, [])
  assert.deepEqual(messages[1].followups, ['fenced follow-up'])
  assert.equal(messages[1].answer, ANSWER)
})

test('normalize messages: duplicate ids are made unique', () => {
  const messages = mruAiNormalizeMessages([
    { id: 'same', role: 'user', question: 'Q1' },
    { id: 'same', role: 'assistant', question: 'Q1', answer: 'A' },
  ])
  assert.notEqual(messages[0].id, messages[1].id)
})

test('normalize messages: input is not mutated', () => {
  const raw = {
    messages: [{
      id: 'a1',
      role: 'assistant',
      question: 'Q',
      answer: FENCED_ANSWER,
      citations: [{ index: 1, blockKey: 'b1:aa', quote: 'q' }],
    }],
  }
  const snapshot = JSON.stringify(raw)
  mruAiNormalizeMessages(raw)
  assert.equal(JSON.stringify(raw), snapshot)
})

/* ========================================================================== */
/* Entailment (docs/RESEARCH.md line 177 / PLAN C4)                           */
/* ========================================================================== */

test('normalize messages: citation entailment fields are preserved', () => {
  const messages = mruAiNormalizeMessages([{
    id: 'a1',
    role: 'assistant',
    question: 'Q',
    answer: 'A [1] [2].',
    citations: [
      {
        index: 1,
        blockKey: 'b1:aa',
        quote: 'q1',
        entailment: 'partial',
        entailmentReason: 'quote hedges the claim',
      },
      { index: 2, blockKey: 'b2:bb', quote: 'q2', entailment: 'supported' },
      { index: 3, blockKey: 'b3:cc', quote: 'q3', entailment: 'bogus' },
    ],
    unverified: [
      {
        index: 2,
        blockKey: 'b2:bb',
        quote: 'q2',
        reason: 'entailment-unsupported',
        entailment: 'unsupported',
        entailmentReason: 'claim too strong',
      },
      { index: 4, blockKey: 'b4:dd', quote: 'q4', reason: 'quote-not-found' },
    ],
  }])
  const message = messages[0]
  assert.equal(message.citations[0].entailment, 'partial')
  assert.equal(message.citations[0].entailmentReason, 'quote hedges the claim')
  assert.equal(message.citations[1].entailment, 'supported')
  assert.equal(message.citations[1].entailmentReason, '')
  assert.equal(message.citations[2].entailment, '')
  assert.equal(message.unverified[0].reason, 'entailment-unsupported')
  assert.equal(message.unverified[0].entailment, 'unsupported')
  assert.equal(message.unverified[0].entailmentReason, 'claim too strong')
  assert.equal(message.unverified[1].reason, 'quote-not-found')
  assert.equal(message.unverified[1].entailment, '')
})

test('citation flags: partial and entailment-unsupported verdicts', () => {
  assert.deepEqual(mruAiCitationFlags({ entailment: 'partial' }, true), { partial: true, unsupported: false })
  assert.deepEqual(mruAiCitationFlags({ entailment: 'supported' }, true), { partial: false, unsupported: false })
  assert.deepEqual(mruAiCitationFlags({ entailment: 'unchecked' }, true), { partial: false, unsupported: false })
  assert.deepEqual(mruAiCitationFlags(null, false), { partial: false, unsupported: false })
  assert.deepEqual(
    mruAiCitationFlags({ entailment: 'unsupported', reason: 'entailment-unsupported' }, false),
    { partial: false, unsupported: true },
  )
  // The reason alone or the verdict alone is enough to flag it (host versions).
  assert.deepEqual(
    mruAiCitationFlags({ reason: 'entailment-unsupported' }, false),
    { partial: false, unsupported: true },
  )
  assert.deepEqual(mruAiCitationFlags({ entailment: 'unsupported' }, false), { partial: false, unsupported: true })
  // A generic unverified citation keeps the generic wording; the reason on a
  // verified citation is not an entailment rejection.
  assert.deepEqual(mruAiCitationFlags({ reason: 'quote-missing' }, false), { partial: false, unsupported: false })
  assert.deepEqual(
    mruAiCitationFlags({ reason: 'entailment-unsupported' }, true),
    { partial: false, unsupported: false },
  )
})

test('unverified breakdown: separates entailment-unsupported from other reasons', () => {
  assert.deepEqual(mruAiUnverifiedBreakdown(null), { unsupported: 0, generic: 0, total: 0 })
  assert.deepEqual(mruAiUnverifiedBreakdown([]), { unsupported: 0, generic: 0, total: 0 })
  assert.deepEqual(mruAiUnverifiedBreakdown([
    { reason: 'entailment-unsupported', entailment: 'unsupported' },
    { reason: 'quote-missing' },
    { entailment: 'unsupported' },
  ]), { unsupported: 2, generic: 1, total: 3 })
})

/* ========================================================================== */
/* mruAiExportMarkdown (PLAN C5)                                              */
/* ========================================================================== */

/** Minimal app dictionaries for the export framing copy (zh/en values). */
const EXPORT_ZH = {
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
const EXPORT_EN = {
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

/** Build a translate fake over one dictionary (with {param} interpolation). */
function mruAiExportFakeT(dictionary) {
  return (key, params) => {
    const template = typeof dictionary[key] === 'string' ? dictionary[key] : key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
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
    citations: [{
      index: 1,
      blockKey: 'b1:aa',
      quote: 'Scaled dot-product attention',
      page: 3,
      aspect: 'method',
      note: '提出缩放点积注意力',
      verified: true,
    }],
    unverified: [{
      index: 2,
      blockKey: 'b2:bb',
      quote: 'a bad quote',
      page: 5,
      aspect: 'result',
      note: '不支持的论点',
      verified: false,
      reason: 'no-match',
    }],
  },
]

test('export markdown: zh format with model/time front matter and citation lines', () => {
  const result = mruAiExportMarkdown(EXPORT_MESSAGES, {
    title: '论文标题',
    modelLabel: 'deepseek-flash',
    exportedAt: EXPORTED_AT,
    t: mruAiExportFakeT(EXPORT_ZH),
  })
  assert.deepEqual(result, {
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

test('export markdown: en format localizes the framing copy only', () => {
  const result = mruAiExportMarkdown(EXPORT_MESSAGES, {
    title: 'Paper title',
    modelLabel: 'deepseek-flash',
    exportedAt: EXPORTED_AT,
    t: mruAiExportFakeT(EXPORT_EN),
  })
  assert.deepEqual(result, {
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

test('export markdown: empty or unusable conversations return null', () => {
  const t = mruAiExportFakeT(EXPORT_ZH)
  assert.equal(mruAiExportMarkdown([], { t }), null)
  assert.equal(mruAiExportMarkdown(null, { t }), null)
  assert.equal(mruAiExportMarkdown(undefined, { t }), null)
  assert.equal(mruAiExportMarkdown({ messages: [] }, { t }), null)
  assert.equal(mruAiExportMarkdown([null, 'nope', { role: 'user', question: '   ' }], { t }), null)
  assert.equal(mruAiExportMarkdown([], null), null)
})

test('export markdown: turns are numbered, missing metadata degrades cleanly', () => {
  const result = mruAiExportMarkdown([
    { id: 'u1', role: 'user', question: 'Q1' },
    { id: 'a1', role: 'assistant', question: 'Q1', answer: 'A1' },
    { id: 'u2', role: 'user', question: 'Q2' },
    {
      id: 'a2',
      role: 'assistant',
      question: 'Q2',
      answer: 'A2 [1]',
      citations: [{ index: 1, blockKey: 'b1:aa', quote: 'q' }],
    },
  ], { exportedAt: EXPORTED_AT, t: mruAiExportFakeT(EXPORT_ZH) })
  assert.equal(result.filename, 'ai-conversation.md')
  assert.match(result.markdown, /^# AI 对话\n\n- 导出时间: 2026-11-07 11:35\n\n/u)
  assert.ok(result.markdown.includes('## 问题 1\nQ1\n\n## 回答 1\nA1'))
  assert.ok(result.markdown.includes('## 问题 2\nQ2\n\n## 回答 2\nA2 [1]'))
  assert.ok(result.markdown.includes('### 引用\n- [1] · 背景 · q'))
})

test('export markdown: raw history payloads and fenced answers are normalized', () => {
  const fenced = 'Answer [1].\n\n```litnotes-json\n'
    + JSON.stringify({ citations: [{ index: 1, blockKey: 'b1:aa', quote: 'quoted', page: 2, aspect: 'method' }] })
    + '\n```'
  const result = mruAiExportMarkdown({
    messages: [
      { id: 'u1', role: 'user', question: 'Q' },
      { id: 'a1', role: 'assistant', question: 'Q', answer: fenced },
    ],
  }, { title: 'T', exportedAt: EXPORTED_AT, t: mruAiExportFakeT(EXPORT_ZH) })
  assert.ok(result.markdown.includes('## 回答 1\nAnswer [1].\n'))
  assert.ok(result.markdown.includes('- [1] · p.2 · 方法 · quoted'))
  assert.equal(result.markdown.includes('litnotes-json'), false)
})

test('export markdown: filename sanitization', () => {
  const t = mruAiExportFakeT(EXPORT_ZH)
  const messages = [{ id: 'u1', role: 'user', question: 'Q' }]
  const filename = (title) => mruAiExportMarkdown(
    messages,
    { title, exportedAt: EXPORTED_AT, t },
  ).filename
  assert.equal(filename('Attention/Is: All*You? Need'), 'Attention Is All You Need.md')
  assert.equal(filename('a\nb\tc'), 'a b c.md')
  assert.equal(filename('   '), 'ai-conversation.md')
  assert.equal(filename('...'), 'ai-conversation.md')
  assert.equal(filename('A'.repeat(120)), `${'A'.repeat(80)}.md`)
})
