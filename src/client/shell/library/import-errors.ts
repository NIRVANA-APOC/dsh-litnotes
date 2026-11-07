/**
 * Error guidance for import / parse failures.
 *
 * The wire contract sends a branchable code plus a bilingual message; the UI
 * must say what failed *and what to do next* (DESIGN-V2 §9), so every code maps
 * to either a setup hint or a concrete next action.
 */

import { ApiError } from '../../api/client.ts'
import type { LitnotesTranslate } from '../locale-context.ts'

/** One actionable failure description. */
export interface ImportFailure {
  /** Branchable wire code (`network`, `token-missing`, …). */
  code: string
  /** Server-safe message; never contains a token. */
  message: string
  /** What to do next, when the failure is actionable. */
  hint: string | null
  /** Whether retrying the same operation can help. */
  retryable: boolean
}

/** Message text of any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

/**
 * Describe an import/parse failure with a next step.
 *
 * @param error - thrown value (usually {@link ApiError}).
 * @param t - translate function.
 * @returns message, hint and retryability.
 */
export function describeImportFailure(error: unknown, t: LitnotesTranslate): ImportFailure {
  const code = error instanceof ApiError ? error.code : 'unknown'
  const message = errorMessage(error) === '' ? t('err.generic') : errorMessage(error)
  switch (code) {
    case 'token-missing':
      return { code, message, hint: t('err.tokenMissing'), retryable: false }
    case 'local-unsupported':
      return { code, message, hint: t('err.localUnsupported'), retryable: false }
    case 'local-missing-tool':
      return { code, message, hint: t('err.localMissingTool'), retryable: false }
    case 'too-large':
      return { code, message, hint: t('err.tooLarge'), retryable: false }
    case 'unsupported-type':
      return { code, message, hint: t('err.unsupportedType'), retryable: false }
    case 'network':
    case 'timeout':
      return { code, message: t('err.network'), hint: null, retryable: true }
    case 'aborted':
      return { code, message, hint: null, retryable: true }
    default:
      return { code, message, hint: null, retryable: true }
  }
}

/** Compose one toast line from a failure (message plus hint). */
export function failureText(failure: ImportFailure): string {
  return failure.hint === null ? failure.message : `${failure.message} ${failure.hint}`
}
