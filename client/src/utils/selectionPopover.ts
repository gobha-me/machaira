export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const GAP = 8

function valid(rect: Rect): boolean {
  return [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    && rect.right > rect.left && rect.bottom > rect.top
}

// Above/below the entire native range, inside the reading column and viewport. Subtract
// tool drawers before choosing a slot so a high z-index never hides their controls.
export function placeSelectionPopover(
  selection: Rect,
  size: { width: number; height: number },
  bounds: Rect,
  obstacles: Rect[] = []
): { left: number; top: number; width: number; maxHeight: number } | null {
  if (!valid(selection) || !valid(bounds) || !Number.isFinite(size.width)
    || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return null
  const width = Math.min(size.width, bounds.right - bounds.left)
  let slots: Rect[] = [
    { ...bounds, bottom: Math.min(bounds.bottom, selection.top - GAP) },
    { ...bounds, top: Math.max(bounds.top, selection.bottom + GAP) }
  ].filter(valid)
  for (const obstacle of obstacles.filter(valid)) {
    const blocked = { left: obstacle.left - GAP, right: obstacle.right + GAP,
      top: obstacle.top - GAP, bottom: obstacle.bottom + GAP }
    slots = slots.flatMap((slot) => {
      if (blocked.left >= slot.right || blocked.right <= slot.left
        || blocked.top >= slot.bottom || blocked.bottom <= slot.top) return [slot]
      return [
        { ...slot, right: Math.min(slot.right, blocked.left) },
        { ...slot, left: Math.max(slot.left, blocked.right) },
        { ...slot, bottom: Math.min(slot.bottom, blocked.top) },
        { ...slot, top: Math.max(slot.top, blocked.bottom) }
      ].filter(valid)
    })
  }
  const candidates = slots.filter((slot) => slot.right - slot.left >= width
    && slot.bottom - slot.top >= Math.min(size.height, 52))
    .map((slot) => {
      const height = Math.min(size.height, slot.bottom - slot.top)
      const above = slot.bottom <= selection.top
      const top = above ? slot.bottom - height : slot.top
      return {
        left: Math.max(slot.left, Math.min(selection.left, slot.right - width)),
        top, width, maxHeight: height,
        distance: above ? selection.top - slot.bottom : slot.top - selection.bottom
      }
    })
  // Prefer full content, then proximity. Equal slots prefer above (the first slot).
  candidates.sort((a, b) => b.maxHeight - a.maxHeight || a.distance - b.distance)
  const best = candidates[0]
  // A range can fill the viewport. Hide actions until there is room rather than cover it.
  return best ? { left: best.left, top: best.top, width: best.width, maxHeight: best.maxHeight } : null
}
