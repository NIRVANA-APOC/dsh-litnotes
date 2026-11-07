/**
 * Client transport tests: JSON envelope handling, NDJSON frame splitting,
 * uploads and typed error mapping against a mocked `fetch`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createHostClient } from '../../src/client/api/client.ts'

const BASE = 'http://localhost:3080/'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('host client JSON calls', () => {
  it('returns the envelope value', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, value: { documents: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createHostClient(BASE)
    await expect(client.call('library.list', {})).resolves.toEqual({ documents: [] })
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(firstCall[0]).toBe('http://localhost:3080/dsh-litnotes/api/library.list')
    expect(JSON.parse(String(firstCall[1].body))).toEqual({})
  })

  it('throws a typed ApiError for an error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ok: false, error: { code: 'token-missing', message: '需要 Token（Token required）' } }, 401),
      ),
    )
    const client = createHostClient(BASE)
    const failure = client.call('status', {})
    await expect(failure).rejects.toBeInstanceOf(ApiError)
    await failure.catch((error: ApiError) => {
      expect(error.code).toBe('token-missing')
      expect(error.status).toBe(401)
      expect(error.isSetup).toBe(true)
    })
  })

  it('maps a non-JSON response to bad-response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 502 })))
    const client = createHostClient(BASE)
    await expect(client.call('status', {})).rejects.toMatchObject({ code: 'bad-response', status: 502 })
  })
})

describe('host client streaming', () => {
  it('splits NDJSON frames across chunk boundaries', async () => {
    const frames = [
      '{"type":"start","messageId":"m1","model":{"provider":"p","model":"m"}}',
      '{"type":"delta","text":"Hello"}',
      '{"type":"done"}',
    ]
    const payload = `${frames.join('\n')}\n`
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 25)))
        controller.enqueue(encoder.encode(payload.slice(25, 60)))
        controller.enqueue(encoder.encode(payload.slice(60)))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))
    const client = createHostClient(BASE)
    const received: Array<{ type: string }> = []
    await client.stream('chat', { documentId: 'd1', question: 'q' }, { onFrame: (frame) => received.push(frame) })
    expect(received.map((frame) => frame.type)).toEqual(['start', 'delta', 'done'])
  })

  it('throws ApiError when the stream endpoint answers an envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: { code: 'llm-unavailable', message: 'no model' } }, 503)),
    )
    const client = createHostClient(BASE)
    await expect(
      client.stream('chat', { documentId: 'd1', question: 'q' }, { onFrame: () => {} }),
    ).rejects.toMatchObject({ code: 'llm-unavailable', status: 503 })
  })
})

describe('urls', () => {
  it('resolves asset, source and vendor URLs against the base', () => {
    const client = createHostClient(BASE)
    expect(client.asset('doc 1', 'images/a.png')).toContain('id=doc+1')
    expect(client.asset('doc 1', 'images/a.png')).toContain('path=images%2Fa.png')
    expect(client.source('doc1', true)).toContain('download=1')
    expect(client.vendor('katex/katex.min.css')).toBe('http://localhost:3080/dsh-litnotes/assets/katex/katex.min.css')
  })
})
