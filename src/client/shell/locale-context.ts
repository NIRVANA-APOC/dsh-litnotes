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
