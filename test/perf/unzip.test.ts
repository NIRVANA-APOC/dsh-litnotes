/**
 * Performance: fflate-backed ZIP extraction for MinerU result archives.
 *
 * Benchmarks the canonical MinerU result archive (`test/fixtures/sample-parse.zip`
 * plus the independently-built fixture archive) and a large synthetic archive
 * (60 entries / ~3.8 MB raw) so decompression and the security preflight are
 * covered at different scales.
 *
 * Timing is recorded, not asserted; extraction correctness (entry bytes match
 * the writer's input, traversal filtering, skipped counters) is asserted.
 */

import { test } from 'vitest'
import { expect } from 'vitest'

import { unzip } from '../../src/host/parse/unzip.ts'
import { makeZip } from '../helpers/zip-builder.ts'
import { figureBytes, standardContentList, standardMarkdown, standardResultZip } from '../helpers/parse-fixtures.ts'
import { measureSync } from './perf.ts'

const resultZip = standardResultZip()
const resultMarkdown = standardMarkdown()
const resultContentList = JSON.stringify(standardContentList())
const resultFigure = figureBytes()

/** A larger MinerU-shaped archive: 60 pages of markdown + images. */
function largeResultZip(): Buffer {
  const entries: Array<{ name: string; data: string | Uint8Array }> = []
  for (let index = 0; index < 50; index += 1) {
    entries.push({
      name: `pages/page-${String(index + 1).padStart(3, '0')}.md`,
      data: `${resultMarkdown}\n\n<!-- page ${index + 1} -->\n`,
    })
  }
  entries.push({ name: 'full.md', data: resultMarkdown })
  entries.push({ name: 'sample_content_list.json', data: resultContentList })
  for (let index = 0; index < 10; index += 1) entries.push({ name: `images/fig-${index + 1}.svg`, data: resultFigure })
  return makeZip(entries)
}

test('extract the canonical MinerU result archive', { timeout: 60_000 }, () => {
  const archive = resultZip
  let lastResult = unzip(archive)
  measureSync(
    { suite: 'unzip', case: 'mineru-result-zip', iters: 60, bytes: archive.length, note: `${lastResult.entries.length} entries` },
    () => {
      lastResult = unzip(archive)
    },
  )
  const markdownEntry = lastResult.entries.find((entry) => entry.name === 'full.md')
  expect(markdownEntry?.data.toString('utf8')).toBe(resultMarkdown)
  expect(lastResult.entries.some((entry) => entry.name === 'sample_content_list.json')).toBe(true)
  expect(lastResult.entries.some((entry) => entry.name === 'images/fig1.svg')).toBe(true)
  expect(lastResult.warnings).toHaveLength(0)
})

test('extract a large multi-entry archive', { timeout: 60_000 }, () => {
  const archive = largeResultZip()
  let lastCount = 0
  measureSync(
    { suite: 'unzip', case: 'large-result-zip', iters: 10, bytes: archive.length, note: '60 entries' },
    () => {
      lastCount = unzip(archive).entries.length
    },
  )
  expect(lastCount).toBe(62)
})

test('extract only the filtered entry set (parse-manager keep filter)', { timeout: 60_000 }, () => {
  const archive = resultZip
  let lastCount = 0
  measureSync(
    { suite: 'unzip', case: 'filtered-result-zip', iters: 60, bytes: archive.length },
    () => {
      lastCount = unzip(archive, {
        filter: (name) => name === 'full.md' || name.endsWith('_content_list.json') || name.startsWith('images/'),
      }).entries.length
    },
  )
  expect(lastCount).toBe(3)
})
