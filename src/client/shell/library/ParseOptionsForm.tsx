/**
 * Shared parse-options form used by the import dialog, the reparse dialog and
 * the settings "default parse settings" section.
 *
 * It renders controlled values only; the owning dialog keeps the draft state
 * and decides when to persist/remember it. Capability-driven disabling follows
 * the Host policy: local parsing ignores MinerU options, the Agent API ignores
 * the model version.
 */

import type { ReactElement } from 'react'
import type { LocalCapabilities, ParseOptions } from '../../../shared/model.ts'
import type { LitnotesTranslate } from '../locale-context.ts'
import { Segmented, Select, Switch, TextInput } from '../design/primitives.tsx'
import { Button } from '../design/primitives.tsx'
import { engineHint, engineOptions, languageOptions, localSupportFor, modelVersionOptions } from './options.ts'
import { useT } from '../locale-context.ts'

/** Props of {@link ParseOptionsForm}. */
export interface ParseOptionsFormProps {
  value: ParseOptions
  onChange: (next: ParseOptions) => void
  tokenConfigured: boolean
  local: LocalCapabilities | null
  /** Lowercase extension of the target file ('' when unknown). */
  ext: string
  disabled?: boolean
  /** Show the "open settings" shortcut next to the token warning. */
  onOpenSettings?: () => void
  /** Hide the engine choice (page-repair requests carry no engine). */
  showEngine?: boolean
}

/** Translate-aware token warning row. */
function TokenWarning({ t, onOpenSettings }: { t: LitnotesTranslate; onOpenSettings?: () => void }): ReactElement {
  return (
    <div className="ln-callout ln-callout--warn">
      <span className="ln-callout__text">{t('dlg.import.tokenWarn')}</span>
      {onOpenSettings === undefined ? null : (
        <Button variant="quiet" size="sm" onClick={onOpenSettings}>
          {t('dlg.import.tokenAction')}
        </Button>
      )}
    </div>
  )
}

/**
 * Render the parse engine + options form.
 *
 * @param props - controlled value, capabilities and change handler.
 * @returns the form markup.
 */
export function ParseOptionsForm({
  value,
  onChange,
  tokenConfigured,
  local,
  ext,
  disabled = false,
  onOpenSettings,
  showEngine = true,
}: ParseOptionsFormProps): ReactElement {
  const t = useT()
  const engine = value.engine ?? 'auto'
  const localSupport = localSupportFor(local, ext, t)
  const localEngine = engine === 'local'
  const modelUnused = localEngine || engine === 'agent'
  const pagesDisabled = localEngine
  const needsToken = engine === 'standard' && !tokenConfigured
  const engineLabels = engineOptions(t, local, ext)

  /** Patch one field of the draft. */
  const patch = (next: Partial<ParseOptions>): void => {
    onChange({ ...value, ...next })
  }

  return (
    <div className="ln-parseform" data-disabled={disabled || undefined}>
      {!showEngine ? null : (
        <div className="ln-field">
          <span className="ln-field__label">{t('parse.engine')}</span>
          <div className="ln-field__control">
            <Segmented
              size="sm"
              value={engine}
              options={engineLabels}
              onChange={(next) => patch({ engine: next })}
              ariaLabel={t('parse.engine')}
            />
            <p className="ln-field__hint">{engineHint(engine, tokenConfigured, localSupport, t)}</p>
            {engine === 'local' && !localSupport.supported && localSupport.reason !== null ? (
              <p className="ln-field__hint ln-field__hint--warn">{localSupport.reason}</p>
            ) : null}
          </div>
        </div>
      )}

      {showEngine && needsToken ? <TokenWarning t={t} onOpenSettings={onOpenSettings} /> : null}

      <div className="ln-field">
        <span className="ln-field__label">{t('parse.model')}</span>
        <div className="ln-field__control">
          <Segmented
            size="sm"
            value={value.modelVersion ?? 'vlm'}
            options={modelVersionOptions(t)}
            onChange={(next) => patch({ modelVersion: next })}
            ariaLabel={t('parse.model')}
            className={modelUnused ? 'is-disabled' : undefined}
          />
          <p className="ln-field__hint">{modelUnused ? t('parse.model.unused') : t('parse.model.hint')}</p>
        </div>
      </div>

      <div className="ln-field">
        <span className="ln-field__label">{t('parse.language')}</span>
        <div className="ln-field__control">
          <Select
            value={value.language ?? 'ch'}
            disabled={disabled || localEngine}
            onChange={(event) => patch({ language: event.target.value })}
            aria-label={t('parse.language')}
          >
            {languageOptions(t).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="ln-field">
        <span className="ln-field__label">{t('parse.pageRanges')}</span>
        <div className="ln-field__control">
          <TextInput
            value={value.pageRanges ?? ''}
            disabled={disabled || pagesDisabled}
            placeholder="2,4-6"
            aria-label={t('parse.pageRanges')}
            onChange={(event) => patch({ pageRanges: event.target.value })}
          />
          <p className="ln-field__hint">{localEngine ? t('parse.pageRangesLocal') : t('parse.pageRangesHint')}</p>
        </div>
      </div>

      <div className="ln-field">
        <span className="ln-field__label">{t('parse.moreOptions')}</span>
        <div className="ln-field__control ln-parseform__switches">
          <label className="ln-parseform__switch">
            <Switch
              checked={value.isOcr === true}
              onChange={(checked) => patch({ isOcr: checked })}
              label={t('parse.ocr')}
              disabled={disabled || localEngine}
            />
            <span>
              <span className="ln-parseform__switchLabel">{t('parse.ocr')}</span>
              <span className="ln-parseform__switchHint">{t('parse.ocrHint')}</span>
            </span>
          </label>
          <label className="ln-parseform__switch">
            <Switch
              checked={value.enableFormula !== false}
              onChange={(checked) => patch({ enableFormula: checked })}
              label={t('parse.formula')}
              disabled={disabled || localEngine}
            />
            <span>
              <span className="ln-parseform__switchLabel">{t('parse.formula')}</span>
              <span className="ln-parseform__switchHint">{t('parse.formulaHint')}</span>
            </span>
          </label>
          <label className="ln-parseform__switch">
            <Switch
              checked={value.enableTable !== false}
              onChange={(checked) => patch({ enableTable: checked })}
              label={t('parse.table')}
              disabled={disabled || localEngine}
            />
            <span>
              <span className="ln-parseform__switchLabel">{t('parse.table')}</span>
              <span className="ln-parseform__switchHint">{t('parse.tableHint')}</span>
            </span>
          </label>
          {localEngine ? <p className="ln-field__hint">{t('parse.localFixed')}</p> : null}
        </div>
      </div>
    </div>
  )
}
