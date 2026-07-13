import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  refs: string[] // e.g. "John 1:4-5 · WEB"
  createdAt: number
  updatedAt: number
}

export interface Highlight {
  // key is `${module}/${book}/${chapter}/${verse}`
  key: string
  color: string
}

interface SwordDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-updated': number } }
  highlights: { key: string; value: Highlight }
}

let dbp: Promise<IDBPDatabase<SwordDB>> | null = null

function db(): Promise<IDBPDatabase<SwordDB>> {
  if (!dbp) {
    dbp = openDB<SwordDB>('sword', 1, {
      upgrade(d) {
        const notes = d.createObjectStore('notes', { keyPath: 'id' })
        notes.createIndex('by-updated', 'updatedAt')
        d.createObjectStore('highlights', { keyPath: 'key' })
      }
    })
  }
  return dbp
}

export const notesDb = {
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

export const highlightsDb = {
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

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Export everything as portable Markdown + JSON (design's "Export everything").
export async function exportAll(): Promise<{ markdown: string; json: string }> {
  const notes = await notesDb.all()
  const highlights = await highlightsDb.all()
  const json = JSON.stringify({ notes, highlights, exportedAt: Date.now() }, null, 2)
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
