import { defineStore } from 'pinia'
import { api, type BookEntry, type ChapterPayload } from '../services/api'
import { highlightsDb } from '../services/db'
import { useLibrary } from './library'
import { useSettings } from './settings'

interface ReaderState {
  moduleName: string | null
  books: BookEntry[]
  book: string | null
  chapter: number
  data: ChapterPayload | null
  selectedVerse: number | null
  rangeEnd: number | null
  highlights: Record<string, string>
  loadingChapter: boolean
  error: string | null
  ready: boolean
}

const HL_COLOR = 'rgba(201,162,39,0.25)'

const POS_KEY = 'sword.reader.pos.v1'

function loadPos(): { moduleName: string; book: string; chapter: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (typeof p?.moduleName === 'string' && p.moduleName && typeof p?.book === 'string' && p.book && typeof p?.chapter === 'number') {
      return { moduleName: p.moduleName, book: p.book, chapter: p.chapter }
    }
    return null
  } catch {
    return null
  }
}

export const useReader = defineStore('reader', {
  state: (): ReaderState => ({
    moduleName: null,
    books: [],
    book: null,
    chapter: 1,
    data: null,
    selectedVerse: null,
    rangeEnd: null,
    highlights: {},
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
    currentRef(): string {
      if (!this.book) return ''
      const base = `${this.bookName} ${this.chapter}`
      if (this.selectedVerse == null) return `${base} · ${this.moduleName}`
      const end = this.rangeEnd ?? this.selectedVerse
      const lo = Math.min(this.selectedVerse, end)
      const hi = Math.max(this.selectedVerse, end)
      const versePart = lo === hi ? `${lo}` : `${lo}–${hi}`
      return `${base}:${versePart} · ${this.moduleName}`
    },
    // Verse numbers covered by the current selection: the range [anchor..rangeEnd]
    // intersected with the chapter's actual verses. Empty when nothing is selected.
    selectedVerses(state): number[] {
      if (state.selectedVerse == null) return []
      const end = state.rangeEnd ?? state.selectedVerse
      const lo = Math.min(state.selectedVerse, end)
      const hi = Math.max(state.selectedVerse, end)
      const inRange = (state.data?.verses ?? []).map((v) => v.n).filter((n) => n >= lo && n <= hi)
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
      const lib = useLibrary()
      await lib.load()
      await this.loadHighlights()
      const bibles = lib.installedBibles
      if (bibles.length === 0) {
        this.ready = true
        return
      }
      const saved = loadPos()
      if (saved && bibles.some((m) => m.name === saved.moduleName)) {
        // Set book/chapter first so setModule's `keep` check preserves them
        // (or drops to John 1 if the saved module lacks the saved book).
        this.book = saved.book
        this.chapter = saved.chapter
        await this.setModule(saved.moduleName)
      } else {
        const preferred = this.effectiveDefaultModule
        if (preferred) await this.setModule(preferred)
      }
      this.ready = true
    },
    async loadHighlights(): Promise<void> {
      const all = await highlightsDb.all()
      const map: Record<string, string> = {}
      for (const h of all) map[h.key] = h.color
      this.highlights = map
    },
    async setModule(name: string): Promise<void> {
      this.moduleName = name
      this.error = null
      try {
        this.books = await api.books(name)
      } catch (e) {
        this.books = []
        this.error = (e as Error).message
        return
      }
      // Keep the current book/chapter if the new module has it; else default.
      const keep = this.book && this.books.some((b) => b.code === this.book)
      if (!keep) {
        const john = this.books.find((b) => b.code === 'John')
        const target = john ?? this.books[0]
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
    async openRef(module: string, book: string, chapter: number, verse?: number): Promise<void> {
      if (module !== this.moduleName) {
        this.moduleName = module
        try {
          this.books = await api.books(module)
        } catch (e) {
          this.error = (e as Error).message
        }
      }
      this.book = book
      this.chapter = chapter
      await this.loadChapter()
      if (verse != null) {
        this.selectedVerse = verse
        this.rangeEnd = verse
      }
    },
    async setChapter(n: number): Promise<void> {
      this.chapter = n
      await this.loadChapter()
    },
    async loadChapter(): Promise<void> {
      if (!this.moduleName || !this.book) return
      this.loadingChapter = true
      this.error = null
      try {
        this.data = await api.chapter(this.moduleName, this.book, this.chapter)
        this.selectedVerse = null
        this.rangeEnd = null
        this.persistPos()
      } catch (e) {
        this.data = null
        this.error = (e as Error).message
      } finally {
        this.loadingChapter = false
      }
    },
    persistPos(): void {
      if (!this.moduleName || !this.book) return
      localStorage.setItem(
        POS_KEY,
        JSON.stringify({ moduleName: this.moduleName, book: this.book, chapter: this.chapter })
      )
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
      for (const v of verses) {
        const key = keyFor(v)
        if (allOn) {
          delete next[key]
          await highlightsDb.remove(key)
        } else {
          next[key] = HL_COLOR
          await highlightsDb.set(key, HL_COLOR)
        }
      }
      this.highlights = next
    }
  }
})
