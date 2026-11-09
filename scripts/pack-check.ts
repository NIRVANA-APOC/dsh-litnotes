/**
 * Verify the npm package tarball before it is published.
 *
 *   node scripts/pack-check.ts
 *
 * Packs the package exactly as `npm publish` would (the `files` allowlist in
 * package.json decides the contents) and asserts the contract the install
 * relies on: every runtime file the plugin loads is inside the tarball, and no
 * development tree leaked in. The tarball is left in `.build/` and its path is
 * printed as the last line (`TARBALL=<path>`) so CI and the publish workflow
 * can reuse the verified artifact as the GitHub release asset.
 *
 * CI runs this on every push; the publish workflow runs it before every npm
 * publish. It is also the fastest way to inspect what a release will ship.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, '.build')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * Resolve npm's CLI script next to the running node so the pack can run without
 * a shell: the Windows `npm.cmd`/`npm.ps1` shims cannot be spawned directly,
 * and spawning through a shell is both slower and deprecated by node.
 * Returns undefined when the layout is unknown, in which case the shim is used.
 */
function resolveNpmCli(): string | undefined {
  const nodeDir = dirname(process.execPath)
  const candidates = [
    // Windows node installer: <node>/node_modules/npm/bin/npm-cli.js
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Unix tarball / GitHub tool cache: <node>/lib/node_modules/npm/bin/npm-cli.js
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/** Runtime files the plugin resolves after `dsh plugin add`; all must ship. */
const REQUIRED = [
  'package.json',
  'index.js',
  'lib/client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'screenshots.json',
  'locale/en.json',
  'locale/zh.json',
  'vendor/pdfjs/pdf.mjs',
  'vendor/pdfjs/pdf.worker.mjs',
  'vendor/pdfjs/LICENSE',
  'vendor/katex/katex.min.js',
  'vendor/katex/katex.min.css',
  'vendor/katex/LICENSE',
  'docs/ARCH.md',
] as const

/** Prefixes that are development-only and must never be published. */
const FORBIDDEN = ['src/', 'test/', 'scripts/', 'node_modules/', '.build/', '.git/', '.github/'] as const

interface PackedFile {
  path: string
  size: number
}

interface PackReport {
  filename: string
  files: PackedFile[]
  size: number
  unpackedSize: number
}

/** Run `npm pack --json` and return its single package report. */
function pack(): PackReport {
  mkdirSync(OUT_DIR, { recursive: true })
  const cli = resolveNpmCli()
  const result = spawnSync(
    cli === undefined ? NPM : process.execPath,
    [...(cli === undefined ? [] : [cli]), 'pack', '--ignore-scripts', '--pack-destination', OUT_DIR, '--json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      // No npm CLI script found: fall back to the platform shim via a shell.
      shell: cli === undefined && process.platform === 'win32',
    },
  )
  if (result.error !== undefined) {
    console.error(`[pack] could not run npm: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[pack] npm pack failed (exit ${String(result.status)}):\n${result.stderr}`)
    process.exit(1)
  }
  const reports = JSON.parse(result.stdout) as PackReport[]
  const report = reports[0]
  if (report === undefined) {
    console.error('[pack] npm pack returned no package report')
    process.exit(1)
  }
  return report
}

const report = pack()
const shipped = new Set(report.files.map((file) => file.path))
const missing = REQUIRED.filter((path) => !shipped.has(path))
const leaked = [...shipped].filter((path) => FORBIDDEN.some((prefix) => path.startsWith(prefix)))
const problems = [
  ...missing.map((path) => `missing runtime file: ${path}`),
  ...leaked.map((path) => `development file leaked into the package: ${path}`),
]
if (problems.length > 0) {
  console.error(`[pack] tarball contract failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

const tarball = join(OUT_DIR, report.filename)
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`
console.log(
  `[pack] ${String(report.files.length)} files · ${kb(report.size)} packed · ${kb(report.unpackedSize)} unpacked`,
)
console.log(`[pack] contract ok: ${String(REQUIRED.length)} required files, no development trees`)
console.log(`TARBALL=${relative(ROOT, tarball).split(sep).join('/')}`)
