import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/database.ts'
import { SecretStore } from '../src/secrets.ts'
import { EmbeddingProviderService, requestEmbeddings } from '../src/semantic.ts'
import { TtsService } from '../src/tts.ts'
import { SttService } from '../src/stt.ts'
import { type DeploymentProviderConfigMap } from '../src/deployment-providers.ts'

const defaults: DeploymentProviderConfigMap = {
  embeddings: { source: 'external', engine: 'tei', baseUrl: 'http://embed.internal/v1/', model: 'minilm', batchSize: 16 },
  tts: { source: 'bundled', engine: 'kokoro', baseUrl: 'http://tts.internal/v1', model: 'kokoro', voice: 'af_heart' },
  stt: { source: 'bundled', engine: 'speaches', baseUrl: 'http://stt.internal/v1', model: 'whisper' }
}

describe('effective deployment defaults', () => {
  it('wires keyless defaults into account APIs, preserves overrides and explicit opt-outs', async () => {
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false,
      registerFeatureRoutes: false, deploymentProviders: defaults
    })
    try {
      const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
        username: 'Owner', password: 'correct horse battery staple'
      } })
      const headers = { cookie: String(bootstrap.headers['set-cookie']).split(';')[0]! }
      const get = async (url: string) => (await app.inject({ method: 'GET', url, headers })).json()
      const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, headers, payload })
      assert.deepEqual((await get('/api/embeddings/provider')).provider, {
        kind: 'local', baseUrl: 'http://embed.internal/v1', model: 'minilm', batchSize: 16,
        hasApiKey: false, deploymentDefault: true
      })
      for (const capability of ['tts', 'stt'] as const) {
        const url = `/api/${capability}/config`
        const config = (await get(url)).config
        assert.equal(config.deploymentDefault, true)
        assert.deepEqual(config.order, ['local', 'browser'])
        assert.equal(config.local.model, defaults[capability]!.model)
        assert.equal(config.local.hasApiKey, false)
        const invalid = await put(url, { order: ['local'], local: null })
        assert.equal(invalid.statusCode, 400)
        assert.equal((await get(url)).config.deploymentDefault, true)
        const override = { ...config.local, baseUrl: 'http://account.internal/v1', model: 'account-model' }
        const saved = await put(url, { order: ['local'], local: override })
        assert.equal(saved.statusCode, 200)
        assert.equal((await get(url)).config.local.baseUrl, override.baseUrl)
        assert.equal((await get(url)).config.deploymentDefault, undefined)
        assert.equal((await put(url, { order: ['browser'], local: null })).statusCode, 200)
        assert.deepEqual((await get(url)).config.order, ['browser'])
        assert.equal((await get(url)).config.local, null)
      }
      const url = '/api/embeddings/provider'
      assert.equal((await put(url, { kind: 'local', model: '', baseUrl: 'file:///bad' })).statusCode, 400)
      assert.equal((await get(url)).provider.deploymentDefault, true)
      assert.equal((await put(url, { kind: 'local', model: 'account-model', baseUrl: 'http://account.internal/v1' })).statusCode, 200)
      assert.equal((await get(url)).provider.model, 'account-model')
      assert.equal((await get(url)).provider.deploymentDefault, undefined)
      assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 204)
      assert.equal((await get(url)).provider, null)
      assert.equal((await put(url, { kind: 'local', model: 'minilm', baseUrl: 'http://embed.internal/v1' })).statusCode, 200)
      assert.equal((await get(url)).provider.kind, 'local')
      assert.equal((await get('/api/ai/provider')).provider, null)
    } finally {
      await app.close()
    }
  })

  it('rejects invalid descriptors at the application and service boundaries', async () => {
    const db = openDatabase(':memory:')
    const secrets = new SecretStore(db, randomBytes(32))
    try {
      const invalid = { ...defaults.embeddings!, baseUrl: 'https://user:secret@provider/v1' }
      await assert.rejects(buildApp({ databasePath: ':memory:', secretKey: randomBytes(32), deploymentProviders: { embeddings: invalid } }), /credentials/)
      assert.throws(() => new EmbeddingProviderService(db, secrets, invalid), /credentials/)
      assert.throws(() => new EmbeddingProviderService(db, secrets, { ...defaults.embeddings!, batchSize: 0 }), /between 1 and 64/)
      assert.throws(() => new TtsService(db, secrets, { ...defaults.tts!, voice: '' }), /voice is required/)
      assert.throws(() => new SttService(db, secrets, { ...defaults.stt!, baseUrl: 'file:///tmp/speech' }), /HTTP or HTTPS/)
    } finally {
      db.close()
    }
  })

  it('uses defaults for real requests without leaking orphaned account keys and surfaces upstream failures', async () => {
    let failing = false
    const paths: string[] = []
    const upstream = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, undefined)
      paths.push(request.url!)
      for await (const _chunk of request) { /* Drain the provider request. */ }
      if (failing) { response.writeHead(400); response.end('provider unavailable'); return }
      if (request.url === '/v1/embeddings') response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))
      else if (request.url === '/v1/audio/transcriptions') response.end(JSON.stringify({ text: 'Love one another.' }))
      else { response.setHeader('content-type', 'audio/mpeg'); response.end('audio') }
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO users VALUES ('owner', 'Owner', 'owner', 'hash', 'admin', NULL, 1)").run()
    const secrets = new SecretStore(db, randomBytes(32))
    for (const name of ['embedding-provider-api-key', 'tts-local-api-key', 'stt-local-api-key']) secrets.set('owner', name, 'orphan-secret')
    const embeddings = new EmbeddingProviderService(db, secrets, { ...defaults.embeddings!, baseUrl })
    const tts = new TtsService(db, secrets, { ...defaults.tts!, baseUrl })
    const stt = new SttService(db, secrets, { ...defaults.stt!, baseUrl })
    try {
      assert.deepEqual(await requestEmbeddings(embeddings.credentials('owner'), ['Love']), [[1, 0]])
      assert.equal((await tts.speech('owner', { provider: 'local', text: 'Love' })).audio.toString(), 'audio')
      assert.equal(await stt.transcribe('owner', 'local', Buffer.from('recording')), 'Love one another.')
      assert.deepEqual(paths, ['/v1/embeddings', '/v1/audio/speech', '/v1/audio/transcriptions'])
      failing = true
      await assert.rejects(requestEmbeddings(embeddings.credentials('owner'), ['Love']), /provider unavailable/)
      await assert.rejects(tts.speech('owner', { provider: 'local', text: 'Love' }), /HTTP 400/)
      await assert.rejects(stt.transcribe('owner', 'local', Buffer.from('recording')), /provider unavailable/)
      tts.save('owner', { order: ['browser'] })
      stt.save('owner', { order: ['browser'] })
      const count = paths.length
      await assert.rejects(tts.speech('owner', { provider: 'local', text: 'Love' }), /not enabled/)
      await assert.rejects(stt.transcribe('owner', 'local', Buffer.from('recording')), /not enabled/)
      assert.equal(paths.length, count)
    } finally {
      db.close()
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
    }
  })
})
