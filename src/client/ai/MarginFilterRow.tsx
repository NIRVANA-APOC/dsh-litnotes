/**
 * The margin filter row (全部 / 对话 / AI 批注 / 我的批注 + counts), hosted by the
 * reader's sticky margin header.
 *
 * The margin column scrolls independently from the paper, so its filter chips
 * must live in the sticky header rather than inside the AI stream: after
 * scrolling down to the notes the reader can always switch back to the
 * conversation (对话) with one click.
 */

import type { ReactElement } from 'react'
import { useMemo } from 'react'

import { AiMarginFilterChips } from './AiMarginFilterChips.tsx'
import { useMarginAnnotationCounts } from './reader-bridge.ts'
import { useAiStore } from './store.ts'

/** Filter chips with live chat/annotation counts. */
export function MarginFilterRow(): ReactElement {
  const messages = useAiStore((state) => state.messages)
  const annotations = useMarginAnnotationCounts()
  const counts = useMemo(
    () => ({
      chat: messages.filter((message) => message.role === 'assistant').length,
      ai: annotations.ai,
      user: annotations.user,
    }),
    [messages, annotations.ai, annotations.user],
  )
  return <AiMarginFilterChips counts={counts} />
}
