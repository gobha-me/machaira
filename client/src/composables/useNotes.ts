import { computed, ref } from 'vue'
import { useReader } from '../stores/reader'
import { useNotes as useNotesStore } from '../stores/notes'
import { useUi } from '../stores/ui'
import { passageRefMatchesSelection } from '../utils/passageRef'

// Note-taking capability shared by Read and Study: a quick-capture composer anchored to the
// current passage (verse, range, or chapter) plus the list of notes on that passage. Extracted
// so both surfaces build the capability once rather than keeping divergent copies.
export function useNotes() {
  const reader = useReader()
  const notes = useNotesStore()
  const ui = useUi()

  const title = ref('')
  const body = ref('')
  const bodyEl = ref<HTMLTextAreaElement | null>(null)
  const saved = ref(false)
  let savedTimer: ReturnType<typeof setTimeout> | undefined

  // Notes anchored to the current passage: any selected verse (range-aware) or, when nothing
  // is selected, every note in the current chapter.
  const passageNotes = computed(() => {
    const selected = reader.selectedVerses
    return notes.list.filter((n) =>
      n.refs.some((ref) =>
        passageRefMatchesSelection(ref, {
          book: reader.bookName,
          chapter: reader.chapter,
          verses: selected
        })
      )
    )
  })

  async function save() {
    const text = body.value.trim()
    if (!text) return
    await notes.create({
      title: title.value.trim() || reader.currentRef,
      body: text,
      refs: [reader.currentRef]
    })
    title.value = ''
    body.value = ''
    saved.value = true
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => (saved.value = false), 1800)
  }

  function openNote(id: string) {
    notes.select(id)
    ui.go('journal')
  }

  function focusComposer() {
    bodyEl.value?.focus()
  }

  function relDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  return { title, body, bodyEl, saved, passageNotes, save, openNote, focusComposer, relDate }
}
