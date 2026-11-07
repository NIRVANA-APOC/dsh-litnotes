/**
 * Option lists and capability checks shared by the import, reparse and
 * settings dialogs.
 *
 * The Host is the authority on parse options (it re-validates everything and
 * owns the `auto` engine policy); these helpers only pre-select sensible
 * values and explain what will happen, so the UI never offers a dead end.
 */

import {
  LANGUAGE_OPTIONS,
  MODEL_VERSIONS,
  PARSE_ENGINES,
  TARGET_LANGUAGE_OPTIONS,
  type LocalProvider,
  type ModelVersion,
  type ParseEngine,
} from '../../../shared/constants.ts'
import type { DocumentSummary, LocalCapabilities, ParseOptions, Preferences } from '../../../shared/model.ts'
import type { LitnotesTranslate } from '../locale-context.ts'
import type { SegmentOption } from '../../design/primitives.tsx'
import { extensionLabel, extensionOf } from './format.ts'

/** Client-side approximation of "can the local engine parse this file". */
export interface LocalSupport {
  supported: boolean
  /** Human reason when `supported` is false. */
  reason: string | null
}

/** Office extensions understood by the local T0.5 conversion path. */
const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'])
/** Image extensions understood by the local OCR-less text path. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp'])

/**
 * Whether the local engine can plausibly handle one file.
 *
 * @param local - capabilities reported by the Host (`settings.get`/`status`).
 * @param ext - lowercase extension with the dot ('' when unknown).
 * @param t - translate function for the reason copy.
 * @returns support flag plus a reason when unsupported.
 */
export function localSupportFor(
  local: LocalCapabilities | null,
  ext: string,
  t: LitnotesTranslate,
): LocalSupport {
  if (local === null || !local.enabled) return { supported: false, reason: t('parse.engine.localMissing') }
  if (!local.available) return { supported: false, reason: t('parse.engine.localMissing') }
  const capabilities = local.capabilities
  if (ext === '.pdf') {
    return capabilities.textLayerPdf
      ? { supported: true, reason: null }
      : { supported: false, reason: t('parse.engine.localUnsupported') }
  }
  if (OFFICE_EXTENSIONS.has(ext)) {
    return capabilities.office
      ? { supported: true, reason: null }
      : { supported: false, reason: t('parse.engine.localUnsupported') }
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return capabilities.images
      ? { supported: true, reason: null }
      : { supported: false, reason: t('parse.engine.localUnsupported') }
  }
  if (ext === '.html' || ext === '.htm') {
    return capabilities.html
      ? { supported: true, reason: null }
      : { supported: false, reason: t('parse.engine.localUnsupported') }
  }
  return { supported: false, reason: t('parse.engine.localUnsupported') }
}

/** Local support for a library document. */
export function localSupportForDocument(
  local: LocalCapabilities | null,
  document: DocumentSummary,
  t: LitnotesTranslate,
): LocalSupport {
  return localSupportFor(local, document.ext.toLowerCase(), t)
}

/** Local support for a file chosen for import. */
export function localSupportForFile(local: LocalCapabilities | null, file: File, t: LitnotesTranslate): LocalSupport {
  return localSupportFor(local, extensionOf(file.name), t)
}

/** Segmented-control options for the parse engine. */
export function engineOptions(t: LitnotesTranslate, local: LocalCapabilities | null, ext: string): Array<SegmentOption<ParseEngine>> {
  const support = localSupportFor(local, ext, t)
  return PARSE_ENGINES.map((value) => ({
    value,
    label:
      value === 'auto'
        ? t('parse.engine.auto')
        : value === 'standard'
          ? t('parse.engine.standard')
          : value === 'agent'
            ? t('parse.engine.agent')
            : t('parse.engine.local'),
    disabled: value === 'local' && !support.supported,
  }))
}

/** Segmented-control options for the MinerU model version. */
export function modelVersionOptions(t: LitnotesTranslate): Array<SegmentOption<ModelVersion>> {
  return MODEL_VERSIONS.map((value) => ({
    value,
    label: value === 'vlm' ? t('parse.model.vlm') : t('parse.model.pipeline'),
  }))
}

/** Select options for the document language. */
export function languageOptions(t: LitnotesTranslate): Array<{ value: string; label: string }> {
  return LANGUAGE_OPTIONS.map(([value, key]) => ({ value, label: t(key) }))
}

/** Select options for the translation target language. */
export function targetLanguageOptions(): Array<{ value: string; label: string }> {
  return TARGET_LANGUAGE_OPTIONS.map(([value, label]) => ({ value, label }))
}

/** Translate-provider options: `auto` first, then the Host-reported services. */
export function providerOptions(
  providers: ReadonlyArray<{ id: string; label: string }>,
  current: string,
  t: LitnotesTranslate,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [{ value: 'auto', label: t('set.providerAuto') }]
  const seen = new Set<string>(['auto'])
  for (const provider of providers) {
    if (provider.id === '' || seen.has(provider.id)) continue
    seen.add(provider.id)
    options.push({ value: provider.id, label: provider.label === '' ? provider.id : provider.label })
  }
  if (current !== '' && !seen.has(current)) options.push({ value: current, label: current })
  return options
}

/** Label of the local provider id shown in the capabilities list. */
export function localProviderLabel(t: LitnotesTranslate, id: string): string {
  if (id === 'builtin') return t('set.localBuiltin')
  if (id === 'system:officeToPdf') return t('set.localOffice')
  if (id.includes('pdftotext')) return t('set.localPdfTool')
  return id
}

/** Parse options seeded from the persisted preferences. */
export function defaultParseOptions(preferences: Preferences): ParseOptions {
  return {
    engine: preferences.defaultEngine,
    modelVersion: preferences.defaultModelVersion,
    language: preferences.defaultLanguage,
    isOcr: preferences.defaultIsOcr,
    enableFormula: preferences.defaultEnableFormula,
    enableTable: preferences.defaultEnableTable,
    pageRanges: '',
  }
}

/** Partial preference patch that remembers the last chosen parse options. */
export function rememberParseOptions(options: ParseOptions | null | undefined): Partial<Preferences> {
  if (options === undefined || options === null) return {}
  const patch: Partial<Preferences> = {}
  if (options.engine !== undefined) patch.defaultEngine = options.engine
  if (options.modelVersion !== undefined) patch.defaultModelVersion = options.modelVersion
  if (options.language !== undefined) patch.defaultLanguage = options.language
  if (typeof options.isOcr === 'boolean') patch.defaultIsOcr = options.isOcr
  if (typeof options.enableFormula === 'boolean') patch.defaultEnableFormula = options.enableFormula
  if (typeof options.enableTable === 'boolean') patch.defaultEnableTable = options.enableTable
  return patch
}

/** One-line explanation of what a parse engine will actually do. */
export function engineHint(
  engine: ParseEngine,
  tokenConfigured: boolean,
  localSupport: LocalSupport,
  t: LitnotesTranslate,
): string {
  if (engine === 'standard') return t('parse.engine.standardHint')
  if (engine === 'agent') return t('parse.engine.agentHint')
  if (engine === 'local') return t('parse.engine.localHint')
  if (!tokenConfigured) return localSupport.supported ? t('parse.engine.autoHint') : t('parse.engine.agentHint')
  return t('parse.engine.autoHint')
}

/** Local provider choices offered when the local engine is chosen. */
export function localProviderOptions(): Array<LocalProvider> {
  return ['auto', 'builtin', 'system:officeToPdf']
}

/** Debug label for a file (kept short in copy). */
export function fileLabel(file: File): string {
  return `${file.name} (${extensionLabel(extensionOf(file.name)) || '?'})`
}
