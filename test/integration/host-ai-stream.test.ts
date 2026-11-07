/**
 * Cross-half integration test: the grounded AI stream over the real HTTP routes.
 *
 * Builds the real Host bundle (`index.js`), mounts it on a fake Cordis context
 * with a scripted `llm` service + `agentDefaultModel`, seeds a synthetic parsed
 * document on disk (temp data dir, no user data, no network), then drives the
 * real `/dsh-litnotes/api/chat` NDJSON route end-to-end:
 *
 *   start → deltas (fence never leaked) → phase(entailment) → answer
 *   (verified citation + AI annotation + entailment summary) → usage → done
 *
 * and asserts the side effects on disk (`annotations.json` AI annotation with
 * aspect/provenance, `chat.json` with both turn messages) plus `chat.history`.
 * A second case proves a model failure maps to one NDJSON `error` frame.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/host/config.ts'
import type {
  LlmGenerateOptions,
  LlmStreamChunk,
} from '../../src/host/host-services.ts'
import { createStore } from '../../src/host/store/index.ts'
import { appendPageMarks, parseMarkdown } from '../../src/shared/markdown/parse.ts'
import type {
  Annotation,
  ChatMessage,
  Citation,
  ContentListEntry,
  EntailmentSummary,
} from '../../src/shared/model.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HOST_ARTIFACT = join(ROOT, 'index.js')

// ---------------------------------------------------------------------------
// Synthetic parsed document (written by the test, not user data)
// ---------------------------------------------------------------------------

/** The parsed paper markdown used by every case. */
const PAPER_MARKDOWN = [
  '# Sparse Expert Routing for Efficient Retrieval',
  '',
  'Sparse expert routing activates only a small number of experts for each token.',
  '',
  '## Routing Method',
  '',
  'The router selects the top-2 experts for every token and gates their outputs.',
  '',
  '## Results',
  '',
  'Sparse routing matches dense retrieval quality at a third of the compute.',
  '',
].join('\n')

/** Content list giving each block a page index (page-mark alignment). */
const PAPER_CONTENT_LIST: ContentListEntry[] = PAPER_MARKDOWN.split('\n\n').map((text, index) => ({
  type: 'text',
  text: text.replace(/^#+\s*/, ''),
  page_idx: index < 2 ? 0 : 1,
}))

/** The quoted sentence used by the scripted citation (verbatim from the paper). */
const CITATION_QUOTE = 'The router selects the top-2 experts for every token and gates their outputs.'

/** Visible answer markdown (the fence must never appear in streamed deltas). */
const ANSWER_VISIBLE = `Sparse routing activates only a few experts per token, and the router picks the top two [1].`

/** Entailment second-pass output. */
const ENTAILMENT_RAW = [
  '```litnotes-entailment',
  '{"results":[{"index":1,"verdict":"supported","reason":"The quote states the router selects the top-2 experts."}]}',
  '```',
].join('\n')

/** One parsed block coordinate used by the scripted citation. */
interface QuoteCoordinate {
  blockKey: string
  quote: string
}

/** Resolve the citation block key/offsets from the shared parser (same model the Host uses). */
function resolveCitation(): { coordinate: QuoteCoordinate; start: number; end: number } {
  const model = appendPageMarks(parseMarkdown(PAPER_MARKDOWN), PAPER_CONTENT_LIST)
  const block = model.blocks.find(
    (entry) => entry.kind !== 'page' && entry.plainText.includes(CITATION_QUOTE),
  )
  if (block === undefined) throw new Error('integration fixture: citation block not found')
  const start = block.plainText.indexOf(CITATION_QUOTE)
  return {
    coordinate: { blockKey: block.key, quote: CITATION_QUOTE },
    start,
    end: start + CITATION_QUOTE.length,
  }
}

/** Build the scripted model answer (visible text + one `litnotes-json` fence). */
function scriptedAnswer(citation: QuoteCoordinate): string {
  const payload = {
    citations: [
      {
        index: 1,
        blockKey: citation.blockKey,
        quote: citation.quote,
        aspect: 'method',
        note: 'The router selects the top-2 experts for every token.',
      },
    ],
    knowledge: { nodes: [], edges: [] },
    followups: ['How are the gated outputs combined?'],
  }
  return `${ANSWER_VISIBLE}\n\n\`\`\`litnotes-json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
}

// ---------------------------------------------------------------------------
// Fake Host context doubles
// ---------------------------------------------------------------------------

/** One registered route (only the shapes this plugin uses). */
interface RegisteredRoute {
  kind: 'exact' | 'prefix' | 'resource'
  path: string
  handler?: (req: FakeRequest, res: FakeResponse) => void | Promise<void>
}

/** Minimal request double: async-iterable JSON body, no socket events. */
class FakeRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  private readonly chunks: Buffer[]
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(method: string, url: string, body: string) {
    this.method = method
    this.url = url
    this.headers = {
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json',
    }
    this.chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (const chunk of this.chunks) yield chunk
  }

  resume(): void {}

  on(event: string, listener: () => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  off(event: string, listener: () => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((entry) => entry !== listener),
    )
    return this
  }

  /** Fire one recorded event (used for client-disconnect coverage if needed). */
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

/** Minimal NDJSON-capturing response double. */
class FakeResponse {
  statusCode = 200
  readonly headers: Record<string, string | number> = {}
  body = ''
  headersSent = false
  writableEnded = false
  destroyed = false

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = value
    return this
  }

  flushHeaders(): void {
    this.headersSent = true
  }

  write(chunk: string | Buffer): boolean {
    this.headersSent = true
    this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    return true
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.write(chunk)
    this.headersSent = true
    this.writableEnded = true
  }

  json(): unknown {
    const parsed: unknown = JSON.parse(this.body)
    return parsed
  }
}

/** One NDJSON frame as received from a streaming route. */
type StreamFrame = Record<string, unknown> & { type: string }

/** Typed `answer` frame (the fields this test asserts). */
interface AnswerFrame extends StreamFrame {
  messageId: string
  markdown: string
  citations: Citation[]
  unverified: Citation[]
  followups: string[]
  annotationIds: string[]
  entailment: EntailmentSummary
}

/** Parse one NDJSON response body into frames (throws on malformed lines). */
function framesOf(body: string): StreamFrame[] {
  return body
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`stream frame is not an object: ${line}`)
      }
      return parsed as StreamFrame
    })
}

/** Require one frame of `type` (first occurrence). */
function frameOf<T extends StreamFrame>(frames: StreamFrame[], type: string): T {
  const frame = frames.find((entry) => entry.type === type)
  if (frame === undefined) throw new Error(`stream has no ${type} frame`)
  return frame as T
}

/** Fake `llm` Host service: scripts the chat answer, the entailment pass and a failure mode. */
class FakeLlmService {
  fail = false
  readonly purposes: string[] = []

  stream(options: LlmGenerateOptions): AsyncIterable<LlmStreamChunk> {
    if (this.fail) throw new Error('simulated host llm failure')
    // The gateway pins reasoning effort 'off' for the utility entailment pass,
    // which is how this double distinguishes the two scripted calls.
    const purpose = options.reasoningEffort === 'off' ? 'entailment' : 'chat'
    this.purposes.push(purpose)
    const raw = purpose === 'entailment' ? ENTAILMENT_RAW : this.answer
    return FakeLlmService.chunks(raw)
  }

  private readonly answer: string

  constructor(answer: string) {
    this.answer = answer
  }

  /** Yield one scripted completion as small text deltas plus usage/finish. */
  private static async *chunks(raw: string): AsyncGenerator<LlmStreamChunk> {
    const size = 23 // deliberately splits the fence marker across chunks sometimes
    for (let index = 0; index < raw.length; index += size) {
      yield { type: 'text-delta', text: raw.slice(index, index + size) }
    }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 48 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Everything one mounted plugin instance exposes to this test. */
interface MountedPlugin {
  ctx: unknown
  routes: RegisteredRoute[]
  fakeLlm: FakeLlmService
  effects: number
}

/** Fake Cordis context that mounts the built plugin with the scripted services. */
function mountPlugin(fakeLlm: FakeLlmService): MountedPlugin {
  const routes: RegisteredRoute[] = []
  let effects = 0
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    effect: (callback: () => (() => void) | void) => {
      effects += 1
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: (serviceName: string) => {
      if (serviceName === 'llm') return fakeLlm
      if (serviceName === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      }
      if (serviceName === 'tools') {
        return { register: () => () => {} }
      }
      return undefined
    },
    webServer: {
      register: (route: RegisteredRoute) => {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection: () => undefined,
    },
  }
  return { ctx, routes, fakeLlm, effects }
}

/** Import the freshly built Host bundle and call its `apply`. */
async function applyPlugin(dataDir: string, fakeLlm: FakeLlmService): Promise<MountedPlugin> {
  const mounted = mountPlugin(fakeLlm)
  const moduleUrl = `${pathToFileURL(HOST_ARTIFACT).href}?mtime=${statSync(HOST_ARTIFACT).mtimeMs}`
  const module = (await import(moduleUrl)) as {
    apply: (ctx: unknown, config?: Record<string, unknown>) => void
  }
  module.apply(mounted.ctx, {
    dataDir,
    apiBase: 'https://api.invalid',
    pollIntervalMs: 10,
    parseTimeoutMs: 5000,
  })
  return mounted
}

/** Latest mtime of any file under `src/host/**` (from index.ts down). */
function latestHostSourceMtime(): number {
  let latest = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.json'))) {
        latest = Math.max(latest, statSync(path).mtimeMs)
      }
    }
  }
  visit(join(ROOT, 'src', 'host'))
  return latest
}

/** Build the Host bundle unless an up-to-date artifact already exists. */
function ensureHostBundle(): void {
  const artifactMtime = existsSync(HOST_ARTIFACT) ? statSync(HOST_ARTIFACT).mtimeMs : 0
  if (artifactMtime > 0 && artifactMtime >= latestHostSourceMtime()) return
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.ts')], { cwd: ROOT, stdio: 'pipe' })
  } catch (error) {
    // The Host bundle is written before the Client half of the build; a failing
    // client build (another workstream's in-flight code) must not block this
    // host-only integration test as long as `index.js` was refreshed.
    const refreshed = existsSync(HOST_ARTIFACT) && statSync(HOST_ARTIFACT).mtimeMs > artifactMtime
    if (!refreshed) throw error
  }
}

/** Seed one parsed document (meta + parsed artifacts + empty annotations). */
async function seedParsedDocument(dataDir: string): Promise<{ documentId: string; citation: QuoteCoordinate }> {
  const config = resolveConfig({ dataDir })
  const store = createStore({ dataDir: config.dataDir, logger: { info: () => {}, warn: () => {}, error: () => {} } })
  await store.init()
  try {
    const documentId = '11111111-2222-4333-8444-555555555555'
    const tempPath = store.newTempPath(documentId)
    await writeFile(tempPath, Buffer.from('%PDF-1.4 integration fixture\n%%EOF\n'))
    await store.createFromFile({ id: documentId, tempPath, originalName: 'sparse-routing.pdf' })
    const parsedDir = store.parsedDir(documentId)
    await mkdir(parsedDir, { recursive: true })
    await writeFile(join(parsedDir, 'full.md'), PAPER_MARKDOWN)
    await writeFile(join(parsedDir, 'content_list.json'), JSON.stringify(PAPER_CONTENT_LIST, null, 2))
    const now = new Date().toISOString()
    await store.update(documentId, {
      status: 'parsed',
      error: null,
      parse: {
        engine: 'standard',
        provider: null,
        local: null,
        modelVersion: 'vlm',
        language: 'ch',
        options: { isOcr: false, enableFormula: true, enableTable: true, pageRanges: '' },
        phase: null,
        remoteState: null,
        taskId: null,
        batchId: null,
        startedAt: now,
        finishedAt: now,
        pages: 2,
        progress: { extracted: 2, total: 2 },
        hasContentList: true,
      },
    })
    await store.saveAnnotations(documentId, { items: [] })
    const { coordinate } = resolveCitation()
    return { documentId, citation: coordinate }
  } finally {
    await store.dispose()
  }
}

/** POST one JSON API method through the registered prefix route. */
async function callApi(
  mounted: MountedPlugin,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; envelope: Record<string, unknown> }> {
  const route = mounted.routes.find((entry) => entry.path === '/dsh-litnotes/api' && entry.kind === 'prefix')
  if (route?.handler === undefined) throw new Error('api prefix route not registered')
  const response = new FakeResponse()
  await route.handler(
    new FakeRequest('POST', `/dsh-litnotes/api/${method}`, JSON.stringify(payload)),
    response,
  )
  const envelope = response.json()
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('api response is not an envelope object')
  }
  return { status: response.statusCode, envelope: envelope as Record<string, unknown> }
}

/** Stream one NDJSON route by its exact path. */
async function callStream(
  mounted: MountedPlugin,
  path: string,
  payload: Record<string, unknown>,
): Promise<StreamFrame[]> {
  const route = mounted.routes.find((entry) => entry.path === path && entry.kind === 'exact')
  if (route?.handler === undefined) throw new Error(`stream route not registered: ${path}`)
  const response = new FakeResponse()
  await route.handler(new FakeRequest('POST', path, JSON.stringify(payload)), response)
  expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
  return framesOf(response.body)
}

/** Read and parse one JSON file under a document directory. */
function readDocumentJson<T>(dataDir: string, documentId: string, name: string): T {
  const parsed: unknown = JSON.parse(readFileSync(join(dataDir, 'documents', documentId, name), 'utf8'))
  return parsed as T
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-litnotes-ai-integration-'))
const DATA_DIR = join(tempRoot, 'data')
let mounted: MountedPlugin
let documentId = ''
let citation: QuoteCoordinate

beforeAll(async () => {
  ensureHostBundle()
  const seeded = await seedParsedDocument(DATA_DIR)
  documentId = seeded.documentId
  citation = seeded.citation
  const answer = scriptedAnswer(citation)
  mounted = await applyPlugin(DATA_DIR, new FakeLlmService(answer))
}, 120_000)

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('grounded AI stream over the real HTTP routes', () => {
  it('streams start → deltas → entailment phase → verified answer → usage → done', async () => {
    const frames = await callStream(mounted, '/dsh-litnotes/api/chat', {
      documentId,
      question: 'How does the router choose experts?',
    })
    // Frame order: start first, answer before usage/done, exactly one done.
    expect(frames[0]?.type).toBe('start')
    expect(frames.filter((frame) => frame.type === 'done')).toHaveLength(1)
    expect(frames[frames.length - 1]?.type).toBe('done')
    expect(frames.filter((frame) => frame.type === 'answer')).toHaveLength(1)

    const start = frameOf<StreamFrame & { messageId: string; model: { provider: string; model: string } }>(
      frames,
      'start',
    )
    expect(typeof start.messageId).toBe('string')
    expect(start.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })

    // Visible deltas concatenate to the answer markdown and never leak the fence.
    const deltas = frames.filter((frame) => frame.type === 'delta')
    expect(deltas.length).toBeGreaterThan(1)
    const streamed = deltas.map((frame) => String(frame.text ?? '')).join('')
    // The visible answer is streamed up to the fence; the trailing blank lines
    // stay on the wire but the persisted/answer frame markdown is trimmed.
    expect(streamed.trimEnd()).toBe(ANSWER_VISIBLE)
    expect(streamed).not.toContain('litnotes-json')
    expect(streamed).not.toContain('```')

    // The citation–claim entailment pass announced itself before the answer frame.
    const answerIndex = frames.findIndex((frame) => frame.type === 'answer')
    const phaseIndex = frames.findIndex((frame) => frame.type === 'phase')
    expect(phaseIndex).toBeGreaterThanOrEqual(0)
    expect(phaseIndex).toBeLessThan(answerIndex)
    expect(frames[phaseIndex]?.phase).toBe('entailment')

    const answer = frameOf<AnswerFrame>(frames, 'answer')
    expect(answer.markdown).toBe(ANSWER_VISIBLE)
    expect(answer.citations).toHaveLength(1)
    const cited = answer.citations[0]
    expect(cited).toMatchObject({
      index: 1,
      blockKey: citation.blockKey,
      quote: citation.quote,
      aspect: 'method',
      verified: true,
      entailment: 'supported',
    })
    expect(typeof cited?.start).toBe('number')
    expect(typeof cited?.end).toBe('number')
    expect((cited?.end ?? 0) - (cited?.start ?? 0)).toBe(CITATION_QUOTE.length)
    expect(answer.unverified).toEqual([])
    expect(answer.followups).toEqual(['How are the gated outputs combined?'])
    expect(answer.annotationIds).toHaveLength(1)
    expect(answer.entailment).toEqual({ checked: true, supported: 1, partial: 0, unsupported: 0 })

    // Two model calls: the answer stream, then the bounded entailment completion.
    expect(mounted.fakeLlm.purposes).toEqual(['chat', 'entailment'])

    const usage = frameOf<StreamFrame & { usage: { inputTokens: number; outputTokens: number } }>(frames, 'usage')
    expect(usage.usage).toEqual({ inputTokens: 120, outputTokens: 48 })
  })

  it('persists the AI aspect annotation and both chat messages on disk', async () => {
    const annotations = readDocumentJson<{ version: number; items: Annotation[] }>(
      DATA_DIR,
      documentId,
      'annotations.json',
    )
    expect(annotations.version).toBe(1)
    expect(annotations.items).toHaveLength(1)
    const annotation = annotations.items[0]
    expect(annotation).toMatchObject({
      origin: 'ai',
      aspect: 'method',
      blockKey: citation.blockKey,
      quote: citation.quote,
      color: 'sage',
      chatId: `doc:${documentId}`,
    })
    expect(typeof annotation?.messageId).toBe('string')
    expect(annotation?.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
    expect(typeof annotation?.id).toBe('string')

    const chat = readDocumentJson<{ version: number; messages: ChatMessage[] }>(DATA_DIR, documentId, 'chat.json')
    expect(chat.version).toBe(1)
    expect(chat.messages).toHaveLength(2)
    const userMessage = chat.messages.find((message) => message.role === 'user')
    const assistantMessage = chat.messages.find((message) => message.role === 'assistant')
    expect(userMessage?.question ?? userMessage?.answer).toBe('How does the router choose experts?')
    expect(assistantMessage?.answer).toBe(ANSWER_VISIBLE)
    expect(assistantMessage?.citations).toHaveLength(1)
    expect(assistantMessage?.annotationIds).toEqual([annotation?.id])

    // The reader-facing history route returns the same persisted turn.
    const history = await callApi(mounted, 'chat.history', { documentId })
    expect(history.status).toBe(200)
    expect(history.envelope.ok).toBe(true)
    const value = history.envelope.value as { messages: ChatMessage[] } | undefined
    expect(value?.messages).toHaveLength(2)
    expect(value?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('turns a model failure into one NDJSON error frame (no answer, no partial turn)', async () => {
    mounted.fakeLlm.fail = true
    try {
      const frames = await callStream(mounted, '/dsh-litnotes/api/chat', {
        documentId,
        question: 'Does a failing model produce a clean error?',
      })
      // `start` is emitted before the model call; the failure then yields one
      // error frame and no answer frame.
      expect(frames.map((frame) => frame.type)).toEqual(['start', 'error'])
      const error = frameOf<StreamFrame & { code: string; message: string }>(frames, 'error')
      expect(typeof error.code).toBe('string')
      expect(error.code.length).toBeGreaterThan(0)
      expect(typeof error.message).toBe('string')
      expect(frames.some((frame) => frame.type === 'answer')).toBe(false)

      // The failed turn wrote neither a new chat message nor a new annotation.
      const chat = readDocumentJson<{ messages: ChatMessage[] }>(DATA_DIR, documentId, 'chat.json')
      expect(chat.messages).toHaveLength(2)
      const annotations = readDocumentJson<{ items: Annotation[] }>(DATA_DIR, documentId, 'annotations.json')
      expect(annotations.items).toHaveLength(1)
    } finally {
      mounted.fakeLlm.fail = false
    }
  })
})
