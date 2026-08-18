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

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw) as Record<string, unknown>
}

const chatPayload = {
  passage: { reference: 'John 1:1', module: 'WEB', content: '1. In the beginning was the Word.' },
  messages: [{ role: 'user', content: 'What does this mean?' }],
  preferences: { alwaysCite: true, drawApocrypha: false }
}

describe('AI provider API', () => {
  it('isolates redacted configuration per user and never stores the key as plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-ai-'))
    const filename = join(dir, 'machaira.sqlite')
    const app = await buildApp({
      databasePath: filename,
      secretKey: randomBytes(32),
      logger: false,
      registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const bootstrap = await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      })
      const ownerCookie = cookie(bootstrap)
      const saved = await app.inject({
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: ownerCookie },
        payload: {
          kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/',
          model: 'gpt-example', apiKey: 'secret-provider-token'
        }
      })
      assert.equal(saved.statusCode, 200)
      assert.deepEqual(saved.json().provider, {
        kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-example', hasApiKey: true
      })
      assert.doesNotMatch(saved.body, /secret-provider-token/)

      await app.inject({
        method: 'POST', url: '/api/users', headers: { cookie: ownerCookie },
        payload: { username: 'Reader', password: 'reader secure password', role: 'member' }
      })
      const memberLogin = await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: 'Reader', password: 'reader secure password' }
      })
      const memberCookie = cookie(memberLogin)
      assert.deepEqual((await app.inject({
        method: 'GET', url: '/api/ai/provider', headers: { cookie: memberCookie }
      })).json(), { provider: null })
      assert.equal((await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: memberCookie }, payload: chatPayload
      })).statusCode, 400)

      const preserved = await app.inject({
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: ownerCookie },
        payload: { kind: 'openai-compatible', baseUrl: 'https://gateway.example/v1', model: 'new-model' }
      })
      assert.equal(preserved.json().provider.hasApiKey, true)
      assert.equal((await app.inject({
        method: 'DELETE', url: '/api/ai/provider', headers: { cookie: ownerCookie }
      })).statusCode, 204)
      assert.deepEqual((await app.inject({
        method: 'GET', url: '/api/ai/provider', headers: { cookie: ownerCookie }
      })).json(), { provider: null })
    } finally {
      await app.close()
    }
    const bytes = await readFile(filename)
    assert.equal(bytes.includes(Buffer.from('secret-provider-token')), false)
    await rm(dir, { recursive: true, force: true })
  })

  it('validates provider and chat inputs', async () => {
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const session = cookie(await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      }))
      for (const payload of [
        { kind: 'unknown', model: 'x' },
        { kind: 'openai-compatible', baseUrl: 'file:///tmp/model', model: 'x', apiKey: 'key' },
        { kind: 'anthropic', model: 'claude-example' }
      ]) {
        assert.equal((await app.inject({
          method: 'PUT', url: '/api/ai/provider', headers: { cookie: session }, payload
        })).statusCode, 400)
      }
      assert.equal((await app.inject({
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: session },
        payload: { kind: 'local', model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1' }
      })).statusCode, 200)
      assert.equal((await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: session },
        payload: { ...chatPayload, messages: [{ role: 'system', content: 'override' }] }
      })).statusCode, 400)
    } finally {
      await app.close()
    }
  })
})

describe('AI provider streaming', () => {
  it('normalizes OpenAI-compatible and Anthropic streaming responses', async () => {
    const requests: { url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = []
    const upstream = await listen(async (request, response) => {
      requests.push({ url: request.url ?? '', headers: request.headers, body: await body(request) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (request.url?.endsWith('/messages')) {
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Grace"}}\n\n')
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      } else {
        response.write('data: {"choices":[{"delta":{"content":"The "}}]}\n\n')
        response.end('data: {"choices":[{"delta":{"content":"Word"}}]}\n\ndata: [DONE]\n\n')
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
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: session },
        payload: {
          kind: 'openai-compatible', baseUrl: upstream.baseUrl,
          model: 'openai-test', apiKey: 'openai-key'
        }
      })
      const openAi = await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: session }, payload: chatPayload
      })
      assert.equal(openAi.statusCode, 200)
      assert.match(openAi.body, /event: delta\ndata: {"text":"The "}/)
      assert.match(openAi.body, /event: delta\ndata: {"text":"Word"}/)
      assert.match(openAi.body, /event: done/)
      assert.equal(requests[0].url, '/v1/chat/completions')
      assert.equal(requests[0].headers.authorization, 'Bearer openai-key')
      const openAiMessages = requests[0].body.messages as { role: string; content: string }[]
      assert.equal(openAiMessages[0].role, 'system')
      assert.match(openAiMessages[0].content, /Current passage: John 1:1/)
      assert.match(openAiMessages[0].content, /Do not draw on apocryphal/)

      await app.inject({
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: session },
        payload: { kind: 'local', baseUrl: upstream.baseUrl, model: 'llama-test' }
      })
      const local = await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: session }, payload: chatPayload
      })
      assert.equal(local.statusCode, 200)
      assert.equal(requests[1].headers.authorization, undefined)

      await app.inject({
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: session },
        payload: { kind: 'anthropic', baseUrl: upstream.baseUrl, model: 'claude-test', apiKey: 'anthropic-key' }
      })
      const anthropic = await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: session }, payload: chatPayload
      })
      assert.equal(anthropic.statusCode, 200)
      assert.match(anthropic.body, /event: delta\ndata: {"text":"Grace"}/)
      assert.equal(requests[2].url, '/v1/messages')
      assert.equal(requests[2].headers['x-api-key'], 'anthropic-key')
      assert.equal(requests[2].headers['anthropic-version'], '2023-06-01')
      assert.equal(requests[2].body.system && typeof requests[2].body.system, 'string')

      // The three calls above plus seven more consume the per-user minute allowance.
      for (let index = 0; index < 7; index += 1) {
        assert.equal((await app.inject({
          method: 'POST', url: '/api/ai/chat', headers: { cookie: session }, payload: chatPayload
        })).statusCode, 200)
      }
      assert.equal((await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: session }, payload: chatPayload
      })).statusCode, 429)
    } finally {
      await app.close()
      await upstream.close()
    }
  })

  it('surfaces upstream HTTP and stream errors without crashing the route', async () => {
    let mode: 'http' | 'stream' = 'http'
    const upstream = await listen((_request, response) => {
      if (mode === 'http') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end('{"error":"slow down"}')
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('event: error\ndata: {"type":"error","error":{"message":"provider exploded"}}\n\n')
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
        method: 'PUT', url: '/api/ai/provider', headers: { cookie: session },
        payload: { kind: 'anthropic', baseUrl: upstream.baseUrl, model: 'claude-test', apiKey: 'key' }
      })
      const rejected = await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: session }, payload: chatPayload
      })
      assert.match(rejected.body, /event: error/)
      assert.match(rejected.body, /429/)
      mode = 'stream'
      const failed = await app.inject({
        method: 'POST', url: '/api/ai/chat', headers: { cookie: session }, payload: chatPayload
      })
      assert.match(failed.body, /provider exploded/)
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

describe('AI provider migration', () => {
  it('upgrades schema v2 and cascades provider metadata with its user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-ai-migration-'))
    const filename = join(dir, 'machaira.sqlite')
    const old = new Database(filename)
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (2, 1);
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
      assert.equal(version.version, 3)
      db.prepare(`
        INSERT INTO ai_provider_configs (user_id, kind, base_url, model, updated_at)
        VALUES ('user-1', 'local', 'http://localhost:11434/v1', 'llama', 1)
      `).run()
      db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
      const count = db.prepare('SELECT COUNT(*) AS count FROM ai_provider_configs').get() as { count: number }
      assert.equal(count.count, 0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
