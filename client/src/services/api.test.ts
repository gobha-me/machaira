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
