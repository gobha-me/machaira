import assert from 'node:assert/strict'
import { it } from 'node:test'
import { streamProviderChat, type AiProviderKind, type ChatInput } from '../src/ai.ts'

const input: ChatInput = {
  passage: { reference: 'John 1:1', module: 'WEB', content: 'The Word' },
  messages: [{ role: 'user', content: 'Question' }],
  preferences: { alwaysCite: true, drawApocrypha: false }
}

const openAiDelta = 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'
const anthropicDelta = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n'

it('requires provider-specific completion, preserves partial text, and releases the stream', async (t) => {
  const cases: Array<[AiProviderKind, string, boolean]> = [
    ['openai-compatible', openAiDelta, false],
    ['anthropic', anthropicDelta, false],
    ['openai-compatible', openAiDelta + 'data: broken\n\n', false],
    ['anthropic', anthropicDelta + 'data: [DONE]\n\n', false],
    ['openai-compatible', openAiDelta + 'data: [DONE]\n\n', true],
    ['local', openAiDelta + 'data: {"choices":[{"finish_reason":"stop"}]}\n\n', true],
    ['anthropic', anthropicDelta + 'data: {"type":"message_stop"}\n\n', true]
  ]
  for (const [kind, frames, complete] of cases) {
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(frames)
        controller.enqueue(bytes.slice(0, 17))
        controller.enqueue(bytes.slice(17))
        if (!complete) controller.close()
      },
      cancel() { cancelled = true }
    })
    t.mock.method(globalThis, 'fetch', async () => new Response(stream, {
      headers: { 'content-type': 'text/event-stream' }
    }))
    const deltas: string[] = []
    const consume = async () => {
      for await (const delta of streamProviderChat({
        config: { kind, baseUrl: 'https://provider.invalid/v1', model: 'test', hasApiKey: true }, apiKey: 'fake-key'
      }, input, new AbortController().signal)) deltas.push(delta)
    }
    if (complete) {
      await consume()
      assert.equal(cancelled, true)
    } else await assert.rejects(consume, /before completion|malformed/)
    assert.deepEqual(deltas, ['Partial'])
    t.mock.restoreAll()
  }
})

it('reports cancellation rather than a completed response', async (t) => {
  const controller = new AbortController()
  controller.abort()
  t.mock.method(globalThis, 'fetch', async () => { throw controller.signal.reason })
  await assert.rejects(async () => {
    for await (const _delta of streamProviderChat({
      config: { kind: 'local', baseUrl: 'https://provider.invalid/v1', model: 'test', hasApiKey: false }, apiKey: null
    }, input, controller.signal)) { /* no completed response */ }
  }, /cancelled/)
})

it('does not accept buffered completion after cancellation during a delta', async (t) => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => new Response(openAiDelta + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' }
  }))
  const stream = streamProviderChat({
    config: { kind: 'local', baseUrl: 'https://provider.invalid/v1', model: 'test', hasApiKey: false }, apiKey: null
  }, input, controller.signal)
  assert.deepEqual(await stream.next(), { value: 'Partial', done: false })
  controller.abort()
  await assert.rejects(stream.next(), /cancelled/)
})
