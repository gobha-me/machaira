import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 9

export type MachairaDatabase = Database.Database

export function openDatabase(filename: string): MachairaDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })

  const db = new Database(filename)
  sqliteVec.load(db)
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

  if (current.version < 4) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE embedding_provider_configs (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'local')),
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE semantic_index_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider_signature TEXT NOT NULL,
          module_signature TEXT NOT NULL,
          dimension INTEGER,
          status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
          chunk_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          error TEXT
        );

        CREATE INDEX semantic_runs_by_user_created
          ON semantic_index_runs(user_id, created_at DESC);

        CREATE TABLE semantic_active_indexes (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES semantic_index_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE semantic_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES semantic_index_runs(id) ON DELETE CASCADE,
          module TEXT NOT NULL,
          book TEXT NOT NULL,
          book_name TEXT NOT NULL,
          chapter INTEGER NOT NULL,
          verse INTEGER NOT NULL,
          content TEXT NOT NULL,
          UNIQUE (run_id, module, book, chapter, verse)
        );

        CREATE INDEX semantic_chunks_by_run ON semantic_chunks(run_id);
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(4, Date.now())
    })()
  }

  if (current.version < 5) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE embedding_provider_configs
          ADD COLUMN batch_size INTEGER NOT NULL DEFAULT 32
          CHECK (batch_size BETWEEN 1 AND 64);
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(5, Date.now())
    })()
  }

  if (current.version < 6) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tts_configs (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          provider_order_json TEXT NOT NULL,
          local_provider TEXT CHECK (local_provider IN ('openai-compatible')),
          local_base_url TEXT,
          local_model TEXT,
          local_voice TEXT,
          cloud_provider TEXT CHECK (cloud_provider IN ('openai-compatible', 'venice')),
          cloud_base_url TEXT,
          cloud_model TEXT,
          cloud_voice TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(6, Date.now())
    })()
  }

  if (current.version < 7) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE stt_configs (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          provider_order_json TEXT NOT NULL,
          local_provider TEXT CHECK (local_provider IN ('openai-compatible')),
          local_base_url TEXT,
          local_model TEXT,
          cloud_provider TEXT CHECK (cloud_provider IN ('openai-compatible', 'venice')),
          cloud_base_url TEXT,
          cloud_model TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(7, Date.now())
    })()
  }

  if (current.version < 8) {
    db.transaction(() => {
      const semanticTable = db.prepare(`
        SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'semantic_chunks'
      `).get()
      if (semanticTable) {
        const columns = new Set((db.prepare('PRAGMA table_info(semantic_chunks)').all() as Array<{ name: string }>).map((column) => column.name))
        if (!columns.has('kind')) db.exec(`ALTER TABLE semantic_chunks ADD COLUMN kind TEXT NOT NULL DEFAULT 'scripture' CHECK (kind IN ('scripture', 'general-book'))`)
        if (!columns.has('locator')) db.exec('ALTER TABLE semantic_chunks ADD COLUMN locator TEXT')
      }
      db.exec(`CREATE TABLE corpus_module_preferences (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          module TEXT NOT NULL,
          ai_enabled INTEGER NOT NULL CHECK (ai_enabled IN (0, 1)),
          license_acknowledged_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, module)
        )`)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(8, Date.now())
    })()
  }

  if (current.version < 9) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE chat_conversations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX chat_conversations_by_user_updated
          ON chat_conversations(user_id, updated_at DESC, id);

        CREATE TABLE chat_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'interrupted', 'failed')),
          reply_to_message_id TEXT REFERENCES chat_messages(id),
          passage_reference TEXT,
          passage_module TEXT,
          passage_content TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (conversation_id, sequence)
        );

        CREATE INDEX chat_messages_by_conversation_sequence
          ON chat_messages(conversation_id, sequence);
        CREATE INDEX chat_messages_by_reply
          ON chat_messages(reply_to_message_id);
      `)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(9, Date.now())
    })()
  }

  if (current.version > SCHEMA_VERSION) {
    db.close()
    throw new Error(`Database schema ${current.version} is newer than supported ${SCHEMA_VERSION}`)
  }

  return db
}
