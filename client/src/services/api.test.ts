import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, consumeSse, consumeSseEvents } from './api'

afterEach(() => vi.unstubAllGlobals())

function fragmentedResponse(parts: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    }
  }), { headers: { 'content-type': 'text/event-stream' } })
}

describe('chat SSE parser', () => {
  it('joins fragmented frames and emits deltas', async () => {
    const deltas: string[] = []
    await consumeSse(fragmentedResponse([
      'event: delta\ndata: {"text":"The', ' Word"}\n\n',
      'event: delta\r\ndata: {"text":" end"}\r\n\r\nevent: done\ndata: {}\n\n'
    ]), { delta: (text) => deltas.push(text) })
    expect(deltas).toEqual(['The Word', ' end'])
  })

  it('throws server stream errors', async () => {
    await expect(consumeSse(fragmentedResponse([
      'event: error\ndata: {"message":"Provider unavailable"}\n\n'
    ]), { delta: () => undefined })).rejects.toThrow('Provider unavailable')
  })

  it('rejects truncated and malformed streams without losing emitted text', async () => {
    const deltas: string[] = []
    await expect(consumeSse(fragmentedResponse([
      'event: delta\ndata: {"text":"Partial"}\n\n'
    ]), { delta: (text) => deltas.push(text) })).rejects.toThrow('before completion')
    expect(deltas).toEqual(['Partial'])
    await expect(consumeSse(fragmentedResponse([
      'event: delta\ndata: {"text":"Partial"}\n\nevent: done\ndata: broken\n\n'
    ]), { delta: () => undefined })).rejects.toThrow()
  })

  it('cancels the reader after completion rather than waiting for EOF', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'))
      },
      cancel
    }))
    await consumeSse(response, { delta: () => undefined })
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('install SSE completion', () => {
  it('rejects progress-only EOF and reports 100 only after fragmented completion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fragmentedResponse(['event: progress\ndata: {"pct":40}\n\n']))
      .mockResolvedValueOnce(fragmentedResponse([
        'event: progress\r\ndata: {"pct":40}\r\n\r\nevent: do', 'ne\r\ndata: {}\r\n\r\n'
      ]))
    vi.stubGlobal('fetch', fetchMock)
    const progress = vi.fn()
    await expect(api.install('CrossWire', 'WEB', progress)).rejects.toThrow('before completion')
    expect(progress.mock.calls).toEqual([[40]])
    await api.install('CrossWire', 'WEB', progress)
    expect(progress.mock.calls).toEqual([[40], [40], [100]])
  })

  it('rejects a conversation completion without a completed message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fragmentedResponse([
      'event: done\ndata: {}\n\n'
    ])))
    await expect(api.streamConversationMessage('conversation-1', {
      content: 'Question', passage: { reference: 'John 1:1', module: 'WEB', content: 'The Word' },
      preferences: { alwaysCite: true, drawApocrypha: false }
    }, { accepted: vi.fn(), delta: vi.fn(), done: vi.fn(), error: vi.fn() }))
      .rejects.toThrow('Invalid conversation completion')
  })
})

describe('generic SSE parser', () => {
  it('parses rebuild progress and completion across fragmented frames', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    await consumeSseEvents(fragmentedResponse([
      'event: progress\ndata: {"module":"WEB",', '"processed":64,"batchSize":32}\n\n',
      'event: done\ndata: {"state":"ready","chunkCount":64}\n\n'
    ]), (event, data) => events.push({ event, data }))
    expect(events).toEqual([
      { event: 'progress', data: { module: 'WEB', processed: 64, batchSize: 32 } },
      { event: 'done', data: { state: 'ready', chunkCount: 64 } }
    ])
  })
})

describe('provider discovery client', () => {
  it('sends staged connection data only on the explicit discovery request', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      return new Response(JSON.stringify({
        supported: true,
        source: 'openai-compatible',
        cached: false,
        fetchedAt: 1,
        truncated: false,
        models: [{ id: 'model-a', name: 'Model A', compatibility: 'unknown', capabilities: [] }],
        voices: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.discoverProvider({
      target: 'chat', provider: 'openai-compatible', baseUrl: 'https://provider.test/v1',
      apiKey: 'staged-key', refresh: true
    })

    expect(result.models[0].id).toBe('model-a')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = calls[0]
    expect(url).toBe('/api/providers/discover')
    expect(init?.credentials).toBe('same-origin')
    expect(JSON.parse(String(init?.body))).toEqual({
      target: 'chat', provider: 'openai-compatible', baseUrl: 'https://provider.test/v1',
      apiKey: 'staged-key', refresh: true
    })
  })
})

describe('deployment provider client', () => {
  it('loads system-provided inference choices without sending configuration', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      providers: {
        embeddings: {
          source: 'bundled', engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'all-minilm:22m', batchSize: 16,
          readiness: { state: 'ready', checkedAt: 1 }
        }
      }
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const providers = await api.deploymentProviders()

    expect(providers.embeddings?.model).toBe('all-minilm:22m')
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/deployment', {
      credentials: 'same-origin'
    })
  })
})
