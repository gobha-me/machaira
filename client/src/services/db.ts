import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Highlight, Note } from './api'

export type { Highlight, Note } from './api'

export interface PlanRecord {
  id: 'plan' // single-record store
  enabled: boolean
  startDate: number | null // local-midnight ms when the plan began
  completed: string[] // chapter keys `${book}/${chapter}`
}

interface SwordDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-updated': number } }
  highlights: { key: string; value: Highlight }
  readingPlan: { key: string; value: PlanRecord }
}

let dbp: Promise<IDBPDatabase<SwordDB>> | null = null

function db(): Promise<IDBPDatabase<SwordDB>> {
  if (!dbp) {
    dbp = openDB<SwordDB>('sword', 2, {
      // Additive upgrade: guard each store so bumping the version preserves existing data.
      upgrade(d) {
        if (!d.objectStoreNames.contains('notes')) {
          const notes = d.createObjectStore('notes', { keyPath: 'id' })
          notes.createIndex('by-updated', 'updatedAt')
        }
        if (!d.objectStoreNames.contains('highlights')) {
          d.createObjectStore('highlights', { keyPath: 'key' })
        }
        if (!d.objectStoreNames.contains('readingPlan')) {
          d.createObjectStore('readingPlan', { keyPath: 'id' })
        }
      }
    })
  }
  return dbp
}

const notesDb = {
  async all(): Promise<Note[]> {
    const d = await db()
    const notes = await d.getAllFromIndex('notes', 'by-updated')
    return notes.reverse()
  },
  async get(id: string): Promise<Note | undefined> {
    return (await db()).get('notes', id)
  },
  async put(note: Note): Promise<void> {
    await (await db()).put('notes', note)
  },
  async remove(id: string): Promise<void> {
    await (await db()).delete('notes', id)
  }
}

const highlightsDb = {
  async all(): Promise<Highlight[]> {
    return (await db()).getAll('highlights')
  },
  async set(key: string, color: string): Promise<void> {
    await (await db()).put('highlights', { key, color })
  },
  async remove(key: string): Promise<void> {
    await (await db()).delete('highlights', key)
  }
}

export const readingPlanDb = {
  async get(): Promise<PlanRecord | undefined> {
    return (await db()).get('readingPlan', 'plan')
  },
  async save(record: PlanRecord): Promise<void> {
    await (await db()).put('readingPlan', record)
  }
}

const IMPORT_KEY_PREFIX = 'sword.personal-data-imported.v1.'

export async function legacyPersonalData(): Promise<{ notes: Note[]; highlights: Highlight[] }> {
  const [notes, highlights] = await Promise.all([notesDb.all(), highlightsDb.all()])
  return { notes, highlights }
}

export function legacyImportComplete(userId: string): boolean {
  return localStorage.getItem(`${IMPORT_KEY_PREFIX}${userId}`) === 'true'
}

export function markLegacyImportComplete(userId: string): void {
  localStorage.setItem(`${IMPORT_KEY_PREFIX}${userId}`, 'true')
}

// Export everything as portable Markdown + JSON (design's "Export everything").
export async function exportAll(
  notes: Note[],
  highlights: Highlight[]
): Promise<{ markdown: string; json: string }> {
  const readingPlan = (await readingPlanDb.get()) ?? null
  const json = JSON.stringify({ notes, highlights, readingPlan, exportedAt: Date.now() }, null, 2)
  const markdown = notes
    .map((n) => {
      const tags = n.tags.length ? `\nTags: ${n.tags.map((t) => `#${t}`).join(' ')}` : ''
      const refs = n.refs.length ? `\nRefs: ${n.refs.join(', ')}` : ''
      const date = new Date(n.updatedAt).toISOString().slice(0, 10)
      return `# ${n.title}\n_${date}_${refs}${tags}\n\n${n.body}\n`
    })
    .join('\n---\n\n')
  return { markdown, json }
}
