import { defineStore } from 'pinia'
import { api, type BookEntry, type ChapterPayload } from '../services/api'
import { highlightsDb } from '../services/db'
import { useLibrary } from './library'

interface ReaderState {
  moduleName: string | null
  books: BookEntry[]
  book: string | null
  chapter: number
  data: ChapterPayload | null
  selectedVerse: number | null
  highlights: Record<string, string>
  loadingChapter: boolean
  error: string | null
  ready: boolean
}

const HL_COLOR = 'rgba(201,162,39,0.25)'

export const useReader = defineStore('reader', {
  state: (): ReaderState => ({
    moduleName: null,
    books: [],
    book: null,
    chapter: 1,
    data: null,
    selectedVerse: null,
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
    currentBook(state): BookEntry | undefined {
      return state.books.find((b) => b.code === state.book)
    },
    bookName(): string {
      return this.currentBook?.name ?? this.book ?? ''
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
      const preferred = bibles.find((m) => m.name.toUpperCase() === 'WEB') ?? bibles[0]
      await this.setModule(preferred.name)
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
      if (verse != null) this.selectedVerse = verse
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
      } catch (e) {
        this.data = null
        this.error = (e as Error).message
      } finally {
        this.loadingChapter = false
      }
    },
    selectVerse(n: number): void {
      this.selectedVerse = this.selectedVerse === n ? null : n
    },
    async toggleHighlight(verse: number): Promise<void> {
      if (!this.moduleName || !this.book) return
      const key = `${this.moduleName}/${this.book}/${this.chapter}/${verse}`
      if (this.highlights[key]) {
        const { [key]: _drop, ...rest } = this.highlights
        this.highlights = rest
        await highlightsDb.remove(key)
      } else {
        this.highlights = { ...this.highlights, [key]: HL_COLOR }
        await highlightsDb.set(key, HL_COLOR)
      }
    }
  }
})
