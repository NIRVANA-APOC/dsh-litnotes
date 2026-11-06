/**
 * Pure-helper tests for the UI polish round (docs/UI-POLISH-SPEC.md §2/§4/§5):
 * layout clamps/storage, reading-width presets and the aspect legend contract.
 * The helpers are extracted from ui/app.js because they are bundle-internal;
 * the render harness (app-integration.test.mjs) covers the wiring.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8')

/** Extract a source region between two literal markers. */
function between(startMarker, endMarker) {
  const start = app.indexOf(startMarker)
  assert.ok(start >= 0, `missing marker: ${startMarker}`)
  const end = app.indexOf(endMarker, start)
  assert.ok(end > start, `missing end marker: ${endMarker}`)
  return app.slice(start, end)
}

function loadLayoutHelpers() {
  const constants = between('const MRU_LAYOUT_KEY', '/** Aspect colour legend')
  const functions = between('/**\n * Read the remembered layout', '/** Clear the browser text selection')
  const storage = new Map()
  const windowStub = {
    localStorage: {
      getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
      setItem: (key, value) => storage.set(String(key), String(value)),
    },
  }
  const source = `const mruClamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));\n`
    + constants + '\n' + functions + `
    ;({ mruLayoutRead, mruLayoutWrite, mruLayoutClamp, mruLayoutDocWidth, mruLayoutWidthLabelKey,
         MRU_LAYOUT_DEFAULTS, MRU_LAYOUT_LIMITS, MRU_DOC_WIDTH_PRESETS, MRU_LAYOUT_KEY })`
  const helpers = vm.runInNewContext(source, { window: windowStub, JSON, Object, Number, Math, Array })
  return { helpers, windowStub, storage }
}

test('layout defaults follow the polish contract', () => {
  const { helpers, storage } = loadLayoutHelpers()
  assert.deepEqual({ ...helpers.MRU_LAYOUT_DEFAULTS }, { railWidth: 288, marginWidth: 296, docWidth: 880 })
  assert.deepEqual({ ...helpers.MRU_LAYOUT_LIMITS.rail }, { min: 220, max: 460 })
  assert.deepEqual({ ...helpers.MRU_LAYOUT_LIMITS.margin }, { min: 240, max: 520 })
  assert.deepEqual([...helpers.MRU_DOC_WIDTH_PRESETS], [720, 880, 1040, 1200])
  assert.equal(helpers.MRU_LAYOUT_KEY, 'dsh-litnotes:layout')
  assert.deepEqual({ ...helpers.mruLayoutRead() }, { railWidth: 288, marginWidth: 296, docWidth: 880 })
  assert.equal(storage.size, 0, 'reading must not write storage')
})

test('layout clamps rail/margin widths and ignores garbage', () => {
  const { helpers, storage } = loadLayoutHelpers()
  assert.equal(helpers.mruLayoutClamp(100, helpers.MRU_LAYOUT_LIMITS.rail), 220)
  assert.equal(helpers.mruLayoutClamp(999, helpers.MRU_LAYOUT_LIMITS.rail), 460)
  assert.equal(helpers.mruLayoutClamp('333', helpers.MRU_LAYOUT_LIMITS.margin), 333)
  assert.equal(helpers.mruLayoutClamp('abc', helpers.MRU_LAYOUT_LIMITS.rail), null)
  assert.equal(helpers.mruLayoutClamp(Number.NaN, helpers.MRU_LAYOUT_LIMITS.rail), null)

  const written = helpers.mruLayoutWrite({ railWidth: 100, marginWidth: 999, docWidth: 1040 })
  assert.deepEqual({ ...written }, { railWidth: 220, marginWidth: 520, docWidth: 1040 })
  const persisted = JSON.parse(storage.get('dsh-litnotes:layout'))
  assert.deepEqual(persisted, { railWidth: 220, marginWidth: 520, docWidth: 1040 })
  assert.deepEqual({ ...helpers.mruLayoutRead() }, persisted)

  // Unknown values keep the previous/default width instead of corrupting it.
  helpers.mruLayoutWrite({ railWidth: 'oops' })
  assert.equal(helpers.mruLayoutRead().railWidth, 220)
  helpers.mruLayoutWrite({ docWidth: 999 })
  assert.equal(helpers.mruLayoutRead().docWidth, 880)
})

test('reading-width presets map to labels and normalize unknown values', () => {
  const { helpers } = loadLayoutHelpers()
  assert.equal(helpers.mruLayoutWidthLabelKey(720), 'layout.widthNarrow')
  assert.equal(helpers.mruLayoutWidthLabelKey(880), 'layout.widthStandard')
  assert.equal(helpers.mruLayoutWidthLabelKey(1040), 'layout.widthWide')
  assert.equal(helpers.mruLayoutWidthLabelKey(1200), 'layout.widthFull')
  assert.equal(helpers.mruLayoutDocWidth(720), 720)
  assert.equal(helpers.mruLayoutDocWidth('1040'), 1040)
  assert.equal(helpers.mruLayoutDocWidth(1234), 880)
  assert.equal(helpers.mruLayoutDocWidth(undefined), 880)
})

test('corrupted localStorage falls back to defaults without throwing', () => {
  const { helpers, storage } = loadLayoutHelpers()
  storage.set('dsh-litnotes:layout', '{not json')
  assert.deepEqual({ ...helpers.mruLayoutRead() }, { railWidth: 288, marginWidth: 296, docWidth: 880 })
  storage.set('dsh-litnotes:layout', JSON.stringify(['array']))
  assert.deepEqual({ ...helpers.mruLayoutRead() }, { railWidth: 288, marginWidth: 296, docWidth: 880 })
})

test('app markup emits the resizer, width-control and legend contract classes', () => {
  for (const className of [
    'mru-resizer', "mru-resizer--' + kind", 'mru-resizer--active',
    "role: 'separator'", "'aria-orientation': 'vertical'", "'aria-valuenow'", 'onDoubleClick',
    'mru-runhead__width', 'mru-runhead__width-group', 'mru-runhead__width--active',
    'mru-aspect-legend', 'mru-aspect-legend__item', 'mru-aspect-legend__dot--',
    'mru-aspect-legend__label', 'mru-margin__legend', 'mru-aspect-popover',
    'mru-runhead__legend', 'mru-root--resizing', '--mru-doc-width', '--mru-rail-width', '--mru-margin-width',
  ]) {
    assert.ok(app.includes(className), `ui/app.js must emit ${className}`)
  }
  // Legend aspects use aspect names as dot modifiers, never colour-only markup.
  for (const aspect of ['definition', 'context', 'method', 'result', 'limitation']) {
    assert.ok(app.includes(`aspect: '${aspect}'`), `legend must include the ${aspect} aspect`)
  }
})

test('app copy deck registers the legend and layout keys (zh + en)', () => {
  for (const key of [
    'layout.resizeRail', 'layout.resizeMargin', 'layout.resizeHint', 'layout.widthGroup',
    'layout.widthNarrow', 'layout.widthStandard', 'layout.widthWide', 'layout.widthFull',
    'aspect.legendTitle', 'aspect.definition', 'aspect.context', 'aspect.method',
    'aspect.result', 'aspect.limitation', 'aspect.legendHint',
  ]) {
    const occurrences = app.split(`'${key}':`).length - 1
    assert.ok(occurrences >= 2, `dictionary key ${key} must exist in both zh and en dictionaries (found ${occurrences})`)
  }
})
