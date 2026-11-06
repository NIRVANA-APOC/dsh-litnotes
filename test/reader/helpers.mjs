/**
 * Unit-test loader for the reader's pure modules.
 *
 * ui/highlight.js is authored for the bundle's shared function scope: it uses
 * helpers defined in ui/markdown.js without importing them (the build strips
 * imports). `scripts/build-client.mjs` inlines both files into one factory
 * scope, so the tests evaluate them exactly the same way: strip the top-level
 * `export ` keywords and run both bodies in a single `Function` scope. This
 * also proves the two files have no colliding top-level declarations.
 *
 * This file is a helper, not a test: `node --test test/reader` only picks up
 * `*.test.mjs` files.
 */
import { readFileSync } from 'node:fs'

const UI_DIR = new URL('../../ui/', import.meta.url)

/** Mirror of scripts/build-client.mjs toFactoryBody(): strip top-level ESM syntax. */
function toFactoryBody(fileName) {
  const source = readFileSync(new URL(fileName, UI_DIR), 'utf8')
  const lines = source.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^import\s/.test(line)) throw new Error(`${fileName}:${i + 1}: import is not allowed in UI sources`)
    if (/^export\s+default\s/.test(line)) throw new Error(`${fileName}:${i + 1}: default export is not allowed`)
    out.push(line.replace(/^export\s+/, ''))
  }
  return out.join('\n')
}

const READER_EXPORTS = [
  'fnv1a',
  'blockKey',
  'runsText',
  'parseInline',
  'parseMarkdown',
  'appendPageMarks',
  'plainTextOfBlock',
  'mdStats',
  'overlayRuns',
  'normalizeAnnotation',
  'groupAnnotations',
  'isAnnotatableBlock',
  'newAnnotationId',
]

const scopeBody = [
  toFactoryBody('markdown.js'),
  toFactoryBody('highlight.js'),
  `\nreturn { ${READER_EXPORTS.join(', ')} }`,
].join('\n\n')

/** All functions exported by ui/markdown.js + ui/highlight.js, shared scope. */
export const reader = new Function(scopeBody)()

/**
 * Assert the structural invariants every reader model must satisfy.
 *
 * Plain parseMarkdown() models have index === position. Models returned by
 * appendPageMarks() keep the originals' index/key untouched and add synthetic
 * page blocks, so positional indices only hold for unmarked models.
 */
export function assertModelIntegrity(assert, model) {
  assert.ok(model !== null && typeof model === 'object')
  assert.ok(Array.isArray(model.blocks))
  assert.ok(Array.isArray(model.outline))
  assert.deepStrictEqual(Object.keys(model.stats).sort(), ['blocks', 'chars', 'headings', 'words'])
  const pageMarked = model.blocks.some((block) => block.kind === 'page')
  const keys = new Set()
  const byKey = new Map()
  for (let i = 0; i < model.blocks.length; i += 1) {
    const block = model.blocks[i]
    if (!pageMarked) assert.strictEqual(block.index, i, `block ${i} has a stale index`)
    else assert.ok(Number.isInteger(block.index), `block ${i} needs an integer index`)
    if (block.kind === 'page') {
      assert.match(block.key, /^page:\d+:\d+$/, `page block ${i} has an invalid key`)
      assert.equal(block.plainText, undefined, 'page blocks carry no plainText')
    } else {
      assert.match(block.key, /^b\d+:[0-9a-f]{8}$/, `block ${i} has an invalid key`)
    }
    assert.ok(!keys.has(block.key), `duplicate block key at ${i}`)
    keys.add(block.key)
    byKey.set(block.key, block)
    if (Array.isArray(block.runs)) {
      assert.strictEqual(block.plainText, reader.runsText(block.runs), `block ${i} plainText ≠ runs`)
    }
    if (block.kind === 'list') {
      assert.ok(Array.isArray(block.items) && block.items.length > 0)
      let cumulative = 0
      for (const item of block.items) {
        assert.ok(Array.isArray(item.runs))
        assert.strictEqual(item.plainText, reader.runsText(item.runs))
        if (!pageMarked) {
          assert.strictEqual(block.plainText.slice(cumulative, cumulative + item.plainText.length), item.plainText)
        }
        cumulative += item.plainText.length
      }
    }
    if (block.kind === 'table') {
      assert.ok(Array.isArray(block.head))
      assert.ok(Array.isArray(block.rows))
      const cells = block.head.concat(block.rows.flat())
      for (const cell of cells) {
        assert.strictEqual(cell.plainText, reader.runsText(cell.runs))
        assert.ok(Number.isInteger(cell.colspan) && cell.colspan >= 1)
        assert.ok(Number.isInteger(cell.rowspan) && cell.rowspan >= 1)
      }
    }
  }
  for (const entry of model.outline) {
    const block = byKey.get(entry.key)
    assert.ok(block, 'outline entry key does not resolve to a block')
    assert.strictEqual(block.kind, 'heading')
    assert.strictEqual(block.index, entry.blockIndex)
  }
  assert.strictEqual(model.stats.blocks, model.blocks.length)
  assert.strictEqual(model.stats.headings, model.outline.length)
}
