import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/database.ts'

const cursor = { moduleName: 'WEB', book: 'Gen', chapter: 2, updated_at: 100 }
const prefs = { preferences: { theme: 'ink', followAlong: false }, updated_at: 100 }

it('isolates both reader resources, authenticates every method, and keeps newer writes including ties', async () => {
  const app = await buildApp({ databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false })
  try {
    const owner = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { username: 'Owner', password: 'correct horse battery staple' } })
    const ownerCookie = String(owner.headers['set-cookie']).split(';')[0]
    await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: ownerCookie }, payload: { username: 'Reader', password: 'reader secure password', role: 'member' } })
    const member = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'Reader', password: 'reader secure password' } })
    const memberCookie = String(member.headers['set-cookie']).split(';')[0]
    for (const [path, value, changed] of [
      ['reading-cursor', cursor, { ...cursor, chapter: 3 }],
      ['preferences', prefs, { ...prefs, preferences: { theme: 'paper' } }]
    ] as const) {
      const url = `/api/me/${path}`
      for (const method of ['GET', 'PUT'] as const) {
        assert.equal((await app.inject({ method, url, ...(method === 'PUT' ? { payload: value } : {}) })).statusCode, 401)
      }
      const put = (cookie: string, payload: object) => app.inject({ method: 'PUT', url, headers: { cookie }, payload })
      assert.equal((await app.inject({ url, headers: { cookie: ownerCookie } })).body, 'null')
      assert.deepEqual((await put(ownerCookie, value)).json(), value)
      assert.equal((await app.inject({ url, headers: { cookie: memberCookie } })).body, 'null')
      assert.deepEqual((await put(memberCookie, { ...changed, updated_at: 101 })).json(), { ...changed, updated_at: 101 })
      for (const updated_at of [99, 100]) {
        const stale = await put(ownerCookie, { ...changed, updated_at })
        assert.equal(stale.statusCode, 200)
        assert.deepEqual(stale.json(), value)
      }
      assert.deepEqual((await put(ownerCookie, { ...changed, updated_at: 102 })).json(), { ...changed, updated_at: 102 })
      assert.deepEqual((await app.inject({ url, headers: { cookie: memberCookie } })).json(), { ...changed, updated_at: 101 })
    }
  } finally { await app.close() }
})

it('rejects malformed, oversized and coercible inputs without changing stored data; drops unknown preference keys', async () => {
  const app = await buildApp({ databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false })
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { username: 'Owner', password: 'correct horse battery staple' } })
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] }
    const put = (path: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/me/${path}`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) })
    for (const [path, value, invalid] of [
      ['reading-cursor', cursor, [
        { moduleName: '../WEB' }, { moduleName: 'WEB/KJV' }, { moduleName: 'x'.repeat(129) }, { moduleName: 1 },
        { book: '' }, { book: {} }, { book: 'x'.repeat(33) }, { chapter: 0 }, { chapter: -1 }, { chapter: 1.5 }, { chapter: '2' },
        { chapter: Number.MAX_SAFE_INTEGER + 1 }, { updated_at: -1 }, { updated_at: 1.1 }, { updated_at: '101' },
        { updated_at: Number.MAX_SAFE_INTEGER + 1 }, { user_id: 'another-user' }
      ]],
      ['preferences', prefs, [
        { preferences: null }, { preferences: [] }, { preferences: { theme: 'sepia' } },
        { preferences: { followAlong: 'false' } }, { preferences: { textScale: 0.89 } }, { preferences: { textScale: 1.41 } },
        { preferences: { accent: 'red' } }, { preferences: { defaultModuleName: '../WEB' } },
        { preferences: { compareModuleNames: ['WEB', 1] } }, { preferences: { compareModuleNames: Array(129).fill('WEB') } },
        { preferences: { commentaryModuleName: {} } }, { updated_at: null }, { updated_at: -1 }, { user_id: 'another-user' }
      ]]
    ] as const) {
      assert.equal((await put(path, value)).statusCode, 200)
      for (const payload of [null, [], 'value', {}, ...invalid.map((patch) => ({ ...value, ...patch }))]) {
        assert.equal((await put(path, payload)).statusCode, 400, JSON.stringify(payload))
      }
      assert.equal((await put(path, { ...value, padding: 'x'.repeat(16 * 1024) })).statusCode, 413)
      assert.deepEqual((await app.inject({ url: `/api/me/${path}`, headers })).json(), value)
    }
    assert.deepEqual((await put('preferences', { preferences: { theme: 'ink', unknown: true, user_id: 'other' }, updated_at: 101 })).json(), {
      preferences: { theme: 'ink' }, updated_at: 101
    })
    const prototypeKey = await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"preferences":{"__proto__":{"polluted":true}},"updated_at":102}' })
    assert.equal(prototypeKey.statusCode, 400)
  } finally { await app.close() }
})

it('migrates an existing v10 database without losing users and persists reader state across reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-state-'))
  const filename = join(dir, 'test.sqlite')
  try {
    const initial = openDatabase(filename)
    initial.exec("INSERT INTO users VALUES ('reader', 'Reader', 'reader', 'hash', 'member', NULL, 1)")
    initial.exec('DROP TABLE reading_cursors; DROP TABLE user_preferences; DROP TABLE embedding_provider_opt_outs; DELETE FROM schema_migrations WHERE version >= 11')
    initial.close()
    const migrated = openDatabase(filename)
    assert.equal((migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version, 12)
    migrated.prepare('INSERT INTO reading_cursors VALUES (?, ?, ?, ?, ?)').run('reader', 'WEB', 'Gen', 2, 100)
    migrated.prepare('INSERT INTO user_preferences VALUES (?, ?, ?)').run('reader', '{"theme":"ink"}', 100)
    migrated.close()
    const reopened = openDatabase(filename)
    assert.equal((reopened.prepare('SELECT chapter FROM reading_cursors').get() as { chapter: number }).chapter, 2)
    assert.equal((reopened.prepare('SELECT preferences_json FROM user_preferences').get() as { preferences_json: string }).preferences_json, '{"theme":"ink"}')
    reopened.exec("DELETE FROM users WHERE id = 'reader'")
    assert.equal(reopened.prepare('SELECT * FROM reading_cursors').all().length, 0)
    assert.equal(reopened.prepare('SELECT * FROM user_preferences').all().length, 0)
    reopened.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
