import { defineStore } from 'pinia'
import { api, type BookEntry, type ChapterPayload } from '../services/api'
import { formatPassageRef } from '../utils/passageRef'
import { useLibrary } from './library'
import { useSettings } from './settings'

interface ReaderState {
  activeUserId: string | null
  moduleName: string | null
  books: BookEntry[]
  book: string | null
  chapter: number
  data: ChapterPayload | null
  selectedVerse: number | null
  rangeEnd: number | null
  highlights: Record<string, string>
  highlightError: string | null
  loadingChapter: boolean
  error: string | null
  ready: boolean
}

const HL_COLOR = 'rgba(201,162,39,0.25)'

const LEGACY_POS_KEY = 'sword.reader.pos.v1'
const POS_KEY_PREFIX = 'sword.reader.pos.v2:'
let readerGeneration = 0
let moduleLoadGeneration = 0
let chapterLoadGeneration = 0
let highlightLoadGeneration = 0

interface ReaderPosition {
  moduleName: string
  book: string
  chapter: number
}

function positionKey(userId: string): string {
  return `${POS_KEY_PREFIX}${encodeURIComponent(userId)}`
}

function loadPos(userId: string): ReaderPosition | null {
  try {
    const raw = localStorage.getItem(positionKey(userId))
    if (!raw) return null
    const p = JSON.parse(raw)
    if (
      typeof p?.moduleName === 'string' && p.moduleName &&
      typeof p?.book === 'string' && p.book &&
      Number.isInteger(p?.chapter) && p.chapter >= 1
    ) {
      return { moduleName: p.moduleName, book: p.book, chapter: p.chapter }
    }
    return null
  } catch {
    return null
  }
}

function discardLegacyPos(): void {
  try {
    // The v1 record was browser-global. It cannot be assigned to an account without risking
    // that one user's passage is restored for another user on the same browser.
    localStorage.removeItem(LEGACY_POS_KEY)
  } catch {
    // Reader startup must still work when browser storage is unavailable.
  }
}

function landingBook(books: BookEntry[]): BookEntry | undefined {
  return books.find((book) => book.code === 'Gen') ?? books[0]
}

function validChapter(book: BookEntry | undefined, chapter: number): boolean {
  return !!book && Number.isInteger(chapter) && chapter >= 1 && chapter <= book.chapters
}

export const useReader = defineStore('reader', {
  state: (): ReaderState => ({
    activeUserId: null,
    moduleName: null,
    books: [],
    book: null,
    chapter: 1,
    data: null,
    selectedVerse: null,
    rangeEnd: null,
    highlights: {},
    highlightError: null,
    loadingChapter: false,
    error: null,
    ready: false
  }),
  getters: {
    installedBibles(): { name: string; description: string }[] {
      return useLibrary().installedBibles.map((m) => ({
        name: m.name,
        description: m.description
      }))
    },
    // The effective default translation: the configured default if installed, else WEB, else
    // the first installed bible. Mirrors the fresh-start pick in init() and anchors compare.
    effectiveDefaultModule(): string | null {
      const bibles = this.installedBibles
      const settings = useSettings()
      const preferred =
        (settings.defaultModuleName && bibles.find((m) => m.name === settings.defaultModuleName)) ||
        bibles.find((m) => m.name.toUpperCase() === 'WEB') ||
        bibles[0]
      return preferred?.name ?? null
    },
    currentBook(state): BookEntry | undefined {
      return state.books.find((b) => b.code === state.book)
    },
    bookName(): string {
      return this.currentBook?.name ?? this.book ?? ''
    },
    selectionBounds(state): { lo: number; hi: number } | null {
      if (state.selectedVerse == null) return null
      const end = state.rangeEnd ?? state.selectedVerse
      return {
        lo: Math.min(state.selectedVerse, end),
        hi: Math.max(state.selectedVerse, end)
      }
    },
    selectionRef(): string {
      if (!this.book) return ''
      return formatPassageRef({
        book: this.bookName,
        chapter: this.chapter,
        verseStart: this.selectionBounds?.lo,
        verseEnd: this.selectionBounds?.hi
      })
    },
    currentRef(): string {
      if (!this.book) return ''
      return formatPassageRef({
        book: this.bookName,
        chapter: this.chapter,
        verseStart: this.selectionBounds?.lo,
        verseEnd: this.selectionBounds?.hi,
        moduleName: this.moduleName
      })
    },
    // Verse numbers covered by the current selection: the range [anchor..rangeEnd]
    // intersected with the chapter's actual verses. Empty when nothing is selected.
    selectedVerses(state): number[] {
      const bounds = this.selectionBounds
      if (!bounds || state.selectedVerse == null) return []
      const inRange = (state.data?.verses ?? [])
        .map((v) => v.n)
        .filter((n) => n >= bounds.lo && n <= bounds.hi)
      return inRange.length ? inRange : [state.selectedVerse]
    },
    hasRange(state): boolean {
      return state.rangeEnd != null && state.rangeEnd !== state.selectedVerse
    },
    highlightColor(state) {
      return (verse: number): string | null => {
        if (!state.moduleName || !state.book) return null
        return state.highlights[`${state.moduleName}/${state.book}/${state.chapter}/${verse}`] ?? null
      }
    }
  },
  actions: {
    async init(): Promise<void> {
      const userId = this.activeUserId
      const generation = readerGeneration
      if (!userId) return
      const lib = useLibrary()
      await lib.load()
      if (generation !== readerGeneration || this.activeUserId !== userId) return
      const bibles = lib.installedBibles
      if (bibles.length === 0) {
        this.ready = true
        return
      }
      const saved = loadPos(userId)
      if (saved && bibles.some((m) => m.name === saved.moduleName)) {
        // Set book/chapter first so setModule can preserve a fully valid saved passage.
        this.book = saved.book
        this.chapter = saved.chapter
        await this.setModule(saved.moduleName)
      } else {
        const preferred = this.effectiveDefaultModule
        if (preferred) await this.setModule(preferred)
      }
      if (generation === readerGeneration && this.activeUserId === userId) this.ready = true
    },
    async loadHighlights(): Promise<void> {
      const generation = highlightLoadGeneration
      const all = await api.highlights()
      if (generation !== highlightLoadGeneration) return
      const map: Record<string, string> = {}
      for (const h of all) map[h.key] = h.color
      this.highlights = map
      this.highlightError = null
    },
    async setModule(name: string): Promise<void> {
      const userId = this.activeUserId
      const readerLoadGeneration = readerGeneration
      const moduleGeneration = ++moduleLoadGeneration
      this.moduleName = name
      this.error = null
      let books: BookEntry[]
      try {
        books = await api.books(name)
      } catch (e) {
        if (
          readerLoadGeneration !== readerGeneration ||
          moduleGeneration !== moduleLoadGeneration ||
          this.activeUserId !== userId
        ) return
        this.books = []
        this.error = (e as Error).message
        return
      }
      if (
        readerLoadGeneration !== readerGeneration ||
        moduleGeneration !== moduleLoadGeneration ||
        this.activeUserId !== userId
      ) return
      this.books = books
      // Preserve the current passage only when both its book and chapter exist in the target
      // module. Otherwise use the canonical fresh landing for that module.
      const currentBook = this.books.find((book) => book.code === this.book)
      if (!validChapter(currentBook, this.chapter)) {
        const target = landingBook(this.books)
        this.book = target?.code ?? null
        this.chapter = 1
      }
      if (this.book) await this.loadChapter()
    },
    async setBook(code: string): Promise<void> {
      this.book = code
      this.chapter = 1
      await this.loadChapter()
    },
    async openRef(
      module: string,
      book: string,
      chapter: number,
      verse?: number,
      verseEnd?: number
    ): Promise<void> {
      const userId = this.activeUserId
      const readerLoadGeneration = readerGeneration
      const moduleGeneration = ++moduleLoadGeneration
      if (module !== this.moduleName) {
        this.moduleName = module
        try {
          const books = await api.books(module)
          if (
            readerLoadGeneration !== readerGeneration ||
            moduleGeneration !== moduleLoadGeneration ||
            this.activeUserId !== userId
          ) return
          this.books = books
        } catch (e) {
          if (
            readerLoadGeneration !== readerGeneration ||
            moduleGeneration !== moduleLoadGeneration ||
            this.activeUserId !== userId
          ) return
          this.error = (e as Error).message
          return
        }
      }
      if (
        readerLoadGeneration !== readerGeneration ||
        moduleGeneration !== moduleLoadGeneration ||
        this.activeUserId !== userId
      ) return
      this.book = book
      this.chapter = chapter
      await this.loadChapter()
      if (
        readerLoadGeneration !== readerGeneration ||
        moduleGeneration !== moduleLoadGeneration ||
        this.activeUserId !== userId ||
        this.moduleName !== module ||
        this.book !== book ||
        this.chapter !== chapter
      ) return
      if (verse != null) {
        this.selectedVerse = verse
        this.rangeEnd = verseEnd ?? verse
      }
    },
    async setChapter(n: number): Promise<void> {
      this.chapter = n
      await this.loadChapter()
    },
    async loadChapter(): Promise<void> {
      if (!this.moduleName || !this.book) return
      const userId = this.activeUserId
      const readerLoadGeneration = readerGeneration
      const loadGeneration = ++chapterLoadGeneration
      const moduleName = this.moduleName
      const book = this.book
      const chapter = this.chapter
      const stale = () =>
        readerLoadGeneration !== readerGeneration ||
        loadGeneration !== chapterLoadGeneration ||
        this.activeUserId !== userId ||
        this.moduleName !== moduleName ||
        this.book !== book ||
        this.chapter !== chapter
      this.loadingChapter = true
      this.error = null
      try {
        const data = await api.chapter(moduleName, book, chapter)
        if (stale()) return
        this.data = data
        this.selectedVerse = null
        this.rangeEnd = null
        this.persistPos()
      } catch (e) {
        if (stale()) return
        this.data = null
        this.error = (e as Error).message
      } finally {
        if (loadGeneration === chapterLoadGeneration) this.loadingChapter = false
      }
    },
    persistPos(): void {
      if (!this.activeUserId || !this.moduleName || !this.book) return
      try {
        localStorage.setItem(
          positionKey(this.activeUserId),
          JSON.stringify({ moduleName: this.moduleName, book: this.book, chapter: this.chapter })
        )
      } catch {
        // A disabled/full localStorage must not turn a successful chapter read into an error.
      }
    },
    // Plain click: single-verse select, toggling off only when re-clicking a lone verse.
    // Clicking within an existing range collapses back to a single anchor.
    selectVerse(n: number): void {
      if (this.selectedVerse === n && !this.hasRange) {
        this.selectedVerse = null
        this.rangeEnd = null
        return
      }
      this.selectedVerse = n
      this.rangeEnd = n
    },
    // Shift-click: extend the selection to [anchor..n], keeping the anchor as the primary
    // verse that compare / word study stay scoped to.
    extendSelection(n: number): void {
      if (this.selectedVerse == null) {
        this.selectedVerse = n
      }
      this.rangeEnd = n
    },
    clearSelection(): void {
      this.selectedVerse = null
      this.rangeEnd = null
    },
    // Toggle a whole passage: if every verse is already highlighted, clear them all;
    // otherwise highlight the lot.
    async toggleHighlightRange(verses: number[]): Promise<void> {
      if (!this.moduleName || !this.book || verses.length === 0) return
      const keyFor = (v: number) => `${this.moduleName}/${this.book}/${this.chapter}/${v}`
      const allOn = verses.every((v) => this.highlights[keyFor(v)])
      const next = { ...this.highlights }
      try {
        const keys = verses.map(keyFor)
        await api.updateHighlights(
          allOn ? [] : keys.map((key) => ({ key, color: HL_COLOR })),
          allOn ? keys : []
        )
        for (const key of keys) {
          if (allOn) delete next[key]
          else next[key] = HL_COLOR
        }
        this.highlights = next
        this.highlightError = null
      } catch (error) {
        const message = `Highlight was not saved: ${(error as Error).message}`
        await this.loadHighlights().catch(() => undefined)
        this.highlightError = message
      }
    },
    activateUser(userId: string | null): void {
      readerGeneration += 1
      moduleLoadGeneration += 1
      chapterLoadGeneration += 1
      highlightLoadGeneration += 1
      this.activeUserId = userId
      this.moduleName = null
      this.books = []
      this.book = null
      this.chapter = 1
      this.data = null
      this.selectedVerse = null
      this.rangeEnd = null
      this.highlights = {}
      this.highlightError = null
      this.loadingChapter = false
      this.error = null
      this.ready = false
      discardLegacyPos()
    }
  }
})
