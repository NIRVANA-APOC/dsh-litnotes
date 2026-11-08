/**
 * Locale plumbing for the shell and scenes: the Host passes the bound
 * translate function through slot props; components read it from context so
 * every nested component translates without prop drilling.
 */

import { createContext, useContext } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Bound translate function for this plugin's namespace. */
export type LitnotesTranslate = TranslateNS<'dsh-litnotes'>

const fallback: LitnotesTranslate = (key) => key

/** Context carrying the active translate function. */
export const LocaleContext = createContext<LitnotesTranslate>(fallback)

/** Read the active translate function. */
export function useT(): LitnotesTranslate {
  return useContext(LocaleContext)
}

/* -------------------------------------------------------------------------- */
/* Active locale id (non-React seam)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read the active locale id outside React — used by feature stores that send
 * the reader's language to the Host (for example `AI 精读` notes and reports).
 * The client entry installs the real reader once the locale service is mounted;
 * the fallback keeps unit tests and minimal hosts deterministic.
 */
let localeReader: () => string = () => 'en'

/**
 * Install the reader that resolves the locale service's active id.
 *
 * @param read - returns a BCP 47-style locale id (`zh`, `en`, …).
 */
export function provideLocale(read: () => string): void {
  localeReader = read
}

/**
 * Current reader language id; never throws.
 *
 * @returns a non-empty locale id, `en` when the locale service is unavailable.
 */
export function activeLocale(): string {
  try {
    const value = localeReader()
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 32) : 'en'
  } catch {
    return 'en'
  }
}
