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
    'mruLayoutRead', 'mruLayoutWrite', 'mruLayoutClamp', 'mruLayoutDocWidth', 'mruLayoutMeasure',
    'mruLayoutWidthLabelKey', 'MruResizer', 'MruAspectLegend',
    'mruMergeAnnotations', 'mruOrphanAnnotation',
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
  // The copy decks live in app.js only (this round): chat.js/graph.js reach the
  // dictionary through the mruAiT / mruGraphText / tr wrappers. Every literal
  // key they pass plus every programmatic family must be registered.
  const zh = dictionaryKeys('ZH')
  const en = dictionaryKeys('EN')
  const used = new Set()
  const patterns = [
    /mruAiT\([^,]+,\s*'([a-zA-Z0-9_.-]+)'/g,
    /mruGraphText\([^,]+,\s*'([a-zA-Z0-9_.-]+)'/g,
    /\btr\('([a-zA-Z0-9_.-]+)'/g,
  ]
  for (const source of [chat, graph]) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        // A trailing dot means the module builds the key from a constant
        // (`'ai.aspect.' + aspect`); the family is asserted below instead.
        if (!match[1].endsWith('.')) used.add(match[1])
      }
    }
  }
  // Programmatic families rendered from constants inside the modules.
  const graphTypes = ['concept', 'method', 'finding', 'definition', 'limitation', 'section', 'question', 'insight', 'paper', 'topic']
  const graphEdges = ['defines', 'uses', 'supports', 'contradicts', 'part_of', 'leads_to', 'evolves_from', 'relates', 'answers', 'mentions', 'shares']
  const graphSources = ['ai-summary', 'qa', 'user', 'aggregate']
  const aspects = ['definition', 'context', 'method', 'result', 'limitation']
  for (const type of graphTypes) used.add(`graph.${type}`)
  for (const type of graphEdges) used.add(`graph.edge.${type}`)
  for (const source of graphSources) used.add(`graph.source.${source}`)
  for (const aspect of ['definition', 'method', 'result', 'limitation']) used.add(`graph.aspect.${aspect}`)
  for (const aspect of aspects) used.add(`aspect.${aspect}`)
  const missingZh = [...used].filter((key) => !zh.has(key))
  const missingEn = [...used].filter((key) => !en.has(key))
  assert.deepEqual(missingZh, [], `ui/chat.js or ui/graph.js use unregistered zh keys: ${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `ui/chat.js or ui/graph.js use unregistered en keys: ${missingEn.join(', ')}`)
  // The per-module fallback decks are gone; the dictionary is the only source.
  assert.doesNotMatch(chat, /const mruAiCopy = \{/, 'chat.js must not keep a local copy deck')
  assert.doesNotMatch(chat, /mruAiCopyLanguage/, 'chat.js must not probe the locale for a local deck')
  assert.doesNotMatch(graph, /const MRU_GRAPH_TEXT = \{/, 'graph.js must not keep a local copy deck')
  assert.doesNotMatch(graph, /function mruGraphLanguage\(/, 'graph.js must not probe the locale for a local deck')
})

test('a successful reparse reloads annotations before normalizing them', () => {
  assert.match(app, /previousStatus === 'parsing' && entry\.status === 'parsed'[\s\S]{0,220}reloadAnnotations\(selected\)/,
    'the parsing→parsed transition must reload library.get annotations')
  assert.match(app, /mruMergeAnnotations\(/, 'the annotations save path must merge stale orphans')
})

test('build pipeline concatenates chat and graph before app', () => {
  assert.match(build, /read\('ui\/chat\.js'\)/, 'build-client must read ui/chat.js')
  assert.match(build, /read\('ui\/graph\.js'\)/, 'build-client must read ui/graph.js')
  assert.match(build, /\[markdown, highlight, chat, graph, app\]/, 'bundle order must be markdown, highlight, chat, graph, app')
})

test('margin notes expose the AI spark and the origin/aspect filter', () => {
  assert.match(app, /const MRU_NOTES_FILTERS = \['all', 'ai', 'user'\]/, 'margin origin filter values are fixed')
  assert.match(app, /notesFilter: 'all',/, 'notesFilter defaults to all')
  assert.match(app, /prefs\.notesFilter = MRU_NOTES_FILTERS\.includes\(prefs\.notesFilter\)/, 'notesFilter must be normalized')
  assert.match(app, /const changeNotesFilter = \(value\) =>/, 'app must own the filter handler')
  assert.match(app, /updatePrefs\(\{ notesFilter: next \}\)/, 'the origin filter must persist host-side')
  const margin = app.slice(app.indexOf('function MruMargin('), app.indexOf('/** Bottom status bar.'))
  for (const className of [
    'mru-note-filter', 'mru-note-filter__chip',
    'mru-note-filter__status', 'mru-note__origin', 'mru-note--ai',
  ]) {
    assert.ok(margin.includes(className), `margin filter/spark markup must emit ${className}`)
  }
  assert.match(margin, /notes\.filterAi/, 'the AI filter chip must use the registered copy')
  assert.match(margin, /mru-note__origin[\s\S]{0,160}MruGlyph, \{ name: 'spark'/, 'AI notes must show the spark marker')
  // The aspect filter is the legend itself: no duplicated dot-only filter row.
  assert.doesNotMatch(margin, /mru-note-filter__aspect/, 'the separate aspect toggle row must be gone')
  assert.match(margin, /MruAspectLegend, \{ t, onToggle: toggleAspect, activeAspect: aspectFilter \}/,
    'the margin legend must double as the aspect filter')
  assert.match(margin, /mru-margin__legend-hint/, 'the filtering legend states what clicking it does')
  const legend = app.slice(app.indexOf('function MruAspectLegend('), app.indexOf('/**\n * Draggable panel divider'))
  assert.match(legend, /mru-aspect-legend__item--button/, 'interactive legend items become toggle buttons')
  assert.match(legend, /'aria-pressed': active \? 'true' : 'false'/, 'interactive legend items expose aria-pressed')
  assert.match(legend, /'data-aspect': entry\.aspect/, 'interactive legend items carry data-aspect for the harness')
  assert.match(legend, /onToggle\(active \? null : entry\.aspect\)/, 'clicking an active aspect clears it')
  const zh = dictionaryKeys('ZH')
  const en = dictionaryKeys('EN')
  for (const key of ['notes.aspectFilterHint', 'notes.filterAspect']) {
    assert.ok(zh.has(key) && en.has(key), `missing dictionary key ${key}`)
  }
  assert.match(app, /notesFilter,\n\s*onNotesFilterChange: changeNotesFilter,/, 'MineruApp must pass the filter state into the margin')
  // The note editor carries the AI provenance into the edit surface too.
  assert.match(app, /origin: annotation\.origin \|\| 'user',/, 'the note editor must receive the annotation origin')
  assert.match(app, /mru-noteeditor__origin/, 'the note editor must render the AI origin badge')
})

test('graph curation is wired through one patch-shaped onUpdateGraph', () => {
  const start = app.indexOf('onUpdateGraph: (patch, legacyEdges)')
  assert.ok(start > 0, 'MineruApp must expose the patch-shaped onUpdateGraph')
  const body = app.slice(start, app.indexOf('\n    }', start))
  assert.match(body, /mruPost\('graph\.update'/, 'curation must post graph.update')
  assert.match(body, /Array\.isArray\(source\.nodes\)/, 'nodes must ride the patch')
  assert.match(body, /Array\.isArray\(source\.merge\)/, 'merge must ride the patch')
  assert.match(body, /payload\.merge = source\.merge/, 'merge must reach the host payload')
  assert.match(body, /return mruPost\('graph\.update'/, 'the handler must resolve the updated graph')
  assert.ok(app.includes('return graph;'), 'the promise must resolve the updated KG')
})

test('conversation export and the download helper are wired', () => {
  assert.match(app, /onExportConversation: \(markdown, filename\) => mruDownloadText\(filename, markdown\)/,
    'the AI panel must receive the export hook')
  assert.match(app, /const mruDownloadText = \(filename, text, mime\) =>/, 'a shared text-download helper must exist')
  assert.match(app, /const mruSafeExportName = \(name\) =>/, 'export filenames must be sanitized')
  assert.match(app, /URL\.createObjectURL\(blob\)/, 'exports must use a Blob download')
  assert.match(app, /anchor\.download = mruSafeExportName\(filename\)/, 'the download must use the sanitized name')
})

test('the auto-build switch is persisted, hinted and reachable two ways', () => {
  assert.match(app, /const autoBuildGraphFor = \(doc\) =>/, 'a shared auto-build guard must exist')
  assert.match(app, /!state\.prefs\.graphAutoBuild \|\| !mruAiState\(state\.status\)\.graph/, 'auto-build must be gated by the pref and graph availability')
  assert.match(app, /autoBuiltGraphsRef\.current\.has\(id\)/, 'auto-build must run once per document per session')
  assert.match(app, /toast\(t\('toast\.autoGraph'\)\)/, 'auto-build must tell the reader it started')
  assert.match(app, /if \(doc\.status === 'parsed' && previous !== 'parsed'\) autoBuildGraphFor\(doc\)/, 'the parse transition must auto-build')
  assert.match(app, /state\.docView !== 'graph'[\s\S]{0,900}autoBuildGraphFor\(doc\)/, 'opening an empty graph view must recover a missed auto-build')
  assert.match(app, /t\('settings\.sectionAi'\)/, 'the AI settings section must exist')
  assert.match(app, /settings\.graphAutoBuildHint/, 'the switch must explain itself')
  assert.match(app, /settings\.graphAutoBuildUnavailable/, 'the switch must explain when it cannot work')
  assert.match(app, /aiGraphReady/, 'the switch must follow AI availability')
})
