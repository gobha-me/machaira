// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { localCalendarDay, useReadingPlan } from './readingPlan'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => {
  useReadingPlan().stopClock()
  vi.useRealTimers()
})

describe('reading-plan calendar clock', () => {
  it('updates already-observed readings at local midnight without reloading', async () => {
    vi.setSystemTime(new Date(2026, 8, 28, 23, 59, 59))
    const plan = useReadingPlan()
    plan.startDate = new Date(2026, 8, 28).getTime()
    plan.startClock()
    const initial = plan.todayLabel
    expect(plan.currentDay).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(plan.currentDay).toBe(2)
    expect(plan.todayLabel).not.toBe(initial)
  })

  it('refreshes on focus and visibility changes after a suspended clock', () => {
    vi.setSystemTime(new Date(2026, 8, 28, 10))
    const plan = useReadingPlan()
    plan.startDate = new Date(2026, 8, 28).getTime()
    plan.startClock()
    expect(plan.currentDay).toBe(1)
    vi.setSystemTime(new Date(2026, 9, 1, 10))
    window.dispatchEvent(new Event('focus'))
    expect(plan.currentDay).toBe(4)
    vi.setSystemTime(new Date(2026, 9, 2, 10))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(plan.currentDay).toBe(5)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stops timers and event listeners on cleanup and avoids duplicate clocks', () => {
    vi.setSystemTime(new Date(2026, 8, 28))
    const plan = useReadingPlan()
    plan.startClock()
    plan.startClock()
    expect(vi.getTimerCount()).toBe(1)
    plan.stopClock()
    expect(vi.getTimerCount()).toBe(0)
    const day = plan.calendarDay
    vi.setSystemTime(new Date(2026, 8, 29))
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(plan.calendarDay).toBe(day)
  })

  it('counts calendar dates across 23- and 25-hour daylight-saving days', () => {
    const previousZone = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const springStart = new Date(2026, 2, 8).getTime()
      const springNext = new Date(2026, 2, 9).getTime()
      const autumnStart = new Date(2026, 10, 1).getTime()
      const autumnNext = new Date(2026, 10, 2).getTime()
      expect(springNext - springStart).toBe(23 * 60 * 60 * 1000)
      expect(autumnNext - autumnStart).toBe(25 * 60 * 60 * 1000)
      expect(localCalendarDay(springNext) - localCalendarDay(springStart)).toBe(1)
      expect(localCalendarDay(autumnNext) - localCalendarDay(autumnStart)).toBe(1)
      const plan = useReadingPlan()
      plan.startDate = springStart
      vi.setSystemTime(springNext)
      plan.refreshCalendar()
      expect(plan.currentDay).toBe(2)
    } finally {
      if (previousZone === undefined) delete process.env.TZ
      else process.env.TZ = previousZone
    }
  })

  it('clamps dates before the start and after the plan window', () => {
    const plan = useReadingPlan()
    plan.startDate = new Date(2026, 8, 28).getTime()
    vi.setSystemTime(new Date(2026, 8, 27))
    plan.refreshCalendar()
    expect(plan.currentDay).toBe(1)
    vi.setSystemTime(new Date(2028, 8, 28))
    plan.refreshCalendar()
    expect(plan.currentDay).toBe(365)
  })
})
