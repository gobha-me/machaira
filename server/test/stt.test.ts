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

function wavFixture(durationSeconds = 0.25): Buffer {
  const sampleRate = 16_000
  const samples = Math.ceil(sampleRate * durationSeconds)
  const dataSize = samples * 2
  const output = Buffer.alloc(44 + dataSize)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + dataSize, 4)
  output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples; i += 1) {
    output.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 4000), 44 + i * 2)
  }
  return output
}

function multipartRecording(
  provider: 'local' | 'cloud',
  audio = wavFixture(),
  durationMs = 250,
  mimetype = 'audio/wav'
): { boundary: string; body: Buffer } {
  const boundary = `machaira-${randomBytes(8).toString('hex')}`
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="provider"\r\n\r\n${provider}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="durationMs"\r\n\r\n${durationMs}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\n`
      + `Content-Type: ${mimetype}\r\n\r\n`
    ),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]
  return { boundary, body: Buffer.concat(chunks) }
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

const local = {
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8000/v1',
  model: 'Systran/faster-whisper-small'
}

const cloud = {
  provider: 'venice',
  baseUrl: 'https://api.venice.ai/api/v1',
  model: 'nvidia/parakeet-tdt-0.6b-v3'
}

describe('STT configuration API', () => {
  it('isolates redacted provider configuration and encrypts keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-stt-'))
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
        method: 'PUT', url: '/api/stt/config', headers: { cookie: owner },
        payload: {
          order: ['local', 'browser', 'cloud'],
          local: { ...local, apiKey: 'local-stt-secret' },
          cloud: { ...cloud, apiKey: 'cloud-stt-secret' }
        }
      })
      assert.equal(saved.statusCode, 200)
      assert.deepEqual(saved.json().config, {
        order: ['local', 'browser', 'cloud'],
        local: { ...local, hasApiKey: true },
        cloud: { ...cloud, hasApiKey: true }
      })
      assert.doesNotMatch(saved.body, /local-stt-secret|cloud-stt-secret/)

      await app.inject({
        method: 'POST', url: '/api/users', headers: { cookie: owner },
        payload: { username: 'Reader', password: 'reader secure password', role: 'member' }
      })
      const member = cookie(await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: 'Reader', password: 'reader secure password' }
      }))
      assert.deepEqual((await app.inject({
        method: 'GET', url: '/api/stt/config', headers: { cookie: member }
      })).json().config, { order: ['browser'], local: null, cloud: null })

      const preserved = await app.inject({
        method: 'PUT', url: '/api/stt/config', headers: { cookie: owner },
        payload: { order: ['cloud'], local: null, cloud: { ...cloud, model: 'openai/whisper-large-v3' } }
      })
      assert.equal(preserved.statusCode, 200)
      assert.equal(preserved.json().config.cloud.hasApiKey, true)

      for (const payload of [
        { order: ['cloud'], local: null, cloud: null },
        { order: ['browser', 'browser'], local: null, cloud: null },
        { order: ['local'], local: { ...local, provider: 'venice' }, cloud: null },
        { order: ['cloud'], local: null, cloud: { ...cloud, clearApiKey: true } }
      ]) {
        assert.equal((await app.inject({
          method: 'PUT', url: '/api/stt/config', headers: { cookie: member }, payload
        })).statusCode, 400)
      }
    } finally {
      await app.close()
    }
    const bytes = await readFile(filename)
    assert.equal(bytes.includes(Buffer.from('local-stt-secret')), false)
    assert.equal(bytes.includes(Buffer.from('cloud-stt-secret')), false)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('STT provider boundary', () => {
  it('checks models and transcribes normalized recorded audio without exposing keys', async () => {
    const requests: { url: string; authorization: string | undefined; body: Buffer }[] = []
    const upstream = await listen(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body
      })
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: local.model }] }))
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ text: 'faith comes by hearing' }))
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
        method: 'PUT', url: '/api/stt/config', headers: { cookie: session },
        payload: {
          order: ['local', 'cloud'],
          local: { ...local, baseUrl: upstream.baseUrl },
          cloud: { ...cloud, baseUrl: upstream.baseUrl, apiKey: 'venice-stt-key' }
        }
      })

      const checked = await app.inject({
        method: 'POST', url: '/api/stt/check', headers: { cookie: session },
        payload: { tier: 'local' }
      })
      assert.equal(checked.statusCode, 200)
      assert.equal(checked.json().modelAvailable, true)

      const recording = multipartRecording('local')
      const transcribed = await app.inject({
        method: 'POST', url: '/api/stt/transcriptions',
        headers: {
          cookie: session,
          'content-type': `multipart/form-data; boundary=${recording.boundary}`
        },
        payload: recording.body
      })
      assert.equal(transcribed.statusCode, 200, transcribed.body)
      assert.deepEqual(transcribed.json(), { text: 'faith comes by hearing' })
      assert.equal(transcribed.headers['cache-control'], 'no-store')
      assert.equal(requests[0].authorization, undefined)
      assert.equal(requests[1].authorization, undefined)
      assert.match(requests[1].body.toString('latin1'), /Systran\/faster-whisper-small/)
      assert.match(requests[1].body.toString('latin1'), /recording\.wav/)
      assert.ok(requests[1].body.includes(Buffer.from('RIFF')))

      const cloudRecording = multipartRecording('cloud')
      const cloudResult = await app.inject({
        method: 'POST', url: '/api/stt/transcriptions',
        headers: {
          cookie: session,
          'content-type': `multipart/form-data; boundary=${cloudRecording.boundary}`
        },
        payload: cloudRecording.body
      })
      assert.equal(cloudResult.statusCode, 200)
      assert.equal(requests[2].authorization, 'Bearer venice-stt-key')
      assert.match(requests[2].body.toString('latin1'), /nvidia\/parakeet-tdt-0\.6b-v3/)
    } finally {
      await app.close()
      await upstream.close()
    }
  })

  it('rejects invalid formats, declared duration, and decoded recordings over one minute', async () => {
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
        method: 'PUT', url: '/api/stt/config', headers: { cookie: session },
        payload: { order: ['local'], local, cloud: null }
      })
      for (const recording of [
        multipartRecording('local', wavFixture(), 61_000),
        multipartRecording('local', wavFixture(), 250, 'application/octet-stream'),
        multipartRecording('local', wavFixture(60.1), 60_000)
      ]) {
        const response = await app.inject({
          method: 'POST', url: '/api/stt/transcriptions',
          headers: {
            cookie: session,
            'content-type': `multipart/form-data; boundary=${recording.boundary}`
          },
          payload: recording.body
        })
        assert.equal(response.statusCode, 400)
      }
    } finally {
      await app.close()
    }
  })

  it('allows only one active transcription per user and local provider', async () => {
    let signalStarted!: () => void
    let releaseUpstream!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseUpstream = resolve })
    const upstream = await listen(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the multipart request before holding the provider response.
      }
      signalStarted()
      await release
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: 'first recording' }))
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
        method: 'PUT', url: '/api/stt/config', headers: { cookie: session },
        payload: {
          order: ['local'],
          local: { ...local, baseUrl: upstream.baseUrl },
          cloud: null
        }
      })
      const injectRecording = () => {
        const recording = multipartRecording('local')
        return app.inject({
          method: 'POST', url: '/api/stt/transcriptions',
          headers: {
            cookie: session,
            'content-type': `multipart/form-data; boundary=${recording.boundary}`
          },
          payload: recording.body
        })
      }

      const first = injectRecording()
      await started
      const busy = await injectRecording()
      assert.equal(busy.statusCode, 429)
      assert.equal(busy.headers['retry-after'], '2')
      releaseUpstream()
      const completed = await first
      assert.equal(completed.statusCode, 200)
      assert.deepEqual(completed.json(), { text: 'first recording' })
    } finally {
      releaseUpstream()
      await app.close()
      await upstream.close()
    }
  })
})

describe('STT schema migration', () => {
  it('upgrades schema v6 and cascades STT metadata with its user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-stt-migration-'))
    const filename = join(dir, 'machaira.sqlite')
    const old = new Database(filename)
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (6, 1);
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
      assert.equal(version.version, 9)
      db.prepare(`
        INSERT INTO stt_configs (user_id, provider_order_json, updated_at)
        VALUES ('user-1', '["browser"]', 1)
      `).run()
      db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
      const count = db.prepare('SELECT COUNT(*) AS count FROM stt_configs').get() as { count: number }
      assert.equal(count.count, 0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
