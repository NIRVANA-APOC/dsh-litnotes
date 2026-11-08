/**
 * Configuration, credentials and preference persistence for dsh-litnotes.
 *
 * Raw row config (docs/ARCH.md §8) is validated and normalized here; no
 * Schemastery schema is exported because the bundle patch carries an untyped
 * `config:` mapping. Preferences are client-owned JSON persisted host-side so
 * they survive page reloads.
 *
 * The MinerU API token lives in the Host credential store under
 * `dsh-litnotes/mineru-token`; when the credentials service is unavailable the
 * plugin keeps a process-lifetime in-memory token instead and reports that the
 * token is not persistent.
 *
 * Only the 1.0.0 data format is read or written: there is no migration of
 * pre-1.0 directories or credential keys.
 *
 * @module host/config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOKEN_KEY } from '../shared/constants.ts'
import type { Preferences } from '../shared/model.ts'
import { normalizePreferences } from '../shared/preferences.ts'
import type { AiConfig, LocalConfig, ResolvedConfig, StoreApi } from './contracts.ts'
import { WireError } from './wire.ts'

/** Credential record key for the MinerU token (namespaced by this plugin). */
export { TOKEN_KEY }

/** Default local parsing engine limits (see the Host local engine). */
const DEFAULT_LOCAL_CONFIG: Readonly<LocalConfig> = Object.freeze({
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
/** Reasoning-effort ids accepted by the DeepSeek-family adapters. */
const REASONING_EFFORTS: ReadonlySet<string> = new Set(['off', 'low', 'high', 'max'])

/**
 * Structural view of the Host credentials service.
 *
 * `describeRecord` is optional: the installed credentials service exposes it
 * on some profiles only, and it is used solely to report whether the token
 * would persist across restarts.
 */
export interface CredentialsLike {
  readRecord?: (key: string) => Promise<unknown>
  modifyRecord?: (
    key: string,
    mutate: (current: unknown) => Promise<unknown> | unknown,
  ) => Promise<unknown>
  deleteRecord?: (key: string) => Promise<void>
  describeRecord?: (key: string) => Promise<unknown>
}

/** Resolve a token value held by an `ApiKeyRecord`. */
function tokenOfRecord(record: unknown): string | undefined {
  if (record === null || typeof record !== 'object') return undefined
  const candidate = record as { kind?: unknown; key?: unknown }
  if (candidate.kind !== 'api-key') return undefined
  if (typeof candidate.key !== 'string') return undefined
  const value = candidate.key.trim()
  return value === '' ? undefined : value
}

/** Fallback token used only while the credentials service is unavailable. */
let memoryToken: string | undefined

/**
 * The plugin package version (used for status/version reporting).
 *
 * The bundler substitutes `__LITNOTES_VERSION__`; when the module runs
 * unbundled (vitest), the package manifest next to the checkout is read
 * instead.
 */
export const PACKAGE_VERSION: string = readPackageVersion()

/** Read the package version from the build substitution or the manifest. */
function readPackageVersion(): string {
  try {
    if (typeof __LITNOTES_VERSION__ === 'string' && __LITNOTES_VERSION__ !== '') {
      return __LITNOTES_VERSION__
    }
  } catch {
    /* unbundled: fall through to the manifest */
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDir, '..', 'package.json'),
    join(moduleDir, 'package.json'),
    join(process.cwd(), 'package.json'),
  ]
  for (const packagePath of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        const version = (parsed as { version?: unknown }).version
        if (typeof version === 'string' && version !== '') return version
      }
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0'
}

/** Expand a leading `~` or `$DSH_HOME` / `${DSH_HOME}` reference. */
function expandPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  const dshHome = process.env.DSH_HOME?.trim()
  const base = dshHome === undefined || dshHome === '' ? join(homedir(), '.dsh') : dshHome
  if (text === '$DSH_HOME' || text === '${DSH_HOME}') return base
  if (text.startsWith('$DSH_HOME/') || text.startsWith('${DSH_HOME}/')) {
    return join(base, text.replace(/^\$?\{?DSH_HOME\}?\//, ''))
  }
  if (text.startsWith('$DSH_HOME\\') || text.startsWith('${DSH_HOME}\\')) {
    return join(base, text.replace(/^\$?\{?DSH_HOME\}?\\/, ''))
  }
  return isAbsolute(text) ? text : resolve(text)
}

/**
 * Clamp an integer option into range, falling back on invalid input.
 *
 * @param value - raw config value (number or numeric string).
 * @param fallback - default used for missing or non-numeric values.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the floored, clamped integer.
 */
function integerOption(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * Validate the `ai:` config block (docs/AI-SPEC.md §9).
 *
 * @param raw - raw `ai` mapping from the row config.
 * @returns the resolved AI limits.
 */
function resolveAiConfig(raw: unknown): AiConfig {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const reasoningEffort = typeof source.reasoningEffort === 'string' ? source.reasoningEffort : 'low'
  return {
    provider: typeof source.provider === 'string' ? source.provider.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    maxContextChars: integerOption(source.maxContextChars, 9000, 1000, 32000),
    historyTurns: integerOption(source.historyTurns, 6, 0, 20),
    answerMaxTokens: integerOption(source.answerMaxTokens, 4096, 256, 16384),
    graphMaxTokens: integerOption(source.graphMaxTokens, 4096, 256, 16384),
    graphSummaryChars: integerOption(source.graphSummaryChars, 4000, 500, 20000),
    maxAnnotationsPerAnswer: integerOption(source.maxAnnotationsPerAnswer, 5, 1, 20),
    reasoningEffort: REASONING_EFFORTS.has(reasoningEffort) ? reasoningEffort : 'low',
    maxGraphChunks: integerOption(source.maxGraphChunks, 12, 1, 40),
    maxGraphSourceChars: integerOption(source.maxGraphSourceChars, 160000, 10000, 1000000),
    // Second, model-based citation verification pass (docs/AI-SPEC.md §5).
    // Default on: quote containment proves provenance, not entailment.
    entailmentCheck: source.entailmentCheck !== false,
    entailmentMaxTokens: integerOption(source.entailmentMaxTokens, 600, 64, 4096),
    // AI 精读 (deep read): whole-paper close reading, report + annotations.
    // Defaults are one full read of a typical 15-25 page paper.
    deepReadMaxChunks: integerOption(source.deepReadMaxChunks, 24, 4, 60),
    deepReadMaxSourceChars: integerOption(source.deepReadMaxSourceChars, 240000, 20000, 1000000),
    deepReadMaxAnnotations: integerOption(source.deepReadMaxAnnotations, 24, 8, 60),
    deepReadMaxTokens: integerOption(source.deepReadMaxTokens, 2400, 512, 8192),
    deepReadSynthesisChars: integerOption(source.deepReadSynthesisChars, 14000, 4000, 40000),
    deepReadCoveragePass: source.deepReadCoveragePass !== false,
    deepReadJudge: source.deepReadJudge !== false,
  }
}

/**
 * Validate and normalize the optional `local:` config block.
 *
 * The block is untyped in the Cordis row (like the rest of this plugin's
 * config), so every field is validated by hand and clamped.
 *
 * @param raw - raw `local` mapping from the row config.
 * @returns the resolved local engine config.
 */
function resolveLocalConfig(raw: unknown): LocalConfig {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_LOCAL_CONFIG.enabled,
    maxPages: integerOption(source.maxPages, DEFAULT_LOCAL_CONFIG.maxPages, 1, 5000),
    maxPdfBytes: integerOption(
      source.maxPdfBytes,
      DEFAULT_LOCAL_CONFIG.maxPdfBytes,
      64 * 1024,
      2 * 1024 * 1024 * 1024,
    ),
    maxTextBytes: integerOption(
      source.maxTextBytes,
      DEFAULT_LOCAL_CONFIG.maxTextBytes,
      64 * 1024,
      256 * 1024 * 1024,
    ),
    minCharsPerPage: integerOption(source.minCharsPerPage, DEFAULT_LOCAL_CONFIG.minCharsPerPage, 0, 10000),
    maxParagraphChars: integerOption(source.maxParagraphChars, DEFAULT_LOCAL_CONFIG.maxParagraphChars, 500, 8000),
    keepContentList:
      typeof source.keepContentList === 'boolean'
        ? source.keepContentList
        : DEFAULT_LOCAL_CONFIG.keepContentList,
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
 * Validate and normalize the raw row config.
 *
 * @param rawConfig - loader-supplied config mapping.
 * @returns resolved config (absolute `dataDir`, canonical `apiBase` without a
 *   trailing slash, clamped limits, resolved `ai`/`local` blocks).
 */
export function resolveConfig(rawConfig?: Record<string, unknown>): ResolvedConfig {
  const raw: Record<string, unknown> =
    rawConfig !== undefined && rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const dshHome = process.env.DSH_HOME?.trim()
  const defaultDataDir =
    dshHome === undefined || dshHome === ''
      ? join(homedir(), '.dsh', 'litnotes')
      : join(dshHome, 'litnotes')
  const dataDir = expandPath(raw.dataDir) ?? defaultDataDir

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
    maxUploadBytes: integerOption(
      raw.maxUploadBytes,
      DEFAULT_MAX_UPLOAD_BYTES,
      64 * 1024,
      2 * 1024 * 1024 * 1024,
    ),
    maxConcurrentParses: integerOption(raw.maxConcurrentParses, 2, 1, 8),
    pollIntervalMs: integerOption(raw.pollIntervalMs, 3000, 10, 10 * 60 * 1000),
    parseTimeoutMs: integerOption(raw.parseTimeoutMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    toolMaxChars: integerOption(raw.toolMaxChars, 40000, 1000, 400000),
    ai: resolveAiConfig(raw.ai),
    local: resolveLocalConfig(raw.local),
    hostVersion: PACKAGE_VERSION,
  }
}

/**
 * Read the stored MinerU API token.
 *
 * Reads through the credentials service on every call so a token set in
 * another session is picked up without a restart. Falls back to the module's
 * in-memory token when the credentials service is missing or unreadable.
 *
 * @param credentials - `ctx.get('credentials')`, if mounted.
 * @returns the token, or undefined when unconfigured.
 */
export async function getToken(credentials?: CredentialsLike): Promise<string | undefined> {
  if (credentials !== undefined && typeof credentials.readRecord === 'function') {
    try {
      const token = tokenOfRecord(await credentials.readRecord(TOKEN_KEY))
      if (token !== undefined) return token
    } catch {
      /* fall back to the session token */
    }
  }
  return memoryToken
}

/**
 * Validate a token string before it is stored.
 *
 * @param token - candidate token.
 * @returns the normalized (trimmed) token.
 * @throws {WireError} `bad-request` for blank, over-long, or whitespace tokens.
 */
export function normalizeToken(token: unknown): string {
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
 * @param credentials - credentials service, if any.
 * @param token - raw token.
 * @returns whether the token was durably persisted.
 */
export async function setToken(credentials: CredentialsLike | undefined, token: string): Promise<boolean> {
  const value = normalizeToken(token)
  memoryToken = value
  if (credentials !== undefined && typeof credentials.modifyRecord === 'function') {
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
 * @param credentials - credentials service, if any.
 * @returns whether a durable record was removed.
 */
export async function clearToken(credentials?: CredentialsLike): Promise<boolean> {
  memoryToken = undefined
  if (credentials !== undefined && typeof credentials.deleteRecord === 'function') {
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
 * @param credentials - credentials service, if mounted.
 * @returns true when a write would persist across restarts.
 */
export async function isTokenPersistent(credentials?: CredentialsLike): Promise<boolean> {
  if (credentials === undefined || typeof credentials.modifyRecord !== 'function') return false
  if (typeof credentials.describeRecord === 'function') {
    try {
      const info = await credentials.describeRecord(TOKEN_KEY)
      if (info !== null && typeof info === 'object') {
        const writable = (info as { writable?: unknown }).writable
        if (typeof writable === 'boolean') return writable
      }
    } catch {
      return true
    }
  }
  return true
}

/**
 * Read the library preferences through the store (defaults merged over the
 * persisted values).
 *
 * @param store - the library store.
 * @returns complete, normalized preferences.
 */
export async function loadPreferences(store: StoreApi): Promise<Preferences> {
  return store.readPreferences()
}

/**
 * Validate, merge over the stored values, and persist preferences.
 *
 * @param store - the library store.
 * @param preferences - partial preference object from the client.
 * @returns the full merged preference object.
 * @throws {WireError} `bad-request` when the payload is not an object.
 */
export async function savePreferences(store: StoreApi, preferences: unknown): Promise<Preferences> {
  if (preferences !== undefined && preferences !== null && (typeof preferences !== 'object' || Array.isArray(preferences))) {
    throw new WireError('bad-request', 'preferences 必须是对象（preferences must be an object）')
  }
  const current = await loadPreferences(store)
  const patch: Record<string, unknown> =
    preferences !== null && typeof preferences === 'object' ? (preferences as Record<string, unknown>) : {}
  const merged = normalizePreferences({ ...current, ...patch })
  await store.writePreferences(merged)
  return merged
}
