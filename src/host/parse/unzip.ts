/**
 * In-memory ZIP extraction for MinerU result archives, built on **fflate**.
 *
 * MinerU returns parse results as a ZIP (`full.md`, `*_content_list.json`,
 * `images/**`). That archive is untrusted: it must never write outside the
 * document directory, expand unbounded memory, or smuggle a hostile entry name
 * back into the library tree. This module keeps the frozen 1.0.0 extraction
 * contract while moving the actual archive parsing and inflate/deflate work to
 * `fflate`:
 *
 *  - `fflate.unzipSync` walks the central directory, local headers and payloads
 *    and performs the decompression (stored + deflate).
 *  - A small **security preflight** reads the End Of Central Directory record and
 *    the central-directory records first. This is not a second ZIP reader: it
 *    exists because fflate intentionally exposes neither CRC verification nor
 *    ZIP64 policy, and because every cap must be enforced *before* any
 *    decompression starts (a ZIP bomb claimed size must not be allocated).
 *  - Entry names are normalized to `/`, path traversal is rejected and recorded
 *    as `warnings`, and `skipped` counts every entry the caller (or the safety
 *    rules) filtered out, matching the frozen implementation.
 *
 * The caller receives `{ entries, skipped, warnings }` with `entries` in
 * archive order; each entry carries raw `Buffer` bytes.
 *
 * @module host/parse/unzip
 */

import * as zlib from 'node:zlib'
import { unzipSync } from 'fflate'
import type { Unzipped } from 'fflate'

/** End Of Central Directory signature (`PK\x05\x06`). */
const EOCD_SIGNATURE = 0x06054b50
/** Central directory file header signature (`PK\x01\x02`). */
const CENTRAL_SIGNATURE = 0x02014b50
/** ZIP64 End Of Central Directory Locator signature (`PK\x06\x07`). */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
/** 0xFFFFFFFF marks a 64-bit field that lives in a ZIP64 extra record. */
const ZIP64_MARKER = 0xffffffff
/** Bytes of the fixed EOCD record (without the archive comment). */
const EOCD_SIZE = 22
/** Bytes of the fixed central-directory file header (without name/extra/comment). */
const CENTRAL_HEADER_SIZE = 46

/** Default resource caps; callers may tighten them but never trust the archive. */
export const ZIP_DEFAULT_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
})

/** Stable machine-readable ZIP failure codes. */
export type ZipErrorCode = 'zip-invalid' | 'zip-truncated' | 'zip-limit' | 'zip-unsupported'

/** Error raised by {@link unzip}; `code` is the branchable ZIP failure class. */
export class ZipError extends Error {
  /** Machine-readable failure class. */
  readonly code: ZipErrorCode

  constructor(code: ZipErrorCode, message: string) {
    super(`unzip: ${message}`)
    this.name = 'ZipError'
    this.code = code
  }
}

/** One extracted archive entry (raw bytes, normalized path). */
export interface UnzipEntry {
  /** Normalized archive path (forward slashes, no leading `./`). */
  name: string
  /** Extracted bytes. */
  data: Buffer
}

/** Result of one in-memory extraction. */
export interface UnzipResult {
  /** Extracted entries in archive order. */
  entries: UnzipEntry[]
  /** Number of entries dropped by the safety rules or the caller's filter. */
  skipped: number
  /** Human-readable warnings for entries skipped because their name is unsafe. */
  warnings: string[]
}

/** Optional extraction controls. */
export interface UnzipOptions {
  /** Keep only entries whose normalized name passes this predicate. */
  filter?: (name: string) => boolean
  /** Maximum number of central-directory entries (default 5000). */
  maxEntries?: number
  /** Maximum sum of uncompressed bytes for extracted entries (default 512 MiB). */
  maxTotalBytes?: number
  /** Maximum uncompressed byte size of one extracted entry (default 128 MiB). */
  maxEntryBytes?: number
}

/** One validated central-directory record that will be extracted. */
interface AcceptedEntry {
  /** Normalized entry name (forward slashes). */
  name: string
  /** CRC-32 recorded in the central directory. */
  crc: number
  /** Uncompressed byte size recorded in the central directory. */
  uncompressedSize: number
}

/** One central-directory record as stored in the archive. */
interface CentralRecord {
  rawName: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

/** The normalized form of one archive entry name. */
interface NormalizedName {
  name: string
  directory: boolean
  reason: string | null
}

/** Narrow a value to a `number` error code field without trusting its shape. */
function errorCodeOf(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null
  const code: unknown = (value as { code?: unknown }).code
  return typeof code === 'number' && Number.isInteger(code) ? code : null
}

/** Create a {@link ZipError}. */
function zipError(code: ZipErrorCode, message: string): ZipError {
  return new ZipError(code, message)
}

/** Read a little-endian uint32 with a bounds check. */
function readU32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) throw zipError('zip-truncated', 'unexpected end of archive')
  return buffer.readUInt32LE(offset)
}

/** Read a little-endian uint16 with a bounds check. */
function readU16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) throw zipError('zip-truncated', 'unexpected end of archive')
  return buffer.readUInt16LE(offset)
}

/**
 * Locate the End Of Central Directory record.
 *
 * The record is followed by a 0..65535 byte archive comment, so the search
 * window is bounded by that maximum comment length. Only the fixed record is
 * read here; `fflate` requires the same record to be present.
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_SIZE) throw zipError('zip-truncated', 'not a ZIP archive (too short)')
  const lowest = Math.max(0, buffer.length - EOCD_SIZE - 0xffff)
  for (let offset = buffer.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (readU32(buffer, offset) !== EOCD_SIGNATURE) continue
    const commentLength = readU16(buffer, offset + 20)
    if (offset + EOCD_SIZE + commentLength === buffer.length) return offset
  }
  throw zipError('zip-invalid', 'end of central directory record not found')
}

/**
 * Normalize one archive entry name and reject anything that could escape the
 * extraction root.
 *
 * @param rawName - name as stored in the ZIP central directory.
 * @returns normalized name; `reason` is non-null for unsafe / unusable names.
 */
function normalizeEntryName(rawName: string): NormalizedName {
  let name = String(rawName).replace(/\\/g, '/')
  while (name.startsWith('./')) name = name.slice(2)
  if (name === '') return { name, directory: true, reason: null }
  if (name.includes('\0')) return { name, directory: false, reason: 'entry name contains a NUL byte' }
  if (name.startsWith('/')) return { name, directory: false, reason: 'absolute entry path' }
  if (/^[A-Za-z]:/.test(name)) return { name, directory: false, reason: 'drive-letter entry path' }
  const directory = name.endsWith('/')
  const segments = name.split('/')
  if (segments.some((segment) => segment === '..')) {
    return { name, directory: false, reason: 'path traversal segment' }
  }
  if (!directory && segments[segments.length - 1] === '') {
    return { name, directory: false, reason: 'empty entry name' }
  }
  return { name, directory, reason: null }
}

/**
 * Reject ZIP64 archives and multi-disk archives before any entry is parsed.
 *
 * MinerU result archives are far below the 4 GiB boundary; accepting ZIP64
 * would mean trusting 64-bit offsets/sizes from an untrusted archive, so the
 * frozen contract rejects them. fflate itself would read a ZIP64 archive, so
 * this policy check has to happen here.
 *
 * @param buffer - complete archive bytes.
 * @param eocdOffset - offset of the End Of Central Directory record.
 */
function assertSupportedArchiveShape(buffer: Buffer, eocdOffset: number): void {
  if (eocdOffset >= 20 && readU32(buffer, eocdOffset - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw zipError('zip-unsupported', 'ZIP64 archives are not supported')
  }
  const entriesOnDisk = readU16(buffer, eocdOffset + 8)
  const totalEntries = readU16(buffer, eocdOffset + 10)
  const centralSize = readU32(buffer, eocdOffset + 12)
  const centralOffset = readU32(buffer, eocdOffset + 16)
  if (
    totalEntries === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralSize === ZIP64_MARKER ||
    centralOffset === ZIP64_MARKER
  ) {
    throw zipError('zip-unsupported', 'ZIP64 archives are not supported')
  }
  const diskNumber = readU16(buffer, eocdOffset + 4)
  const centralDisk = readU16(buffer, eocdOffset + 6)
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw zipError('zip-unsupported', 'multi-disk ZIP archives are not supported')
  }
}

/** Read one central-directory record starting at `cursor`. */
function readCentralRecord(buffer: Buffer, cursor: number, index: number): { record: CentralRecord; next: number } {
  if (readU32(buffer, cursor) !== CENTRAL_SIGNATURE) {
    throw zipError('zip-invalid', `bad central directory signature at entry ${index}`)
  }
  const flags = readU16(buffer, cursor + 8)
  const method = readU16(buffer, cursor + 10)
  const crc = readU32(buffer, cursor + 16)
  const compressedSize = readU32(buffer, cursor + 20)
  const uncompressedSize = readU32(buffer, cursor + 24)
  const nameLength = readU16(buffer, cursor + 28)
  const extraLength = readU16(buffer, cursor + 30)
  const commentLength = readU16(buffer, cursor + 32)
  const localOffset = readU32(buffer, cursor + 42)
  const next = cursor + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
  if (next > buffer.length) throw zipError('zip-truncated', 'central directory entry exceeds archive size')
  if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
    throw zipError('zip-unsupported', 'ZIP64 archives are not supported')
  }
  if ((flags & 0x1) !== 0) throw zipError('zip-unsupported', 'encrypted ZIP entries are not supported')
  const rawName = buffer.toString('utf8', cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength)
  return {
    record: { rawName, method, flags, crc, compressedSize, uncompressedSize, localOffset },
    next,
  }
}

/** CRC-32 implementation exposed by the runtime, when available (Node >= 22.2). */
const runtimeCrc32: ((data: Uint8Array) => number) | undefined =
  typeof zlib.crc32 === 'function' ? zlib.crc32 : undefined

/**
 * Verify the CRC-32 recorded in the central directory when the runtime offers
 * `zlib.crc32`. Older runtimes skip the check (frozen 1.0.0 behaviour).
 */
function verifyCrc(data: Buffer, expected: number, name: string): void {
  if (runtimeCrc32 === undefined) return
  const actual = runtimeCrc32(data) >>> 0
  if (actual !== expected >>> 0) throw zipError('zip-invalid', `CRC mismatch for ${name}`)
}

/**
 * Convert one failure thrown by fflate into a frozen-contract {@link ZipError}.
 *
 * fflate reports a numeric `code` on its `FlateError`; code 14 (`unknown
 * compression method`) maps to `zip-unsupported`, every other malformed-archive
 * failure maps to `zip-invalid`.
 */
function mapFlateError(error: unknown): ZipError {
  if (error instanceof ZipError) return error
  const code = errorCodeOf(error)
  const message = error instanceof Error ? error.message : String(error)
  if (code === 14) return zipError('zip-unsupported', message || 'unsupported compression method')
  return zipError('zip-invalid', message || 'cannot extract archive')
}

/**
 * Extract every eligible entry of a ZIP archive into memory.
 *
 * @param buffer - complete archive bytes.
 * @param options - optional entry filter and resource caps.
 * @returns extracted entries in archive order, the number of skipped entries,
 *   and human-readable warnings for skipped unsafe entries.
 * @throws {ZipError} `zip-invalid` / `zip-truncated` / `zip-limit` /
 *   `zip-unsupported` when the archive is malformed, exceeds a cap, is
 *   encrypted, multi-disk or ZIP64.
 */
export function unzip(buffer: Uint8Array, options: UnzipOptions = {}): UnzipResult {
  if (!(buffer instanceof Uint8Array)) {
    throw zipError('zip-invalid', 'expected a Buffer of archive bytes')
  }
  const {
    filter,
    maxEntries = ZIP_DEFAULT_LIMITS.maxEntries,
    maxTotalBytes = ZIP_DEFAULT_LIMITS.maxTotalBytes,
    maxEntryBytes = ZIP_DEFAULT_LIMITS.maxEntryBytes,
  } = options
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const eocdOffset = findEndOfCentralDirectory(source)
  assertSupportedArchiveShape(source, eocdOffset)
  const totalEntries = readU16(source, eocdOffset + 10)
  const centralSize = readU32(source, eocdOffset + 12)
  const centralOffset = readU32(source, eocdOffset + 16)
  if (totalEntries > maxEntries) {
    throw zipError('zip-limit', `archive has ${totalEntries} entries (limit ${maxEntries})`)
  }
  if (centralOffset + centralSize > source.length) {
    throw zipError('zip-truncated', 'central directory exceeds archive size')
  }

  // Preflight the central directory: reject unsafe names, unsupported layouts
  // and cap violations before fflate decompresses a single byte.
  const accepted: AcceptedEntry[] = []
  const warnings: string[] = []
  let skipped = 0
  let totalBytes = 0
  let cursor = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    const { record, next } = readCentralRecord(source, cursor, index)
    cursor = next
    const normalized = normalizeEntryName(record.rawName)
    if (normalized.directory) continue
    if (normalized.reason !== null) {
      skipped += 1
      warnings.push(`skipped unsafe entry ${JSON.stringify(record.rawName)}: ${normalized.reason}`)
      continue
    }
    if (typeof filter === 'function' && !filter(normalized.name)) {
      skipped += 1
      continue
    }
    if (record.compressedSize === ZIP64_MARKER || record.uncompressedSize === ZIP64_MARKER) {
      throw zipError('zip-unsupported', 'ZIP64 archives are not supported')
    }
    if (record.method !== 0 && record.method !== 8) {
      throw zipError(
        'zip-unsupported',
        `compression method ${record.method} is not supported (${normalized.name})`,
      )
    }
    if (record.uncompressedSize > maxEntryBytes) {
      throw zipError(
        'zip-limit',
        `entry ${normalized.name} is ${record.uncompressedSize} bytes (limit ${maxEntryBytes})`,
      )
    }
    if (totalBytes + record.uncompressedSize > maxTotalBytes) {
      throw zipError('zip-limit', `archive expands beyond ${maxTotalBytes} bytes`)
    }
    totalBytes += record.uncompressedSize
    accepted.push({ name: normalized.name, crc: record.crc, uncompressedSize: record.uncompressedSize })
  }

  if (accepted.length === 0) return { entries: [], skipped, warnings }

  // Decompress with fflate. The filter is fflate's pre-decompression hook: it
  // re-checks the name (fflate may decode a non-UTF-8 name differently) and
  // only lets preflighted entries through. Central-directory order is the same
  // order fflate walks, so a matching normalized name is enough.
  const acceptedNames = new Set(accepted.map((entry) => entry.name))
  const rawNameFor = new Map<string, string>()
  let extracted: Unzipped
  try {
    extracted = unzipSync(source, {
      filter: (file) => {
        const normalized = normalizeEntryName(file.name)
        if (normalized.directory || normalized.reason !== null) return false
        if (!acceptedNames.has(normalized.name)) return false
        rawNameFor.set(normalized.name, file.name)
        return true
      },
    })
  } catch (error) {
    throw mapFlateError(error)
  }

  const entries: UnzipEntry[] = []
  for (const record of accepted) {
    const rawName = rawNameFor.get(record.name)
    if (rawName === undefined) {
      throw zipError('zip-invalid', `cannot extract entry ${record.name}`)
    }
    const bytes = extracted[rawName]
    if (bytes === undefined) {
      throw zipError('zip-invalid', `cannot extract entry ${record.name}`)
    }
    const data = Buffer.from(bytes)
    if (data.length !== record.uncompressedSize) {
      throw zipError('zip-invalid', `size mismatch for ${record.name}`)
    }
    verifyCrc(data, record.crc, record.name)
    entries.push({ name: record.name, data })
  }
  return { entries, skipped, warnings }
}
