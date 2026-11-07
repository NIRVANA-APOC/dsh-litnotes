/**
 * Agent context integration for dsh-litnotes.
 *
 * The plugin owns a local literature library. Instead of relying on the model
 * to notice the tools by name, the plugin registers ONE compact system-prompt
 * section telling the agent that the library exists, which tool family to use
 * and that every result carries citation-ready coordinates. The text is
 * deliberately static (not derived from the library state): a per-turn section
 * would make the agent context vary with unrelated library mutations, and an
 * empty library still has tools worth calling (`library_manage` to import a
 * paper).
 *
 * Registration is effect-owned: Cordis disposes it with the plugin scope, and
 * the returned disposer is idempotent. A profile without the `systemPrompt`
 * service is a safe no-op (the library simply loses the hint).
 *
 * @module host/ai/prompt-section
 */

import type { PluginContext, PromptSection, SystemPromptService } from '../host-services.ts'
import type { Disposer, Logger } from '../host-services.ts'
import type { ServiceApi } from '../contracts.ts'

/** Stable prompt-section name (the Harness dedupes/reporting uses this). */
export const LIBRARY_PROMPT_SECTION_NAME = 'litnotes-library'

/**
 * Section order: after the Harness identity/behaviour sections (0–50) and
 * before task-specific late sections, so the hint reads as ambient capability
 * rather than a hard instruction.
 */
export const LIBRARY_PROMPT_SECTION_ORDER = 55

/**
 * The static section text (≤3 lines): library existence, the tool families and
 * the citation-ready result coordinates, plus the stay-silent rule.
 */
export const LIBRARY_PROMPT_SECTION_TEXT: string = [
  'A local literature library is available through dsh-litnotes: use the library_search, library_read, library_ask, library_annotate, library_translate, library_graph and library_manage tools when the task involves the user\'s papers.',
  'Their results carry documentId, blockKey, page and quote coordinates — cite papers with those coordinates so the user can jump to the exact text.',
  'Do not mention the literature library when the request is unrelated to it.',
].join('\n')

/** The prompt section registered with the Host. */
export const LIBRARY_PROMPT_SECTION: PromptSection = Object.freeze({
  name: LIBRARY_PROMPT_SECTION_NAME,
  order: LIBRARY_PROMPT_SECTION_ORDER,
  text: LIBRARY_PROMPT_SECTION_TEXT,
})

/** Context capability this module needs (the real Cordis context conforms). */
export type PromptSectionContext = Pick<PluginContext, 'get'> & Partial<Pick<PluginContext, 'effect'>>

/** Dependencies of {@link registerLibraryPromptSection}. */
export interface LibraryPromptSectionDeps {
  /** Host plugin context (`ctx.get('systemPrompt')`, `ctx.effect`). */
  ctx: PromptSectionContext
  /**
   * The operations service is accepted for composition-root symmetry and future
   * dynamic variants; the section text is intentionally static, so it is not
   * read here (see the module doc for the rationale).
   */
  service?: ServiceApi | undefined
  logger?: Logger | undefined
}

/** Disposer that can safely be called more than once. */
function noopDisposer(): void {
  /* no registration to release */
}

/** Narrow an unknown Host service value to the `systemPrompt` surface. */
function asSystemPromptService(value: unknown): SystemPromptService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return typeof (value as { section?: unknown }).section === 'function'
    ? (value as SystemPromptService)
    : undefined
}

/** Contexts that already registered the section (idempotency guard). */
const REGISTERED_CONTEXTS = new WeakSet<object>()

/**
 * Register the static dsh-litnotes library hint as ONE Host system-prompt
 * section.
 *
 * @param deps - the Host context, the operations service (unused, see type) and
 *   an optional logger.
 * @returns an idempotent disposer. Registration itself is also owned by
 *   `ctx.effect` when the context exposes one, so the section is removed with
 *   the plugin scope even if the caller ignores the return value.
 */
export function registerLibraryPromptSection(deps: LibraryPromptSectionDeps): Disposer {
  const { ctx } = deps
  const log = deps.logger ?? {}
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return noopDisposer
  if (REGISTERED_CONTEXTS.has(ctx)) return noopDisposer
  let serviceValue: unknown
  try {
    serviceValue = ctx.get('systemPrompt')
  } catch {
    // The contract says get() never throws for absent services; a broken
    // profile context must still not fail the plugin.
    return noopDisposer
  }
  const systemPrompt = asSystemPromptService(serviceValue)
  if (systemPrompt === undefined) {
    log.debug?.('[dsh-litnotes] systemPrompt service absent; library prompt section not registered')
    return noopDisposer
  }
  let sectionDisposer: Disposer = noopDisposer
  try {
    const value = systemPrompt.section(LIBRARY_PROMPT_SECTION)
    if (typeof value === 'function') sectionDisposer = value
  } catch (error) {
    log.warn?.(
      '[dsh-litnotes] cannot register the library prompt section: %s',
      (error as Error)?.message ?? error,
    )
    return noopDisposer
  }
  REGISTERED_CONTEXTS.add(ctx)
  let disposed = false
  /** Idempotent cleanup: release the section and clear the idempotency guard. */
  function cleanup(): void {
    if (disposed) return
    disposed = true
    REGISTERED_CONTEXTS.delete(ctx)
    try {
      sectionDisposer()
    } catch (error) {
      log.warn?.(
        '[dsh-litnotes] library prompt section disposer failed: %s',
        (error as Error)?.message ?? error,
      )
    }
  }
  // Prefer letting Cordis own the registration lifecycle (`ctx.effect`) so the
  // section disappears with the plugin scope; fall back to returning the plain
  // disposer for minimal contexts/tests.
  if (typeof ctx.effect === 'function') {
    try {
      return ctx.effect(() => cleanup, 'dsh-litnotes: library prompt section')
    } catch (error) {
      log.warn?.(
        '[dsh-litnotes] cannot own the library prompt section effect: %s',
        (error as Error)?.message ?? error,
      )
    }
  }
  return cleanup
}
