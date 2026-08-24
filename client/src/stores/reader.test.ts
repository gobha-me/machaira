import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api, type BookEntry, type ChapterPayload, type ModuleInfo } from '../services/api'
import { useLibrary } from './library'
import { useReader } from './reader'
import { useSettings } from './settings'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const standardBooks: BookEntry[] = [
  { code: 'John', name: 'John', section: 'nt', chapters: 21 },
  { code: 'Gen', name: 'Genesis', section: 'ot', chapters: 50 },
  { code: 'Rom', name: 'Romans', section: 'nt', chapters: 16 }
]

function bible(name: string): ModuleInfo {
  return {
    id: `CrossWire:${name}`,
    name,
    type: 'BIBLE',
    description: `${name} Bible`,
    language: 'en',
    hasStrongs: false,
    hasGreekStrongsKeys: false,
    hasHebrewStrongsKeys: false,
    hasFootnotes: false,
    hasHeadings: false,
    hasRedLetterWords: false,
    hasCrossReferences: false,
    locked: false,
    installed: true,
    kind: 'scripture',
    collection: 'bible',
    coverage: [],
    coverageSource: 'unknown',
    format: 'bundled',
    coverageSummary: 'Exact book coverage has not been audited',
    aiEligibility: 'public-domain'
  }
}

function chapter(moduleName: string, book: string, chapterNumber: number): ChapterPayload {
  const entry = standardBooks.find((candidate) => candidate.code === book)
  return {
    module: moduleName,
    book,
    bookName: entry?.name ?? book,
    chapter: chapterNumber,
    verses: []
  }
}

function prepareLibrary(...names: string[]): void {
  const library = useLibrary()
  library.modules = names.map(bible)
  library.loaded = true
}

function mockReaderApi(booksByModule: Record<string, BookEntry[]> = { WEB: standardBooks }): void {
  vi.spyOn(api, 'books').mockImplementation(async (moduleName) => booksByModule[moduleName] ?? [])
  vi.spyOn(api, 'chapter').mockImplementation(async (moduleName, book, chapterNumber) =>
    chapter(moduleName, book, chapterNumber)
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('reader position', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', new MemoryStorage())
  })

  it('opens Genesis 1 for a fresh user even when Genesis is not listed first', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect(reader.ready).toBe(true)
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Gen', 1])
    expect(localStorage.getItem('sword.reader.pos.v2:user-a')).toBe(
      JSON.stringify({ moduleName: 'WEB', book: 'Gen', chapter: 1 })
    )
  })

  it('restores a valid saved module, book, and chapter', async () => {
    prepareLibrary('WEB', 'KJV')
    mockReaderApi({ WEB: standardBooks, KJV: standardBooks })
    localStorage.setItem(
      'sword.reader.pos.v2:user-a',
      JSON.stringify({ moduleName: 'KJV', book: 'Rom', chapter: 8 })
    )
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['KJV', 'Rom', 8])
    expect(api.chapter).toHaveBeenCalledWith('KJV', 'Rom', 8)
  })

  it('keeps positions isolated while switching accounts in one browser', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    localStorage.setItem(
      'sword.reader.pos.v2:user-a',
      JSON.stringify({ moduleName: 'WEB', book: 'Rom', chapter: 8 })
    )
    localStorage.setItem(
      'sword.reader.pos.v2:user-b',
      JSON.stringify({ moduleName: 'WEB', book: 'John', chapter: 3 })
    )
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()
    expect([reader.book, reader.chapter]).toEqual(['Rom', 8])

    reader.activateUser('user-b')
    expect(reader.data).toBeNull()
    await reader.init()
    expect([reader.book, reader.chapter]).toEqual(['John', 3])

    reader.activateUser('user-a')
    await reader.init()
    expect([reader.book, reader.chapter]).toEqual(['Rom', 8])
  })

  it('falls back to the preferred module and Genesis when the saved module was removed', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    useSettings().defaultModuleName = 'WEB'
    localStorage.setItem(
      'sword.reader.pos.v2:user-a',
      JSON.stringify({ moduleName: 'KJV', book: 'Rom', chapter: 8 })
    )
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Gen', 1])
  })

  it('uses the saved module landing when its saved passage is invalid', async () => {
    prepareLibrary('KJV')
    mockReaderApi({ KJV: standardBooks })
    localStorage.setItem(
      'sword.reader.pos.v2:user-a',
      JSON.stringify({ moduleName: 'KJV', book: 'Rom', chapter: 99 })
    )
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['KJV', 'Gen', 1])
  })

  it('uses the saved module landing when that canon does not contain the saved book', async () => {
    const limitedBooks: BookEntry[] = [
      { code: 'Gen', name: 'Genesis', section: 'ot', chapters: 50 },
      { code: 'Exod', name: 'Exodus', section: 'ot', chapters: 40 }
    ]
    prepareLibrary('TORAH')
    mockReaderApi({ TORAH: limitedBooks })
    localStorage.setItem(
      'sword.reader.pos.v2:user-a',
      JSON.stringify({ moduleName: 'TORAH', book: 'Rom', chapter: 8 })
    )
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['TORAH', 'Gen', 1])
  })

  it('uses the first available book for a nonstandard canon without Genesis', async () => {
    const nonstandardBooks: BookEntry[] = [
      { code: 'Tob', name: 'Tobit', section: 'apocrypha', chapters: 14 },
      { code: 'Jdt', name: 'Judith', section: 'apocrypha', chapters: 16 }
    ]
    prepareLibrary('APOC')
    mockReaderApi({ APOC: nonstandardBooks })
    localStorage.setItem('sword.reader.pos.v2:user-a', '{invalid json')
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['APOC', 'Tob', 1])
  })

  it('ignores and removes the unsafe browser-global legacy position', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    localStorage.setItem(
      'sword.reader.pos.v1',
      JSON.stringify({ moduleName: 'WEB', book: 'Rom', chapter: 8 })
    )
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect(localStorage.getItem('sword.reader.pos.v1')).toBeNull()
    expect([reader.book, reader.chapter]).toEqual(['Gen', 1])
  })

  it('keeps reading when browser storage is unavailable', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') }
    })
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect(reader.error).toBeNull()
    expect(reader.data).toEqual(chapter('WEB', 'Gen', 1))
  })

  it('retains the empty state when no Bibles are installed', async () => {
    prepareLibrary()
    const books = vi.spyOn(api, 'books')
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect(reader.ready).toBe(true)
    expect(reader.moduleName).toBeNull()
    expect(books).not.toHaveBeenCalled()
  })

  it('discards initialization that finishes after the account changes', async () => {
    prepareLibrary('WEB')
    const firstBooks = deferred<BookEntry[]>()
    vi.spyOn(api, 'books')
      .mockReturnValueOnce(firstBooks.promise)
      .mockResolvedValueOnce(standardBooks)
    vi.spyOn(api, 'chapter').mockImplementation(async (moduleName, book, chapterNumber) =>
      chapter(moduleName, book, chapterNumber)
    )
    const reader = useReader()

    reader.activateUser('user-a')
    const staleInit = reader.init()
    await vi.waitFor(() => expect(api.books).toHaveBeenCalledTimes(1))

    reader.activateUser('user-b')
    await reader.init()
    firstBooks.resolve(standardBooks)
    await staleInit

    expect(reader.activeUserId).toBe('user-b')
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Gen', 1])
    expect(api.chapter).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight reference open when the account changes', async () => {
    prepareLibrary('WEB', 'KJV')
    mockReaderApi({ WEB: standardBooks, KJV: standardBooks })
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    const staleBooks = deferred<BookEntry[]>()
    vi.mocked(api.books).mockReturnValueOnce(staleBooks.promise)
    const staleOpen = reader.openRef('KJV', 'Rom', 8, 3)
    await vi.waitFor(() => expect(api.books).toHaveBeenCalledTimes(2))

    reader.activateUser('user-b')
    await reader.init()
    staleBooks.resolve(standardBooks)
    await staleOpen

    expect(reader.activeUserId).toBe('user-b')
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Gen', 1])
    expect(reader.selectedVerse).toBeNull()
    expect(api.chapter).toHaveBeenCalledTimes(2)
  })
})
