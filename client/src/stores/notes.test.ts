import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api, type Note } from '../services/api'
import { useNotes } from './notes'

const baseNote: Note = {
  id: 'note-1',
  title: 'Title',
  body: 'Original',
  tags: ['study'],
  refs: ['John 1:1 · WEB'],
  createdAt: 100,
  updatedAt: 100
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('notes store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('loads server-backed notes and creates canonical server records', async () => {
    vi.spyOn(api, 'notes').mockResolvedValue([baseNote])
    vi.spyOn(api, 'createNote').mockResolvedValue({
      ...baseNote,
      id: 'note-2',
      title: 'New note',
      createdAt: 200,
      updatedAt: 200
    })
    const notes = useNotes()

    await notes.load()
    expect(notes.current?.id).toBe('note-1')

    await notes.create({ title: 'New note' })
    expect(api.createNote).toHaveBeenCalledWith({
      title: 'New note', body: '', tags: [], refs: []
    })
    expect(notes.current?.id).toBe('note-2')
    expect(notes.list.map((note) => note.id)).toEqual(['note-2', 'note-1'])
  })

  it('coalesces edits and never lets an older response overwrite newer input', async () => {
    vi.useFakeTimers()
    const first = deferred<Note>()
    const update = vi.spyOn(api, 'updateNote')
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(async (_id, patch) => ({
        ...baseNote,
        ...patch,
        updatedAt: 300
      }))
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id

    notes.save({ body: 'First edit' })
    await vi.advanceTimersByTimeAsync(400)
    expect(update).toHaveBeenCalledTimes(1)

    notes.save({ body: 'Final edit' })
    await vi.advanceTimersByTimeAsync(400)
    first.resolve({ ...baseNote, body: 'First edit', updatedAt: 200 })
    await vi.runAllTimersAsync()

    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][1]).toMatchObject({ body: 'Final edit' })
    expect(notes.current?.body).toBe('Final edit')
    expect(notes.saving).toBe(false)
  })

  it('surfaces failed saves and retries the current snapshot', async () => {
    vi.useFakeTimers()
    const update = vi.spyOn(api, 'updateNote')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ...baseNote, body: 'Changed', updatedAt: 200 })
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id

    notes.save({ body: 'Changed' })
    await vi.advanceTimersByTimeAsync(400)
    expect(notes.saveError).toBe('network down')

    notes.retrySave()
    await vi.runAllTimersAsync()
    expect(update).toHaveBeenCalledTimes(2)
    expect(notes.saveError).toBeNull()
    expect(notes.current?.body).toBe('Changed')
  })

  it('does not resurrect a deleted note when an in-flight save finishes', async () => {
    vi.useFakeTimers()
    const saving = deferred<Note>()
    vi.spyOn(api, 'updateNote').mockReturnValue(saving.promise)
    vi.spyOn(api, 'deleteNote').mockResolvedValue()
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id

    notes.save({ body: 'Changed' })
    await vi.advanceTimersByTimeAsync(400)
    await notes.remove(baseNote.id)
    saving.resolve({ ...baseNote, body: 'Changed', updatedAt: 200 })
    await Promise.resolve()

    expect(notes.list).toEqual([])
    expect(notes.currentId).toBeNull()
  })

  it('discards an in-flight load when the authenticated account resets', async () => {
    const loading = deferred<Note[]>()
    vi.spyOn(api, 'notes').mockReturnValue(loading.promise)
    const notes = useNotes()

    const load = notes.load()
    notes.resetPersonalData()
    loading.resolve([baseNote])
    await load

    expect(notes.list).toEqual([])
    expect(notes.loaded).toBe(false)
  })
})
