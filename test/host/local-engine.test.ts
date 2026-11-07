/**
 * Unit tests for the local engine facade (`src/host/parse/local/engine.ts`).
 *
 * The engine is the T0/T0.5 orchestration layer: capability snapshot,
 * support/probe resolution, limit validation and artifact synthesis. Every
 * external dependency (pdf.js extractor, DSH Office converter, file reader,
 * clock) is injected, so these tests never touch the network or a real
 * Office/PDF toolchain.
 *
 * Ported from the frozen `test/unit/local-engine.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { OfficeToPdfService } from '../../src/host/host-services.ts'
import type { LocalProvider } from '../../src/shared/constants.ts'
import type { ContentListEntry } from '../../src/shared/model.ts'
import { PDFJS_VERSION } from '../../src/host/parse/local/pdf.ts'
import type {
  ExtractPdfTextInput,
  PdfExtractionResult,
  PdfPageBlock,
} from '../../src/host/parse/local/pdf.ts'
import type { ConvertOfficeToPdfResult } from '../../src/host/parse/local/office.ts'
import {
  BUILTIN_PROVIDER,
  DEFAULT_LOCAL_CONFIG,
  OFFICE_PROVIDER,
  createLocalEngine,
} from '../../src/host/parse/local/engine.ts'
import { parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { WireError } from '../../src/host/wire.ts'

const LONG_BODY =
  'Injected extractor body text that is long enough to pass the local engine text floor. '.repeat(5).trim()

/** A fake PDF extractor with a call log. */
interface FakePdfExtractor {
  (input: ExtractPdfTextInput): Promise<PdfExtractionResult>
  calls: ExtractPdfTextInput[]
}

/** A fake PDF extractor returning one page with a heading and a long paragraph. */
function createFakePdfExtractor(
  options: {
    pages?: PdfPageBlock[][]
    pageCount?: number
    title?: string | null
    chars?: number
    outlineUsed?: boolean
  } = {},
): FakePdfExtractor {
  const {
    pages = [
      [
        { kind: 'heading', level: 1, text: 'Engine Test Paper' },
        { kind: 'paragraph', text: LONG_BODY },
      ],
    ],
    pageCount = pages.length,
    title = 'Engine Test Paper',
    chars = pages.flat().reduce((sum, block) => sum + block.text.length, 0),
    outlineUsed = false,
  } = options
  const calls: ExtractPdfTextInput[] = []
  const extractor = async (input: ExtractPdfTextInput): Promise<PdfExtractionResult> => {
    calls.push(input)
    input.onProgress?.({ extracted: pageCount, total: pageCount })
    return { pages, pageCount, title: title ?? '', chars, outlineUsed }
  }
  return Object.assign(extractor, { calls })
}

/** A fake Office→PDF service (convert exists so the capability probe passes). */
function createFakeOfficeToPdf(): OfficeToPdfService & { calls: unknown[] } {
  return {
    calls: [],
    async convert() {
      throw new Error('the engine tests always inject officeConverter instead')
    },
  }
}

/** Assert one thrown/rejected value is a WireError with `code`. */
function isWireError(error: unknown, code: string, status?: number): true {
  assert.ok(error instanceof WireError, `expected a WireError, got ${String(error)}`)
  assert.equal(error.code, code)
  if (status !== undefined) assert.equal(error.status, status)
  return true
}

/** A logger that records messages. */
function createLogger(): { entries: Array<{ level: string; args: unknown[] }>; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void } {
  const entries: Array<{ level: string; args: unknown[] }> = []
  const record = (level: string) => (...args: unknown[]): void => {
    entries.push({ level, args })
  }
  return { entries, info: record('info'), warn: record('warn'), error: record('error') }
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
  assert.ok(office !== undefined)
  assert.equal(office.available, false)
  assert.equal(office.version, '')
  assert.match(office.reason ?? '', /office-to-pdf/i)
})

test('snapshot: a mounted officeToPdf service enables the Office provider', () => {
  const engine = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  const snapshot = engine.snapshot()
  assert.equal(snapshot.capabilities.office, true)
  assert.equal(snapshot.available, true)
  const office = snapshot.providers.find((provider) => provider.id === OFFICE_PROVIDER)
  assert.ok(office !== undefined)
  assert.equal(office.available, true)
  assert.equal(office.version, 'office-to-pdf')
  assert.equal(office.reason, undefined)
})

test('snapshot: lazily mounted officeToPdf is picked up after creation', () => {
  let service: OfficeToPdfService | undefined
  const engine = createLocalEngine({ config: {}, getOfficeToPdf: () => service })
  assert.equal(engine.snapshot().capabilities.office, false)
  service = createFakeOfficeToPdf()
  assert.equal(engine.snapshot().capabilities.office, true)
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

test('engine defaults mirror the default local config table', () => {
  const engine = createLocalEngine({ config: {} })
  assert.deepEqual(engine.config, { ...DEFAULT_LOCAL_CONFIG }, 'the defaults must not drift')
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
  assert.deepEqual(engine.providers, { builtin: BUILTIN_PROVIDER, office: OFFICE_PROVIDER })
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
  assert.match(office.reason ?? '', /office-to-pdf service is unavailable/)

  const withOffice = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  assert.deepEqual(withOffice.supports({ ext: '.pptx' }), { supported: true, provider: OFFICE_PROVIDER })
  assert.equal(withOffice.supports({ ext: '.docm' }).supported, false)

  for (const [meta, pattern] of [
    [{ ext: '.png' }, /unsupported extension \.png/],
    [{ originalName: 'figure.svg' }, /unsupported extension \.svg/],
    [{}, /unsupported extension \(unknown\)/],
  ] as Array<[{ ext?: string; originalName?: string }, RegExp]>) {
    const support = withOffice.supports(meta)
    assert.equal(support.supported, false)
    assert.equal(support.provider, null)
    assert.match(support.reason ?? '', pattern)
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
    (error: unknown) => isWireError(error, 'local-unsupported', 415),
  )
  assert.throws(
    () => engine.plan({ ext: '.docx' }, { localProvider: BUILTIN_PROVIDER }),
    (error: unknown) => isWireError(error, 'local-unsupported', 415),
  )
})

test('plan(): unsupported types, missing tools and size caps', () => {
  const bare = createLocalEngine({ config: {} })
  assert.throws(() => bare.plan({ ext: '.png' }), (error: unknown) => isWireError(error, 'local-unsupported', 415))
  assert.throws(() => bare.plan({ ext: '.docx' }), (error: unknown) => isWireError(error, 'local-missing-tool', 503))

  const engine = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  assert.throws(
    () => engine.plan({ ext: '.pdf', size: DEFAULT_LOCAL_CONFIG.maxPdfBytes + 1 }),
    (error: unknown) => isWireError(error, 'too-large', 413),
  )
  assert.throws(
    () => engine.plan({ ext: '.docx', size: DEFAULT_LOCAL_CONFIG.maxOfficePdfBytes + 1 }),
    (error: unknown) => isWireError(error, 'too-large', 413),
  )
  // At the limit it passes.
  assert.equal(engine.plan({ ext: '.pdf', size: DEFAULT_LOCAL_CONFIG.maxPdfBytes }).provider, BUILTIN_PROVIDER)

  const disabled = createLocalEngine({ config: { local: { enabled: false } } })
  assert.throws(() => disabled.plan({ ext: '.pdf' }), (error: unknown) => isWireError(error, 'local-missing-tool', 503))
})

// ---------------------------------------------------------------------------
// extract: builtin provider
// ---------------------------------------------------------------------------

test('extract(): injected page blocks become 1:1 reader artifacts', async () => {
  const extractor = createFakePdfExtractor()
  const reads: Array<{ path: string; maxBytes: number }> = []
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

  const progress: Array<{ extracted: number; total: number }> = []
  const result = await engine.extract({
    id: 'doc-1',
    meta: { ext: '.pdf', originalName: 'paper.pdf' },
    sourcePath: '/virtual/paper.pdf',
    params: { localProvider: 'auto' },
    onProgress: (entry) => progress.push(entry),
  })

  assert.deepEqual(reads, [{ path: '/virtual/paper.pdf', maxBytes: engine.config.maxPdfBytes }])
  assert.equal(extractor.calls.length, 1)
  const call = extractor.calls[0]
  assert.ok(call !== undefined)
  assert.equal(call.maxPages, engine.config.maxPages)
  assert.equal(call.maxTextBytes, engine.config.maxTextBytes)
  assert.ok(call.signal instanceof AbortSignal)
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
  // The engine produces MinerU-compatible entries; narrow the contract's
  // `unknown[]` payload to its documented shape.
  const contentList = (result.contentList ?? []) as ContentListEntry[]
  const model = parseMarkdown(result.markdown)
  assert.equal(contentList.length, model.blocks.length)
  for (let index = 0; index < contentList.length; index += 1) {
    assert.equal(contentList[index]?.text, model.blocks[index]?.plainText)
  }
  assert.equal(model.blocks[0]?.kind, 'heading')
})

test('extract(): missing source path is a host error', async () => {
  const engine = createLocalEngine({ config: {} })
  await assert.rejects(
    () => engine.extract({ id: 'doc-1', meta: { ext: '.pdf' }, sourcePath: '' }),
    (error: unknown) => isWireError(error, 'host-error', 500),
  )
})

test('extract(): too little text maps to local-empty-text', async () => {
  const extractor = createFakePdfExtractor({
    pages: [[{ kind: 'paragraph', text: 'tiny' }]],
    title: null,
  })
  const engine = createLocalEngine({
    config: {},
    pdfExtractor: extractor,
    readSourceCapped: async () => new Uint8Array([1]),
  })
  await assert.rejects(
    () => engine.extract({ id: 'doc-1', meta: { ext: '.pdf' }, sourcePath: '/virtual/scan.pdf' }),
    (error: unknown) => {
      isWireError(error, 'local-empty-text', 422)
      assert.ok(error instanceof WireError)
      assert.equal(error.meta?.pages, 1)
      assert.ok(Number(error.meta?.chars) < 200)
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
  const call = extractor.calls[0]
  assert.ok(call !== undefined)
  assert.equal(call.maxPages, 12)
  assert.equal(call.maxTextBytes, 1024 * 1024)
  assert.deepEqual(result.contentList, [], 'keepContentList=false is respected')
  assert.ok(result.markdown.length > 0)
})

// ---------------------------------------------------------------------------
// extract: system:officeToPdf provider
// ---------------------------------------------------------------------------

test('extract(): Office converts to PDF first and reports missing fonts', async () => {
  const officeToPdf = createFakeOfficeToPdf()
  const converterCalls: Array<{ officeToPdf: unknown; meta: unknown; maxBytes: number; signal: unknown }> = []
  const officeConverter = async (input: {
    officeToPdf?: OfficeToPdfService
    meta?: unknown
    readSource: (maxBytes: number) => Promise<Uint8Array>
    signal?: AbortSignal
    maxBytes?: number
  }): Promise<ConvertOfficeToPdfResult> => {
    converterCalls.push({ officeToPdf: input.officeToPdf, meta: input.meta, maxBytes: input.maxBytes ?? 0, signal: input.signal })
    const source = await input.readSource(4096)
    assert.ok(source instanceof Uint8Array)
    return { pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]), missingFonts: ['Calibri'] }
  }
  const extractor = createFakePdfExtractor()
  const reads: Array<{ path: string; maxBytes: number }> = []
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
  assert.ok(input !== undefined)
  assert.equal(input.officeToPdf, officeToPdf)
  assert.ok(input.meta !== null && typeof input.meta === 'object')
  assert.equal((input.meta as { originalName?: string }).originalName, 'slides.pptx')
  assert.equal(input.maxBytes, engine.config.maxOfficePdfBytes)
  assert.ok(input.signal instanceof AbortSignal)
  assert.deepEqual(reads, [{ path: '/virtual/slides.pptx', maxBytes: 4096 }], 'the converter decides the read budget')

  // The converted PDF bytes (not the Office bytes) reach the extractor.
  const call = extractor.calls[0]
  assert.ok(call !== undefined)
  assert.deepEqual([...((call.data as Uint8Array | undefined) ?? new Uint8Array())], [0x25, 0x50, 0x44, 0x46])
  assert.equal(result.provider, OFFICE_PROVIDER)
  assert.ok(result.warnings.includes('missing-fonts'))
  assert.equal(result.stats.toolVersion, 'office-to-pdf')
  assert.equal(result.stats.provider, OFFICE_PROVIDER)
})

test('extract(): Office without a mounted service is local-missing-tool', async () => {
  const engine = createLocalEngine({ config: {} })
  await assert.rejects(
    () => engine.extract({ id: 'doc-2', meta: { ext: '.docx' }, sourcePath: '/virtual/x.docx' }),
    (error: unknown) => isWireError(error, 'local-missing-tool', 503),
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
    (error: unknown) => isWireError(error, 'too-large', 413),
  )
  assert.equal(converted, 0, 'no conversion work is scheduled for an oversized file')
})

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

test('extract(): a local deadline aborts hung work with local-failed', async () => {
  let sawSignal: AbortSignal | undefined
  const extractor = (input: ExtractPdfTextInput): Promise<PdfExtractionResult> =>
    new Promise((_resolve, reject) => {
      sawSignal = input.signal
      input.signal?.addEventListener('abort', () => {
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
    (error: unknown) => {
      isWireError(error, 'local-failed', 500)
      assert.match((error as Error).message, /超时|timed out/)
      return true
    },
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 900, `timed out after ${elapsed} ms`)
  assert.ok(elapsed < 5000)
  assert.equal(sawSignal?.aborted, true)
})

test('extract(): caller cancellation is not reported as a local failure', async () => {
  const controller = new AbortController()
  controller.abort()
  const extractor = async (): Promise<PdfExtractionResult> => {
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
  }
  const engine = createLocalEngine({
    config: {},
    pdfExtractor: extractor,
    readSourceCapped: async () => new Uint8Array([1]),
  })
  await assert.rejects(
    () =>
      engine.extract({
        id: 'doc-1',
        meta: { ext: '.pdf' },
        sourcePath: '/virtual/paper.pdf',
        signal: controller.signal,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})

test('extract(): local provider param overrides are validated', async () => {
  const engine = createLocalEngine({ config: {}, officeToPdf: createFakeOfficeToPdf() })
  await assert.rejects(
    () =>
      engine.extract({
        id: 'doc-1',
        meta: { ext: '.pdf' },
        sourcePath: '/virtual/paper.pdf',
        params: { localProvider: 'system:officeToPdf' as LocalProvider },
      }),
    (error: unknown) => isWireError(error, 'local-unsupported', 415),
  )
})
