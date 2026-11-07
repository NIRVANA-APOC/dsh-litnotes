/**
 * dsh-litnotes pre-install gate (TypeScript).
 *
 *   node scripts/check.ts             # full gate (what CI / the Lead runs)
 *   node scripts/check.ts --no-tests  # skip vitest while iterating
 *   node scripts/check.ts --final     # release gate: transition warnings fail
 *
 * Validates, in order:
 *   1. package manifest (name/version/dsh bundle+client/exports/files).
 *   2. cordis.patch.yml: one insert row with id/name `dsh-litnotes`.
 *   3. locale metadata (meta.title + meta.description, en + zh).
 *   4. icon.svg and the sidebar artwork.
 *   5. vendored pdf.js runtime files and version lock.
 *   6. no legacy identity markers (`dsh-mineru`, `Mru`, `__MINERU_`, …) in
 *      shipped sources, docs or manifest; with --final the old JS/UI trees and
 *      historical docs must be gone too.
 *   7. `tsc -p tsconfig.json` (strict, no emit).
 *   8. `node scripts/build.ts --check` (both bundles build + syntax-parse).
 *   9. generated artifacts: loader format, external module requests, sizes and
 *      the Host module's exported plugin identity.
 *  10. `vitest run` (unit + component + artifact tests).
 *
 * Prints a compact PASS/FAIL/WARN table and exits non-zero on any FAIL.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = new Set(process.argv.slice(2))
const SKIP_TESTS = ARGS.has('--no-tests')
const FINAL = ARGS.has('--final')

type Status = 'PASS' | 'FAIL' | 'WARN'
interface Result {
  name: string
  status: Status
  detail: string
}

const results: Result[] = []

/** Record one gate result. */
function add(name: string, status: Status, detail = ''): void {
  results.push({ name, status, detail })
}

/** Run one check; a thrown error becomes a FAIL with its message. */
async function check(name: string, fn: () => string | void | Promise<string | void>): Promise<void> {
  try {
    const detail = await fn()
    add(name, 'PASS', detail ?? '')
  } catch (error) {
    add(name, 'FAIL', error instanceof Error ? error.message : String(error))
  }
}

/** Run a check whose failure is only a WARN before the release gate. */
async function transitionCheck(
  name: string,
  fn: () => string | void | Promise<string | void>,
): Promise<void> {
  try {
    const detail = await fn()
    add(name, 'PASS', detail ?? '')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    add(name, FINAL ? 'FAIL' : 'WARN', message)
  }
}

/** Read a repo-relative UTF-8 file. */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** All regular files under `dir` (repo-relative POSIX paths), skipping heavy dirs. */
function walk(dir = ROOT, skip = new Set(['node_modules', '.git', '.agents', '.build'])): string[] {
  const out: string[] = []
  const visit = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const child = join(absolute, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) out.push(relative(ROOT, child).split(sep).join('/'))
    }
  }
  visit(dir)
  return out
}

const ALL_FILES = walk()

/** Match one path against a simple glob supporting `*` and `**`. */
function matchesGlob(relPath: string, pattern: string): boolean {
  const parts = pattern.split('/')
  const segments = relPath.split('/')
  const segmentMatches = (glob: string, value: string): boolean => {
    if (!glob.includes('*')) return glob === value
    const escaped = glob
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')
    return new RegExp(`^${escaped}$`).test(value)
  }
  const match = (pi: number, si: number): boolean => {
    if (pi === parts.length) return si === segments.length
    if (parts[pi] === '**') {
      for (let index = si; index <= segments.length; index += 1) if (match(pi + 1, index)) return true
      return false
    }
    if (si >= segments.length) return false
    const part = parts[pi]
    if (part === undefined) return false
    if (!segmentMatches(part, segments[si] ?? '')) return false
    return match(pi + 1, si + 1)
  }
  return match(0, 0)
}

/** Legacy identity markers that must never ship in 2.0. */
const LEGACY_MARKERS = [
  'dsh-mineru',
  '__MINERU',
  'MRU_',
  'Mru',
  'mru-',
  'dsh-scholar',
  'dsh-mineru/api-token',
  'renamed from',
  '前身为',
]

/** Historical docs that the 2.0 docs set replaces. */
const HISTORICAL_DOCS = [
  'docs/QA-REPORT.md',
  'docs/QA-REPORT-AI.md',
  'docs/DESIGN-NOTES.md',
  'docs/UI-POLISH-SPEC.md',
  'docs/RESEARCH.md',
  'docs/MINERU.md',
  'docs/LOCAL-FALLBACK.md',
  'docs/LOCAL-RICH-CONTENT.md',
]

/** Files the legacy implementation shipped and 2.0 must not. */
const LEGACY_TREES = ['ui/', 'lib/', 'index-legacy.js', 'scripts/build-client.mjs', 'scripts/check.mjs']

// ---------------------------------------------------------------------------
// 1. package manifest
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: unknown
  version?: unknown
  type?: unknown
  main?: unknown
  exports?: Record<string, unknown>
  files?: unknown
  dsh?: {
    bundle?: { patch?: unknown }
    client?: { platform?: unknown; immediately?: unknown; inject?: unknown }
  }
  devDependencies?: Record<string, string>
}

let pkg: PackageJson = {}

await check('package.json manifest', () => {
  pkg = JSON.parse(read('package.json')) as PackageJson
  const problems: string[] = []
  if (pkg.name !== 'dsh-litnotes') problems.push(`name is ${JSON.stringify(pkg.name)}`)
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    problems.push(`version is ${JSON.stringify(pkg.version)}`)
  }
  if (pkg.type !== 'module') problems.push('type must be "module"')
  if (pkg.main !== 'index.js') problems.push(`main is ${JSON.stringify(pkg.main)}, expected index.js`)
  const exportsField = pkg.exports ?? {}
  for (const [key, expected] of [
    ['.', './index.js'],
    ['./client', './lib/client.js'],
    ['./locale/*.json', './locale/*.json'],
    ['./icon', './icon.svg'],
  ] as const) {
    if (exportsField[key] !== expected) problems.push(`exports["${key}"] must be ${expected}`)
  }
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !existsSync(join(ROOT, patch))) problems.push('dsh.bundle.patch is missing')
  const client = pkg.dsh?.client
  if (client?.platform !== 'web') problems.push('dsh.client.platform must be web')
  if (client?.immediately !== true) problems.push('dsh.client.immediately must be true')
  const inject = client?.inject
  for (const required of [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ]) {
    if (!Array.isArray(inject) || !inject.includes(required)) problems.push(`dsh.client.inject lacks ${required}`)
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return `name=${String(pkg.name)}, v${String(pkg.version)}, client=web`
})

await check('package.json files allowlist', () => {
  const files = Array.isArray(pkg.files) ? (pkg.files as string[]) : []
  for (const required of ['index.js', 'lib/**/*.js', 'vendor/**', 'locale/*.json', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
    if (!files.includes(required)) throw new Error(`files is missing "${required}"`)
  }
  const missing = files.filter((pattern) => !ALL_FILES.some((file) => matchesGlob(file, pattern)))
  if (missing.length > 0) throw new Error(`files patterns resolve to nothing: ${missing.join(', ')}`)
  return `${files.length} patterns`
})

// ---------------------------------------------------------------------------
// 2. cordis patch
// ---------------------------------------------------------------------------

await check('cordis.patch.yml', () => {
  const text = read('cordis.patch.yml')
  if (!text.includes('id: dsh-litnotes')) throw new Error('missing insert row id: dsh-litnotes')
  if (!text.includes('name: dsh-litnotes')) throw new Error('missing insert row name: dsh-litnotes')
  return 'one insert row'
})

// ---------------------------------------------------------------------------
// 3. locale metadata
// ---------------------------------------------------------------------------

await check('locale metadata (en, zh)', () => {
  for (const locale of ['en', 'zh']) {
    const parsed = JSON.parse(read(`locale/${locale}.json`)) as {
      meta?: { title?: unknown; description?: unknown }
    }
    if (typeof parsed.meta?.title !== 'string' || parsed.meta.title === '') {
      throw new Error(`${locale}: meta.title is missing`)
    }
    if (typeof parsed.meta?.description !== 'string' || parsed.meta.description === '') {
      throw new Error(`${locale}: meta.description is missing`)
    }
  }
  return 'title + description in en/zh'
})

// ---------------------------------------------------------------------------
// 4. artwork
// ---------------------------------------------------------------------------

await check('plugin icon', () => {
  const svg = read('icon.svg')
  if (!svg.includes('<svg') || !svg.includes('</svg>')) throw new Error('icon.svg is not an SVG document')
  const bytes = statSync(join(ROOT, 'icon.svg')).size
  if (bytes > 256 * 1024) throw new Error(`icon.svg is ${bytes} bytes (cap 262144)`)
  return `${bytes} B`
})

// ---------------------------------------------------------------------------
// 5. vendored pdf.js
// ---------------------------------------------------------------------------

const PDFJS_VERSION = '5.4.449'

await transitionCheck('vendor pdf.js runtime', () => {
  for (const rel of ['vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs', 'vendor/pdfjs/LICENSE']) {
    if (!existsSync(join(ROOT, rel))) throw new Error(`missing ${rel}`)
    if (statSync(join(ROOT, rel)).size === 0) throw new Error(`${rel} is empty`)
  }
  const hostSource = ALL_FILES.filter((file) => file.startsWith('src/host/'))
    .map((file) => read(file))
    .join('\n')
  if (!hostSource.includes(PDFJS_VERSION)) throw new Error(`src/host/** does not mention PDFJS_VERSION ${PDFJS_VERSION}`)
  return `pdfjs ${PDFJS_VERSION}`
})

// ---------------------------------------------------------------------------
// 6. legacy identity audit
// ---------------------------------------------------------------------------

function scanLegacy(files: string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    const text = read(file)
    for (const marker of LEGACY_MARKERS) {
      if (text.includes(marker)) hits.push(`${file}: ${marker}`)
    }
  }
  return hits
}

/** Legacy implementation files, removed by the cleanup workstream. */
const LEGACY_FILES = new Set(['scripts/build-client.mjs', 'scripts/check.mjs', 'scripts/demo.mjs'])

await check('new code identity (no legacy markers)', () => {
  const files = ALL_FILES.filter(
    (file) =>
      !LEGACY_FILES.has(file) &&
      file !== 'scripts/check.ts' &&
      (file.startsWith('src/') ||
        file.startsWith('scripts/') ||
        (file.startsWith('test/') && (file.endsWith('.ts') || file.endsWith('.tsx'))) ||
        file.startsWith('locale/') ||
        file === 'cordis.patch.yml' ||
        file === 'icon.svg'),
  )
  const hits = scanLegacy(files)
  if (hits.length > 0) {
    throw new Error(`legacy markers found (${hits.length}): ${hits.slice(0, 6).join(' | ')}`)
  }
  return `${files.length} files clean`
})

await transitionCheck('docs identity (no legacy markers)', () => {
  const files = ALL_FILES.filter(
    (file) => file.startsWith('docs/') || file === 'README.md' || file === 'CHANGELOG.md' || file === 'package.json',
  )
  const hits = scanLegacy(files)
  if (hits.length > 0) throw new Error(`legacy markers found (${hits.length}): ${hits.slice(0, 6).join(' | ')}`)
  return `${files.length} files clean`
})

// ---------------------------------------------------------------------------
// 7. TypeScript
// ---------------------------------------------------------------------------

await check('typescript (tsc strict)', () => {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  return 'no type errors'
})

// ---------------------------------------------------------------------------
// 8. production build
// ---------------------------------------------------------------------------

await check('production build', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.ts'), '--check'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  const client = statSync(join(ROOT, 'lib', 'client.js')).size
  const host = statSync(join(ROOT, 'index.js')).size
  return `client ${(client / 1024).toFixed(1)} KiB, host ${(host / 1024).toFixed(1)} KiB`
})

// ---------------------------------------------------------------------------
// 9. generated artifacts
// ---------------------------------------------------------------------------

await check('client bundle contract', () => {
  const text = read('lib/client.js')
  if (!text.includes('window.__ModuleLoader__.load(')) throw new Error('missing module-loader shell')
  if (!text.includes('id: "dsh-litnotes"')) throw new Error('bundle id is not dsh-litnotes')
  if (/__LITNOTES_[A-Z_]+__/.test(text)) throw new Error('unreplaced build placeholder')
  const requests = new Set([...text.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))
  for (const request of requests) {
    if (request !== 'react') throw new Error(`unexpected runtime module request: ${request}`)
  }
  return `runtime requests: ${[...requests].join(', ') || 'none'}`
})

await check('host bundle contract', async () => {
  const module = (await import(pathToFileURL(join(ROOT, 'index.js')).href)) as {
    name?: unknown
    inject?: unknown
    apply?: unknown
  }
  if (module.name !== 'dsh-litnotes') throw new Error('host module has no name export')
  if (typeof module.apply !== 'function') throw new Error('host module has no apply export')
  if (!Array.isArray(module.inject)) throw new Error('host module has no inject export')
  return 'apply/inject/name present'
})

await check('dsh client entry files', () => {
  for (const rel of ['lib/client.js', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'cordis.patch.yml']) {
    if (!existsSync(join(ROOT, rel))) throw new Error(`missing shipped file ${rel}`)
  }
  return 'shipped files present'
})

// ---------------------------------------------------------------------------
// 10. transition hygiene (release gate makes these fail)
// ---------------------------------------------------------------------------

await transitionCheck('legacy trees removed', () => {
  // `lib/client.js` is the generated client artifact, not legacy code.
  const present = LEGACY_TREES.filter((prefix) =>
    ALL_FILES.some((file) => file.startsWith(prefix) && file !== 'lib/client.js'),
  )
  if (present.length > 0) throw new Error(`legacy files still present: ${present.join(', ')}`)
  return 'no legacy JS trees'
})

await transitionCheck('legacy node:test suite removed', () => {
  const legacyTests = ALL_FILES.filter(
    (file) => file.startsWith('test/') && (file.endsWith('.mjs') || file.endsWith('.js')),
  )
  if (legacyTests.length > 0) throw new Error(`${legacyTests.length} legacy test files still present`)
  return 'no legacy test files'
})

await transitionCheck('historical docs removed', () => {
  const present = HISTORICAL_DOCS.filter((file) => existsSync(join(ROOT, file)))
  if (present.length > 0) throw new Error(`historical docs still present: ${present.join(', ')}`)
  return 'docs set is current'
})

// ---------------------------------------------------------------------------
// 11. tests
// ---------------------------------------------------------------------------

await check('vitest', () => {
  if (SKIP_TESTS) return 'skipped'
  const binary = join(ROOT, 'node_modules', '.bin', 'vitest')
  if (!existsSync(binary)) throw new Error('vitest is not installed (run pnpm install)')
  const output = execFileSync(binary, ['run', '--reporter=dot'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  const line = output.split('\n').filter((entry) => entry.includes('Tests')).pop() ?? ''
  const match = /Tests\s+(\d+) passed/.exec(line) ?? /(\d+) passed/.exec(line)
  return match ? `${match[1]} tests passed` : 'tests passed'
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const width = Math.max(...results.map((result) => result.name.length), 10)
console.log('\ndsh-litnotes install gate\n')
for (const result of results) {
  const mark = result.status === 'PASS' ? 'PASS' : result.status === 'WARN' ? 'WARN' : 'FAIL'
  console.log(`  ${mark.padEnd(4)}  ${result.name.padEnd(width)}  ${result.detail}`)
}
const failed = results.filter((result) => result.status === 'FAIL')
const warned = results.filter((result) => result.status === 'WARN')
console.log(
  `\n${results.length} checks: ${results.length - failed.length - warned.length} passed, ` +
    `${warned.length} warnings, ${failed.length} failed`,
)
if (failed.length > 0) {
  console.log('RESULT: FAIL')
  process.exitCode = 1
} else {
  console.log(FINAL ? 'RESULT: PASS (release gate)' : 'RESULT: PASS')
}
