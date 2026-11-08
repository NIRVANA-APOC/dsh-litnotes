/**
 * dsh-litnotes — Host half entry.
 *
 * Wires the on-disk library (store), the parse pipeline (MinerU cloud + local
 * engine), the operation service shared by the HTTP API and the agent tools,
 * the web routes, the grounded AI bundle (chat + knowledge graphs) and the
 * eight library tools exposed to the DSH agent. The Client half is
 * `lib/client.js` and reaches this half only through the routes registered
 * here.
 *
 * Contracts: docs/ARCH.md, docs/AI-SPEC.md.
 *
 * @module host/index
 */

import type { ParseManagerApi } from './contracts.ts'
import { PACKAGE_VERSION, getToken, resolveConfig, type CredentialsLike } from './config.ts'
import type {
  AgentDefaultModelService,
  HostContext,
  LlmService,
  Logger,
  ModelSelection,
  TokenMeterService,
  ToolsService,
  TranslatorService,
} from './host-services.ts'
import { createAiServices } from './ai/index.ts'
import { registerLibraryPromptSection } from './ai/prompt-section.ts'
import { registerLibraryTools } from './agent-tools.ts'
import { createLocalEngine } from './parse/local/engine.ts'
import { createParseManager } from './parse/manager.ts'
import { describeMineruError, normalizeParseOptions } from './parse/mineru.ts'
import { registerRoutes } from './routes.ts'
import { createService } from './service.ts'
import { createStore } from './store/index.ts'

/** Plugin identity for Cordis rows. */
export const name = 'dsh-litnotes'

/** Hard dependencies. Optional services (`tools`, `credentials`, `translator`,
 * `llm`, `agentDefaultModel`, `officeToPdf`, `tokenMeter`) are read with
 * `ctx.get()` so profiles without them still load the library, only losing the
 * corresponding capability. */
export const inject = ['webServer', 'connection']

/** Host version string reported by `health.ping` / `status`. */
export const HOST_VERSION = `${PACKAGE_VERSION}+host`

/**
 * Read an optional Host service as its structural contract.
 *
 * `ctx.get()` is intentionally untyped at the platform boundary, so the cast
 * happens once here instead of at every call site.
 *
 * @param ctx - Host plugin context.
 * @param serviceName - registered service name.
 * @returns the service when mounted, undefined otherwise.
 */
function optionalService<T>(ctx: HostContext, serviceName: string): T | undefined {
  try {
    const value = ctx.get(serviceName)
    if (value === undefined || value === null) return undefined
    return value as T
  } catch {
    return undefined
  }
}

/**
 * The default model selection reported by the Host agent preset.
 *
 * @param ctx - Host plugin context.
 * @returns the current selection, or undefined when no preset is mounted.
 */
function defaultModelOf(ctx: HostContext): (() => ModelSelection | undefined) {
  return () => {
    const service = optionalService<AgentDefaultModelService>(ctx, 'agentDefaultModel')
    try {
      return service?.currentSelection?.()
    } catch {
      return undefined
    }
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx - Host plugin context.
 * @param config - raw row config (validated by `resolveConfig`).
 */
export function apply(ctx: HostContext, config?: Record<string, unknown>): void {
  const logger: Logger = ctx.logger ?? console
  const resolved = resolveConfig(config)
  // `ctx.get` returns the platform service; the plugin only relies on the
  // structural CredentialsLike surface documented in host-services.ts.
  const credentials = optionalService<CredentialsLike>(ctx, 'credentials')

  const store = createStore({ dataDir: resolved.dataDir, logger })
  // Local engine (T0 pdf.js / T0.5 officeToPdf). The Office service is optional
  // and may be mounted after this plugin, so it is resolved lazily per parse.
  const localEngine = createLocalEngine({
    config: resolved,
    logger,
    getOfficeToPdf: () => optionalService<unknown>(ctx, 'officeToPdf'),
  })
  const manager: ParseManagerApi = createParseManager({
    store,
    config: resolved,
    logger,
    getToken: () => getToken(credentials),
    fetchImpl: globalThis.fetch,
    localEngine,
  })
  /** Optional model selection used by the AI engine. */
  const defaultModelSelection = defaultModelOf(ctx)
  const ai = createAiServices({
    store,
    config: resolved,
    logger,
    getLlm: () => optionalService<LlmService>(ctx, 'llm'),
    getDefaultModel: defaultModelSelection,
    hostVersion: HOST_VERSION,
    getTokenMeter: () => optionalService<TokenMeterService>(ctx, 'tokenMeter'),
  })
  const service = createService({
    store,
    manager,
    config: resolved,
    logger,
    hostVersion: HOST_VERSION,
    getCredentials: () => credentials,
    getTranslator: () => optionalService<TranslatorService>(ctx, 'translator'),
    getLlm: () => optionalService<LlmService>(ctx, 'llm'),
    localEngine,
    getDefaultModel: defaultModelSelection,
    getAi: () => ai.ensure(),
    normalizeParseOptions,
    describeMineruError,
  })

  // Register the static literature-library hint in the agent system prompt.
  // The helper owns its disposal through `ctx.effect` and is a safe no-op when
  // the profile does not mount the `systemPrompt` service.
  registerLibraryPromptSection({ ctx, service, logger })

  // Boot: initialize the library then resume interruptible parse tasks. Routes
  // are registered immediately; store methods await the same init promise.
  ctx.effect(() => {
    let disposed = false
    const ready = store
      .init()
      .then(() => {
        if (disposed) return
        manager.resume()
        logger.info?.('[dsh-litnotes] library ready at %s', resolved.dataDir)
      })
      .catch((error: unknown) => {
        logger.error?.('[dsh-litnotes] library initialization failed:', error)
      })
    return () => {
      disposed = true
      void ready
        .then(() => Promise.allSettled([manager.dispose(), store.dispose()]))
        .catch(() => {})
    }
  }, 'dsh-litnotes: library boot')

  ctx.effect(
    () => registerRoutes({ ctx, service, store, config: resolved, logger }),
    'dsh-litnotes: web routes',
  )
  ctx.effect(
    () =>
      registerLibraryTools({
        tools: optionalService<ToolsService>(ctx, 'tools'),
        service,
        config: resolved,
        logger,
      }),
    'dsh-litnotes: library agent tools',
  )

  logger.info?.('[dsh-litnotes] mounted (data=%s, api=%s)', resolved.dataDir, resolved.apiBase)
}
