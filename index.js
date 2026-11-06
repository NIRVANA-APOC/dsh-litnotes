/**
 * dsh-litnotes — Host half.
 *
 * Wires the on-disk literature library (store), the MinerU parse manager, the
 * operation service shared by the HTTP API and the agent tool, the web routes,
 * and the `mineru` tool. The Client half is `lib/client.js` (generated from
 * ui/** by scripts/build-client.mjs) and reaches this half through the routes
 * registered here.
 *
 * Contract: docs/ARCH.md and docs/HOST-INTERFACES.md.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getToken, resolveConfig } from './lib/config.js'
import { createStore } from './lib/store.js'
import { createParseManager } from './lib/parse-manager.js'
import { createService } from './lib/service.js'
import { registerRoutes } from './lib/routes.js'
import { registerAgentTool } from './lib/agent-tool.js'

/** Plugin identity for Cordis rows. */
export const name = 'dsh-litnotes'

/** Hard dependencies. Optional services (tools, credentials, translator, llm,
 * agentDefaultModel) are read with ctx.get() so profiles without them still
 * load the library, only losing the corresponding capability. */
export const inject = ['webServer', 'connection']

const PACKAGE = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'))
const HOST_VERSION = `${PACKAGE.version}+host`

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {Record<string, unknown>} config - Raw row config (see docs/ARCH.md §8).
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const resolved = resolveConfig(config)
  const credentials = ctx.get('credentials')

  const store = createStore({ dataDir: resolved.dataDir, logger })
  const manager = createParseManager({
    store,
    config: resolved,
    logger,
    getToken: () => getToken(credentials),
    fetchImpl: globalThis.fetch,
  })
  const service = createService({
    store,
    manager,
    config: resolved,
    logger,
    hostVersion: HOST_VERSION,
    getCredentials: () => credentials,
    getTranslator: () => ctx.get('translator'),
    getLlm: () => ctx.get('llm'),
    getDefaultModel: () => {
      try {
        return ctx.get('agentDefaultModel')?.currentSelection?.()
      } catch {
        return undefined
      }
    },
  })

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
      .catch((error) => {
        logger.error?.('[dsh-litnotes] library initialization failed:', error)
      })
    return () => {
      disposed = true
      void ready
        .then(() => Promise.allSettled([manager.dispose(), store.dispose()]))
        .catch(() => {})
    }
  }, 'dsh-litnotes: library boot')

  ctx.effect(() => registerRoutes({ ctx, service, store, config: resolved, logger }),
    'dsh-litnotes: web routes')
  ctx.effect(() => registerAgentTool({ ctx, service, config: resolved, logger }),
    'dsh-litnotes: mineru agent tool')

  logger.info?.('[dsh-litnotes] mounted (data=%s, api=%s)', resolved.dataDir, resolved.apiBase)
}

// reload marker: 1793968084
