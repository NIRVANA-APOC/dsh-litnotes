/**
 * Dependency-free in-memory ZIP reader sufficient for MinerU result archives.
 *
 * Reads the End Of Central Directory record, walks the central directory and
 * then each local header. Stored (method 0) and deflate (method 8) entries are
 * supported; ZIP64 archives are rejected because MinerU result archives are
 * far below the 4 GiB boundary and accepting ZIP64 would mean trusting 64-bit
 * offsets from an untrusted archive.
 *
 * Every entry name is normalized to `/` separators and checked for path
 * traversal before it can reach the caller: unsafe entries are skipped and
 * recorded in `warnings` instead of being extracted. Size/count caps bound the
 * memory an archive can force the host to allocate.
 *
 * @module lib/unzip
 */
import { crc32, inflateRawSync } from 'node:zlib'

/** End Of Central Directory signature. */
const EOCD_SIGNATURE = 0x06054b50
/** Central directory file header signature. */
const CENTRAL_SIGNATURE = 0x02014b50
/** Local file header signature. */
const LOCAL_SIGNATURE = 0x04034b50
/** ZIP64 End Of Central Directory Locator signature. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
/** 0xFFFFFFFF marks a 64-bit field that lives in a ZIP64 extra record. */
const ZIP64_MARKER = 0xffffffff

/** Default bounds; callers may tighten but not rely on the archive's own claims. */
export const ZIP_DEFAULT_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
})

/** Create an Error carrying a stable machine code. */
function zipError(code, message) {
  const error = new Error(`unzip: ${message}`)
  error.code = code
  return error
}

/** Read a little-endian uint32 with a bounds check. */
function readU32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) throw zipError('zip-truncated', 'unexpected end of archive')
  return buffer.readUInt32LE(offset)
}

/** Read a little-endian uint16 with a bounds check. */
function readU16(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) throw zipError('zip-truncated', 'unexpected end of archive')
  return buffer.readUInt16LE(offset)
}

/**
 * Locate the End Of Central Directory record at the end of the buffer.
 * The record is followed by a comment of 0..65535 bytes, so the search window
 * is bounded by the maximum possible comment size.
 */
function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) throw zipError('zip-truncated', 'not a ZIP archive (too short)')
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  throw zipError('zip-invalid', 'end of central directory record not found')
}

/**
 * Normalize one archive entry name and reject anything that could escape the
 * extraction root.
 *
 * @param {string} rawName - name as stored in the ZIP central directory.
 * @returns {{ name: string, directory: boolean, reason: string | null }} result;
 *   `reason` is non-null for unsafe / unusable names.
 */
function normalizeEntryName(rawName) {
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
 * Verify the CRC-32 recorded in the central directory when the runtime offers
 * `zlib.crc32` (Node >= 22.2). Older runtimes skip the check.
 * @param {Buffer} data - extracted bytes.
 * @param {number} expected - CRC-32 from the archive.
 * @param {string} name - entry name for the error message.
 */
function verifyCrc(data, expected, name) {
  if (typeof crc32 !== 'function') return
  const actual = crc32(data) >>> 0
  if (actual !== (expected >>> 0)) throw zipError('zip-invalid', `CRC mismatch for ${name}`)
}

/**
 * Extract every eligible entry of a ZIP archive into memory.
 *
 * @param {Buffer | Uint8Array} buffer - complete archive bytes.
 * @param {{
 *   filter?: (name: string) => boolean,
 *   maxEntries?: number,
 *   maxTotalBytes?: number,
 *   maxEntryBytes?: number,
 * } | undefined} [options] - optional entry filter and resource caps.
 * @returns {{ entries: Array<{ name: string, data: Buffer }>, skipped: number, warnings: string[] }}
 *   extracted entries in archive order, the number of skipped entries, and
 *   human-readable warnings for skipped unsafe entries.
 * @throws {Error} with `code` `zip-invalid` / `zip-truncated` / `zip-limit` /
 *   `zip-unsupported` when the archive is malformed, exceeds a cap, is
 *   encrypted, or is ZIP64.
 */
export function unzip(buffer, options = {}) {
  const {
    filter,
    maxEntries = ZIP_DEFAULT_LIMITS.maxEntries,
    maxTotalBytes = ZIP_DEFAULT_LIMITS.maxTotalBytes,
    maxEntryBytes = ZIP_DEFAULT_LIMITS.maxEntryBytes,
  } = options
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw zipError('zip-invalid', 'expected a Buffer of archive bytes')
  }
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const eocdOffset = findEndOfCentralDirectory(source)

  const diskNumber = readU16(source, eocdOffset + 4)
  const centralDisk = readU16(source, eocdOffset + 6)
  const entriesOnDisk = readU16(source, eocdOffset + 8)
  const totalEntries = readU16(source, eocdOffset + 10)
  const centralSize = readU32(source, eocdOffset + 12)
  const centralOffset = readU32(source, eocdOffset + 16)

  // ZIP64 is recognised by the locator, the 0xFFFF entry count sentinel, or
  // any 0xFFFFFFFF 32-bit offset/size.
  if (eocdOffset >= 20 && readU32(source, eocdOffset - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw zipError('zip-unsupported', 'ZIP64 archives are not supported')
  }
  if (
    totalEntries === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralSize === ZIP64_MARKER ||
    centralOffset === ZIP64_MARKER
  ) {
    throw zipError('zip-unsupported', 'ZIP64 archives are not supported')
  }
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw zipError('zip-unsupported', 'multi-disk ZIP archives are not supported')
  }
  if (totalEntries > maxEntries) {
    throw zipError('zip-limit', `archive has ${totalEntries} entries (limit ${maxEntries})`)
  }
  if (centralOffset + centralSize > source.length) {
    throw zipError('zip-truncated', 'central directory exceeds archive size')
  }

  const entries = []
  const warnings = []
  let skipped = 0
  let totalBytes = 0
  let cursor = centralOffset

  for (let index = 0; index < totalEntries; index += 1) {
    if (readU32(source, cursor) !== CENTRAL_SIGNATURE) {
      throw zipError('zip-invalid', `bad central directory signature at entry ${index}`)
    }
    const flags = readU16(source, cursor + 8)
    const method = readU16(source, cursor + 10)
    const expectedCrc = readU32(source, cursor + 16)
    const compressedSize = readU32(source, cursor + 20)
    const uncompressedSize = readU32(source, cursor + 24)
    const nameLength = readU16(source, cursor + 28)
    const extraLength = readU16(source, cursor + 30)
    const commentLength = readU16(source, cursor + 32)
    const localOffset = readU32(source, cursor + 42)
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength
    if (nextCursor > source.length) throw zipError('zip-truncated', 'central directory entry exceeds archive size')
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localOffset === ZIP64_MARKER
    ) {
      throw zipError('zip-unsupported', 'ZIP64 archives are not supported')
    }
    if ((flags & 0x1) !== 0) throw zipError('zip-unsupported', 'encrypted ZIP entries are not supported')

    const rawName = source.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor = nextCursor

    const normalized = normalizeEntryName(rawName)
    if (normalized.directory) continue
    if (normalized.reason !== null) {
      skipped += 1
      warnings.push(`skipped unsafe entry ${JSON.stringify(rawName)}: ${normalized.reason}`)
      continue
    }
    const name = normalized.name
    if (typeof filter === 'function' && !filter(name)) {
      skipped += 1
      continue
    }
    if (uncompressedSize > maxEntryBytes) {
      throw zipError('zip-limit', `entry ${name} is ${uncompressedSize} bytes (limit ${maxEntryBytes})`)
    }
    if (totalBytes + uncompressedSize > maxTotalBytes) {
      throw zipError('zip-limit', `archive expands beyond ${maxTotalBytes} bytes`)
    }

    if (readU32(source, localOffset) !== LOCAL_SIGNATURE) {
      throw zipError('zip-invalid', `bad local file header for ${name}`)
    }
    const localNameLength = readU16(source, localOffset + 26)
    const localExtraLength = readU16(source, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataStart > source.length || dataEnd > source.length) {
      throw zipError('zip-truncated', `entry ${name} data exceeds archive size`)
    }
    const raw = source.subarray(dataStart, dataEnd)

    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize || 1) })
      } catch {
        throw zipError('zip-invalid', `cannot inflate entry ${name}`)
      }
    } else {
      throw zipError('zip-unsupported', `compression method ${method} is not supported (${name})`)
    }
    if (data.length !== uncompressedSize) {
      throw zipError('zip-invalid', `size mismatch for ${name}`)
    }
    verifyCrc(data, expectedCrc, name)
    totalBytes += data.length
    entries.push({ name, data })
  }

  return { entries, skipped, warnings }
}
