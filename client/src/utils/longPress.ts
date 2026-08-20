export const LONG_PRESS_DELAY_MS = 500
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10

export interface LongPressPointer {
  pointerId: number
  pointerType: string
  clientX: number
  clientY: number
}

export type TouchSelectionAction = 'select' | 'extend' | 'preserve'

export interface NativeTouchSuppression {
  verse: number
  until: number
}

export function touchSelectionAction(
  selectedVerse: number | null,
  selectedVerses: readonly number[],
  targetVerse: number
): TouchSelectionAction {
  if (selectedVerses.includes(targetVerse)) return 'preserve'
  return selectedVerse == null ? 'select' : 'extend'
}

export function shouldSuppressNativeTouch(
  suppression: NativeTouchSuppression | null,
  targetVerse: number,
  now = Date.now()
): boolean {
  return suppression?.verse === targetVerse && now <= suppression.until
}

interface PendingLongPress {
  pointerId: number
  verse: number
  startX: number
  startY: number
  timer: ReturnType<typeof setTimeout>
}

export function createLongPress(
  onTrigger: (verse: number, position: { x: number; y: number }) => void
) {
  let pending: PendingLongPress | null = null

  function cancel(): void {
    if (pending) clearTimeout(pending.timer)
    pending = null
  }

  function start(verse: number, event: LongPressPointer): void {
    cancel()
    if (event.pointerType !== 'touch') return

    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    pending = {
      pointerId,
      verse,
      startX,
      startY,
      timer: setTimeout(() => {
        if (!pending || pending.pointerId !== pointerId) return
        pending = null
        onTrigger(verse, { x: startX, y: startY })
      }, LONG_PRESS_DELAY_MS)
    }
  }

  function move(event: LongPressPointer): void {
    if (!pending || pending.pointerId !== event.pointerId) return
    const moved = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY)
    if (moved > LONG_PRESS_MOVE_TOLERANCE_PX) cancel()
  }

  function end(pointerId: number): void {
    if (pending?.pointerId === pointerId) cancel()
  }

  return { start, move, end, cancel }
}
