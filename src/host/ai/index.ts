/**
 * AI service bundle for dsh-litnotes.
 *
 * The bundle is built lazily so the plugin still boots (and the reading desk
 * keeps working) while a deployment has no LLM service. One `ensure()` call
 * builds the gateway, retriever, graph service and grounded chat service and
 * memoizes them; `peek()` returns the bundle only when it is already built.
 *
 * Contract: `AiServicesApi` in `src/host/contracts.ts`, `docs/AI-SPEC.md` §3.7.
 *
 * @module host/ai/index
 */

import { createLlmGateway, type LlmGateway } from './llm.ts'
import { createRetriever, type Retriever } from './retrieval.ts'
import { createChatService, type ChatService } from './chat.ts'
import { createGraphService } from './graph.ts'
import type { AiServicesApi, ResolvedConfig, StoreApi } from '../contracts.ts'
import type { Logger } from '../host-services.ts'

/** Dependencies injected by the Host composition root. */
export interface AiServicesDeps {
  /** Library store (`StoreApi`): documents, aux JSON, annotations, preferences. */
  store: StoreApi
  /** Resolved Host configuration (`config.ai` drives every engine budget). */
  config: ResolvedConfig
  logger?: Logger | undefined
  /** `() => ctx.get('llm')` — read lazily on every model call. */
  getLlm?: (() => unknown) | undefined
  /** `() => ctx.get('agentDefaultModel')` — default model route. */
  getDefaultModel?: (() => unknown) | undefined
  /** `() => ctx.get('tokenMeter')` — context-budget estimation when mounted. */
  getTokenMeter?: (() => unknown) | undefined
  /** Host version string reported by `AiServicesApi.version`. */
  hostVersion?: string | undefined
}

/** The lazy AI bundle returned by {@link createAiServices}. */
export interface AiServicesBundle {
  /** Build (or return the memoized) engine bundle; rejects when creation fails. */
  ensure: () => Promise<AiServicesApi>
  /** The bundle if it was already built, otherwise `undefined`. */
  peek: () => AiServicesApi | undefined
}

/** Build the concrete engine bundle once. */
function buildBundle(deps: AiServicesDeps, bundle: { llm?: LlmGateway; retriever?: Retriever }): AiServicesApi {
  const logger = deps.logger ?? {}
  const llm = createLlmGateway({
    getLlm: deps.getLlm,
    getDefaultModel: deps.getDefaultModel,
    getTokenMeter: deps.getTokenMeter,
    config: deps.config,
    logger,
  })
  const retriever = createRetriever({ logger })
  let graph: AiServicesApi['graph'] | null = null
  try {
    graph = createGraphService({
      llm,
      store: deps.store,
      config: deps.config,
      logger,
      readMarkdown: (documentId) => deps.store.readMarkdown(documentId),
    })
  } catch (error) {
    // The knowledge-graph engine is optional: Q&A still works without it.
    logger.warn?.(
      '[dsh-litnotes] knowledge-graph engine unavailable: %s',
      (error as Error)?.message ?? error,
    )
    graph = null
  }
  const chat: ChatService = createChatService({
    llm,
    retriever,
    store: deps.store,
    config: deps.config,
    logger,
    loadAnnotations: (documentId) => deps.store.loadAnnotations(documentId),
    saveAnnotations: (documentId, data) => deps.store.saveAnnotations(documentId, data),
    mutateAnnotations: (documentId, mutate) => deps.store.mutateAnnotations(documentId, mutate),
    mutateAux: (documentId, name, mutate) => deps.store.mutateAux(documentId, name, mutate),
    onGraphDelta: async (documentId, delta) => {
      if (graph === null) return null
      try {
        return await graph.mergeDocKnowledge(documentId, delta)
      } catch (error) {
        logger.warn?.(
          '[dsh-litnotes] cannot merge Q&A knowledge into the graph: %s',
          (error as Error)?.message ?? error,
        )
        return null
      }
    },
  })
  bundle.llm = llm
  bundle.retriever = retriever
  return {
    llm,
    retriever,
    chat,
    graph: graph ?? emptyGraphService(),
    available: llm.available() === true,
    version: deps.hostVersion ?? '',
  }
}

/** A graph service that reports every capability as unavailable. */
function emptyGraphService(): AiServicesApi['graph'] {
  const unavailable = { code: 'llm-unavailable', message: '知识图谱服务不可用（Knowledge-graph service unavailable）' }
  const abortFrame = async function* (): AsyncGenerator<{ type: 'error'; code: string; message: string }> {
    yield { type: 'error', ...unavailable }
  }
  return {
    docGraph: async () => {
      throw new Error(unavailable.message)
    },
    buildDocGraph: () => abortFrame(),
    mergeDocKnowledge: async () => {
      throw new Error(unavailable.message)
    },
    updateDocGraph: async () => {
      throw new Error(unavailable.message)
    },
    libraryGraph: async () => {
      throw new Error(unavailable.message)
    },
    rebuildLibraryGraph: () => abortFrame(),
  }
}

/**
 * Create the lazy AI service bundle.
 *
 * @param deps - Host store/configuration plus the optional service getters.
 * @returns `ensure()` builds the bundle once (rejects when the engines cannot
 *   be created); `peek()` exposes it only after a successful build.
 */
export function createAiServices(deps: AiServicesDeps): AiServicesBundle {
  let bundle: AiServicesApi | null = null
  let bundlePromise: Promise<AiServicesApi> | null = null
  const scratch: { llm?: LlmGateway; retriever?: Retriever } = {}

  async function build(): Promise<AiServicesApi> {
    const value = buildBundle(deps, scratch)
    bundle = value
    return value
  }

  async function ensure(): Promise<AiServicesApi> {
    if (bundle !== null) return bundle
    if (bundlePromise === null) {
      bundlePromise = build().then(
        (value) => value,
        (error: unknown) => {
          bundlePromise = null
          throw error
        },
      )
    }
    return bundlePromise
  }

  return {
    ensure,
    peek: () => bundle ?? undefined,
  }
}
