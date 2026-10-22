import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { api, type Note } from '../services/api'
import { readNoteDrafts, writeNoteDrafts } from '../services/noteDrafts'

interface NotesState {
  list: Note[]
  currentId: string | null
  loaded: boolean
  loading: boolean
  saving: boolean
  error: string | null
  saveErrors: Record<string, string>
  dirty: Record<string, boolean>
  userId: string | null
  draftError: string | null
  deleting: Record<string, boolean>
  deleted: Note[]
  restoring: Record<string, boolean>
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
    saveErrors: {},
    dirty: {},
    userId: null,
    draftError: null,
    deleting: {},
    deleted: [],
    restoring: {}
  }),
  getters: {
    current(state): Note | null {
      return state.list.find((n) => n.id === state.currentId) ?? null
    },
    saveError(state): string | null {
      return state.currentId ? state.saveErrors[state.currentId] ?? null : null
    },
    saveErrorId(state): string | null {
      return state.currentId && state.saveErrors[state.currentId] ? state.currentId : null
    }
  },
  actions: {
    activateUser(userId: string | null): void {
      this.resetPersonalData()
      this.userId = userId
      if (!userId) return
      try {
        this.list = readNoteDrafts(userId)
        for (const note of this.list) {
          this.dirty[note.id] = true
          this.saveErrors[note.id] = 'Unsaved draft recovered. Retry to sync.'
        }
        this.currentId = this.list[0]?.id ?? null
      } catch {
        this.draftError = 'Could not read local drafts. Browser storage may be unavailable or damaged.'
      }
    },
    persistDrafts(): void {
      if (!this.userId) return
      try {
        writeNoteDrafts(this.userId, this.list.filter((note) => this.dirty[note.id]))
        this.draftError = null
      } catch {
        this.draftError = 'Could not keep a local copy of your edits. Keep this page open until saving succeeds.'
      }
    },
    async load(): Promise<void> {
      if (this.loading) return
      const activeGeneration = generation
      this.loading = true
      this.error = null
      try {
        const notes = await api.notes()
        if (activeGeneration !== generation) return
        const local = new Map(this.list.map((note) => [note.id, note]))
        this.list = [
          ...this.list.filter((note) => this.dirty[note.id]),
          ...notes.filter((note) => !this.dirty[note.id] && !this.deleted.some((item) => item.id === note.id)).map((note) => {
            const existing = local.get(note.id)
            return existing && existing.updatedAt > note.updatedAt ? existing : note
          })
        ].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
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
    async create(seed?: Partial<Note>): Promise<Note | undefined> {
      const activeGeneration = generation
      this.error = null
      try {
        const note = await api.createNote({
          title: seed?.title ?? 'Untitled note',
          body: seed?.body ?? '',
          tags: seed?.tags ?? [],
          refs: seed?.refs ?? []
        })
        if (activeGeneration !== generation) return
        this.list = [note, ...this.list]
        this.currentId = note.id
        return note
      } catch (error) {
        if (activeGeneration !== generation) return
        this.error = (error as Error).message
        throw error
      }
    },
    select(id: string): void {
      this.currentId = id
    },
    save(patch: Partial<Note>): void {
      if (this.currentId) this.saveFor(this.currentId, patch)
    },
    saveFor(id: string, patch: Partial<Note>): void {
      const note = this.list.find((item) => item.id === id)
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
      this.dirty[updated.id] = true
      // Synchronous storage closes the debounce/unload window; only server acknowledgement clears it.
      this.persistDrafts()
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
    async flushSave(id: string, keepalive = false): Promise<void> {
      const state = pending.get(id)
      const note = this.list.find((item) => item.id === id)
      if (!state || !note || state.running || this.deleting[id]) return
      clearTimeout(state.timer)
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
        }, keepalive)
        if (activeGeneration !== generation || pending.get(id) !== state) return
        if (state.revision === sentRevision) {
          this.list = [saved, ...this.list.filter((item) => item.id !== id)]
          delete this.saveErrors[id]
          delete this.dirty[id]
          this.persistDrafts()
        }
      } catch (error) {
        if (activeGeneration === generation && pending.get(id) === state) {
          this.saveErrors[id] = (error as Error).message
        }
      } finally {
        if (activeGeneration === generation && pending.get(id) === state) {
          state.running = false
          if (state.revision !== sentRevision) {
            state.timer = setTimeout(() => void this.flushSave(id), 0)
          } else {
            pending.delete(id)
          }
          this.saving = pending.size > 0
        }
      }
    },
    retrySave(): void {
      const id = this.saveErrorId ?? this.currentId
      if (id) this.retrySaveFor(id)
    },
    retrySaveFor(id: string): void {
      if (this.dirty[id]) this.scheduleSave(id, 0)
    },
    flushPending(): void {
      if (Object.keys(this.dirty).length) this.persistDrafts()
      for (const id of Object.keys(this.dirty)) {
        if (this.deleting[id]) continue
        if (!pending.has(id)) pending.set(id, { running: false, revision: 0 })
        this.saving = true
        // Browsers may end the request on pagehide; the local draft remains until acknowledgement.
        void this.flushSave(id, true)
      }
    },
    async remove(id: string): Promise<void> {
      if (this.deleting[id] || !this.list.some((note) => note.id === id)) return
      const activeGeneration = generation
      this.error = null
      this.deleting[id] = true
      const state = pending.get(id)
      clearTimeout(state?.timer)
      pending.delete(id)
      this.saving = pending.size > 0
      try {
        await api.deleteNote(id)
        if (activeGeneration !== generation) return
        const note = this.list.find((item) => item.id === id)
        if (note) this.deleted.push({ ...toRaw(note), tags: [...note.tags], refs: [...note.refs] })
        clearTimeout(pending.get(id)?.timer)
        pending.delete(id)
        this.saving = pending.size > 0
        delete this.saveErrors[id]
        delete this.dirty[id]
        this.list = this.list.filter((n) => n.id !== id)
        this.persistDrafts()
        if (this.currentId === id) this.currentId = this.list[0]?.id ?? null
      } catch (error) {
        if (activeGeneration !== generation) return
        this.error = `Could not delete note: ${(error as Error).message}`
        if (this.dirty[id]) this.scheduleSave(id)
        throw error
      } finally {
        if (activeGeneration === generation) delete this.deleting[id]
      }
    },
    async undoRemove(id: string): Promise<void> {
      const note = this.deleted.find((item) => item.id === id)
      if (!note || this.restoring[id]) return
      const activeGeneration = generation
      this.error = null
      this.restoring[id] = true
      try {
        // The create endpoint assigns a new ID; preserve the content, including unsaved edits.
        await this.create(note)
        if (activeGeneration === generation) this.deleted = this.deleted.filter((item) => item.id !== id)
      } finally {
        if (activeGeneration === generation) delete this.restoring[id]
      }
    },
    resetPersonalData(): void {
      cancelPending()
      this.list = []
      this.currentId = null
      this.loaded = false
      this.loading = false
      this.saving = false
      this.error = null
      this.saveErrors = {}
      this.dirty = {}
      this.userId = null
      this.draftError = null
      this.deleting = {}
      this.deleted = []
      this.restoring = {}
    }
  }
})
