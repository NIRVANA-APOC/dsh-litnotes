/**
 * Pure-helper tests for the AI panel's floating question navigator and aspect
 * legend (docs/UI-POLISH-SPEC.md §3/§5). Component rendering is covered by the
 * app render harness; these pin the mapping and scroll math.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mruAiAspectLegendItems,
  mruAiNavAwayFromLatest,
  mruAiNavCurrentMark,
  mruAiNavTargetScrollTop,
  mruAiQuestionMarks,
} from '../../ui/chat.js'

test('question marks: one mark per user message with ordinal and question text', () => {
  const messages = [
    { id: 'm1', role: 'user', question: 'What is the method?' },
    { id: 'm2', role: 'assistant', question: 'What is the method?', answer: 'It is…' },
    { id: 'm3', role: 'user', question: 'What are the limits?' },
    { id: 'm4', role: 'assistant', question: 'What are the limits?', answer: 'It…' },
    { id: 'm5', role: 'user', question: '   ' },
    { id: '', role: 'user', question: 'no id' },
    { role: 'user', question: 'missing id' },
  ]
  const marks = mruAiQuestionMarks(messages)
  assert.deepEqual(marks.map((mark) => mark.messageId), ['m1', 'm3', 'm5'])
  assert.deepEqual(marks.map((mark) => mark.ordinal), [1, 2, 3])
  assert.equal(marks[0].question, 'What is the method?')
  assert.deepEqual(mruAiQuestionMarks(null), [])
  assert.deepEqual(mruAiQuestionMarks([]), [])
})

test('current mark: the last question at or above the anchor line', () => {
  const marks = mruAiQuestionMarks([
    { id: 'u1', role: 'user', question: 'Q1' },
    { id: 'a1', role: 'assistant', question: 'Q1', answer: 'A1' },
    { id: 'u2', role: 'user', question: 'Q2' },
    { id: 'a2', role: 'assistant', question: 'Q2', answer: 'A2' },
    { id: 'u3', role: 'user', question: 'Q3' },
  ])
  const offsets = [
    { messageId: 'u1', top: 0 },
    { messageId: 'a1', top: 120 },
    { messageId: 'u2', top: 400 },
    { messageId: 'a2', top: 520 },
    { messageId: 'u3', top: 900 },
  ]
  assert.equal(mruAiNavCurrentMark(marks, offsets, 300), 0)
  assert.equal(mruAiNavCurrentMark(marks, offsets, 420), 1)
  assert.equal(mruAiNavCurrentMark(marks, offsets, 999), 2)
  assert.equal(mruAiNavCurrentMark(marks, offsets, -10), -1)
  assert.equal(mruAiNavCurrentMark(marks, [], 100), -1)
  assert.equal(mruAiNavCurrentMark([], offsets, 100), -1)
  assert.equal(mruAiNavCurrentMark(marks, offsets, Number.NaN), -1)
})

test('away from latest: only when the list is scrolled up beyond the threshold', () => {
  assert.equal(mruAiNavAwayFromLatest(0, 1000, 400), true)
  assert.equal(mruAiNavAwayFromLatest(600, 1000, 400), false)
  assert.equal(mruAiNavAwayFromLatest(450, 1000, 400, 120), true)
  assert.equal(mruAiNavAwayFromLatest(470, 1000, 400, 120), true)
  assert.equal(mruAiNavAwayFromLatest(480, 1000, 400, 120), false)
  assert.equal(mruAiNavAwayFromLatest(Number.NaN, 1000, 400), false)
})

test('target scrollTop: message lands padding px below the container top', () => {
  assert.equal(mruAiNavTargetScrollTop(100, 500, 100), 488)
  assert.equal(mruAiNavTargetScrollTop(0, 0, 0, 12), 0)
  assert.equal(mruAiNavTargetScrollTop(50, 100, 300), 0)
  assert.equal(mruAiNavTargetScrollTop(Number.NaN, 50, 0), 38)
})

test('aspect legend items: five aspects resolved through the reader aspect.* keys', () => {
  // ui/chat.js keeps no copy deck: without a translate callback the key is the
  // fallback label (still guaranteed non-empty).
  const untranslated = mruAiAspectLegendItems(null)
  assert.deepEqual(untranslated.map((item) => item.aspect), ['definition', 'context', 'method', 'result', 'limitation'])
  assert.deepEqual(untranslated.map((item) => item.label), [
    'aspect.definition',
    'aspect.context',
    'aspect.method',
    'aspect.result',
    'aspect.limitation',
  ])
  const dictionary = {
    'aspect.definition': '定义',
    'aspect.context': '背景',
    'aspect.method': '方法',
    'aspect.result': '结果',
    'aspect.limitation': '局限',
  }
  const items = mruAiAspectLegendItems((key) => dictionary[key] || key)
  assert.deepEqual(items.map((item) => item.label), ['定义', '背景', '方法', '结果', '局限'])
  for (const item of items) assert.equal(typeof item.label, 'string')
  assert.equal(items.every((item) => item.label.trim() !== ''), true)
})
