/**
 * dsh-litnotes pre-install gate.
 *
 *   node scripts/check.mjs            # full gate (what the Lead runs)
 *   node scripts/check.mjs --no-tests # skip the node:test run while iterating
 *   node scripts/check.mjs --no-build # skip the client-bundle build check
 *
 * Validates, in order:
 *   1. package.json: name, dsh.bundle.patch target, dsh.client (web + exports
 *      `.` / `./client`), and that the `files` allowlist covers the runtime.
 *   2. cordis.patch.yml: one insert row with id/name `dsh-litnotes` (line-based,
 *      no YAML dependency).
 *   3. locale/{en,zh}.json: meta.title + meta.description.
 *   4. icon.svg + ui/*.svg exist and look like SVG documents.
 *   5. vendored pdf.js runtime files (pdf.mjs / pdf.worker.mjs / LICENSE)
 *      exist, are non-empty and stay in sync with `PDFJS_VERSION`.
 *   6. `node --check` on every shipped .js/.mjs (index.js, lib/**, ui/*.js,
 *      scripts/**, test/**).
 *   6. generated client bundle sanity (lib/client.js: loader shell, no
 *      unreplaced __MINERU_ placeholders).
 *   7. `node scripts/build-client.mjs --check`.
 *   8. `node --test test/` (unit + reader + e2e), parsing the runner summary.
 *
 * Prints a compact PASS/FAIL table and exits non-zero on any failure.
 * Dependency-free; no npm install, no network.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = new Set(process.argv.slice(2))
const SKIP_TESTS = ARGS.has('--no-tests')
const SKIP_BUILD = ARGS.has('--no-build')

/** Collected check results. @type {{name: string, status: 'PASS'|'FAIL'|'WARN', detail: string}[]} */
const results = []

/** @param {string} name @param {'PASS'|'FAIL'|'WARN'} status @param {string} [detail] */
function add(name, status, detail = '') {
  results.push({ name, status, detail })
}

/** Run one check; a thrown error becomes a FAIL with its message. */
function check(name, fn) {
  try {
    const detail = fn()
    add(name, 'PASS', detail ?? '')
  } catch (error) {
    add(name, 'FAIL', error instanceof Error ? error.message : String(error))
  }
}

/** Read a file relative to the repo root. */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

// ---------------------------------------------------------------------------
// Tiny filesystem walk + glob matching (no dependencies)
// ---------------------------------------------------------------------------

/** All regular files under `dir` (repo-relative POSIX-ish paths), skipping heavy dirs. */
function walk(dir = ROOT) {
  const skip = new Set(['node_modules', '.git'])
  /** @type {string[]} */
  const out = []
  const visit = (absolute) => {
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

/** Match one path segment against a `*` wildcard segment. */
function segmentMatches(pattern, segment) {
  if (!pattern.includes('*')) return pattern === segment
  const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  return regex.test(segment)
}

/** Match a repo-relative path against a simple glob supporting `*` and `**`. */
function matchesGlob(relPath, pattern) {
  const parts = pattern.split('/')
  const segments = relPath.split('/')
  const match = (pi, si) => {
    if (pi === parts.length) return si === segments.length
    if (parts[pi] === '**') {
      for (let i = si; i <= segments.length; i += 1) if (match(pi + 1, i)) return true
      return false
    }
    if (si >= segments.length) return false
    if (!segmentMatches(parts[pi], segments[si])) return false
    return match(pi + 1, si + 1)
  }
  return match(0, 0)
}

// ---------------------------------------------------------------------------
// 1. package.json
// ---------------------------------------------------------------------------

/** @type {any} */
let pkg = {}
check('package.json manifest', () => {
  const raw = read('package.json')
  pkg = JSON.parse(raw)
  const problems = []
  if (pkg.name !== 'dsh-litnotes') problems.push(`name is ${JSON.stringify(pkg.name)}, expected "dsh-litnotes"`)
  if (pkg.type !== 'module') problems.push('type must be "module"')
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch === '') problems.push('dsh.bundle.patch is missing')
  else if (!existsSync(join(ROOT, patch))) problems.push(`dsh.bundle.patch target does not exist: ${patch}`)
  const client = pkg.dsh?.client
  if (!client || typeof client !== 'object') problems.push('dsh.client is missing')
  else if (client.platform !== 'web') problems.push(`dsh.client.platform is ${JSON.stringify(client.platform)}, expected "web"`)
  const exportsField = pkg.exports ?? {}
  for (const key of ['.', './client']) {
    const target = exportsField[key]
    if (typeof target !== 'string' || target === '') {
      problems.push(`exports[${JSON.stringify(key)}] is missing`)
      continue
    }
    if (!existsSync(join(ROOT, target))) problems.push(`exports[${JSON.stringify(key)}] target does not exist: ${target}`)
  }
  if (!Array.isArray(pkg.files)) problems.push('files allowlist is missing')
  if (problems.length > 0) throw new Error(problems.join('; '))
  return `name=dsh-litnotes, v${pkg.version}, client=${client.platform}, ${pkg.files.length} files entries`
})

// ---------------------------------------------------------------------------
// 2. package.json "files" allowlist covers what the runtime needs
// ---------------------------------------------------------------------------

check('package.json files allowlist', () => {
  const required = ['index.js', 'lib/**/*.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'ui/*.svg']
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const problems = []
  for (const pattern of required) {
    if (!files.includes(pattern)) problems.push(`files is missing ${JSON.stringify(pattern)}`)
    else if (!ALL_FILES.some((file) => matchesGlob(file, pattern))) {
      problems.push(`files pattern ${JSON.stringify(pattern)} matches no checked-in file`)
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return `${required.length} required patterns present`
})

check('package.json files entries resolve', () => {
  const warnings = []
  for (const entry of pkg.files ?? []) {
    if (typeof entry !== 'string' || entry === '') {
      warnings.push(`invalid files entry ${JSON.stringify(entry)}`)
      continue
    }
    if (!ALL_FILES.some((file) => matchesGlob(file, entry))) warnings.push(`${entry} matches no file`)
  }
  if (warnings.length > 0) add('package.json files entries resolve', 'WARN', warnings.join('; '))
  return `${(pkg.files ?? []).length} entries resolve`
})

// ---------------------------------------------------------------------------
// 3. cordis.patch.yml
// ---------------------------------------------------------------------------

check('cordis.patch.yml', () => {
  const yml = read('cordis.patch.yml')
  const lines = yml.split(/\r?\n/)
  const problems = []
  if (/\t/.test(yml)) problems.push('contains tab indentation')
  if (!lines.some((line) => /^\s*-\s*insert:\s*$/.test(line))) problems.push('no "- insert:" row')
  if (!lines.some((line) => /^\s*-\s*id:\s*dsh-litnotes\s*$/.test(line))) problems.push('no "- id: dsh-litnotes" row under insert')
  if (!lines.some((line) => /^\s+name:\s*dsh-litnotes\s*$/.test(line))) problems.push('no "name: dsh-litnotes" row')
  if (problems.length > 0) throw new Error(problems.join('; '))
  return 'insert row id/name dsh-litnotes'
})

// ---------------------------------------------------------------------------
// 4. locale metadata
// ---------------------------------------------------------------------------

check('locale metadata (en, zh)', () => {
  const problems = []
  for (const lang of ['en', 'zh']) {
    const rel = `locale/${lang}.json`
    let data
    try {
      data = JSON.parse(read(rel))
    } catch (error) {
      throw new Error(`${rel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const title = data?.meta?.title
    const description = data?.meta?.description
    if (typeof title !== 'string' || title.trim() === '') problems.push(`${rel}: meta.title is empty`)
    if (typeof description !== 'string' || description.trim() === '') problems.push(`${rel}: meta.description is empty`)
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return 'title + description in en/zh'
})

// ---------------------------------------------------------------------------
// 5. icons
// ---------------------------------------------------------------------------

check('icon.svg + ui/*.svg', () => {
  const svgs = ['icon.svg', ...ALL_FILES.filter((file) => /^ui\/[^/]+\.svg$/.test(file))]
  if (!svgs.includes('icon.svg')) throw new Error('icon.svg is missing')
  const problems = []
  for (const rel of svgs) {
    const source = read(rel).trim()
    if (!/<svg[\s>]/.test(source) || !source.includes('</svg>')) problems.push(`${rel} is not an SVG document`)
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return `${svgs.length} SVG files look valid`
})

// ---------------------------------------------------------------------------
// 5b. vendored pdf.js runtime (T0 local engine)
// ---------------------------------------------------------------------------

check('vendor pdf.js assets', () => {
  const required = ['vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs', 'vendor/pdfjs/LICENSE']
  const problems = []
  const sizes = new Map()
  for (const rel of required) {
    const absolute = join(ROOT, rel)
    if (!existsSync(absolute)) {
      problems.push(`${rel} is missing`)
      continue
    }
    const info = statSync(absolute)
    if (info.size <= 0) problems.push(`${rel} is empty`)
    else sizes.set(rel, info.size)
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  // The loader reports PDFJS_VERSION; it must describe the vendored bundle.
  const version = /export const PDFJS_VERSION = '([^']+)'/.exec(read('lib/local-pdf.js'))?.[1]
  if (typeof version !== 'string' || version === '') throw new Error('lib/local-pdf.js has no PDFJS_VERSION')
  for (const rel of ['vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs']) {
    if (!read(rel).includes(version)) throw new Error(`${rel} does not contain PDFJS_VERSION ${version}`)
  }
  const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`
  return `${required.length} files (pdf.mjs ${kib(sizes.get('vendor/pdfjs/pdf.mjs'))}, worker ${kib(
    sizes.get('vendor/pdfjs/pdf.worker.mjs'),
  )}), pdfjs ${version}`
})

// ---------------------------------------------------------------------------
// 6. `node --check` every shipped .js/.mjs
// ---------------------------------------------------------------------------

/** @returns {string[]} */
function shippedScripts() {
  const patterns = ['index.js', 'lib/**/*.js', 'ui/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'test/**/*.js', 'test/**/*.mjs']
  return ALL_FILES.filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
    .filter((file) => patterns.some((pattern) => matchesGlob(file, pattern)))
    .sort()
}

check('node --check (shipped JS)', () => {
  const files = shippedScripts()
  if (files.length === 0) throw new Error('no shipped .js/.mjs files found')
  const failures = []
  for (const rel of files) {
    const result = spawnSync(process.execPath, ['--check', join(ROOT, rel)], { encoding: 'utf8', timeout: 30_000 })
    if (result.status !== 0) {
      const firstLine = (result.stderr ?? '').split('\n').find((line) => line.trim() !== '') ?? 'syntax error'
      failures.push(`${rel}: ${firstLine.trim()}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length}/${files.length} file(s) failed: ${failures.slice(0, 6).join(' | ')}`)
  }
  return `${files.length} files parse`
})

// ---------------------------------------------------------------------------
// 7. generated client bundle
// ---------------------------------------------------------------------------

check('generated client bundle', () => {
  const rel = 'lib/client.js'
  if (!existsSync(join(ROOT, rel))) throw new Error(`${rel} is missing (run node scripts/build-client.mjs)`)
  const source = read(rel)
  const problems = []
  if (!source.includes('window.__ModuleLoader__.load')) problems.push('missing __ModuleLoader__ loader shell')
  if (!source.includes("id: 'dsh-litnotes'")) problems.push("missing id: 'dsh-litnotes'")
  if (source.includes('__MINERU_')) problems.push('unreplaced __MINERU_ placeholder survived')
  if (/^export\s/m.test(source)) problems.push('top-level export survived inlining')
  if (!source.includes('function clientMain')) problems.push('missing clientMain(require)')
  if (problems.length > 0) throw new Error(problems.join('; '))
  return `${(Buffer.byteLength(source) / 1024).toFixed(1)} KiB`
})

// ---------------------------------------------------------------------------
// 8. build-client.mjs --check
// ---------------------------------------------------------------------------

if (SKIP_BUILD) {
  add('client build check', 'WARN', 'skipped (--no-build)')
} else {
  check('client build check', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-client.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    })
    const stdout = (result.stdout ?? '').trim()
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').trim()
      throw new Error(stderr.split('\n').slice(-2).join(' ') || stdout || 'build-client failed')
    }
    return stdout.split('\n').at(-1) ?? 'ok'
  })
}

// ---------------------------------------------------------------------------
// 9. node --test test/
// ---------------------------------------------------------------------------

/** Parse the Node test runner summary (spec reporter: "ℹ pass 3"; TAP: "# pass 3"). */
function parseTestSummary(output) {
  const pick = (key) => {
    const match = new RegExp(`(?:ℹ|#)\\s*${key}\\s+(\\d+)`).exec(output)
    return match ? Number(match[1]) : undefined
  }
  return {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    skipped: pick('skipped'),
    cancelled: pick('cancelled'),
  }
}

if (SKIP_TESTS) {
  add('node --test test/', 'WARN', 'skipped (--no-tests)')
} else {
  check('node --test test/', () => {
    const result = spawnSync(process.execPath, ['--test', 'test/'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const summary = parseTestSummary(output)
    if (summary.tests === undefined || summary.fail === undefined) {
      const tail = output.trim().split('\n').slice(-8).join(' | ')
      throw new Error(`could not parse test summary (exit ${result.status}); output: ${tail}`)
    }
    if (summary.tests === 0) throw new Error('no test files were executed under test/')
    if ((summary.fail ?? 0) > 0 || result.status !== 0) {
      const failing = [...output.matchAll(/^\s*(?:✖|not ok \d+ -)\s*(.+)$/gm)]
        .map((match) => match[1].trim())
        .filter((name) => name !== '')
        .slice(0, 5)
      throw new Error(
        `${summary.fail} failed, ${summary.pass} passed${failing.length > 0 ? `: ${failing.join(', ')}` : ''}`,
      )
    }
    return `${summary.pass} passed, ${summary.fail} failed, ${summary.skipped ?? 0} skipped, ${summary.tests} tests`
  })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failures = results.filter((entry) => entry.status === 'FAIL')
const warnings = results.filter((entry) => entry.status === 'WARN')

console.log('')
console.log('dsh-litnotes install gate')
console.log('')
const width = Math.max(...results.map((entry) => entry.name.length), 10)
for (const entry of results) {
  const label = entry.status.padEnd(4)
  const detail = entry.detail === '' ? '' : `  ${entry.detail}`
  console.log(`  ${label}  ${entry.name.padEnd(width)}${detail}`)
}
console.log('')
const passed = results.filter((entry) => entry.status === 'PASS').length
console.log(
  `${results.length} checks: ${passed} passed, ${failures.length} failed` +
    (warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''),
)
if (failures.length > 0) {
  console.log('RESULT: FAIL')
  process.exitCode = 1
} else {
  console.log('RESULT: PASS')
}
