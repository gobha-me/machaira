import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import Database from 'better-sqlite3'
import { openDatabase } from '../src/database.ts'

it('upgrades v11 reader data to v12 and persists account-scoped opt-outs with foreign-key enforcement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-migration-'))
  const filename = join(dir, 'test.sqlite')
  try {
    const initial = openDatabase(filename)
    try {
      initial.exec(`
        INSERT INTO users VALUES ('owner', 'Owner', 'owner', 'hash', 'admin', NULL, 1);
        INSERT INTO users VALUES ('reader', 'Reader', 'reader', 'hash', 'member', NULL, 1);
        INSERT INTO reading_cursors VALUES ('reader', 'WEB', 'Gen', 2, 100);
        INSERT INTO user_preferences VALUES ('reader', '{"theme":"ink","followAlong":false}', 101);
        DROP TABLE embedding_provider_opt_outs;
        DELETE FROM schema_migrations WHERE version = 12;
      `)
    } finally { initial.close() }

    const migrated = openDatabase(filename)
    try {
      assert.deepEqual(migrated.prepare('SELECT version FROM schema_migrations WHERE version >= 11 ORDER BY version').all(), [
        { version: 11 }, { version: 12 }
      ])
      assert.deepEqual(migrated.prepare('SELECT * FROM reading_cursors').all(), [{
        user_id: 'reader', module_name: 'WEB', book: 'Gen', chapter: 2, updated_at: 100
      }])
      assert.deepEqual(migrated.prepare('SELECT * FROM user_preferences').all(), [{
        user_id: 'reader', preferences_json: '{"theme":"ink","followAlong":false}', updated_at: 101
      }])
      const optOut = migrated.prepare('INSERT INTO embedding_provider_opt_outs VALUES (?)')
      assert.throws(() => optOut.run('missing-user'), /FOREIGN KEY constraint failed/)
      optOut.run('reader')
      assert.throws(() => optOut.run('reader'), /UNIQUE constraint failed/)
      assert.equal(migrated.prepare('SELECT 1 FROM embedding_provider_opt_outs WHERE user_id = ?').get('owner'), undefined)
    } finally { migrated.close() }

    const reopened = openDatabase(filename)
    try {
      assert.deepEqual(reopened.prepare('SELECT * FROM embedding_provider_opt_outs').all(), [{ user_id: 'reader' }])
      assert.deepEqual(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 12').get(), { count: 1 })
      reopened.prepare('DELETE FROM users WHERE id = ?').run('reader')
      for (const table of ['reading_cursors', 'user_preferences', 'embedding_provider_opt_outs']) {
        assert.deepEqual(reopened.prepare(`SELECT * FROM ${table}`).all(), [])
      }
      assert.deepEqual(reopened.prepare('SELECT id FROM users').all(), [{ id: 'owner' }])
    } finally { reopened.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('does not record a failed v12 migration and can retry without losing v11 reader state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-migration-failure-'))
  const filename = join(dir, 'test.sqlite')
  try {
    const initial = openDatabase(filename)
    try {
      initial.exec(`
        INSERT INTO users VALUES ('reader', 'Reader', 'reader', 'hash', 'member', NULL, 1);
        INSERT INTO reading_cursors VALUES ('reader', 'WEB', 'Gen', 2, 100);
        DROP TABLE embedding_provider_opt_outs;
        DELETE FROM schema_migrations WHERE version = 12;
        CREATE VIEW embedding_provider_opt_outs AS SELECT id AS user_id FROM users;
      `)
    } finally { initial.close() }

    assert.throws(() => openDatabase(filename), /already exists/)
    const repair = new Database(filename)
    try {
      assert.deepEqual(repair.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(), { version: 11 })
      assert.deepEqual(repair.prepare('SELECT chapter FROM reading_cursors').get(), { chapter: 2 })
      repair.exec('DROP VIEW embedding_provider_opt_outs')
    } finally { repair.close() }

    const retried = openDatabase(filename)
    try {
      assert.deepEqual(retried.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(), { version: 12 })
      assert.deepEqual(retried.prepare('SELECT chapter FROM reading_cursors').get(), { chapter: 2 })
      assert.deepEqual(retried.prepare('SELECT * FROM embedding_provider_opt_outs').all(), [])
    } finally { retried.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
