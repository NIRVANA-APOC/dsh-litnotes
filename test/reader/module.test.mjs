/**
 * Module-contract tests for the two pure reader modules: the build inlines them
 * into one function scope (scripts/build-client.mjs), so they must not use
 * imports/default exports, must not redeclare the shared markdown helpers, and
 * the shared-scope load performed by ./helpers.mjs must expose every documented
 * function.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reader } from './helpers.mjs'

const markdownSource = readFileSync(new URL('../../ui/markdown.js', import.meta.url), 'utf8')
const highlightSource = readFileSync(new URL('../../ui/highlight.js', import.meta.url), 'utf8')

test('ui sources are factory-body compatible (no import / default export)', () => {
  for (const [name, source] of [['markdown.js', markdownSource], ['highlight.js', highlightSource]]) {
    assert.doesNotMatch(source, /^import\s/m, `${name} must not import modules`)
    assert.doesNotMatch(source, /^export\s+default\s/m, `${name} must not use a default export`)
    const stripped = source.split('\n').map((line) => line.replace(/^export\s+/, '')).join('\n')
    assert.doesNotMatch(stripped, /^export\s/m, `${name} must only use top-level export statements`)
    // No ESM-only dynamic import inside function bodies.
    assert.doesNotMatch(source, /\bimport\s*\(/, `${name} must not use dynamic import()`)
  }
})

test('documented reader functions are exported and callable', () => {
  const expected = [
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
  for (const name of expected) {
    assert.equal(typeof reader[name], 'function', `missing export ${name}`)
  }
})

test('highlight.js does not redeclare the shared markdown helpers', () => {
  for (const name of ['fnv1a', 'blockKey', 'runsText', 'plainTextOfBlock']) {
    assert.doesNotMatch(
      highlightSource,
      new RegExp(`\\b(function|const|let|var)\\s+${name}\\b`),
      `highlight.js must use the shared ${name} from markdown.js`,
    )
  }
})

test('module headings still carry the authoritative contract comments', () => {
  assert.match(markdownSource, /CONTRACT \(docs\/UI-SPEC\.md §3\.5\)/)
  assert.match(highlightSource, /annotation/i)
})

test('parsed blocks round-trip through the annotation helpers', () => {
  const model = reader.parseMarkdown('**Claim:** routing is cheap for long queries.')
  const block = model.blocks[0]
  assert.equal(reader.isAnnotatableBlock(block), true)
  const annotation = reader.normalizeAnnotation({ start: 2, end: 7, color: 'sky' }, block)
  assert.ok(annotation)
  const segments = reader.overlayRuns(block.runs, [annotation])
  assert.equal(segments.map((segment) => segment.text).join(''), block.plainText)
  assert.ok(segments.some((segment) => segment.annotationIds.includes(annotation.id)))
  const group = reader.groupAnnotations([annotation])
  assert.equal(group.get(block.key).length, 1)
})
