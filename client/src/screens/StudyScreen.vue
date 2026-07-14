<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { api, ApiError, type CompareRow, type StrongsPayload } from '../services/api'
import StrongsCard from '../components/StrongsCard.vue'

const reader = useReader()
const ui = useUi()

const focus = ref<number>(1)
const rows = ref<CompareRow[]>([])
const comparing = ref(false)
const compareError = ref<string | null>(null)

// Guards a chapter roll-over from re-triggering the compare watch mid-step, and drops
// out-of-order compare responses when the user steps quickly.
let advancing = false
let compareSeq = 0

const strongsKey = ref<string | null>(null)
const strongs = ref<StrongsPayload | null>(null)
const strongsError = ref<string | null>(null)
const strongsLoading = ref(false)

// A marker attaches to the preceding word; the next text segment gets a leading space
// unless it opens with closing punctuation (mirrors ReadScreen's inline spacing).
const CLOSE_PUNCT = /^[\s,.;:!?)\]}”’»…]/
function segLead(text: string, i: number): string {
  return i > 0 && !CLOSE_PUNCT.test(text) ? ' ' : ''
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  if (!reader.ready) await reader.init()
  focus.value = reader.selectedVerse ?? 1
  await loadCompare()
})

onUnmounted(() => window.removeEventListener('keydown', onKey))

watch(
  () => [reader.moduleName, reader.book, reader.chapter],
  () => {
    if (advancing) return
    loadCompare()
  }
)

// Primary/accented compare row follows the reading translation: order reader.moduleName
// first, then the remaining installed bibles keep their featured order.
const compareNames = computed(() => {
  const names = reader.installedBibles.map((m) => m.name)
  const primary = reader.moduleName
  if (!primary || !names.includes(primary)) return names
  return [primary, ...names.filter((n) => n !== primary)]
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
  if (!reader.book || compareNames.value.length === 0) {
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

// Tapping a word both focuses its verse (so the comparison follows) and looks it up.
async function studyWord(n: number, keys: string[]) {
  if (focus.value !== n) await setFocus(n)
  await tapWord(keys)
}

async function tapWord(keys: string[]) {
  const key = keys[0]
  if (!key) return
  strongsKey.value = key
  strongsLoading.value = true
  strongsError.value = null
  strongs.value = null
  try {
    strongs.value = await api.strongs(key)
  } catch (e) {
    strongs.value = null
    strongsError.value =
      e instanceof ApiError && e.status === 409 ? e.message : `No entry for ${key}.`
  } finally {
    strongsLoading.value = false
  }
}
</script>

<template>
  <div class="study">
    <!-- left: compare + word study -->
    <div class="left">
      <div class="topbar">
        <span class="ref">{{ reader.bookName }} {{ reader.chapter }}:{{ focus }}</span>
        <div class="stepper">
          <button
            class="step hover-ink"
            :disabled="atStart"
            @click="stepVerse(-1)"
            title="Previous verse"
            aria-label="Previous verse"
          >‹</button>
          <button
            class="step hover-ink"
            :disabled="atEnd"
            @click="stepVerse(1)"
            title="Next verse"
            aria-label="Next verse"
          >›</button>
        </div>
        <span class="sub">comparing {{ rows.length }} translation{{ rows.length === 1 ? '' : 's' }}</span>
        <div class="spacer"></div>
        <button class="back hover-ink" @click="ui.go('read')">← Back to reading</button>
      </div>

      <div class="scroll">
        <p v-if="compareError" class="error">{{ compareError }}</p>
        <div v-if="comparing" class="loading">Comparing…</div>

        <div v-else-if="rows.length" class="compare-card">
          <div v-for="(r, i) in rows" :key="r.module" class="compare-row" :class="{ last: i === rows.length - 1 }">
            <span class="tag" :style="{ color: i === 0 ? 'var(--accent)' : 'var(--muted)' }">{{ r.module }}</span>
            <span class="ctext serif">{{ r.text ?? '—' }}</span>
          </div>
        </div>
        <div v-else class="empty">
          Install more than one translation in the Library to compare renderings.
        </div>

        <!-- Word study (tap a word in the passage below) -->
        <div class="section-label">
          Word study · Strong’s lexicon<template v-if="strongsKey"> · {{ strongsKey }}</template>
        </div>
        <div class="strongs-box">
          <p v-if="strongsError" class="strongs-error">{{ strongsError }}</p>
          <div v-else-if="strongsLoading" class="loading">Looking up…</div>
          <StrongsCard v-else-if="strongs" :entry="strongs" class="strongs-result" />
          <p v-else class="strongs-hint">
            Tap any word in the passage below to open its Greek or Hebrew entry. Needs a
            Strong’s-tagged translation (e.g. KJVA) and the Strong’s modules from the Library.
          </p>
        </div>

        <!-- Context passage (real chapter text, click to refocus) -->
        <div class="section-label">Context · {{ reader.bookName }} {{ reader.chapter }}</div>
        <div v-if="reader.data" class="context serif">
          <span
            v-for="v in reader.data.verses"
            :key="v.n"
            class="cverse"
            :style="{ background: v.n === focus ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'transparent' }"
            @click="setFocus(v.n)"
          ><sup class="cvnum">{{ v.n }}</sup><template
              v-for="(seg, i) in v.segments"
              :key="i"
            ><template v-if="seg.kind === 'word'"
            >{{ segLead(seg.text, i) }}<span
                class="wtap"
                @click.stop="studyWord(v.n, seg.strongs)"
              >{{ seg.text }}</span></template><template
              v-else-if="seg.kind === 'note'"
            ></template><template v-else
            >{{ segLead(seg.text, i) + seg.text }}</template></template>{{ ' ' }}</span>
        </div>
      </div>
    </div>

    <!-- right: study partner (honest disabled) -->
    <div class="partner">
      <div class="topbar">
        <div class="mark"></div>
        <span class="ptitle">Study partner</span>
        <div class="spacer"></div>
        <span class="sub">not connected</span>
      </div>
      <div class="partner-body">
        <div class="disabled-note">
          <div class="dn-title serif">Bring your own model</div>
          <p>
            The study partner talks to an LLM — any OpenAI-compatible endpoint, Claude, or a local
            model. Connect a provider in Settings to enable chat about this passage.
          </p>
          <button class="dn-btn" @click="ui.go('settings')">Open Settings →</button>
        </div>
      </div>
      <div class="composer">
        <input disabled placeholder="Connect a provider in Settings to chat" />
        <button disabled class="send">→</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.study {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.left {
  flex: 1.2;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
}
.topbar {
  height: 58px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 22px;
}
.ref {
  font-size: 14px;
  font-weight: 700;
}
.stepper {
  display: flex;
  gap: 4px;
}
.step {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--ink);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.sub {
  font-size: 12px;
  color: var(--muted);
}
.spacer {
  flex: 1;
}
.back {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px 22px 60px;
}
.compare-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 16px;
}
.compare-row {
  display: flex;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.compare-row.last {
  border-bottom: none;
}
.tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  width: 52px;
  flex-shrink: 0;
  padding-top: 3px;
}
.ctext {
  font-size: 16.5px;
  line-height: 1.6;
}
.section-label {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 24px 0 12px;
}
.strongs-box {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 6px;
}
.strongs-hint,
.strongs-error {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--muted);
  margin: 10px 0 0;
}
.strongs-error {
  color: var(--accent);
}
.strongs-result {
  margin-top: 12px;
}
.context {
  font-size: 16px;
  line-height: 1.8;
  text-wrap: pretty;
}
.cverse {
  cursor: pointer;
  border-radius: 3px;
  padding: 1px 2px;
}
.wtap {
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.12s;
}
.wtap:hover {
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}
.cvnum {
  font-size: 0.58em;
  color: var(--accent);
  font-weight: 600;
  margin-right: 3px;
  font-family: 'Instrument Sans', sans-serif;
}
.empty,
.loading {
  font-size: 13px;
  color: var(--muted);
  padding: 8px 0;
}
.error {
  font-size: 13px;
  color: var(--accent);
}
/* partner */
.partner {
  width: clamp(320px, 40vw, 430px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--card);
}
.mark {
  width: 8px;
  height: 8px;
  background: var(--accent);
  transform: rotate(45deg);
  flex-shrink: 0;
}
.ptitle {
  font-size: 14px;
  font-weight: 700;
}
.partner-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.disabled-note {
  text-align: center;
  max-width: 300px;
}
.dn-title {
  font-size: 18px;
  margin-bottom: 8px;
}
.disabled-note p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
  margin: 0 0 16px;
}
.dn-btn {
  background: none;
  border: 1px solid var(--accent);
  color: var(--accent);
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.composer {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.composer input {
  flex: 1;
  min-width: 0;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 13px;
  font-size: 13px;
  color: var(--muted);
  outline: none;
}
.send {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  font-size: 16px;
  opacity: 0.5;
}
.composer input:disabled,
.send:disabled {
  cursor: not-allowed;
}
</style>
