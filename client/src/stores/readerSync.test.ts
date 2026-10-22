// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ReadingCursor, UserPreferences } from '@machaira/scripture'
import { api } from '../services/api'
import { useReader } from './reader'
import { useSettings } from './settings'
import { useLibrary } from './library'
import { pathologicalModule } from '../test/fixtures/moduleInfo'

const cursorKey = (id: string) => `sword.reader.pos.v2:${id}`
const prefsKey = (id: string) => `sword.settings.v1:${id}`
const position: ReadingCursor = { moduleName: 'WEB', book: 'Gen', chapter: 2, updated_at: 100 }
const preferences: UserPreferences = { preferences: { theme: 'ink', defaultModuleName: 'KJV' }, updated_at: 100 }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function prepare() {
  const library = useLibrary()
  library.modules = ['WEB', 'KJV'].map((name) => ({ ...pathologicalModule, name, type: 'BIBLE', kind: 'scripture', installed: true }))
  library.loaded = true
  const settings = useSettings()
  const reader = useReader()
  return { settings, reader }
}

async function login(id: string) {
  const stores = prepare()
  stores.settings.activateUser(id)
  stores.reader.activateUser(id)
  await stores.settings.restore()
  await stores.reader.init()
  return stores
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  vi.restoreAllMocks()
  localStorage.clear()
  setActivePinia(createPinia())
  vi.spyOn(api, 'readingCursor').mockResolvedValue(null)
  vi.spyOn(api, 'preferences').mockResolvedValue(null)
  vi.spyOn(api, 'saveReadingCursor').mockImplementation(async (value) => value)
  vi.spyOn(api, 'savePreferences').mockImplementation(async (value) => value)
  vi.spyOn(api, 'books').mockResolvedValue([{ code: 'Gen', name: 'Genesis', section: 'ot', chapters: 50 }])
  vi.spyOn(api, 'chapter').mockImplementation(async (module, book, chapter) => ({ module, book, bookName: 'Genesis', chapter, verses: [] }))
})

afterEach(() => {
  useReader().activateUser(null)
  useSettings().activateUser(null)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('account reader sync', () => {
  it('restores the newest server translation, chapter and settings in a second browser', async () => {
    let remoteCursor: ReadingCursor | null = null
    let remotePreferences: UserPreferences | null = null
    vi.mocked(api.readingCursor).mockImplementation(async () => remoteCursor)
    vi.mocked(api.preferences).mockImplementation(async () => remotePreferences)
    vi.mocked(api.saveReadingCursor).mockImplementation(async (value) => { remoteCursor = value; return value })
    vi.mocked(api.savePreferences).mockImplementation(async (value) => { remotePreferences = value; return value })
    const first = await login('reader')
    first.settings.setTheme('ink')
    first.settings.setDefaultModule('KJV')
    await first.reader.setModule('KJV')
    await first.reader.setChapter(2)
    await vi.advanceTimersByTimeAsync(1000)
    first.reader.activateUser(null)
    first.settings.activateUser(null)
    localStorage.clear()
    setActivePinia(createPinia())
    const second = await login('reader')
    expect([second.reader.moduleName, second.reader.chapter, second.settings.theme, second.settings.defaultModuleName])
      .toEqual(['KJV', 2, 'ink', 'KJV'])
    expect(JSON.parse(localStorage.getItem(cursorKey('reader'))!).updated_at).toBe(remoteCursor!.updated_at)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.saveReadingCursor).toHaveBeenCalledTimes(1)
    expect(api.savePreferences).toHaveBeenCalledTimes(1)
  })

  it.each(['offline', 'server failure'])('keeps reading and preferences usable from cache after %s', async (message) => {
    localStorage.setItem(cursorKey('reader'), JSON.stringify(position))
    localStorage.setItem(prefsKey('reader'), JSON.stringify(preferences))
    vi.mocked(api.readingCursor).mockRejectedValue(new Error(message))
    vi.mocked(api.preferences).mockRejectedValue(new Error(message))
    vi.mocked(api.saveReadingCursor).mockRejectedValue(new Error(message))
    vi.mocked(api.savePreferences).mockRejectedValue(new Error(message))
    const { settings, reader } = await login('reader')
    expect([reader.moduleName, reader.chapter, settings.theme]).toEqual(['WEB', 2, 'ink'])
    expect(reader.ready).toBe(true)
    expect(reader.error).toBeNull()
    settings.toggle('followAlong')
    await reader.setChapter(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.parse(localStorage.getItem(cursorKey('reader'))!).chapter).toBe(3)
    expect(JSON.parse(localStorage.getItem(prefsKey('reader'))!).preferences.followAlong).toBe(false)
    expect(reader.error).toBeNull()
    // A reconnect/login retries the dirty local values, with their original edit timestamps.
    vi.mocked(api.readingCursor).mockResolvedValue(position)
    vi.mocked(api.preferences).mockResolvedValue(preferences)
    vi.mocked(api.saveReadingCursor).mockImplementation(async (value) => value)
    vi.mocked(api.savePreferences).mockImplementation(async (value) => value)
    await Promise.all([reader.restorePosition(), settings.restore()])
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.saveReadingCursor).toHaveBeenLastCalledWith(JSON.parse(localStorage.getItem(cursorKey('reader'))!))
    expect(api.savePreferences).toHaveBeenLastCalledWith(JSON.parse(localStorage.getItem(prefsKey('reader'))!))
  })

  it.each([0, 99, 100])('uses server state over older or tied local cache timestamp %s', async (updated_at) => {
    localStorage.setItem(cursorKey('reader'), JSON.stringify({ ...position, chapter: 3, updated_at }))
    localStorage.setItem(prefsKey('reader'), JSON.stringify({ preferences: { theme: 'paper' }, updated_at }))
    vi.mocked(api.readingCursor).mockResolvedValue(position)
    vi.mocked(api.preferences).mockResolvedValue(preferences)
    const { reader, settings } = await login('reader')
    expect([reader.chapter, settings.theme]).toEqual([2, 'ink'])
    expect(JSON.parse(localStorage.getItem(cursorKey('reader'))!)).toEqual(position)
    expect(JSON.parse(localStorage.getItem(prefsKey('reader'))!)).toEqual(preferences)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.saveReadingCursor).not.toHaveBeenCalled()
    expect(api.savePreferences).not.toHaveBeenCalled()
  })

  it('keeps edits made during a slow restore when the GET response is older', async () => {
    const old = deferred<UserPreferences | null>()
    const { settings } = await login('reader')
    vi.mocked(api.preferences).mockReturnValueOnce(old.promise)
    const restoring = settings.restore()
    settings.setTheme('ink')
    old.resolve({ preferences: { theme: 'paper' }, updated_at: 100 })
    await restoring
    expect(settings.theme).toBe('ink')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ preferences: expect.objectContaining({ theme: 'ink' }) }))
  })

  it('keeps newer local edits and debounces rapid changes into one write per resource', async () => {
    localStorage.setItem(cursorKey('reader'), JSON.stringify({ ...position, updated_at: 200 }))
    localStorage.setItem(prefsKey('reader'), JSON.stringify({ ...preferences, updated_at: 200 }))
    vi.mocked(api.readingCursor).mockResolvedValue({ ...position, chapter: 1 })
    vi.mocked(api.preferences).mockResolvedValue({ ...preferences, preferences: { theme: 'paper' } })
    const { reader, settings } = await login('reader')
    expect(reader.chapter).toBe(2)
    expect(settings.theme).toBe('ink')
    await reader.setChapter(3)
    await reader.setChapter(4)
    settings.setTheme('paper')
    settings.toggle('showFootnotes')
    await vi.advanceTimersByTimeAsync(999)
    expect(api.saveReadingCursor).not.toHaveBeenCalled()
    expect(api.savePreferences).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.saveReadingCursor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chapter: 4 }))
    expect(api.savePreferences).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ preferences: expect.objectContaining({ theme: 'paper', showFootnotes: false }) }))
  })

  it('accepts newer server state returned for rejected stale PUTs without a save loop', async () => {
    const { reader, settings } = await login('reader')
    const newerCursor = { ...position, chapter: 7, updated_at: 5000 }
    const newerPrefs: UserPreferences = { preferences: { theme: 'ink' }, updated_at: 5000 }
    vi.mocked(api.saveReadingCursor).mockResolvedValue(newerCursor)
    vi.mocked(api.savePreferences).mockResolvedValue(newerPrefs)
    settings.setTheme('paper')
    await vi.advanceTimersByTimeAsync(1000)
    expect([reader.chapter, reader.data?.chapter, settings.theme]).toEqual([7, 7, 'ink'])
    expect(JSON.parse(localStorage.getItem(cursorKey('reader'))!)).toEqual(newerCursor)
    expect(JSON.parse(localStorage.getItem(prefsKey('reader'))!)).toEqual(newerPrefs)
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.saveReadingCursor).toHaveBeenCalledTimes(1)
    expect(api.savePreferences).toHaveBeenCalledTimes(1)
  })

  it('never saves a chapter whose load failed', async () => {
    const { reader } = await login('reader')
    await vi.advanceTimersByTimeAsync(1000)
    vi.mocked(api.chapter).mockRejectedValueOnce(new Error('read failed'))
    await reader.setChapter(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader.error).toBe('read failed')
    expect(JSON.parse(localStorage.getItem(cursorKey('reader'))!).chapter).toBe(1)
    expect(api.saveReadingCursor).toHaveBeenCalledTimes(1)
  })

  it('migrates legacy global settings to only the first account and lets existing server preferences win', async () => {
    localStorage.setItem('sword.settings.v1', JSON.stringify({ theme: 'ink', defaultModuleName: 'KJV', unknown: 'drop' }))
    const { settings } = await login('first')
    expect(settings.theme).toBe('ink')
    expect(localStorage.getItem('sword.settings.v1')).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.savePreferences).toHaveBeenLastCalledWith({ preferences: { theme: 'ink', defaultModuleName: 'KJV' }, updated_at: 0 })
    await login('second')
    expect(settings.theme).toBe('paper')
    expect(settings.defaultModuleName).toBeNull()
    expect(localStorage.getItem(prefsKey('second'))).toBeNull()
    await login('first')
    expect(settings.theme).toBe('ink')
    // A legacy value must also be consumed if the first account already has server settings.
    localStorage.clear()
    localStorage.setItem('sword.settings.v1', '{"theme":"ink"}')
    vi.mocked(api.preferences).mockResolvedValue({ preferences: { theme: 'paper' }, updated_at: 10 })
    await login('server-user')
    expect(settings.theme).toBe('paper')
    expect(localStorage.getItem('sword.settings.v1')).toBeNull()
  })

  it('cancels queued writes when accounts change and resets settings on logout', async () => {
    const { reader, settings } = await login('first')
    settings.setTheme('ink')
    await reader.setChapter(2)
    await login('second')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.savePreferences).not.toHaveBeenCalled()
    expect(api.saveReadingCursor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chapter: 1 }))
    expect(settings.theme).toBe('paper')
    settings.setTheme('ink')
    reader.activateUser(null)
    settings.activateUser(null)
    await vi.advanceTimersByTimeAsync(1000)
    expect(settings.theme).toBe('paper')
    expect(api.savePreferences).not.toHaveBeenCalled()
  })

  it.each(['GET', 'PUT'] as const)('ignores delayed %s results after switching away and back to the same user', async (method) => {
    const oldCursor = deferred<ReadingCursor | null>()
    const oldPrefs = deferred<UserPreferences | null>()
    const stores = prepare()
    stores.settings.activateUser('first')
    stores.reader.activateUser('first')
    let pending: Promise<unknown>
    if (method === 'GET') {
      vi.mocked(api.readingCursor).mockReturnValueOnce(oldCursor.promise)
      vi.mocked(api.preferences).mockReturnValueOnce(oldPrefs.promise)
      pending = Promise.all([stores.reader.init(), stores.settings.restore()])
    } else {
      await stores.reader.init()
      stores.settings.setTheme('ink')
      // PUTs cannot return null; only the non-null values below resolve these promises.
      vi.mocked(api.saveReadingCursor).mockImplementationOnce(async () => (await oldCursor.promise)!)
      vi.mocked(api.savePreferences).mockImplementationOnce(async () => (await oldPrefs.promise)!)
      await vi.advanceTimersByTimeAsync(1000)
      pending = Promise.resolve()
    }
    await login('second')
    const { reader, settings } = await login('first')
    const beforeCursor = localStorage.getItem(cursorKey('first'))
    const beforePrefs = localStorage.getItem(prefsKey('first'))
    oldCursor.resolve({ ...position, chapter: 9, updated_at: 9000 })
    oldPrefs.resolve({ ...preferences, updated_at: 9000 })
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(reader.chapter).toBe(1)
    expect(settings.theme).toBe(method === 'PUT' ? 'ink' : 'paper')
    expect(localStorage.getItem(cursorKey('first'))).toBe(beforeCursor)
    expect(localStorage.getItem(prefsKey('first'))).toBe(beforePrefs)
  })

  it('does not roll back a new edit when an older save completes', async () => {
    const old = deferred<UserPreferences>()
    const { settings } = await login('reader')
    vi.mocked(api.savePreferences).mockReturnValueOnce(old.promise)
    settings.setTheme('ink')
    await vi.advanceTimersByTimeAsync(1000)
    const submitted = vi.mocked(api.savePreferences).mock.calls[0][0]
    settings.setTheme('paper')
    old.resolve(submitted)
    await vi.advanceTimersByTimeAsync(0)
    expect(settings.theme).toBe('paper')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.savePreferences).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem(prefsKey('reader'))!).preferences.theme).toBe('paper')
  })

  it('uses defaults for corrupt caches and keeps reading when browser storage is blocked', async () => {
    localStorage.setItem(cursorKey('reader'), '{invalid')
    localStorage.setItem(prefsKey('reader'), '{"preferences":{"theme":false},"updated_at":20}')
    let stores = await login('reader')
    expect([stores.reader.chapter, stores.settings.theme]).toEqual([1, 'paper'])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    stores = await login('blocked')
    stores.settings.setTheme('ink')
    await stores.reader.setChapter(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(stores.reader.error).toBeNull()
    expect(stores.reader.chapter).toBe(2)
    expect(api.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ preferences: expect.objectContaining({ theme: 'ink' }) }))
  })
})
