/**
 * Translate adapter for the AI helpers.
 *
 * The margin helpers (`chat.ts` export/citation/nav copy) look up keys built at
 * runtime (`aspect.${aspect}`, error-code keys), so they need a string-keyed
 * translate function while the framework seat is typed to the merged namespace
 * union. This module widens the key space at that single boundary — nowhere else
 * casts keys.
 */

import type { LitnotesTranslate } from '../shell/locale-context.ts'
import type { AiTranslate } from './chat.ts'

/**
 * Bind the typed framework translate function to the AI helper contract.
 *
 * @param t - framework-bound translate function of the `dsh-litnotes` namespace.
 * @returns a string-keyed translate function for helpers/callbacks.
 */
export function adaptTranslate(t: LitnotesTranslate): AiTranslate {
  return (key, params) => t(key as Parameters<LitnotesTranslate>[0], params)
}
