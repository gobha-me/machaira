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
  const selectedAnchor = ref<string | null>(null)
  const anchor = computed(() => selectedAnchor.value ?? reader.currentRef)
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
    const originalAnchor = anchor.value
    error.value = null
    saved.value = false
    clearTimeout(savedTimer)
    saving.value = true
    try {
      await notes.create({
        title: originalTitle.trim() || originalAnchor,
        body: text,
        refs: [originalAnchor]
      })
      if (title.value === originalTitle) title.value = ''
      if (body.value === originalBody) body.value = ''
      if (!body.value && !title.value && selectedAnchor.value === originalAnchor) selectedAnchor.value = null
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

  function anchorSelection(reference: string, quote: string): void {
    if (!reference.trim() || !quote.trim()) return
    // Do not silently attach an existing draft to a different passage.
    if ((body.value.trim() || title.value.trim()) && anchor.value !== reference) {
      error.value = 'Save the current note before starting a note on another selection.'
      return
    }
    selectedAnchor.value = reference
    // The existing note contract stores verse ranges; a quote preserves the selected
    // word/phrase boundaries without introducing a second reference storage format.
    if (!body.value.trim()) body.value = `> ${quote.trim().replace(/\n/g, '\n> ')}\n\n`
    error.value = null
  }

  function relDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  return { title, body, bodyEl, saved, error, saving, anchor, anchorSelection, passageNotes, save, openNote, focusComposer, relDate }
}
