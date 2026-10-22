import type { Note } from './api'

function key(userId: string): string {
  return `machaira:note-drafts:${encodeURIComponent(userId)}`
}

function isNote(value: unknown): value is Note {
  if (!value || typeof value !== 'object') return false
  const note = value as Record<string, unknown>
  return typeof note.id === 'string' && note.id.length > 0
    && typeof note.title === 'string' && typeof note.body === 'string'
    && Array.isArray(note.tags) && note.tags.every((tag) => typeof tag === 'string')
    && Array.isArray(note.refs) && note.refs.every((ref) => typeof ref === 'string')
    && typeof note.createdAt === 'number' && Number.isFinite(note.createdAt)
    && typeof note.updatedAt === 'number' && Number.isFinite(note.updatedAt)
}

export function readNoteDrafts(userId: string): Note[] {
  const stored = localStorage.getItem(key(userId))
  if (stored === null) return []
  const drafts: unknown = JSON.parse(stored)
  if (!Array.isArray(drafts) || !drafts.every(isNote)) {
    throw new Error('Invalid stored note drafts')
  }
  return drafts
}

export function writeNoteDrafts(userId: string, drafts: Note[]): void {
  if (drafts.length) localStorage.setItem(key(userId), JSON.stringify(drafts))
  else localStorage.removeItem(key(userId))
}
