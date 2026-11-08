/**
 * Preset whole-paper questions offered above the AI composer.
 *
 * They stay visible in every scope (the default 全文 and any explicit paragraph
 * or selection focus) so a reader always has a first question to start from,
 * instead of only seeing suggestions on a brand-new conversation.
 */

/** i18n keys of the preset questions, in display order. */
export const QUICK_PROMPT_KEYS = [
  'ai.quickSummary',
  'ai.quickSolved',
  'ai.quickMethod',
  'ai.quickLimits',
  'ai.quickConcept',
] as const

/** One preset question key. */
export type QuickPromptKey = (typeof QUICK_PROMPT_KEYS)[number]
