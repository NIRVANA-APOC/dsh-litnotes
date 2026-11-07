/**
 * Unit tests for the T0 PDF text-layer extractor
 * (`src/host/parse/local/pdf.ts`).
 *
 * Two layers of coverage:
 *  - a vendor smoke test importing the bundled `vendor/pdfjs/pdf.mjs` and
 *    extracting a hand-built minimal PDF (no fixtures, no network);
 *  - error/bounds behaviour driven by an injected fake `pdfjsModule`, so
 *    encryption, corrupt files, page/text caps, cancellation and progress are
 *    all deterministic.
 *
 * Ported from the frozen `test/unit/local-pdf.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  PdfDocument,
  PdfJsModule,
  PdfLoadingTask,
  PdfPageBlock,
} from '../../src/host/parse/local/pdf.ts'
import { PDFJS_VERSION, extractPdfText, loadPdfjs } from '../../src/host/parse/local/pdf.ts'
import { WireError } from '../../src/host/wire.ts'

/** One text line drawn by {@link makeMinimalPdf}. */
interface MinimalPdfLine {
  text: string
  size: number
  y: number
}

/**
 * Build a minimal but valid single-page PDF with a text layer.
 *
 * @param lines - text lines to draw.
 * @returns PDF bytes.
 */
function makeMinimalPdf(lines: MinimalPdfLine[]): Buffer {
  const content = lines.map(({ text, size, y }) => `BT /F1 ${size} Tf 72 ${y} Td (${text}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${index + 1} 0 obj\n${objects[index] ?? ''}\nendobj\n`
  }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** One fake pdf.js text item. */
interface FakeTextLine {
  text: string
  size?: number
  y?: number
}

/** Observable state of the fake pdf.js module. */
interface FakePdfjsState {
  destroyed: number
  getDocumentOptions: Record<string, unknown> | null
  pagesRead: number[]
  getOutlineCalled: number
}

/** The fake pdf.js module namespace. */
interface FakePdfjs extends PdfJsModule {
  state: FakePdfjsState
}

/** Options of {@link createFakePdfjs}. */
interface FakePdfjsOptions {
  numPages?: number
  pages?: FakeTextLine[][]
  outline?: Array<{ title: string; items: unknown[] }> | null
  metadataTitle?: string | null
  loadingError?: Error | null
  metadataError?: boolean
  onGetPage?: (pageNumber: number) => void
}

/** Build a fake `pdfjs` module namespace. */
function createFakePdfjs(options: FakePdfjsOptions = {}): FakePdfjs {
  const {
    numPages = 1,
    pages = [],
    outline = null,
    metadataTitle = null,
    loadingError = null,
    metadataError = false,
    onGetPage,
  } = options
  const state: FakePdfjsState = { destroyed: 0, getDocumentOptions: null, pagesRead: [], getOutlineCalled: 0 }
  return {
    state,
    getDocument(documentOptions: Record<string, unknown>): PdfLoadingTask {
      state.getDocumentOptions = documentOptions
      const doc: PdfDocument = {
        numPages,
        async getPage(pageNumber: number) {
          state.pagesRead.push(pageNumber)
          onGetPage?.(pageNumber)
          const lines = pages[pageNumber - 1] ?? []
          const page = {
            async getTextContent() {
              return {
                items: lines.map((line, index) => ({
                  str: line.text,
                  transform: [1, 0, 0, 1, 72, line.y ?? 700 - index * 14],
                  height: line.size ?? 10,
                  hasEOL: true,
                })),
              }
            },
            cleanup() {},
          }
          return page
        },
        async getOutline() {
          state.getOutlineCalled += 1
          return outline
        },
        async getMetadata() {
          if (metadataError) throw new Error('broken metadata')
          return { info: metadataTitle === null ? {} : { Title: metadataTitle } }
        },
      }
      return {
        promise: loadingError === null ? Promise.resolve(doc) : Promise.reject(loadingError),
        async destroy() {
          state.destroyed += 1
        },
      }
    },
  }
}

/** Two-page fake document used by several tests. */
function twoPagePdfjs(): FakePdfjs {
  return createFakePdfjs({
    numPages: 2,
    pages: [
      [{ text: 'A Local Test Paper', size: 18 }, { text: 'The first page has a body line.', size: 10 }],
      [{ text: 'The second page also has body text.', size: 10 }],
    ],
  })
}

/** Assert an async call rejects with a WireError of `code`. */
async function rejectsWire(promiseFactory: () => Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promiseFactory, (error: unknown) => {
    assert.ok(error instanceof WireError, `expected a WireError, got ${String(error)}`)
    assert.equal(error.code, code)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  })
}

/** All block texts of one page. */
function blockTexts(blocks: PdfPageBlock[] | undefined): string[] {
  return (blocks ?? []).map((block) => block.text)
}

// ---------------------------------------------------------------------------
// Vendor smoke test (real bundled pdf.js)
// ---------------------------------------------------------------------------

test('vendor smoke: bundled pdf.js extracts the text layer of a minimal PDF', async () => {
  const pdfjs = await loadPdfjs()
  assert.equal(typeof pdfjs.getDocument, 'function')
  assert.equal(pdfjs.version, PDFJS_VERSION, 'PDFJS_VERSION matches the vendored bundle')
  assert.match(PDFJS_VERSION, /^\d+\.\d+\.\d+$/)

  const data = makeMinimalPdf([
    { text: 'A Minimal Test Document', size: 18, y: 720 },
    { text: 'Body first line.', size: 10, y: 680 },
    { text: 'Body second line.', size: 10, y: 664 },
  ])
  const extracted = await extractPdfText({ data })
  assert.equal(extracted.pageCount, 1)
  assert.equal(extracted.title, 'A Minimal Test Document')
  assert.equal(extracted.outlineUsed, false)
  assert.ok(extracted.chars > 0)
  assert.ok(Array.isArray(extracted.pages))
  assert.equal(extracted.pages.length, 1)
  const blocks = extracted.pages[0] ?? []
  assert.ok(blocks.length >= 1)
  for (const block of blocks) {
    assert.ok(block.kind === 'heading' || block.kind === 'paragraph')
    assert.equal(typeof block.text, 'string')
    assert.ok(block.text.length > 0)
  }
  const text = blockTexts(blocks).join(' ')
  assert.match(text, /Body first line\./)
  assert.match(text, /Body second line\./)
})

test('loadPdfjs imports the vendored bundle once', async () => {
  const first = await loadPdfjs()
  const second = await loadPdfjs()
  assert.equal(first, second)
})

test('missing PDF data is rejected as bad-request', async () => {
  await rejectsWire(() => extractPdfText({}), 'bad-request')
  await rejectsWire(() => extractPdfText({ data: null }), 'bad-request')
})

// ---------------------------------------------------------------------------
// Error mapping and bounds (fake pdf.js)
// ---------------------------------------------------------------------------

test('encrypted PDFs map to local-encrypted', async () => {
  const password = Object.assign(new Error('password required'), { name: 'PasswordException' })
  await rejectsWire(async () => {
    const pdfjs = createFakePdfjs({ loadingError: password })
    await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs })
  }, 'local-encrypted', 422)

  const symbol = Object.assign(new Error('UnknownErrorException: symbol'), { name: 'UnknownErrorException' })
  await rejectsWire(async () => {
    await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: createFakePdfjs({ loadingError: symbol }) })
  }, 'local-encrypted', 422)
})

test('invalid PDFs map to local-failed and destroy the loading task', async () => {
  const invalid = Object.assign(new Error('no pdf header'), { name: 'InvalidPDFException' })
  const pdfjs = createFakePdfjs({ loadingError: invalid })
  await rejectsWire(() => extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs }), 'local-failed', 422)
  assert.equal(pdfjs.state.destroyed, 1)
  await assert.rejects(
    () => extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs }),
    (error: unknown) => {
      assert.ok(error instanceof WireError)
      assert.equal(error.code, 'local-failed')
      assert.match(error.message, /PDF/)
      return true
    },
  )
})

test('page caps map to too-large and report the limit', async () => {
  const pdfjs = createFakePdfjs({ numPages: 5 })
  await rejectsWire(
    () => extractPdfText({ data: new Uint8Array([1]), maxPages: 2, pdfjsModule: pdfjs }),
    'too-large',
    413,
  )
  assert.deepEqual(pdfjs.state.pagesRead, [], 'no page is opened past the cap')
  assert.equal(pdfjs.state.destroyed, 1)

  // Default maxPages is 500.
  const big = createFakePdfjs({ numPages: 501 })
  await rejectsWire(() => extractPdfText({ data: new Uint8Array([1]), pdfjsModule: big }), 'too-large')
})

test('text byte cap maps to too-large', async () => {
  const pdfjs = twoPagePdfjs()
  await rejectsWire(
    () => extractPdfText({ data: new Uint8Array([1]), maxTextBytes: 10, pdfjsModule: pdfjs }),
    'too-large',
    413,
  )
})

test('a page without any text yields zero chars and empty blocks', async () => {
  const pdfjs = createFakePdfjs({ numPages: 1, pages: [[]] })
  const extracted = await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs })
  assert.equal(extracted.chars, 0)
  assert.equal(extracted.pageCount, 1)
  assert.deepEqual(extracted.pages, [[]])
  assert.equal(extracted.outlineUsed, false)
})

test('extraction is deterministic and destroys one loading task per run', async () => {
  const pdfjs = twoPagePdfjs()
  const first = await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs })
  const second = await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs })
  assert.deepEqual(first, second)
  assert.equal(pdfjs.state.destroyed, 2)
  assert.equal(first.pageCount, 2)
  assert.ok(first.chars > 0)
  assert.equal(first.title, 'A Local Test Paper')
})

test('onProgress reports extracted/total per page', async () => {
  const pdfjs = twoPagePdfjs()
  const progress: Array<{ extracted: number; total: number }> = []
  await extractPdfText({
    data: new Uint8Array([1]),
    pdfjsModule: pdfjs,
    onProgress: (entry) => progress.push(entry),
  })
  assert.deepEqual(progress, [
    { extracted: 1, total: 2 },
    { extracted: 2, total: 2 },
  ])
})

test('cancellation surfaces as AbortError, not a WireError', async () => {
  // Already-aborted signal: pdf.js is never asked for a document.
  const controller = new AbortController()
  controller.abort()
  const pdfjs = createFakePdfjs({ numPages: 1 })
  await assert.rejects(
    () => extractPdfText({ data: new Uint8Array([1]), signal: controller.signal, pdfjsModule: pdfjs }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      assert.equal(error instanceof WireError, false)
      return true
    },
  )
  assert.equal(pdfjs.state.getDocumentOptions, null)

  // Aborted after the first page: the next page check aborts.
  const mid = new AbortController()
  const midPdfjs = createFakePdfjs({
    numPages: 2,
    pages: [[{ text: 'first page body text', size: 10 }], [{ text: 'second page body text', size: 10 }]],
    onGetPage: () => mid.abort(),
  })
  await assert.rejects(
    () => extractPdfText({ data: new Uint8Array([1]), signal: mid.signal, pdfjsModule: midPdfjs }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
  assert.deepEqual(midPdfjs.state.pagesRead, [1], 'aborts before opening the next page')
  assert.equal(midPdfjs.state.destroyed, 1)
})

test('the pdf.js outline becomes heading levels', async () => {
  const pdfjs = createFakePdfjs({
    numPages: 1,
    metadataTitle: 'A Test Paper',
    outline: [
      { title: 'Introduction', items: [] },
      { title: 'Methods', items: [{ title: 'Setup', items: [] }] },
    ],
    pages: [
      [
        { text: 'A Test Paper', size: 18 },
        { text: 'Introduction', size: 12 },
        { text: 'Body of the introduction paragraph.', size: 10 },
        { text: 'Methods', size: 12 },
        { text: 'Setup', size: 12 },
        { text: 'More body text for the methods section.', size: 10 },
      ],
    ],
  })
  const extracted = await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs })
  assert.equal(extracted.outlineUsed, true)
  assert.equal(extracted.title, 'A Test Paper')
  const headings = (extracted.pages[0] ?? []).filter(
    (block): block is Extract<PdfPageBlock, { kind: 'heading' }> => block.kind === 'heading',
  )
  const byText = new Map(headings.map((block) => [block.text, block.level]))
  assert.equal(byText.get('Introduction'), 2)
  assert.equal(byText.get('Methods'), 2)
  assert.equal(byText.get('Setup'), 3, 'outline nesting adds one level per depth')
  assert.equal(pdfjs.state.getOutlineCalled, 1)
})

test('metadata titles are used and metadata failures are tolerated', async () => {
  const pdfjs = createFakePdfjs({
    numPages: 1,
    metadataTitle: 'Metadata Paper Title',
    pages: [[{ text: 'Metadata Paper Title', size: 18 }, { text: 'Body line long enough to survive.', size: 10 }]],
  })
  const extracted = await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: pdfjs })
  assert.equal(extracted.title, 'Metadata Paper Title')

  const broken = createFakePdfjs({
    numPages: 1,
    metadataError: true,
    pages: [[{ text: 'Some body text that is long.', size: 10 }]],
  })
  const fallback = await extractPdfText({ data: new Uint8Array([1]), pdfjsModule: broken })
  assert.equal(typeof fallback.title, 'string')
})
