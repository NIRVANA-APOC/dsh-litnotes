/**
 * The margin filter row (全部 / 对话 / AI 批注 / 我的批注 / 精读 + counts), hosted
 * by the reader's sticky margin header.
 *
 * The margin column scrolls independently from the paper, so its filter chips
 * must live in the sticky header rather than inside the AI stream: after
 * scrolling down to the notes the reader can always switch back to the
 * conversation (对话) with one click.
 *
 * The `精读` count is the number of report annotations the close-reading run
 * wrote for the current document; it is 0 when the stored record belongs to a
 * different paper (the store keeps one active document at a time).
 */

import type { ReactElement } from 'react'
import { useMemo } from 'react'

import { AiMarginFilterChips } from './AiMarginFilterChips.tsx'
import { useMarginAnnotationCounts } from './reader-bridge.ts'
import { useDeepReadStore } from './deepread-store.ts'
import { useAiStore } from './store.ts'
import { useUiStore } from '../state/ui.ts'

/** Filter chips with live chat / annotation / close-reading counts. */
export function MarginFilterRow(): ReactElement {
  const messages = useAiStore((state) => state.messages)
  const annotations = useMarginAnnotationCounts()
  const currentDocumentId = useUiStore((state) => state.currentDocumentId)
  const deepReadRecord = useDeepReadStore((state) => state.record)
  // Count = report annotations of the current paper; a record of another
  // document (stale store state) never leaks into this paper's chip.
  const deepReadCount =
    deepReadRecord !== null && deepReadRecord.documentId === currentDocumentId
      ? deepReadRecord.highlights.length
      : 0
  const counts = useMemo(
    () => ({
      chat: messages.filter((message) => message.role === 'assistant').length,
      ai: annotations.ai,
      user: annotations.user,
      deepread: deepReadCount,
    }),
    [messages, annotations.ai, annotations.user, deepReadCount],
  )
  return <AiMarginFilterChips counts={counts} />
}
