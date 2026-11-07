/**
 * Configuration, credentials and preference persistence for dsh-litnotes.
 *
 * Raw row config (docs/ARCH.md §8) is validated and normalized here; no
 * Schemastery schema is exported because the bundle patch carries an untyped
 * `config:` mapping. Preferences are client-owned JSON persisted host-side so
 * they survive page reloads.
 *
 * The MinerU API token lives in the Host credential store under
 * `dsh-litnotes/api-token`; when the credentials service is unavailable the
 * plugin keeps a process-lifetime in-memory token instead and reports that the
 * token is not persistent.
 *
 * @module lib/config
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WireError } from './wire.js'

/** Credential record key: both segments are lowercase hyphenated identifiers. */
export const TOKEN_KEY = 'dsh-litnotes/mineru-token'
/** Pre-rename credential keys, migrated on the next token read. */
export const LEGACY_TOKEN_KEYS = ['dsh-scholar/mineru-token', 'dsh-mineru/api-token']

/** Preference defaults; every field is client-owned and validated on write. */
export const DEFAULT_PREFERENCES = Object.freeze({
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
  // When no MinerU token is configured and the local engine cannot handle the
  // file, `auto` falls back to the token-free cloud agent API (which uploads
  // the source file). Privacy-sensitive users can switch this off.
  autoAllowAgentFallback: true,
})

/** Default local parsing engine limits (see lib/local-engine.js). */
const DEFAULT_LOCAL_CONFIG = Object.freeze({
  enabled: true,
  maxPages: 500,
  maxPdfBytes: 200 * 1024 * 1024,
  maxTextBytes: 32 * 1024 * 1024,
  minCharsPerPage: 30,
  maxParagraphChars: 4000,
  keepContentList: true,
  timeoutMs: 120000,
  maxOfficePdfBytes: 100 * 1024 * 1024,
})

/** Default MinerU API base. */
const DEFAULT_API_BASE = 'https://mineru.net'
/** Default upload cap: 200 MiB (matches the MinerU standard limit). */
const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024
/** Accepted engines for the preference / parse options. */
const ENGINES = new Set(['auto', 'standard', 'agent', 'local'])
/** Accepted MinerU model versions. */
const MODEL_VERSIONS = new Set(['pipeline', 'vlm'])
/**
 * Accepted reading modes. The client UI uses original/bilingual/translated;
 * the compare/translation spellings are kept for forward/backward tolerance.
 */
export const READING_MODES = new Set(['original', 'bilingual', 'translated', 'compare', 'translation'])
/** Accepted highlight colors (client-owned annotation ink). */
export const HIGHLIGHT_COLORS = new Set(['yellow', 'sage', 'sky', 'rose'])

/** Large language tags MinerU understands; other values pass through if sane. */
const LANGUAGE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/i

/** Resolve a token value held by an ApiKeyRecord. */
function tokenOfRecord(record) {
  if (record === undefined || record === null || typeof record !== 'object') return undefined
  if (record.kind !== 'api-key') return undefined
  if (typeof record.key !== 'string') return undefined
  const value = record.key.trim()
  return value === '' ? undefined : value
}

/** Fallback token used only while the credentials service is unavailable. */
let memoryToken

/** Plugin package version, or `0.0.0` when package.json cannot be read. */
function readPackageVersion() {
  try {
    const packagePath = join(import.meta.dirname, '..', 'package.json')
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8'))
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The plugin package version (used for status/version reporting). */
export const PACKAGE_VERSION = readPackageVersion()

/** Expand a leading `~` or `$DSH_HOME` / `${DSH_HOME}` reference. */
function expandPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let text = value.trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  const dshHome = process.env.DSH_HOME?.trim()
  if (text === '$DSH_HOME' || text === '${DSH_HOME}') return dshHome || join(homedir(), '.dsh')
  if (text.startsWith('$DSH_HOME/') || text.startsWith('${DSH_HOME}/')) {
    const rest = text.replace(/^\$?\{?DSH_HOME\}?\//, '')
    return join(dshHome || join(homedir(), '.dsh'), rest)
  }
  if (text.startsWith('$DSH_HOME\\') || text.startsWith('${DSH_HOME}\\')) {
    const rest = text.replace(/^\$?\{?DSH_HOME\}?\\/, '')
    return join(dshHome || join(homedir(), '.dsh'), rest)
  }
  return isAbsolute(text) ? text : resolve(text)
}

/** Clamp an integer option into range, falling back on invalid input. */
function integerOption(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * One-time migration of the pre-rename data directory (`~/.dsh/mineru`) to the
 * current one (`~/.dsh/litnotes`). Runs only when the new directory does not
 * exist yet and never overwrites user data; failures fall back to a copy.
 * @param {string} target - resolved new data directory.
 */
function migrateLegacyDataDir(target) {
  try {
    if (existsSync(target)) return
    const base = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    for (const legacyName of ['scholar', 'mineru']) {
      const legacy = join(base, legacyName)
      if (legacy === target || !existsSync(legacy)) continue
      try {
        renameSync(legacy, target)
      } catch {
        cpSync(legacy, target, { recursive: true, force: false })
        rmSync(legacy, { recursive: true, force: true })
      }
      return
    }
  } catch {
    /* migration is best-effort; the new empty data directory is created later */
  }
}

/**
 * Validate and normalize the raw row config.
 *
 * @param {Record<string, unknown> | undefined} rawConfig - loader-supplied config mapping.
 * @returns {{
 *   dataDir: string, apiBase: string, maxUploadBytes: number,
 *   maxConcurrentParses: number, pollIntervalMs: number,
 *   parseTimeoutMs: number, toolMaxChars: number, hostVersion: string,
 * }} resolved config (absolute dataDir, canonical apiBase without trailing slash).
 */
export function resolveConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const defaultDataDir = process.env.DSH_HOME?.trim()
    ? join(process.env.DSH_HOME.trim(), 'litnotes')
    : join(homedir(), '.dsh', 'litnotes')
  const configured = expandPath(raw.dataDir)
  if (configured === undefined) migrateLegacyDataDir(defaultDataDir)
  const dataDir = configured ?? defaultDataDir

  let apiBase = DEFAULT_API_BASE
  if (typeof raw.apiBase === 'string' && raw.apiBase.trim() !== '') {
    const candidate = raw.apiBase.trim().replace(/\/+$/, '')
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') apiBase = candidate
    } catch {
      /* keep the default base on invalid configuration */
    }
  }

  return {
    dataDir,
    apiBase,
    maxUploadBytes: integerOption(raw.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES, 64 * 1024, 2 * 1024 * 1024 * 1024),
    maxConcurrentParses: integerOption(raw.maxConcurrentParses, 2, 1, 8),
    pollIntervalMs: integerOption(raw.pollIntervalMs, 3000, 10, 10 * 60 * 1000),
    parseTimeoutMs: integerOption(raw.parseTimeoutMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    toolMaxChars: integerOption(raw.toolMaxChars, 40000, 1000, 400000),
    ai: resolveAiConfig(raw.ai),
    local: resolveLocalConfig(raw.local),
    hostVersion: PACKAGE_VERSION,
  }
}

/** Reasoning-effort ids accepted by the DeepSeek-family adapters. */
const REASONING_EFFORTS = new Set(['off', 'low', 'high', 'max'])

/**
 * Validate the `ai:` config block (docs/AI-SPEC.md §9).
 * @param {unknown} raw - raw `ai` mapping.
 * @returns {{ provider: string, model: string, maxContextChars: number,
 *   historyTurns: number, answerMaxTokens: number, graphMaxTokens: number,
 *   graphSummaryChars: number, maxAnnotationsPerAnswer: number,
 *   reasoningEffort: string, maxGraphChunks: number, maxGraphSourceChars: number,
 *   entailmentCheck: boolean, entailmentMaxTokens: number }}
 */
function resolveAiConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    provider: typeof source.provider === 'string' ? source.provider.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    maxContextChars: integerOption(source.maxContextChars, 9000, 1000, 32000),
    historyTurns: integerOption(source.historyTurns, 6, 0, 20),
    answerMaxTokens: integerOption(source.answerMaxTokens, 4096, 256, 16384),
    graphMaxTokens: integerOption(source.graphMaxTokens, 4096, 256, 16384),
    graphSummaryChars: integerOption(source.graphSummaryChars, 4000, 500, 20000),
    maxAnnotationsPerAnswer: integerOption(source.maxAnnotationsPerAnswer, 5, 1, 20),
    reasoningEffort: REASONING_EFFORTS.has(source.reasoningEffort) ? source.reasoningEffort : 'low',
    maxGraphChunks: integerOption(source.maxGraphChunks, 12, 1, 40),
    maxGraphSourceChars: integerOption(source.maxGraphSourceChars, 160000, 10000, 1000000),
    // Second, model-based citation verification pass (docs/AI-SPEC.md §5).
    // Default on: quote containment proves provenance, not entailment.
    entailmentCheck: source.entailmentCheck !== false,
    entailmentMaxTokens: integerOption(source.entailmentMaxTokens, 600, 64, 4096),
  }
}

/**
 * Validate and normalize the optional `local:` config block.
 *
 * The block is untyped in the Cordis row (like the rest of this plugin's
 * config), so every field is validated by hand and clamped.
 *
 * @param {unknown} raw - raw `local` mapping from the row config.
 * @returns {typeof DEFAULT_LOCAL_CONFIG} resolved local engine config.
 */
function resolveLocalConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_LOCAL_CONFIG.enabled,
    maxPages: integerOption(source.maxPages, DEFAULT_LOCAL_CONFIG.maxPages, 1, 5000),
    maxPdfBytes: integerOption(source.maxPdfBytes, DEFAULT_LOCAL_CONFIG.maxPdfBytes, 64 * 1024, 2 * 1024 * 1024 * 1024),
    maxTextBytes: integerOption(source.maxTextBytes, DEFAULT_LOCAL_CONFIG.maxTextBytes, 64 * 1024, 256 * 1024 * 1024),
    minCharsPerPage: integerOption(source.minCharsPerPage, DEFAULT_LOCAL_CONFIG.minCharsPerPage, 0, 10000),
    maxParagraphChars: integerOption(
      source.maxParagraphChars,
      DEFAULT_LOCAL_CONFIG.maxParagraphChars,
      500,
      8000,
    ),
    keepContentList:
      typeof source.keepContentList === 'boolean' ? source.keepContentList : DEFAULT_LOCAL_CONFIG.keepContentList,
    timeoutMs: integerOption(source.timeoutMs, DEFAULT_LOCAL_CONFIG.timeoutMs, 1000, 60 * 60 * 1000),
    maxOfficePdfBytes: integerOption(
      source.maxOfficePdfBytes,
      DEFAULT_LOCAL_CONFIG.maxOfficePdfBytes,
      64 * 1024,
      1024 * 1024 * 1024,
    ),
  }
}

/**
 * Read the stored MinerU API token.
 *
 * Reads through the credentials service on every call so a token set in
 * another session is picked up without a restart. Falls back to the module's
 * in-memory token when the credentials service is missing or unreadable.
 *
 * @param {{ readRecord?: Function } | undefined} credentials - `ctx.get('credentials')`.
 * @returns {Promise<string | undefined>} the token, or undefined when unconfigured.
 */
export async function getToken(credentials) {
  if (credentials && typeof credentials.readRecord === 'function') {
    try {
      const token = tokenOfRecord(await credentials.readRecord(TOKEN_KEY))
      if (token !== undefined) return token
    } catch {
      /* fall back to the session token */
    }
    // One-time migration from the pre-rename credential keys.
    for (const legacyKey of LEGACY_TOKEN_KEYS) {
      try {
        const legacy = tokenOfRecord(await credentials.readRecord(legacyKey))
        if (legacy === undefined) continue
        if (typeof credentials.modifyRecord === 'function') {
          await credentials.modifyRecord(TOKEN_KEY, async () => ({ kind: 'api-key', key: legacy }))
        }
        if (typeof credentials.deleteRecord === 'function') await credentials.deleteRecord(legacyKey)
        return legacy
      } catch {
        /* legacy read is best-effort */
      }
    }
  }
  return memoryToken
}

/**
 * Validate a token string before it is stored.
 *
 * @param {unknown} token - candidate token.
 * @returns {string} normalized (trimmed) token.
 * @throws {WireError} `bad-request` for blank, over-long, or whitespace tokens.
 */
export function normalizeToken(token) {
  const value = typeof token === 'string' ? token.trim() : ''
  if (value === '') {
    throw new WireError('bad-request', 'Token 不能为空（Token must not be empty）')
  }
  if (value.length < 8 || value.length > 4096 || /\s/.test(value)) {
    throw new WireError('bad-request', 'Token 格式无效（Invalid token format）')
  }
  return value
}

/**
 * Store the MinerU API token as an `ApiKeyRecord`.
 *
 * @param {{ modifyRecord?: Function } | undefined} credentials - credentials service, if any.
 * @param {string} token - raw token.
 * @returns {Promise<boolean>} whether the token was durably persisted.
 */
export async function setToken(credentials, token) {
  const value = normalizeToken(token)
  memoryToken = value
  if (credentials && typeof credentials.modifyRecord === 'function') {
    try {
      await credentials.modifyRecord(TOKEN_KEY, async () => ({ kind: 'api-key', key: value }))
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Remove the stored token (durable store and in-memory fallback).
 *
 * @param {{ deleteRecord?: Function } | undefined} credentials - credentials service, if any.
 * @returns {Promise<boolean>} whether a durable record was removed.
 */
export async function clearToken(credentials) {
  memoryToken = undefined
  if (credentials && typeof credentials.deleteRecord === 'function') {
    try {
      await credentials.deleteRecord(TOKEN_KEY)
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Whether the credentials service can durably store the token.
 *
 * @param {{ describeRecord?: Function, modifyRecord?: Function } | undefined} credentials - credentials service.
 * @returns {Promise<boolean>} true when a write would persist across restarts.
 */
export async function isTokenPersistent(credentials) {
  if (!credentials || typeof credentials.modifyRecord !== 'function') return false
  if (typeof credentials.describeRecord === 'function') {
    try {
      const info = await credentials.describeRecord(TOKEN_KEY)
      if (info && typeof info.writable === 'boolean') return info.writable
    } catch {
      return true
    }
  }
  return true
}

/** Clamp a number into a closed interval. */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Validate one preference field, keeping the default on invalid input.
 * @param {string} key - preference key.
 * @param {unknown} value - candidate value.
 * @returns {unknown} accepted value or the default.
 */
function validatePreference(key, value) {
  const fallback = DEFAULT_PREFERENCES[key]
  switch (key) {
    case 'targetLanguage':
      return typeof value === 'string' && LANGUAGE_PATTERN.test(value.trim()) ? value.trim() : fallback
    case 'translationProvider':
      return ['auto', 'google', 'bing', 'deepseek-account', 'deepseek-official'].includes(value) ? value : fallback
    case 'readingMode':
      return READING_MODES.has(value) ? value : fallback
    case 'readingScale': {
      const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      return Number.isFinite(number) && number >= 0.8 && number <= 2 ? number : fallback
    }
    case 'defaultEngine':
      return ENGINES.has(value) ? value : fallback
    case 'defaultModelVersion':
      return MODEL_VERSIONS.has(value) ? value : fallback
    case 'defaultLanguage':
      return typeof value === 'string' && LANGUAGE_PATTERN.test(value.trim()) ? value.trim() : fallback
    case 'defaultIsOcr':
    case 'defaultEnableFormula':
    case 'defaultEnableTable':
    case 'showPageMarks':
    case 'aiPanelOpen':
    case 'graphAutoBuild':
    case 'autoAllowAgentFallback':
      return typeof value === 'boolean' ? value : fallback
    case 'marginTab':
      return value === 'outline' || value === 'notes' || value === 'ai' ? value : fallback
    case 'notesFilter':
      return value === 'all' || value === 'ai' || value === 'user' ? value : fallback
    case 'libraryView':
      return value === 'library' || value === 'graph' ? value : fallback
    case 'docView':
      return value === 'read' || value === 'graph' ? value : fallback
    default:
      return fallback
  }
}

/**
 * Merge an arbitrary preference object over the defaults, keeping only known
 * keys with valid values.
 *
 * @param {unknown} prefs - candidate preferences.
 * @returns {typeof DEFAULT_PREFERENCES} complete preference object.
 */
export function normalizePreferences(prefs) {
  const source = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {}
  const out = {}
  for (const key of Object.keys(DEFAULT_PREFERENCES)) out[key] = validatePreference(key, source[key])
  return out
}

/** Atomic text write (tmp file in the destination directory, then rename). */
async function writeFileAtomic(filePath, text) {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, filePath)
  } catch (error) {
    await rmQuiet(temp)
    throw error
  }
}

/** Remove a file without surfacing errors. */
async function rmQuiet(filePath) {
  try {
    await rm(filePath, { force: true })
  } catch {
    /* ignore */
  }
}

/**
 * Read `<dataDir>/preferences.json`, merged over {@link DEFAULT_PREFERENCES}.
 * A missing or corrupt file yields the defaults rather than an error.
 *
 * @param {string} dataDir - resolved data directory.
 * @returns {Promise<typeof DEFAULT_PREFERENCES>} complete preferences.
 */
export async function loadPreferences(dataDir) {
  const filePath = join(dataDir, 'preferences.json')
  let stored = {}
  try {
    const info = await stat(filePath)
    if (info.size <= 1024 * 1024) stored = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    stored = {}
  }
  return normalizePreferences(stored)
}

/**
 * Validate, merge over the stored values, and persist preferences.
 *
 * @param {string} dataDir - resolved data directory.
 * @param {Record<string, unknown>} prefs - partial preferences from the client.
 * @returns {Promise<typeof DEFAULT_PREFERENCES>} the full merged preference object.
 */
export async function savePreferences(dataDir, prefs) {
  if (prefs !== undefined && prefs !== null && (typeof prefs !== 'object' || Array.isArray(prefs))) {
    throw new WireError('bad-request', 'preferences 必须是对象（preferences must be an object）')
  }
  const current = await loadPreferences(dataDir)
  const merged = normalizePreferences({ ...current, ...(prefs ?? {}) })
  await writeFileAtomic(join(dataDir, 'preferences.json'), `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}
