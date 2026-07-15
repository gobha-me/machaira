import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { api, type CompareRow } from '../services/api'
import { useReader } from '../stores/reader'
import { useSettings } from '../stores/settings'

interface UseCompareOptions {
  // When false, loadCompare is a no-op so a pane can host compare lazily (Read opens it on
  // demand; Study passes a constant-true ref).
  active?: Ref<boolean>
  // Bind ←/→ to step the focused verse. Study opts in; Read leaves stepping to the deep-dive.
  keyboard?: boolean
}

// Compare translations for a focused verse. Extracted from Study so Read can surface the same
// capability without a third copy. Reader-coupled: follows reader.moduleName/book/chapter.
export function useCompare(opts: UseCompareOptions = {}) {
  const reader = useReader()
  const settings = useSettings()
  const active = opts.active ?? ref(true)

  const focus = ref<number>(1)
  const rows = ref<CompareRow[]>([])
  const comparing = ref(false)
  const compareError = ref<string | null>(null)

  // Guards a chapter roll-over from re-triggering the compare watch mid-step, and drops
  // out-of-order compare responses when the user steps quickly.
  let advancing = false
  let compareSeq = 0

  // Which translations participate in compare: the configured subset (settings.compareModuleNames)
  // intersected with what's installed, or all installed when unconfigured (null). The default
  // translation is always available (it's locked in Settings); the reading translation is pinned
  // first and accented (#15), even if neither is in the configured set.
  const compareNames = computed(() => {
    const installed = reader.installedBibles.map((m) => m.name)
    const configured = settings.compareModuleNames
    const base = configured === null ? installed : installed.filter((n) => configured.includes(n))
    const anchor = reader.effectiveDefaultModule
    const withAnchor =
      anchor && installed.includes(anchor) && !base.includes(anchor) ? [...base, anchor] : base
    const primary = reader.moduleName
    if (!primary || !installed.includes(primary)) return withAnchor
    return [primary, ...withAnchor.filter((n) => n !== primary)]
  })

  // Verse-stepping bounds. Prev/next roll over between chapters within the current book and
  // stop (disable) at the book's first chapter / verse 1 and last chapter / last verse.
  const verseNums = computed(() => (reader.data?.verses ?? []).map((v) => v.n))
  const focusIdx = computed(() => verseNums.value.indexOf(focus.value))
  const chapterCount = computed(() => reader.currentBook?.chapters ?? 1)
  const atStart = computed(() => focusIdx.value <= 0 && reader.chapter <= 1)
  const atEnd = computed(
    () => focusIdx.value === verseNums.value.length - 1 && reader.chapter >= chapterCount.value
  )

  async function loadCompare() {
    if (!active.value || !reader.book || compareNames.value.length === 0) {
      rows.value = []
      return
    }
    const seq = ++compareSeq
    comparing.value = true
    compareError.value = null
    try {
      const res = await api.compare(reader.book, reader.chapter, focus.value, compareNames.value)
      if (seq !== compareSeq) return
      rows.value = res.translations
    } catch (e) {
      if (seq !== compareSeq) return
      compareError.value = (e as Error).message
      rows.value = []
    } finally {
      if (seq === compareSeq) comparing.value = false
    }
  }

  async function setFocus(n: number) {
    focus.value = n
    reader.selectVerse(n)
    await loadCompare()
  }

  // Step the focused verse ±1, rolling into the adjacent chapter (within the book) at edges.
  async function stepVerse(delta: number) {
    const nums = verseNums.value
    const target = focusIdx.value + delta
    if (target >= 0 && target < nums.length) {
      await setFocus(nums[target])
      return
    }
    const nextChapter = reader.chapter + delta
    if (nextChapter < 1 || nextChapter > chapterCount.value) return
    advancing = true
    await reader.setChapter(nextChapter)
    advancing = false
    const newNums = verseNums.value
    const landing = delta > 0 ? newNums[0] : newNums[newNums.length - 1]
    if (landing != null) await setFocus(landing)
  }

  watch(
    () => [reader.moduleName, reader.book, reader.chapter],
    () => {
      if (advancing) return
      loadCompare()
    }
  )

  function onKey(e: KeyboardEvent) {
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      stepVerse(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      stepVerse(-1)
    }
  }

  if (opts.keyboard) {
    onMounted(() => window.addEventListener('keydown', onKey))
    onUnmounted(() => window.removeEventListener('keydown', onKey))
  }

  return {
    focus,
    rows,
    comparing,
    compareError,
    compareNames,
    verseNums,
    focusIdx,
    chapterCount,
    atStart,
    atEnd,
    loadCompare,
    setFocus,
    stepVerse
  }
}
