/**
 * AI margin seat.
 *
 * `client-ai` owns `AiMarginEntries` (conversation stream, citation chips,
 * composer, filter chips). This module is the single import point the reader
 * scene uses, so the handoff is one line: when the AI component lands, this
 * file re-exports it from `../ai/AiMarginEntries.tsx` and the reader scene does
 * not change.
 *
 * Until that file exists this module exposes a typed, inert stub that keeps the
 * margin layout and the tether contract exercised (no fake content, no copy).
 */

import type { ReactElement } from 'react'
import type { AiMarginEntriesProps } from './api.ts'

/** Placeholder for `client-ai`'s margin stream (deleted on handoff). */
export function AiMarginEntries({ documentId }: AiMarginEntriesProps): ReactElement {
  return (
    <div
      className="ln-margin__ai ln-margin__ai--empty"
      data-document-id={documentId}
      data-ai-margin="pending"
    />
  )
}
