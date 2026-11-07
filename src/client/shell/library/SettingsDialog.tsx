/**
 * Settings dialog (DESIGN-V2 §8): parse engine + MinerU token + local
 * capabilities, translation, AI features, appearance and about/diagnostics.
 *
 * Two-column label/control rows, no cards. Every write goes through the
 * settings store (optimistic patch reconciled with the Host); nothing here
 * duplicates Host policy.
 */

import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { READING_SCALES } from '../../../shared/constants.ts'
import type { ParseOptions, Preferences } from '../../../shared/model.ts'
import { useLibraryStore } from '../../state/library.ts'
import { useSettingsStore } from '../../state/settings.ts'
import { useUiStore } from '../../state/ui.ts'
import { Button, Dialog, Field, Segmented, Select, Switch, TextInput } from '../../design/primitives.tsx'
import { useT } from '../locale-context.ts'
import { defaultParseOptions, localProviderLabel, providerOptions, targetLanguageOptions } from './options.ts'
import { rememberParseOptions } from './options.ts'
import { ParseOptionsForm } from './ParseOptionsForm.tsx'
import { SHELL_LIBRARY_CSS } from './styles.ts'
import { useInjectedStyle } from '../../design/use-style.ts'

/** Section ids of the settings sheet (also the nav anchors). */
export type SettingsSectionId = 'parse' | 'translate' | 'ai' | 'appearance' | 'about'

/** Stable section order for the nav. */
const SECTIONS: ReadonlyArray<{ id: SettingsSectionId; key: 'set.nav.parse' | 'set.nav.translate' | 'set.nav.ai' | 'set.nav.appearance' | 'set.nav.about' }> = [
  { id: 'parse', key: 'set.nav.parse' },
  { id: 'translate', key: 'set.nav.translate' },
  { id: 'ai', key: 'set.nav.ai' },
  { id: 'appearance', key: 'set.nav.appearance' },
  { id: 'about', key: 'set.nav.about' },
]

/** Render the settings sheet. */
export function SettingsDialog(): ReactElement {
  useInjectedStyle('shell-library', SHELL_LIBRARY_CSS)
  const t = useT()
  const dialog = useUiStore((state) => state.dialog)
  const close = useUiStore((state) => state.closeDialog)
  const toast = useUiStore((state) => state.toast)
  const preferences = useSettingsStore((state) => state.preferences)
  const patch = useSettingsStore((state) => state.patch)
  const setToken = useSettingsStore((state) => state.setToken)
  const clearToken = useSettingsStore((state) => state.clearToken)
  const loadSettings = useSettingsStore((state) => state.load)
  const loadingSettings = useSettingsStore((state) => state.loading)
  const tokenConfigured = useSettingsStore((state) => state.tokenConfigured)
  const tokenPersistent = useSettingsStore((state) => state.tokenPersistent)
  const providers = useSettingsStore((state) => state.providers)
  const local = useSettingsStore((state) => state.local)
  const status = useLibraryStore((state) => state.status)
  const documents = useLibraryStore((state) => state.documents)
  const [token, setTokenDraft] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [redetectBusy, setRedetectBusy] = useState(false)
  const [defaults, setDefaults] = useState<ParseOptions>(() => defaultParseOptions(preferences))
  const sectionRefs = useRef<Partial<Record<SettingsSectionId, HTMLDivElement | null>>>({})
  const open = dialog === 'settings'

  useEffect(() => {
    if (!open) return
    setTokenDraft('')
    setDefaults(defaultParseOptions(useSettingsStore.getState().preferences))
  }, [open])

  /** Persist a preference patch; the store surfaces failures as a toast. */
  const update = (value: Partial<Preferences>): void => {
    void patch(value)
  }

  const ai = status?.ai ?? null
  const route = ai?.route ?? null
  const aiGraphReady = ai !== null && ai.graph
  const localAvailable = local !== null && local.enabled && local.available
  const providerChoices = useMemo(
    () => providerOptions(providers, preferences.translationProvider, t),
    [providers, preferences.translationProvider, t],
  )

  /** Scroll one section into view (nav anchor). */
  const jump = (id: SettingsSectionId): void => {
    const element = sectionRefs.current[id]
    if (element === null || element === undefined) return
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    element.focus()
  }

  /** Save the pasted MinerU token. */
  const saveToken = async (): Promise<void> => {
    const value = token.trim()
    if (value === '' || tokenBusy) return
    setTokenBusy(true)
    try {
      await setToken(value)
      setTokenDraft('')
    } catch {
      // The settings store already surfaced the failure.
    } finally {
      setTokenBusy(false)
    }
  }

  /** Copy a diagnostics block to the clipboard (best effort). */
  const copyDiagnostics = async (): Promise<void> => {
    const text = diagnosticsText
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined) {
      toast(t('err.generic'), 'error')
      return
    }
    try {
      await clipboard.writeText(text)
      toast(t('set.diagnosticsCopied'), 'success')
    } catch {
      toast(t('err.generic'), 'error')
    }
  }

  const diagnosticsText = useMemo(() => {
    const lines: string[] = []
    lines.push(`${t('set.version')}: ${status?.version ?? '2.0.0'}`)
    lines.push(`${t('set.hostVersion')}: ${status?.hostVersion ?? '—'}`)
    lines.push(`${t('set.dataDir')}: ${status?.dataDirDisplay ?? '—'}`)
    lines.push(`${t('set.modelRoute')}: ${route === null ? t('set.modelRouteNone') : `${route.provider} · ${route.model}`}`)
    lines.push(
      t('set.diagnosticsLine', {
        host: status?.hostVersion ?? '—',
        count: documents.length,
        local: localAvailable ? t('set.diagnosticsLocalReady') : t('set.diagnosticsLocalOff'),
      }),
    )
    return lines.join('\n')
  }, [status, route, documents.length, localAvailable, t])

  return (
    <Dialog open={open} onClose={close} title={t('set.title')} width={700}
      footer={
        <Button variant="ghost" onClick={close}>
          {t('set.close')}
        </Button>
      }
    >
      <div className="ln-set">
        <nav className="ln-set__nav" aria-label={t('set.title')}>
          {SECTIONS.map((section) => (
            <button key={section.id} type="button" className="ln-chip" onClick={() => jump(section.id)}>
              {t(section.key)}
            </button>
          ))}
        </nav>

        {/* ---- Parse engine -------------------------------------------- */}
        <section
          className="ln-set__section"
          ref={(node) => {
            sectionRefs.current.parse = node
          }}
          aria-label={t('set.nav.parse')}
        >
          <h3 className="ln-set__sectionTitle">{t('set.nav.parse')}</h3>
          <Field
            label={t('set.token')}
            description={
              tokenConfigured
                ? tokenPersistent
                  ? t('set.tokenSaved')
                  : t('set.tokenMemory')
                : `${t('set.tokenMissing')} · ${t('set.tokenLocalFallback')}`
            }
          >
            <div className="ln-set__inline">
              <TextInput
                type="password"
                value={token}
                placeholder={t('set.tokenPlaceholder')}
                autoComplete="off"
                aria-label={t('set.token')}
                onChange={(event) => setTokenDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveToken()
                }}
              />
              <Button disabled={tokenBusy || token.trim() === ''} onClick={() => void saveToken()}>
                {t('set.tokenSave')}
              </Button>
              {tokenConfigured ? (
                <Button variant="ghost" disabled={tokenBusy} onClick={() => void clearToken()}>
                  {t('set.tokenClear')}
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label={t('set.local')} description={t('set.localHint')}>
            <div className="ln-set__inline">
              <Button
                variant="quiet"
                size="sm"
                disabled={redetectBusy || loadingSettings}
                onClick={() => {
                  setRedetectBusy(true)
                  void loadSettings().finally(() => setRedetectBusy(false))
                }}
              >
                {t('set.localRedetect')}
              </Button>
              {!localAvailable ? <span className="ln-field__hint">{t('set.localEmpty')}</span> : null}
            </div>
            <div className="ln-set__localList">
              {local === null || local.providers.length === 0 ? (
                <span className="ln-field__hint">{t('set.localEmpty')}</span>
              ) : (
                local.providers.map((provider) => (
                  <div key={provider.id} className="ln-set__localRow">
                    <span className="ln-set__localName">{localProviderLabel(t, provider.id)}</span>
                    <span className={`ln-badge ln-badge--${provider.available ? 'success' : 'neutral'}`}>
                      {provider.available ? t('set.localAvailable') : t('set.localUnavailable')}
                    </span>
                    {provider.version === null || provider.version === undefined ? null : (
                      <span className="ln-set__localVersion">{provider.version}</span>
                    )}
                    {provider.available ? null : <span className="ln-set__localReason">{provider.reason ?? ''}</span>}
                  </div>
                ))
              )}
              {local !== null && !local.enabled ? <span className="ln-field__hint">{t('set.localDisabled')}</span> : null}
            </div>
          </Field>
          <Field label={t('set.defaults')} description={t('set.defaultsHint')}>
            <ParseOptionsForm
              value={defaults}
              onChange={(next) => {
                setDefaults(next)
                update(rememberParseOptions(next))
              }}
              tokenConfigured={tokenConfigured}
              local={local}
              ext=".pdf"
            />
          </Field>
        </section>

        {/* ---- Translation --------------------------------------------- */}
        <section
          className="ln-set__section"
          ref={(node) => {
            sectionRefs.current.translate = node
          }}
          aria-label={t('set.nav.translate')}
        >
          <h3 className="ln-set__sectionTitle">{t('set.nav.translate')}</h3>
          <Field label={t('set.targetLang')} description={t('set.targetLangHint')}>
            <Select
              value={preferences.targetLanguage}
              aria-label={t('set.targetLang')}
              onChange={(event) => update({ targetLanguage: event.target.value })}
            >
              {targetLanguageOptions().map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('set.provider')} description={t('set.providerHint')}>
            <Select
              value={preferences.translationProvider}
              aria-label={t('set.provider')}
              onChange={(event) => update({ translationProvider: event.target.value })}
            >
              {providerChoices.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          {status !== null && !status.translatorAvailable ? (
            <div className="ln-callout ln-callout--warn">
              <span className="ln-callout__text">{t('set.providerUnavailable')}</span>
            </div>
          ) : null}
        </section>

        {/* ---- AI features --------------------------------------------- */}
        <section
          className="ln-set__section"
          ref={(node) => {
            sectionRefs.current.ai = node
          }}
          aria-label={t('set.nav.ai')}
        >
          <h3 className="ln-set__sectionTitle">{t('set.nav.ai')}</h3>
          <Field label={t('set.modelRoute')}>
            <span className="ln-set__theme">
              {route === null ? t('set.modelRouteNone') : t('set.modelRouteValue', { provider: route.provider, model: route.model })}
            </span>
          </Field>
          <Field
            label={t('set.graphAutoBuild')}
            description={aiGraphReady ? t('set.graphAutoBuildHint') : t('set.graphAutoBuildUnavailable')}
          >
            <Switch
              checked={preferences.graphAutoBuild}
              onChange={(checked) => {
                if (aiGraphReady) update({ graphAutoBuild: checked })
              }}
              label={t('set.graphAutoBuild')}
              disabled={!aiGraphReady}
            />
          </Field>
          <Field label={t('set.entailmentNotice')} description={t('set.entailmentNoticeHint')}>
            <Switch
              checked={preferences.entailmentNotice}
              onChange={(checked) => update({ entailmentNotice: checked })}
              label={t('set.entailmentNotice')}
            />
          </Field>
          {ai !== null && !ai.available ? (
            <div className="ln-callout ln-callout--warn">
              <span className="ln-callout__text">
                {t('set.aiUnavailable', { reason: ai.reason ?? t('err.generic') })}
              </span>
            </div>
          ) : null}
        </section>

        {/* ---- Appearance ---------------------------------------------- */}
        <section
          className="ln-set__section"
          ref={(node) => {
            sectionRefs.current.appearance = node
          }}
          aria-label={t('set.nav.appearance')}
        >
          <h3 className="ln-set__sectionTitle">{t('set.nav.appearance')}</h3>
          <Field label={t('set.theme')}>
            <span className="ln-set__theme">{t('set.themeFollow')}</span>
          </Field>
          <Field label={t('set.readScale')}>
            <Segmented
              size="sm"
              value={String(preferences.readingScale)}
              options={READING_SCALES.map((scale) => ({
                value: String(scale),
                label:
                  scale === 0.9 ? t('set.readScale.90') : scale === 1.12 ? t('set.readScale.112') : t('set.readScale.100'),
              }))}
              onChange={(value) => update({ readingScale: Number(value) })}
              ariaLabel={t('set.readScale')}
            />
          </Field>
          <Field label={t('set.readPageMarks')} description={t('set.readPageMarksHint')}>
            <Switch
              checked={preferences.showPageMarks}
              onChange={(checked) => update({ showPageMarks: checked })}
              label={t('set.readPageMarks')}
            />
          </Field>
        </section>

        {/* ---- About ---------------------------------------------------- */}
        <section
          className="ln-set__section"
          ref={(node) => {
            sectionRefs.current.about = node
          }}
          aria-label={t('set.nav.about')}
        >
          <h3 className="ln-set__sectionTitle">{t('set.nav.about')}</h3>
          <Field label={t('set.version')}>
            <span className="ln-tabular">{status?.version ?? '2.0.0'}</span>
          </Field>
          <Field label={t('set.hostVersion')}>
            <span className="ln-tabular">{status?.hostVersion ?? '—'}</span>
          </Field>
          <Field label={t('set.dataDir')}>
            <span className="ln-set__path">{status?.dataDirDisplay ?? '—'}</span>
          </Field>
          <Field label={t('set.diagnostics')}>
            <div className="ln-set__diag">
              <pre className="ln-set__diagText">{diagnosticsText}</pre>
              <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyDiagnostics()}>
                {t('set.copyDiagnostics')}
              </Button>
            </div>
          </Field>
          <p className="ln-set__aboutBody">{t('set.aboutBody')}</p>
        </section>
      </div>
    </Dialog>
  )
}
