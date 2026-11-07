/**
 * Unit + fixture-safety tests for the fflate-based ZIP extractor
 * (`src/host/parse/unzip.ts`).
 *
 * Ported from the frozen `test/unit/unzip.test.mjs` and the extractor half of
 * `test/e2e/unzip.test.mjs`. Archives are produced by the independent fflate
 * writer (`test/helpers/zip-builder.ts`) so the extractor is verified against a
 * different implementation path. Adversarial cases cover path traversal,
 * ZIP64/multi-disk rejection, entry count and size caps, unsupported
 * compression methods, CRC mismatches and truncated inputs.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ZipError, unzip } from '../../src/host/parse/unzip.ts'
import {
  centralRecordOffset,
  corruptPayload,
  crc32,
  findEocdOffset,
  makeDeflatedZip,
  makeStoredZip,
  makeZip,
  patchCentralSizeSentinel,
  patchFirstEntryMethod,
  patchToFakeZip64,
} from '../helpers/zip-builder.ts'
import { standardContentList, standardMarkdown, standardResultZip, figureBytes } from '../helpers/parse-fixtures.ts'

/** The filter the parse manager keeps (ARCH.md §6). */
function mineruFilter(name: string): boolean {
  return name === 'full.md' || name.endsWith('_content_list.json') || name.startsWith('images/')
}

/** Run `fn` and return the thrown error (failing when nothing is thrown). */
function thrownError(fn: () => unknown): Error & { code?: unknown } {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`)
    return error
  }
  assert.fail('expected the function to throw')
}

/** Assert that `fn` throws a {@link ZipError} with the given code. */
function assertZipError(fn: () => unknown, code: string): ZipError {
  const error = thrownError(fn)
  assert.ok(error instanceof ZipError, `expected ZipError, got ${error.name}: ${error.message}`)
  assert.equal(error.code, code)
  return error
}

// ---------------------------------------------------------------------------
// Frozen unit tests (test/unit/unzip.test.mjs)
// ---------------------------------------------------------------------------

test('extracts stored entries with normalized names and byte data', () => {
  const archive = makeStoredZip([
    { name: 'full.md', data: '# Title\n\nHello world.' },
    { name: 'images/fig1.svg', data: '<svg/>' },
    { name: 'nested/dir/file.txt', data: 'deep' },
  ])
  const result = unzip(archive)
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['full.md', 'images/fig1.svg', 'nested/dir/file.txt'],
  )
  assert.equal(result.entries[0]?.data.toString(), '# Title\n\nHello world.')
  assert.equal(result.entries[1]?.data.toString(), '<svg/>')
  assert.equal(result.entries[2]?.data.toString(), 'deep')
})

test('extracts deflated entries (method 8)', () => {
  const text = 'a'.repeat(5000)
  const archive = makeDeflatedZip([{ name: 'paper.md', data: text }])
  const { entries } = unzip(archive)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, 'paper.md')
  assert.equal(entries[0]?.data.toString(), text)
})

test('applies the entry filter and counts skipped entries', () => {
  const archive = makeStoredZip([
    { name: 'full.md', data: 'keep' },
    { name: 'layout.json', data: '{}' },
    { name: 'images/a.png', data: 'png' },
  ])
  const result = unzip(archive, { filter: (name) => name === 'full.md' || name.startsWith('images/') })
  assert.deepEqual(result.entries.map((entry) => entry.name), ['full.md', 'images/a.png'])
  assert.equal(result.skipped, 1)
})

test('skips directories silently', () => {
  const archive = makeStoredZip([
    { name: 'images/', data: '', directory: true },
    { name: 'images/a.png', data: 'x' },
  ])
  const { entries } = unzip(archive)
  assert.deepEqual(entries.map((entry) => entry.name), ['images/a.png'])
})

test('rejects path traversal entries with warnings and extracts the safe ones', () => {
  const archive = makeStoredZip([
    { name: '../../etc/passwd', data: 'root' },
    { name: 'images/../../../escape.png', data: 'bad' },
    { name: '/absolute/path.txt', data: 'abs' },
    { name: 'C:\\windows\\system32.txt', data: 'drive' },
    { name: 'safe/ok.txt', data: 'safe' },
  ])
  const result = unzip(archive)
  assert.deepEqual(result.entries.map((entry) => entry.name), ['safe/ok.txt'])
  assert.equal(result.skipped, 4)
  assert.equal(result.warnings.length, 4)
  for (const warning of result.warnings) assert.match(warning, /unsafe entry/)
})

test('normalizes backslash separators instead of extracting a Windows path', () => {
  const archive = makeStoredZip([{ name: 'images\\fig1.png', data: 'png' }])
  const { entries } = unzip(archive)
  assert.deepEqual(entries.map((entry) => entry.name), ['images/fig1.png'])
})

test('rejects ZIP64 archives', () => {
  const archive = patchToFakeZip64(makeStoredZip([{ name: 'full.md', data: 'x' }]))
  const error = assertZipError(() => unzip(archive), 'zip-unsupported')
  assert.match(error.message, /ZIP64/)
})

test('rejects archives with a fake 0xFFFFFFFF central-directory size', () => {
  const archive = patchCentralSizeSentinel(makeStoredZip([{ name: 'full.md', data: 'x' }]))
  assertZipError(() => unzip(archive), 'zip-unsupported')
})

test('rejects non-zip input and truncated archives', () => {
  const garbage = thrownError(() => unzip(Buffer.from('not a zip at all')))
  assert.ok(garbage.code === 'zip-truncated' || garbage.code === 'zip-invalid')
  const archive = makeStoredZip([{ name: 'a.txt', data: 'hello world' }])
  const truncated = thrownError(() => unzip(archive.subarray(0, archive.length - 8)))
  assert.equal(typeof truncated.code, 'string')
})

test('enforces entry and size caps', () => {
  const archive = makeStoredZip([
    { name: 'a.txt', data: 'hello world' },
    { name: 'b.txt', data: 'b' },
  ])
  assertZipError(() => unzip(archive, { maxEntries: 1 }), 'zip-limit')
  assertZipError(() => unzip(archive, { maxEntryBytes: 5 }), 'zip-limit')
  assertZipError(() => unzip(archive, { maxTotalBytes: 1 }), 'zip-limit')
})

test('detects CRC mismatches for corrupt stored entries', () => {
  const archive = makeStoredZip([{ name: 'a.txt', data: 'hello' }])
  corruptPayload(archive, 'hello', 'jello')
  const error = assertZipError(() => unzip(archive), 'zip-invalid')
  assert.match(error.message, /CRC/)
})

test('rejects unsupported compression methods', () => {
  const archive = makeDeflatedZip([{ name: 'a.txt', data: 'compressed payload' }])
  patchFirstEntryMethod(archive, 12) // bzip2
  assertZipError(() => unzip(archive), 'zip-unsupported')
})

test('reads an archive with an EOCD comment', () => {
  const archive = makeStoredZip([{ name: 'a.txt', data: 'with comment' }], { comment: 'mineru test comment' })
  const { entries } = unzip(archive)
  assert.equal(entries[0]?.data.toString(), 'with comment')
})

// ---------------------------------------------------------------------------
// Frozen end-to-end extractor tests (test/e2e/unzip.test.mjs)
// ---------------------------------------------------------------------------

test('make-zip / unzip round-trips stored entries', () => {
  const entries = [
    { name: 'full.md', data: '# Title\n\nBody\n' },
    { name: 'images/fig1.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
    { name: 'nested/dir/data.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
  ]
  const archive = makeZip(
    entries.map((entry) => ({ name: entry.name, data: entry.data })),
    { method: 'stored' },
  )
  assert.equal(archive.readUInt32LE(0), 0x04034b50)
  const result = unzip(archive)
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['full.md', 'images/fig1.svg', 'nested/dir/data.bin'],
  )
  assert.equal(result.entries[0]?.data.toString('utf8'), entries[0]?.data)
  assert.deepEqual(result.entries[2]?.data, entries[2]?.data)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926) // reference CRC-32 vector
})

test('fixture result zip extracts exactly the MinerU keep-set', () => {
  const archive = standardResultZip()
  const { entries, skipped } = unzip(archive, { filter: mineruFilter })
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['full.md', 'images/fig1.svg', 'sample_content_list.json'])
  assert.equal(skipped, 2) // layout.json + paper.pdf
  const markdown = entries.find((entry) => entry.name === 'full.md')
  assert.equal(markdown?.data.toString('utf8'), standardMarkdown())
  const contentList = entries.find((entry) => entry.name === 'sample_content_list.json')
  assert.deepEqual(JSON.parse(contentList?.data.toString('utf8') ?? '[]'), standardContentList())
  const image = entries.find((entry) => entry.name === 'images/fig1.svg')
  assert.deepEqual(image?.data, figureBytes())
})

test('path traversal entries are skipped with warnings, never extracted', () => {
  const archive = makeZip([
    { name: '../evil.md', data: '# evil' },
    { name: 'nested/../../evil2.md', data: '# evil2' },
    { name: 'images/ok.svg', data: '<svg/>' },
  ])
  const result = unzip(archive)
  assert.deepEqual(result.entries.map((entry) => entry.name), ['images/ok.svg'])
  assert.equal(result.skipped, 2)
  assert.equal(result.warnings.length, 2)
})

test('backslashes are normalized before the safety check', () => {
  const archive = makeZip([{ name: 'images\\nested\\fig.svg', data: '<svg/>' }])
  const { entries } = unzip(archive)
  assert.deepEqual(entries.map((entry) => entry.name), ['images/nested/fig.svg'])
})

test('entry-count cap is enforced before extraction', () => {
  const archive = makeZip([
    { name: 'a.txt', data: 'a' },
    { name: 'b.txt', data: 'b' },
    { name: 'c.txt', data: 'c' },
  ])
  assertZipError(() => unzip(archive, { maxEntries: 2 }), 'zip-limit')
})

test('truncated archives fail closed', () => {
  const archive = standardResultZip()
  const error = thrownError(() => unzip(archive.subarray(0, 64)))
  assert.ok(error instanceof ZipError)
  assert.ok(error.code === 'zip-truncated' || error.code === 'zip-invalid')
})

test('tampered entry bytes are rejected by the CRC check', () => {
  const archive = makeStoredZip([{ name: 'full.md', data: '# Title\n\nBody\n' }])
  corruptPayload(archive, 'Body', 'Evil')
  assertZipError(() => unzip(archive), 'zip-invalid')
})

// ---------------------------------------------------------------------------
// fflate-specific structural coverage
// ---------------------------------------------------------------------------

test('central directory offsets match the writer layout (test-helper sanity)', () => {
  const archive = makeStoredZip([{ name: 'a.txt', data: 'a' }])
  const eocd = findEocdOffset(archive)
  assert.equal(archive.readUInt32LE(eocd), 0x06054b50)
  const central = centralRecordOffset(archive, 0)
  assert.equal(archive.readUInt32LE(central), 0x02014b50)
  const nameLength = archive.readUInt16LE(central + 28)
  assert.equal(archive.toString('utf8', central + 46, central + 46 + nameLength), 'a.txt')
})

test('rejects archives with a hostile NUL byte in the entry name', () => {
  const archive = makeZip([{ name: 'safe\0evil.md', data: 'x' }])
  const result = unzip(archive)
  assert.deepEqual(result.entries, [])
  assert.equal(result.skipped, 1)
  assert.match(result.warnings[0] ?? '', /NUL/)
})

test('rejects empty input and non-bytes input', () => {
  assertZipError(() => unzip(new Uint8Array(0)), 'zip-truncated')
  const invalid = thrownError(() => unzip('not bytes' as unknown as Uint8Array))
  assert.equal(invalid.code, 'zip-invalid')
})

test('an empty archive extracts to an empty result', () => {
  const archive = makeStoredZip([{ name: 'only.txt', data: 'x' }], { comment: '' })
  const filtered = unzip(archive, { filter: () => false })
  assert.deepEqual(filtered.entries, [])
  assert.equal(filtered.skipped, 1)
})
