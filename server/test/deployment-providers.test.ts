import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { buildApp } from '../src/app.ts'
import {
  DeploymentProviderConfigError,
  DeploymentProviderService,
  parseDeploymentProviders
} from '../src/deployment-providers.ts'

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value)
  return value.split(';', 1)[0]
}

describe('deployment provider configuration', () => {
  it('parses strict non-secret provider descriptors', () => {
    const providers = parseDeploymentProviders(JSON.stringify({
      embeddings: {
        source: 'bundled', engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/',
        model: 'all-minilm:22m', batchSize: 16
      },
      stt: {
        source: 'external', engine: 'openai-compatible', baseUrl: 'http://speech.internal/v1',
        model: 'whisper-small'
      },
      tts: {
        source: 'bundled', engine: 'kokoro', baseUrl: 'http://127.0.0.1:8880/v1',
        model: 'kokoro', voice: 'af_heart'
      }
    }))
    assert.deepEqual(providers.embeddings, {
      source: 'bundled', engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'all-minilm:22m', batchSize: 16
    })
    assert.equal(providers.stt?.source, 'external')
    assert.equal(providers.tts?.voice, 'af_heart')
  })

  it('rejects invalid JSON, partial providers, credentials, and unknown capabilities', () => {
    assert.throws(() => parseDeploymentProviders('{'), DeploymentProviderConfigError)
    assert.throws(() => parseDeploymentProviders(JSON.stringify({
      embeddings: { source: 'bundled', engine: 'tei', baseUrl: 'http://local/v1', model: 'model', batchSize: 16 }
    })), /engine must be ollama/)
    assert.throws(() => parseDeploymentProviders(JSON.stringify({
      stt: { source: 'external', engine: 'openai-compatible', baseUrl: 'http://key:secret@local/v1', model: 'model' }
    })), /cannot include credentials/)
    assert.throws(() => parseDeploymentProviders(JSON.stringify({
      tts: { source: 'bundled', engine: 'kokoro', baseUrl: 'http://local/v1', model: 'kokoro' }
    })), /voice is required/)
    assert.throws(() => parseDeploymentProviders(JSON.stringify({ chat: {} })), /Unknown deployment provider capability/)
  })
})

describe('deployment provider readiness', () => {
  it('checks models, caches readiness, and distinguishes startup from later failure', async () => {
    let now = 1_000
    let healthy = false
    let calls = 0
    const fetcher: typeof fetch = async (input) => {
      calls += 1
      assert.equal(String(input), 'http://127.0.0.1:11434/api/tags')
      if (!healthy) throw new Error('connection refused')
      return new Response(JSON.stringify({ models: [{ name: 'all-minilm:22m' }] }), {
        headers: { 'content-type': 'application/json' }
      })
    }
    const service = new DeploymentProviderService({
      embeddings: {
        source: 'bundled', engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'all-minilm:22m', batchSize: 16
      }
    }, fetcher, () => now)

    assert.equal((await service.list()).embeddings?.readiness.state, 'starting')
    assert.equal((await service.list()).embeddings?.readiness.state, 'starting')
    assert.equal(calls, 1)

    healthy = true
    now += 10_001
    assert.equal((await service.list()).embeddings?.readiness.state, 'ready')
    assert.equal(calls, 2)

    healthy = false
    now += 10_001
    assert.equal((await service.list()).embeddings?.readiness.state, 'unavailable')
    assert.equal(calls, 3)
  })

  it('does not probe external providers', async () => {
    const service = new DeploymentProviderService({
      stt: {
        source: 'external', engine: 'openai-compatible', baseUrl: 'https://speech.example/v1',
        model: 'whisper'
      }
    }, async () => { throw new Error('must not be called') })
    assert.deepEqual((await service.list()).stt?.readiness, { state: 'unchecked', checkedAt: null })
  })

  it('accepts a successful non-JSON health body from Kokoro', async () => {
    const service = new DeploymentProviderService({
      tts: {
        source: 'bundled', engine: 'kokoro', baseUrl: 'http://127.0.0.1:8880/v1',
        model: 'kokoro', voice: 'af_heart'
      }
    }, async (input) => {
      assert.equal(String(input), 'http://127.0.0.1:8880/health')
      return new Response('OK')
    })
    assert.equal((await service.list()).tts?.readiness.state, 'ready')
  })
})

describe('deployment provider API', () => {
  it('requires authentication and returns configured deployment choices', async () => {
    const app = await buildApp({
      databasePath: ':memory:',
      secretKey: randomBytes(32),
      logger: false,
      registerFeatureRoutes: false,
      deploymentProviders: {
        stt: {
          source: 'external', engine: 'openai-compatible', baseUrl: 'https://speech.example/v1',
          model: 'whisper'
        }
      }
    })
    await app.ready()
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/providers/deployment' })).statusCode, 401)
      const owner = cookie(await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      }))
      const response = await app.inject({
        method: 'GET', url: '/api/providers/deployment', headers: { cookie: owner }
      })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), {
        providers: {
          stt: {
            source: 'external', engine: 'openai-compatible', baseUrl: 'https://speech.example/v1',
            model: 'whisper', readiness: { state: 'unchecked', checkedAt: null }
          }
        }
      })
    } finally {
      await app.close()
    }
  })
})
