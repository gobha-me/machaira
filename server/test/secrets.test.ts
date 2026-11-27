import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it, type TestContext } from 'node:test'
import { openDatabase } from '../src/database.ts'
import { parseSecretKey, SecretStore } from '../src/secrets.ts'

function fixture(t: TestContext) {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  db.exec(`
    INSERT INTO users VALUES ('owner', 'Owner', 'owner', 'unused-test-hash', 'admin', NULL, 1);
    INSERT INTO users VALUES ('reader', 'Reader', 'reader', 'unused-test-hash', 'member', NULL, 1);
  `)
  const key = randomBytes(32)
  return { db, key, store: new SecretStore(db, key) }
}

describe('SecretStore', () => {
  it('decodes all 32 key bytes and rejects decoded lengths on either side', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 7))
    assert.deepEqual(parseSecretKey(key.toString('base64')), key)
    for (const length of [0, 1, 16, 31, 33, 64]) {
      assert.throws(() => parseSecretKey(Buffer.alloc(length).toString('base64')), /32-byte key/)
    }
    assert.throws(() => parseSecretKey('not-a-key'), /32-byte key/)
  })

  it('round-trips empty, binary-like, and Unicode text across block boundaries', (t) => {
    const { store } = fixture(t)
    for (const value of ['', '\0', 'Greek: μάχαιρα; Hebrew: שָׁלוֹם; 😀',
      ...[1, 15, 16, 17, 1024].map((length) => 'x'.repeat(length))]) {
      store.set('owner', 'provider-key', value)
      assert.equal(store.has('owner', 'provider-key'), true)
      assert.equal(store.get('owner', 'provider-key'), value)
    }
  })

  it('isolates missing, overwritten, and removed secrets by account and name', (t) => {
    const { store } = fixture(t)
    assert.equal(store.get('owner', 'missing'), null)
    assert.equal(store.has('owner', 'missing'), false)
    store.remove('owner', 'missing')
    store.set('owner', 'chat-key', 'owner-chat')
    store.set('owner', 'voice-key', 'owner-voice')
    store.set('reader', 'chat-key', 'reader-chat')
    store.set('owner', 'chat-key', 'owner-chat-replaced')
    assert.equal(store.get('owner', 'chat-key'), 'owner-chat-replaced')
    assert.equal(store.get('owner', 'voice-key'), 'owner-voice')
    assert.equal(store.get('reader', 'chat-key'), 'reader-chat')
    assert.equal(store.get('reader', 'voice-key'), null)
    store.remove('owner', 'chat-key')
    assert.equal(store.has('owner', 'chat-key'), false)
    assert.equal(store.get('owner', 'chat-key'), null)
    assert.equal(store.get('owner', 'voice-key'), 'owner-voice')
    assert.equal(store.get('reader', 'chat-key'), 'reader-chat')
  })

  it('requires a nonblank name without leaving a stored record', (t) => {
    const { db, store } = fixture(t)
    for (const name of ['', ' ', '\t\r\n']) assert.throws(() => store.set('owner', name, 'value'), /name is required/)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_secrets').get() as { count: number }).count, 0)
  })

  it('stores authenticated ciphertext with a fresh nonce on overwrite', (t) => {
    const { db, key, store } = fixture(t)
    const value = 'synthetic test value that must not be stored as plaintext'
    const row = () => db.prepare('SELECT ciphertext, iv, auth_tag FROM user_secrets').get() as {
      ciphertext: Buffer; iv: Buffer; auth_tag: Buffer
    }
    store.set('owner', 'provider-key', value)
    const first = row()
    assert.equal(first.iv.length, 12)
    assert.equal(first.auth_tag.length, 16)
    assert.equal(first.ciphertext.length, Buffer.byteLength(value))
    assert.notDeepEqual(first.ciphertext, Buffer.from(value))
    store.set('owner', 'provider-key', value)
    const second = row()
    assert.notDeepEqual(second.iv, first.iv)
    assert.notDeepEqual(second.ciphertext, first.ciphertext)
    assert.equal(new SecretStore(db, Buffer.from(key)).get('owner', 'provider-key'), value)
  })

  it('rejects the wrong decryption key and keeps the original value readable', (t) => {
    const { db, key, store } = fixture(t)
    store.set('owner', 'provider-key', 'synthetic secret')
    const wrongKey = Buffer.from(key)
    wrongKey[0] ^= 1
    assert.throws(() => new SecretStore(db, wrongKey).get('owner', 'provider-key'))
    assert.equal(store.get('owner', 'provider-key'), 'synthetic secret')
  })

  for (const field of ['ciphertext', 'iv', 'auth_tag'] as const) {
    it(`rejects a modified ${field}`, (t) => {
      const { db, store } = fixture(t)
      store.set('owner', 'provider-key', 'synthetic secret')
      const row = db.prepare('SELECT ciphertext, iv, auth_tag FROM user_secrets').get() as Record<typeof field, Buffer>
      const modified = Buffer.from(row[field])
      modified[0] ^= 1
      db.prepare(`UPDATE user_secrets SET ${field} = ?`).run(modified)
      assert.throws(() => store.get('owner', 'provider-key'))
    })
  }

  for (const [userId, name] of [['reader', 'provider-key'], ['owner', 'renamed-key']]) {
    it(`binds encrypted records to account and name: ${userId}/${name}`, (t) => {
      const { db, store } = fixture(t)
      store.set('owner', 'provider-key', 'synthetic secret')
      db.prepare(`
        INSERT INTO user_secrets (user_id, name, ciphertext, iv, auth_tag, updated_at)
        SELECT ?, ?, ciphertext, iv, auth_tag, updated_at
        FROM user_secrets WHERE user_id = 'owner' AND name = 'provider-key'
      `).run(userId, name)
      assert.throws(() => store.get(userId, name))
      assert.equal(store.get('owner', 'provider-key'), 'synthetic secret')
    })
  }
})
