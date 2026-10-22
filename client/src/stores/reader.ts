import { defineStore } from 'pinia'
import { bookCode, parseReadingCursor, type ReadingCursor, type ScriptureTarget } from '@machaira/scripture'
import { AccountCache } from '../services/accountCache'
import { api, type BookEntry, type ChapterPayload } from '../services/api'
import { formatPassageRef } from '../utils/passageRef'
import { moduleLabel } from '../utils/moduleLabel'
import { useLibrary } from './library'
import { useSettings } from './settings'
import type { PassageLocation } from '../router'

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
let referenceOpenGeneration = 0
const positionSyncs = new WeakMap<object, AccountCache<ReadingCursor>>()
const highlightMutations = new WeakMap<object, Promise<void>>()

export type OpenReferenceResult =
  | { ok: true; notice?: string }
  | { ok: false; error: string }

function positionKey(userId: string): string {
  return `${POS_KEY_PREFIX}${encodeURIComponent(userId)}`
}

function parseCachedPosition(value: unknown): ReadingCursor | null {
  // v2 caches predate timestamps. Give those entries the lowest priority during migration.
  if (value && typeof value === 'object' && !Array.isArray(value) && !('updated_at' in value)) {
    return parseReadingCursor({ ...value, updated_at: 0 })
  }
  return parseReadingCursor(value)
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
    installedBibles(): { name: string; description: string; label: string }[] {
      return useLibrary().installedBibles.map((m) => ({
        name: m.name,
        description: m.description,
        label: moduleLabel(m)
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
    async reconcileInstalled(): Promise<void> {
      if (!this.activeUserId || !this.ready) return
      if (this.moduleName && this.installedBibles.some((module) => module.name === this.moduleName)) return
      const preferred = this.effectiveDefaultModule
      if (preferred) {
        await this.setModule(preferred)
      } else {
        moduleLoadGeneration += 1
        chapterLoadGeneration += 1
        referenceOpenGeneration += 1
        this.moduleName = null
        this.books = []
        this.book = null
        this.chapter = 1
        this.data = null
        this.clearSelection()
        this.loadingChapter = false
        this.error = null
      }
    },
    async init(initialPassage?: PassageLocation): Promise<OpenReferenceResult | undefined> {
      const userId = this.activeUserId
      const generation = readerGeneration
      if (!userId) return
      await positionSyncs.get(this)?.restore()
      if (generation !== readerGeneration || this.activeUserId !== userId) return
      const lib = useLibrary()
      await lib.load()
      if (generation !== readerGeneration || this.activeUserId !== userId) return
      const bibles = lib.installedBibles
      if (bibles.length === 0) {
        this.ready = true
        return
      }
      // Restore sync timestamps first, but never display or persist the saved cursor over
      // an explicit URL on this load. Resolve foreign links before restoring a saved cursor.
      let initialResult: OpenReferenceResult | undefined
      if (initialPassage) {
        const result = await this.openRoute(initialPassage, undefined, { fallbackToDefault: true })
        initialResult = result
        if (generation !== readerGeneration || this.activeUserId !== userId) return
        if (result.ok) {
          this.ready = true
          return result
        }
      }
      const saved = positionSyncs.get(this)?.current
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
      return initialResult
    },
    async loadHighlights(): Promise<void> {
      const generation = ++highlightLoadGeneration
      const all = await api.highlights()
      if (generation !== highlightLoadGeneration) return
      const map: Record<string, string> = {}
      for (const h of all) map[h.key] = h.color
      this.highlights = map
      this.highlightError = null
    },
    async openRoute(
      target: PassageLocation,
      isCurrent: () => boolean = () => true,
      { fallbackToDefault = false }: { fallbackToDefault?: boolean } = {}
    ): Promise<OpenReferenceResult> {
      const generation = ++referenceOpenGeneration
      const accountGeneration = readerGeneration
      const moduleGeneration = moduleLoadGeneration
      const chapterGeneration = chapterLoadGeneration
      const current = () => isCurrent() && generation === referenceOpenGeneration &&
        accountGeneration === readerGeneration && moduleGeneration === moduleLoadGeneration &&
        chapterGeneration === chapterLoadGeneration
      const unavailable = { ok: false, error: 'This passage link is not available in your library.' } as const
      if (!Number.isSafeInteger(target.chapter) || target.chapter < 1 ||
        (target.verseStart === null && target.verseEnd !== null)) return unavailable
      // Preflight each candidate without changing the reader. An unavailable module or a
      // different canon must never make a partial navigation persist a Genesis cursor.
      // URL recovery is opt-in: internal connections are already mapped to a translation
      // and must retain their existing failure behavior rather than silently switching it.
      const modules = [...new Set([target.moduleName, fallbackToDefault ? this.effectiveDefaultModule : null])]
        .filter((name): name is string => !!name && this.installedBibles.some((module) => module.name === name))
      for (const moduleName of modules) {
        try {
          const books = this.moduleName === moduleName && this.books.length
            ? this.books : await api.books(moduleName)
          if (!current()) return unavailable
          const canonicalBook = bookCode(target.book)
          const book = books.find((book) => book.code === target.book) ??
            books.find((book) => book.code === canonicalBook || book.name.toLocaleLowerCase() === target.book.trim().toLocaleLowerCase())
          if (!book || !validChapter(book, target.chapter)) continue
          const data = await api.chapter(moduleName, book.code, target.chapter)
          if (!current()) return unavailable
          if (data.module !== moduleName || data.book !== book.code || data.chapter !== target.chapter) continue
          if (target.verseStart !== null) {
            const start = target.verseStart
            const end = target.verseEnd ?? start
            const verses = new Set(data.verses.map((verse) => verse.n))
            // Count available verses instead of iterating an untrusted, potentially huge range.
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start ||
              [...verses].filter((verse) => verse >= start && verse <= end).length !== end - start + 1) {
              continue
            }
          }
          const module = this.installedBibles.find((candidate) => candidate.name === moduleName)
          if (!module) return unavailable
          moduleLoadGeneration += 1
          chapterLoadGeneration += 1
          this.moduleName = moduleName
          this.books = books
          this.book = book.code
          this.chapter = target.chapter
          this.data = data
          this.selectedVerse = target.verseStart
          this.rangeEnd = target.verseEnd ?? target.verseStart
          this.loadingChapter = false
          this.error = null
          this.persistPos()
          const label = module.label
          const ref = formatPassageRef({ ...target, book: book.name, moduleName: null })
          if (moduleName !== target.moduleName) {
            return { ok: true, notice: `The linked translation (${target.moduleName}) could not open this passage. Opened ${ref} in your default translation, ${label}.` }
          }
          return book.code === target.book ? { ok: true }
            : { ok: true, notice: `Resolved this passage link to ${ref} in ${label}.` }
        } catch {
          if (!current()) return unavailable
        }
      }
      return unavailable
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
      else {
        this.data = null
        this.clearSelection()
      }
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
    async openAvailableRef(target: ScriptureTarget): Promise<OpenReferenceResult> {
      const moduleName = this.moduleName
      const userId = this.activeUserId
      if (!moduleName) return { ok: false, error: 'No current translation is available.' }
      const book = this.books.find((candidate) => candidate.code === target.book)
      if (!book || target.chapter > book.chapters) {
        return { ok: false, error: `This reference is not available in ${moduleName}.` }
      }

      const generation = ++referenceOpenGeneration
      const originBook = this.book
      const originChapter = this.chapter
      let data: ChapterPayload
      try {
        data = await api.chapter(moduleName, target.book, target.chapter)
      } catch {
        return { ok: false, error: `This reference is not available in ${moduleName}.` }
      }
      if (
        generation !== referenceOpenGeneration ||
        this.activeUserId !== userId ||
        this.moduleName !== moduleName ||
        this.book !== originBook ||
        this.chapter !== originChapter
      ) {
        return { ok: false, error: 'The passage changed before this reference could open.' }
      }

      if (target.verseStart !== null) {
        const verses = new Set(data.verses.map((verse) => verse.n))
        const end = target.verseEnd ?? target.verseStart
        for (let verse = target.verseStart; verse <= end; verse += 1) {
          if (!verses.has(verse)) {
            return { ok: false, error: `This reference is not available in ${moduleName}.` }
          }
        }
      }

      // Invalidate an older chapter fetch only once this preflight is known to be valid.
      chapterLoadGeneration += 1
      this.loadingChapter = false
      this.book = target.book
      this.chapter = target.chapter
      this.data = data
      this.selectedVerse = target.verseStart
      this.rangeEnd = target.verseStart === null ? null : (target.verseEnd ?? target.verseStart)
      this.error = null
      this.persistPos()
      return { ok: true }
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
    async restorePosition(): Promise<void> {
      await positionSyncs.get(this)?.restore()
    },
    persistPos(): void {
      if (!this.activeUserId || !this.moduleName || !this.book) return
      positionSyncs.get(this)?.update({ moduleName: this.moduleName, book: this.book, chapter: this.chapter })
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
      const generation = readerGeneration
      const keys = [...new Set(verses)].map((v) => `${this.moduleName}/${this.book}/${this.chapter}/${v}`)
      const previous = highlightMutations.get(this) ?? Promise.resolve()
      const mutation = previous.catch(() => undefined).then(async () => {
        if (generation !== readerGeneration) return
        const allOn = keys.every((key) => this.highlights[key])
        try {
          await api.updateHighlights(
            allOn ? [] : keys.map((key) => ({ key, color: HL_COLOR })),
            allOn ? keys : []
          )
          if (generation !== readerGeneration) return
          highlightLoadGeneration += 1
          const next = { ...this.highlights }
          for (const key of keys) {
            if (allOn) delete next[key]
            else next[key] = HL_COLOR
          }
          this.highlights = next
          this.highlightError = null
        } catch (error) {
          if (generation !== readerGeneration) return
          const message = `Highlight was not saved: ${(error as Error).message}`
          await this.loadHighlights().catch(() => undefined)
          if (generation !== readerGeneration) return
          this.highlightError = message
        }
      })
      highlightMutations.set(this, mutation)
      try { await mutation }
      finally {
        if (highlightMutations.get(this) === mutation) highlightMutations.delete(this)
      }
    },
    activateUser(userId: string | null): void {
      positionSyncs.get(this)?.activate(null)
      readerGeneration += 1
      moduleLoadGeneration += 1
      chapterLoadGeneration += 1
      highlightLoadGeneration += 1
      referenceOpenGeneration += 1
      highlightMutations.delete(this)
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
      const sync = new AccountCache<ReadingCursor>({
        key: positionKey,
        parse: parseCachedPosition,
        get: () => api.readingCursor(),
        put: (value) => api.saveReadingCursor(value),
        apply: (value) => {
          if (!this.ready || !this.installedBibles.some((module) => module.name === value.moduleName)) return
          if (this.moduleName === value.moduleName && this.book === value.book && this.chapter === value.chapter) return
          void this.openRef(value.moduleName, value.book, value.chapter)
        }
      })
      positionSyncs.set(this, sync)
      sync.activate(userId)
    }
  }
})
