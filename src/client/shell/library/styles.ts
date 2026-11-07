/**
 * The shell-library area stylesheet, injected once by {@link useInjectedStyle}.
 * Kept as a `.ts` wrapper so the build's CSS asset plugin returns the compiled
 * string (same pattern as `styles/index.ts`).
 */

import css from './styles.css'

/** Compiled shell-library stylesheet. */
export const SHELL_LIBRARY_CSS: string = css
