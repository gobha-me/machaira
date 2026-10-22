import type { FastifyInstance } from 'fastify'
import { parseReadingCursor, parseUserPreferences, type ReadingCursor, type UserPreferences } from '@machaira/scripture'
import type { MachairaDatabase } from '../database.js'

export async function registerReaderState(app: FastifyInstance, db: MachairaDatabase): Promise<void> {
  const cursor = db.prepare(`SELECT module_name AS moduleName, book, chapter, updated_at
    FROM reading_cursors WHERE user_id = ?`)
  const preferences = db.prepare('SELECT preferences_json, updated_at FROM user_preferences WHERE user_id = ?')
  const getCursor = (userId: string): ReadingCursor | null => cursor.get(userId) as ReadingCursor | undefined ?? null
  const getPreferences = (userId: string): UserPreferences | null => {
    const row = preferences.get(userId) as { preferences_json: string; updated_at: number } | undefined
    return row ? { preferences: JSON.parse(row.preferences_json), updated_at: row.updated_at } : null
  }
  const saveCursor = db.prepare(`INSERT INTO reading_cursors (user_id, module_name, book, chapter, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
    module_name = excluded.module_name, book = excluded.book, chapter = excluded.chapter, updated_at = excluded.updated_at
    WHERE excluded.updated_at > reading_cursors.updated_at`)
  const savePreferences = db.prepare(`INSERT INTO user_preferences (user_id, preferences_json, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
    preferences_json = excluded.preferences_json, updated_at = excluded.updated_at
    WHERE excluded.updated_at > user_preferences.updated_at`)

  app.get('/api/me/reading-cursor', async (request) => getCursor(request.authUser!.id))
  app.get('/api/me/preferences', async (request) => getPreferences(request.authUser!.id))
  app.put('/api/me/reading-cursor', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const value = parseReadingCursor(request.body)
    if (!value) return reply.code(400).send({ error: 'Invalid reading cursor' })
    const userId = request.authUser!.id
    saveCursor.run(userId, value.moduleName, value.book, value.chapter, value.updated_at)
    return getCursor(userId)
  })
  app.put('/api/me/preferences', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const value = parseUserPreferences(request.body)
    if (!value) return reply.code(400).send({ error: 'Invalid preferences' })
    const userId = request.authUser!.id
    savePreferences.run(userId, JSON.stringify(value.preferences), value.updated_at)
    return getPreferences(userId)
  })
}
