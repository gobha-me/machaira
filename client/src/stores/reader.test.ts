import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function chapterWithVerses(
  moduleName: string,
  book: string,
  chapterNumber: number,
  verses: number[]
): ChapterPayload {
  return {
    ...chapter(moduleName, book, chapterNumber),
    verses: verses.map((n) => ({
      n,
      text: `Verse ${n}`,
      notes: [],
      segments: [{ kind: 'text' as const, text: `Verse ${n}` }],
      crossReferences: []
    }))
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
  afterEach(() => useReader().activateUser(null))

  it('recovers after installing the first translation into a ready empty reader', async () => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    mockReaderApi()
    const reader = useReader()
    reader.activateUser('reader')
    prepareLibrary()
    await reader.init()
    expect(reader.ready).toBe(true)
    expect(reader.moduleName).toBeNull()
    prepareLibrary('WEB')
    await reader.reconcileInstalled()
    expect(reader.moduleName).toBe('WEB')
    expect(reader.book).toBe('Gen')
    expect(reader.data?.book).toBe('Gen')
  })

  it('preserves valid passages on fallback and clears the final removed translation', async () => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    mockReaderApi({ WEB: standardBooks, KJV: standardBooks })
    const reader = useReader()
    reader.activateUser('reader')
    prepareLibrary('KJV', 'WEB')
    reader.ready = true
    reader.book = 'John'
    reader.chapter = 3
    await reader.setModule('KJV')
    prepareLibrary('WEB')
    await reader.reconcileInstalled()
    expect(reader.moduleName).toBe('WEB')
    expect(reader.book).toBe('John')
    expect(reader.chapter).toBe(3)
    prepareLibrary()
    await reader.reconcileInstalled()
    expect(reader.moduleName).toBeNull()
    expect(reader.books).toEqual([])
    expect(reader.data).toBeNull()
    expect(reader.book).toBeNull()
  })

  it('does not reload a valid active translation for unrelated catalogue changes', async () => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    mockReaderApi()
    const reader = useReader()
    reader.activateUser('reader')
    prepareLibrary('WEB')
    reader.ready = true
    await reader.setModule('WEB')
    const bookCalls = vi.mocked(api.books).mock.calls.length
    const chapterCalls = vi.mocked(api.chapter).mock.calls.length
    prepareLibrary('WEB', 'KJV')
    await reader.reconcileInstalled()
    expect(api.books).toHaveBeenCalledTimes(bookCalls)
    expect(api.chapter).toHaveBeenCalledTimes(chapterCalls)
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.spyOn(api, 'readingCursor').mockResolvedValue(null)
    vi.spyOn(api, 'saveReadingCursor').mockImplementation(async (value) => value)
  })

  it('opens Genesis 1 for a fresh user even when Genesis is not listed first', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    const reader = useReader()

    reader.activateUser('user-a')
    await reader.init()

    expect(reader.ready).toBe(true)
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Gen', 1])
    expect(JSON.parse(localStorage.getItem('sword.reader.pos.v2:user-a')!)).toEqual({
      moduleName: 'WEB', book: 'Gen', chapter: 1, updated_at: expect.any(Number)
    })
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

  it('preflights an available reference and commits its range atomically', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    vi.mocked(api.chapter).mockResolvedValueOnce(chapterWithVerses('WEB', 'Rom', 8, [1, 2, 3]))

    const result = await reader.openAvailableRef({
      book: 'Rom', chapter: 8, verseStart: 1, verseEnd: 3
    })

    expect(result).toEqual({ ok: true })
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Rom', 8])
    expect([reader.selectedVerse, reader.rangeEnd]).toEqual([1, 3])
    expect(reader.data?.verses.map((verse) => verse.n)).toEqual([1, 2, 3])
  })

  it.each(['John', 'john', 'Jn', 'Jn.'])('resolves foreign translation links by book name or alias %s in the configured default', async (book) => {
    prepareLibrary('WEB', 'LSV')
    useSettings().defaultModuleName = 'LSV'
    mockReaderApi({ WEB: standardBooks, LSV: standardBooks })
    vi.mocked(api.chapter).mockResolvedValue(chapterWithVerses('LSV', 'John', 3, [16, 17, 18]))
    const reader = useReader()
    reader.activateUser('user-a')

    const result = await reader.init({ moduleName: 'ForeignBible', book, chapter: 3, verseStart: 16, verseEnd: 18 })

    expect(result).toEqual({ ok: true, notice: expect.stringContaining('default translation, LSV') })
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['LSV', 'John', 3])
    expect(reader.selectedVerses).toEqual([16, 17, 18])
    expect(api.books).toHaveBeenCalledExactlyOnceWith('LSV')
    expect(api.chapter).toHaveBeenCalledExactlyOnceWith('LSV', 'John', 3)
    expect(JSON.parse(localStorage.getItem('sword.reader.pos.v2:user-a')!).book).toBe('John')
  })

  it.each(['books failure', 'chapter failure', 'different canon', 'wrong chapter', 'missing verse'])('tries the default after a requested translation has %s', async (failure) => {
    prepareLibrary('KJV', 'LSV')
    useSettings().defaultModuleName = 'LSV'
    mockReaderApi({ KJV: standardBooks, LSV: standardBooks })
    vi.mocked(api.chapter).mockImplementation(async (module) => chapterWithVerses(module, 'John', 3, [16, 17, 18]))
    if (failure === 'books failure') vi.mocked(api.books).mockRejectedValueOnce(new Error('Unavailable'))
    if (failure === 'chapter failure') vi.mocked(api.chapter).mockRejectedValueOnce(new Error('Unavailable'))
    if (failure === 'different canon') vi.mocked(api.books).mockResolvedValueOnce(standardBooks.filter((book) => book.code !== 'John'))
    if (failure === 'wrong chapter') vi.mocked(api.chapter).mockResolvedValueOnce(chapterWithVerses('KJV', 'Gen', 1, [16, 17, 18]))
    if (failure === 'missing verse') vi.mocked(api.chapter).mockResolvedValueOnce(chapterWithVerses('KJV', 'John', 3, [16, 18]))
    const reader = useReader()
    reader.activateUser('user-a')

    expect(await reader.openRoute({ moduleName: 'KJV', book: 'John', chapter: 3, verseStart: 16, verseEnd: 18 }, undefined, { fallbackToDefault: true }))
      .toEqual({ ok: true, notice: expect.stringContaining('default translation, LSV') })
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['LSV', 'John', 3])
    expect(reader.selectedVerses).toEqual([16, 17, 18])
  })

  it.each([
    { book: 'Unknown', chapter: 3, verseStart: 16, verseEnd: 16 },
    { book: 'Jo', chapter: 3, verseStart: 16, verseEnd: 16 },
    { book: 'John', chapter: 22, verseStart: 16, verseEnd: 16 },
    { book: 'John', chapter: 0, verseStart: 16, verseEnd: 16 },
    { book: 'John', chapter: NaN, verseStart: 16, verseEnd: 16 },
    { book: 'John', chapter: 3, verseStart: 18, verseEnd: 16 },
    { book: 'John', chapter: 3, verseStart: 0, verseEnd: 16 },
    { book: 'John', chapter: 3, verseStart: 16, verseEnd: Number.MAX_SAFE_INTEGER },
    { book: 'John', chapter: 3, verseStart: null, verseEnd: 16 }
  ])('never commits or saves an unresolvable foreign passage %j', async (target) => {
    prepareLibrary('WEB')
    mockReaderApi()
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    const before = JSON.parse(JSON.stringify(reader.$state))
    const cached = localStorage.getItem('sword.reader.pos.v2:user-a')
    vi.mocked(api.chapter).mockResolvedValue(chapterWithVerses('WEB', 'John', 3, [16, 18]))

    expect(await reader.openRoute({ moduleName: 'ForeignBible', ...target }, undefined, { fallbackToDefault: true })).toEqual({
      ok: false, error: 'This passage link is not available in your library.'
    })
    expect(reader.$state).toEqual(before)
    expect(localStorage.getItem('sword.reader.pos.v2:user-a')).toBe(cached)
  })

  it('does not try a fallback after an obsolete linked request finishes', async () => {
    prepareLibrary('WEB', 'KJV')
    mockReaderApi({ WEB: standardBooks, KJV: standardBooks })
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    const books = deferred<BookEntry[]>()
    vi.mocked(api.books).mockReturnValueOnce(books.promise)
    const obsolete = reader.openRoute({ moduleName: 'KJV', book: 'John', chapter: 3, verseStart: null, verseEnd: null }, undefined, { fallbackToDefault: true })
    await reader.setChapter(2)
    books.resolve([])

    expect((await obsolete).ok).toBe(false)
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Gen', 2])
    expect(api.chapter).toHaveBeenCalledTimes(2)
  })

  it('keeps the existing passage if the default translation fails or is removed during recovery', async () => {
    prepareLibrary('WEB', 'KJV')
    mockReaderApi({ WEB: standardBooks, KJV: standardBooks })
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    const before = JSON.parse(JSON.stringify(reader.$state))
    vi.mocked(api.books).mockRejectedValueOnce(new Error('Source unavailable'))
    vi.mocked(api.chapter).mockRejectedValueOnce(new Error('Default unavailable'))
    const target = { moduleName: 'KJV', book: 'John', chapter: 3, verseStart: null, verseEnd: null }
    expect((await reader.openRoute(target, undefined, { fallbackToDefault: true })).ok).toBe(false)
    expect(reader.$state).toEqual(before)

    const pending = deferred<ChapterPayload>()
    vi.mocked(api.chapter).mockReturnValueOnce(pending.promise)
    const recovery = reader.openRoute({ ...target, moduleName: 'ForeignBible' }, undefined, { fallbackToDefault: true })
    prepareLibrary('KJV')
    pending.resolve(chapterWithVerses('WEB', 'John', 3, [16]))
    expect((await recovery).ok).toBe(false)
    expect(reader.$state).toEqual(before)
  })

  it('keeps internal reference failures in their requested translation unless URL recovery is enabled', async () => {
    prepareLibrary('WEB', 'KJV')
    mockReaderApi({ WEB: standardBooks, KJV: standardBooks })
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    vi.mocked(api.chapter).mockRejectedValueOnce(new Error('Cannot read KJV'))
    vi.mocked(api.books).mockClear()
    vi.mocked(api.chapter).mockClear()

    expect((await reader.openRoute({ moduleName: 'KJV', book: 'John', chapter: 3, verseStart: 16, verseEnd: 16 })).ok).toBe(false)
    expect(api.books).toHaveBeenCalledExactlyOnceWith('KJV')
    expect(api.chapter).toHaveBeenCalledExactlyOnceWith('KJV', 'John', 3)
    expect([reader.moduleName, reader.book, reader.chapter]).toEqual(['WEB', 'Gen', 1])
  })

  it('keeps the current passage unchanged when a target is unavailable', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    reader.selectVerse(1)
    const before = {
      book: reader.book,
      chapter: reader.chapter,
      data: reader.data,
      selectedVerse: reader.selectedVerse,
      rangeEnd: reader.rangeEnd
    }
    vi.mocked(api.chapter).mockResolvedValueOnce(chapterWithVerses('WEB', 'John', 3, [15, 16]))

    const result = await reader.openAvailableRef({
      book: 'John', chapter: 3, verseStart: 16, verseEnd: 17
    })

    expect(result).toEqual({ ok: false, error: 'This reference is not available in WEB.' })
    expect({
      book: reader.book,
      chapter: reader.chapter,
      data: reader.data,
      selectedVerse: reader.selectedVerse,
      rangeEnd: reader.rangeEnd
    }).toEqual(before)
  })

  it('keeps the current passage unchanged when reference preflight fails', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    const before = JSON.parse(JSON.stringify(reader.$state))
    vi.mocked(api.chapter).mockRejectedValueOnce(new Error('read failed'))

    expect(await reader.openAvailableRef({
      book: 'John', chapter: 3, verseStart: 16, verseEnd: 16
    })).toEqual({ ok: false, error: 'This reference is not available in WEB.' })
    expect(reader.$state).toEqual(before)
  })

  it('discards a preflight that finishes after the account changes', async () => {
    prepareLibrary('WEB')
    mockReaderApi()
    const reader = useReader()
    reader.activateUser('user-a')
    await reader.init()
    const pending = deferred<ChapterPayload>()
    vi.mocked(api.chapter).mockReturnValueOnce(pending.promise)

    const opening = reader.openAvailableRef({
      book: 'John', chapter: 3, verseStart: 16, verseEnd: 16
    })
    reader.activateUser('user-b')
    pending.resolve(chapterWithVerses('WEB', 'John', 3, [16]))

    expect(await opening).toEqual({
      ok: false,
      error: 'The passage changed before this reference could open.'
    })
    expect(reader.activeUserId).toBe('user-b')
    expect(reader.data).toBeNull()
  })
})
