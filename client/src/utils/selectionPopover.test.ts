import { describe, expect, it } from 'vitest'
import { placeSelectionPopover, type Rect } from './selectionPopover'

const bounds = { left: 100, right: 720, top: 8, bottom: 792 }
const size = { width: 280, height: 52 }
const range = { left: 500, right: 550, top: 300, bottom: 325 }
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

describe('selection popover placement', () => {
  it.each([
    { ...range, top: 8, bottom: 30 },
    { ...range, top: 770, bottom: 792 },
    { ...range, left: 705, right: 720 },
    { ...range, left: 95, right: 120 },
    { ...range, top: -20, bottom: 30 },
    { ...range, top: 770, bottom: 820 }
  ])('stays off the range and within the column at viewport edges: %o', (selection) => {
    const pos = placeSelectionPopover(selection, size, bounds)!
    const rect = { left: pos.left, right: pos.left + pos.width, top: pos.top, bottom: pos.top + pos.maxHeight }
    expect(overlaps(rect, selection)).toBe(false)
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left)
    expect(rect.right).toBeLessThanOrEqual(bounds.right)
    expect(rect.top).toBeGreaterThanOrEqual(bounds.top)
    expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom)
  })

  it('flips below at the top edge and above at the bottom edge', () => {
    expect(placeSelectionPopover({ ...range, top: 8, bottom: 30 }, size, bounds)!.top).toBe(38)
    expect(placeSelectionPopover({ ...range, top: 770, bottom: 792 }, size, bounds)!.top).toBe(710)
  })

  it('moves away from a side panel that overlaps the reading area', () => {
    const panel = { left: 430, right: 800, top: 100, bottom: 800 }
    const pos = placeSelectionPopover(range, size, bounds, [panel])!
    expect(pos.left + pos.width).toBeLessThanOrEqual(panel.left - 8)
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(range.top - 8)
  })

  it('repositions below when expanded content no longer fits above', () => {
    const selection = { ...range, top: 80, bottom: 100 }
    expect(placeSelectionPopover(selection, size, bounds)!.top).toBe(20)
    expect(placeSelectionPopover(selection, { ...size, height: 260 }, bounds)!.top).toBe(108)
  })

  it('constrains oversized content and narrow columns without covering a multi-line range', () => {
    const selection = { left: 20, right: 200, top: 210, bottom: 600 }
    const pos = placeSelectionPopover(selection, { width: 280, height: 900 }, { ...bounds, left: 8, right: 220 })!
    expect(pos).toEqual({ left: 8, top: 8, width: 212, maxHeight: 194 })
  })

  it('hides when a viewport-filling selection or drawer leaves no usable slot', () => {
    expect(placeSelectionPopover({ ...range, top: 8, bottom: 792 }, size, bounds)).toBeNull()
    expect(placeSelectionPopover(range, size, bounds, [bounds])).toBeNull()
  })

  it.each([
    { ...range, left: NaN }, { ...range, bottom: Infinity },
    { ...range, right: range.left }, { ...range, bottom: range.top - 1 }
  ])('rejects invalid or collapsed range geometry: %o', (selection) => {
    expect(placeSelectionPopover(selection, size, bounds)).toBeNull()
  })

  it('rejects invalid viewport and menu sizes', () => {
    expect(placeSelectionPopover(range, size, { ...bounds, right: 20 })).toBeNull()
    for (const width of [0, -1, NaN, Infinity]) {
      expect(placeSelectionPopover(range, { ...size, width }, bounds)).toBeNull()
    }
    expect(placeSelectionPopover(range, { ...size, height: NaN }, bounds)).toBeNull()
  })
})
