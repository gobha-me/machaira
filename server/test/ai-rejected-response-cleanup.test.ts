import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { AiProviderError, streamProviderChat, type AiProviderKind, type ChatInput } from '../src/ai.ts'
import { buildApp } from '../src/app.ts'

const input: ChatInput = {
  passage: { reference: 'John 1:1', module: 'WEB', content: 'In the beginning was the Word.' },
  messages: [{ role: 'user', content: 'Explain this passage.' }],
  preferences: { alwaysCite: true, drawApocrypha: false }
}
const mimeError = 'Provider did not return an event stream'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1500)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function provider(contentType: string | undefined, status = 200, corruptEncoding = false) {
  const disconnected = deferred()
  const paths: string[] = []
  let mode: 'rejected' | 'complete' | 'incomplete' = 'rejected'
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    request.resume()
    if (mode === 'rejected') {
      response.once('close', disconnected.resolve)
      if (contentType !== undefined) response.setHeader('content-type', contentType)
      if (corruptEncoding) response.setHeader('content-encoding', 'gzip')
      response.writeHead(status)
      response.flushHeaders()
      if (status === 204) response.end()
      else if (corruptEncoding) response.end('this is not a gzip response')
      else response.write('{"incomplete":')
      return
    }
    response.writeHead(200, { 'content-type': 'TeXt/EvEnT-StReAm; charset=utf-8' })
    const anthropic = request.url?.endsWith('/messages')
    response.write(anthropic
      ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Recovered"}}\n\n'
      : 'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n')
    response.end(mode === 'incomplete' ? '' : anthropic
      ? 'data: {"type":"message_stop"}\n\n'
      : 'data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  return {
    baseUrl, paths,
    disconnected: () => bounded(disconnected.promise,
      'the rejected unread response must disconnect before the provider deadline'),
    recover() { mode = 'complete' },
    truncate() { mode = 'incomplete' },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  }
}

function credentials(kind: AiProviderKind, baseUrl: string) {
  return {
    config: { kind, baseUrl, model: 'test-model', hasApiKey: kind !== 'local' },
    apiKey: kind === 'local' ? null : 'test-only-key'
  }
}

async function collect(kind: AiProviderKind, baseUrl: string, signal: AbortSignal, text: string[]) {
  for await (const delta of streamProviderChat(credentials(kind, baseUrl), input, signal)) text.push(delta)
}

function isMimeError(error: unknown): boolean {
  assert.ok(error instanceof AiProviderError)
  assert.equal(error.message, mimeError)
  return true
}

describe('rejected chat response body ownership over real HTTP', () => {
  for (const kind of ['openai-compatible', 'local', 'anthropic'] as const) {
    for (const contentType of ['application/json', 'text/plain', undefined]) {
      it(`${kind}: releases a held ${contentType ?? 'missing MIME'} body and accepts a later valid stream`, async () => {
        const upstream = await provider(contentType)
        const abort = new AbortController()
        const deltas: string[] = []
        try {
          await assert.rejects(bounded(collect(kind, upstream.baseUrl, abort.signal, deltas),
            'MIME rejection must not consume the held response body'), isMimeError)
          assert.deepEqual(deltas, [])
          await upstream.disconnected()
          upstream.recover()
          await bounded(collect(kind, upstream.baseUrl, abort.signal, deltas), 'valid stream must complete')
          assert.deepEqual(deltas, ['Recovered'])
          const endpoint = kind === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'
          assert.deepEqual(upstream.paths, [endpoint, endpoint])
        } finally {
          abort.abort()
          await upstream.close()
        }
      })
    }

    it(`${kind}: still rejects a valid MIME stream that lacks its explicit completion event`, async () => {
      const upstream = await provider('application/json')
      const abort = new AbortController()
      const deltas: string[] = []
      try {
        upstream.truncate()
        await assert.rejects(collect(kind, upstream.baseUrl, abort.signal, deltas), (error: unknown) => {
          assert.ok(error instanceof AiProviderError)
          assert.equal(error.message, 'Provider stream ended before completion')
          return true
        })
        assert.deepEqual(deltas, ['Recovered'])
      } finally {
        abort.abort()
        await upstream.close()
      }
    })
  }

  for (const [label, status, corruptEncoding] of [
    ['bodyless successful response', 204, false],
    ['malformed compressed response', 200, true]
  ] as const) {
    it(`preserves the controlled MIME error for a ${label}`, async () => {
      const upstream = await provider('application/json', status, corruptEncoding)
      const abort = new AbortController()
      const deltas: string[] = []
      try {
        await assert.rejects(collect('openai-compatible', upstream.baseUrl, abort.signal, deltas), isMimeError)
        assert.deepEqual(deltas, [])
      } finally {
        abort.abort()
        await upstream.close()
      }
    })
  }
})

describe('authenticated chat recovery after rejecting a held provider body', () => {
  for (const [kind, contentType] of [
    ['openai-compatible', 'application/json'],
    ['local', undefined],
    ['anthropic', 'text/plain']
  ] as const) {
    it(`${kind}: releases the upstream, persists failure, and permits retry in the same conversation`, async () => {
      const upstream = await provider(contentType)
      const app = await buildApp({
        databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
      })
      try {
        await app.ready()
        const bootstrap = await app.inject({
          method: 'POST', url: '/api/auth/bootstrap',
          payload: { username: 'CleanupTester', password: 'independent rejected body cleanup test' }
        })
        assert.equal(bootstrap.statusCode, 201, bootstrap.body)
        const setCookie = bootstrap.headers['set-cookie']
        const session = Array.isArray(setCookie) ? setCookie[0] : setCookie
        assert.ok(session)
        const headers = { cookie: session.split(';', 1)[0] }
        const saved = await app.inject({
          method: 'PUT', url: '/api/ai/provider', headers,
          payload: { kind, baseUrl: upstream.baseUrl, model: 'test-model',
            ...(kind === 'local' ? {} : { apiKey: 'test-only-key' }) }
        })
        assert.equal(saved.statusCode, 200, saved.body)
        const created = await app.inject({ method: 'POST', url: '/api/ai/conversations', headers })
        assert.equal(created.statusCode, 201, created.body)
        const id = created.json().conversation.id as string
        const url = `/api/ai/conversations/${id}`
        const failed = await bounded(app.inject({
          method: 'POST', url: `${url}/messages`, headers,
          payload: { content: input.messages[0].content, passage: input.passage, preferences: input.preferences }
        }), 'the route must report MIME rejection without reading the held body')
        assert.equal(failed.statusCode, 200, failed.body)
        assert.match(failed.body, /event: accepted\n/)
        assert.match(failed.body, /event: error\n/)
        assert.match(failed.body, /Provider did not return an event stream/)
        assert.doesNotMatch(failed.body, /event: (?:delta|done)\n/)
        const failure = (await app.inject({ method: 'GET', url, headers })).json().conversation.messages.at(-1)
        assert.equal(failure.status, 'failed')
        assert.equal(failure.content, '')
        assert.equal(failure.error, mimeError)
        await upstream.disconnected()
        upstream.recover()
        const retried = await bounded(app.inject({
          method: 'POST', url: `${url}/messages/${failure.id}/retry`, headers,
          payload: { preferences: input.preferences }
        }), 'retry must release conversation ownership and complete')
        assert.equal(retried.statusCode, 200, retried.body)
        assert.match(retried.body, /event: delta\n/)
        assert.match(retried.body, /event: done\n/)
        assert.doesNotMatch(retried.body, /event: error\n/)
        const messages = (await app.inject({ method: 'GET', url, headers })).json().conversation.messages
        assert.deepEqual(messages.map((message: { status: string }) => message.status),
          ['completed', 'failed', 'completed'])
        assert.equal(messages.at(-1).content, 'Recovered')
        assert.equal(upstream.paths.length, 2)
      } finally {
        await upstream.close()
        await app.close()
      }
    })
  }
})
