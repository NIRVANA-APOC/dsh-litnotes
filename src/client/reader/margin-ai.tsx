/**
 * AI margin seat — the single import point the reader scene uses for the AI
 * conversation stream.
 *
 * `client-ai` owns the component (`src/client/ai/AiMarginEntries.tsx`); this
 * module only re-exports it so the reader never depends on AI internals and the
 * handoff stays one line. Props contract: `documentId`, `orderOf`, `onJump`,
 * `onAnnotationsChanged` (lead-brokered; mirrored in `./api.ts`).
 */

export { AiMarginEntries } from '../ai/AiMarginEntries.tsx'
export type { AiMarginEntriesProps } from '../ai/AiMarginEntries.tsx'
export { AiComposer } from '../ai/AiComposer.tsx'
export { MarginFilterRow } from '../ai/MarginFilterRow.tsx'
