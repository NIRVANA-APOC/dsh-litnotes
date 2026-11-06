/**
 * Dependency-free ZIP writer used by the test fixtures.
 *
 * MinerU result archives are ZIP files; `lib/unzip.js` reads them. To test that
 * reader (and the parse manager that extracts results) without network access we
 * need to *produce* ZIPs. Only the STORED method (0, no compression) is
 * implemented, which is enough for fixtures and keeps this file tiny.
 *
 *   import { makeZip } from './make-zip.mjs'
 *   const buffer = makeZip([{ name: 'full.md', data: '# hello' }])
 *
 * Entry names are written verbatim — including hostile names such as
 * `../evil.md`, which the unzip tests need in order to prove that traversal is
 * rejected. The writer never reads or writes the filesystem itself.
 *
 * CLI:
 *   node test/fixtures/make-zip.mjs
 * writes `test/fixtures/sample-parse.zip` containing
 *   full.md                    = paper.md
 *   sample_content_list.json   = content_list.json
 *   images/fig1.svg            = images/fig1.svg
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** DOS timestamp 2026-01-01 00:00:00, fixed so archives are reproducible. */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * CRC-32 (IEEE 802.3), as required by the ZIP local and central headers.
 * @param {Buffer} buffer
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Coerce one entry's data to a Buffer. */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  throw new TypeError('makeZip: entry data must be a Buffer, Uint8Array or string')
}

/**
 * Build a ZIP archive in memory with the STORED method (no compression).
 *
 * @param {Array<{ name: string, data: Buffer|Uint8Array|string }>} entries
 *   File entries in archive order. Names are written as UTF-8 and are NOT
 *   sanitized (traversal-safety fixtures rely on that); directories are written
 *   as normal zero-length entries if the caller includes them.
 * @returns {Buffer} the complete ZIP archive
 */
export function makeZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('makeZip: expected a non-empty entries array')
  }

  /** @type {{ nameBuf: Buffer, data: Buffer, crc: number, offset: number }[]} */
  const records = []
  /** @type {Buffer[]} */
  const chunks = []
  let offset = 0

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || entry.name === '') {
      throw new TypeError('makeZip: every entry needs a non-empty string name')
    }
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = toBuffer(entry.data)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6) // general purpose flag: UTF-8 names
    local.writeUInt16LE(0, 8) // compression method: stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size (== stored size)
    local.writeUInt32LE(data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra field length

    records.push({ nameBuf, data, crc, offset })
    chunks.push(local, nameBuf, data)
    offset += local.length + nameBuf.length + data.length
  }

  const centralChunks = []
  let centralSize = 0
  for (const record of records) {
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8) // UTF-8 names
    central.writeUInt16LE(0, 10) // stored
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(record.crc, 16)
    central.writeUInt32LE(record.data.length, 20)
    central.writeUInt32LE(record.data.length, 24)
    central.writeUInt16LE(record.nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra field length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(record.offset, 42) // local header offset
    centralChunks.push(central, record.nameBuf)
    centralSize += central.length + record.nameBuf.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(records.length, 8)
  end.writeUInt16LE(records.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...chunks, ...centralChunks, end])
}

/* ------------------------------------------------------------------ */
/* CLI: write the canonical parse-result fixture archive               */
/* ------------------------------------------------------------------ */

/** Write test/fixtures/sample-parse.zip from the fixture files. */
export function writeSampleZip(outFile = join(HERE, 'sample-parse.zip')) {
  const zip = makeZip([
    { name: 'full.md', data: readFileSync(join(HERE, 'paper.md')) },
    { name: 'sample_content_list.json', data: readFileSync(join(HERE, 'content_list.json')) },
    { name: 'images/fig1.svg', data: readFileSync(join(HERE, 'images', 'fig1.svg')) },
  ])
  writeFileSync(outFile, zip)
  return { outFile, zip }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  try {
    const { outFile } = writeSampleZip()
    console.log(`[make-zip] wrote ${outFile}`)
  } catch (error) {
    console.error(`[make-zip] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
