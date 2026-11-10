import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { AuthService, SESSION_COOKIE } from '../src/auth.ts'
import { openDatabase } from '../src/database.ts'
import { ProviderDiscoveryError, ProviderDiscoveryService } from '../src/provider-discovery.ts'
import { registerProviderDiscovery } from '../src/routes/provider-discovery.ts'
import { SecretStore } from '../src/secrets.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// Only the transport is observed: headers and bodies come from real HTTP fetch.
async function fixture(mode: 'direct' | 'fallback' | 'pagination' = 'direct', deadline?: number) {
  const headersReceived = deferred()
  const paths: string[] = []
  let incomplete = true
  let held: ServerResponse | undefined
  const upstream = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    paths.push(url.pathname + url.search)
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/tags') {
      response.writeHead(404)
      response.end('{}')
    } else if (mode === 'pagination' && !url.searchParams.has('after_id')) {
      response.end(JSON.stringify({
        data: [{ id: 'claude-haiku-4-5' }], has_more: true, last_id: 'claude-haiku-4-5'
      }))
    } else if (incomplete) {
      held = response
      response.writeHead(200)
      response.flushHeaders()
      response.write('{"data":[{"id":"incomplete')
    } else {
      response.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }], has_more: false }))
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address === 'object')
  const db = openDatabase(':memory:')
  const auth = new AuthService(db)
  const owner = await auth.bootstrap('StreamTester', 'independent response stream regression')
  const token = auth.createSession(owner.id)
  const service = new ProviderDiscoveryService(db, new SecretStore(db, randomBytes(32)), async (input, init) => {
    const response = await fetch(input, init)
    if (held && response.ok) headersReceived.resolve()
    return response
  }, Date.now, deadline)
  const app = Fastify({ logger: false })
  await app.register(cookie)
  app.decorateRequest('authUser', null)
  app.addHook('onRequest', async (request, reply) => {
    const user = auth.authenticate(request.cookies[SESSION_COOKIE])
    if (!user) return reply.code(401).send({ error: 'Authentication required' })
    request.authUser = user
  })
  await registerProviderDiscovery(app, service)
  await app.ready()
  const payload = {
    target: 'chat',
    provider: mode === 'pagination' ? 'anthropic' : mode === 'fallback' ? 'local' : 'openai-compatible',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'test-only-provider-credential'
  }
  return {
    app, service, owner, payload, paths, headersReceived,
    discover: async () => app.inject({
      method: 'POST', url: '/api/providers/discover',
      headers: { cookie: `${SESSION_COOKIE}=${token}` }, payload
    }),
    disconnect() {
      assert.ok(held, 'the upstream must have started its response body')
      held.destroy()
    },
    recover() { incomplete = false },
    async close() {
      upstream.closeAllConnections()
      await app.close()
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => error ? reject(error) : resolve())
      })
      db.close()
    }
  }
}

async function assertRecovery(f: Awaited<ReturnType<typeof fixture>>) {
  const failedRequests = f.paths.length
  f.recover()
  const recovered = await f.discover()
  assert.equal(recovered.statusCode, 200, recovered.body)
  assert.equal(recovered.json().cached, false)
  assert.deepEqual(recovered.json().models.map((model: { id: string }) => model.id),
    f.payload.provider === 'anthropic' ? ['claude-haiku-4-5', 'gpt-4o-mini'] : ['gpt-4o-mini'])
  assert.ok(f.paths.length > failedRequests, 'a failed response must not populate the model cache')
  const recoveredRequests = f.paths.length
  const cached = await f.discover()
  assert.equal(cached.statusCode, 200, cached.body)
  assert.equal(cached.json().cached, true)
  assert.deepEqual(cached.json().models, recovered.json().models)
  assert.equal(f.paths.length, recoveredRequests)
}

describe('provider discovery failures after real response headers', () => {
  for (const mode of ['direct', 'fallback', 'pagination'] as const) {
    it(`${mode}: returns 502 for an interrupted body and retries without caching partial models`, async () => {
      const f = await fixture(mode)
      try {
        const pending = f.discover()
        await f.headersReceived.promise
        f.disconnect()
        const failed = await pending
        assert.equal(failed.statusCode, 502, failed.body)
        assert.equal(failed.json().code, 'provider_unreachable')
        assert.equal(failed.json().models, undefined)
        assert.doesNotMatch(failed.body, /test-only-provider-credential/)
        if (mode === 'fallback') assert.deepEqual(f.paths, ['/api/tags', '/v1/models'])
        if (mode === 'pagination') {
          assert.deepEqual(f.paths, ['/v1/models?limit=100', '/v1/models?limit=100&after_id=claude-haiku-4-5'])
        }
        await assertRecovery(f)
      } finally {
        await f.close()
      }
    })
  }

  it('classifies cancellation during a body read and permits a fresh uncancelled request', async () => {
    const f = await fixture()
    const controller = new AbortController()
    try {
      const pending = f.service.discover(f.owner.id, f.payload, controller.signal)
      const rejected = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof ProviderDiscoveryError)
        assert.equal(error.code, 'provider_timeout')
        assert.equal(error.message, 'Provider model discovery timed out or was cancelled')
        return true
      })
      await f.headersReceived.promise
      controller.abort()
      await rejected
      await assertRecovery(f)
    } finally {
      controller.abort()
      await f.close()
    }
  })

  it('returns 504 when the real service deadline expires after headers and leaves no cached partial result', async () => {
    const f = await fixture('direct', 250)
    try {
      const pending = f.discover()
      await f.headersReceived.promise
      const timedOut = await pending
      assert.equal(timedOut.statusCode, 504, timedOut.body)
      assert.deepEqual(timedOut.json(), {
        error: 'Provider model discovery timed out or was cancelled', code: 'provider_timeout'
      })
      await assertRecovery(f)
    } finally {
      await f.close()
    }
  })
})
