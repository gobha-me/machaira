import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { api, type Note } from '../services/api'

interface NotesState {
  list: Note[]
  currentId: string | null
  loaded: boolean
  loading: boolean
  saving: boolean
  error: string | null
  saveError: string | null
  saveErrorId: string | null
}

interface PendingSave {
  timer?: ReturnType<typeof setTimeout>
  running: boolean
  revision: number
}

const SAVE_DELAY_MS = 400
const pending = new Map<string, PendingSave>()
let generation = 0

function cancelPending(): void {
  generation += 1
  for (const state of pending.values()) clearTimeout(state.timer)
  pending.clear()
}

export const useNotes = defineStore('notes', {
  state: (): NotesState => ({
    list: [],
    currentId: null,
    loaded: false,
    loading: false,
    saving: false,
    error: null,
    saveError: null,
    saveErrorId: null
  }),
  getters: {
    current(state): Note | null {
      return state.list.find((n) => n.id === state.currentId) ?? null
    }
  },
  actions: {
    async load(): Promise<void> {
      if (this.loading) return
      const activeGeneration = generation
      this.loading = true
      this.error = null
      try {
        const notes = await api.notes()
        if (activeGeneration !== generation) return
        this.list = notes
        if (!this.currentId || !this.list.some((note) => note.id === this.currentId)) {
          this.currentId = this.list[0]?.id ?? null
        }
        this.loaded = true
      } catch (error) {
        if (activeGeneration !== generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (activeGeneration === generation) this.loading = false
      }
    },
    async create(seed?: Partial<Note>): Promise<void> {
      this.error = null
      try {
        const note = await api.createNote({
          title: seed?.title ?? 'Untitled note',
          body: seed?.body ?? '',
          tags: seed?.tags ?? [],
          refs: seed?.refs ?? []
        })
        this.list = [note, ...this.list]
        this.currentId = note.id
      } catch (error) {
        this.error = (error as Error).message
        throw error
      }
    },
    select(id: string): void {
      this.currentId = id
    },
    save(patch: Partial<Note>): void {
      const note = this.current
      if (!note) return
      const raw = toRaw(note)
      const updated: Note = {
        ...raw,
        ...patch,
        tags: [...(patch.tags ?? raw.tags)],
        refs: [...(patch.refs ?? raw.refs)],
        updatedAt: Date.now()
      }
      this.list = [updated, ...this.list.filter((item) => item.id !== updated.id)]
      this.saveError = null
      this.saveErrorId = null
      this.scheduleSave(updated.id)
    },
    scheduleSave(id: string, delay = SAVE_DELAY_MS): void {
      const state = pending.get(id) ?? { running: false, revision: 0 }
      state.revision += 1
      clearTimeout(state.timer)
      state.timer = setTimeout(() => void this.flushSave(id), delay)
      pending.set(id, state)
      this.saving = true
    },
    async flushSave(id: string): Promise<void> {
      const state = pending.get(id)
      const note = this.list.find((item) => item.id === id)
      if (!state || !note || state.running) return
      state.running = true
      state.timer = undefined
      const sentRevision = state.revision
      const activeGeneration = generation
      try {
        const saved = await api.updateNote(id, {
          title: note.title,
          body: note.body,
          tags: [...note.tags],
          refs: [...note.refs]
        })
        if (activeGeneration !== generation || pending.get(id) !== state) return
        if (state.revision === sentRevision) {
          this.list = [saved, ...this.list.filter((item) => item.id !== id)]
          this.saveError = null
          this.saveErrorId = null
        }
      } catch (error) {
        if (activeGeneration === generation && pending.get(id) === state) {
          this.saveError = (error as Error).message
          this.saveErrorId = id
        }
      } finally {
        if (activeGeneration !== generation || pending.get(id) !== state) return
        state.running = false
        if (state.revision !== sentRevision) {
          state.timer = setTimeout(() => void this.flushSave(id), 0)
        } else {
          pending.delete(id)
        }
        this.saving = pending.size > 0
      }
    },
    retrySave(): void {
      const id = this.saveErrorId ?? this.currentId
      if (id) this.scheduleSave(id, 0)
    },
    async remove(id: string): Promise<void> {
      const state = pending.get(id)
      clearTimeout(state?.timer)
      pending.delete(id)
      await api.deleteNote(id)
      this.list = this.list.filter((n) => n.id !== id)
      if (this.currentId === id) this.currentId = this.list[0]?.id ?? null
      this.saving = pending.size > 0
    },
    resetPersonalData(): void {
      cancelPending()
      this.list = []
      this.currentId = null
      this.loaded = false
      this.loading = false
      this.saving = false
      this.error = null
      this.saveError = null
      this.saveErrorId = null
    }
  }
})
