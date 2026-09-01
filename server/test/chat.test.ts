import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { buildApp } from '../src/app.ts'
import { ChatConflictError, ChatConversationService } from '../src/chat.ts'
import { openDatabase } from '../src/database.ts'

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value)
  return value.split(';', 1)[0]
}

const turn = (content: string, reference = 'John 1:1') => ({
  content,
  passage: { reference, module: 'WEB', content: `Text for ${reference}` },
  preferences: { alwaysCite: true, drawApocrypha: false }
})

describe('chat conversation API', () => {
  it('supports CRUD while hiding conversations from other accounts', async () => {
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false,
      registerFeatureRoutes: false
    })
    await app.ready()
    try {
      const ownerCookie = cookie(await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      }))
      await app.inject({
        method: 'POST', url: '/api/users', headers: { cookie: ownerCookie },
        payload: { username: 'Reader', password: 'reader secure password', role: 'member' }
      })
      const memberCookie = cookie(await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: 'Reader', password: 'reader secure password' }
      }))

      const created = await app.inject({
        method: 'POST', url: '/api/ai/conversations', headers: { cookie: ownerCookie }
      })
      assert.equal(created.statusCode, 201)
      const id = created.json().conversation.id as string
      assert.equal(created.json().conversation.title, 'New chat')
      assert.deepEqual((await app.inject({
        method: 'GET', url: '/api/ai/conversations', headers: { cookie: memberCookie }
      })).json(), { conversations: [] })
      assert.equal((await app.inject({
        method: 'GET', url: `/api/ai/conversations/${id}`, headers: { cookie: memberCookie }
      })).statusCode, 404)
      assert.equal((await app.inject({
        method: 'PATCH', url: `/api/ai/conversations/${id}`, headers: { cookie: memberCookie },
        payload: { title: 'Stolen' }
      })).statusCode, 404)
      assert.equal((await app.inject({
        method: 'DELETE', url: `/api/ai/conversations/${id}`, headers: { cookie: memberCookie }
      })).statusCode, 404)
      assert.equal((await app.inject({
        method: 'POST', url: `/api/ai/conversations/${id}/messages`, headers: { cookie: memberCookie },
        payload: turn('Not mine')
      })).statusCode, 404)

      const renamed = await app.inject({
        method: 'PATCH', url: `/api/ai/conversations/${id}`, headers: { cookie: ownerCookie },
        payload: { title: 'Grace and truth' }
      })
      assert.equal(renamed.statusCode, 200)
      assert.equal(renamed.json().conversation.title, 'Grace and truth')
      assert.equal((await app.inject({
        method: 'PATCH', url: `/api/ai/conversations/${id}`, headers: { cookie: ownerCookie },
        payload: { title: ' ' }
      })).statusCode, 400)
      assert.equal((await app.inject({
        method: 'DELETE', url: `/api/ai/conversations/${id}`, headers: { cookie: ownerCookie }
      })).statusCode, 204)
      assert.equal((await app.inject({
        method: 'GET', url: `/api/ai/conversations/${id}`, headers: { cookie: ownerCookie }
      })).statusCode, 404)
    } finally {
      await app.close()
    }
  })
})

describe('chat conversation storage', () => {
  it('persists attempts, recovers streams, bounds provider history, and cascades account deletion', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare(`
        INSERT INTO users (id, username, username_normalized, password_hash, role, created_at)
        VALUES ('user-1', 'Owner', 'owner', 'hash', 'admin', 1)
      `).run()
      const chats = new ChatConversationService(db)
      const conversation = chats.create('user-1')

      const first = chats.startTurn('user-1', conversation.id, turn('What does this mean?'))
      assert.equal(first.conversation.title, 'What does this mean?')
      chats.appendDelta('user-1', conversation.id, first.assistantMessage.id, 'Partial')
      chats.fail('user-1', conversation.id, first.assistantMessage.id, 'interrupted', 'Stopped')
      const interrupted = chats.get('user-1', conversation.id)!
      assert.equal(interrupted.messages[1].content, 'Partial')
      assert.equal(interrupted.messages[1].status, 'interrupted')

      const retry = chats.startRetry(
        'user-1', conversation.id, first.assistantMessage.id,
        { preferences: { alwaysCite: true, drawApocrypha: false } }
      )
      assert.deepEqual(retry.providerInput.messages.map((message) => message.role), ['user'])
      chats.appendDelta('user-1', conversation.id, retry.assistantMessage.id, 'Complete')
      chats.complete('user-1', conversation.id, retry.assistantMessage.id)
      assert.equal(chats.get('user-1', conversation.id)!.messages.length, 3)

      for (let index = 2; index <= 12; index += 1) {
        const started = chats.startTurn(
          'user-1', conversation.id, turn(`Question ${index}`, `John 1:${index}`)
        )
        assert.ok(started.providerInput.messages.length <= 20)
        assert.equal(started.providerInput.messages.at(-1)?.role, 'user')
        assert.equal(started.providerInput.messages[0].role, 'user')
        chats.appendDelta('user-1', conversation.id, started.assistantMessage.id, `Answer ${index}`)
        chats.complete('user-1', conversation.id, started.assistantMessage.id)
      }

      const dangling = chats.startTurn('user-1', conversation.id, turn('One more'))
      chats.appendDelta('user-1', conversation.id, dangling.assistantMessage.id, 'Still running')
      assert.throws(
        () => chats.startTurn('user-1', conversation.id, turn('Too soon')),
        (error: unknown) => error instanceof ChatConflictError
      )
      assert.throws(
        () => chats.delete('user-1', conversation.id),
        (error: unknown) => error instanceof ChatConflictError
      )
      new ChatConversationService(db)
      const recovered = chats.get('user-1', conversation.id)!.messages.at(-1)!
      assert.equal(recovered.status, 'interrupted')
      assert.equal(recovered.content, 'Still running')

      db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
      assert.equal(chats.list('user-1').length, 0)
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count, 0)
    } finally {
      db.close()
    }
  })

  it('upgrades a version-8 database and cascades its new records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-chat-migration-'))
    const filename = join(dir, 'machaira.sqlite')
    const old = new Database(filename)
    old.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (8, 1);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE tts_configs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        provider_order_json TEXT NOT NULL,
        local_provider TEXT CHECK (local_provider IN ('openai-compatible')),
        local_base_url TEXT, local_model TEXT, local_voice TEXT,
        cloud_provider TEXT CHECK (cloud_provider IN ('openai-compatible', 'venice')),
        cloud_base_url TEXT, cloud_model TEXT, cloud_voice TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('user-1', 'Owner', 'owner', 'hash', 'admin', NULL, 1);
    `)
    old.close()

    const db = openDatabase(filename)
    try {
      assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get() as { version: number }).version, 10)
      const chats = new ChatConversationService(db)
      const conversation = chats.create('user-1')
      const started = chats.startTurn('user-1', conversation.id, turn('Persist me'))
      chats.fail('user-1', conversation.id, started.assistantMessage.id, 'failed', 'Unavailable')
      db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
      assert.equal(chats.list('user-1').length, 0)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
