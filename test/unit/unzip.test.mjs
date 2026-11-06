/**
 * Unit tests for the dependency-free ZIP extractor (`lib/unzip.js`).
 *
 * Archives are produced by an independent stored/deflate writer
 * (`test/unit/zip-builder.test.mjs`) so the extractor is verified against the
 * ZIP layout rather than against itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unzip } from '../../lib/unzip.js'
import { makeDeflatedZip, makeStoredZip, makeZip } from './zip-builder.test.mjs'

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
  assert.equal(result.entries[0].data.toString(), '# Title\n\nHello world.')
  assert.equal(result.entries[1].data.toString(), '<svg/>')
  assert.equal(result.entries[2].data.toString(), 'deep')
})

test('extracts deflated entries (method 8)', () => {
  const text = 'a'.repeat(5000)
  const archive = makeDeflatedZip([{ name: 'paper.md', data: text }])
  const { entries } = unzip(archive)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'paper.md')
  assert.equal(entries[0].data.toString(), text)
})

test('applies the entry filter and counts skipped entries', () => {
  const archive = makeStoredZip([
    { name: 'full.md', data: 'keep' },
    { name: 'layout.json', data: '{}' },
    { name: 'images/a.png', data: 'png' },
  ])
  const result = unzip(archive, { filter: (name) => name === 'full.md' || name.startsWith('images/') })
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['full.md', 'images/a.png'],
  )
  assert.equal(result.skipped, 1)
})

test('skips directories silently', () => {
  const archive = makeStoredZip([{ name: 'images/', directory: true }, { name: 'images/a.png', data: 'x' }])
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
  const archive = makeZip([{ name: 'full.md', data: 'x' }], { zip64: true })
  assert.throws(() => unzip(archive), (error) => {
    assert.equal(error.code, 'zip-unsupported')
    assert.match(error.message, /ZIP64/)
    return true
  })
})

test('rejects archives with a fake 0xFFFFFFFF central-directory size', () => {
  const archive = makeStoredZip([{ name: 'full.md', data: 'x' }])
  // The EOCD is the last 22 bytes; overwrite the central-directory size field.
  archive.writeUInt32LE(0xffffffff, archive.length - 10)
  assert.throws(() => unzip(archive), (error) => {
    assert.equal(error.code, 'zip-unsupported')
    return true
  })
})

test('rejects non-zip input and truncated archives', () => {
  assert.throws(() => unzip(Buffer.from('not a zip at all')), (error) => {
    assert.ok(error.code === 'zip-truncated' || error.code === 'zip-invalid')
    return true
  })
  const archive = makeStoredZip([{ name: 'a.txt', data: 'hello world' }])
  assert.throws(() => unzip(archive.subarray(0, archive.length - 8)), (error) => {
    assert.ok(typeof error.code === 'string')
    return true
  })
})

test('enforces entry and size caps', () => {
  const archive = makeStoredZip([
    { name: 'a.txt', data: 'hello world' },
    { name: 'b.txt', data: 'b' },
  ])
  assert.throws(() => unzip(archive, { maxEntries: 1 }), (error) => {
    assert.equal(error.code, 'zip-limit')
    return true
  })
  assert.throws(() => unzip(archive, { maxEntryBytes: 5 }), (error) => {
    assert.equal(error.code, 'zip-limit')
    return true
  })
  assert.throws(() => unzip(archive, { maxTotalBytes: 1 }), (error) => {
    assert.equal(error.code, 'zip-limit')
    return true
  })
})

test('detects CRC mismatches for corrupt stored entries', () => {
  const archive = makeStoredZip([{ name: 'a.txt', data: 'hello' }])
  // Corrupt the entry payload but leave the recorded CRC intact.
  const payloadIndex = archive.indexOf(Buffer.from('hello'))
  archive.write('jello', payloadIndex)
  assert.throws(() => unzip(archive), (error) => {
    assert.equal(error.code, 'zip-invalid')
    assert.match(error.message, /CRC/)
    return true
  })
})

test('rejects unsupported compression methods', () => {
  // Build a valid tiny deflate archive, then patch the method to 12 (bzip2).
  const archive = makeDeflatedZip([{ name: 'a.txt', data: 'compressed payload' }])
  const eocdOffset = archive.length - 22
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  archive.writeUInt16LE(12, 8) // local header method
  archive.writeUInt16LE(12, centralOffset + 10) // central directory method
  assert.throws(() => unzip(archive), (error) => {
    assert.equal(error.code, 'zip-unsupported')
    return true
  })
})

test('reads an archive with an EOCD comment', () => {
  const archive = makeStoredZip([{ name: 'a.txt', data: 'with comment' }], { comment: 'mineru test comment' })
  const { entries } = unzip(archive)
  assert.equal(entries[0].data.toString(), 'with comment')
})
