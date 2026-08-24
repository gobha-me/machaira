import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/database.ts'

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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw) as Record<string, unknown>
}

const local = {
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8880/v1',
  model: 'kokoro',
  voice: 'af_heart'
}

const cloud = {
  provider: 'venice',
  baseUrl: 'https://api.venice.ai/api/v1',
  model: 'tts-kokoro',
  voice: 'af_sky'
}

describe('TTS configuration API', () => {
  it('isolates redacted provider configuration and encrypts keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-tts-'))
    const filename = join(dir, 'machaira.sqlite')
    const app = await buildApp({
      databasePath: filename, secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const owner = cookie(await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      }))
      const saved = await app.inject({
        method: 'PUT', url: '/api/tts/config', headers: { cookie: owner },
        payload: {
          order: ['local', 'browser', 'cloud'],
          local: { ...local, apiKey: 'local-secret' },
          cloud: { ...cloud, apiKey: 'cloud-secret' }
        }
      })
      assert.equal(saved.statusCode, 200)
      assert.deepEqual(saved.json().config, {
        order: ['local', 'browser', 'cloud'],
        local: { ...local, hasApiKey: true },
        cloud: { ...cloud, hasApiKey: true }
      })
      assert.doesNotMatch(saved.body, /local-secret|cloud-secret/)

      await app.inject({
        method: 'POST', url: '/api/users', headers: { cookie: owner },
        payload: { username: 'Reader', password: 'reader secure password', role: 'member' }
      })
      const member = cookie(await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: 'Reader', password: 'reader secure password' }
      }))
      assert.deepEqual((await app.inject({
        method: 'GET', url: '/api/tts/config', headers: { cookie: member }
      })).json().config, { order: ['browser'], local: null, cloud: null })

      const preserved = await app.inject({
        method: 'PUT', url: '/api/tts/config', headers: { cookie: owner },
        payload: { order: ['cloud'], local: null, cloud: { ...cloud, model: 'tts-other' } }
      })
      assert.equal(preserved.statusCode, 200)
      assert.equal(preserved.json().config.cloud.hasApiKey, true)
      assert.equal(preserved.json().config.local, null)

      const changedCloudIdentity = await app.inject({
        method: 'PUT', url: '/api/tts/config', headers: { cookie: owner },
        payload: {
          order: ['cloud'], local: null,
          cloud: { ...cloud, baseUrl: 'https://api.openai.com/v1' }
        }
      })
      assert.equal(changedCloudIdentity.statusCode, 400)

      for (const payload of [
        { order: ['cloud'], local: null, cloud: null },
        { order: ['browser', 'browser'], local: null, cloud: null },
        { order: ['local'], local: { ...local, provider: 'venice' }, cloud: null },
        { order: ['cloud'], local: null, cloud: { ...cloud, clearApiKey: true } }
      ]) {
        assert.equal((await app.inject({
          method: 'PUT', url: '/api/tts/config', headers: { cookie: member }, payload
        })).statusCode, 400)
      }
    } finally {
      await app.close()
    }
    const bytes = await readFile(filename)
    assert.equal(bytes.includes(Buffer.from('local-secret')), false)
    assert.equal(bytes.includes(Buffer.from('cloud-secret')), false)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('TTS speech proxy', () => {
  it('normalizes local and cloud requests without exposing credentials', async () => {
    const requests: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = []
    const upstream = await listen(async (request, response) => {
      requests.push({ headers: request.headers, body: await requestBody(request) })
      response.writeHead(200, { 'content-type': 'audio/mpeg' })
      response.end(Buffer.from('fake-mp3'))
    })
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const session = cookie(await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      }))
      await app.inject({
        method: 'PUT', url: '/api/tts/config', headers: { cookie: session },
        payload: {
          order: ['local', 'cloud'],
          local: { ...local, baseUrl: upstream.baseUrl },
          cloud: { ...cloud, baseUrl: upstream.baseUrl, apiKey: 'venice-key' }
        }
      })

      const localSpeech = await app.inject({
        method: 'POST', url: '/api/tts/speech', headers: { cookie: session },
        payload: { provider: 'local', text: 'In the beginning' }
      })
      assert.equal(localSpeech.statusCode, 200)
      assert.equal(localSpeech.headers['content-type'], 'audio/mpeg')
      assert.equal(localSpeech.rawPayload.toString(), 'fake-mp3')
      assert.equal(requests[0].headers.authorization, undefined)
      assert.deepEqual(requests[0].body, {
        model: 'kokoro', voice: 'af_heart', input: 'In the beginning',
        response_format: 'mp3', speed: 1
      })

      const cloudSpeech = await app.inject({
        method: 'POST', url: '/api/tts/speech', headers: { cookie: session },
        payload: { provider: 'cloud', text: 'The Word was with God' }
      })
      assert.equal(cloudSpeech.statusCode, 200)
      assert.equal(requests[1].headers.authorization, 'Bearer venice-key')
      assert.equal(requests[1].body.model, 'tts-kokoro')

      await app.inject({
        method: 'PUT', url: '/api/tts/config', headers: { cookie: session },
        payload: {
          order: ['browser'], local: { ...local, baseUrl: upstream.baseUrl },
          cloud: { ...cloud, baseUrl: upstream.baseUrl }
        }
      })
      assert.equal((await app.inject({
        method: 'POST', url: '/api/tts/speech', headers: { cookie: session },
        payload: { provider: 'cloud', text: 'must not leave' }
      })).statusCode, 400)
      assert.equal(requests.length, 2)
    } finally {
      await app.close()
      await upstream.close()
    }
  })

  it('rejects provider errors, non-audio responses, and oversized audio', async () => {
    let mode: 'error' | 'json' | 'large' = 'error'
    const upstream = await listen((_request, response) => {
      if (mode === 'error') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end('{"error":"slow down"}')
      } else if (mode === 'json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      } else {
        response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': `${11 * 1024 * 1024}` })
        response.end('too-large')
      }
    })
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const session = cookie(await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      }))
      await app.inject({
        method: 'PUT', url: '/api/tts/config', headers: { cookie: session },
        payload: { order: ['local'], local: { ...local, baseUrl: upstream.baseUrl }, cloud: null }
      })
      for (const expected of [/429/, /did not return audio/, /oversized audio/]) {
        const response = await app.inject({
          method: 'POST', url: '/api/tts/speech', headers: { cookie: session },
          payload: { provider: 'local', text: 'test' }
        })
        assert.equal(response.statusCode, 502)
        assert.match(response.json().error, expected)
        mode = mode === 'error' ? 'json' : 'large'
      }
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

describe('TTS schema migration', () => {
  it('upgrades schema v5 and cascades TTS metadata with its user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-tts-migration-'))
    const filename = join(dir, 'machaira.sqlite')
    const old = new Database(filename)
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (5, 1);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled_at INTEGER, created_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('user-1', 'Owner', 'owner', 'hash', 'admin', NULL, 1);
    `)
    old.close()
    const db = openDatabase(filename)
    try {
      const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
      assert.equal(version.version, 8)
      db.prepare(`
        INSERT INTO tts_configs (user_id, provider_order_json, updated_at)
        VALUES ('user-1', '["browser"]', 1)
      `).run()
      db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
      const count = db.prepare('SELECT COUNT(*) AS count FROM tts_configs').get() as { count: number }
      assert.equal(count.count, 0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
