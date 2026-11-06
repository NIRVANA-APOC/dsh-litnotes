/**
 * ZIP fixture + extractor safety tests (end-to-end level: the same files the
 * mock MinerU server serves are fed through lib/unzip.js, which the parse
 * manager uses to unpack `full_zip_url` archives).
 *
 * Focus: path traversal and resource caps must be enforced by the extractor
 * before anything is written to the document directory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { unzip } from '../../lib/unzip.js'
import { makeZip, crc32 } from '../fixtures/make-zip.mjs'
import { standardResultZip } from './helpers.mjs'

/** The filter the parse manager is documented to keep (ARCH.md §6). */
function mineruFilter(name) {
  return name === 'full.md' || name.endsWith('_content_list.json') || name.startsWith('images/')
}

test('make-zip / unzip round-trips stored entries', () => {
  const entries = [
    { name: 'full.md', data: '# Title\n\nBody\n' },
    { name: 'images/fig1.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
    { name: 'nested/dir/data.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
  ]
  const archive = makeZip(entries)
  assert.equal(archive.readUInt32LE(0), 0x04034b50)
  const result = unzip(archive)
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['full.md', 'images/fig1.svg', 'nested/dir/data.bin'],
  )
  assert.equal(result.entries[0].data.toString('utf8'), entries[0].data)
  assert.deepEqual(result.entries[2].data, entries[2].data)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926) // reference CRC-32 vector
})

test('fixture result zip extracts exactly the MinerU keep-set', () => {
  const result = unzip(standardResultZip(), { filter: mineruFilter })
  const names = result.entries.map((entry) => entry.name)
  assert.deepEqual(names, ['full.md', 'sample_content_list.json', 'images/fig1.svg'])
  assert.ok(result.skipped >= 2, 'layout.json and the original PDF must be skipped')
  assert.match(result.entries[0].data.toString('utf8'), /^# Sparse Expert Routing/)
  const contentList = JSON.parse(result.entries[1].data.toString('utf8'))
  assert.ok(Array.isArray(contentList) && contentList.length > 0)
  assert.ok(result.entries[2].data.toString('utf8').includes('<svg'))
})

test('path traversal entries are skipped with warnings, never extracted', () => {
  const archive = makeZip([
    { name: '../escape.md', data: 'evil' },
    { name: '/etc/passwd', data: 'evil' },
    { name: 'nested/../../escape2.md', data: 'evil' },
    { name: 'C:\\windows\\evil.md', data: 'evil' },
    { name: 'images\\..\\..\\evil3.md', data: 'evil' },
    { name: 'full.md', data: '# safe' },
    { name: 'images/fig1.svg', data: '<svg/>' },
  ])
  const result = unzip(archive)
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['full.md', 'images/fig1.svg'],
  )
  assert.equal(result.skipped, 5)
  assert.equal(result.warnings.length, 5)
  for (const warning of result.warnings) assert.match(warning, /skipped unsafe entry/)
})

test('backslashes are normalized before the safety check', () => {
  const result = unzip(makeZip([{ name: 'images\\fig1.svg', data: '<svg/>' }]))
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['images/fig1.svg'],
  )
})

test('entry-count cap is enforced before extraction', () => {
  const archive = makeZip([
    { name: 'a.md', data: 'a' },
    { name: 'b.md', data: 'b' },
    { name: 'c.md', data: 'c' },
  ])
  assert.throws(() => unzip(archive, { maxEntries: 2 }), (error) => error?.code === 'zip-limit')
})

test('truncated archives fail closed', () => {
  const archive = standardResultZip()
  assert.throws(
    () => unzip(archive.subarray(0, Math.floor(archive.length / 2))),
    (error) => ['zip-truncated', 'zip-invalid'].includes(error?.code),
  )
  assert.throws(() => unzip(Buffer.alloc(8)), (error) => error?.code === 'zip-truncated')
})

test('tampered entry bytes are rejected by the CRC check', () => {
  const archive = Buffer.from(makeZip([{ name: 'full.md', data: 'hello world' }]))
  const marker = archive.indexOf(Buffer.from('hello world'))
  assert.ok(marker > 0)
  archive[marker] = 'H'.charCodeAt(0)
  assert.throws(() => unzip(archive), (error) => error?.code === 'zip-invalid' && /CRC/.test(error.message))
})
