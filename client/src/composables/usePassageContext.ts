import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { formatPassageRef } from '../utils/passageRef'
import { selectedScripture, type SelectedText } from '../utils/textSelection'

/** Snapshot native Scripture selections before focus moves to the chat composer. */
export function usePassageContext() {
  const reader = useReader()
  const ui = useUi()
  const selected = ref<SelectedText | null>(null)
  const available = computed(() => !!reader.moduleName && !!reader.book && !!reader.data
    && !reader.loadingChapter && !reader.error
    && reader.data.module === reader.moduleName && reader.data.book === reader.book
    && reader.data.chapter === reader.chapter)

  function updateSelection() {
    if (!available.value) return
    const root = document.querySelector<HTMLElement>('[data-passage-context]')
    const selection = window.getSelection()
    const scripture = root ? selectedScripture(root, selection) : null
    // Selecting non-focusable prose can leave focus in the drawer. Capture a valid
    // Scripture range before considering focus, or its context chip will go stale.
    if (scripture) {
      selected.value = scripture
      return
    }
    // Moving focus to the drawer may collapse the browser selection. Keep its snapshot
    // there, but never capture text from notes, search results, or the conversation.
    if (selection?.isCollapsed
      && document.activeElement?.closest('#study-partner, [aria-controls="study-partner"]')) return
    selected.value = null
  }

  watch(() => [reader.moduleName, reader.book, reader.chapter, reader.data,
    reader.loadingChapter, reader.error, reader.selectedVerse, reader.rangeEnd, ui.screen],
  () => { selected.value = null }, { flush: 'sync' })

  onMounted(() => document.addEventListener('selectionchange', updateSelection))
  onUnmounted(() => document.removeEventListener('selectionchange', updateSelection))

  return computed(() => {
    const module = reader.moduleName ?? ''
    const reference = reader.selectionRef
    if (!available.value) return { reference, module, content: '' }
    if (selected.value) {
      return {
        reference: formatPassageRef({ book: reader.bookName, chapter: reader.chapter,
          verseStart: selected.value.verseStart, verseEnd: selected.value.verseEnd }),
        module,
        content: selected.value.text
      }
    }
    const bounds = reader.selectionBounds
    const verses = reader.data!.verses.filter((verse) => verse.text.trim()
      && (!bounds || (verse.n >= bounds.lo && verse.n <= bounds.hi)))
    return { reference, module, content: verses.map((verse) => `${verse.n}. ${verse.text}`).join('\n') }
  })
}
