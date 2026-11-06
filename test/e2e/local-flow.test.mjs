/**
 * End-to-end local parsing flow (T0 / T0.5).
 *
 * A real Host stack (store + parse manager + service) with the cloud mock
 * running: a token-free `{engine:'auto'}` parse of a supported PDF must be
 * served entirely on device — the mock MinerU server must receive no request
 * at all — and produce readable artifacts with 1..N page marks. A scanned
 * document (extractor reports local-empty-text) must fail cleanly.
 *
 * The local engine is injected: these tests exercise the wiring, limits and
 * artifact contract without running pdf.js/Office during the e2e suite.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { synthLocalDocument } from '../../lib/local-synth.js'
import { WireError } from '../../lib/wire.js'
import { reader } from '../reader/helpers.mjs'
import { createHarness, importDocument } from './harness.mjs'
import { waitForStatus } from './helpers.mjs'

/** Artifacts for a two-page synthetic paper, produced by the real synthesizer. */
function syntheticLocalArtifacts() {
  const synth = synthLocalDocument({
    pages: [
      [
        { kind: 'heading', level: 1, text: 'On-Device Parsing Paper' },
        { kind: 'paragraph', text: 'The first page is extracted by the bundled pdf.js text layer.' },
      ],
      [{ kind: 'paragraph', text: 'The second page proves page marks work without any upload.' }],
    ],
  })
  return {
    markdown: synth.markdown,
    contentList: synth.contentList,
    pages: synth.pageCount,
    provider: 'builtin',
    title: synth.title,
    warnings: synth.warnings,
    stats: {
      pageCount: synth.pageCount,
      textChars: synth.textChars,
      extractMs: 2,
      toolVersion: 'pdfjs-dist/5.4.449',
      provider: 'builtin',
    },
  }
}

/**
 * Fake local engine matching `createLocalEngine()`'s manager-facing surface.
 * @param {{ fail?: Error | null }} [options]
 */
function createFakeLocalEngine({ fail = null } = {}) {
  const state = { extracts: [] }
  return {
    state,
    config: { maxPdfBytes: 200 * 1024 * 1024 },
    snapshot() {
      return {
        enabled: true,
        available: true,
        recommended: 'builtin',
        providers: [
          { id: 'builtin', available: true, version: 'pdfjs-dist/5.4.449' },
          { id: 'system:officeToPdf', available: false, version: '', reason: 'not mounted' },
        ],
        capabilities: { textLayerPdf: true, office: false, images: false, html: false },
      }
    },
    supports(meta) {
      return /\.pdf$/i.test(String(meta?.originalName ?? ''))
        ? { supported: true, provider: 'builtin' }
        : { supported: false, provider: null, reason: 'unsupported extension' }
    },
    async extract(input) {
      state.extracts.push(input)
      if (fail !== null) throw fail
      input.onProgress?.({ extracted: 1, total: 2 })
      input.onProgress?.({ extracted: 2, total: 2 })
      return syntheticLocalArtifacts()
    },
  }
}

test('token-free auto parse uses the local engine and never calls MinerU', async (t) => {
  const localEngine = createFakeLocalEngine()
  const harness = await createHarness(t, { token: null, localEngine })
  const doc = await importDocument(harness, {
    name: 'local-paper.pdf',
    bytes: Buffer.from('%PDF-1.4 local e2e fixture\n%%EOF\n'),
  })

  const started = await harness.service.startParse(doc.id, { engine: 'auto' })
  assert.equal(started.document.status, 'parsing')
  assert.equal(started.document.parse.engine, 'local', 'no token + supported PDF selects local')
  assert.equal(started.document.parse.phase, 'extracting')

  const parsed = await waitForStatus(harness.store, doc.id, 'parsed')
  assert.equal(parsed.error, null)
  assert.equal(parsed.parse.engine, 'local')
  assert.equal(parsed.parse.provider, 'builtin')
  assert.equal(parsed.parse.phase, null)
  assert.equal(parsed.parse.pages, 2)
  assert.equal(parsed.parse.hasContentList, true)
  assert.equal(parsed.parse.local.toolVersion, 'pdfjs-dist/5.4.449')
  assert.deepEqual(parsed.parse.local.warnings, ['no-structure'])
  assert.equal(parsed.title, 'On-Device Parsing Paper')

  // The cloud mock saw nothing: the parse was fully on device.
  assert.deepEqual(harness.mock.state.requests, [], 'no MinerU request for a local parse')
  assert.equal(harness.mock.state.batches.size, 0)
  assert.equal(harness.mock.state.tasks.size, 0)

  // The local extractor got the real source path and a live signal.
  assert.equal(localEngine.state.extracts.length, 1)
  assert.equal(localEngine.state.extracts[0].id, doc.id)
  assert.equal(existsSync(await harness.store.sourcePath(doc.id)), true)

  // Artifacts are readable through the same path the reader uses.
  const parsedDir = join(harness.docDir(doc.id), 'parsed')
  assert.equal(existsSync(join(parsedDir, 'full.md')), true)
  assert.equal(existsSync(join(parsedDir, 'content_list.json')), true)
  const read = await harness.service.readMarkdown(doc.id)
  assert.equal(read.markdown, syntheticLocalArtifacts().markdown)
  assert.equal(read.contentList.length, syntheticLocalArtifacts().contentList.length)
  assert.equal(read.pages, 2)

  // Page marks 1..N are placed on the reader model.
  const model = reader.appendPageMarks(reader.parseMarkdown(read.markdown), read.contentList)
  assert.deepEqual(
    model.blocks.filter((block) => block.kind === 'page').map((block) => block.page),
    [1, 2],
  )
  assert.equal(model.blocks[0].kind, 'page')
  assert.equal(model.outline.length, 1, 'the synthetic title heading is in the outline')
})

test('a scanned document fails locally without uploading and keeps its source', async (t) => {
  const fail = new WireError('local-empty-text', '没有从文件中提取到文字（可能是扫描件）', 422)
  const localEngine = createFakeLocalEngine({ fail })
  const harness = await createHarness(t, { token: null, localEngine })
  const doc = await importDocument(harness, {
    name: 'scanned.pdf',
    bytes: Buffer.from('%PDF-1.4 scanned e2e fixture\n%%EOF\n'),
  })

  const started = await harness.service.startParse(doc.id, { engine: 'auto' })
  assert.equal(started.document.parse.engine, 'local')

  const failed = await waitForStatus(harness.store, doc.id, 'failed')
  assert.match(failed.error, /没有从文件中提取到文字|scanned/i)
  assert.equal(failed.parse.phase, null)
  assert.equal(harness.mock.state.requests.length, 0, 'a local failure never falls back to the cloud behind the user')
  assert.equal(existsSync(join(harness.docDir(doc.id), 'parsed')), false, 'no partial artifacts are written')
  assert.equal(existsSync(await harness.store.sourcePath(doc.id)), true, 'the source is kept for retry')
})
