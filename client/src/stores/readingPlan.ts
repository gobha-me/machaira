import { defineStore } from 'pinia'
import { readingPlanDb } from '../services/db'
import {
  chapterKey,
  chaptersThroughDay,
  daySlice,
  PLAN_DAYS,
  rangeLabel,
  TOTAL_CHAPTERS,
  type Reading
} from '../services/plan'

const DAY_MS = 86_400_000

function midnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

interface ReadingPlanState {
  enabled: boolean
  startDate: number | null
  completed: Set<string>
  loaded: boolean
}

export interface ReadingRow extends Reading {
  read: boolean
}

export const useReadingPlan = defineStore('readingPlan', {
  state: (): ReadingPlanState => ({
    enabled: false,
    startDate: null,
    completed: new Set(),
    loaded: false
  }),
  getters: {
    // Days since the plan began (0-based), clamped to the 365-day window.
    currentDayIndex(state): number {
      if (state.startDate == null) return 0
      const days = Math.floor((midnight(Date.now()) - state.startDate) / DAY_MS)
      return Math.max(0, Math.min(PLAN_DAYS - 1, days))
    },
    currentDay(): number {
      return this.currentDayIndex + 1
    },
    todayReadings(state): ReadingRow[] {
      return daySlice(this.currentDayIndex).map((r) => ({
        ...r,
        read: state.completed.has(chapterKey(r.book, r.chapter))
      }))
    },
    todayLabel(): string {
      return rangeLabel(daySlice(this.currentDayIndex))
    },
    // First unread chapter of today's reading (or the first, if all read).
    firstUnreadToday(state): Reading | null {
      const today = daySlice(this.currentDayIndex)
      return today.find((r) => !state.completed.has(chapterKey(r.book, r.chapter))) ?? today[0] ?? null
    },
    chaptersRead(state): number {
      return state.completed.size
    },
    totalChapters(): number {
      return TOTAL_CHAPTERS
    },
    percent(state): number {
      return Math.round((state.completed.size / TOTAL_CHAPTERS) * 100)
    },
    // Chapters the reader "should" have finished by the end of today.
    expectedChapters(): number {
      return chaptersThroughDay(this.currentDayIndex)
    },
    behindBy(): number {
      return Math.max(0, this.expectedChapters - this.chaptersRead)
    },
    onTrack(): boolean {
      return this.chaptersRead >= this.expectedChapters
    },
    todayComplete(): boolean {
      return this.todayReadings.every((r) => r.read)
    },
    isChapterRead(state) {
      return (book: string, chapter: number): boolean =>
        state.completed.has(chapterKey(book, chapter))
    },
    isDayComplete(state) {
      return (day: number): boolean =>
        daySlice(day).every((r) => state.completed.has(chapterKey(r.book, r.chapter)))
    },
    readingsForDay() {
      return (day: number): ReadingRow[] =>
        daySlice(day).map((r) => ({
          ...r,
          read: this.completed.has(chapterKey(r.book, r.chapter))
        }))
    }
  },
  actions: {
    async load(): Promise<void> {
      if (this.loaded) return
      const rec = await readingPlanDb.get()
      if (rec) {
        this.enabled = rec.enabled
        this.startDate = rec.startDate
        this.completed = new Set(rec.completed)
      }
      this.loaded = true
    },
    persist(): void {
      void readingPlanDb.save({
        id: 'plan',
        enabled: this.enabled,
        startDate: this.startDate,
        completed: [...this.completed]
      })
    },
    setEnabled(v: boolean): void {
      this.enabled = v
      if (v && this.startDate == null) this.startDate = midnight(Date.now())
      this.persist()
    },
    toggle(): void {
      this.setEnabled(!this.enabled)
    },
    markChapterRead(book: string, chapter: number): void {
      const next = new Set(this.completed)
      next.add(chapterKey(book, chapter))
      this.completed = next
      this.persist()
    },
    unmarkChapterRead(book: string, chapter: number): void {
      const next = new Set(this.completed)
      next.delete(chapterKey(book, chapter))
      this.completed = next
      this.persist()
    },
    toggleChapter(book: string, chapter: number): void {
      if (this.isChapterRead(book, chapter)) this.unmarkChapterRead(book, chapter)
      else this.markChapterRead(book, chapter)
    },
    markDayRead(day: number): void {
      const next = new Set(this.completed)
      for (const r of daySlice(day)) next.add(chapterKey(r.book, r.chapter))
      this.completed = next
      this.persist()
    },
    unmarkDayRead(day: number): void {
      const next = new Set(this.completed)
      for (const r of daySlice(day)) next.delete(chapterKey(r.book, r.chapter))
      this.completed = next
      this.persist()
    },
    toggleDay(day: number): void {
      if (this.isDayComplete(day)) this.unmarkDayRead(day)
      else this.markDayRead(day)
    },
    reset(): void {
      this.completed = new Set()
      this.startDate = this.enabled ? midnight(Date.now()) : null
      this.persist()
    }
  }
})
