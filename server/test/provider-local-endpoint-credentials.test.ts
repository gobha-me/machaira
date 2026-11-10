import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { AiInputError, AiProviderService, streamProviderChat } from '../src/ai.ts'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/database.ts'
import { SecretStore } from '../src/secrets.ts'
import { EmbeddingProviderService, requestEmbeddings, SemanticInputError } from '../src/semantic.ts'

type ServiceKind = 'chat' | 'embeddings'
const serviceKinds: ServiceKind[] = ['chat', 'embeddings']
const chatInput = {
  passage: { reference: 'John 1:1', module: 'WEB', content: 'In the beginning was the Word.' },
  messages: [{ role: 'user' as const, content: 'Explain this passage.' }],
  preferences: { alwaysCite: true, drawApocrypha: false }
}

function fixture(t: TestContext, kind: ServiceKind) {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  for (const id of ['owner', 'reader']) {
    db.prepare(`
      INSERT INTO users (id, username, username_normalized, password_hash, role, created_at)
      VALUES (?, ?, ?, 'unused-hash', 'member', 1)
    `).run(id, id, id)
  }
  const secrets = new SecretStore(db, randomBytes(32))
  const chat = new AiProviderService(db, secrets)
  const embeddings = new EmbeddingProviderService(db, secrets)
  const service = kind === 'chat' ? chat : embeddings
  const otherService = kind === 'chat' ? embeddings : chat
  const secretName = kind === 'chat' ? 'ai-provider-api-key' : 'embedding-provider-api-key'
  return {
    db, service, otherService,
    secretCount: () => (db.prepare(
      'SELECT count(*) AS total FROM user_secrets WHERE user_id = ? AND name = ?'
    ).get('owner', secretName) as { total: number }).total,
    ciphertext: () => (db.prepare(
      'SELECT ciphertext FROM user_secrets WHERE user_id = ? AND name = ?'
    ).get('owner', secretName) as { ciphertext: Buffer }).ciphertext,
    async request() {
      if (kind === 'chat') {
        let text = ''
        for await (const delta of streamProviderChat(chat.credentials('owner'), chatInput)) text += delta
        assert.equal(text, 'A safe reply')
      } else {
        assert.deepEqual(await requestEmbeddings(embeddings.credentials('owner'), ['light', 'truth']), [[1, 0], [1, 1]])
      }
    }
  }
}

async function upstream(t: TestContext, original: string, replacement: string) {
  const requests: { path: string; credential: string }[] = []
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization
    requests.push({
      path: request.url ?? '',
      // Record labels so even a failing assertion cannot print a credential.
      credential: authorization === undefined ? 'none'
        : authorization === `Bearer ${original}` ? 'original'
          : authorization === `Bearer ${replacement}` ? 'replacement' : 'unexpected'
    })
    if (request.url?.endsWith('/embeddings')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ index: 1, embedding: [1, 1] }, { index: 0, embedding: [1, 0] }] }))
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"A safe reply"}}]}\n\ndata: [DONE]\n\n')
    }
    request.resume()
  })
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

function keys() {
  return { original: randomBytes(24).toString('hex'), replacement: randomBytes(24).toString('hex') }
}

describe('local provider endpoint credential isolation', () => {
  for (const kind of serviceKinds) {
    for (const boundary of ['port', 'path'] as const) {
      const urls = async (t: TestContext, original: string, replacement: string) => {
        const first = await upstream(t, original, replacement)
        const second = boundary === 'port' ? await upstream(t, original, replacement) : first
        return { first, second, destination: boundary === 'path' ? `${first.baseUrl}/different-gateway` : second.baseUrl }
      }

      it(`${kind}: clears visible key status when only the local ${boundary} changes`, async t => {
        const f = fixture(t, kind)
        const { original, replacement } = keys()
        const { first, destination } = await urls(t, original, replacement)
        f.service.save('owner', { kind: 'local', baseUrl: first.baseUrl, model: 'model', apiKey: original })
        const changed = f.service.save('owner', { kind: 'local', baseUrl: destination, model: 'model' })
        assert.equal(changed.hasApiKey, false)
        assert.equal(changed.baseUrl, destination)
        assert.equal(f.secretCount(), 0)
      })

      it(`${kind}: removes decrypted credentials when only the local ${boundary} changes`, async t => {
        const f = fixture(t, kind)
        const { original, replacement } = keys()
        const { first, destination } = await urls(t, original, replacement)
        f.service.save('owner', { kind: 'local', baseUrl: first.baseUrl, model: 'model', apiKey: original })
        f.service.save('owner', { kind: 'local', baseUrl: destination, model: 'model' })
        assert.equal(f.service.credentials('owner').apiKey === null, true, 'the new endpoint must be keyless')
      })

      it(`${kind}: never sends the old key to a changed local ${boundary} and supports later replacement`, async t => {
        const f = fixture(t, kind)
        const { original, replacement } = keys()
        const { first, second, destination } = await urls(t, original, replacement)
        f.service.save('owner', { kind: 'local', baseUrl: first.baseUrl, model: 'model', apiKey: original })
        await f.request()
        assert.equal(first.requests.at(-1)?.credential, 'original')
        f.service.save('owner', { kind: 'local', baseUrl: destination, model: 'model' })
        await f.request()
        assert.equal(second.requests.at(-1)?.credential, 'none')
        assert.equal(second.requests.at(-1)?.path, `${new URL(destination).pathname}/${kind === 'chat' ? 'chat/completions' : 'embeddings'}`)

        f.service.save('owner', { kind: 'local', baseUrl: destination, model: 'another-model' })
        await f.request()
        assert.equal(second.requests.at(-1)?.credential, 'none')
        f.service.save('owner', { kind: 'local', baseUrl: first.baseUrl, model: 'model', apiKey: replacement })
        await f.request()
        assert.equal(first.requests.at(-1)?.credential, 'replacement')
        f.service.save('owner', { kind: 'local', baseUrl: destination, model: 'model', clearApiKey: true })
        await f.request()
        assert.equal(second.requests.at(-1)?.credential, 'none')
      })
    }

    it(`${kind}: isolates an endpoint change from other users and the other provider service`, t => {
      const f = fixture(t, kind)
      const { original } = keys()
      const config = { kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'model', apiKey: original }
      f.service.save('owner', config)
      f.service.save('reader', config)
      f.otherService.save('owner', config)
      assert.equal(f.ciphertext().includes(Buffer.from(original)), false)
      f.service.save('owner', { ...config, baseUrl: 'http://127.0.0.1:11435/v1', apiKey: undefined })
      assert.equal(f.secretCount(), 0)
      assert.equal(f.service.get('reader')?.hasApiKey, true)
      assert.equal(f.service.credentials('reader').apiKey === original, true)
      assert.equal(f.otherService.get('owner')?.hasApiKey, true)
      assert.equal(f.otherService.credentials('owner').apiKey === original, true)
    })

    it(`${kind}: rejects conflicting replacement/clear atomically before a valid endpoint switch`, t => {
      const f = fixture(t, kind)
      const { original, replacement } = keys()
      const before = f.service.save('owner', {
        kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'model', apiKey: original
      })
      const ciphertext = f.ciphertext()
      const changed = { kind: 'local', baseUrl: 'http://127.0.0.1:11434/other', model: 'changed' }
      assert.throws(() => f.service.save('owner', { ...changed, apiKey: replacement, clearApiKey: true }), {
        name: 'Error', message: 'Cannot replace and clear the API key together'
      })
      assert.deepEqual(f.service.get('owner'), before)
      assert.equal(f.ciphertext().equals(ciphertext), true)
      assert.equal(f.service.credentials('owner').apiKey === original, true)
      assert.equal(f.service.save('owner', changed).hasApiKey, false)
    })

    it(`${kind}: preserves normalized URLs, model edits and cloud migration before a real local path change`, t => {
      const f = fixture(t, kind)
      const { original } = keys()
      const initial = { kind: 'local', baseUrl: 'http://localhost:11434/v1/', model: 'first', apiKey: original }
      f.service.save('owner', initial)
      const equivalent = f.service.save('owner', {
        kind: 'local', baseUrl: 'http://LOCALHOST:11434/v1///', model: 'second', batchSize: 7
      })
      assert.equal(equivalent.baseUrl, 'http://localhost:11434/v1')
      assert.equal(equivalent.hasApiKey, true)
      assert.equal(f.service.credentials('owner').apiKey === original, true)
      if ('batchSize' in equivalent) assert.equal(equivalent.batchSize, 7)

      const cloud = { kind: 'openai-compatible', baseUrl: 'https://first.example/v1', model: 'cloud', apiKey: original }
      f.service.save('owner', cloud)
      const migrated = f.service.save('owner', { ...cloud, baseUrl: 'https://second.example/gateway', apiKey: undefined })
      assert.equal(migrated.hasApiKey, true)
      assert.equal(f.service.credentials('owner').apiKey === original, true)
      assert.throws(() => f.service.save('owner', {
        kind: 'local', baseUrl: initial.baseUrl, model: 'local', clearApiKey: 'true'
      }), kind === 'chat' ? AiInputError : SemanticInputError)
      assert.deepEqual(f.service.get('owner'), migrated)
      f.service.save('owner', initial)
      assert.equal(f.service.save('owner', { ...initial, baseUrl: 'http://localhost:11434/v2', apiKey: undefined }).hasApiKey, false)
    })
  }
})

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value)
  return value.split(';', 1)[0]
}

describe('authenticated local endpoint credential updates', () => {
  for (const kind of serviceKinds) {
    it(`${kind}: persists a keyless, redacted endpoint switch and preserves the other account`, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'machaira-local-endpoint-'))
      const { original, replacement } = keys()
      const first = await upstream(t, original, replacement)
      const second = await upstream(t, original, replacement)
      const filename = join(dir, 'test.sqlite')
      const app = await buildApp({
        databasePath: filename, secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
      })
      const db = openDatabase(filename)
      t.after(async () => {
        db.close()
        await app.close()
        await rm(dir, { recursive: true, force: true })
      })
      await app.ready()
      const owner = cookie(await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'test owner password 208' }
      }))
      const created = await app.inject({
        method: 'POST', url: '/api/users', headers: { cookie: owner },
        payload: { username: 'Reader', password: 'test reader password 208', role: 'member' }
      })
      assert.equal(created.statusCode, 201)
      const reader = cookie(await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { username: 'Reader', password: 'test reader password 208' }
      }))
      const url = kind === 'chat' ? '/api/ai/provider' : '/api/embeddings/provider'
      const originalConfig = { kind: 'local', baseUrl: first.baseUrl, model: 'model', apiKey: original }
      for (const session of [owner, reader]) {
        const saved = await app.inject({ method: 'PUT', url, headers: { cookie: session }, payload: originalConfig })
        assert.equal(saved.statusCode, 200)
        assert.equal(saved.body.includes(original), false)
      }
      const rows = db.prepare('SELECT ciphertext FROM user_secrets').all() as { ciphertext: Buffer }[]
      assert.equal(rows.length, 2)
      assert.equal(rows.some(row => row.ciphertext.includes(Buffer.from(original))), false)

      const changed = { kind: 'local', baseUrl: second.baseUrl, model: 'changed' }
      assert.equal((await app.inject({ method: 'PUT', url, payload: changed })).statusCode, 401)
      const rejected = await app.inject({
        method: 'PUT', url, headers: { cookie: owner }, payload: { ...changed, apiKey: replacement, clearApiKey: true }
      })
      assert.equal(rejected.statusCode, 400)
      assert.equal(rejected.body.includes(original) || rejected.body.includes(replacement), false)
      const switched = await app.inject({ method: 'PUT', url, headers: { cookie: owner }, payload: changed })
      assert.equal(switched.statusCode, 200)
      assert.equal(switched.json().provider.hasApiKey, false)
      assert.equal(switched.body.includes(original), false)
      const persisted = await app.inject({ method: 'GET', url, headers: { cookie: owner } })
      assert.equal(persisted.json().provider.baseUrl, second.baseUrl)
      assert.equal(persisted.json().provider.hasApiKey, false)
      const other = await app.inject({ method: 'GET', url, headers: { cookie: reader } })
      assert.equal(other.json().provider.baseUrl, first.baseUrl)
      assert.equal(other.json().provider.hasApiKey, true)
      assert.equal((db.prepare('SELECT count(*) AS total FROM user_secrets').get() as { total: number }).total, 1)

      if (kind === 'chat') {
        const conversation = (await app.inject({
          method: 'POST', url: '/api/ai/conversations', headers: { cookie: owner }
        })).json().conversation
        const response = await app.inject({
          method: 'POST', url: `/api/ai/conversations/${conversation.id}/messages`, headers: { cookie: owner },
          payload: { content: 'Explain this passage.', passage: chatInput.passage, preferences: chatInput.preferences }
        })
        assert.match(response.body, /event: done/)
        assert.doesNotMatch(response.body, /event: error/)
        assert.equal(second.requests.at(-1)?.credential, 'none')
      }
    })
  }
})
