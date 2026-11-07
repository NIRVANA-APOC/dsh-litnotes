/**
 * Unit tests for the MinerU client (`src/host/parse/mineru.ts`): parse-option
 * engine policy and precondition errors, API error mapping to friendly bilingual
 * messages, retry behaviour, request shapes and download caps.
 *
 * Ported from the frozen `test/unit/mineru.test.mjs`; all network access is
 * injected through `fetchImpl` so the suite runs fully offline.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ParseOptionContext } from '../../src/host/contracts.ts'
import type { MineruClient, MineruFetch, MineruMeta, MineruResponse } from '../../src/host/parse/mineru.ts'
import {
  MineruError,
  createMineruClient,
  describeMineruError,
  normalizeParseOptions,
} from '../../src/host/parse/mineru.ts'
import { WireError } from '../../src/host/wire.ts'

const TOKEN = 'unit-test-token-1234567890'

/** Build a `Response` with a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Standard context info for `normalizeParseOptions`. */
function ctxInfo(hasToken: boolean, maxUploadBytes = 200 * 1024 * 1024): ParseOptionContext {
  return {
    hasToken,
    maxUploadBytes,
    localSupported: false,
    localMaxBytes: 0,
    autoAllowAgentFallback: true,
  }
}

/** Metadata fixture for a PDF document. */
function pdfMeta(overrides: Partial<MineruMeta> = {}): MineruMeta {
  return { ext: '.pdf', originalName: 'paper.pdf', size: 1024, ...overrides }
}

/** Assert a thunk throws a `WireError` with the given code (and message pattern). */
function assertWireError(fn: () => unknown, code: string, pattern?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof WireError, `expected WireError, got ${String(error)}`)
    assert.equal(error.code, code)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

/** One captured fetch call. */
interface CapturedRequest {
  url: string
  init: RequestInit
}

/** Build an injected fetch that records calls; `handler` produces the response. */
function captureFetch(
  handler: (request: CapturedRequest) => MineruResponse | Promise<MineruResponse>,
): { fetchImpl: MineruFetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  const fetchImpl: MineruFetch = async (url, init) => {
    const request: CapturedRequest = { url, init }
    calls.push(request)
    return await handler(request)
  }
  return { fetchImpl, calls }
}

/** Read one request header regardless of the HeadersInit representation. */
function headerOf(request: CapturedRequest, name: string): string | undefined {
  const headers = request.init.headers
  if (headers === undefined) return undefined
  if (headers instanceof Headers) {
    const value = headers.get(name)
    return value === null ? undefined : value
  }
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === name)
    return entry?.[1]
  }
  return headers[name]
}

/** Parse the JSON body of one captured request. */
function jsonBodyOf(request: CapturedRequest): Record<string, unknown> {
  const body = request.init.body
  assert.equal(typeof body, 'string', 'expected a JSON string body')
  const parsed: unknown = JSON.parse(body as string) // narrow: asserted string above
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

/** Return a captured request's body bytes. */
function bodyBytesOf(request: CapturedRequest): Buffer {
  const body = request.init.body
  assert.ok(body instanceof Uint8Array, 'expected a byte body')
  return Buffer.from(body)
}

/** Create a client with an injected fetch and token (`null` means unconfigured). */
function clientWith(
  fetchImpl: MineruFetch,
  options: { token?: string | null; apiBase?: string } = {},
): MineruClient {
  const { token = TOKEN, apiBase = 'https://api.mineru.test' } = options
  return createMineruClient({
    getToken: async () => (token === null ? undefined : token),
    apiBase,
    fetchImpl,
    logger: { warn: () => {} },
  })
}

// ---------------------------------------------------------------------------
// normalizeParseOptions
// ---------------------------------------------------------------------------

test('engine auto picks agent without a token and standard with one', () => {
  const agent = normalizeParseOptions({}, pdfMeta(), ctxInfo(false))
  assert.equal(agent.engine, 'agent')
  assert.deepEqual(agent.params, {
    fileName: 'paper.pdf',
    language: 'ch',
    isOcr: false,
    enableFormula: true,
    enableTable: true,
    pageRanges: '',
  })

  const standard = normalizeParseOptions({}, pdfMeta(), ctxInfo(true))
  assert.equal(standard.engine, 'standard')
  assert.equal(standard.params.modelVersion, 'vlm')
  assert.equal(standard.params.enableTable, true)
})

test('explicit standard without a token fails with token-missing', () => {
  assertWireError(() => normalizeParseOptions({ engine: 'standard' }, pdfMeta(), ctxInfo(false)), 'token-missing', /Token/)
})

test('unsupported file types are rejected with unsupported-type / token-missing', () => {
  assertWireError(
    () => normalizeParseOptions({}, pdfMeta({ ext: '.txt', originalName: 'notes.txt' }), ctxInfo(true)),
    'unsupported-type',
  )
  // A standard-only type with no token cannot run on the agent API: point at token setup.
  assertWireError(
    () => normalizeParseOptions({}, pdfMeta({ ext: '.doc', originalName: 'paper.doc' }), ctxInfo(false)),
    'token-missing',
  )
  // .docx is accepted by the agent API.
  const docx = normalizeParseOptions({}, pdfMeta({ ext: '.docx', originalName: 'paper.docx' }), ctxInfo(false))
  assert.equal(docx.engine, 'agent')
})

test('size limits are enforced per engine and suggest the token for mid-size files', () => {
  const fifteenMb = { size: 15 * 1024 * 1024 }
  assertWireError(() => normalizeParseOptions({}, pdfMeta(fifteenMb), ctxInfo(false)), 'token-missing', /Token/)
  // With a token auto switches to standard, which allows up to 200 MB.
  const standard = normalizeParseOptions({}, pdfMeta(fifteenMb), ctxInfo(true))
  assert.equal(standard.engine, 'standard')
  // Explicit agent with 15 MB is too large regardless of the token.
  assertWireError(() => normalizeParseOptions({ engine: 'agent' }, pdfMeta(fifteenMb), ctxInfo(true)), 'too-large')
  const wayTooLarge = { size: 300 * 1024 * 1024 }
  assertWireError(() => normalizeParseOptions({}, pdfMeta(wayTooLarge), ctxInfo(true)), 'too-large')
  // Agent limit is measured against bytes.
  assertWireError(
    () => normalizeParseOptions({}, pdfMeta({ size: 11 * 1024 * 1024 }), ctxInfo(false)),
    'token-missing',
  )
})

test('parse options are validated and normalized', () => {
  const result = normalizeParseOptions(
    {
      engine: 'standard',
      modelVersion: 'pipeline',
      language: 'en',
      isOcr: true,
      enableFormula: false,
      enableTable: false,
      pageRanges: ' 2, 4-6 ',
      extraFormats: ['docx', 'html'],
    },
    pdfMeta(),
    ctxInfo(true),
  )
  assert.equal(result.engine, 'standard')
  assert.deepEqual(result.params, {
    fileName: 'paper.pdf',
    modelVersion: 'pipeline',
    language: 'en',
    isOcr: true,
    enableFormula: false,
    enableTable: false,
    pageRanges: '2,4-6',
    extraFormats: ['docx', 'html'],
  })

  assertWireError(() => normalizeParseOptions({ engine: 'wat' }, pdfMeta(), ctxInfo(true)), 'bad-request')
  assertWireError(
    () => normalizeParseOptions({ engine: 'standard', modelVersion: 'turbo' }, pdfMeta(), ctxInfo(true)),
    'bad-request',
  )
  assertWireError(
    () => normalizeParseOptions({ engine: 'standard', pageRanges: 'abc' }, pdfMeta(), ctxInfo(true)),
    'bad-request',
  )
  assertWireError(
    () => normalizeParseOptions({ engine: 'standard', pageRanges: '201' }, pdfMeta(), ctxInfo(true)),
    'bad-request',
  )
  assertWireError(
    () => normalizeParseOptions({ engine: 'agent', pageRanges: '25' }, pdfMeta(), ctxInfo(false)),
    'bad-request',
  )
  assertWireError(
    () => normalizeParseOptions({ engine: 'standard', extraFormats: ['exe'] }, pdfMeta(), ctxInfo(true)),
    'bad-request',
  )
})

test('html sources force the MinerU-HTML model version', () => {
  const result = normalizeParseOptions(
    { engine: 'standard' },
    pdfMeta({ ext: '.html', originalName: 'paper.html' }),
    ctxInfo(true),
  )
  assert.equal(result.params.modelVersion, 'MinerU-HTML')
})

test('non-object options are tolerated as defaults', () => {
  assert.equal(normalizeParseOptions(undefined, pdfMeta(), ctxInfo(true)).engine, 'standard')
  assert.equal(normalizeParseOptions(null, pdfMeta(), ctxInfo(true)).engine, 'standard')
  assert.equal(normalizeParseOptions([], pdfMeta(), ctxInfo(true)).engine, 'standard')
})

test('local engine policy honours the local provider and limits', () => {
  const plan = normalizeParseOptions(
    { engine: 'local', localProvider: 'builtin' },
    pdfMeta({ size: 1024 }),
    { ...ctxInfo(false), localSupported: true, localMaxBytes: 4096 },
  )
  assert.equal(plan.engine, 'local')
  assert.deepEqual(plan.params, { fileName: 'paper.pdf', language: 'ch', localProvider: 'builtin' })

  assertWireError(
    () => normalizeParseOptions({ engine: 'local' }, pdfMeta(), { ...ctxInfo(false), localSupported: false }),
    'local-unsupported',
  )
  assertWireError(
    () =>
      normalizeParseOptions({ engine: 'local' }, pdfMeta(), {
        ...ctxInfo(false),
        localSupported: false,
        localReason: 'builtin pdf extractor is unavailable',
      }),
    'local-missing-tool',
  )
  assertWireError(
    () =>
      normalizeParseOptions({ engine: 'local' }, pdfMeta({ size: 8192 }), {
        ...ctxInfo(false),
        localSupported: true,
        localMaxBytes: 4096,
      }),
    'too-large',
  )
})

// ---------------------------------------------------------------------------
// MineruError mapping
// ---------------------------------------------------------------------------

test('standard API codes map to friendly errors without leaking the token', async () => {
  const { fetchImpl } = captureFetch(() => jsonResponse({ code: 'A0202', msg: 'user token is invalid' }))
  const client = clientWith(fetchImpl)
  await assert.rejects(
    client.standardCreateBatch({ fileName: 'paper.pdf', dataId: 'uuid', options: {} }),
    (error: unknown) => {
      assert.ok(error instanceof MineruError)
      assert.equal(error.code, 'A0202')
      assert.match(error.message, /Token/)
      assert.equal(error.detail?.apiCode, 'A0202')
      assert.equal(error.message.includes(TOKEN), false)
      return true
    },
  )
})

test('upstream -60005 maps to the 200 MB limit message', async () => {
  const { fetchImpl } = captureFetch(() => jsonResponse({ code: -60005, msg: 'file too large' }))
  const client = clientWith(fetchImpl)
  await assert.rejects(
    client.standardCreateBatch({ fileName: 'paper.pdf', dataId: 'uuid', options: {} }),
    (error: unknown) => {
      assert.ok(error instanceof MineruError)
      assert.equal(error.code, '-60005')
      assert.match(error.message, /200 MB/)
      return true
    },
  )
})

test('a non-JSON HTTP failure is mapped by status', async () => {
  const { fetchImpl } = captureFetch(() => new Response('gateway error', { status: 401 }))
  const client = clientWith(fetchImpl)
  await assert.rejects(
    client.standardCreateBatch({ fileName: 'paper.pdf', dataId: 'uuid', options: {} }),
    (error: unknown) => {
      assert.ok(error instanceof MineruError)
      assert.equal(error.code, 'http-401')
      assert.equal(error.httpStatus, 401)
      assert.match(error.message, /Token/)
      return true
    },
  )
})

test('network errors are retried then reported as network-error', async () => {
  let calls = 0
  const { fetchImpl } = captureFetch(() => {
    calls += 1
    throw new TypeError('fetch failed')
  })
  const client = clientWith(fetchImpl)
  await assert.rejects(
    client.standardCreateBatch({ fileName: 'paper.pdf', dataId: 'uuid', options: {} }),
    (error: unknown) => {
      assert.ok(error instanceof MineruError)
      assert.equal(error.code, 'network-error')
      return true
    },
  )
  assert.equal(calls, 2, 'POST retries once')
})

test('putBytes retries once and sends raw bytes without a content-type header', async () => {
  const captured: CapturedRequest[] = []
  let calls = 0
  const fetchImpl: MineruFetch = async (url, init) => {
    calls += 1
    captured.push({ url, init })
    if (calls === 1) throw new TypeError('socket hang up')
    return new Response(null, { status: 200 })
  }
  const client = clientWith(fetchImpl)
  const result = await client.putBytes('https://upload.test/signed', Buffer.from('bytes'))
  assert.equal(result.status, 200)
  assert.equal(calls, 2)
  const second = captured[1]
  assert.ok(second !== undefined)
  assert.equal(headerOf(second, 'content-type'), undefined)
  assert.equal(second.init.method, 'PUT')
  assert.equal(bodyBytesOf(second).toString(), 'bytes')
})

test('describeMineruError handles WireError and unknown errors safely', () => {
  assert.equal(describeMineruError(new WireError('token-missing', '需要配置 Token')), '需要配置 Token')
  assert.match(describeMineruError(new Error('boom')), /解析失败/)
  assert.match(describeMineruError({ name: 'AbortError' }), /取消/)
})

test('describeMineruError appends a failed terminal state detail once', () => {
  const error = new MineruError('parse-failed', '解析失败', 0, { state: 'failed', msg: 'disk full' })
  assert.equal(describeMineruError(error), '解析失败（disk full）')
})

// ---------------------------------------------------------------------------
// Request shapes / polling payloads
// ---------------------------------------------------------------------------

test('standardCreateBatch sends the documented body and auth header', async () => {
  const { fetchImpl, calls } = captureFetch(() =>
    jsonResponse({ code: 0, data: { batch_id: 'batch-9', file_urls: ['https://upload.test/u1'] } }),
  )
  const client = clientWith(fetchImpl)
  const result = await client.standardCreateBatch({
    fileName: 'paper.pdf',
    dataId: 'doc-uuid',
    options: {
      modelVersion: 'vlm',
      language: 'en',
      isOcr: true,
      enableFormula: false,
      enableTable: true,
      pageRanges: '2,4-6',
      extraFormats: ['docx'],
    },
  })
  const request = calls[0]
  assert.ok(request !== undefined)
  assert.equal(request.url, 'https://api.mineru.test/api/v4/file-urls/batch')
  assert.equal(request.init.method, 'POST')
  assert.equal(headerOf(request, 'authorization'), `Bearer ${TOKEN}`)
  assert.equal(headerOf(request, 'content-type'), 'application/json')
  const body = jsonBodyOf(request)
  assert.deepEqual(body.files, [
    { name: 'paper.pdf', data_id: 'doc-uuid', is_ocr: true, page_ranges: '2,4-6' },
  ])
  assert.equal(body.model_version, 'vlm')
  assert.equal(body.language, 'en')
  assert.equal(body.enable_formula, false)
  assert.equal(body.enable_table, true)
  assert.deepEqual(body.extra_formats, ['docx'])
  assert.deepEqual(result, { batchId: 'batch-9', uploadUrl: 'https://upload.test/u1' })
})

test('standardBatchResult maps rows and progress', async () => {
  const { fetchImpl } = captureFetch(() =>
    jsonResponse({
      code: 0,
      data: {
        batch_id: 'batch-1',
        extract_result: [
          {
            data_id: 'doc-uuid',
            file_name: 'paper.pdf',
            state: 'RUNNING',
            extract_progress: { extracted_pages: 2, total_pages: 7 },
          },
          { data_id: 'other', file_name: 'x.pdf', state: 'done', full_zip_url: 'https://cdn.test/x.zip' },
        ],
      },
    }),
  )
  const client = clientWith(fetchImpl)
  const snapshot = await client.standardBatchResult('batch-1')
  assert.equal(snapshot.batchId, 'batch-1')
  assert.equal(snapshot.results.length, 2)
  assert.deepEqual(snapshot.results[0], {
    dataId: 'doc-uuid',
    fileName: 'paper.pdf',
    state: 'running',
    fullZipUrl: undefined,
    errMsg: '',
    progress: { extracted: 2, total: 7 },
  })
  assert.equal(snapshot.results[1]?.fullZipUrl, 'https://cdn.test/x.zip')
})

test('agentCreateTask and agentTaskResult use the token-free v1 endpoints', async () => {
  const { fetchImpl, calls } = captureFetch((request) => {
    if (request.url.endsWith('/api/v1/agent/parse/file')) {
      return jsonResponse({ code: 0, data: { task_id: 'task-1', file_url: 'https://upload.test/a1' } })
    }
    return jsonResponse({
      code: 0,
      data: {
        task_id: 'task-1',
        state: 'done',
        markdown_url: 'https://cdn.test/full.md',
        err_msg: '',
      },
    })
  })
  const client = clientWith(fetchImpl)
  const created = await client.agentCreateTask({
    fileName: 'paper.pdf',
    options: { language: 'en', isOcr: true, pageRanges: '1-3' },
  })
  assert.deepEqual(created, { taskId: 'task-1', uploadUrl: 'https://upload.test/a1' })
  const createRequest = calls[0]
  assert.ok(createRequest !== undefined)
  assert.deepEqual(jsonBodyOf(createRequest), {
    file_name: 'paper.pdf',
    language: 'en',
    enable_table: true,
    is_ocr: true,
    enable_formula: true,
    page_range: '1-3',
  })
  assert.equal(headerOf(createRequest, 'authorization'), undefined, 'agent API sends no token')
  const outcome = await client.agentTaskResult('task-1')
  assert.equal(outcome.state, 'done')
  assert.equal(outcome.markdownUrl, 'https://cdn.test/full.md')
  assert.equal(calls[1]?.url, 'https://api.mineru.test/api/v1/agent/parse/task-1')
})

test('token-missing is raised before any request when no token is configured', async () => {
  let calls = 0
  const fetchImpl: MineruFetch = async () => {
    calls += 1
    return jsonResponse({ code: 0, data: {} })
  }
  const client = clientWith(fetchImpl, { token: null })
  await assert.rejects(
    client.standardCreateBatch({ fileName: 'paper.pdf', dataId: 'uuid', options: {} }),
    (error: unknown) => {
      assert.ok(error instanceof MineruError)
      assert.equal(error.code, 'token-missing')
      return true
    },
  )
  assert.equal(calls, 0)
})

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

test('downloadBytes enforces the declared content-length cap', async () => {
  const { fetchImpl } = captureFetch(
    () =>
      new Response(Buffer.alloc(64), {
        status: 200,
        headers: { 'content-length': '64' },
      }),
  )
  const client = clientWith(fetchImpl)
  await assert.rejects(client.downloadBytes('https://cdn.test/big.zip', { maxBytes: 32 }), (error: unknown) => {
    assert.ok(error instanceof MineruError)
    assert.equal(error.code, 'too-large')
    return true
  })
})

test('downloadBytes streams and returns the body bytes', async () => {
  const payload = Buffer.from('hello markdown content')
  const { fetchImpl } = captureFetch(() => new Response(payload, { status: 200 }))
  const client = clientWith(fetchImpl)
  const buffer = await client.downloadBytes('https://cdn.test/full.md', { maxBytes: 1024 })
  assert.equal(buffer.toString(), 'hello markdown content')
})

test('downloadBytes maps HTTP failures', async () => {
  const { fetchImpl } = captureFetch(() => new Response('missing', { status: 404 }))
  const client = clientWith(fetchImpl)
  await assert.rejects(client.downloadBytes('https://cdn.test/full.md', {}), (error: unknown) => {
    assert.ok(error instanceof MineruError)
    assert.equal(error.code, 'http-404')
    return true
  })
})

test('downloadBytes caps streamed bodies that lie about their size', async () => {
  const { fetchImpl } = captureFetch(() => new Response(Buffer.alloc(128), { status: 200 }))
  const client = clientWith(fetchImpl)
  await assert.rejects(client.downloadBytes('https://cdn.test/large.zip', { maxBytes: 64 }), (error: unknown) => {
    assert.ok(error instanceof MineruError)
    assert.equal(error.code, 'too-large')
    return true
  })
})
