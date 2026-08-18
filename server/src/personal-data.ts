import { randomUUID } from 'node:crypto'
import type { MachairaDatabase } from './database.js'

export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  refs: string[]
  createdAt: number
  updatedAt: number
}

export interface Highlight {
  key: string
  color: string
}

interface NoteRow {
  id: string
  title: string
  body: string
  tags_json: string
  refs_json: string
  created_at: number
  updated_at: number
}

export class PersonalDataInputError extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PersonalDataInputError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string') throw new PersonalDataInputError(`${label} must be a string`)
  if (value.length > max) throw new PersonalDataInputError(`${label} is too long`)
  return value
}

function nonEmptyString(value: unknown, label: string, max: number): string {
  const result = string(value, label, max)
  if (!result) throw new PersonalDataInputError(`${label} is required`)
  return result
}

function stringArray(value: unknown, label: string, itemMax: number, fallback?: string[]): string[] {
  if (value === undefined && fallback) return fallback
  if (!Array.isArray(value) || value.length > 100) {
    throw new PersonalDataInputError(`${label} must contain at most 100 strings`)
  }
  return value.map((item, index) => string(item, `${label}[${index}]`, itemMax))
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PersonalDataInputError(`${label} must be a non-negative integer`)
  }
  return value
}

function noteFromRow(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags_json) as string[],
    refs: JSON.parse(row.refs_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function noteValues(value: unknown, defaults?: Note): Omit<Note, 'id' | 'createdAt' | 'updatedAt'> {
  const input = object(value, 'Note')
  return {
    title: string(input.title, 'Note title', 500, defaults?.title ?? 'Untitled note'),
    body: string(input.body, 'Note body', 1_048_576, defaults?.body ?? ''),
    tags: stringArray(input.tags, 'Note tags', 64, defaults?.tags ?? []),
    refs: stringArray(input.refs, 'Note refs', 512, defaults?.refs ?? [])
  }
}

function legacyNote(value: unknown): Note {
  const input = object(value, 'Legacy note')
  const values = noteValues(input)
  const createdAt = timestamp(input.createdAt, 'Legacy note createdAt')
  const updatedAt = timestamp(input.updatedAt, 'Legacy note updatedAt')
  if (updatedAt < createdAt) {
    throw new PersonalDataInputError('Legacy note updatedAt must not precede createdAt')
  }
  return {
    id: nonEmptyString(input.id, 'Legacy note id', 128),
    ...values,
    createdAt,
    updatedAt
  }
}

function highlight(value: unknown): Highlight {
  const input = object(value, 'Highlight')
  return {
    key: nonEmptyString(input.key, 'Highlight key', 512),
    color: nonEmptyString(input.color, 'Highlight color', 128)
  }
}

export class PersonalDataService {
  constructor(private readonly db: MachairaDatabase) {}

  listNotes(userId: string): Note[] {
    const rows = this.db.prepare(`
      SELECT id, title, body, tags_json, refs_json, created_at, updated_at
      FROM notes WHERE user_id = ? ORDER BY updated_at DESC, id
    `).all(userId) as NoteRow[]
    return rows.map(noteFromRow)
  }

  createNote(userId: string, input: unknown): Note {
    const values = noteValues(input)
    const now = Date.now()
    const note: Note = { id: randomUUID(), ...values, createdAt: now, updatedAt: now }
    this.insertNote(userId, note)
    return note
  }

  updateNote(userId: string, id: string, input: unknown): Note | null {
    const safeId = nonEmptyString(id, 'Note id', 128)
    const row = this.db.prepare(`
      SELECT id, title, body, tags_json, refs_json, created_at, updated_at
      FROM notes WHERE user_id = ? AND id = ?
    `).get(userId, safeId) as NoteRow | undefined
    if (!row) return null

    const existing = noteFromRow(row)
    const values = noteValues(input, existing)
    const updated: Note = { ...existing, ...values, updatedAt: Date.now() }
    this.db.prepare(`
      UPDATE notes SET title = ?, body = ?, tags_json = ?, refs_json = ?, updated_at = ?
      WHERE user_id = ? AND id = ?
    `).run(
      updated.title,
      updated.body,
      JSON.stringify(updated.tags),
      JSON.stringify(updated.refs),
      updated.updatedAt,
      userId,
      safeId
    )
    return updated
  }

  deleteNote(userId: string, id: string): boolean {
    const safeId = nonEmptyString(id, 'Note id', 128)
    return this.db.prepare('DELETE FROM notes WHERE user_id = ? AND id = ?')
      .run(userId, safeId).changes > 0
  }

  listHighlights(userId: string): Highlight[] {
    return this.db.prepare(`
      SELECT key, color FROM highlights WHERE user_id = ? ORDER BY key
    `).all(userId) as Highlight[]
  }

  setHighlight(userId: string, input: unknown): void {
    const value = highlight(input)
    this.db.prepare(`
      INSERT INTO highlights (user_id, key, color) VALUES (?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET color = excluded.color
    `).run(userId, value.key, value.color)
  }

  deleteHighlight(userId: string, key: string): void {
    const safeKey = nonEmptyString(key, 'Highlight key', 512)
    this.db.prepare('DELETE FROM highlights WHERE user_id = ? AND key = ?').run(userId, safeKey)
  }

  updateHighlights(userId: string, input: unknown): void {
    const data = object(input, 'Highlight batch')
    if (!Array.isArray(data.set) || data.set.length > 500) {
      throw new PersonalDataInputError('Highlight batch set must contain at most 500 records')
    }
    if (!Array.isArray(data.remove) || data.remove.length > 500) {
      throw new PersonalDataInputError('Highlight batch remove must contain at most 500 keys')
    }
    const set = data.set.map(highlight)
    const remove = data.remove.map((key, index) =>
      nonEmptyString(key, `Highlight batch remove[${index}]`, 512))

    this.db.transaction(() => {
      const removeStatement = this.db.prepare(
        'DELETE FROM highlights WHERE user_id = ? AND key = ?'
      )
      for (const key of remove) removeStatement.run(userId, key)
      const setStatement = this.db.prepare(`
        INSERT INTO highlights (user_id, key, color) VALUES (?, ?, ?)
        ON CONFLICT (user_id, key) DO UPDATE SET color = excluded.color
      `)
      for (const value of set) setStatement.run(userId, value.key, value.color)
    })()
  }

  importLegacy(userId: string, input: unknown): {
    notesImported: number
    notesSkipped: number
    highlightsImported: number
    highlightsSkipped: number
  } {
    const data = object(input, 'Import')
    if (!Array.isArray(data.notes) || data.notes.length > 5_000) {
      throw new PersonalDataInputError('Import notes must be an array of at most 5000 records')
    }
    if (!Array.isArray(data.highlights) || data.highlights.length > 50_000) {
      throw new PersonalDataInputError('Import highlights must be an array of at most 50000 records')
    }
    const notes = data.notes.map(legacyNote)
    const highlights = data.highlights.map(highlight)
    let notesImported = 0
    let highlightsImported = 0

    this.db.transaction(() => {
      const insertNote = this.db.prepare(`
        INSERT OR IGNORE INTO notes
          (user_id, id, title, body, tags_json, refs_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const note of notes) {
        notesImported += insertNote.run(
          userId,
          note.id,
          note.title,
          note.body,
          JSON.stringify(note.tags),
          JSON.stringify(note.refs),
          note.createdAt,
          note.updatedAt
        ).changes
      }

      const insertHighlight = this.db.prepare(`
        INSERT OR IGNORE INTO highlights (user_id, key, color) VALUES (?, ?, ?)
      `)
      for (const value of highlights) {
        highlightsImported += insertHighlight.run(userId, value.key, value.color).changes
      }
    })()

    return {
      notesImported,
      notesSkipped: notes.length - notesImported,
      highlightsImported,
      highlightsSkipped: highlights.length - highlightsImported
    }
  }

  private insertNote(userId: string, note: Note): void {
    this.db.prepare(`
      INSERT INTO notes
        (user_id, id, title, body, tags_json, refs_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      note.id,
      note.title,
      note.body,
      JSON.stringify(note.tags),
      JSON.stringify(note.refs),
      note.createdAt,
      note.updatedAt
    )
  }
}
