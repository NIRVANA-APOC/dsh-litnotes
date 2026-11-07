/**
 * AI service bundle for dsh-litnotes.
 *
 * Lazily imports the engine modules so the plugin still boots (and the classic
 * reading desk keeps working) while a deployment has no LLM service or while
 * the AI modules are being installed. One `ensure()` call builds the gateway,
 * retriever, graph service and grounded chat service and memoizes them.
 *
 * Contract: docs/AI-SPEC.md §3.
 *
 * @module lib/ai/index
 */
import { parseMarkdown, plainTextOfBlock } from '../../ui/markdown.js'

/**
 * Revision suffix for the lazily imported engine modules. HMR can replace this
 * entry module, but Node caches dynamically imported modules for the process
 * lifetime; bump this revision whenever `lib/ai/*.js` changes so the next
 * bundle build imports a fresh URL instead of the cached old module.
 */
const AI_MODULE_REVISION = '5'

/** Cache-busted specifier for one lazily imported engine module. */
const engineModule = (file) => `./${file}?rev=${AI_MODULE_REVISION}`

/**
 * Create the lazy AI service bundle.
 *
 * @param {{
 *   store: ReturnType<import('../store.js').createStore>,
 *   config: Record<string, any>,
 *   logger?: Record<string, Function>,
 *   getLlm?: () => any,
 *   getDefaultModel?: () => any,
 *   hostVersion?: string,
 * }} deps - host services and configuration.
 * @returns {{ ensure: () => Promise<object>, peek: () => object | null }}
 *   `ensure()` resolves the bundle (throws `ai-unavailable` when the engine
 *   cannot load); `peek()` returns it if already built.
 */
export function createAiServices({ store, config, logger, getLlm, getDefaultModel, hostVersion } = {}) {
  let bundle = null
  let bundlePromise = null

  const loggerRef = logger ?? {}

  async function build() {
    const [llmModule, retrievalModule, chatModule, aspectsModule] = await Promise.all([
      import(engineModule('llm.js')),
      import(engineModule('retrieval.js')),
      import(engineModule('chat.js')),
      import(engineModule('aspects.js')),
    ])
    const llm = llmModule.createLlmGateway({
      getLlm,
      getDefaultModel,
      config,
      logger: loggerRef,
    })
    const retriever = retrievalModule.createRetriever({
      parseMarkdown,
      plainTextOfBlock,
      logger: loggerRef,
    })
    let graph = null
    try {
      const graphModule = await import(engineModule('graph.js'))
      graph = graphModule.createGraphService({
        llm,
        store,
        config,
        logger: loggerRef,
        readMarkdown: (id) => store.readMarkdown(id),
      })
    } catch (error) {
      // The knowledge-graph engine is optional: Q&A still works without it.
      loggerRef.warn?.('[dsh-litnotes] knowledge-graph engine unavailable: %s', error?.message ?? error)
      graph = null
    }
    const chat = chatModule.createChatService({
      llm,
      retriever,
      store,
      config,
      logger: loggerRef,
      loadAnnotations: (id) => store.loadAnnotations(id),
      saveAnnotations: (id, data) => store.saveAnnotations(id, data),
      onGraphDelta: async (documentId, delta) => {
        if (graph === null || typeof graph.mergeDocKnowledge !== 'function') return null
        try {
          return await graph.mergeDocKnowledge(documentId, delta)
        } catch (error) {
          loggerRef.warn?.('[dsh-litnotes] cannot merge Q&A knowledge into the graph: %s', error?.message ?? error)
          return null
        }
      },
    })
    return {
      llm,
      retriever,
      chat,
      graph,
      aspects: aspectsModule,
      available: llm.available() === true,
      version: hostVersion ?? '',
    }
  }

  async function ensure() {
    if (bundle !== null) return bundle
    if (bundlePromise === null) {
      bundlePromise = build().then((value) => {
        bundle = value
        return value
      })
      bundlePromise.catch(() => {
        bundlePromise = null
      })
    }
    return bundlePromise
  }

  return {
    ensure,
    peek: () => bundle,
  }
}
