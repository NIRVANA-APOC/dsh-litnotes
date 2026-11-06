/**
 * Local PDF text-layer extractor for dsh-litnotes (T0 builtin engine).
 *
 * Wraps the vendored `pdfjs-dist` legacy **min** build
 * (`vendor/pdfjs/pdf.mjs`, Apache-2.0, 5.4.449) and turns a PDF's text layer
 * into per-page blocks consumed by `lib/local-synth.js`:
 *
 *   { kind:'heading', level:1..4, text } | { kind:'paragraph', text }
 *
 * Design notes:
 *  - The module is lazy: pdf.js (~1.5 MiB) is imported on the first local parse
 *    only, never at Host startup. Only the min build is vendored because the
 *    non-min legacy bundle costs +300 MiB RSS just to import.
 *  - Reading order trusts pdf.js' content-stream order (correct on the tested
 *    two-column academic PDFs; a column detector is a later refinement).
 *  - Headings prefer `getOutline()` (arXiv-class PDFs); otherwise a font-size +
 *    numbering heuristic is used. The title (possibly wrapped over 1–3 lines) is
 *    removed from the body blocks and emitted as `#` by the synthesizer.
 *  - Errors map to WireError codes `local-encrypted` / `local-failed`; page
 *    limits and text caps protect the Host from pathological PDFs.
 *
 * @module lib/local-pdf
 */
import { WireError } from './wire.js'

/** Exact vendored pdf.js version (kept in sync with `vendor/pdfjs/`). */
export const PDFJS_VERSION = '5.4.449'

/** Lazily imported pdf.js module (per process). */
let pdfjsPromise = null

/**
 * Minimal DOM stubs required by pdf.js' Node "fake worker" import.
 *
 * pdf.js only uses these for rendering; the local engine extracts text and
 * never rasterizes, so inert stubs are enough. Without them Node throws
 * `ReferenceError: DOMMatrix is not defined` while importing the vendored
 * legacy build (the optional `@napi-rs/canvas` package is not bundled).
 */
function installNodeDomPolyfills() {
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init) {
        const matrix = Array.isArray(init) && init.length === 6 ? init : [1, 0, 0, 1, 0, 0]
        this.a = matrix[0]
        this.b = matrix[1]
        this.c = matrix[2]
        this.d = matrix[3]
        this.e = matrix[4]
        this.f = matrix[5]
      }
    }
  }
  if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = class ImageData {}
  if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {}
}

/** pdf.js emits Node-canvas/DOM warnings that are irrelevant for text extraction. */
const IGNORED_BOOTSTRAP_WARNING = /@napi-rs\/canvas|DOMMatrix|ImageData|Path2D|Cannot polyfill/i

/**
 * Import the vendored pdf.js module once and wire its worker path.
 *
 * Node uses pdf.js' "fake worker": the worker module is imported on the same
 * thread. An explicit `workerSrc` file URL is the least surprising way to make
 * that resolution work regardless of the vendored file names.
 *
 * @returns {Promise<Record<string, any>>} the pdf.js module namespace.
 */
export function loadPdfjs() {
  if (pdfjsPromise === null) {
    pdfjsPromise = (async () => {
      installNodeDomPolyfills()
      // Suppress pdf.js' Node-canvas bootstrap warnings for the import window
      // only (they pollute Host logs and the text path never renders).
      const originalWarn = console.warn
      const originalLog = console.log
      const filtered = (...args) => {
        const text = args.map((value) => String(value)).join(' ')
        if (IGNORED_BOOTSTRAP_WARNING.test(text)) return
        originalWarn(...args)
      }
      console.warn = filtered
      console.log = filtered
      try {
        const module = await import(new URL('../vendor/pdfjs/pdf.mjs', import.meta.url).href)
        module.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href
        return module
      } finally {
        console.warn = originalWarn
        console.log = originalLog
      }
    })().catch((error) => {
      pdfjsPromise = null
      throw new WireError(
        'local-missing-tool',
        `内置 PDF 解析器加载失败（Cannot load the bundled pdf.js: ${error?.message ?? error}）`,
        503,
      )
    })
  }
  return pdfjsPromise
}

/** Abort-shaped error understood by the parse manager. */
function abortError() {
  const error = new Error('本地解析已取消（Local parse cancelled）')
  error.name = 'AbortError'
  return error
}

/** Throw when the caller cancelled the extraction. */
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

/** Normalize one extracted text line (collapse whitespace, trim). */
function normalizeLine(value) {
  return String(value ?? '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Median of a numeric array (returns 0 for empty input). */
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Lowercase, punctuation-stripped comparison form of a heading/title. */
function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^0-9a-z\u00e0-\u024f\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Group pdf.js text items into visual lines while preserving content order.
 *
 * pdf.js marks most line ends with `hasEOL`; a baseline jump is used as a
 * fallback for producers that omit it.
 *
 * @param {any[]} items - `textContent.items`.
 * @returns {{text:string, x:number, y:number, size:number}[]} ordered lines.
 */
function buildLines(items) {
  const lines = []
  let current = null

  const finish = () => {
    if (current === null) return
    const text = normalizeLine(current.chunks.join(''))
    if (text !== '') lines.push({ text, x: current.x, y: current.y, size: current.size })
    current = null
  }

  const start = (item) => {
    const transform = Array.isArray(item.transform) ? item.transform : []
    const size = Number.isFinite(item.height) && item.height > 0 ? item.height : 10
    return {
      chunks: [],
      x: Number.isFinite(transform[4]) ? transform[4] : 0,
      y: Number.isFinite(transform[5]) ? transform[5] : 0,
      size,
      lastY: Number.isFinite(transform[5]) ? transform[5] : 0,
    }
  }

  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object' || typeof item.str !== 'string') continue
    const transform = Array.isArray(item.transform) ? item.transform : []
    const y = Number.isFinite(transform[5]) ? transform[5] : 0
    const height = Number.isFinite(item.height) && item.height > 0 ? item.height : 10
    if (current === null) current = start(item)
    else if (Math.abs(current.lastY - y) > Math.max(2, current.size * 0.6)) {
      finish()
      current = start(item)
    }
    if (current === null) current = start(item)
    if (item.str !== '') current.chunks.push(item.str)
    current.lastY = y
    current.size = Math.max(current.size, height)
    if (item.hasEOL === true) finish()
  }
  finish()
  return lines
}

/** Flatten a pdf.js outline tree into `{title, depth}` records. */
function flattenOutline(items, depth = 0, out = []) {
  if (!Array.isArray(items) || depth > 6 || out.length >= 500) return out
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const title = normalizeLine(item.title)
    if (title !== '') out.push({ title, depth })
    if (Array.isArray(item.items)) flattenOutline(item.items, depth + 1, out)
  }
  return out
}

/** Read the PDF metadata title (best effort). */
async function readMetadataTitle(doc) {
  try {
    const metadata = await doc.getMetadata()
    const title = metadata?.info?.Title
    if (typeof title !== 'string') return null
    const clean = normalizeLine(title)
    if (clean === '' || clean.length > 300) return null
    if (/^(untitled|microsoft word\s*-|powerpoint presentation|slide\s*\d+|无标题)/i.test(clean)) return null
    return clean
  } catch {
    return null
  }
}

/** Whether one line looks like a numbered section heading. */
function numberedHeadingLevel(text) {
  const match = /^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+\S/.exec(text)
  if (match === null) return 0
  // Reject numeric table/result rows such as "28.4 1.0 41.8": a real heading
  // contains words.
  if (!/[A-Za-z\u4e00-\u9fff]{3,}/.test(text)) return 0
  const depth = match[1].split('.').length
  return Math.min(4, 1 + depth)
}

/** Known unnumbered academic headings (must be the whole line). */
const KNOWN_HEADINGS = /^(abstract|introduction|related work|background|(?:our )?method(?:s|ology)?|approach|experiment(?:s|al setup)?|evaluation|results?(?: and analysis)?|analysis|discussion|conclusion(?:s)?|limitations?|references|bibliography|acknowledg(?:e)?ments?|appendix|supplementary material)\s*[.:]?$/i

/** Whether a line is a plausible unnumbered heading (size-based). */
function isPlausibleHeading(line, bodySize) {
  const text = line.text
  if (text.length > 140 || text.length < 2) return false
  if (/[.,;:]$/.test(text)) return false
  if (/^\d+(?:\.\d+)*$/.test(text)) return false
  if (KNOWN_HEADINGS.test(text)) return true
  const size = Number(line.size) || 0
  if (bodySize <= 0) return size >= 1
  if (size >= bodySize * 1.18) return true
  return false
}

/**
 * Choose the document title among the first page's lines.
 *
 * Handles titles wrapped over 1–3 lines by matching the PDF metadata title
 * against consecutive normalized line prefixes. The chosen lines are removed
 * from the body blocks and the synthesizer emits the full title as `#`.
 *
 * @param {object[]} allLines - flattened lines with `page` index.
 * @param {string|null} metadataTitle - PDF metadata title, if any.
 * @returns {{lines: object[], text: string}} title lines and display text.
 */
function chooseTitle(allLines, metadataTitle) {
  const firstPage = allLines.filter((line) => line.page === 0).slice(0, 40)
  if (firstPage.length === 0) return { lines: [], text: metadataTitle ?? '' }
  const wanted = normalizeForMatch(metadataTitle)
  if (metadataTitle !== null && wanted !== '') {
    // Try runs of 1..3 consecutive lines whose joined normalized form is the
    // metadata title (or a prefix of it).
    for (let start = 0; start < Math.min(firstPage.length, 24); start += 1) {
      let joined = ''
      for (let end = start; end < Math.min(firstPage.length, start + 3); end += 1) {
        const piece = normalizeForMatch(firstPage[end].text)
        if (piece === '') break
        joined = joined === '' ? piece : `${joined} ${piece}`
        if (joined.length < 8) continue
        if (joined === wanted || wanted.startsWith(joined)) {
          return { lines: firstPage.slice(start, end + 1), text: metadataTitle }
        }
        if (!wanted.startsWith(joined)) break
      }
    }
    return { lines: [], text: metadataTitle }
  }
  // No usable metadata: promote the largest first-page line(s) that look like a
  // title. Wrapped titles (2–3 lines, same font size) are joined.
  const maxSize = Math.max(...firstPage.map((line) => Number(line.size) || 0))
  const isTitleLine = (line) => {
    const size = Number(line.size) || 0
    return line.text.length <= 220 && (maxSize === 0 || size >= maxSize * 0.92) && !/[.;,:]$/.test(line.text)
  }
  const start = firstPage.findIndex(isTitleLine)
  if (start === -1) return { lines: [], text: '' }
  const lines = [firstPage[start]]
  let text = firstPage[start].text
  for (let index = start + 1; index < Math.min(firstPage.length, start + 3); index += 1) {
    const line = firstPage[index]
    if (!isTitleLine(line) || text.length + line.text.length > 300) break
    lines.push(line)
    text = `${text} ${line.text}`
  }
  return { lines, text: text.trim() }
}

/** Strip leading section numbers from a normalized comparison string. */
function stripLeadingNumbers(normalized) {
  return normalized.replace(/^(?:\d{1,2}\s+)+/, '').trim()
}

/**
 * Remove repeated running headers/footers and page-number-only lines.
 *
 * @param {object[][]} pageLines - lines grouped per page.
 * @returns {object[][]} filtered lines (same shape).
 */
function stripRunningHeads(pageLines) {
  const pageCount = pageLines.length
  if (pageCount < 3) return pageLines.map((lines) => lines.filter((line) => !/^\d{1,4}$/.test(line.text)))
  const counts = new Map()
  for (const lines of pageLines) {
    const seen = new Set()
    for (const line of lines) {
      if (line.text.length > 140) continue
      const key = normalizeForMatch(line.text)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const repeated = (line) => {
    const key = normalizeForMatch(line.text)
    const count = counts.get(key) ?? 0
    return count >= 3 && count >= pageCount * 0.4
  }
  return pageLines.map((lines) => lines.filter((line) => !/^\d{1,4}$/.test(line.text) && !repeated(line)))
}

/**
 * Classify lines into page blocks (headings + paragraphs).
 *
 * Title lines are dropped (the synthesizer emits the title as `#`).
 *
 * @param {object[][]} pageLines - filtered lines per page.
 * @param {Set<object>} titleLines - lines that compose the document title.
 * @param {Map<object, number>} headingLevels - line -> heading level (1..4).
 * @returns {object[][]} page blocks for the synthesizer.
 */
function buildPageBlocks(pageLines, titleLines, headingLevels) {
  const pages = []
  for (let pageIndex = 0; pageIndex < pageLines.length; pageIndex += 1) {
    const lines = pageLines[pageIndex]
    const blocks = []
    let paragraph = []
    const flushParagraph = () => {
      if (paragraph.length === 0) return
      const text = joinLines(paragraph)
      paragraph = []
      if (text !== '') blocks.push({ kind: 'paragraph', text })
    }
    for (const line of lines) {
      if (titleLines.has(line)) {
        flushParagraph()
        continue
      }
      const level = headingLevels.get(line)
      if (level !== undefined) {
        flushParagraph()
        blocks.push({ kind: 'heading', level, text: line.text })
        continue
      }
      if (paragraph.length > 0) {
        const previous = paragraph[paragraph.length - 1]
        if (shouldBreakParagraph(previous, line)) flushParagraph()
      }
      paragraph.push(line)
    }
    flushParagraph()
    pages.push(blocks)
  }
  return pages
}

/** Whether two adjacent lines belong to different paragraphs. */
function shouldBreakParagraph(previous, line) {
  const previousY = Number(previous.y) || 0
  const lineY = Number(line.y) || 0
  const size = Math.max(Number(previous.size) || 10, Number(line.size) || 10)
  if (lineY > previousY + size * 0.6) return true
  if (previousY - lineY > size * 1.9) return true
  return false
}

/** Join collected lines into one paragraph, repairing hyphenated line breaks. */
function joinLines(lines) {
  let text = ''
  for (const line of lines) {
    if (text === '') {
      text = line.text
      continue
    }
    if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(line.text)) {
      text = text.slice(0, -1) + line.text
    } else {
      text += ' ' + line.text
    }
  }
  return text.trim()
}

/**
 * Extract one PDF's text layer into page blocks.
 *
 * @param {{
 *   data: Uint8Array|Buffer,
 *   maxPages?: number,
 *   maxTextBytes?: number,
 *   signal?: AbortSignal,
 *   onProgress?: (progress: {extracted:number,total:number}) => void,
 *   logger?: {warn?: Function},
 *   pdfjsModule?: Record<string, any>,
 * }} input - PDF bytes and bounds.
 * @returns {Promise<{
 *   pages: object[][], pageCount: number, title: string, chars: number,
 *   outlineUsed: boolean,
 * }>} extracted page blocks.
 */
export async function extractPdfText({
  data,
  maxPages = 500,
  maxTextBytes = 32 * 1024 * 1024,
  signal,
  onProgress,
  logger,
  pdfjsModule,
} = {}) {
  if (data === undefined || data === null) throw new WireError('bad-request', '缺少 PDF 数据（Missing PDF data）')
  const bytes = new Uint8Array(data)
  const pdfjs = pdfjsModule ?? (await loadPdfjs())
  throwIfAborted(signal)

  let loadingTask
  let doc
  try {
    loadingTask = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      useWorkerFetch: false,
      verbosity: 0,
    })
    doc = await loadingTask.promise
    const pageCount = Number.isInteger(doc.numPages) && doc.numPages > 0 ? doc.numPages : 0
    const pageLimit = Number.isFinite(maxPages) && maxPages > 0 ? Math.floor(maxPages) : 500
    if (pageCount > pageLimit) {
      throw new WireError(
        'too-large',
        `本地解析最多支持 ${pageLimit} 页（PDF has ${pageCount} pages; local limit is ${pageLimit}）`,
        413,
      )
    }

    const pageLines = []
    let chars = 0
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      throwIfAborted(signal)
      const page = await doc.getPage(pageNumber)
      const textContent = await page.getTextContent({ includeMarkedContent: false })
      const lines = buildLines(textContent?.items)
      pageLines.push(lines)
      chars += lines.reduce((sum, line) => sum + line.text.length, 0)
      if (chars > maxTextBytes) {
        throw new WireError('too-large', '提取文本超过本地解析上限（Extracted text exceeds local limit）', 413)
      }
      try {
        page.cleanup()
      } catch {
        /* page cleanup is best-effort */
      }
      onProgress?.({ extracted: pageNumber, total: pageCount })
    }

    const outline = await doc.getOutline().catch(() => null)
    const outlineItems = flattenOutline(outline)
    const metadataTitle = await readMetadataTitle(doc)

    const filtered = stripRunningHeads(pageLines)
    // Keep object identity: heading levels are tracked by line reference and the
    // same objects are later grouped into blocks.
    const allLines = []
    for (let page = 0; page < filtered.length; page += 1) {
      for (const line of filtered[page]) {
        line.page = page
        allLines.push(line)
      }
    }

    const title = chooseTitle(allLines, metadataTitle)
    const titleLines = new Set(title.lines)
    const headingLevels = new Map()

    // 1) Match pdf.js outline titles to extracted lines, in document order.
    let cursor = 0
    let matched = 0
    for (const item of outlineItems) {
      const wanted = normalizeForMatch(item.title)
      if (wanted === '') continue
      const wantedStripped = stripLeadingNumbers(wanted)
      for (let index = cursor; index < allLines.length; index += 1) {
        const line = allLines[index]
        if (titleLines.has(line)) continue
        if (headingLevels.has(line)) continue
        const normalized = normalizeForMatch(line.text)
        if (normalized === '' || line.text.length > 200) continue
        // Strict match: the line must *be* the outline title (numbering like
        // `3.2.1 ` is stripped on both sides). Loose prefix matching would
        // promote ordinary prose that happens to start with a section word.
        const lineStripped = stripLeadingNumbers(normalized)
        if (normalized === wanted || lineStripped === wantedStripped) {
          headingLevels.set(line, Math.min(4, item.depth + 2))
          cursor = index + 1
          matched += 1
          break
        }
      }
    }

    // 2) Font-size + numbering heuristic for the remaining lines. Page 0 body
    // text is excluded from the size rule: footnotes/licence notices there are
    // frequently larger than body text and would otherwise become headings.
    const sizes = allLines.filter((line) => line.text.length >= 20).map((line) => Number(line.size) || 0)
    const bodySize = median(sizes)
    for (const line of allLines) {
      if (titleLines.has(line) || headingLevels.has(line)) continue
      if (line.text.length < 2 || line.text.length > 140) continue
      if (/[.,;:]$/.test(line.text)) continue
      const numbered = numberedHeadingLevel(line.text)
      if (numbered > 0 && (line.size >= bodySize * 1.02 || KNOWN_HEADINGS.test(line.text))) {
        headingLevels.set(line, numbered)
        continue
      }
      if (line.page === 0) continue
      if (isPlausibleHeading(line, bodySize)) headingLevels.set(line, 2)
    }

    const pages = buildPageBlocks(filtered, titleLines, headingLevels)
    const finalChars = pages.reduce(
      (sum, blocks) => sum + blocks.reduce((pageSum, block) => pageSum + block.text.length, 0),
      0,
    )
    return {
      pages,
      pageCount,
      title: title.text,
      chars: finalChars,
      outlineUsed: matched > 0,
    }
  } catch (error) {
    if (error instanceof WireError) throw error
    if (error?.name === 'AbortError' || signal?.aborted) throw abortError()
    const name = typeof error?.name === 'string' ? error.name : ''
    if (name === 'PasswordException') {
      throw new WireError('local-encrypted', 'PDF 已加密，无法本地解析（The PDF is encrypted; local parsing is unavailable）', 422)
    }
    if (name === 'InvalidPDFException') {
      throw new WireError('local-failed', '文件不是有效的 PDF（The file is not a valid PDF）', 422)
    }
    if (name === 'UnknownErrorException' && /symbol/i.test(String(error?.message ?? ''))) {
      throw new WireError('local-encrypted', 'PDF 权限加密暂不支持本地解析（Owner-password PDFs are not supported locally）', 422)
    }
    const message = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').slice(0, 200)
    logger?.warn?.(`[dsh-litnotes] local pdf extraction failed: ${message}`)
    throw new WireError('local-failed', `本地解析失败（Local parsing failed）：${message || 'unknown error'}`, 500)
  } finally {
    try {
      await loadingTask?.destroy?.()
    } catch {
      /* destroying the loading task is best-effort */
    }
  }
}
