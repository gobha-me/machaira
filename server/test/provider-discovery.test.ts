import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/database.ts'
import { ProviderDiscoveryError, ProviderDiscoveryService } from '../src/provider-discovery.ts'
import { SecretStore } from '../src/secrets.ts'

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value)
  return value.split(';', 1)[0]
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function session(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  return cookie(await app.inject({
    method: 'POST', url: '/api/auth/bootstrap',
    payload: { username: 'Owner', password: 'correct horse battery staple' }
  }))
}

describe('provider discovery API', () => {
  it('uses staged and matching stored credentials, caches success, and isolates users', async () => {
    const requests: IncomingMessage['headers'][] = []
    const upstream = await listen((request, response) => {
      requests.push(request.headers)
      assert.equal(request.url, '/v1/models')
      json(response, {
        object: 'list',
        data: [
          { id: 'gpt-example', object: 'model', owned_by: 'example-owner', shutdown_date: '2027-01-01' },
          { id: 'embedding-only', object: 'model', type: 'embedding' }
        ]
      })
    })
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const owner = await session(app)
      assert.equal((await app.inject({
        method: 'POST', url: '/api/providers/discover',
        payload: { target: 'chat', provider: 'openai-compatible', baseUrl: upstream.baseUrl, apiKey: 'staged-key' }
      })).statusCode, 401)

      const first = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'chat', provider: 'openai-compatible', baseUrl: upstream.baseUrl, apiKey: 'staged-key' }
      })
      assert.equal(first.statusCode, 200)
      assert.equal(first.json().cached, false)
      assert.deepEqual(first.json().models, [{
        id: 'gpt-example', name: 'gpt-example', owner: 'example-owner',
        compatibility: 'unknown', capabilities: [], deprecatedAt: '2027-01-01'
      }])
      assert.doesNotMatch(first.body, /staged-key/)
      assert.equal(requests[0].authorization, 'Bearer staged-key')

      const cached = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'chat', provider: 'openai-compatible', baseUrl: upstream.baseUrl, apiKey: 'staged-key' }
      })
      assert.equal(cached.json().cached, true)
      assert.equal(requests.length, 1)

      await app.inject({
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: owner },
        payload: { kind: 'openai-compatible', baseUrl: upstream.baseUrl, model: 'gpt-example', apiKey: 'stored-key' }
      })
      const stored = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'chat', provider: 'openai-compatible', baseUrl: upstream.baseUrl, refresh: true }
      })
      assert.equal(stored.statusCode, 200)
      assert.equal(requests.at(-1)?.authorization, 'Bearer stored-key')

      await app.inject({
        method: 'POST', url: '/api/users', headers: { cookie: owner },
        payload: { username: 'Reader', password: 'reader secure password', role: 'member' }
      })
      const reader = cookie(await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: 'Reader', password: 'reader secure password' }
      }))
      const isolated = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: reader },
        payload: { target: 'chat', provider: 'openai-compatible', baseUrl: upstream.baseUrl }
      })
      assert.equal(isolated.statusCode, 400)
      assert.equal(isolated.json().code, 'invalid_request')

      const changed = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'chat', provider: 'openai-compatible', baseUrl: `${upstream.origin}/other` }
      })
      assert.equal(changed.statusCode, 400)
    } finally {
      await app.close()
      await upstream.close()
    }
  })

  it('normalizes Anthropic pagination, Venice types and voices, and Ollama metadata', async () => {
    const seen: { url: string; headers: IncomingMessage['headers'] }[] = []
    const upstream = await listen((request, response) => {
      seen.push({ url: request.url ?? '', headers: request.headers })
      const url = new URL(request.url ?? '/', 'http://provider.test')
      if (url.pathname === '/v1/models' && request.headers['x-api-key']) {
        assert.equal(request.headers['anthropic-version'], '2023-06-01')
        if (url.searchParams.get('after_id')) {
          json(response, {
            data: [{ id: 'claude-haiku', display_name: 'Claude Haiku', max_input_tokens: 200000, max_tokens: 8192 }],
            has_more: false, last_id: 'claude-haiku'
          })
        } else {
          json(response, {
            data: [{ id: 'claude-sonnet', display_name: 'Claude Sonnet', max_input_tokens: 1000000, max_tokens: 64000 }],
            has_more: true, last_id: 'claude-sonnet'
          })
        }
      } else if (url.pathname === '/v1/models' && url.searchParams.get('type') === 'asr') {
        json(response, { data: [{
          id: 'venice-asr', type: 'asr', owned_by: 'venice.ai',
          model_spec: { name: 'Venice ASR', privacy: 'private', description: 'Speech recognition' }
        }] })
      } else if (url.pathname === '/v1/models' && url.searchParams.get('type') === 'tts') {
        json(response, { data: [{ id: 'venice-tts', type: 'tts', model_spec: { name: 'Venice TTS' } }] })
      } else if (url.pathname === '/v1/models/venice-tts') {
        json(response, { data: { id: 'venice-tts', model_spec: {
          voices: ['af_sky', { id: 'am_adam', name: 'Adam' }]
        } } })
      } else if (url.pathname === '/api/tags') {
        json(response, { models: [{
          name: 'gemma3:latest', model: 'gemma3:latest', size: 3_338_801_804,
          details: { parameter_size: '4.3B', quantization_level: 'Q4_K_M' }
        }] })
      } else {
        json(response, { error: 'not found' }, 404)
      }
    })
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const owner = await session(app)
      const anthropic = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'chat', provider: 'anthropic', baseUrl: upstream.baseUrl, apiKey: 'claude-key' }
      })
      assert.equal(anthropic.statusCode, 200)
      assert.equal(anthropic.json().source, 'anthropic')
      assert.deepEqual(anthropic.json().models.map((model: { id: string }) => model.id), ['claude-haiku', 'claude-sonnet'])
      assert.ok(anthropic.json().models.every((model: { compatibility: string }) => model.compatibility === 'confirmed'))
      assert.ok(seen.some((request) => request.url.includes('after_id=claude-sonnet')))

      const veniceStt = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'stt-cloud', provider: 'venice', baseUrl: upstream.baseUrl, apiKey: 'venice-key' }
      })
      assert.equal(veniceStt.statusCode, 200)
      assert.deepEqual(veniceStt.json().models[0], {
        id: 'venice-asr', name: 'Venice ASR', owner: 'venice.ai', compatibility: 'confirmed',
        capabilities: ['stt'], description: 'Speech recognition', privacy: 'private'
      })

      const veniceTts = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: {
          target: 'tts-cloud', provider: 'venice', baseUrl: upstream.baseUrl,
          apiKey: 'venice-key', model: 'venice-tts'
        }
      })
      assert.equal(veniceTts.statusCode, 200)
      assert.deepEqual(veniceTts.json().voices, [
        { id: 'am_adam', name: 'Adam' },
        { id: 'af_sky', name: 'af_sky' }
      ])

      const ollama = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'chat', provider: 'local', baseUrl: upstream.baseUrl }
      })
      assert.equal(ollama.statusCode, 200)
      assert.equal(ollama.json().source, 'ollama')
      assert.deepEqual(ollama.json().models[0], {
        id: 'gemma3:latest', name: 'gemma3:latest', owner: 'Ollama', compatibility: 'unknown',
        capabilities: [], sizeBytes: 3_338_801_804, parameterSize: '4.3B', quantization: 'Q4_K_M'
      })
    } finally {
      await app.close()
      await upstream.close()
    }
  })

  it('caps model lists and returns actionable upstream failure codes', async () => {
    let mode: 'large-list' | 'unauthorized' | 'unsupported' | 'malformed' | 'server-error' | 'oversized' | 'redirect' = 'large-list'
    const upstream = await listen((_request, response) => {
      if (mode === 'large-list') {
        json(response, { data: Array.from({ length: 501 }, (_, index) => ({ id: `model-${index}`, object: 'model' })) })
      } else if (mode === 'unauthorized') {
        json(response, { error: 'bad key' }, 401)
      } else if (mode === 'unsupported') {
        json(response, { error: 'missing' }, 404)
      } else if (mode === 'malformed') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{not json')
      } else if (mode === 'server-error') {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('x'.repeat(3000))
      } else if (mode === 'oversized') {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) })
        response.end('{}')
      } else {
        response.writeHead(302, { location: '/elsewhere' })
        response.end()
      }
    })
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const owner = await session(app)
      const discover = (refresh = true) => app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: {
          target: 'chat', provider: 'openai-compatible', baseUrl: upstream.baseUrl,
          apiKey: 'key', refresh
        }
      })
      const capped = await discover()
      assert.equal(capped.statusCode, 200)
      assert.equal(capped.json().models.length, 500)
      assert.equal(capped.json().truncated, true)

      for (const [nextMode, code] of [
        ['unauthorized', 'provider_unauthorized'],
        ['unsupported', 'provider_unsupported'],
        ['malformed', 'provider_malformed'],
        ['server-error', 'provider_unreachable'],
        ['oversized', 'provider_response_too_large'],
        ['redirect', 'provider_unreachable']
      ] as const) {
        mode = nextMode
        const failed = await discover()
        assert.equal(failed.statusCode, 502)
        assert.equal(failed.json().code, code)
      }

      const invalid = await app.inject({
        method: 'POST', url: '/api/providers/discover', headers: { cookie: owner },
        payload: { target: 'embedding', provider: 'anthropic', baseUrl: upstream.baseUrl, apiKey: 'key' }
      })
      assert.equal(invalid.statusCode, 400)
      assert.equal(invalid.json().code, 'invalid_request')
    } finally {
      await app.close()
      await upstream.close()
    }
  })

  it('aborts a provider request at the configured timeout', async () => {
    const db = openDatabase(':memory:')
    const fetcher = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('Provider timeout did not fire')), 100)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive)
          reject(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      })
    }
    const discovery = new ProviderDiscoveryService(
      db,
      new SecretStore(db, randomBytes(32)),
      fetcher,
      Date.now,
      5
    )
    try {
      await assert.rejects(
        discovery.discover('user-1', {
          target: 'chat', provider: 'local', baseUrl: 'http://provider.test/v1'
        }),
        (error) => error instanceof ProviderDiscoveryError && error.code === 'provider_timeout'
      )
    } finally {
      db.close()
    }
  })
})
