import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useReader } from '../stores/reader'

interface UsePassageMenuOptions {
  // Plain (non-shift) tap on a Strong's-tagged word. The composable owns the shift case — it
  // extends the selection rather than letting a .stop'd word span swallow the gesture — so each
  // surface supplies only its own lookup: Read opens the rail card, Study fills the lexicon panel.
  onWordTap?: (verse: number, strongs: string[]) => void | Promise<void>
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
  const menuOpen = computed(() => reader.selectedVerse != null && !menuDismissed.value)

  const selectionLabel = computed(() => {
    if (reader.selectedVerse == null) return ''
    const vs = reader.selectedVerses
    const lo = vs[0]
    const hi = vs[vs.length - 1]
    return `${reader.bookName} ${reader.chapter}:${lo === hi ? lo : `${lo}–${hi}`}`
  })

  const selectionHighlighted = computed(
    () =>
      reader.selectedVerses.length > 0 && reader.selectedVerses.every((n) => reader.highlightColor(n))
  )

  // Bring the selected passage forward by dimming the rest, whenever a selection is active.
  function verseOpacity(n: number): number {
    if (reader.selectedVerse == null) return 1
    return reader.selectedVerses.includes(n) ? 1 : 0.4
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

  function dismiss() {
    menuDismissed.value = true
  }

  // Left click: quiet select-first — bring the verse forward without opening the menu, so a focus
  // click doesn't cover the text (#27). Clicking the lone selected verse again toggles it back off
  // (selectVerse). Shift+left-click extends the range and stays just as quiet: extending is a
  // selection gesture, not a request for the menu, and popping it here would cover the passage the
  // user just selected — the same complaint #27 raised about the plain click (#33). It dismisses
  // rather than doing nothing, because a menu already open from a right-click is anchored at that
  // earlier click point and would sit over the range as it grows.
  function onVerseClick(n: number, e: MouseEvent) {
    if (e.shiftKey && reader.selectedVerse != null) {
      reader.extendSelection(n)
      dismiss()
      return
    }
    reader.selectVerse(n)
    dismiss()
  }

  // Right click (also long-press on touch): the dedicated menu opener. Keep an existing range
  // intact when the click lands inside it — that's what makes Highlight/Note/Compare act on the
  // range — and start fresh only when it lands outside. selectedVerses is [] with nothing
  // selected, so a first right-click still selects; and because `n` is never the current lone
  // selection here, selectVerse's toggle-off branch can't fire from a right-click.
  function onVerseContext(n: number, e: MouseEvent) {
    e.preventDefault()
    if (!reader.selectedVerses.includes(n)) reader.selectVerse(n)
    openAt(e)
  }

  // Shift-drag on running prose would start a native text selection that fights the range
  // gesture; suppress it on shift-mousedown only, leaving plain drag-to-copy intact.
  function onVerseMouseDown(e: MouseEvent) {
    if (e.shiftKey) e.preventDefault()
  }

  // Word spans keep @click.stop so a plain lookup doesn't also re-select the verse, which means
  // the shift gesture has to be forwarded here rather than bubbling to onVerseClick.
  function onWordClick(n: number, strongs: string[], e: MouseEvent) {
    if (e.shiftKey) {
      onVerseClick(n, e)
      return
    }
    opts.onWordTap?.(n, strongs)
  }

  function onSelectionKey(e: KeyboardEvent) {
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
    if (e.key === 'Escape' && reader.selectedVerse != null) {
      reader.clearSelection()
      dismiss()
    }
  }
  onMounted(() => window.addEventListener('keydown', onSelectionKey))
  onUnmounted(() => window.removeEventListener('keydown', onSelectionKey))

  // menuDismissed stays private — dismiss() is the only way to close the menu, so future work
  // added there can't apply on one screen and not the other.
  return {
    menuPos,
    menuOpen,
    selectionLabel,
    selectionHighlighted,
    verseOpacity,
    verseBg,
    onVerseClick,
    onVerseContext,
    onVerseMouseDown,
    onWordClick,
    dismiss
  }
}
