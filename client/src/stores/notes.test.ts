import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    useNotes().resetPersonalData()
  })
  afterEach(() => {
    useNotes().resetPersonalData()
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

  it('retains another note’s failed draft and warning through a successful save and refresh', async () => {
    vi.useFakeTimers()
    const second = { ...baseNote, id: 'note-2' }
    const update = vi.spyOn(api, 'updateNote')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...second, body: 'Second saved', updatedAt: 200 })
      .mockResolvedValueOnce({ ...baseNote, body: 'First draft', updatedAt: 300 })
    vi.spyOn(api, 'notes').mockResolvedValue([baseNote, second])
    const notes = useNotes()
    notes.list = [baseNote, second]
    notes.currentId = baseNote.id
    notes.save({ body: 'First draft' })
    await vi.advanceTimersByTimeAsync(400)

    notes.select(second.id)
    notes.save({ body: 'Second saved' })
    await vi.advanceTimersByTimeAsync(400)
    expect(notes.saveErrors[baseNote.id]).toBe('offline')
    expect(notes.saving).toBe(false)
    await notes.load()
    notes.select(baseNote.id)
    expect(notes.current?.body).toBe('First draft')
    expect(notes.saveError).toBe('offline')

    notes.retrySave()
    await vi.runAllTimersAsync()
    expect(update).toHaveBeenCalledTimes(3)
    expect(notes.current?.body).toBe('First draft')
    expect(notes.saveErrors).toEqual({})
    expect(notes.dirty).toEqual({})
  })

  it('keeps edits made while a list refresh is pending', async () => {
    vi.useFakeTimers()
    const response = deferred<Note[]>()
    vi.spyOn(api, 'notes').mockReturnValue(response.promise)
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    const loading = notes.load()
    notes.save({ body: 'New draft' })
    response.resolve([baseNote])
    await loading
    expect(notes.current?.body).toBe('New draft')
    expect(notes.dirty[baseNote.id]).toBe(true)
  })

  it('does not roll back a completed save with an older list response', async () => {
    vi.useFakeTimers()
    const response = deferred<Note[]>()
    vi.spyOn(api, 'notes').mockReturnValue(response.promise)
    vi.spyOn(api, 'updateNote').mockResolvedValue({ ...baseNote, body: 'Saved', updatedAt: 200 })
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    const loading = notes.load()
    notes.save({ body: 'Saved' })
    await vi.advanceTimersByTimeAsync(400)
    response.resolve([baseNote])
    await loading
    expect(notes.current?.body).toBe('Saved')
  })
})
