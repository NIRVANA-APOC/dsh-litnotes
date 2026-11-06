/**
 * Minimal ZIP writer used by the host unit tests.
 *
 * Independent of `lib/unzip.js` on purpose: the extractor must be verified
 * against archives built from the ZIP specification, not against its own
 * inverse. Supports the two methods MinerU uses (stored and deflate), the
 * UTF-8 name flag, and a deliberately-broken ZIP64 shape for rejection tests.
 *
 * This module intentionally declares no tests of its own; it is imported by
 * `unzip.test.mjs` and `parse-manager.test.mjs`.
 */
import { crc32, deflateRawSync } from 'node:zlib'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const FLAG_UTF8 = 0x0800

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{ name: string, data: string | Buffer, directory?: boolean }>} entries
 *   entries to store; `name` may end with `/` for a directory record.
 * @param {{ method?: 'stored' | 'deflate', zip64?: boolean, comment?: string }} [options]
 *   compression method, ZIP64 markers, and archive comment.
 * @returns {Buffer} the archive bytes.
 */
export function makeZip(entries, { method = 'stored', zip64 = false, comment = '' } = {}) {
  const localParts = []
  const centralParts = []
  const commentBuffer = Buffer.from(comment, 'utf8')
  let offset = 0
  for (const entry of entries) {
    const nameBuffer = Buffer.from(String(entry.name), 'utf8')
    const raw = entry.directory === true ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '')
    const compressed = method === 'deflate' && !entry.directory ? deflateRawSync(raw) : raw
    const methodId = method === 'deflate' && !entry.directory ? 8 : 0
    const checksum = crc32(raw) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(methodId, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuffer, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(methodId, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(entry.directory === true ? 0x10 : 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuffer)

    offset += local.length + nameBuffer.length + compressed.length
  }
  const localDirectory = Buffer.concat(localParts)
  const centralDirectory = Buffer.concat(centralParts)
  const locator = Buffer.alloc(zip64 ? 20 : 0)
  if (zip64) {
    locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0)
    locator.writeUInt32LE(0, 4)
    locator.writeBigUInt64LE(0n, 8)
    locator.writeUInt32LE(1, 16)
  }
  const eocd = Buffer.alloc(22 + commentBuffer.length)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8)
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10)
  eocd.writeUInt32LE(zip64 ? 0xffffffff : centralDirectory.length, 12)
  eocd.writeUInt32LE(zip64 ? 0xffffffff : localDirectory.length, 16)
  eocd.writeUInt16LE(commentBuffer.length, 20)
  commentBuffer.copy(eocd, 22)
  return Buffer.concat([localDirectory, centralDirectory, locator, eocd])
}

/** Convenience wrapper for a stored-method archive. */
export function makeStoredZip(entries, options = {}) {
  return makeZip(entries, { ...options, method: 'stored' })
}

/** Convenience wrapper for a deflate-method archive. */
export function makeDeflatedZip(entries, options = {}) {
  return makeZip(entries, { ...options, method: 'deflate' })
}
