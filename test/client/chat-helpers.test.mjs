/**
 * Pure-helper tests for ui/chat.js: answer/fence splitting, inline citation
 * marker scanning (including code/escape exclusions) and history normalization.
 * The component itself is not rendered here; the exported helpers are the
 * contract the rest of the client relies on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mruAiCitationMarkers,
  mruAiParseAnswer,
  mruAiNormalizeMessages,
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
