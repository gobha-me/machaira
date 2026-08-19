import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildApp } from '../src/app.ts'
import { AuthService } from '../src/auth.ts'
import { openDatabase } from '../src/database.ts'
import { SecretStore } from '../src/secrets.ts'

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value)
  return value.split(';', 1)[0]
}

describe('authentication API', () => {
  it('bootstraps once, gates APIs, and manages accounts and sessions', async () => {
    const app = await buildApp({
      databasePath: ':memory:',
      secretKey: randomBytes(32),
      logger: false,
      registerFeatureRoutes: false
    })
    await app.ready()

    try {
      const initial = await app.inject({ method: 'GET', url: '/api/auth/status' })
      assert.equal(initial.statusCode, 200)
      assert.equal(initial.json().state, 'bootstrap')

      const health = await app.inject({ method: 'GET', url: '/api/health' })
      assert.equal(health.statusCode, 200)
      const gated = await app.inject({ method: 'GET', url: '/api/users' })
      assert.equal(gated.statusCode, 401)
      const gatedConnections = await app.inject({
        method: 'POST', url: '/api/connections', payload: { seeds: [] }
      })
      assert.equal(gatedConnections.statusCode, 401)

      const weak = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        payload: { username: 'owner', password: 'short' }
      })
      assert.equal(weak.statusCode, 400)

      const bootstrap = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      })
      assert.equal(bootstrap.statusCode, 201)
      assert.equal(bootstrap.json().user.role, 'admin')
      const ownerCookie = cookie(bootstrap)

      const duplicateBootstrap = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        payload: { username: 'other', password: 'another secure password' }
      })
      assert.equal(duplicateBootstrap.statusCode, 409)

      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'Owner', password: 'not the password' }
      })
      assert.equal(wrong.statusCode, 401)
      assert.equal(wrong.json().error, 'Invalid username or password')

      const status = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: { cookie: ownerCookie }
      })
      assert.equal(status.json().state, 'authenticated')
      assert.equal(status.json().user.username, 'Owner')

      const invalidConnections = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { cookie: ownerCookie },
        payload: { seeds: [] }
      })
      assert.equal(invalidConnections.statusCode, 400)

      const created = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: ownerCookie },
        payload: { username: 'Reader', password: 'reader secure password', role: 'member' }
      })
      assert.equal(created.statusCode, 201)
      const memberId = created.json().user.id as string

      const memberLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'reader', password: 'reader secure password' }
      })
      assert.equal(memberLogin.statusCode, 200)
      const memberCookie = cookie(memberLogin)
      const forbidden = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: memberCookie }
      })
      assert.equal(forbidden.statusCode, 403)

      const selfDisable = await app.inject({
        method: 'PATCH',
        url: `/api/users/${bootstrap.json().user.id}`,
        headers: { cookie: ownerCookie },
        payload: { disabled: true }
      })
      assert.equal(selfDisable.statusCode, 400)

      const selfReset = await app.inject({
        method: 'POST',
        url: `/api/users/${bootstrap.json().user.id}/password`,
        headers: { cookie: ownerCookie },
        payload: { password: 'new administrator password' }
      })
      assert.equal(selfReset.statusCode, 400)

      const disable = await app.inject({
        method: 'PATCH',
        url: `/api/users/${memberId}`,
        headers: { cookie: ownerCookie },
        payload: { disabled: true }
      })
      assert.equal(disable.statusCode, 204)
      const disabledSession = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: memberCookie }
      })
      assert.equal(disabledSession.statusCode, 401)

      const passwordChange = await app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: { cookie: ownerCookie },
        payload: {
          currentPassword: 'correct horse battery staple',
          newPassword: 'a new correct horse battery staple'
        }
      })
      assert.equal(passwordChange.statusCode, 204)
      const refreshedCookie = cookie(passwordChange)
      const revoked = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: ownerCookie }
      })
      assert.equal(revoked.statusCode, 401)
      const refreshed = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: refreshedCookie }
      })
      assert.equal(refreshed.statusCode, 200)

      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: refreshedCookie }
      })
      assert.equal(logout.statusCode, 204)
      const afterLogout = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: refreshedCookie }
      })
      assert.equal(afterLogout.statusCode, 401)
    } finally {
      await app.close()
    }
  })
})

describe('authentication storage', () => {
  it('stores password hashes, expires sessions, and encrypts per-user secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-auth-'))
    const filename = join(dir, 'auth.sqlite')
    const key = randomBytes(32)
    const db = openDatabase(filename)
    let sessionToken = ''
    try {
      const auth = new AuthService(db)
      const user = await auth.bootstrap('owner', 'correct horse battery staple')
      const passwordRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as {
        password_hash: string
      }
      assert.notEqual(passwordRow.password_hash, 'correct horse battery staple')
      assert.match(passwordRow.password_hash, /^\$argon2id\$/)

      sessionToken = auth.createSession(user.id)
      assert.ok(auth.authenticate(sessionToken))
      db.prepare('UPDATE sessions SET expires_at = 0').run()
      assert.equal(auth.authenticate(sessionToken), null)

      const secrets = new SecretStore(db, key)
      secrets.set(user.id, 'provider-token', 'super-secret-provider-token')
      assert.equal(secrets.has(user.id, 'provider-token'), true)
      assert.equal(secrets.get(user.id, 'provider-token'), 'super-secret-provider-token')
      assert.equal(secrets.get(user.id, 'missing'), null)
      secrets.remove(user.id, 'provider-token')
      assert.equal(secrets.has(user.id, 'provider-token'), false)
      assert.equal(secrets.get(user.id, 'provider-token'), null)
    } finally {
      db.close()
    }

    const bytes = await readFile(filename)
    assert.equal(bytes.includes(Buffer.from('super-secret-provider-token')), false)
    assert.equal(bytes.includes(Buffer.from(sessionToken)), false)
    await rm(dir, { recursive: true, force: true })
  })
})
