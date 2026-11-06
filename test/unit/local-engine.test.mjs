/**
 * Unit tests for the local engine facade (`lib/local-engine.js`).
 *
 * The engine is the T0/T0.5 orchestration layer: capability snapshot,
 * support/probe resolution, limit validation and artifact synthesis. Every
 * external dependency (pdf.js extractor, DSH Office converter, file reader,
 * clock) is injected, so these tests never touch the network or a real
 * Office/PDF toolchain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_PROVIDER,
  DEFAULT_LOCAL_CONFIG,
  OFFICE_PROVIDER,
  createLocalEngine,
} from '../../lib/local-engine.js'
import { resolveConfig } from '../../lib/config.js'
import { PDFJS_VERSION } from '../../lib/local-pdf.js'
import { WireError } from '../../lib/wire.js'
import { reader } from '../reader/helpers.mjs'

const LONG_BODY =
  'Injected extractor body text that is long enough to pass the local engine text floor. '.repeat(5).trim()

/** A fake PDF extractor returning one page with a heading and a long paragraph. */
function createFakePdfExtractor({
  pages = [[{ kind: 'heading', level: 1, text: 'Engine Test Paper' }, { kind: 'paragraph', text: LONG_BODY }]],
  pageCount = pages.length,
  title = 'Engine Test Paper',
  chars = pages.flat().reduce((sum, block) => sum + block.text.length, 0),
  outlineUsed = false,
} = {}) {
  const calls = []
  const extractor = async (input) => {
    calls.push(input)
    await input.onProgress?.({ extracted: pageCount, total: pageCount })
    return { pages, pageCount, title, chars, outlineUsed }
  }
  extractor.calls = calls
  return extractor
}

/** A fake Office→PDF service (convert exists so the capability probe passes). */
function createFakeOfficeToPdf() {
  return {
    calls: [],
    async convert() {
      throw new Error('the engine tests always inject officeConverter instead')
    },
  }
}

/** Assert one thrown/rejected value is a WireError with `code`. */
function isWire(error, code, status) {
  assert.ok(error instanceof WireError, `expected a WireError, got ${error}`)
  assert.equal(error.code, code)
  if (status !== undefined) assert.equal(error.status, status)
  return true
}

/** A logger that records messages. */
function createLogger() {
  const entries = []
  return {
    entries,
    info: (...args) => entries.push({ level: 'info', args }),
    warn: (...args) => entries.push({ level: 'warn', args }),
    error: (...args) => entries.push({ level: 'error', args }),
  }
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

test('snapshot: the bundled pdf.js is available, Office is not mounted', () => {
  const engine = createLocalEngine({ config: {} })
  const snapshot = engine.snapshot()
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.recommended, BUILTIN_PROVIDER)
  assert.deepEqual(Object.keys(snapshot.capabilities).sort(), ['html', 'images', 'office', 'textLayerPdf'])
  assert.equal(snapshot.capabilities.textLayerPdf, true)
  assert.equal(snapshot.capabilities.office, false)
  assert.equal(snapshot.capabilities.images, false)
  assert.equal(snapshot.capabilities.html, false)

  assert.equal(snapshot.providers.length, 2)
  const builtin = snapshot.providers.find((provider) => provider.id === BUILTIN_PROVIDER)
  assert.deepEqual(builtin, {
    id: BUILTIN_PROVIDER,
    available: true,
    version: `pdfjs-dist/${PDFJS_VERSION}`,
  })
  const office = snapshot.providers.find((provider) => provider.id === OFFICE_PROVIDER)
  assert.equal(office.available, false)
  assert.equal(office.version, '')
  assert.match(office.reason, /office-to-pdf/i)
})

test('snapshot: a mounted officeToPdf service enables the Office provider', () => {
  const engine = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  const snapshot = engine.snapshot()
  assert.equal(snapshot.capabilities.office, true)
  assert.equal(snapshot.available, true)
  const office = snapshot.providers.find((provider) => provider.id === OFFICE_PROVIDER)
  assert.equal(office.available, true)
  assert.equal(office.version, 'office-to-pdf')
  assert.equal(office.reason, undefined)
})

test('snapshot: disabled local parsing reports nothing available', () => {
  const engine = createLocalEngine({ config: { local: { enabled: false } }, officeToPdf: createFakeOfficeToPdf() })
  const snapshot = engine.snapshot()
  assert.equal(snapshot.enabled, false)
  assert.equal(snapshot.available, false)
  assert.equal(snapshot.recommended, null)
  assert.equal(snapshot.capabilities.textLayerPdf, false)
  assert.equal(snapshot.capabilities.office, false)
  for (const provider of snapshot.providers) assert.equal(provider.available, false)
  assert.equal(engine.config.enabled, false)
})

test('engine defaults mirror the lib/config.js local block', () => {
  const resolved = resolveConfig({ dataDir: '/tmp/dsh-litnotes-defaults-test' })
  assert.deepEqual(resolved.local, { ...DEFAULT_LOCAL_CONFIG }, 'the two default tables must not drift')
})

test('config block is resolved and clamped over the defaults', () => {
  const engine = createLocalEngine({
    config: { local: { maxPages: 7, maxPdfBytes: 1024, timeoutMs: 5, keepContentList: false, minCharsPerPage: -3 } },
  })
  assert.equal(engine.config.maxPages, 7)
  assert.equal(engine.config.maxPdfBytes, 64 * 1024, 'lower bound clamps')
  assert.equal(engine.config.timeoutMs, 1000, 'lower bound clamps')
  assert.equal(engine.config.keepContentList, false)
  assert.equal(engine.config.minCharsPerPage, 0)
  assert.equal(engine.config.maxParagraphChars, DEFAULT_LOCAL_CONFIG.maxParagraphChars)
  assert.deepEqual(engine.providers, { BUILTIN_PROVIDER, OFFICE_PROVIDER })
})

// ---------------------------------------------------------------------------
// supports / plan
// ---------------------------------------------------------------------------

test('supports(): PDF and Office capability resolution', () => {
  const bare = createLocalEngine({ config: {} })
  assert.deepEqual(bare.supports({ ext: '.pdf' }), { supported: true, provider: BUILTIN_PROVIDER })
  assert.deepEqual(bare.supports({ originalName: 'Paper.PDF' }), { supported: true, provider: BUILTIN_PROVIDER })

  const office = bare.supports({ ext: '.docx' })
  assert.equal(office.supported, false)
  assert.equal(office.provider, null)
  assert.match(office.reason, /office-to-pdf service is unavailable/)

  const withOffice = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  assert.deepEqual(withOffice.supports({ ext: '.pptx' }), { supported: true, provider: OFFICE_PROVIDER })
  assert.equal(withOffice.supports({ ext: '.docm' }).supported, false)

  for (const [meta, pattern] of [
    [{ ext: '.png' }, /unsupported extension \.png/],
    [{ originalName: 'figure.svg' }, /unsupported extension \.svg/],
    [{}, /unsupported extension \(unknown\)/],
  ]) {
    const support = withOffice.supports(meta)
    assert.equal(support.supported, false)
    assert.equal(support.provider, null)
    assert.match(support.reason, pattern)
  }

  const disabled = createLocalEngine({ config: { local: { enabled: false } } })
  assert.deepEqual(disabled.supports({ ext: '.pdf' }), {
    supported: false,
    provider: null,
    reason: 'local parsing is disabled',
  })
})

test('plan(): resolves the provider and normalized params', () => {
  const engine = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  assert.deepEqual(engine.plan({ ext: '.pdf', originalName: 'paper.pdf' }, { localProvider: 'auto' }), {
    provider: BUILTIN_PROVIDER,
    params: { fileName: 'paper.pdf', language: 'local', localProvider: BUILTIN_PROVIDER },
  })
  assert.deepEqual(engine.plan({ ext: '.docx', originalName: 'slides.docx' }), {
    provider: OFFICE_PROVIDER,
    params: { fileName: 'slides.docx', language: 'local', localProvider: OFFICE_PROVIDER },
  })
  // Explicit provider overrides that match are accepted.
  assert.equal(engine.plan({ ext: '.pdf' }, { localProvider: BUILTIN_PROVIDER }).provider, BUILTIN_PROVIDER)
})

test('plan(): provider override mismatch is local-unsupported', () => {
  const engine = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  assert.throws(
    () => engine.plan({ ext: '.pdf' }, { localProvider: OFFICE_PROVIDER }),
    (error) => isWire(error, 'local-unsupported', 415),
  )
  assert.throws(
    () => engine.plan({ ext: '.docx' }, { localProvider: BUILTIN_PROVIDER }),
    (error) => isWire(error, 'local-unsupported', 415),
  )
})

test('plan(): unsupported types, missing tools and size caps', () => {
  const bare = createLocalEngine({ config: {} })
  assert.throws(() => bare.plan({ ext: '.png' }), (error) => isWire(error, 'local-unsupported', 415))
  assert.throws(() => bare.plan({ ext: '.docx' }), (error) => isWire(error, 'local-missing-tool', 503))

  const engine = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  assert.throws(
    () => engine.plan({ ext: '.pdf', size: DEFAULT_LOCAL_CONFIG.maxPdfBytes + 1 }),
    (error) => isWire(error, 'too-large', 413),
  )
  assert.throws(
    () => engine.plan({ ext: '.docx', size: DEFAULT_LOCAL_CONFIG.maxOfficePdfBytes + 1 }),
    (error) => isWire(error, 'too-large', 413),
  )
  // At the limit it passes.
  assert.equal(engine.plan({ ext: '.pdf', size: DEFAULT_LOCAL_CONFIG.maxPdfBytes }).provider, BUILTIN_PROVIDER)

  const disabled = createLocalEngine({ config: { local: { enabled: false } } })
  assert.throws(() => disabled.plan({ ext: '.pdf' }), (error) => isWire(error, 'local-missing-tool', 503))
})

// ---------------------------------------------------------------------------
// extract: builtin provider
// ---------------------------------------------------------------------------

test('extract(): injected page blocks become 1:1 reader artifacts', async () => {
  const extractor = createFakePdfExtractor()
  const reads = []
  let clock = 1000
  const engine = createLocalEngine({
    config: { local: { minCharsPerPage: 0 } },
    logger: createLogger(),
    pdfExtractor: extractor,
    readSourceCapped: async (path, maxBytes) => {
      reads.push({ path, maxBytes })
      return new Uint8Array([0x25, 0x50, 0x44, 0x46])
    },
    now: () => (clock += 5),
  })

  const progress = []
  const result = await engine.extract({
    id: 'doc-1',
    meta: { ext: '.pdf', originalName: 'paper.pdf' },
    sourcePath: '/virtual/paper.pdf',
    params: { localProvider: 'auto' },
    onProgress: (entry) => progress.push(entry),
  })

  assert.deepEqual(reads, [{ path: '/virtual/paper.pdf', maxBytes: engine.config.maxPdfBytes }])
  assert.equal(extractor.calls.length, 1)
  assert.equal(extractor.calls[0].maxPages, engine.config.maxPages)
  assert.equal(extractor.calls[0].maxTextBytes, engine.config.maxTextBytes)
  assert.ok(extractor.calls[0].signal instanceof AbortSignal)
  assert.deepEqual(progress, [{ extracted: 1, total: 1 }])

  assert.equal(result.provider, BUILTIN_PROVIDER)
  assert.equal(result.pages, 1)
  assert.equal(result.title, 'Engine Test Paper')
  assert.ok(Array.isArray(result.warnings) && result.warnings.includes('no-structure'))
  assert.ok(result.warnings.includes('no-outline'), 'outlineUsed=false is surfaced as a warning')
  assert.deepEqual(result.stats, {
    pageCount: 1,
    textChars: result.stats.textChars,
    extractMs: 5,
    toolVersion: `pdfjs-dist/${PDFJS_VERSION}`,
    provider: BUILTIN_PROVIDER,
  })
  assert.equal(result.stats.textChars, 'Engine Test Paper'.length + LONG_BODY.length)

  // The content list stays 1:1 with the parsed markdown blocks.
  const model = reader.parseMarkdown(result.markdown)
  assert.equal(result.contentList.length, model.blocks.length)
  for (let index = 0; index < result.contentList.length; index += 1) {
    assert.equal(result.contentList[index].text, model.blocks[index].plainText)
  }
  assert.equal(model.blocks[0].kind, 'heading')
})

test('extract(): missing source path is a host error', async () => {
  const engine = createLocalEngine({ config: {} })
  await assert.rejects(
    () => engine.extract({ id: 'doc-1', meta: { ext: '.pdf' } }),
    (error) => isWire(error, 'host-error', 500),
  )
})

test('extract(): too little text maps to local-empty-text', async () => {
  const extractor = createFakePdfExtractor({
    pages: [[{ kind: 'paragraph', text: 'tiny' }]],
    title: null,
  })
  const engine = createLocalEngine({ config: {}, pdfExtractor: extractor, readSourceCapped: async () => new Uint8Array([1]) })
  await assert.rejects(
    () => engine.extract({ id: 'doc-1', meta: { ext: '.pdf' }, sourcePath: '/virtual/scan.pdf' }),
    (error) => {
      isWire(error, 'local-empty-text', 422)
      assert.equal(error.meta.pages, 1)
      assert.ok(error.meta.chars < 200)
      return true
    },
  )
})

test('extract(): configuration bounds are forwarded and honoured', async () => {
  const extractor = createFakePdfExtractor()
  const engine = createLocalEngine({
    config: {
      local: {
        maxPages: 12,
        maxTextBytes: 1024 * 1024,
        maxParagraphChars: 900,
        keepContentList: false,
        minCharsPerPage: 0,
      },
    },
    pdfExtractor: extractor,
    readSourceCapped: async () => new Uint8Array([1]),
  })
  const result = await engine.extract({ id: 'doc-1', meta: { ext: '.pdf' }, sourcePath: '/virtual/paper.pdf' })
  assert.deepEqual(extractor.calls[0].maxPages, 12)
  assert.equal(extractor.calls[0].maxTextBytes, 1024 * 1024)
  assert.deepEqual(result.contentList, [], 'keepContentList=false is respected')
  assert.ok(result.markdown.length > 0)
})

// ---------------------------------------------------------------------------
// extract: system:officeToPdf provider
// ---------------------------------------------------------------------------

test('extract(): Office converts to PDF first and reports missing fonts', async () => {
  const officeToPdf = createFakeOfficeToPdf()
  const converterCalls = []
  const officeConverter = async (input) => {
    converterCalls.push(input)
    const source = await input.readSource(4096)
    assert.ok(source instanceof Uint8Array)
    return { pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]), missingFonts: ['Calibri'] }
  }
  const extractor = createFakePdfExtractor()
  const reads = []
  const engine = createLocalEngine({
    config: { local: { minCharsPerPage: 0 } },
    officeToPdf,
    officeConverter,
    pdfExtractor: extractor,
    readSourceCapped: async (path, maxBytes) => {
      reads.push({ path, maxBytes })
      return new Uint8Array([1, 2, 3])
    },
  })

  const result = await engine.extract({
    id: 'doc-2',
    meta: { ext: '.pptx', originalName: 'slides.pptx', size: 1024 },
    sourcePath: '/virtual/slides.pptx',
  })

  assert.equal(converterCalls.length, 1)
  const input = converterCalls[0]
  assert.equal(input.officeToPdf, officeToPdf)
  assert.equal(input.meta.originalName, 'slides.pptx')
  assert.equal(input.maxBytes, engine.config.maxOfficePdfBytes)
  assert.ok(input.signal instanceof AbortSignal)
  assert.deepEqual(reads, [{ path: '/virtual/slides.pptx', maxBytes: 4096 }], 'the converter decides the read budget')

  // The converted PDF bytes (not the Office bytes) reach the extractor.
  assert.deepEqual([...extractor.calls[0].data], [0x25, 0x50, 0x44, 0x46])
  assert.equal(result.provider, OFFICE_PROVIDER)
  assert.ok(result.warnings.includes('missing-fonts'))
  assert.equal(result.stats.toolVersion, 'office-to-pdf')
  assert.equal(result.stats.provider, OFFICE_PROVIDER)
})

test('extract(): Office without a mounted service is local-missing-tool', async () => {
  const engine = createLocalEngine({ config: {} })
  await assert.rejects(
    () => engine.extract({ id: 'doc-2', meta: { ext: '.docx' }, sourcePath: '/virtual/x.docx' }),
    (error) => isWire(error, 'local-missing-tool', 503),
  )
})

test('extract(): Office size caps are enforced before conversion', async () => {
  const officeToPdf = createFakeOfficeToPdf()
  let converted = 0
  const engine = createLocalEngine({
    config: {},
    officeToPdf,
    officeConverter: async () => {
      converted += 1
      return { pdf: new Uint8Array([1]), missingFonts: [] }
    },
    pdfExtractor: createFakePdfExtractor(),
    readSourceCapped: async () => new Uint8Array([1]),
  })
  await assert.rejects(
    () =>
      engine.extract({
        id: 'doc-2',
        meta: { ext: '.docx', size: engine.config.maxOfficePdfBytes + 1 },
        sourcePath: '/virtual/x.docx',
      }),
    (error) => isWire(error, 'too-large', 413),
  )
  assert.equal(converted, 0, 'no conversion work is scheduled for an oversized file')
})

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

test('extract(): a local deadline aborts hung work with local-failed', async () => {
  let sawSignal = null
  const extractor = (input) =>
    new Promise((resolve, reject) => {
      sawSignal = input.signal
      input.signal.addEventListener('abort', () => {
        const error = new Error('aborted by local deadline')
        error.name = 'AbortError'
        reject(error)
      })
    })
  const engine = createLocalEngine({
    config: { local: { timeoutMs: 1000 } },
    pdfExtractor: extractor,
    readSourceCapped: async () => new Uint8Array([1]),
  })
  const startedAt = Date.now()
  await assert.rejects(
    () => engine.extract({ id: 'doc-1', meta: { ext: '.pdf' }, sourcePath: '/virtual/slow.pdf' }),
    (error) => {
      isWire(error, 'local-failed', 500)
      assert.match(error.message, /超时|timed out/)
      return true
    },
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 900, `timed out after ${elapsed} ms`)
  assert.ok(elapsed < 5000)
  assert.equal(sawSignal.aborted, true)
})

test('extract(): caller cancellation is not reported as a local failure', async () => {
  const controller = new AbortController()
  controller.abort()
  const extractor = async () => {
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
  }
  const engine = createLocalEngine({ config: {}, pdfExtractor: extractor, readSourceCapped: async () => new Uint8Array([1]) })
  await assert.rejects(
    () => engine.extract({ id: 'doc-1', meta: { ext: '.pdf' }, sourcePath: '/virtual/paper.pdf', signal: controller.signal }),
    (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})
