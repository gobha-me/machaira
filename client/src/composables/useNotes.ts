import { computed, onScopeDispose, ref } from 'vue'
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
  const error = ref<string | null>(null)
  const saving = ref(false)
  let savedTimer: ReturnType<typeof setTimeout> | undefined
  onScopeDispose(() => clearTimeout(savedTimer))

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
    if (!text || saving.value) return
    const originalTitle = title.value
    const originalBody = body.value
    error.value = null
    saved.value = false
    clearTimeout(savedTimer)
    saving.value = true
    try {
      await notes.create({
        title: originalTitle.trim() || reader.currentRef,
        body: text,
        refs: [reader.currentRef]
      })
      if (title.value === originalTitle) title.value = ''
      if (body.value === originalBody) body.value = ''
      saved.value = true
      savedTimer = setTimeout(() => (saved.value = false), 1800)
    } catch (cause) {
      error.value = `Could not create note: ${(cause as Error).message}`
    } finally {
      saving.value = false
    }
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

  return { title, body, bodyEl, saved, error, saving, passageNotes, save, openNote, focusComposer, relDate }
}
