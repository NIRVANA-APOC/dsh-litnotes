/**
 * Cross-half integration test: the document knowledge-graph build stream over
 * the real `/dsh-litnotes/api/graph.build` NDJSON route.
 *
 * Builds the real Host bundle, mounts it on a fake Cordis context with a
 * scripted `llm` service (one extraction call + one summary call), seeds a
 * parsed document on a temp data dir, then asserts:
 *  - the real progress frame sequence (reading → extracting → merging → done),
 *  - one final `graph` frame with the extracted nodes/edges and the summary,
 *  - `graph.json` persisted through the real store,
 *  - client cancellation mid-stream: no graph frame is delivered and the
 *    persisted `graph.json` stays a complete, valid previous graph (no partial
 *    write).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LlmGenerateOptions, LlmStreamChunk } from '../../src/host/host-services.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { createStore } from '../../src/host/store/index.ts'
import { appendPageMarks, parseMarkdown } from '../../src/shared/markdown/parse.ts'
import type { ContentListEntry } from '../../src/shared/model.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HOST_ARTIFACT = join(ROOT, 'index.js')

/** The parsed paper markdown. */
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

/** Content list giving each block a page index. */
const PAPER_CONTENT_LIST: ContentListEntry[] = PAPER_MARKDOWN.split('\n\n').map((text, index) => ({
  type: 'text',
  text: text.replace(/^#+\s*/, ''),
  page_idx: index < 2 ? 0 : 1,
}))

/** The citation block key/page used by the scripted graph node. */
function resolveBlockKey(): string {
  const model = appendPageMarks(parseMarkdown(PAPER_MARKDOWN), PAPER_CONTENT_LIST)
  const block = model.blocks.find(
    (entry) => entry.kind !== 'page' && entry.plainText.includes('The router selects the top-2 experts'),
  )
  if (block === undefined) throw new Error('graph fixture: block not found')
  return block.key
}

const BLOCK_KEY = resolveBlockKey()

/** Scripted graph extraction payload (fenced `litnotes-graph`). */
const GRAPH_ANSWER = [
  '```litnotes-graph',
  JSON.stringify({
    nodes: [
      {
        type: 'method',
        label: 'Sparse routing',
        summary: 'Routes each token to a small set of experts.',
        blockKeys: [BLOCK_KEY],
        aspect: 'method',
      },
    ],
    edges: [{ from: 'Sparse routing', to: 'top-2 experts', type: 'uses' }],
  }),
  '```',
].join('\n')

/** Scripted graph summary payload (fenced `litnotes-summary`). */
const SUMMARY_ANSWER = [
  '```litnotes-summary',
  JSON.stringify({
    overview: 'This paper studies sparse expert routing for retrieval.',
    tldr: ['Sparse routing matches dense retrieval at a third of the compute.'],
    glossary: [{ term: 'Sparse routing', definition: 'Activating only a few experts per token.' }],
  }),
  '```',
].join('\n')

// ---------------------------------------------------------------------------
// Fake Host context doubles
// ---------------------------------------------------------------------------

/** One registered route (only the shapes this plugin uses). */
interface RegisteredRoute {
  kind: 'exact' | 'prefix' | 'resource'
  path: string
  handler?: (req: FakeRequest, res: FakeResponse) => void | Promise<void>
}

/** Fake `llm` Host service: scripts the extraction and summary completions. */
class FakeLlmService {
  readonly calls: Array<'extraction' | 'summary'> = []
  private readonly extractionAnswer: string
  private readonly summaryAnswer: string

  constructor(extractionAnswer: string, summaryAnswer: string) {
    this.extractionAnswer = extractionAnswer
    this.summaryAnswer = summaryAnswer
  }

  stream(options: LlmGenerateOptions): AsyncIterable<LlmStreamChunk> {
    const system = typeof options.system === 'string' ? options.system : ''
    const kind = system.includes('litnotes-graph') ? 'extraction' : 'summary'
    this.calls.push(kind)
    const raw = kind === 'extraction' ? this.extractionAnswer : this.summaryAnswer
    return FakeLlmService.chunks(raw)
  }

  private static async *chunks(raw: string): AsyncGenerator<LlmStreamChunk> {
    const size = 41
    for (let index = 0; index < raw.length; index += size) {
      yield { type: 'text-delta', text: raw.slice(index, index + size) }
    }
    yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 32 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Minimal request double: async-iterable body plus emittable socket events. */
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
    this.chunks = [Buffer.from(body, 'utf8')]
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

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

/** Minimal NDJSON-capturing response double with an optional per-frame hook. */
class FakeResponse {
  statusCode = 200
  readonly headers: Record<string, string | number> = {}
  body = ''
  headersSent = false
  writableEnded = false
  frameCount = 0
  /** Called after each frame is written (used to simulate a client disconnect). */
  onFrame: (() => void) | undefined

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
    this.frameCount += 1
    this.onFrame?.()
    return true
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.write(chunk)
    this.headersSent = true
    this.writableEnded = true
  }
}

/** One NDJSON frame. */
type StreamFrame = Record<string, unknown> & { type: string }

/** Parse one NDJSON body into frames. */
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

/** Everything one mounted plugin instance exposes to this test. */
interface MountedPlugin {
  ctx: unknown
  routes: RegisteredRoute[]
  fakeLlm: FakeLlmService
}

/** Fake Cordis context that mounts the built plugin with the scripted LLM. */
function mountPlugin(fakeLlm: FakeLlmService): MountedPlugin {
  const routes: RegisteredRoute[] = []
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: (serviceName: string) => {
      if (serviceName === 'llm') return fakeLlm
      if (serviceName === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      }
      if (serviceName === 'tools') return { register: () => () => {} }
      return undefined
    },
    webServer: {
      register: (route: RegisteredRoute) => {
        routes.push(route)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
  }
  return { ctx, routes, fakeLlm }
}

/** Latest mtime of any file under `src/host/**`. */
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
    const refreshed = existsSync(HOST_ARTIFACT) && statSync(HOST_ARTIFACT).mtimeMs > artifactMtime
    if (!refreshed) throw error
  }
}

/** Import the freshly built Host bundle and call its `apply`. */
async function applyPlugin(dataDir: string, fakeLlm: FakeLlmService): Promise<MountedPlugin> {
  const mounted = mountPlugin(fakeLlm)
  const moduleUrl = `${pathToFileURL(HOST_ARTIFACT).href}?mtime=${statSync(HOST_ARTIFACT).mtimeMs}`
  const module = (await import(moduleUrl)) as {
    apply: (ctx: unknown, config?: Record<string, unknown>) => void
  }
  module.apply(mounted.ctx, { dataDir, apiBase: 'https://api.invalid', pollIntervalMs: 10 })
  return mounted
}

/** Seed one parsed document on disk. */
async function seedDocument(dataDir: string): Promise<string> {
  const config = resolveConfig({ dataDir })
  const store = createStore({ dataDir: config.dataDir, logger: { info: () => {}, warn: () => {}, error: () => {} } })
  await store.init()
  try {
    const documentId = '22222222-3333-4444-8555-666666666666'
    const tempPath = store.newTempPath(documentId)
    await writeFile(tempPath, Buffer.from('%PDF-1.4 graph fixture\n%%EOF\n'))
    await store.createFromFile({
      id: documentId,
      tempPath,
      originalName: 'graph-paper.pdf',
      title: 'Sparse Expert Routing for Efficient Retrieval',
    })
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
    return documentId
  } finally {
    await store.dispose()
  }
}

/** Stream the graph.build route; `onFrame` lets a test simulate a disconnect. */
async function callGraphBuild(
  mounted: MountedPlugin,
  documentId: string,
  options: { force?: boolean; onFrame?: () => void } = {},
): Promise<StreamFrame[]> {
  const route = mounted.routes.find((entry) => entry.path === '/dsh-litnotes/api/graph.build')
  if (route?.handler === undefined) throw new Error('graph.build route not registered')
  const request = new FakeRequest(
    'POST',
    '/dsh-litnotes/api/graph.build',
    JSON.stringify({ documentId, force: options.force === true }),
  )
  const response = new FakeResponse()
  response.onFrame = options.onFrame
  await route.handler(request as never, response as never)
  expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
  return framesOf(response.body)
}

/** Read and parse a document's graph.json. */
function readGraphFile(dataDir: string, documentId: string): { nodes: Array<{ label: string }>; overview: string } {
  const parsed: unknown = JSON.parse(readFileSync(join(dataDir, 'documents', documentId, 'graph.json'), 'utf8'))
  return parsed as { nodes: Array<{ label: string }>; overview: string }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-litnotes-graph-integration-'))
const DATA_DIR = join(tempRoot, 'data')
let mounted: MountedPlugin
let documentId = ''

beforeAll(async () => {
  ensureHostBundle()
  documentId = await seedDocument(DATA_DIR)
  mounted = await applyPlugin(DATA_DIR, new FakeLlmService(GRAPH_ANSWER, SUMMARY_ANSWER))
}, 120_000)

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('knowledge-graph build stream over the real HTTP route', () => {
  it('streams progress → graph and persists graph.json', async () => {
    const frames = await callGraphBuild(mounted, documentId, { force: true })
    // Progress first, one graph frame, no error; done phase is the last progress.
    expect(frames.length).toBeGreaterThanOrEqual(4)
    expect(frames.every((frame) => frame.type === 'progress' || frame.type === 'graph')).toBe(true)
    expect(frames.filter((frame) => frame.type === 'graph')).toHaveLength(1)
    expect(frames.at(-1)?.type).toBe('graph')

    const phases = frames.filter((frame) => frame.type === 'progress').map((frame) => frame.phase)
    expect(phases[0]).toBe('reading')
    expect(phases).toContain('extracting')
    expect(phases).toContain('merging')
    expect(phases.indexOf('extracting')).toBeLessThan(phases.indexOf('merging'))
    expect(phases.indexOf('merging')).toBeLessThan(phases.lastIndexOf('done'))
    const extracting = frames.find((frame) => frame.type === 'progress' && frame.phase === 'extracting')
    expect(extracting?.done).toBe(1)
    expect(extracting?.total).toBe(1)

    // The graph frame carries the extracted nodes/edges plus the summary.
    const graph = frames.find((frame) => frame.type === 'graph')?.graph as Record<string, unknown> | undefined
    expect(graph).toBeDefined()
    const nodes = (graph?.nodes ?? []) as Array<Record<string, unknown>>
    expect(nodes.some((node) => node.label === 'Sparse routing')).toBe(true)
    expect(nodes.some((node) => node.label === 'top-2 experts')).toBe(true)
    expect(nodes.length).toBeGreaterThanOrEqual(2)
    const edges = (graph?.edges ?? []) as Array<Record<string, unknown>>
    expect(edges.length).toBeGreaterThanOrEqual(1)
    expect(String(graph?.overview)).toContain('sparse expert routing')
    expect(graph?.stats).toMatchObject({ nodes: nodes.length })
    expect(graph?.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
    // Two model calls: chunk extraction then summary.
    expect(mounted.fakeLlm.calls).toEqual(['extraction', 'summary'])

    // Persisted through the real store.
    expect(existsSync(join(DATA_DIR, 'documents', documentId, 'graph.json'))).toBe(true)
    const onDisk = readGraphFile(DATA_DIR, documentId)
    expect(onDisk.nodes.some((node) => node.label === 'Sparse routing')).toBe(true)
    expect(onDisk.overview).toContain('sparse expert routing')
  })

  it('client cancellation mid-stream leaves the previous graph.json intact', async () => {
    const before = readGraphFile(DATA_DIR, documentId)
    expect(before.nodes.length).toBeGreaterThanOrEqual(2)

    // Abort after the first written frame: the route stops writing frames and
    // the builder never reaches its atomic graph.json write.
    let request: FakeRequest | undefined
    const mountedForCancel = mountPlugin(new FakeLlmService(GRAPH_ANSWER, SUMMARY_ANSWER))
    const moduleUrl = `${pathToFileURL(HOST_ARTIFACT).href}?mtime=${statSync(HOST_ARTIFACT).mtimeMs}`
    const module = (await import(moduleUrl)) as {
      apply: (ctx: unknown, config?: Record<string, unknown>) => void
    }
    module.apply(mountedForCancel.ctx, { dataDir: DATA_DIR, apiBase: 'https://api.invalid', pollIntervalMs: 10 })
    const route = mountedForCancel.routes.find((entry) => entry.path === '/dsh-litnotes/api/graph.build')
    if (route?.handler === undefined) throw new Error('graph.build route not registered')
    request = new FakeRequest(
      'POST',
      '/dsh-litnotes/api/graph.build',
      JSON.stringify({ documentId, force: true }),
    )
    const response = new FakeResponse()
    response.onFrame = () => {
      if (response.frameCount === 1) request?.emit('close')
    }
    await route.handler(request as never, response as never)
    const frames = framesOf(response.body)
    // The stream stopped at the client disconnect: no graph frame was delivered.
    expect(frames.some((frame) => frame.type === 'graph')).toBe(false)
    expect(frames.length).toBeLessThanOrEqual(2)

    // The old graph.json is untouched and still valid (no partial write).
    const after = readGraphFile(DATA_DIR, documentId)
    expect(after.nodes.map((node) => node.label)).toEqual(before.nodes.map((node) => node.label))
    expect(after.overview).toBe(before.overview)
  })
})
