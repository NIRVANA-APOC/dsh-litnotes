/**
 * Static contract checks for the dsh-litnotes AI app integration (ui/app.js).
 * These run without a browser: they pin the helpers that ui/chat.js and
 * ui/graph.js consume, the AI copy deck, and the persisted view preferences.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8')
const build = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8')
const chat = readFileSync(join(ROOT, 'ui', 'chat.js'), 'utf8')
const graph = readFileSync(join(ROOT, 'ui', 'graph.js'), 'utf8')

/** Extract a top-level `const NAME = { ... }` object literal body. */
function dictionaryBody(name) {
  const start = app.indexOf(`const ${name} = {`)
  assert.ok(start >= 0, `${name} dictionary is missing`)
  const end = app.indexOf('\n};', start)
  assert.ok(end > start, `${name} dictionary is not terminated`)
  return app.slice(start, end)
}

/** Extract the string keys of a dictionary literal. */
function dictionaryKeys(name) {
  const body = dictionaryBody(name)
  const keys = new Set()
  for (const match of body.matchAll(/^\s*'([^']+)':/gm)) keys.add(match[1])
  return keys
}

test('app.js exposes the helper contract consumed by ui/chat.js and ui/graph.js', () => {
  const functions = [
    'mruScrollToElement', 'mruFormatCount', 'mruDisplayText', 'mruErrorText',
    'MruRichText', 'MruFormula', 'MruGlyph', 'MruSpinner', 'mruOverlayPos',
    'mruStreamNdjson', 'mruAiState', 'mruAiModelLabel',
  ]
  for (const name of functions) {
    assert.match(app, new RegExp(`(?:^|\\n)(?:async\\s+)?function\\s+${name}\\s*\\(`), `${name} must be a top-level function declaration`)
  }
  assert.match(app, /function mruAiPanelComponent\(\)\s*\{\s*return typeof MruAiPanel === 'function'/, 'MruAiPanel must be resolved through a typeof guard')
  assert.match(app, /function mruGraphViewComponent\(\)\s*\{\s*return typeof MruGraphView === 'function'/, 'MruGraphView must be resolved through a typeof guard')
})

test('mruStreamNdjson implements the NDJSON client contract', () => {
  const start = app.indexOf('async function mruStreamNdjson(')
  assert.ok(start > 0, 'mruStreamNdjson is missing')
  const end = app.indexOf('\n}\n', start)
  const body = app.slice(start, end)
  assert.match(body, /method:\s*'POST'/, 'must POST')
  assert.match(body, /accept:\s*'application\/x-ndjson'/, 'must ask for NDJSON')
  assert.match(body, /TextDecoder/, 'must decode UTF-8 chunks')
  assert.ok(body.includes("buffer.indexOf("), 'must split frames on newline')
  assert.match(body, /emitLine/, 'must parse line frames')
  assert.match(body, /onFrame/, 'must deliver parsed frames')
  assert.match(body, /MruApiError\('aborted'/, 'must map aborts')
  assert.match(body, /host-unavailable/, 'must tolerate a host that is not ready')
})

test('zh/en AI copy deck is complete and symmetric', () => {
  const zh = dictionaryKeys('ZH')
  const en = dictionaryKeys('EN')
  assert.deepEqual([...zh].sort(), [...en].sort(), 'zh and en dictionaries must have identical key sets')
  const aiKeys = [...zh].filter((key) => key.startsWith('ai.'))
  const graphKeys = [...zh].filter((key) => key.startsWith('graph.'))
  assert.ok(aiKeys.length >= 40, `expected the AI panel copy deck, found ${aiKeys.length} ai.* keys`)
  assert.ok(graphKeys.length >= 25, `expected the graph copy deck, found ${graphKeys.length} graph.* keys`)
  for (const key of ['margin.ai', 'topbar.viewLibrary', 'topbar.viewGraph', 'reader.viewRead', 'reader.viewGraph', 'sel.askAi', 'ai.askBlock']) {
    assert.ok(zh.has(key), `missing AI UI key ${key}`)
  }
})

test('AI view preferences are host-persisted and validated', () => {
  const defaults = app.slice(app.indexOf('const MRU_DEFAULT_PREFS = {'), app.indexOf('\n};', app.indexOf('const MRU_DEFAULT_PREFS = {')))
  for (const key of ['aiPanelOpen', 'libraryView', 'docView', 'graphAutoBuild']) {
    assert.ok(defaults.includes(`${key}:`), `default preference ${key} is missing`)
  }
  assert.match(app, /MRU_MARGIN_TABS\s*=\s*\['outline',\s*'notes',\s*'ai'\]/, 'margin tabs must include ai')
  assert.match(app, /MRU_LIBRARY_VIEWS\s*=\s*\['library',\s*'graph'\]/, 'library views must be library|graph')
  assert.match(app, /MRU_DOC_VIEWS\s*=\s*\['read',\s*'graph'\]/, 'document views must be read|graph')
  assert.match(app, /aiPanelOpen:\s*tab === 'ai'/, 'margin tab changes must persist aiPanelOpen')
})

test('the AI label set covers both client modules', () => {
  // While ui/chat.js / ui/graph.js are placeholders this only validates the
  // dictionary; once the modules land it also asserts every t() key they use
  // is registered in app.js (missing keys would surface as raw key strings).
  const zh = dictionaryKeys('ZH')
  const used = new Set()
  for (const source of [chat, graph]) {
    for (const match of source.matchAll(/(?<![A-Za-z0-9_.$])t\(['"]([a-zA-Z0-9_.]+)['"]/g)) used.add(match[1])
  }
  const missing = [...used].filter((key) => !zh.has(key))
  assert.deepEqual(missing, [], `ui/chat.js or ui/graph.js use unregistered t() keys: ${missing.join(', ')}`)
})

test('build pipeline concatenates chat and graph before app', () => {
  assert.match(build, /read\('ui\/chat\.js'\)/, 'build-client must read ui/chat.js')
  assert.match(build, /read\('ui\/graph\.js'\)/, 'build-client must read ui/graph.js')
  assert.match(build, /\[markdown, highlight, chat, graph, app\]/, 'bundle order must be markdown, highlight, chat, graph, app')
})
