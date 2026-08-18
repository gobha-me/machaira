import { describe, expect, it } from 'vitest'
import { consumeSse } from './api'

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
