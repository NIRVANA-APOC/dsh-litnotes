/**
 * Locale dictionary integrity: every area file owns its keys in zh + en, the
 * merged dictionaries must be key-complete, non-empty, duplicate-free, and
 * every key used through `t('…')` in client sources must exist.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../../src/client/i18n/index.ts'

const CLIENT_DIR = fileURLToPath(new URL('../../src/client/', import.meta.url))
const AREA_FILES = ['base.ts', 'read.ts', 'ai.ts', 'deepread.ts', 'graph.ts', 'lib.ts'] as const

/** All client source files (recursive). */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

describe('locale dictionaries', () => {
  it('has identical key sets in zh and en', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('has no empty or placeholder translations', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh:${key}`).not.toBe('')
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en:${key}`).not.toBe('')
      // A raw locale key as a value is a copy bug, not a translation.
      expect(value).not.toBe(key)
    }
  })

  it('does not declare the same key twice across area files', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const area of AREA_FILES) {
      const source = readFileSync(join(CLIENT_DIR, 'i18n', area), 'utf8')
      // Count only the zh dictionary (the en block repeats the same keys).
      const zhPart = source.split('export const en')[0] ?? source
      // Keys appear as quoted object keys inside the exported dictionary.
      for (const match of zhPart.matchAll(/^\s{2}'([a-zA-Z0-9_.-]+)':/gm)) {
        const key = match[1]
        if (key === undefined) continue
        const previous = seen.get(key)
        if (previous !== undefined) duplicates.push(`${key} (${previous} + ${area})`)
        else seen.set(key, area)
      }
    }
    expect(duplicates).toEqual([])
  })

  it('contains every key referenced by t(\'…\') in client sources', () => {
    const missing = new Set<string>()
    for (const file of sourceFiles(CLIENT_DIR)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)) {
        const key = match[1]
        if (key !== undefined && !(key in zh)) missing.add(`${file}: ${key}`)
      }
    }
    expect([...missing]).toEqual([])
  })
})
