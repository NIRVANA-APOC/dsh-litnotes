/**
 * AI margin seat — the single import point the reader scene uses for the AI
 * conversation stream and the close-reading (`精读`) panel.
 *
 * `client-ai` owns the components (`src/client/ai/AiMarginEntries.tsx`,
 * `src/client/ai/DeepReadPanel.tsx`); this module only re-exports them so the
 * reader never depends on AI internals and the handoff stays one line. Props
 * contracts: `AiMarginEntries` — `documentId`, `orderOf`, `onJump`,
 * `onAnnotationsChanged`; `DeepReadPanel` — `documentId`, `annotations`,
 * `onJump`, `onAnnotationsChanged` (mirrored in `./api.ts`).
 */

export { AiMarginEntries } from '../ai/AiMarginEntries.tsx'
export type { AiMarginEntriesProps } from '../ai/AiMarginEntries.tsx'
export { AiComposer } from '../ai/AiComposer.tsx'
export { MarginFilterRow } from '../ai/MarginFilterRow.tsx'
export { DeepReadPanel } from '../ai/DeepReadPanel.tsx'
export type { DeepReadPanelProps } from '../ai/DeepReadPanel.tsx'
