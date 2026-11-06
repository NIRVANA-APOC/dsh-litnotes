/**
 * Create a throwaway demo library for manual verification of the reading desk.
 *
 *   node scripts/demo.mjs [--out /tmp/some-dir]
 *
 * Writes a complete `<tmp>/mineru/` data directory that matches the on-disk
 * model in docs/ARCH.md §3: one parsed document (fixture paper markdown,
 * content list, image, source PDF), annotations and translations.
 *
 * The directory always lives under `os.tmpdir()` by default; this script never
 * reads or writes `$DSH_HOME` and never touches the user's real library.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseMarkdown, blockKey } from '../ui/markdown.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'test', 'fixtures')

/** Fixed date so the demo library looks stable across runs. */
const NOW = new Date('2026-11-06T09:04:00.000Z')

/** Read a fixture file. */
function fixture(rel) {
  return readFileSync(join(FIXTURES, rel))
}

/** Build a tiny but structurally valid one-page PDF as the demo source file. */
function buildDemoPdf(title) {
  const stream = `BT /F1 18 Tf 72 760 Td (${title.replace(/[()\\]/g, '')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(pdf, 'utf8')
}

/** Locate a phrase inside the parsed block model and derive a valid annotation. */
function annotationFor(model, phrase, options) {
  for (const block of model.blocks) {
    if (typeof block.plainText !== 'string') continue
    const start = block.plainText.indexOf(phrase)
    if (start < 0) continue
    return {
      id: options.id,
      blockKey: blockKey(block.index, block.plainText),
      start,
      end: start + phrase.length,
      quote: phrase,
      color: options.color,
      note: options.note,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }
  }
  return null
}

/** Translation entries keyed by the reader block key. */
function translationEntryFor(model, phrase, translation) {
  for (const block of model.blocks) {
    if (typeof block.plainText !== 'string') continue
    const start = block.plainText.indexOf(phrase)
    if (start >= 0) return [blockKey(block.index, block.plainText), translation]
  }
  return null
}

/** Write the demo document tree and return a small report. */
function createDemoLibrary(outBase) {
  const markdown = fixture('paper.md').toString('utf8')
  const contentList = JSON.parse(fixture('content_list.json').toString('utf8'))
  const figure = fixture('images/fig1.svg')
  const source = buildDemoPdf('Sparse Expert Routing for Efficient Document Retrieval')

  const model = parseMarkdown(markdown)
  const title = model.outline.find((entry) => entry.level === 1)?.text ?? 'Sparse Expert Routing for Efficient Document Retrieval'
  const docId = randomUUID()
  const dataDir = join(outBase, 'mineru')
  const docDir = join(dataDir, 'documents', docId)

  mkdirSync(join(docDir, 'parsed', 'images'), { recursive: true })

  // meta.json — parsed document, standard engine.
  const meta = {
    schemaVersion: 1,
    id: docId,
    title,
    originalName: 'sparse-route.pdf',
    ext: '.pdf',
    mime: 'application/pdf',
    size: source.length,
    sha256: createHash('sha256').update(source).digest('hex'),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'parsed',
    error: null,
    parse: {
      engine: 'standard',
      modelVersion: 'vlm',
      language: 'ch',
      options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
      phase: null,
      taskId: null,
      batchId: 'demo-batch',
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      pages: Math.max(...contentList.map((item) => item.page_idx ?? 0)) + 1,
      progress: { extracted: 3, total: 3 },
      hasContentList: true,
    },
  }
  writeFileSync(join(docDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  writeFileSync(join(docDir, 'source.pdf'), source)
  writeFileSync(join(docDir, 'parsed', 'full.md'), markdown)
  writeFileSync(join(docDir, 'parsed', 'content_list.json'), `${JSON.stringify(contentList, null, 2)}\n`)
  writeFileSync(join(docDir, 'parsed', 'images', 'fig1.svg'), figure)

  // Annotation fixtures exercising the highlight + margin-note model.
  const annotations = [
    annotationFor(model, 'spend the same compute on every query', {
      id: 'a000000000001',
      color: 'yellow',
      note: '核心动机：查询难度不同，但检索编码器的计算量固定。',
    }),
    annotationFor(model, 'the model can grow in parameters while staying cheap at inference', {
      id: 'a000000000002',
      color: 'sage',
      note: '稀疏路由的好处：参数可以长，推理仍然便宜。',
    }),
    annotationFor(model, 'The adaptive controller recovers the small gap on the 1M collection', {
      id: 'a000000000003',
      color: 'sky',
      note: '自适应路由在 1M 集合上补回了差距，长查询才付出额外代价。',
    }),
  ].filter((annotation) => annotation !== null)
  writeFileSync(join(docDir, 'annotations.json'), `${JSON.stringify({ version: 1, items: annotations }, null, 2)}\n`)

  const translations = {
    version: 1,
    targetLanguage: 'zh',
    entries: {},
  }
  for (const [phrase, translation] of [
    ['Passage retrieval is the first stage of nearly every question-answering system.', '段落检索几乎是所有问答系统的第一阶段。'],
    ['SparseRoute keeps the standard dual-encoder interface:', 'SparseRoute 保持了标准的双塔编码器接口：'],
    ['Routing is not uniform across a paper:', '路由在一篇论文内部并不是均匀的：'],
  ]) {
    const entry = translationEntryFor(model, phrase, translation)
    if (entry !== null) translations.entries[entry[0]] = entry[1]
  }
  writeFileSync(join(docDir, 'translations.json'), `${JSON.stringify(translations, null, 2)}\n`)

  // Host-owned preferences live at the data-dir root.
  const preferences = {
    targetLanguage: 'zh',
    translationProvider: 'auto',
    readingMode: 'original',
    readingScale: 1,
    defaultEngine: 'auto',
    defaultModelVersion: 'vlm',
    defaultLanguage: 'ch',
    defaultIsOcr: false,
    defaultEnableFormula: true,
    defaultEnableTable: true,
    showPageMarks: true,
  }
  writeFileSync(join(dataDir, 'preferences.json'), `${JSON.stringify(preferences, null, 2)}\n`)

  return { dataDir, docDir, docId, title, annotations: annotations.length, blocks: model.blocks.length }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const args = process.argv.slice(2)
  let base
  const outIndex = args.indexOf('--out')
  if (outIndex >= 0 && args[outIndex + 1]) {
    base = resolve(args[outIndex + 1])
    mkdirSync(base, { recursive: true })
  } else {
    base = mkdtempSync(join(tmpdir(), 'dsh-litnotes-demo-'))
  }

  try {
    const report = createDemoLibrary(base)
    console.log('')
    console.log('[demo] throwaway MinerU library created')
    console.log(`[demo] data dir:   ${report.dataDir}`)
    console.log(`[demo] document:   ${report.docId}  "${report.title}"`)
    console.log(`[demo] contents:   ${report.blocks} parsed blocks, ${report.annotations} annotations, 3 pages`)
    console.log('')
    console.log('[demo] point the plugin at this data dir (plugin config `dataDir`), e.g.:')
    console.log(`         dataDir: ${report.dataDir}`)
    console.log('[demo] or start the harness with:')
    console.log(`         DSH_HOME=${base}`)
    console.log('')
    console.log(`[demo] clean up with: rm -rf ${base}`)
    console.log('')
    if (!existsSync(report.docDir)) {
      console.error('[demo] WARNING: expected document directory was not written')
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`[demo] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export { createDemoLibrary }
