import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLongPress,
  LONG_PRESS_DELAY_MS,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  shouldSuppressNativeTouch,
  touchSelectionAction
} from './longPress'

function pointer(overrides: Partial<{
  pointerId: number
  pointerType: string
  clientX: number
  clientY: number
}> = {}) {
  return {
    pointerId: 7,
    pointerType: 'touch',
    clientX: 40,
    clientY: 80,
    ...overrides
  }
}

describe('touch long press', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('selects a first verse, extends outside the selection, and preserves a touched range', () => {
    expect(touchSelectionAction(null, [], 4)).toBe('select')
    expect(touchSelectionAction(4, [4], 8)).toBe('extend')
    expect(touchSelectionAction(4, [4, 5, 6, 7, 8], 6)).toBe('preserve')
  })

  it('suppresses duplicate native events only for the touched verse and expiry window', () => {
    const suppression = { verse: 8, until: 2200 }
    expect(shouldSuppressNativeTouch(suppression, 8, 2000)).toBe(true)
    expect(shouldSuppressNativeTouch(suppression, 7, 2000)).toBe(false)
    expect(shouldSuppressNativeTouch(suppression, 8, 2201)).toBe(false)
  })

  it('opens at the original touch point after the hold threshold', () => {
    vi.useFakeTimers()
    const trigger = vi.fn()
    const gesture = createLongPress(trigger)

    gesture.start(12, pointer())
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 1)
    expect(trigger).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(trigger).toHaveBeenCalledWith(12, { x: 40, y: 80 })
  })

  it('ignores mouse pointers and cancels on release', () => {
    vi.useFakeTimers()
    const trigger = vi.fn()
    const gesture = createLongPress(trigger)

    gesture.start(3, pointer({ pointerType: 'mouse' }))
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS)
    gesture.start(4, pointer())
    gesture.end(7)
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS)

    expect(trigger).not.toHaveBeenCalled()
  })

  it('keeps a small touch wobble but cancels when the pointer becomes a scroll', () => {
    vi.useFakeTimers()
    const trigger = vi.fn()
    const gesture = createLongPress(trigger)

    gesture.start(5, pointer())
    gesture.move(pointer({ clientX: 40 + LONG_PRESS_MOVE_TOLERANCE_PX, clientY: 80 }))
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS)
    expect(trigger).toHaveBeenCalledTimes(1)

    gesture.start(6, pointer())
    gesture.move(pointer({ clientX: 41 + LONG_PRESS_MOVE_TOLERANCE_PX, clientY: 80 }))
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS)
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending hold when disposed', () => {
    vi.useFakeTimers()
    const trigger = vi.fn()
    const gesture = createLongPress(trigger)

    gesture.start(9, pointer())
    gesture.cancel()
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS)

    expect(trigger).not.toHaveBeenCalled()
  })
})
