import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { crossReferencesForVerses } from '../utils/crossReferences'
import { hasNativeTextSelection } from '../utils/textSelection'
import {
  createLongPress,
  shouldSuppressNativeTouch,
  touchSelectionAction,
  type NativeTouchSuppression
} from '../utils/longPress'

interface UsePassageMenuOptions {
  // A tagged-word lookup never changes the verse selection.
  onWordTap?: (verse: number, strongs: string[], target: HTMLElement) => void | Promise<void>
}

// Verse-selection gestures, their presentation ("bring the passage forward"), and the floating
// action menu they open. Extracted so Read and Study share one implementation instead of two
// copies that drift — the drift is what left Study without dimming and with its own click
// semantics (#24). Reader-coupled: the selection lives in the store, not here.
export function usePassageMenu(opts: UsePassageMenuOptions = {}) {
  const reader = useReader()

  const menuPos = ref({ x: 0, y: 0 })
  // Starts dismissed: the selection lives in the shared store, so a screen can mount with one
  // already active (arriving from Search's openRef, or switching Read↔Study). Starting false
  // popped the menu at the clamped top-left corner with no gesture behind it — the opposite of
  // what #27 asked for. Only openAt() opens it.
  const menuDismissed = ref(true)
  let keyboardOpener: HTMLElement | null = null
  const menuOpen = computed(() => reader.selectedVerse != null && !menuDismissed.value)

  const selectionLabel = computed(() => {
    if (reader.selectedVerse == null) return ''
    return reader.selectionRef
  })

  const selectionHighlighted = computed(
    () =>
      reader.selectedVerses.length > 0 && reader.selectedVerses.every((n) => reader.highlightColor(n))
  )

  const selectionCrossReferences = computed(() =>
    crossReferencesForVerses(reader.data?.verses ?? [], reader.selectedVerses)
  )
  const crossReferencesAvailable = computed(() => selectionCrossReferences.value.length > 0)
  const crossReferencesReason = computed(
    () =>
      `No cross-references available in ${reader.moduleName ?? 'this translation'} for ${
        selectionLabel.value || 'this selection'
      }.`
  )

  // Bring the selected passage forward by dimming the rest, whenever a selection is active.
  function verseOpacity(n: number): number {
    if (reader.selectedVerse == null) return 1
    return reader.selectedVerses.includes(n) ? 1 : 0.7
  }

  // A highlight wins over the selection tint; the tint marks the brought-forward range.
  function verseBg(n: number): string {
    const hl = reader.highlightColor(n)
    if (hl) return hl
    if (reader.selectedVerses.includes(n)) return 'color-mix(in oklab, var(--accent) 12%, transparent)'
    return 'transparent'
  }

  function openAt(e: MouseEvent) {
    menuPos.value = { x: e.clientX, y: e.clientY }
    menuDismissed.value = false
  }

  function openAtPosition(position: { x: number; y: number }) {
    menuPos.value = position
    menuDismissed.value = false
  }

  function dismiss() {
    menuDismissed.value = true
    if (keyboardOpener?.isConnected) keyboardOpener.focus({ preventScroll: true })
    keyboardOpener = null
  }

  // Only verse numbers and the surrounding gutter select verses. In particular, the first
  // click of a prose double-click arrives before the browser creates its native word range.
  // Shift extends quietly and dismisses any menu anchored to the previous range.
  function onVerseClick(n: number, e: MouseEvent) {
    if (isProse(e)) return
    if (hasNativeTextSelection(e.currentTarget) || e.detail >= 2) return
    if (suppressesNativeTouchEvent(n)) return
    if (e.shiftKey && reader.selectedVerse != null) {
      reader.extendSelection(n)
      dismiss()
      return
    }
    reader.selectVerse(n)
    dismiss()
  }

  // Right click (also verse-number long-press on touch): the dedicated menu opener. Keep an existing range
  // intact when the click lands inside it — that's what makes Highlight/Note/Compare act on the
  // range — and start fresh only when it lands outside. selectedVerses is [] with nothing
  // selected, so a first right-click still selects; and because `n` is never the current lone
  // selection here, selectVerse's toggle-off branch can't fire from a right-click.
  function onVerseContext(n: number, e: MouseEvent) {
    // Leave the browser's Copy/Share menu intact for native word/phrase selections.
    if (nativeTextTouch || hasNativeTextSelection(e.currentTarget)) { dismiss(); return }
    e.preventDefault()
    if (suppressesNativeTouchEvent(n)) return
    if (!reader.selectedVerses.includes(n)) reader.selectVerse(n)
    openAt(e)
  }

  function onVerseKeydown(n: number, e: KeyboardEvent) {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
    e.preventDefault()
    e.stopPropagation()
    if (!reader.selectedVerses.includes(n)) reader.selectVerse(n)
    keyboardOpener = e.currentTarget as HTMLElement
    const bounds = keyboardOpener.getBoundingClientRect()
    openAtPosition({ x: bounds.left, y: bounds.bottom })
    void nextTick(() => {
      if (keyboardOpener?.isConnected && menuOpen.value) {
        document.querySelector<HTMLElement>('.passage-actions button:not(:disabled)')?.focus()
      }
    })
  }

  // Mobile browsers do not expose Shift, and native context-menu timing varies by platform.
  // Own a movement-cancelled long press on verse numbers so touch users can extend a range
  // and open passage actions while leaving prose available for native text selection.
  let suppressNativeTouch: NativeTouchSuppression | null = null
  const longPress = createLongPress((verse, position) => {
    const action = touchSelectionAction(reader.selectedVerse, reader.selectedVerses, verse)
    if (action === 'extend') reader.extendSelection(verse)
    else if (action === 'select') reader.selectVerse(verse)
    suppressNativeTouch = { verse, until: Date.now() + 1200 }
    openAtPosition(position)
  })

  function suppressesNativeTouchEvent(verse: number): boolean {
    if (!suppressNativeTouch || Date.now() > suppressNativeTouch.until) {
      suppressNativeTouch = null
      return false
    }
    return shouldSuppressNativeTouch(suppressNativeTouch, verse)
  }

  let nativeTextTouch = false
  function onVersePointerDown(n: number, e: PointerEvent) {
    // Prose long-press belongs to the browser's text selection and copy handles.
    // Verse-number long-press retains the passage range gesture.
    const prose = e.target instanceof Element && e.target.closest('[data-selection-text]')
    nativeTextTouch = !!prose && e.pointerType === 'touch'
    if (prose) { longPress.cancel(); return }
    longPress.start(n, e)
  }

  function onVersePointerMove(e: PointerEvent) {
    longPress.move(e)
  }

  function onVersePointerEnd(e: PointerEvent) {
    longPress.end(e.pointerId)
  }

  function isProse(e: MouseEvent): boolean {
    return e.target instanceof Element && !!e.target.closest('[data-selection-text]')
  }

  // Prevent native range extension only on verse controls; prose keeps Shift+click selection.
  function onVerseMouseDown(e: MouseEvent) {
    if (e.shiftKey && !isProse(e)) e.preventDefault()
  }

  // Keep tagged-word lookups independent of verse selection, including Shift+click.
  let wordTapTimer: ReturnType<typeof setTimeout> | null = null
  function cancelWordTap() {
    if (wordTapTimer !== null) clearTimeout(wordTapTimer)
    wordTapTimer = null
  }
  function onWordClick(n: number, strongs: string[], e: MouseEvent) {
    cancelWordTap()
    if (hasNativeTextSelection(e.currentTarget) || e.detail >= 2) return
    if (e.shiftKey) return
    const target = e.currentTarget
    if (!(target instanceof HTMLElement)) return
    if (e.detail === 0) { void opts.onWordTap?.(n, strongs, target); return }
    // Let a native double-click finish before a mouse lookup opens its anchored card.
    // Keyboard activation remains immediate; native ranges win over this timer.
    wordTapTimer = setTimeout(() => {
      wordTapTimer = null
      if (!hasNativeTextSelection(target)) void opts.onWordTap?.(n, strongs, target)
    }, 500)
  }
  watch(() => [reader.moduleName, reader.book, reader.chapter, reader.data, reader.loadingChapter, reader.error], cancelWordTap, { flush: 'sync' })

  function onSelectionKey(e: KeyboardEvent) {
    if (e.key === 'Escape') cancelWordTap()
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
    if (e.key === 'Escape' && reader.selectedVerse != null) {
      reader.clearSelection()
      dismiss()
    }
  }
  onMounted(() => window.addEventListener('keydown', onSelectionKey))
  onUnmounted(() => {
    window.removeEventListener('keydown', onSelectionKey)
    cancelWordTap()
    longPress.cancel()
  })

  // menuDismissed stays private — dismiss() is the only way to close the menu, so future work
  // added there can't apply on one screen and not the other.
  return {
    menuPos,
    menuOpen,
    selectionLabel,
    selectionHighlighted,
    selectionCrossReferences,
    crossReferencesAvailable,
    crossReferencesReason,
    verseOpacity,
    verseBg,
    onVerseClick,
    onVerseContext,
    onVerseKeydown,
    onVerseMouseDown,
    onVersePointerDown,
    onVersePointerMove,
    onVersePointerEnd,
    onWordClick,
    dismiss
  }
}
