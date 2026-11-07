/**
 * Real-library adversarial smoke test (read-only user data, temp workspace).
 *
 * Runs the **real** local engine (vendored pdf.js, no injection) over a PDF
 * copied from the user's actual 1.0.0 library (`~/.dsh/litnotes`) into a temp
 * data dir. This proves the port still handles real-world PDFs, not just the
 * fixtures. Nothing from the user's library is written into the repo, and the
 * library itself is only read.
 *
 * The test skips (and logs why) when the real library is not available; set
 * `DSH_LITNOTES_REAL_LIBRARY` to point at a copy elsewhere.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { Logger } from '../../src/host/host-services.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { createLocalEngine } from '../../src/host/parse/local/engine.ts'
import { createParseManager } from '../../src/host/parse/manager.ts'
import { createStore } from '../../src/host/store/index.ts'
import { waitFor } from '../helpers/parse-fixtures.ts'

/** The user's real library (read-only). */
const REAL_LIBRARY = process.env.DSH_LITNOTES_REAL_LIBRARY ?? join(homedir(), '.dsh', 'litnotes')

/** One real PDF sample. */
interface RealPdfSample {
  path: string
  bytes: Buffer
  docId: string
}

/** Discover the PDF sources of the real library (largest bounded, smallest first). */
async function findRealPdfs(): Promise<RealPdfSample[]> {
  const documentsDir = join(REAL_LIBRARY, 'documents')
  if (!existsSync(documentsDir)) return []
  const entries = await readdir(documentsDir, { withFileTypes: true })
  const samples: RealPdfSample[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sourcePath = join(documentsDir, entry.name, 'source.pdf')
    if (!existsSync(sourcePath)) continue
    try {
      const bytes = await readFile(sourcePath)
      if (bytes.length > 0 && bytes.length <= 128 * 1024 * 1024) {
        samples.push({ path: sourcePath, bytes, docId: entry.name })
      }
    } catch {
      /* unreadable source: try the next document */
    }
  }
  return samples.sort((left, right) => left.bytes.length - right.bytes.length)
}

/** Silent host logger for the smoke run. */
const SILENT_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} }

test(
  'local engine parses a PDF from the real 1.0.0 library (read-only copy)',
  { timeout: 180_000 },
  async () => {
    const samples = await findRealPdfs()
    if (samples.length === 0) {
      console.log(`[real-library] skipped: no source.pdf under ${REAL_LIBRARY}/documents`)
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'dsh-litnotes-reallib-'))
    const config = resolveConfig({
      dataDir: join(root, 'data'),
      pollIntervalMs: 10,
      parseTimeoutMs: 120_000,
    })
    const store = createStore({ dataDir: config.dataDir, logger: SILENT_LOGGER })
    await store.init()
    const manager = createParseManager({
      store,
      config,
      logger: SILENT_LOGGER,
      getToken: () => undefined,
      fetchImpl: async () => {
        throw new Error('the real-library smoke test must never use the network')
      },
      localEngine: createLocalEngine({ config, logger: SILENT_LOGGER }),
    })
    /** One observed outcome per attempted real PDF. */
    interface Outcome {
      docId: string
      sourceBytes: number
      status: string
      pages: number | null
      chars: number | null
      ms: number
      error: string | null
    }
    const outcomes: Outcome[] = []
    try {
      for (const sample of samples) {
        const id = randomUUID()
        const tempPath = store.newTempPath(id)
        await writeFile(tempPath, sample.bytes)
        await store.createFromFile({ id, tempPath, originalName: 'real-library-sample.pdf' })
        const startedAt = Date.now()
        await manager.start(id, {
          engine: 'local',
          params: { fileName: 'real-library-sample.pdf', language: 'local', localProvider: 'builtin' },
        })
        const final = await waitFor(
          () => {
            const current = store.get(id)
            return current !== undefined && (current.status === 'parsed' || current.status === 'failed')
              ? current
              : null
          },
          { label: `real PDF ${sample.docId} parse`, timeout: 120_000 },
        )
        const parse = final.parse
        outcomes.push({
          docId: sample.docId,
          sourceBytes: sample.bytes.length,
          status: final.status,
          pages: parse?.pages ?? null,
          chars: parse?.local?.textChars ?? null,
          ms: Date.now() - startedAt,
          error: final.error,
        })
        if (final.status === 'parsed') {
          const read = await store.readMarkdown(id)
          assert.ok(read.markdown.trim().length > 0, 'parsed markdown must not be empty')
          assert.ok((parse?.local?.pageCount ?? 0) >= 1, 'at least one page is extracted')
          assert.ok((parse?.local?.textChars ?? 0) > 0, 'positive text char count')
          assert.equal(parse?.local?.toolVersion, 'pdfjs-dist/5.4.449')
        } else {
          // Scanned/encrypted PDFs are legitimate local outcomes; log and try the next.
          console.log(
            `[real-library] ${sample.docId}: ${final.status} (${final.error ?? 'no error message'})`,
          )
        }
      }
      // Human-readable numbers for the acceptance report (Lead: "report numbers only").
      console.log(`[real-library] outcomes: ${JSON.stringify(outcomes)}`)
      assert.ok(
        outcomes.some((outcome) => outcome.status === 'parsed'),
        'at least one real user PDF must parse locally',
      )
    } finally {
      await manager.dispose().catch(() => {})
      await store.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  },
)
