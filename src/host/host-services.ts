/**
 * Structural types for the DSH Host services this plugin consumes.
 *
 * The plugin deliberately keeps its own narrow contracts instead of importing
 * every `@deepseek-ai/*` package: the Host bundle ships without npm
 * dependencies, and these surfaces are what `cordis_inspect_query` reports for
 * the installed Harness. Optional services are always read through
 * `ctx.get(name)` and treated as absent when the profile does not mount them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** A cleanup callback returned by a registration. */
export type Disposer = () => void

/** Minimal leveled logger (the Cordis logger conforms). */
export interface Logger {
  debug?: (message: string, ...args: unknown[]) => void
  info?: (message: string, ...args: unknown[]) => void
  warn?: (message: string, ...args: unknown[]) => void
  error?: (message: string, ...args: unknown[]) => void
}

/** The plugin context surface both halves rely on. */
export interface PluginContext {
  logger?: Logger
  /** Register a resource owned by this plugin; the callback may return a disposer. */
  effect: (callback: () => Disposer | void, label?: string) => Disposer
  /** Read an optional service (never throws when the service is absent). */
  get: (name: string) => unknown
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** An API-key credential record (the shape `credentials.modifyRecord` stores). */
export interface ApiKeyRecord {
  kind: 'api-key'
  key: string
}

/** `ctx.get('credentials')` */
export interface CredentialsService {
  readRecord?: (key: string) => Promise<unknown>
  modifyRecord: (
    key: string,
    mutate: (current: unknown) => Promise<unknown> | unknown,
  ) => Promise<unknown>
  deleteRecord: (key: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Web server & connection fence
// ---------------------------------------------------------------------------

/** One route registration accepted by `ctx.webServer.register`. */
export type WebRoute =
  | {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }
  | {
      kind: 'resource'
      path: string
      resource: unknown
    }

/** `ctx.get('webServer')` */
export interface WebServerService {
  register: (route: WebRoute) => Disposer
  getOrigin?: () => string
}

/** `ctx.get('connection')` — the browser trust fence. */
export interface ConnectionService {
  requestRejection: (request: IncomingMessage) => number | undefined
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A JSON-schema object as accepted by the tools service. */
export type JsonSchema = Record<string, unknown>

/** One model-facing content block produced by a tool projection. */
export type ContentBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

/** The canonical output declaration every tool must carry. */
export interface ToolOutputDefinition {
  schema: JsonSchema
  render: (args: unknown, value: unknown) => ContentBlock[]
  presentationMeta?: (args: unknown, value: unknown) => unknown
}

/** One executable tool registration. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  output: ToolOutputDefinition
  execute: (args: Record<string, unknown>, exec?: { signal?: AbortSignal }) => Promise<unknown>
}

/** `ctx.get('tools')` */
export interface ToolsService {
  register: (definition: ToolDefinition) => Disposer
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** One user/assistant/system message passed to the LLM service. */
export interface LlmRequestMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string }>
}

/** Request options of `llm.stream`. */
export interface LlmGenerateOptions {
  provider: string
  model: string
  messages: LlmRequestMessage[]
  system?: string
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  signal?: AbortSignal
  purpose?: string
}

/** Raw chunk stream emitted by `llm.stream` (only the shapes this plugin uses). */
export type LlmStreamChunk =
  | { type: 'text-delta'; index?: number; text: string }
  | { type: 'text'; text: string }
  | { type: 'delta'; delta: string }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; [key: string]: unknown } }
  | { type: 'finish'; reason: { kind: string; failure?: unknown } }
  | { type: 'error'; failure?: { message?: string; code?: string } }

/** `ctx.get('llm')` */
export interface LlmService {
  stream: (options: LlmGenerateOptions) => AsyncIterable<LlmStreamChunk> | Promise<AsyncIterable<LlmStreamChunk>>
}

/** One resolved model route. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** `ctx.get('agentDefaultModel')` */
export interface AgentDefaultModelService {
  currentSelection: () => ModelSelection
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** One translator provider route (the Host translator's closed union). */
export type TranslationProviderId = 'google' | 'bing' | 'deepseek-account' | 'deepseek-official'

/** The request accepted by `translator.resolve`. */
export interface TranslationRequest {
  text: string
  targetLanguage: string
  sourceLanguage?: string
  provider?: TranslationProviderId
}

/** The resolved spec `translator.translate` consumes. */
export interface TranslationSpec {
  provider: TranslationProviderId | string
  text: string
  targetLanguage: string
  sourceLanguage: string
  sessionId?: unknown
}

/** `ctx.get('translator')` */
export interface TranslatorService {
  availableProviders: (signal?: AbortSignal) => Promise<readonly TranslationProviderId[]>
  resolve: (request: TranslationRequest) => TranslationSpec
  translate: (spec: TranslationSpec, signal?: AbortSignal) => Promise<string>
}

// ---------------------------------------------------------------------------
// Office → PDF (local T0.5 path)
// ---------------------------------------------------------------------------

/** Options accepted by `officeToPdf.convert`. */
export interface OfficeToPdfInput {
  extension: string
  priority?: 'background' | 'foreground'
  source: {
    key: string
    version: string
    bytes?: number
    read: (signal?: AbortSignal, reservedBytes?: number) => Promise<{ bytes: Uint8Array; version: string }>
  }
}

/** `ctx.get('officeToPdf')` */
export interface OfficeToPdfService {
  convert: (
    input: OfficeToPdfInput,
    signal?: AbortSignal,
  ) => Promise<{ pdf?: Uint8Array; missingFonts?: string[] }>
}

// ---------------------------------------------------------------------------
// Context governance (token estimation, prompt sections)
// ---------------------------------------------------------------------------

/** The session message shape `tokenMeter.estimateMessage` accepts (only what we build). */
export interface EstimableMessage {
  role: 'user' | 'assistant' | 'system'
  content: Array<{ type: 'text'; text: string }>
}

/** `ctx.get('tokenMeter')` */
export interface TokenMeterService {
  estimateMessage: (message: EstimableMessage) => number
}

/** One system-prompt section registration. */
export interface PromptSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
  complete?: boolean
}

/** `ctx.get('systemPrompt')` */
export interface SystemPromptService {
  section: (section: PromptSection) => Disposer
}

// ---------------------------------------------------------------------------
// The root context the plugin `apply()` receives
// ---------------------------------------------------------------------------

/** Everything the plugin needs from the Host context. */
export interface HostContext extends PluginContext {
  /** Hard dependencies (`inject`). */
  webServer: WebServerService
  connection: ConnectionService
  get: (name: string) => unknown
}
