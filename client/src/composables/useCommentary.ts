import { computed, ref, watch, type Ref } from 'vue'
import { api, type CommentaryEntry } from '../services/api'
import { useReader } from '../stores/reader'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'

interface UseCommentaryOptions {
  // When false, load() is a no-op so a pane can host the panel lazily (Read opens it on
  // demand; Study passes a constant-true ref).
  active?: Ref<boolean>
}

// Per-verse notes for the current chapter from one installed commentary module. Extracted so
// Read (rail card) and Study (page panel) surface the same capability. Reader-coupled: follows
// reader.book/chapter. The active module is the user's saved choice (settings.commentaryModuleName)
// when still installed, else the first installed commentary.
export function useCommentary(opts: UseCommentaryOptions = {}) {
  const reader = useReader()
  const library = useLibrary()
  const settings = useSettings()
  const active = opts.active ?? ref(true)

  const entries = ref<CommentaryEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const locked = ref(false)

  // Drops out-of-order responses when the user switches chapter/module quickly.
  let seq = 0

  const installedCommentaries = computed(() => library.installedCommentaries.map((m) => m.name))

  const activeModule = computed<string | null>(() => {
    const installed = installedCommentaries.value
    const saved = settings.commentaryModuleName
    if (saved && installed.includes(saved)) return saved
    return installed[0] ?? null
  })

  async function load() {
    if (!active.value || !activeModule.value || !reader.book) {
      entries.value = []
      locked.value = false
      return
    }
    const s = ++seq
    loading.value = true
    error.value = null
    try {
      const res = await api.commentary(activeModule.value, reader.book, reader.chapter)
      if (s !== seq) return
      entries.value = res.entries
      locked.value = res.locked
    } catch (e) {
      if (s !== seq) return
      error.value = (e as Error).message
      entries.value = []
      locked.value = false
    } finally {
      if (s === seq) loading.value = false
    }
  }

  function setModule(name: string) {
    settings.setCommentaryModule(name)
    load()
  }

  // Reload on module/chapter change (installing a commentary flips activeModule null→name).
  watch(
    () => [activeModule.value, reader.book, reader.chapter],
    () => {
      if (active.value) load()
    }
  )

  return {
    entries,
    loading,
    error,
    locked,
    activeModule,
    installedCommentaries,
    load,
    setModule
  }
}
