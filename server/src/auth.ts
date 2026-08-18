import argon2 from 'argon2'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { MachairaDatabase } from './database.js'

export const SESSION_COOKIE = 'machaira_session'
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export type UserRole = 'admin' | 'member'

export interface AuthUser {
  id: string
  username: string
  role: UserRole
}

export interface ManagedUser extends AuthUser {
  disabled: boolean
  createdAt: number
}

interface UserRow {
  id: string
  username: string
  username_normalized: string
  password_hash: string
  role: UserRole
  disabled_at: number | null
  created_at: number
}

export class AuthInputError extends Error {}
export class AuthConflictError extends Error {}
export class AuthForbiddenError extends Error {}

function normalizeUsername(username: string): string {
  return username.trim().toLocaleLowerCase('en-US')
}

function validateUsername(username: string): string {
  const trimmed = username.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(trimmed)) {
    throw new AuthInputError('Username must be 3–64 characters using letters, numbers, ., _, or -')
  }
  return trimmed
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 256) {
    throw new AuthInputError('Password must be between 12 and 256 characters')
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function publicUser(row: Pick<UserRow, 'id' | 'username' | 'role'>): AuthUser {
  return { id: row.id, username: row.username, role: row.role }
}

function isUniqueConstraint(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT'
}

export class AuthService {
  private readonly dummyHash: Promise<string>

  constructor(private readonly db: MachairaDatabase) {
    this.dummyHash = argon2.hash(randomBytes(32), { type: argon2.argon2id })
  }

  hasUsers(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
    return row.count > 0
  }

  async bootstrap(username: string, password: string): Promise<AuthUser> {
    const display = validateUsername(username)
    validatePassword(password)
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    const id = randomUUID()

    try {
      this.db.transaction(() => {
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
        if (count.count !== 0) throw new AuthConflictError('Bootstrap is already complete')
        this.db.prepare(`
          INSERT INTO users (id, username, username_normalized, password_hash, role, created_at)
          VALUES (?, ?, ?, ?, 'admin', ?)
        `).run(id, display, normalizeUsername(display), passwordHash, Date.now())
      })()
    } catch (error) {
      if (error instanceof AuthConflictError) throw error
      if (isUniqueConstraint(error)) throw new AuthConflictError('Username is already in use')
      throw error
    }

    return { id, username: display, role: 'admin' }
  }

  async login(username: string, password: string): Promise<AuthUser | null> {
    const normalized = normalizeUsername(username)
    const row = this.db.prepare('SELECT * FROM users WHERE username_normalized = ?').get(normalized) as
      | UserRow
      | undefined
    const hash = row?.password_hash ?? await this.dummyHash
    const valid = await argon2.verify(hash, password).catch(() => false)
    if (!row || !valid || row.disabled_at !== null) return null
    return publicUser(row)
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      this.db.prepare(`
        INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
      `).run(tokenHash(token), userId, now, now + SESSION_TTL_SECONDS * 1000)
    })()
    return token
  }

  authenticate(token: string | undefined): AuthUser | null {
    if (!token) return null
    const now = Date.now()
    const row = this.db.prepare(`
      SELECT u.* FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL
    `).get(tokenHash(token), now) as UserRow | undefined

    if (!row) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?')
        .run(tokenHash(token), now)
      return null
    }
    return publicUser(row)
  }

  revokeSession(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<string> {
    validatePassword(newPassword)
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
    if (!row || !await argon2.verify(row.password_hash, currentPassword).catch(() => false)) {
      throw new AuthForbiddenError('Current password is incorrect')
    }
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id })
    this.db.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    })()
    return this.createSession(userId)
  }

  listUsers(): ManagedUser[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at, username_normalized').all() as UserRow[]
    return rows.map((row) => ({
      ...publicUser(row),
      disabled: row.disabled_at !== null,
      createdAt: row.created_at
    }))
  }

  async createUser(username: string, password: string, role: UserRole): Promise<ManagedUser> {
    const display = validateUsername(username)
    validatePassword(password)
    if (role !== 'admin' && role !== 'member') throw new AuthInputError('Invalid role')
    const hash = await argon2.hash(password, { type: argon2.argon2id })
    const id = randomUUID()
    const createdAt = Date.now()
    try {
      this.db.prepare(`
        INSERT INTO users (id, username, username_normalized, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, display, normalizeUsername(display), hash, role, createdAt)
    } catch (error) {
      if (isUniqueConstraint(error)) throw new AuthConflictError('Username is already in use')
      throw error
    }
    return { id, username: display, role, disabled: false, createdAt }
  }

  setDisabled(actorId: string, userId: string, disabled: boolean): void {
    if (actorId === userId && disabled) throw new AuthInputError('You cannot disable your own account')
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
    if (!row) throw new AuthInputError('User not found')
    if (disabled && row.role === 'admin' && row.disabled_at === null) {
      const activeAdmins = this.db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL
      `).get() as { count: number }
      if (activeAdmins.count <= 1) throw new AuthInputError('The last enabled administrator cannot be disabled')
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
        .run(disabled ? Date.now() : null, userId)
      if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    })()
  }

  async resetPassword(userId: string, password: string): Promise<void> {
    validatePassword(password)
    const exists = this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)
    if (!exists) throw new AuthInputError('User not found')
    const hash = await argon2.hash(password, { type: argon2.argon2id })
    this.db.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    })()
  }
}
