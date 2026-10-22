// @vitest-environment happy-dom
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
    localStorage.clear()
    vi.useRealTimers()
    useNotes().resetPersonalData()
  })
  afterEach(() => {
    useNotes().resetPersonalData()
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

  it('recovers a failed draft in a new store even when the server list is stale or unavailable', async () => {
    vi.useFakeTimers()
    const update = vi.spyOn(api, 'updateNote').mockRejectedValue(new Error('offline'))
    vi.spyOn(api, 'notes').mockRejectedValueOnce(new Error('still offline')).mockResolvedValue([baseNote])
    const notes = useNotes()
    notes.activateUser('reader')
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    notes.save({ title: '', body: 'Unsynced draft', tags: [], refs: [] })
    await vi.advanceTimersByTimeAsync(400)
    expect(notes.saveError).toBe('offline')
    notes.resetPersonalData()
    setActivePinia(createPinia())
    const reloaded = useNotes()
    reloaded.activateUser('reader')
    await expect(reloaded.load()).rejects.toThrow('still offline')
    expect(reloaded.current).toMatchObject({ title: '', body: 'Unsynced draft', tags: [], refs: [] })
    await reloaded.load()
    expect(reloaded.current?.body).toBe('Unsynced draft')
    expect(reloaded.saveError).toContain('recovered')
    expect(localStorage.getItem('machaira:note-drafts:reader')).toContain('Unsynced draft')

    update.mockResolvedValue({ ...baseNote, body: 'Unsynced draft', updatedAt: 200 })
    reloaded.retrySave()
    await vi.runAllTimersAsync()
    expect(reloaded.dirty).toEqual({})
    expect(localStorage.getItem('machaira:note-drafts:reader')).toBeNull()
  })

  it('persists before debounce and keeps newer input when an older save is acknowledged', async () => {
    vi.useFakeTimers()
    const response = deferred<Note>()
    vi.spyOn(api, 'updateNote').mockReturnValue(response.promise)
    const notes = useNotes()
    notes.activateUser('reader')
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    notes.save({ body: 'Before debounce' })
    expect(localStorage.getItem('machaira:note-drafts:reader')).toContain('Before debounce')
    await vi.advanceTimersByTimeAsync(400)
    notes.save({ body: 'Newer input' })
    response.resolve({ ...baseNote, body: 'Before debounce' })
    await Promise.resolve()
    expect(localStorage.getItem('machaira:note-drafts:reader')).toContain('Newer input')

    notes.resetPersonalData()
    setActivePinia(createPinia())
    const reloaded = useNotes()
    reloaded.activateUser('reader')
    expect(reloaded.current?.body).toBe('Newer input')
  })

  it('isolates drafts by account and ignores an acknowledgement after sign-out', async () => {
    vi.useFakeTimers()
    const response = deferred<Note>()
    vi.spyOn(api, 'updateNote').mockReturnValue(response.promise)
    const notes = useNotes()
    notes.activateUser('first')
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    notes.save({ body: 'First account draft' })
    await vi.advanceTimersByTimeAsync(400)
    notes.activateUser('second')
    response.resolve({ ...baseNote, body: 'First account draft' })
    await Promise.resolve()
    expect(notes.list).toEqual([])
    expect(localStorage.getItem('machaira:note-drafts:second')).toBeNull()
    notes.activateUser(null)
    expect(notes.list).toEqual([])
    notes.activateUser('first')
    expect(notes.current?.body).toBe('First account draft')
  })

  it.each(['{broken', 'null', '[{}]', JSON.stringify([{ ...baseNote, refs: [null] }])])(
    'reports damaged storage without deleting it (%s)', (stored) => {
      localStorage.setItem('machaira:note-drafts:reader', stored)
      const notes = useNotes()
      expect(() => notes.activateUser('reader')).not.toThrow()
      expect(notes.list).toEqual([])
      expect(notes.draftError).toContain('Could not read local drafts')
      notes.flushPending()
      expect(localStorage.getItem('machaira:note-drafts:reader')).toBe(stored)
    }
  )

  it('reports unavailable storage while still attempting to save to the server', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('Quota exceeded') },
      removeItem: vi.fn()
    })
    vi.spyOn(api, 'updateNote').mockRejectedValue(new Error('offline'))
    const notes = useNotes()
    notes.activateUser('reader')
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    notes.save({ body: 'Retained in memory' })
    expect(notes.draftError).toContain('Could not keep a local copy')
    await vi.advanceTimersByTimeAsync(400)
    expect(notes.current?.body).toBe('Retained in memory')
    expect(notes.saveError).toBe('offline')
  })

  it('flushes before debounce, retries failed drafts, and avoids duplicate in-flight writes', async () => {
    vi.useFakeTimers()
    const response = deferred<Note>()
    const update = vi.spyOn(api, 'updateNote').mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ ...baseNote, body: 'Draft' })
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    notes.save({ body: 'Draft' })
    notes.flushPending()
    notes.flushPending()
    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith(baseNote.id, expect.objectContaining({ body: 'Draft' }), true)
    await vi.advanceTimersByTimeAsync(400)
    expect(update).toHaveBeenCalledOnce()
    response.reject(new Error('pagehide interrupted request'))
    await Promise.resolve()
    expect(notes.dirty[baseNote.id]).toBe(true)
    notes.flushPending()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(2)
    expect(notes.dirty).toEqual({})
  })

  it('retains a dirty draft after delete failure and resumes its cancelled save', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'deleteNote').mockRejectedValue(new Error('permission denied'))
    vi.spyOn(api, 'updateNote').mockRejectedValue(new Error('offline'))
    const notes = useNotes()
    notes.activateUser('reader')
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    notes.save({ body: 'Keep me' })
    await expect(notes.remove(baseNote.id)).rejects.toThrow('permission denied')
    expect(notes.error).toContain('Could not delete note: permission denied')
    expect(notes.deleted).toEqual([])
    expect(localStorage.getItem('machaira:note-drafts:reader')).toContain('Keep me')
    await vi.advanceTimersByTimeAsync(400)
    expect(api.updateNote).toHaveBeenCalledOnce()
    expect(notes.current?.body).toBe('Keep me')
    expect(notes.saveError).toBe('offline')
  })

  it('undo restores unsaved content and retains the undo entry if restoring fails', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'deleteNote').mockResolvedValue()
    const create = vi.spyOn(api, 'createNote')
      .mockRejectedValueOnce(new Error('restore unavailable'))
      .mockResolvedValueOnce({ ...baseNote, id: 'restored', body: 'Unsaved content' })
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    notes.save({ body: 'Unsaved content' })
    await notes.remove(baseNote.id)
    expect(notes.list).toEqual([])
    await expect(notes.undoRemove(baseNote.id)).rejects.toThrow('restore unavailable')
    expect(notes.deleted).toHaveLength(1)
    expect(notes.error).toBe('restore unavailable')
    await notes.undoRemove(baseNote.id)
    expect(create).toHaveBeenLastCalledWith({
      title: baseNote.title, body: 'Unsaved content', tags: baseNote.tags, refs: baseNote.refs
    })
    expect(notes.current?.body).toBe('Unsaved content')
    expect(notes.deleted).toEqual([])
  })

  it('includes edits made during deletion in undo and cancels their save timer', async () => {
    vi.useFakeTimers()
    const deletion = deferred<void>()
    vi.spyOn(api, 'deleteNote').mockReturnValue(deletion.promise)
    const update = vi.spyOn(api, 'updateNote')
    const notes = useNotes()
    notes.list = [baseNote]
    notes.currentId = baseNote.id
    const removing = notes.remove(baseNote.id)
    notes.save({ body: 'Typed during deletion' })
    deletion.resolve()
    await removing
    await vi.runAllTimersAsync()
    expect(update).not.toHaveBeenCalled()
    expect(notes.saving).toBe(false)
    expect(notes.deleted[0]?.body).toBe('Typed during deletion')
  })
})
