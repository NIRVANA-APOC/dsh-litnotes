/**
 * Unit tests for the agent-context integration (`src/host/ai/prompt-section.ts`):
 * one compact, static system-prompt section that tells the agent the literature
 * library exists, which tools to use and that results carry citation-ready
 * coordinates; effect-owned/idempotent registration and safe degradation when
 * the `systemPrompt` service is absent.
 */

import { expect, test } from 'vitest'
import {
  LIBRARY_PROMPT_SECTION,
  LIBRARY_PROMPT_SECTION_NAME,
  LIBRARY_PROMPT_SECTION_ORDER,
  LIBRARY_PROMPT_SECTION_TEXT,
  registerLibraryPromptSection,
  type PromptSectionContext,
} from '../../src/host/ai/prompt-section.ts'
import type { PromptSection, SystemPromptService } from '../../src/host/host-services.ts'
import type { Disposer } from '../../src/host/host-services.ts'
import type { ServiceApi } from '../../src/host/contracts.ts'

/** Fake `systemPrompt` service that records sections and disposal. */
interface FakePromptService extends SystemPromptService {
  sections: PromptSection[]
  disposeCalls: number
}

/** Create a fake `systemPrompt` service. */
function createFakeSystemPrompt(): FakePromptService {
  const sections: PromptSection[] = []
  const service: FakePromptService = {
    sections,
    disposeCalls: 0,
    section(section: PromptSection): Disposer {
      sections.push(section)
      return () => {
        service.disposeCalls += 1
      }
    },
  }
  return service
}

/** One recorded `ctx.effect` registration. */
interface RecordedEffect {
  label: string | undefined
  dispose: Disposer
}

/** Build a fake host context (`get` + optional `effect`). */
function makeCtx(options: {
  systemPrompt?: FakePromptService | undefined
  withEffect?: boolean
  effectThrows?: boolean
  getThrows?: boolean
} = {}): { ctx: PromptSectionContext; effects: RecordedEffect[] } {
  const effects: RecordedEffect[] = []
  const ctx: PromptSectionContext = {
    get(name: string): unknown {
      if (options.getThrows === true) throw new Error('context exploded')
      return name === 'systemPrompt' ? options.systemPrompt : undefined
    },
  }
  if (options.withEffect !== false) {
    ctx.effect = (callback: () => Disposer | void, label?: string): Disposer => {
      if (options.effectThrows === true) throw new Error('effect exploded')
      const disposer = callback()
      const dispose = (): void => {
        if (typeof disposer === 'function') disposer()
      }
      effects.push({ label, dispose })
      return dispose
    }
  }
  return { ctx, effects }
}

/** A minimal operations-service stand-in (the section text must not read it). */
function fakeService(documents: unknown[]): ServiceApi {
  return {
    listDocuments: async () => ({ documents }),
  } as unknown as ServiceApi
}

test('registers exactly one compact, static section with the documented name/order', () => {
  const systemPrompt = createFakeSystemPrompt()
  const { ctx } = makeCtx({ systemPrompt })
  const dispose = registerLibraryPromptSection({ ctx, logger: {} })
  expect(systemPrompt.sections.length).toBe(1)
  const section = systemPrompt.sections[0]
  expect(section).toBeDefined()
  expect(section?.name).toBe(LIBRARY_PROMPT_SECTION_NAME)
  expect(section?.name).toBe('litnotes-library')
  expect(section?.order).toBe(LIBRARY_PROMPT_SECTION_ORDER)
  expect(section?.text).toBe(LIBRARY_PROMPT_SECTION_TEXT)
  expect(section).toBe(LIBRARY_PROMPT_SECTION)
  dispose()
})

test('the text names the tool families, the citation coordinates and the silence rule', () => {
  const text = LIBRARY_PROMPT_SECTION_TEXT
  for (const tool of [
    'library_search',
    'library_read',
    'library_ask',
    'library_deepread',
    'library_annotate',
    'library_translate',
    'library_graph',
    'library_manage',
  ]) {
    expect(text.includes(tool), `expected tool ${tool} in the prompt section`).toBe(true)
  }
  for (const coordinate of ['documentId', 'blockKey', 'page', 'quote']) {
    expect(text.includes(coordinate), `expected coordinate ${coordinate}`).toBe(true)
  }
  expect(text.toLowerCase()).toContain('cite')
  expect(text.toLowerCase()).toContain('unrelated')
  // Compact: at most three lines.
  expect(text.split('\n').length).toBeLessThanOrEqual(3)
})

test('the text is static: library-empty state does not change it', () => {
  const emptyCtx = makeCtx({ systemPrompt: createFakeSystemPrompt() })
  registerLibraryPromptSection({ ctx: emptyCtx.ctx, service: fakeService([]), logger: {} })
  const populatedCtx = makeCtx({ systemPrompt: createFakeSystemPrompt() })
  registerLibraryPromptSection({
    ctx: populatedCtx.ctx,
    service: fakeService([{ id: 'doc-1' }, { id: 'doc-2' }]),
    logger: {},
  })
  expect(emptyCtx.ctx).not.toBe(populatedCtx.ctx)
  const emptyText = (emptyCtx.ctx.get('systemPrompt') as FakePromptService).sections[0]?.text
  const populatedText = (populatedCtx.ctx.get('systemPrompt') as FakePromptService).sections[0]?.text
  expect(emptyText).toBe(LIBRARY_PROMPT_SECTION_TEXT)
  expect(populatedText).toBe(LIBRARY_PROMPT_SECTION_TEXT)
})

test('disposal runs once and is idempotent', () => {
  const systemPrompt = createFakeSystemPrompt()
  const { ctx, effects } = makeCtx({ systemPrompt })
  const dispose = registerLibraryPromptSection({ ctx, logger: {} })
  expect(effects.length).toBe(1)
  expect(effects[0]?.label).toBe('dsh-litnotes: library prompt section')
  dispose()
  expect(systemPrompt.disposeCalls).toBe(1)
  dispose()
  expect(systemPrompt.disposeCalls, 'the disposer is idempotent').toBe(1)
})

test('re-registering with the same context is a no-op (idempotent registration)', () => {
  const systemPrompt = createFakeSystemPrompt()
  const { ctx } = makeCtx({ systemPrompt })
  const first = registerLibraryPromptSection({ ctx, logger: {} })
  const second = registerLibraryPromptSection({ ctx, logger: {} })
  expect(systemPrompt.sections.length).toBe(1)
  second()
  expect(systemPrompt.disposeCalls, 'the no-op disposer must not release the live section').toBe(0)
  first()
  expect(systemPrompt.disposeCalls).toBe(1)
})

test('a missing systemPrompt service is a safe no-op', () => {
  const { ctx, effects } = makeCtx({ systemPrompt: undefined })
  const dispose = registerLibraryPromptSection({ ctx, logger: {} })
  expect(typeof dispose).toBe('function')
  expect(effects.length, 'no section means no effect to own').toBe(0)
  expect(() => dispose()).not.toThrow()
})

test('a context without get is a safe no-op', () => {
  const dispose = registerLibraryPromptSection({ ctx: null as unknown as PromptSectionContext, logger: {} })
  expect(() => dispose()).not.toThrow()
})

test('a throwing systemPrompt service neither throws nor owns an effect', () => {
  const systemPrompt: SystemPromptService = {
    section(): Disposer {
      throw new Error('section service exploded')
    },
  }
  const { ctx, effects } = makeCtx({ systemPrompt: systemPrompt as FakePromptService })
  const warnings: string[] = []
  const dispose = registerLibraryPromptSection({ ctx, logger: { warn: (message?: string) => warnings.push(String(message)) } })
  expect(typeof dispose).toBe('function')
  expect(() => dispose()).not.toThrow()
  expect(effects.length).toBe(0)
  expect(warnings.length).toBe(1)
})

test('falls back to the plain disposer when ctx.effect throws', () => {
  const systemPrompt = createFakeSystemPrompt()
  const { ctx } = makeCtx({ systemPrompt, effectThrows: true })
  const dispose = registerLibraryPromptSection({ ctx, logger: {} })
  expect(systemPrompt.sections.length).toBe(1)
  dispose()
  expect(systemPrompt.disposeCalls).toBe(1)
})

test('a throwing ctx.get is tolerated as a missing service', () => {
  const { ctx } = makeCtx({ getThrows: true })
  const dispose = registerLibraryPromptSection({ ctx, logger: {} })
  expect(typeof dispose).toBe('function')
  expect(() => dispose()).not.toThrow()
})

test('can re-register after the previous registration was disposed', () => {
  const systemPrompt = createFakeSystemPrompt()
  const { ctx } = makeCtx({ systemPrompt })
  const first = registerLibraryPromptSection({ ctx, logger: {} })
  first()
  const second = registerLibraryPromptSection({ ctx, logger: {} })
  expect(systemPrompt.sections.length).toBe(2)
  second()
  expect(systemPrompt.disposeCalls).toBe(2)
})
