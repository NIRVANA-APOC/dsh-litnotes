/**
 * Shared MinerU/parse fixtures for the Host parse-pipeline tests.
 *
 * These are the typed 2.0 equivalents of the frozen helpers
 * (`test/e2e/helpers.mjs` + `test/fixtures/make-zip.mjs`): the canonical paper
 * markdown / content list / figure used by the mock MinerU server, the canonical
 * result ZIP, a small plausible PDF payload and a bounded async `waitFor`.
 *
 * Everything here reads only checked-in fixtures under `test/fixtures/` and the
 * in-memory ZIP writer; it never touches the network or the real library.
 *
 * @module test/helpers/parse-fixtures
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeZip } from './zip-builder.ts'

/** Absolute path of one checked-in fixture file. */
function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url))
}

/** Read one checked-in fixture as raw bytes. */
export function fixture(rel: string): Buffer {
  return readFileSync(fixturePath(rel))
}

/** Read one checked-in fixture as UTF-8 text. */
export function fixtureText(rel: string): string {
  return fixture(rel).toString('utf8')
}

/** The paper markdown served inside the mock's standard-API result ZIP. */
export function standardMarkdown(): string {
  return fixtureText('paper.md')
}

/** The content list served inside the mock's standard-API result ZIP. */
export function standardContentList(): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(fixtureText('content_list.json'))
  if (!Array.isArray(parsed)) throw new Error('content_list.json fixture is not an array')
  return parsed as Array<Record<string, unknown>>
}

/** The figure bytes served inside the mock's standard-API result ZIP. */
export function figureBytes(): Buffer {
  return fixture(join('images', 'fig1.svg'))
}

/** Markdown returned by the agent (lightweight) API mock. */
export function agentMarkdown(): string {
  return [
    '# Lightweight Parsing Result',
    '',
    'This document was parsed by the mock agent engine. It has no content list',
    'and no local images, which is exactly what the real lightweight API returns.',
    '',
    '## Equation',
    '',
    '$$',
    'y = \\sum_{i=1}^{n} x_i',
    '$$',
    '',
  ].join('\n')
}

/**
 * The canonical MinerU result archive: full markdown, a content list, one image,
 * plus files the parse manager must ignore (layout JSON, the original PDF).
 */
export function standardResultZip(): Buffer<ArrayBuffer> {
  return makeZip([
    { name: 'full.md', data: standardMarkdown() },
    { name: 'sample_content_list.json', data: fixtureText('content_list.json') },
    { name: 'images/fig1.svg', data: figureBytes() },
    { name: 'layout.json', data: '{"pdf_info":[]}' },
    { name: 'paper.pdf', data: pdfBytes() },
  ])
}

/** A small but plausible PDF payload for the "source" side of the upload. */
export function pdfBytes(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n% dsh-litnotes end-to-end fixture\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'utf8',
  )
}

/**
 * Create a temp directory inside `os.tmpdir()` and register its cleanup with a
 * vitest context (`ctx.onTestFinished` / the returned disposer).
 *
 * @param prefix - directory name prefix.
 * @returns the temp directory path plus an idempotent cleanup function.
 */
export async function createTempDir(prefix = 'dsh-litnotes-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  let removed = false
  return {
    dir,
    cleanup: async () => {
      if (removed) return
      removed = true
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** Options of {@link waitFor}. */
export interface WaitForOptions {
  timeout?: number
  interval?: number
  label?: string
}

/**
 * Poll `check` until it returns a truthy value or the timeout expires.
 *
 * Tests never busy-wait indefinitely: every wait is bounded and labelled, both
 * for fast CI and for a readable failure message.
 *
 * @param check - predicate; may be async.
 * @param options - timeout (default 5000 ms), interval (default 10 ms) and label.
 * @returns the resolved, non-nullish value that satisfied the predicate.
 */
export async function waitFor<T>(check: () => T | Promise<T>, options: WaitForOptions = {}): Promise<NonNullable<T>> {
  const { timeout = 5000, interval = 10, label = 'condition' } = options
  const deadline = Date.now() + timeout
  let lastError: unknown
  for (;;) {
    try {
      const value = await check()
      if (value) return value as NonNullable<T>
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      const suffix = lastError === undefined ? '' : ` (last error: ${String(lastError)})`
      throw new Error(`timed out after ${timeout}ms waiting for ${label}${suffix}`)
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, interval)
    })
  }
}
