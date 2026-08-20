import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/database.ts'
import { PersonalDataService } from '../src/personal-data.ts'

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value)
  return value.split(';', 1)[0]
}

describe('personal data API', () => {
  it('persists notes and highlights with strict per-user isolation', async () => {
    const app = await buildApp({
      databasePath: ':memory:',
      secretKey: randomBytes(32),
      logger: false,
      registerFeatureRoutes: false
    })
    await app.ready()

    try {
      const bootstrap = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      })
      const ownerCookie = cookie(bootstrap)

      await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: ownerCookie },
        payload: { username: 'Reader', password: 'reader secure password', role: 'member' }
      })
      const memberLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'Reader', password: 'reader secure password' }
      })
      const memberCookie = cookie(memberLogin)

      const created = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { cookie: ownerCookie },
        payload: { title: 'Grace', body: 'A note', tags: ['study'], refs: ['John 1:1 · WEB'] }
      })
      assert.equal(created.statusCode, 201)
      const ownerNote = created.json().note
      assert.match(ownerNote.id, /^[0-9a-f-]{36}$/)

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${ownerNote.id}`,
        headers: { cookie: ownerCookie },
        payload: { body: 'Updated note' }
      })
      assert.equal(updated.statusCode, 200)
      assert.equal(updated.json().note.body, 'Updated note')
      assert.deepEqual(updated.json().note.tags, ['study'])

      const key = 'WEB/John/1/1'
      assert.equal((await app.inject({
        method: 'PUT',
        url: '/api/highlights',
        headers: { cookie: ownerCookie },
        payload: { key, color: 'gold' }
      })).statusCode, 204)

      const ownerData = await app.inject({
        method: 'GET', url: '/api/notes', headers: { cookie: ownerCookie }
      })
      assert.equal(ownerData.json().notes.length, 1)
      const ownerHighlights = await app.inject({
        method: 'GET', url: '/api/highlights', headers: { cookie: ownerCookie }
      })
      assert.deepEqual(ownerHighlights.json().highlights, [{ key, color: 'gold' }])

      const batch = await app.inject({
        method: 'POST',
        url: '/api/highlights/batch',
        headers: { cookie: ownerCookie },
        payload: {
          set: [{ key: 'WEB/John/1/2', color: 'gold' }],
          remove: [key]
        }
      })
      assert.equal(batch.statusCode, 204)
      const batchedHighlights = await app.inject({
        method: 'GET', url: '/api/highlights', headers: { cookie: ownerCookie }
      })
      assert.deepEqual(batchedHighlights.json().highlights, [
        { key: 'WEB/John/1/2', color: 'gold' }
      ])

      // Restore the original key for the cross-account import and delete checks below.
      await app.inject({
        method: 'POST',
        url: '/api/highlights/batch',
        headers: { cookie: ownerCookie },
        payload: {
          set: [{ key, color: 'gold' }],
          remove: ['WEB/John/1/2']
        }
      })

      const memberData = await app.inject({
        method: 'GET', url: '/api/notes', headers: { cookie: memberCookie }
      })
      assert.deepEqual(memberData.json().notes, [])
      const crossUserUpdate = await app.inject({
        method: 'PATCH',
        url: `/api/notes/${ownerNote.id}`,
        headers: { cookie: memberCookie },
        payload: { body: 'Not allowed' }
      })
      assert.equal(crossUserUpdate.statusCode, 404)

      const legacy = {
        notes: [{
          id: ownerNote.id,
          title: 'Browser note',
          body: 'Imported for another account',
          tags: [],
          refs: [],
          createdAt: 100,
          updatedAt: 200
        }],
        highlights: [{ key, color: 'blue' }]
      }
      const imported = await app.inject({
        method: 'POST',
        url: '/api/personal-data/import',
        headers: { cookie: memberCookie },
        payload: legacy
      })
      assert.deepEqual(imported.json(), {
        notesImported: 1,
        notesSkipped: 0,
        highlightsImported: 1,
        highlightsSkipped: 0
      })
      const retried = await app.inject({
        method: 'POST',
        url: '/api/personal-data/import',
        headers: { cookie: memberCookie },
        payload: legacy
      })
      assert.deepEqual(retried.json(), {
        notesImported: 0,
        notesSkipped: 1,
        highlightsImported: 0,
        highlightsSkipped: 1
      })

      const ownerAfterImport = await app.inject({
        method: 'GET', url: '/api/notes', headers: { cookie: ownerCookie }
      })
      assert.equal(ownerAfterImport.json().notes[0].body, 'Updated note')
      const memberAfterImport = await app.inject({
        method: 'GET', url: '/api/notes', headers: { cookie: memberCookie }
      })
      assert.equal(memberAfterImport.json().notes[0].body, 'Imported for another account')

      assert.equal((await app.inject({
        method: 'DELETE',
        url: `/api/highlights/${encodeURIComponent(key)}`,
        headers: { cookie: ownerCookie }
      })).statusCode, 204)
      assert.equal((await app.inject({
        method: 'DELETE',
        url: `/api/notes/${ownerNote.id}`,
        headers: { cookie: ownerCookie }
      })).statusCode, 204)
      assert.equal((await app.inject({
        method: 'DELETE',
        url: `/api/notes/${ownerNote.id}`,
        headers: { cookie: ownerCookie }
      })).statusCode, 404)
    } finally {
      await app.close()
    }
  })

  it('rejects unauthenticated and invalid personal-data requests', async () => {
    const app = await buildApp({
      databasePath: ':memory:',
      secretKey: randomBytes(32),
      logger: false,
      registerFeatureRoutes: false
    })
    await app.ready()
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/notes' })).statusCode, 401)
      const bootstrap = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      })
      const ownerCookie = cookie(bootstrap)
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: { cookie: ownerCookie },
        payload: { title: 12 }
      })
      assert.equal(invalid.statusCode, 400)
      assert.match(invalid.json().error, /title/i)
      const badImport = await app.inject({
        method: 'POST',
        url: '/api/personal-data/import',
        headers: { cookie: ownerCookie },
        payload: { notes: 'no', highlights: [] }
      })
      assert.equal(badImport.statusCode, 400)
    } finally {
      await app.close()
    }
  })
})

describe('personal data storage migration', () => {
  it('upgrades a version-1 account database and cascades deleted users', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-personal-data-'))
    const filename = join(dir, 'machaira.sqlite')
    const old = new Database(filename)
    old.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 1);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        disabled_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('user-1', 'Owner', 'owner', 'hash', 'admin', NULL, 1);
    `)
    old.close()

    const db = openDatabase(filename)
    try {
      const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get() as { version: number }
      assert.equal(version.version, 7)
      const data = new PersonalDataService(db)
      const note = data.createNote('user-1', { title: 'Persisted' })
      data.setHighlight('user-1', { key: 'WEB/John/1/1', color: 'gold' })
      assert.equal(data.listNotes('user-1')[0].id, note.id)
      assert.equal(data.listHighlights('user-1').length, 1)

      db.prepare('DELETE FROM users WHERE id = ?').run('user-1')
      assert.deepEqual(data.listNotes('user-1'), [])
      assert.deepEqual(data.listHighlights('user-1'), [])
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
