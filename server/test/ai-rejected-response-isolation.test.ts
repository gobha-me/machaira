import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { AiProviderError, streamProviderChat } from '../src/ai.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 1500)
    })])
  } finally {
    clearTimeout(timer)
  }
}

describe('concurrent provider response body isolation', () => {
  for (const kind of ['openai-compatible', 'local', 'anthropic'] as const) {
    it(`${kind}: closes every rejected body while an accepted stream keeps its connection`, async () => {
      const closed = [deferred(), deferred(), deferred()]
      let accepted: ServerResponse | undefined
      const server = createServer((request, response) => {
        let raw = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => { raw += chunk })
        request.on('end', () => {
          const model = (JSON.parse(raw) as { model: string }).model
          if (model === 'accepted') {
            accepted = response
            response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
            response.write(kind === 'anthropic'
              ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Start"}}\n\n'
              : 'data: {"choices":[{"delta":{"content":"Start"}}]}\n\n')
            return
          }
          const index = Number(model)
          response.once('close', closed[index].resolve)
          const mime = ['application/json', 'text/plain', undefined][index]
          if (mime !== undefined) response.setHeader('content-type', mime)
          response.writeHead(200)
          response.flushHeaders()
          response.write('{"unfinished":')
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const abort = new AbortController()
      const input = {
        passage: { reference: 'John 1:1', module: 'WEB', content: 'In the beginning was the Word.' },
        messages: [{ role: 'user' as const, content: 'Explain the passage.' }],
        preferences: { alwaysCite: true, drawApocrypha: false }
      }
      const stream = (model: string) => streamProviderChat({
        config: { kind, baseUrl: `http://127.0.0.1:${address.port}/v1`, model, hasApiKey: kind !== 'local' },
        apiKey: kind === 'local' ? null : 'test-only-key'
      }, input, abort.signal)
      const valid = stream('accepted')
      try {
        assert.deepEqual(await bounded(valid.next(), 'the accepted stream must start'),
          { value: 'Start', done: false })
        const rejected = [0, 1, 2].map((index) => assert.rejects(stream(String(index)).next(), (error: unknown) => {
          assert.ok(error instanceof AiProviderError)
          assert.equal(error.message, 'Provider did not return an event stream')
          return true
        }))
        await bounded(Promise.all(rejected), 'all MIME rejections must finish without reading bodies')
        await bounded(Promise.all(closed.map((event) => event.promise)),
          'each rejected unread response must disconnect independently')
        assert.equal(abort.signal.aborted, false)
        assert.ok(accepted)
        assert.equal(accepted.destroyed, false)
        accepted.write(kind === 'anthropic'
          ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Finish"}}\n\n'
          : 'data: {"choices":[{"delta":{"content":"Finish"}}]}\n\n')
        accepted.end(kind === 'anthropic' ? 'data: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n')
        assert.deepEqual(await bounded(valid.next(), 'the accepted stream must remain readable'),
          { value: 'Finish', done: false })
        assert.deepEqual(await bounded(valid.next(), 'the accepted stream must complete'),
          { value: undefined, done: true })
      } finally {
        abort.abort()
        await valid.return(undefined)
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve())
        })
      }
    })
  }
})
