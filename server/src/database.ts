import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 3

export type MachairaDatabase = Database.Database

export function openDatabase(filename: string): MachairaDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })

  const db = new Database(filename)
  if (filename !== ':memory:') chmodSync(filename, 0o600)
  db.pragma('foreign_keys = ON')
  if (filename !== ':memory:') db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number }

  if (current.version < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          username_normalized TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
          disabled_at INTEGER,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE INDEX sessions_by_user ON sessions(user_id);
        CREATE INDEX sessions_by_expiry ON sessions(expires_at);

        CREATE TABLE user_secrets (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          ciphertext BLOB NOT NULL,
          iv BLOB NOT NULL,
          auth_tag BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, name)
        );
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(1, Date.now())
    })()
  }

  if (current.version < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE notes (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          refs_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, id)
        );

        CREATE INDEX notes_by_user_updated ON notes(user_id, updated_at DESC);

        CREATE TABLE highlights (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          color TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(2, Date.now())
    })()
  }

  if (current.version < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE ai_provider_configs (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic', 'local')),
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(3, Date.now())
    })()
  }

  if (current.version > SCHEMA_VERSION) {
    db.close()
    throw new Error(`Database schema ${current.version} is newer than supported ${SCHEMA_VERSION}`)
  }

  return db
}
