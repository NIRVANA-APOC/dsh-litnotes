/**
 * Preferences: shared defaults and tolerant normalization.
 *
 * The Host is the persistence owner (`<dataDir>/preferences.json`); the Client
 * writes through `settings.update` and adopts the normalized result. Both
 * halves normalize with the same rules so an old or hand-edited file can never
 * hand the UI an out-of-range value.
 */

import {
  DOC_WIDTHS,
  PARSE_ENGINES,
  READING_MEASURES,
  READING_MODES,
  READING_SCALES,
  TARGET_LANGUAGE_OPTIONS,
} from './constants.ts'
import type { Preferences } from './model.ts'

/** Preference defaults for a fresh installation. */
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  targetLanguage: 'zh',
  translationProvider: 'auto',
  readingMode: 'original',
  readingScale: 1,
  showPageMarks: true,
  defaultEngine: 'auto',
  autoAllowAgentFallback: true,
  defaultModelVersion: 'vlm',
  defaultLanguage: 'ch',
  defaultIsOcr: false,
  defaultEnableFormula: true,
  defaultEnableTable: true,
  aiPanelOpen: false,
  libraryView: 'library',
  docView: 'read',
  graphAutoBuild: false,
  entailmentNotice: true,
  notesFilter: 'all',
  lastDocumentId: null,
  lastBlockKey: null,
  readingMeasure: 560,
  docWidth: 880,
  railWidth: 288,
  marginWidth: 320,
  railOpen: true,
  marginOpen: true,
})

/** Accepted translation providers (values are resolved host-side). */
const TRANSLATION_PROVIDERS = new Set([
  'auto',
  'google',
  'bing',
  'llm',
  'deepl',
  'youdao',
  'baidu',
  'tencent',
  'azure',
])

/** Whether a value is one of the allowed reading modes. */
function isReadingMode(value: unknown): value is Preferences['readingMode'] {
  return typeof value === 'string' && (READING_MODES as readonly string[]).includes(value)
}

/** Coerce a numeric preference into an allowed preset, falling back on the default. */
function presetOf<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return allowed.includes(number as T) ? (number as T) : fallback
}

/** Clamp an integer into a range, falling back on the default. */
function clampedInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Coerce an unknown value to a string with a fallback. */
function text(value: unknown, fallback: string, pattern?: RegExp): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  if (pattern && !pattern.test(trimmed)) return fallback
  return trimmed
}

/**
 * Normalize a (possibly partial, possibly untrusted) preference object.
 *
 * Unknown keys are dropped; every known key is validated and falls back to its
 * default. This is intentionally tolerant: preferences are a cache of user
 * intent, never a security boundary.
 */
export function normalizePreferences(raw: unknown): Preferences {
  const source: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const d = DEFAULT_PREFERENCES
  const targetLanguages = new Set<string>(TARGET_LANGUAGE_OPTIONS.map(([value]) => value))
  const out: Preferences = {
    targetLanguage:
      typeof source.targetLanguage === 'string' && targetLanguages.has(source.targetLanguage)
        ? source.targetLanguage
        : d.targetLanguage,
    translationProvider:
      typeof source.translationProvider === 'string' && TRANSLATION_PROVIDERS.has(source.translationProvider)
        ? source.translationProvider
        : d.translationProvider,
    readingMode: isReadingMode(source.readingMode) ? source.readingMode : d.readingMode,
    readingScale: presetOf(source.readingScale, READING_SCALES, d.readingScale),
    showPageMarks: typeof source.showPageMarks === 'boolean' ? source.showPageMarks : d.showPageMarks,
    defaultEngine:
      typeof source.defaultEngine === 'string' && (PARSE_ENGINES as readonly string[]).includes(source.defaultEngine)
        ? (source.defaultEngine as Preferences['defaultEngine'])
        : d.defaultEngine,
    autoAllowAgentFallback:
      typeof source.autoAllowAgentFallback === 'boolean'
        ? source.autoAllowAgentFallback
        : d.autoAllowAgentFallback,
    defaultModelVersion:
      source.defaultModelVersion === 'pipeline' || source.defaultModelVersion === 'vlm'
        ? source.defaultModelVersion
        : d.defaultModelVersion,
    defaultLanguage: text(source.defaultLanguage, d.defaultLanguage, /^[a-z][a-z0-9_]{1,31}$/i),
    defaultIsOcr: typeof source.defaultIsOcr === 'boolean' ? source.defaultIsOcr : d.defaultIsOcr,
    defaultEnableFormula:
      typeof source.defaultEnableFormula === 'boolean'
        ? source.defaultEnableFormula
        : d.defaultEnableFormula,
    defaultEnableTable:
      typeof source.defaultEnableTable === 'boolean'
        ? source.defaultEnableTable
        : d.defaultEnableTable,
    aiPanelOpen: typeof source.aiPanelOpen === 'boolean' ? source.aiPanelOpen : d.aiPanelOpen,
    libraryView: source.libraryView === 'graph' ? 'graph' : 'library',
    docView: source.docView === 'graph' ? 'graph' : 'read',
    graphAutoBuild:
      typeof source.graphAutoBuild === 'boolean' ? source.graphAutoBuild : d.graphAutoBuild,
    entailmentNotice:
      typeof source.entailmentNotice === 'boolean'
        ? source.entailmentNotice
        : d.entailmentNotice,
    notesFilter:
      source.notesFilter === 'ai' || source.notesFilter === 'user' ? source.notesFilter : 'all',
    lastDocumentId:
      typeof source.lastDocumentId === 'string' && source.lastDocumentId.trim() !== ''
        ? source.lastDocumentId.trim().slice(0, 200)
        : null,
    lastBlockKey:
      typeof source.lastBlockKey === 'string' && source.lastBlockKey.trim() !== ''
        ? source.lastBlockKey.trim().slice(0, 200)
        : null,
    readingMeasure: presetOf(source.readingMeasure, READING_MEASURES, d.readingMeasure),
    docWidth: presetOf(source.docWidth, DOC_WIDTHS, d.docWidth),
    railWidth: clampedInt(source.railWidth, d.railWidth, 200, 400),
    marginWidth: clampedInt(source.marginWidth, d.marginWidth, 240, 560),
    railOpen: typeof source.railOpen === 'boolean' ? source.railOpen : d.railOpen,
    marginOpen: typeof source.marginOpen === 'boolean' ? source.marginOpen : d.marginOpen,
  }
  return out
}

/** Merge a partial patch over current preferences and normalize the result. */
export function mergePreferences(current: Preferences, patch: unknown): Preferences {
  const source: Record<string, unknown> = patch && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {}
  return normalizePreferences({ ...current, ...source })
}
