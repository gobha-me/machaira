import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { MachairaDatabase } from './database.js'

export function parseSecretKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('MACHAIRA_SECRET_KEY must be a base64-encoded 32-byte key')
  return key
}

export class SecretStore {
  constructor(
    private readonly db: MachairaDatabase,
    private readonly key: Buffer
  ) {}

  set(userId: string, name: string, value: string): void {
    if (!name.trim()) throw new Error('Secret name is required')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(`${userId}:${name}`, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    this.db.prepare(`
      INSERT INTO user_secrets (user_id, name, ciphertext, iv, auth_tag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `).run(userId, name, ciphertext, iv, authTag, Date.now())
  }

  get(userId: string, name: string): string | null {
    const row = this.db.prepare(`
      SELECT ciphertext, iv, auth_tag FROM user_secrets WHERE user_id = ? AND name = ?
    `).get(userId, name) as { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer } | undefined
    if (!row) return null
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv)
    decipher.setAAD(Buffer.from(`${userId}:${name}`, 'utf8'))
    decipher.setAuthTag(row.auth_tag)
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
  }

  remove(userId: string, name: string): void {
    this.db.prepare('DELETE FROM user_secrets WHERE user_id = ? AND name = ?').run(userId, name)
  }
}
