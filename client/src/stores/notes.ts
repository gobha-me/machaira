import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { notesDb, newId, type Note } from '../services/db'

interface NotesState {
  list: Note[]
  currentId: string | null
  loaded: boolean
}

export const useNotes = defineStore('notes', {
  state: (): NotesState => ({
    list: [],
    currentId: null,
    loaded: false
  }),
  getters: {
    current(state): Note | null {
      return state.list.find((n) => n.id === state.currentId) ?? null
    }
  },
  actions: {
    async load(): Promise<void> {
      this.list = await notesDb.all()
      if (!this.currentId && this.list.length) this.currentId = this.list[0].id
      this.loaded = true
    },
    async create(seed?: Partial<Note>): Promise<void> {
      const now = Date.now()
      const note: Note = {
        id: newId(),
        title: seed?.title ?? 'Untitled note',
        body: seed?.body ?? '',
        tags: seed?.tags ?? [],
        refs: seed?.refs ?? [],
        createdAt: now,
        updatedAt: now
      }
      await notesDb.put(note)
      this.list = [note, ...this.list]
      this.currentId = note.id
    },
    select(id: string): void {
      this.currentId = id
    },
    async save(patch: Partial<Note>): Promise<void> {
      const note = this.current
      if (!note) return
      // Unwrap Pinia reactivity and rebuild the arrays as plain arrays; IndexedDB's
      // structured clone rejects Vue's reactive Proxy arrays and the put would fail.
      const raw = toRaw(note)
      const updated: Note = {
        ...raw,
        ...patch,
        tags: [...(patch.tags ?? raw.tags)],
        refs: [...(patch.refs ?? raw.refs)],
        updatedAt: Date.now()
      }
      await notesDb.put(updated)
      this.list = [updated, ...this.list.filter((n) => n.id !== updated.id)]
    },
    async remove(id: string): Promise<void> {
      await notesDb.remove(id)
      this.list = this.list.filter((n) => n.id !== id)
      if (this.currentId === id) this.currentId = this.list[0]?.id ?? null
    }
  }
})
