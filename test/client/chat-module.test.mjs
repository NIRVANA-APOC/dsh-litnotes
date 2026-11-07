/**
 * Build/contract tests for ui/chat.js. The build concatenates markdown.js,
 * highlight.js, chat.js, graph.js and app.js inside one factory function, strips
 * top-level `export ` keywords and requires globally unique prefixed names.
 * These checks keep chat.js safe for that shared scope and pin the documented
 * CSS class contract (docs/AI-SPEC.md §8).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const chatSource = readFileSync(new URL('../../ui/chat.js', import.meta.url), 'utf8')
const markdownSource = readFileSync(new URL('../../ui/markdown.js', import.meta.url), 'utf8')
const highlightSource = readFileSync(new URL('../../ui/highlight.js', import.meta.url), 'utf8')

function stripExports(source) {
  return source.split('\n').map((line) => line.replace(/^export\s+/, '')).join('\n')
}

test('chat.js is factory-body compatible (no imports, no default export, only top-level export functions)', () => {
  assert.doesNotMatch(chatSource, /^import\s/m, 'ui/chat.js must not import modules')
  assert.doesNotMatch(chatSource, /^export\s+default\s/m, 'ui/chat.js must not default-export')
  assert.doesNotMatch(chatSource, /\bimport\s*\(/, 'ui/chat.js must not use dynamic import()')
  const exported = chatSource.split('\n').filter((line) => /^export\s/.test(line))
  assert.ok(exported.length > 0)
  for (const line of exported) {
    assert.match(line, /^export function\s+[A-Za-z_$][\w$]*\s*\(/, `not a top-level export function: ${line}`)
  }
  const stripped = stripExports(chatSource)
  assert.doesNotMatch(stripped, /^export\s/m)
})

test('chat.js exports exactly the documented names, all mruAi/MruAi-prefixed', () => {
  const names = chatSource.split('\n')
    .map((line) => /^export\s+function\s+([A-Za-z_$][\w$]*)/.exec(line))
    .filter(Boolean)
    .map((match) => match[1])
  assert.deepEqual(names.sort(), [
    'MruAiPanel',
    'mruAiAspectLegendItems',
    'mruAiCitationFlags',
    'mruAiCitationMarkers',
    'mruAiExportMarkdown',
    'mruAiNavAwayFromLatest',
    'mruAiNavCurrentMark',
    'mruAiNavTargetScrollTop',
    'mruAiNormalizeMessages',
    'mruAiParseAnswer',
    'mruAiQuestionMarks',
    'mruAiUnverifiedBreakdown',
  ].sort())
  for (const name of names) assert.match(name, /^(mruAi|MruAi)/)
})

test('every top-level chat.js declaration is mruAi/MruAi-prefixed', () => {
  const declarations = []
  const pattern = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  let match
  while ((match = pattern.exec(chatSource)) !== null) declarations.push(match[1] || match[2])
  assert.ok(declarations.length > 20)
  for (const name of declarations) {
    assert.match(name, /^(mruAi|MruAi)/, `top-level name must be prefixed for the shared scope: ${name}`)
  }
})

test('chat.js does not touch the document body or browser storage', () => {
  assert.doesNotMatch(chatSource, /document\.body/)
  assert.doesNotMatch(chatSource, /\blocalStorage\b/)
  assert.doesNotMatch(chatSource, /\bsessionStorage\b/)
})

test('chat.js carries every required §8 .mru-ai class', () => {
  const required = [
    'mru-ai',
    'mru-ai__head',
    'mru-ai__title',
    'mru-ai__model',
    'mru-ai__messages',
    'mru-ai__empty',
    'mru-ai__empty-title',
    'mru-ai__empty-text',
    'mru-ai__prompts',
    'mru-ai__prompt',
    'mru-ai__msg',
    'mru-ai__msg--user',
    'mru-ai__msg--assistant',
    'mru-ai__bubble',
    'mru-ai__question',
    'mru-ai__answer',
    'mru-ai__citations',
    'mru-ai__citation',
    'mru-ai__citation--unverified',
    'mru-ai__citation-card',
    'mru-ai__actions',
    'mru-ai__action',
    'mru-ai__followups',
    'mru-ai__followup',
    'mru-ai__context',
    'mru-ai__chip',
    'mru-ai__chip-label',
    'mru-ai__composer',
    'mru-ai__input',
    'mru-ai__send',
    'mru-ai__stop',
    'mru-ai__hint',
    'mru-ai__error',
    'mru-ai__notice',
    'mru-ai__streaming',
    'mru-ai__spark',
  ]
  for (const className of required) {
    assert.ok(chatSource.includes(className), `missing class ${className}`)
  }
})

test('extra modifier classes are documented in the file header', () => {
  const header = chatSource.slice(0, chatSource.indexOf('/** Quick prompts shown'))
  for (const className of [
    'mru-ai__msg--streaming',
    'mru-ai__chip--selection',
    'mru-ai__chip--visible',
    'mru-ai__citation--missing',
    'mru-ai__citation--partial',
    'mru-ai__claim',
    'mru-ai__claim--partial',
    'mru-ai__claim--unsupported',
    'mru-ai__notice--entailment',
    'mru-ai__action--compact',
  ]) {
    assert.ok(header.includes(className), `extra modifier not documented: ${className}`)
  }
})

test('chat.js carries no local copy deck (i18n consolidation, PLAN C6)', () => {
  // All copy is registered in the app dictionaries (ui/app.js ZH/EN); the panel
  // must go through mruAiT(t,key,params) only.
  assert.doesNotMatch(chatSource, /\bmruAiCopy\b/)
  assert.doesNotMatch(chatSource, /\bmruAiCopyLanguage\b/)
  assert.doesNotMatch(chatSource, /'ai\.aspect\./)
  // Chat aspect labels reuse the reader aspect.* keys.
  assert.match(chatSource, /'aspect\.definition'/)
  assert.match(chatSource, /'aspect\.context'/)
  assert.match(chatSource, /'aspect\.method'/)
  assert.match(chatSource, /'aspect\.result'/)
  assert.match(chatSource, /'aspect\.limitation'/)
})

test('chat.js is valid ESM and importable without React', async () => {
  const module = await import('../../ui/chat.js')
  assert.equal(typeof module.MruAiPanel, 'function')
  assert.equal(typeof module.mruAiParseAnswer, 'function')
  assert.equal(typeof module.mruAiCitationMarkers, 'function')
  assert.equal(typeof module.mruAiNormalizeMessages, 'function')
})

test('markdown + highlight + chat concatenate into one parseable factory body', () => {
  const combined = [markdownSource, highlightSource, chatSource].map(stripExports).join('\n\n')
  assert.doesNotMatch(combined, /^export\s/m)
  // Mirror scripts/build-client.mjs: the source becomes the body of a function.
  const factory = new Function(
    'React',
    'h',
    `${combined}\n;return { MruAiPanel, mruAiParseAnswer, mruAiCitationMarkers, mruAiCitationFlags, mruAiUnverifiedBreakdown, mruAiExportMarkdown, mruAiNormalizeMessages };`,
  )
  const fakeReact = {
    createElement: () => null,
    Fragment: null,
    useState: () => [undefined, () => {}],
    useRef: () => ({ current: undefined }),
    useEffect: () => {},
  }
  const exports = factory(fakeReact, () => null)
  assert.equal(typeof exports.MruAiPanel, 'function')
  assert.deepEqual(exports.mruAiNormalizeMessages(null), [])
  assert.equal(exports.mruAiParseAnswer('plain').answer, 'plain')
  assert.equal(exports.mruAiExportMarkdown([], {}), null)
  assert.deepEqual(exports.mruAiUnverifiedBreakdown([]), { unsupported: 0, generic: 0, total: 0 })
})
