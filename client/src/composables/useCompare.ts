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
  // Re-seed the comparison whenever the store selection moves (both ends, so a shift-extend
  // refreshes it). Opt-in and explicit at the call site so "compare follows the selection" is
  // visible from the screen without opening this file.
  followSelection?: boolean
}

// Compare translations for a focused verse. Extracted from Study so Read can surface the same
// capability without a third copy. Reader-coupled: follows reader.moduleName/book/chapter.
export function useCompare(opts: UseCompareOptions = {}) {
  const reader = useReader()
  const settings = useSettings()
  const active = opts.active ?? ref(true)

  const focus = ref<number>(1)
  // The far end of a compare range; equals focus for a single verse. Verse-stepping stays keyed
  // on focus (see verseNums/atStart/atEnd) and collapses a range back to a single verse.
  const focusEnd = ref<number>(1)
  const rows = ref<CompareRow[]>([])
  const comparing = ref(false)
  const compareError = ref<string | null>(null)

  // Guards a chapter roll-over from re-triggering the compare watch mid-step, and drops
  // out-of-order compare responses when the user steps quickly.
  let advancing = false
  let compareSeq = 0
  // Trailing delay before a scheduled comparison actually fetches, so a burst of changes issues
  // one request instead of one per event: shift-clicking a range out fires a store write per click
  // (#31), and holding ←/→ fires one per key repeat. Each /api/compare is a withSword() critical
  // section doing a readChapter per translation, so the redundant ones queue ahead of the user's
  // own next read. compareSeq only discards stale *responses* — the work is still done — so it is
  // the correctness backstop here, not the fix. Per-instance like the two above, never module
  // scope: Read and Study each hold their own useCompare.
  const SETTLE_MS = 150
  let settleTimer: ReturnType<typeof setTimeout> | undefined

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
  // The far edge of the compared passage. Equals focusIdx for a single verse; for a range the
  // bounds have to read from the end you're travelling towards, or ›/‹ appear enabled (and step)
  // while the range still has verses left in that direction.
  const focusEndIdx = computed(() => verseNums.value.indexOf(focusEnd.value))
  const chapterCount = computed(() => reader.currentBook?.chapters ?? 1)
  const atStart = computed(() => focusIdx.value <= 0 && reader.chapter <= 1)
  const atEnd = computed(
    () => focusEndIdx.value === verseNums.value.length - 1 && reader.chapter >= chapterCount.value
  )

  // "16" for a single verse, "16–17" for a range — used by both screens' compare headers.
  const focusLabel = computed(() =>
    focus.value === focusEnd.value ? `${focus.value}` : `${focus.value}–${focusEnd.value}`
  )

  async function runCompare() {
    // Re-checked here and not trusted from schedule time: a scheduled run fires up to SETTLE_MS
    // later, by which point Read's card can have closed or the chapter can have moved.
    const book = reader.book
    if (!book || !active.value || compareNames.value.length === 0) {
      comparing.value = false
      return
    }
    const seq = ++compareSeq
    comparing.value = true
    compareError.value = null
    try {
      const res = await api.compare(
        book,
        reader.chapter,
        focus.value,
        focusEnd.value,
        compareNames.value
      )
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

  // The one door every path uses to refresh the comparison, and so the one place the delay above
  // belongs — debouncing the followSelection watch instead would defer focus/focusEnd, which the
  // focusLabel, the ‹/› bounds and Study's compare tint all read synchronously, and would leave a
  // pending fetch that lands after stepVerse and yanks the panel back to the range you just left.
  // Reads reader.book/chapter and focus at fire time, so it can't fetch a stale range either.
  // immediate is for seeding on open/mount, where there is no burst to coalesce and the delay
  // would just read as lag.
  function loadCompare({ immediate = false } = {}) {
    clearTimeout(settleTimer)
    settleTimer = undefined
    if (!active.value || !reader.book || compareNames.value.length === 0) {
      rows.value = []
      comparing.value = false
      return
    }
    if (immediate) {
      void runCompare()
      return
    }
    // Claim the spinner up front: for the length of the delay the panel is showing the previous
    // verse's rows, and without this it looks settled on the wrong passage rather than busy.
    comparing.value = true
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      void runCompare()
    }, SETTLE_MS)
  }

  onUnmounted(() => clearTimeout(settleTimer))

  // focus/focusEnd move now and the fetch settles later, so the label, the ‹/› bounds and the
  // range tint stay in step with the gesture while only the request waits.
  function setFocus(n: number) {
    focus.value = n
    focusEnd.value = n
    reader.selectVerse(n)
    loadCompare()
  }

  // Compare a verse range [lo, hi]. lo === hi behaves exactly like setFocus (single verse).
  // Does not touch the store selection — the caller already owns it (the range came from there).
  function setRange(lo: number, hi: number, opts?: { immediate?: boolean }) {
    focus.value = Math.min(lo, hi)
    focusEnd.value = Math.max(lo, hi)
    loadCompare(opts)
  }

  // Seed compare from the current selection — the whole range, not just the anchor. Used on
  // open/mount; falls back to verse 1 when nothing is selected. Fetches immediately: this is a
  // one-shot with nothing to coalesce, and Read calls it the moment the compare card opens.
  function syncFromSelection() {
    const vs = reader.selectedVerses
    if (vs.length) setRange(vs[0], vs[vs.length - 1], { immediate: true })
    else setRange(1, 1, { immediate: true })
  }

  // Step the focused verse ±1, rolling into the adjacent chapter (within the book) at edges.
  // Steps off the edge of the compared passage in the direction of travel, then collapses to that
  // single verse — stepping from the anchor would walk › back into the middle of a range the
  // user just selected, since the selection pins focus to its low end.
  async function stepVerse(delta: number) {
    const nums = verseNums.value
    const target = (delta > 0 ? focusEndIdx.value : focusIdx.value) + delta
    if (target >= 0 && target < nums.length) {
      setFocus(nums[target])
      return
    }
    const nextChapter = reader.chapter + delta
    if (nextChapter < 1 || nextChapter > chapterCount.value) return
    advancing = true
    await reader.setChapter(nextChapter)
    advancing = false
    const newNums = verseNums.value
    const landing = delta > 0 ? newNums[0] : newNums[newNums.length - 1]
    if (landing != null) setFocus(landing)
  }

  watch(
    () => [reader.moduleName, reader.book, reader.chapter],
    () => {
      if (advancing) return
      loadCompare()
    }
  )

  // Compare follows the selection. One-directional and loop-free: setRange never touches the
  // store, so nothing here can re-trigger this watch.
  watch(
    () => [reader.selectedVerse, reader.rangeEnd],
    () => {
      // Read hosts compare lazily — a closed card shouldn't fetch.
      if (!opts.followSelection || !active.value) return
      const vs = reader.selectedVerses
      // Deselecting (or loadChapter clearing the selection on a chapter change) holds the last
      // comparison rather than blanking the pane or yanking it back to verse 1.
      if (!vs.length) return
      const lo = vs[0]
      const hi = vs[vs.length - 1]
      // Already showing it — setFocus() sets focus/focusEnd before it calls selectVerse, so
      // stepVerse lands here and bails instead of re-arming the delay on a comparison that is
      // already the one being fetched.
      if (lo === focus.value && hi === focusEnd.value) return
      setRange(lo, hi)
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
    focusEnd,
    focusLabel,
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
    // setFocus/setRange stay private: setFocus writes back to the store (reader.selectVerse), so
    // exporting it invites a caller to drive compare alongside the followSelection watch and
    // re-introduce the two-way coupling the watch above depends on not existing. Screens seed
    // compare through syncFromSelection and then just move the selection.
    syncFromSelection,
    stepVerse
  }
}
