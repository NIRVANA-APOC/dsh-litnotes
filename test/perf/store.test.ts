/**
 * Performance: the on-disk library store at library scale.
 *
 * Builds a deterministic **library-sized fixture set** in a temp directory that
 * mirrors the real `${DSH_HOME}/litnotes` layout (frozen 1.0.0 on-disk shape):
 * 200 document directories with `meta.json`, annotations, translations and one
 * parsed document carrying the canonical MinerU paper markdown + content list.
 * The real library this machine holds is two documents of the same shape; 200
 * is the "a few hundred papers" scale a literature desk must stay responsive at.
 *
 * Times are recorded only — the test asserts functional correctness (counts and
 * loaded payloads), never a duration. Numbers are printed as `PERF {...}` lines.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createStore } from '../../src/host/store/index.ts'
import type { StoreApi } from '../../src/host/contracts.ts'
import type { Annotation, DocumentMeta } from '../../src/shared/model.ts'
import { standardContentList, standardMarkdown } from '../helpers/parse-fixtures.ts'
import { measureAsync, measureSync } from './perf.ts'

/** Number of fixture documents: a realistic large personal literature library. */
const LIBRARY_DOCS = 200
/** Annotations per fixture document (a lightly annotated paper). */
const NOTES_PER_DOC = 2
/** Translation entries per fixture document. */
const TRANSLATIONS_PER_DOC = 12

const paperMarkdown = standardMarkdown()
const paperContentList = standardContentList()

let dataDir = ''
const documentIds: string[] = []
let parsedDocId = ''

/** One fixture annotation on a block. */
function fixtureAnnotation(index: number): Annotation {
  return {
    id: `perf-note-${index}`,
    blockKey: `b${index}:ab12cd34`,
    start: 0,
    end: 24,
    quote: 'a representative annotated quote',
    note: `performance fixture annotation ${index}`,
    color: index % 2 === 0 ? 'yellow' : 'sage',
  }
}

/** Frozen 1.0.0-shaped metadata for one fixture document. */
function fixtureMeta(id: string, index: number): DocumentMeta {
  const parsed = index % 10 !== 0
  const createdAt = new Date(Date.UTC(2026, 0, 1 + (index % 27), index % 24)).toISOString()
  return {
    schemaVersion: 1,
    id,
    title: `Performance Fixture Paper ${index + 1}: Subgraph Matching Methods`,
    originalName: `fixture-${index + 1}.pdf`,
    ext: '.pdf',
    mime: 'application/pdf',
    size: 900_000 + index * 1024,
    sha256: `${(index * 7919).toString(16).padStart(8, '0')}`.repeat(8).slice(0, 64),
    createdAt,
    updatedAt: createdAt,
    status: parsed ? 'parsed' : 'uploaded',
    error: null,
    parse: parsed
      ? {
          engine: 'standard',
          provider: null,
          modelVersion: 'vlm',
          language: 'ch',
          options: null,
          phase: null,
          remoteState: null,
          taskId: null,
          batchId: null,
          startedAt: createdAt,
          finishedAt: createdAt,
          pages: 12,
          progress: null,
          hasContentList: true,
          local: null,
        }
      : null,
  }
}

/** Write the shared preferences document once. */
async function writePreferences(): Promise<void> {
  await writeFile(
    join(dataDir, 'preferences.json'),
    `${JSON.stringify(
      {
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
        aiPanelOpen: false,
        marginTab: 'outline',
        notesFilter: 'all',
        libraryView: 'library',
        docView: 'read',
        graphAutoBuild: false,
        autoAllowAgentFallback: true,
      },
      null,
      2,
    )}\n`,
  )
}

/** One fixture document's on-disk payload, written concurrently (timing excludes setup). */
async function writeFixtureDocument(id: string, index: number): Promise<void> {
  const dir = join(dataDir, 'documents', id)
  await mkdir(dir, { recursive: true })
  const items = Array.from({ length: NOTES_PER_DOC }, (_value, noteIndex) => fixtureAnnotation(index * 10 + noteIndex))
  const entries: Record<string, string> = {}
  for (let entryIndex = 0; entryIndex < TRANSLATIONS_PER_DOC; entryIndex += 1) {
    entries[`b${entryIndex}:ab12cd34`] = `译文条目 ${entryIndex}：为了性能测试生成的代表性翻译文本。`
  }
  const files: Array<Promise<unknown>> = [
    writeFile(join(dir, 'meta.json'), `${JSON.stringify(fixtureMeta(id, index), null, 2)}\n`),
    writeFile(join(dir, 'annotations.json'), `${JSON.stringify({ version: 1, items }, null, 2)}\n`),
    writeFile(join(dir, 'translations.json'), `${JSON.stringify({ version: 1, targetLanguage: 'zh', entries }, null, 2)}\n`),
  ]
  if (index === 0) {
    parsedDocId = id
    const parsedDir = join(dir, 'parsed')
    await mkdir(parsedDir, { recursive: true })
    files.push(writeFile(join(parsedDir, 'full.md'), paperMarkdown))
    files.push(writeFile(join(parsedDir, 'content_list.json'), `${JSON.stringify(paperContentList)}\n`))
  }
  await Promise.all(files)
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-perf-store-'))
  await mkdir(join(dataDir, 'documents'), { recursive: true })
  await mkdir(join(dataDir, 'tmp'), { recursive: true })
  await mkdir(join(dataDir, 'diagnostics'), { recursive: true })
  await writePreferences()
  for (let index = 0; index < LIBRARY_DOCS; index += 1) documentIds.push(randomUUID())
  await Promise.all(documentIds.map((id, index) => writeFixtureDocument(id, index)))
}, 120_000)

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/** Create one store over the shared fixture data directory. */
async function openStore(): Promise<StoreApi> {
  const store = createStore({ dataDir })
  await store.init()
  return store
}

test('store init loads the library-sized metadata index', { timeout: 120_000 }, async () => {
  let lastTotal = 0
  await measureAsync(
    { suite: 'store', case: 'init-index', iters: 3, note: `documents=${LIBRARY_DOCS}` },
    async () => {
      const store = await openStore()
      lastTotal = store.stats().total
      await store.dispose()
    },
  )
  expect(lastTotal).toBe(LIBRARY_DOCS)
})

test('store list + get on a library-sized library', { timeout: 120_000 }, async () => {
  const store = await openStore()
  measureSync(
    { suite: 'store', case: 'list-documents', iters: 500, note: `documents=${LIBRARY_DOCS}` },
    () => store.list(),
  )
  const list = store.list()
  expect(list).toHaveLength(LIBRARY_DOCS)
  // Newest-first ordering is part of the frozen contract.
  expect(Date.parse(list[0]?.updatedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(list.at(-1)?.updatedAt ?? ''))

  let cursor = 0
  measureSync(
    { suite: 'store', case: 'get-document', iters: 5_000, note: `documents=${LIBRARY_DOCS}` },
    () => {
      const id = documentIds[cursor % LIBRARY_DOCS] ?? ''
      cursor += 1
      return store.get(id)
    },
  )
  expect(store.get(documentIds[42] ?? '')?.title).toContain('Performance Fixture Paper 43')
  expect(store.get('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  await store.dispose()
})

test('store loads annotations and translations at library scale', { timeout: 120_000 }, async () => {
  const store = await openStore()
  await measureAsync(
    { suite: 'store', case: 'load-annotations', iters: 200, note: `notesPerDocument=${NOTES_PER_DOC}` },
    () => store.loadAnnotations(documentIds[7] ?? ''),
  )
  const annotations = await store.loadAnnotations(documentIds[7] ?? '')
  expect(annotations.version).toBe(1)
  expect(annotations.items).toHaveLength(NOTES_PER_DOC)
  expect(annotations.items[0]?.quote).toBe('a representative annotated quote')

  await measureAsync(
    { suite: 'store', case: 'load-translations', iters: 200, note: `entriesPerDocument=${TRANSLATIONS_PER_DOC}` },
    () => store.loadTranslations(documentIds[9] ?? ''),
  )
  const translations = await store.loadTranslations(documentIds[9] ?? '')
  expect(Object.keys(translations.entries)).toHaveLength(TRANSLATIONS_PER_DOC)
  await store.dispose()
})

test('store reads a parsed document (markdown + content list)', { timeout: 120_000 }, async () => {
  const store = await openStore()
  await measureAsync(
    { suite: 'store', case: 'read-markdown', iters: 100, bytes: paperMarkdown.length, note: 'canonical fixture paper' },
    () => store.readMarkdown(parsedDocId),
  )
  const parsed = await store.readMarkdown(parsedDocId)
  expect(parsed.markdown).toBe(paperMarkdown)
  expect(parsed.contentList).toHaveLength(paperContentList.length)
  expect(parsed.pages).toBeGreaterThan(0)
  await store.dispose()
})

test('store readPreferences on the library-sized fixture', { timeout: 120_000 }, async () => {
  const store = await openStore()
  await measureAsync({ suite: 'store', case: 'read-preferences', iters: 100 }, () => store.readPreferences())
  const preferences = await store.readPreferences()
  expect(preferences.libraryView).toBe('library')
  await store.dispose()
})
