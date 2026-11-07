/**
 * Typed ZIP writer for the parse-pipeline tests, built on **fflate** `zipSync`.
 *
 * The extractor under test (`src/host/parse/unzip.ts`) must be verified against
 * archives written by a different code path, so this helper uses fflate's
 * writer rather than the extractor's own reader. It supports the two methods
 * MinerU uses (stored and deflate), UTF-8 names, an archive comment, and
 * buffer-patching helpers that fabricate the adversarial shapes the frozen 1.0.0
 * security tests need: a fake ZIP64 archive, a tampered entry method, a fake
 * 64-bit central-directory size and a corrupted entry payload with an intact
 * CRC.
 *
 * This module declares no tests of its own; it is imported by the unzip and
 * parse-manager tests.
 *
 * @module test/helpers/zip-builder
 */

import * as zlib from 'node:zlib'
import { strToU8, zipSync } from 'fflate'

/** One file/directory entry written into an archive. */
export interface ZipTestEntry {
  /** Archive path; a trailing `/` marks a directory record. */
  name: string
  /** Entry bytes; ignored for directory records. */
  data?: string | Uint8Array
  /** Whether this is an explicit directory record (name should end with `/`). */
  directory?: boolean
}

/** Compression methods the helper can write. */
export type ZipTestMethod = 'stored' | 'deflate'

/** Options accepted by {@link makeZip}. */
export interface ZipTestOptions {
  /** `stored` (method 0) or `deflate` (method 8, the default). */
  method?: ZipTestMethod
  /** Archive comment written after the End Of Central Directory record. */
  comment?: string
}

/** Signature of the End Of Central Directory record. */
const EOCD_SIGNATURE = 0x06054b50
/** Signature of the central-directory file header. */
const CENTRAL_SIGNATURE = 0x02014b50
/** Signature of the ZIP64 End Of Central Directory Locator. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
/** 0xFFFFFFFF marks a 64-bit field in a ZIP64 archive. */
const ZIP64_MARKER = 0xffffffff

/** Coerce one entry's data to a `Uint8Array`. */
function entryBytes(data: string | Uint8Array | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array(0)
  return typeof data === 'string' ? strToU8(data) : data
}

/**
 * Build a ZIP archive in memory with fflate's writer.
 *
 * @param entries - files and directory records in archive order.
 * @param options - compression method and archive comment.
 * @returns the complete archive bytes.
 */
export function makeZip(entries: ZipTestEntry[], options: ZipTestOptions = {}): Buffer<ArrayBuffer> {
  const { method = 'deflate', comment = '' } = options
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  for (const entry of entries) {
    const name = entry.directory === true && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name
    files[name] = [entryBytes(entry.data), { level: method === 'stored' ? 0 : 6 }]
  }
  const archive = zipSync(files, comment === '' ? {} : { comment })
  return Buffer.from(archive)
}

/** Convenience wrapper for a stored-method archive (method 0). */
export function makeStoredZip(entries: ZipTestEntry[], options: Omit<ZipTestOptions, 'method'> = {}): Buffer<ArrayBuffer> {
  return makeZip(entries, { ...options, method: 'stored' })
}

/** Convenience wrapper for a deflated archive (method 8). */
export function makeDeflatedZip(entries: ZipTestEntry[], options: Omit<ZipTestOptions, 'method'> = {}): Buffer<ArrayBuffer> {
  return makeZip(entries, { ...options, method: 'deflate' })
}

/**
 * Locate the End Of Central Directory record (the archive has no comment in the
 * shapes this helper builds; the scan is bounded by the ZIP comment cap anyway).
 *
 * @param archive - complete archive bytes.
 * @returns byte offset of the EOCD signature.
 */
export function findEocdOffset(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - 22 - 0xffff)
  for (let offset = archive.length - 22; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('zip-builder: end of central directory record not found')
}

/** Byte offset of the central directory, read from the EOCD record. */
export function centralDirectoryOffset(archive: Buffer): number {
  const eocd = findEocdOffset(archive)
  if (archive.readUInt32LE(eocd) !== EOCD_SIGNATURE) {
    throw new Error('zip-builder: bad EOCD signature')
  }
  return archive.readUInt32LE(eocd + 16)
}

/** Byte offset of the central-directory record for one entry (in archive order). */
export function centralRecordOffset(archive: Buffer, index: number): number {
  let cursor = centralDirectoryOffset(archive)
  for (let current = 0; current < index; current += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`zip-builder: bad central signature at record ${current}`)
    }
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return cursor
}

/**
 * Rewrite a normal archive into the "fake ZIP64" shape the security tests use:
 * append a ZIP64 locator, and set the EOCD entry/size/offset fields to their
 * 0xFFFF / 0xFFFFFFFF sentinels. The archive payload itself stays valid, so
 * only a ZIP64 policy check can reject it.
 *
 * @param archive - a normal archive produced by {@link makeZip}.
 * @returns patched archive bytes (a new buffer).
 */
export function patchToFakeZip64(archive: Buffer): Buffer {
  const eocd = findEocdOffset(archive)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(0n, 8)
  locator.writeUInt32LE(1, 16)
  const patched = Buffer.concat([archive.subarray(0, eocd), locator, archive.subarray(eocd)])
  const newEocd = eocd + locator.length
  patched.writeUInt16LE(0xffff, newEocd + 8)
  patched.writeUInt16LE(0xffff, newEocd + 10)
  patched.writeUInt32LE(ZIP64_MARKER, newEocd + 12)
  patched.writeUInt32LE(ZIP64_MARKER, newEocd + 16)
  return patched
}

/**
 * Patch the EOCD "size of central directory" field to the ZIP64 sentinel while
 * leaving everything else intact (frozen adversarial test).
 *
 * @param archive - a normal archive (ideally comment-free).
 * @returns the same buffer, patched in place.
 */
export function patchCentralSizeSentinel(archive: Buffer): Buffer {
  const eocd = findEocdOffset(archive)
  archive.writeUInt32LE(ZIP64_MARKER, eocd + 12)
  return archive
}

/**
 * Patch the compression method of the first entry in both the local header and
 * the central-directory record, simulating a method the extractor must reject.
 *
 * @param archive - a normal archive.
 * @param method - the (unsupported) method number to write, e.g. 12 (bzip2).
 * @returns the same buffer, patched in place.
 */
export function patchFirstEntryMethod(archive: Buffer, method: number): Buffer {
  const central = centralRecordOffset(archive, 0)
  const localOffset = archive.readUInt32LE(central + 42)
  archive.writeUInt16LE(method, localOffset + 8)
  archive.writeUInt16LE(method, central + 10)
  return archive
}

/**
 * Corrupt the payload bytes of the first stored entry while leaving the CRC in
 * the headers untouched (frozen CRC-mismatch test).
 *
 * @param archive - a stored-method archive.
 * @param target - the original payload byte sequence to corrupt (same length).
 * @param replacement - replacement bytes of identical length.
 * @returns the same buffer, patched in place.
 */
export function corruptPayload(archive: Buffer, target: string, replacement: string): Buffer {
  const expected = Buffer.from(target, 'utf8')
  const actual = Buffer.from(replacement, 'utf8')
  if (actual.length !== expected.length) throw new Error('corruptPayload: replacement length must match')
  const index = archive.indexOf(expected)
  if (index < 0) throw new Error('corruptPayload: target payload not found')
  actual.copy(archive, index)
  return archive
}

/** CRC-32 of the given bytes, using the runtime implementation (Node >= 22.2). */
export function crc32(data: Uint8Array): number {
  if (typeof zlib.crc32 !== 'function') throw new Error('crc32 is not available in this Node runtime')
  return zlib.crc32(data) >>> 0
}

/** UTF-8 encode a string for archive entries. */
export { strToU8 }
