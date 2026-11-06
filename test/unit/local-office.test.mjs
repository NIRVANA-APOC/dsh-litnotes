/**
 * Unit tests for the T0.5 Office→PDF adapter (`lib/local-office.js`).
 *
 * The adapter is a thin, observable boundary: DSH's optional `officeToPdf`
 * service converts the file, then the builtin pdf.js extractor runs. These
 * tests pin the call convention (extension/priority/source.read/version) and
 * the complete error-code mapping without requiring the real service.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OFFICE_EXTENSIONS,
  convertOfficeToPdf,
  isOfficeExtension,
} from '../../lib/local-office.js'
import { WireError } from '../../lib/wire.js'

/** A converted-PDF payload as the DSH service returns it. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

/** Fake `officeToPdf` service recording convert() calls. */
function createFakeOffice({ result = { pdf: PDF_BYTES, missingFonts: [] }, error = null } = {}) {
  const calls = []
  return {
    calls,
    async convert(request, signal) {
      calls.push({ request, signal })
      if (error !== null) throw error
      return result
    },
  }
}

/** Run one conversion with sensible defaults. */
function convert(overrides = {}) {
  const officeToPdf = overrides.officeToPdf ?? createFakeOffice()
  return convertOfficeToPdf({
    officeToPdf,
    meta: { id: 'doc-1', ext: '.docx', size: 1234, sha256: 'abc123' },
    readSource: async () => new Uint8Array([1, 2, 3]),
    ...overrides,
  })
}

test('office extension helpers cover the DSH converter formats', () => {
  for (const ext of ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']) {
    assert.equal(isOfficeExtension(ext), true, ext)
    assert.ok(OFFICE_EXTENSIONS.has(ext))
  }
  for (const ext of ['.pdf', '.png', '.docm', '', undefined, null]) {
    assert.equal(isOfficeExtension(ext), false, String(ext))
  }
  assert.equal(isOfficeExtension('.DOCX'), true, 'extensions are case-insensitive')
})

test('converts through the service with the documented call convention', async () => {
  const officeToPdf = createFakeOffice({ result: { pdf: PDF_BYTES, missingFonts: ['Calibri', 7, 'Arial'] } })
  const reads = []
  const result = await convert({
    officeToPdf,
    readSource: async (maxBytes) => {
      reads.push(maxBytes)
      return new Uint8Array([9, 9, 9])
    },
    maxBytes: 4096,
  })

  assert.equal(officeToPdf.calls.length, 1)
  const { request, signal } = officeToPdf.calls[0]
  assert.equal(request.extension, 'docx', 'extension is passed without the dot')
  assert.equal(request.priority, 'foreground')
  assert.equal(request.source.key, 'doc-1')
  assert.equal(request.source.version, 'abc123', 'sha256 is the preferred source version')
  assert.equal(request.source.bytes, 1234)
  assert.equal(signal, undefined)

  const read = await request.source.read(undefined, 2048)
  assert.deepEqual(reads, [2048], 'read() honours the smaller reserved-bytes budget')
  assert.ok(read.bytes instanceof Uint8Array)
  assert.deepEqual([...read.bytes], [9, 9, 9])
  assert.equal(read.version, 'abc123')

  assert.ok(result.pdf instanceof Uint8Array)
  assert.deepEqual(result.missingFonts, ['Calibri', 'Arial'], 'non-string fonts are filtered')
})

test('source.read falls back to maxBytes and detects cancellation', async () => {
  const officeToPdf = createFakeOffice()
  const reads = []
  await convert({
    officeToPdf,
    readSource: async (maxBytes) => {
      reads.push(maxBytes)
      return new Uint8Array([1])
    },
    maxBytes: 2048,
  })
  await officeToPdf.calls[0].request.source.read(undefined, undefined)
  assert.deepEqual(reads, [2048], 'no reservedBytes -> maxBytes')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => officeToPdf.calls[0].request.source.read(controller.signal, undefined),
    (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})

test('missing service throws local-missing-tool', async () => {
  for (const officeToPdf of [undefined, null, {}, { convert: 'nope' }]) {
    await assert.rejects(
      () => convert({ officeToPdf }),
      (error) => {
        assert.ok(error instanceof WireError)
        assert.equal(error.code, 'local-missing-tool')
        assert.equal(error.status, 503)
        return true
      },
    )
  }
})

test('non-Office extensions are rejected before conversion', async () => {
  const officeToPdf = createFakeOffice()
  await assert.rejects(
    () => convert({ officeToPdf, meta: { id: 'doc-1', ext: '.pdf' } }),
    (error) => {
      assert.equal(error.code, 'local-unsupported')
      assert.equal(error.status, 415)
      return true
    },
  )
  assert.equal(officeToPdf.calls.length, 0, 'the service is never called for unsupported types')
})

test('service error codes map onto WireError codes', async () => {
  const mapping = [
    ['input-too-large', 'too-large', 413],
    ['output-too-large', 'too-large', 413],
    ['invalid-document', 'local-unsupported', 422],
    ['unsupported-format', 'local-unsupported', 422],
    ['invalid-output', 'local-unsupported', 422],
    ['timeout', 'local-failed', 500],
    ['unavailable', 'local-missing-tool', 503],
    ['busy', 'local-missing-tool', 503],
    ['source-changed', 'local-failed', 500],
    ['something-new', 'local-failed', 500],
  ]
  for (const [code, expected, status] of mapping) {
    const error = Object.assign(new Error(`boom ${code}`), { code })
    await assert.rejects(
      () => convert({ officeToPdf: createFakeOffice({ error }) }),
      (thrown) => {
        assert.ok(thrown instanceof WireError)
        assert.equal(thrown.code, expected, `service code ${code}`)
        assert.equal(thrown.status, status, `service code ${code} status`)
        return true
      },
    )
  }
})

test('a WireError thrown by the service passes through unchanged', async () => {
  const original = new WireError('local-encrypted', 'encrypted source', 422)
  await assert.rejects(
    () => convert({ officeToPdf: createFakeOffice({ error: original }) }),
    (error) => {
      assert.equal(error, original)
      return true
    },
  )
})

test('cancellation and invalid results fail safely', async () => {
  const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' })
  await assert.rejects(
    () => convert({ officeToPdf: createFakeOffice({ error: aborted }) }),
    (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  // A pre-aborted caller signal wins over service errors.
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => convert({ officeToPdf: createFakeOffice({ error: new Error('ignored') }), signal: controller.signal }),
    (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  for (const result of [{}, { pdf: null }, { pdf: new Uint8Array([]) }, { pdf: 'not bytes' }]) {
    await assert.rejects(
      () => convert({ officeToPdf: createFakeOffice({ result }) }),
      (error) => {
        assert.equal(error.code, 'local-failed')
        assert.equal(error.status, 500)
        return true
      },
    )
  }
})
