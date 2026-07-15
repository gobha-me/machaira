<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useReadingPlan } from '../stores/readingPlan'
import { useNotes as useNotesStore } from '../stores/notes'
import { PLAN_DAYS } from '../services/plan'
import { type BookEntry } from '../services/api'
import { useCompare } from '../composables/useCompare'
import { useWordStudy } from '../composables/useWordStudy'
import { useNotes } from '../composables/useNotes'
import { segLead } from '../utils/text'
import PassageActions from '../components/PassageActions.vue'
import StrongsCard from '../components/StrongsCard.vue'

const reader = useReader()
const ui = useUi()
const settings = useSettings()
const plan = useReadingPlan()
const notesStore = useNotesStore()

function openTodayReading() {
  const first = plan.firstUnreadToday
  if (first && reader.moduleName) reader.openRef(reader.moduleName, first.book, first.chapter)
}

const versesStyle = computed(() => ({
  fontSize: 'calc(20px * var(--vs))',
  letterSpacing: settings.extraSpacing ? '0.03em' : 'normal',
  wordSpacing: settings.extraSpacing ? '0.12em' : 'normal'
}))

function verseOpacity(n: number): number {
  if (!settings.lineFocus || reader.selectedVerse == null) return 1
  return reader.selectedVerses.includes(n) ? 1 : 0.4
}

const transOpen = ref(false)
const bookOpen = ref(false)
const draftBook = ref<string | null>(null)

onMounted(() => {
  reader.init()
  notesStore.load()
})

const sectionLabels: Record<BookEntry['section'], string> = {
  ot: 'Old Testament',
  nt: 'New Testament',
  apocrypha: 'Apocrypha'
}

const grouped = computed(() => {
  const groups: { key: BookEntry['section']; label: string; books: BookEntry[] }[] = []
  for (const key of ['ot', 'nt', 'apocrypha'] as const) {
    const books = reader.books.filter((b) => b.section === key)
    if (books.length) groups.push({ key, label: sectionLabels[key], books })
  }
  return groups
})

const draftChapters = computed(() => {
  const code = draftBook.value ?? reader.book
  return reader.books.find((b) => b.code === code)?.chapters ?? 0
})

function openBookPicker() {
  draftBook.value = reader.book
  bookOpen.value = !bookOpen.value
}

async function pickChapter(n: number) {
  const code = draftBook.value ?? reader.book
  if (!code) return
  if (code !== reader.book) {
    await reader.setBook(code)
  }
  await reader.setChapter(n)
  bookOpen.value = false
  stopListening()
}

async function pickModule(name: string) {
  transOpen.value = false
  await reader.setModule(name)
  stopListening()
}

// ── Listen: browser Web Speech, with verse follow-along ──
const hasTTS = typeof window !== 'undefined' && 'speechSynthesis' in window
const listening = ref(false)
const playing = ref(false)
const spokenVerse = ref<number | null>(null)

function toggleListen() {
  if (!hasTTS) return
  listening.value = !listening.value
  if (listening.value) startPlayback()
  else stopListening()
}

function startPlayback() {
  if (!reader.data) return
  window.speechSynthesis.cancel()
  playing.value = true
  const verses = reader.data.verses
  let i = Math.max(
    0,
    verses.findIndex((v) => v.n === (reader.selectedVerse ?? verses[0]?.n))
  )
  const speakNext = () => {
    if (i >= verses.length) {
      playing.value = false
      spokenVerse.value = null
      // Finished reading the chapter aloud — count it toward the reading plan.
      if (plan.enabled && reader.book) plan.markChapterRead(reader.book, reader.chapter)
      return
    }
    const v = verses[i]
    spokenVerse.value = v.n
    const u = new SpeechSynthesisUtterance(v.text)
    u.onend = () => {
      i += 1
      if (playing.value) speakNext()
    }
    window.speechSynthesis.speak(u)
  }
  speakNext()
}

function togglePlay() {
  if (!hasTTS) return
  if (playing.value) {
    window.speechSynthesis.pause()
    playing.value = false
  } else {
    if (window.speechSynthesis.paused) window.speechSynthesis.resume()
    else startPlayback()
    playing.value = true
  }
}

function stopListening() {
  if (hasTTS) window.speechSynthesis.cancel()
  playing.value = false
  spokenVerse.value = null
  listening.value = false
}

onUnmounted(stopListening)

function verseBg(n: number): string {
  const hl = reader.highlightColor(n)
  if (spokenVerse.value === n) return 'color-mix(in oklab, var(--accent) 18%, transparent)'
  if (hl) return hl
  if (reader.selectedVerses.includes(n)) return 'color-mix(in oklab, var(--accent) 12%, transparent)'
  return 'transparent'
}

const progressPct = computed(() => {
  if (!reader.data || spokenVerse.value == null) return 0
  const verses = reader.data.verses
  const idx = verses.findIndex((v) => v.n === spokenVerse.value)
  return verses.length ? Math.round(((idx + 1) / verses.length) * 100) : 0
})

// Footnotes pulled out of each verse, collected under the chapter (keyed by verse+label).
const chapterNotes = computed(() => {
  const out: { verse: number; label: string; text: string }[] = []
  if (!reader.data) return out
  for (const v of reader.data.verses) {
    for (const note of v.notes) out.push({ verse: v.n, label: note.label, text: note.text })
  }
  return out
})

// ── Strong's word study: tap a tagged word → lexicon entry in the rail ──
// The menu's "Word study" button opens this in place; wordStudyOn reveals the tappable
// words for the current chapter even when the global Strong's-display setting is off.
const wordStudyOn = ref(false)
const {
  strongsKey,
  entry: strongsEntry,
  error: strongsError,
  loading: strongsLoading,
  tapWord,
  clear: clearWordStudy
} = useWordStudy()

const wordsTappable = computed(() => settings.showStrongs || wordStudyOn.value)
const chapterHasStrongs = computed(
  () => !!reader.data?.verses.some((v) => v.segments?.some((s) => s.kind === 'word'))
)

function openWordStudy() {
  wordStudyOn.value = true
}

function closeWordStudy() {
  clearWordStudy()
  wordStudyOn.value = false
}

// ── Compare: same capability as Study, surfaced as a rail card scoped to the selected verse ──
const compareOpen = ref(false)
const {
  focus: compareFocus,
  rows: compareRows,
  comparing,
  compareError,
  loadCompare
} = useCompare({ active: compareOpen })

function openCompare() {
  compareOpen.value = true
  compareFocus.value = reader.selectedVerse ?? 1
  loadCompare()
}

function closeCompare() {
  compareOpen.value = false
}

// Keep the open compare card in step with the selected verse.
watch(
  () => reader.selectedVerse,
  (v) => {
    if (compareOpen.value && v != null) {
      compareFocus.value = v
      loadCompare()
    }
  }
)

// ── Notes: shared quick-capture capability, anchored to the current passage ──
const {
  title: noteTitle,
  body: noteBody,
  bodyEl: noteBodyEl,
  saved: noteSaved,
  passageNotes,
  save: saveNote,
  openNote,
  focusComposer: focusNoteComposer,
  relDate: noteRelDate
} = useNotes()

// ── Passage action menu: floating keystone entry (shared PassageActions component) ──
const menuPos = ref({ x: 0, y: 0 })
const menuDismissed = ref(false)
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

// Left click: quick-highlight this verse — the immersive surface's primary gesture. Any
// open action menu is dismissed.
function onVerseClick(v: { n: number }) {
  reader.toggleHighlightRange([v.n])
  if (reader.selectedVerse != null) {
    reader.clearSelection()
    menuDismissed.value = true
  }
}

// Right click: open the passage action menu at the pointer. Shift extends the selection so
// Highlight/Note act on the whole passage.
function onVerseContext(v: { n: number }, e: MouseEvent) {
  e.preventDefault()
  if (e.shiftKey && reader.selectedVerse != null) reader.extendSelection(v.n)
  else if (reader.selectedVerse !== v.n || reader.hasRange) reader.selectVerse(v.n)
  menuPos.value = { x: e.clientX, y: e.clientY }
  menuDismissed.value = false
}

function menuWordStudy() {
  openWordStudy()
  menuDismissed.value = true
}
function menuCompare() {
  openCompare()
  menuDismissed.value = true
}
function menuHighlight() {
  reader.toggleHighlightRange(reader.selectedVerses)
  menuDismissed.value = true
}
function menuNote() {
  focusNoteComposer()
  menuDismissed.value = true
}

function onSelectionKey(e: KeyboardEvent) {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
  if (e.key === 'Escape' && reader.selectedVerse != null) {
    reader.clearSelection()
    menuDismissed.value = true
  }
}
onMounted(() => window.addEventListener('keydown', onSelectionKey))
onUnmounted(() => window.removeEventListener('keydown', onSelectionKey))
</script>

<template>
  <!-- Empty state: nothing installed -->
  <div v-if="reader.ready && reader.installedBibles.length === 0" class="empty-screen">
    <div class="empty-card">
      <div class="empty-mark"></div>
      <h2 class="serif">No translations yet</h2>
      <p>Download a translation in the Library to start reading.</p>
      <button class="empty-btn" @click="ui.go('library')">Open the Library →</button>
    </div>
  </div>

  <div v-else class="read">
    <!-- top bar -->
    <div class="topbar">
      <div class="pick">
        <button class="chip hover-line" @click="openBookPicker">
          {{ reader.bookName }} {{ reader.chapter }} <span class="caret">▾</span>
        </button>
        <div v-if="bookOpen" class="panel book-panel">
          <div class="book-cols">
            <div class="book-list">
              <template v-for="g in grouped" :key="g.key">
                <div class="book-group-label">{{ g.label }}</div>
                <button
                  v-for="b in g.books"
                  :key="b.code"
                  class="book-item hover-soft"
                  :class="{ active: (draftBook ?? reader.book) === b.code }"
                  @click="draftBook = b.code"
                >
                  {{ b.name }}
                </button>
              </template>
            </div>
            <div class="chapter-grid">
              <button
                v-for="n in draftChapters"
                :key="n"
                class="chapter-cell hover-soft"
                :class="{ active: (draftBook ?? reader.book) === reader.book && n === reader.chapter }"
                @click="pickChapter(n)"
              >
                {{ n }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="pick">
        <button class="chip chip-accent hover-line" @click="transOpen = !transOpen">
          {{ reader.moduleName }} <span class="caret">▾</span>
        </button>
        <div v-if="transOpen" class="panel trans-panel">
          <button
            v-for="m in reader.installedBibles"
            :key="m.name"
            class="trans-item hover-soft"
            @click="pickModule(m.name)"
          >
            <span class="trans-mark" :style="{ background: reader.moduleName === m.name ? 'var(--accent)' : 'transparent' }"></span>
            <span class="trans-tag">{{ m.name }}</span>
            <span class="trans-name">{{ m.description }}</span>
          </button>
          <div class="trans-foot">
            <button class="link" @click="transOpen = false; ui.go('study')">Compare translations side by side →</button>
          </div>
        </div>
      </div>

      <div class="spacer"></div>
      <button class="ghost hover-ink" @click="ui.go('study')">Study this chapter</button>
      <button
        class="listen"
        :class="{ disabled: !hasTTS }"
        :title="hasTTS ? 'Read aloud' : 'Speech not available in this browser'"
        @click="toggleListen"
      >
        Listen
      </button>
    </div>

    <!-- body -->
    <div class="body">
      <div class="cols">
        <div class="reading">
          <div v-if="reader.loadingChapter" class="loading">Loading…</div>
          <p v-else-if="reader.error" class="error">{{ reader.error }}</p>
          <template v-else-if="reader.data">
            <div class="eyebrow">{{ sectionLabels[reader.currentBook?.section ?? 'nt'] }}</div>
            <h1 class="serif">{{ reader.bookName }} <span class="accent">{{ reader.chapter }}</span></h1>
            <div class="meta">{{ reader.data.verses.length }} verses · {{ reader.moduleName }}</div>

            <div class="verses serif" :style="versesStyle">
              <span
                v-for="v in reader.data.verses"
                :key="v.n"
                class="verse"
                :style="{ background: verseBg(v.n), opacity: verseOpacity(v.n) }"
                @click="onVerseClick(v)"
                @contextmenu="onVerseContext(v, $event)"
              ><sup class="vnum">{{ v.n }}</sup><template
                  v-if="(settings.showFootnotes && v.notes.length) || wordsTappable"
                ><template v-for="(seg, i) in v.segments" :key="i"><template
                    v-if="seg.kind === 'word' && wordsTappable"
                  >{{ segLead(seg.text, i) }}<span
                      class="wtap"
                      @click.stop="tapWord(seg.strongs)"
                    >{{ seg.text }}</span></template><sup
                    v-else-if="seg.kind === 'note' && settings.showFootnotes"
                    class="noteref"
                    :title="seg.text"
                  >{{ seg.label }}</sup><template
                    v-else-if="seg.kind === 'note'"
                  ></template><template
                    v-else
                  >{{ segLead(seg.text, i) + seg.text }}</template></template></template><template v-else>{{ v.text }}</template>{{ ' ' }}</span>
            </div>

            <div v-if="settings.showFootnotes && chapterNotes.length" class="notes">
              <div class="notes-label">Notes</div>
              <div v-for="(note, i) in chapterNotes" :key="i" class="note-row">
                <span class="note-key">{{ note.verse }}<span class="note-mark">{{ note.label }}</span></span>
                <span class="note-text">{{ note.text }}</span>
              </div>
            </div>

          </template>
        </div>

        <aside class="rail-side">
          <div
            v-if="compareOpen"
            class="word-card"
          >
            <div class="word-card-head">
              <span class="word-card-label">Compare · {{ reader.bookName }} {{ reader.chapter }}:{{ compareFocus }}</span>
              <button class="word-card-close hover-ink" @click="closeCompare">✕</button>
            </div>
            <div v-if="comparing" class="word-card-state">Comparing…</div>
            <p v-else-if="compareError" class="word-card-error">{{ compareError }}</p>
            <div v-else-if="compareRows.length" class="compare-rows">
              <div v-for="(r, i) in compareRows" :key="r.module" class="compare-row">
                <span class="compare-tag" :style="{ color: i === 0 ? 'var(--accent)' : 'var(--muted)' }">{{ r.module }}</span>
                <span class="compare-text serif">{{ r.text ?? '—' }}</span>
              </div>
            </div>
            <p v-else class="word-card-state">Install more than one translation in the Library to compare renderings.</p>
          </div>

          <div
            v-if="wordStudyOn || (settings.showStrongs && (strongsEntry || strongsLoading || strongsError))"
            class="word-card"
          >
            <div class="word-card-head">
              <span class="word-card-label">Word study<template v-if="strongsKey"> · {{ strongsKey }}</template></span>
              <button class="word-card-close hover-ink" @click="closeWordStudy">✕</button>
            </div>
            <div v-if="strongsLoading" class="word-card-state">Looking up…</div>
            <p v-else-if="strongsError" class="word-card-error">{{ strongsError }}</p>
            <StrongsCard v-else-if="strongsEntry" :entry="strongsEntry" />
            <p v-else-if="!chapterHasStrongs" class="word-card-state">
              This translation isn’t Strong’s-tagged. Switch to a tagged translation (e.g. KJVA) to study words.
            </p>
            <p v-else class="word-card-state">Tap a highlighted word in the passage to open its Greek or Hebrew entry.</p>
          </div>

          <div class="note-card">
            <div class="note-card-head">
              <span class="note-card-label">Notes</span>
              <span v-if="noteSaved" class="note-saved">Saved ✓</span>
            </div>
            <div v-if="reader.currentRef" class="note-anchor">{{ reader.currentRef }}</div>
            <input
              v-model="noteTitle"
              class="note-title-input"
              type="text"
              placeholder="Title (optional)"
            />
            <textarea
              ref="noteBodyEl"
              v-model="noteBody"
              class="note-input"
              placeholder="Jot a note on this passage…"
            ></textarea>
            <button class="note-save" :disabled="!noteBody.trim()" @click="saveNote">Save note</button>

            <div v-if="passageNotes.length" class="note-list">
              <div class="note-list-label">On this passage</div>
              <div class="note-list-scroll">
                <button
                  v-for="n in passageNotes"
                  :key="n.id"
                  class="note-list-item hover-soft"
                  @click="openNote(n.id)"
                >
                  <span class="note-list-title">{{ n.title }}</span>
                  <span class="note-list-date">{{ noteRelDate(n.updatedAt) }}</span>
                </button>
              </div>
            </div>
          </div>

          <div class="hint-card">
            <div class="hint-label">Reading</div>
            <div class="hint-body">
              {{ reader.moduleName }} · {{ reader.bookName }} {{ reader.chapter }}
            </div>
          </div>

          <div v-if="plan.enabled" class="plan-card">
            <div class="plan-label">Reading plan · Day {{ plan.currentDay }}/{{ PLAN_DAYS }}</div>
            <div class="plan-today">{{ plan.todayLabel }}</div>
            <div class="plan-track"><div class="plan-fill" :style="{ width: plan.percent + '%' }"></div></div>
            <div class="plan-meta">
              {{ plan.chaptersRead }}/{{ plan.totalChapters }} chapters
              <span :class="{ ok: plan.onTrack }">· {{ plan.onTrack ? 'on track' : `${plan.behindBy} behind` }}</span>
            </div>
            <div class="plan-actions">
              <button class="plan-open" @click="openTodayReading">Open today</button>
              <button
                class="plan-mark"
                :class="{ done: plan.todayComplete }"
                @click="plan.markDayRead(plan.currentDayIndex)"
              >{{ plan.todayComplete ? 'Read ✓' : 'Mark read' }}</button>
            </div>
          </div>

          <div class="hint-text">Select any verse to compare, highlight, or start a note.</div>
        </aside>
      </div>
    </div>

    <PassageActions
      v-if="menuOpen"
      :ref-label="selectionLabel"
      :highlighted="selectionHighlighted"
      :pos="menuPos"
      @word-study="menuWordStudy"
      @compare="menuCompare"
      @cross-refs="ui.go('search')"
      @highlight="menuHighlight"
      @note="menuNote"
    />

    <!-- listen bar -->
    <div v-if="listening" class="listenbar">
      <button class="play" @click="togglePlay">{{ playing ? '❚❚' : '▶' }}</button>
      <div class="listen-meta">
        <div class="listen-title">{{ reader.bookName }} {{ reader.chapter }} · {{ reader.moduleName }}</div>
        <div class="listen-sub">
          {{ spokenVerse ? `Following along — verse ${spokenVerse}` : 'Ready' }}
        </div>
      </div>
      <div class="listen-track"><div class="listen-fill" :style="{ width: progressPct + '%' }"></div></div>
      <button class="listen-close hover-ink" @click="stopListening">Close</button>
    </div>
  </div>
</template>

<style scoped>
.read {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.topbar {
  height: 58px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 24px;
}
.pick {
  position: relative;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}
.chip-accent {
  color: var(--accent);
}
.caret {
  color: var(--muted);
  font-size: 11px;
}
.spacer {
  flex: 1;
}
.ghost {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  padding: 8px 10px;
}
.listen {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.listen.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.panel {
  position: absolute;
  top: 44px;
  left: 0;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(30, 22, 10, 0.12);
  z-index: 40;
}
.trans-panel {
  width: 330px;
  padding: 6px;
}
.trans-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  border-radius: 7px;
  padding: 9px 10px;
  cursor: pointer;
  text-align: left;
}
.trans-mark {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 6px;
}
.trans-tag {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  min-width: 48px;
  flex-shrink: 0;
}
.trans-name {
  font-size: 12.5px;
  color: var(--muted);
  white-space: normal;
  line-height: 1.35;
}
.trans-foot {
  border-top: 1px solid var(--line);
  margin: 6px 4px 2px;
  padding: 8px 6px 4px;
}
.link {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
  padding: 0;
}
.book-panel {
  width: 460px;
}
.book-cols {
  display: flex;
  height: 340px;
}
.book-list {
  width: 220px;
  overflow-y: auto;
  border-right: 1px solid var(--line);
  padding: 6px;
}
.book-group-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  padding: 10px 8px 4px;
}
.book-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 7px 8px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
}
.book-item.active {
  color: var(--accent);
  font-weight: 700;
}
.chapter-grid {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  align-content: start;
}
.chapter-cell {
  aspect-ratio: 1;
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--ink);
  cursor: pointer;
}
.chapter-cell.active {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}
.body {
  flex: 1;
  overflow-y: auto;
}
.cols {
  display: flex;
  justify-content: center;
  gap: 52px;
  padding: 60px 40px 120px;
}
.reading {
  max-width: 620px;
  min-width: 0;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
h1 {
  font-weight: 500;
  font-size: 46px;
  margin: 0 0 8px;
}
.accent {
  color: var(--accent);
}
.meta {
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 34px;
}
.verses {
  line-height: 1.85;
  text-wrap: pretty;
}
.verse {
  cursor: pointer;
  border-radius: 3px;
  padding: 1px 3px;
  transition: background 0.15s;
}
.vnum {
  font-size: 0.58em;
  color: var(--accent);
  font-weight: 600;
  margin-right: 4px;
  font-family: 'Instrument Sans', sans-serif;
}
.noteref {
  font-size: 0.62em;
  color: var(--gold);
  font-weight: 700;
  padding-left: 1px;
  cursor: help;
  font-family: 'Instrument Sans', sans-serif;
}
.wtap {
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.12s;
}
.wtap:hover {
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}
.notes {
  margin-top: 40px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  font-family: 'Instrument Sans', sans-serif;
}
.notes-label {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 14px;
}
.note-row {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 13px;
  line-height: 1.55;
}
.note-key {
  flex-shrink: 0;
  min-width: 36px;
  color: var(--accent);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.note-mark {
  color: var(--gold);
  margin-left: 1px;
}
.note-text {
  color: var(--muted);
}
.rail-side {
  width: clamp(170px, 18vw, 225px);
  flex-shrink: 0;
  padding-top: 196px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.word-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 12px 14px;
}
.word-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.word-card-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.word-card-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  padding: 0 2px;
}
.word-card-state {
  font-size: 13px;
  color: var(--muted);
}
.word-card-error {
  font-size: 13px;
  line-height: 1.5;
  color: var(--accent);
  margin: 0;
}
.compare-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.compare-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.compare-tag {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.compare-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink);
}
.note-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 12px 14px;
}
.note-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.note-card-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.note-saved {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gold);
}
.note-anchor {
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 8px;
}
.note-title-input,
.note-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12.5px;
  color: var(--ink);
  font-family: inherit;
}
.note-title-input {
  margin-bottom: 6px;
}
.note-input {
  min-height: 68px;
  line-height: 1.5;
  resize: vertical;
}
.note-title-input:focus,
.note-input:focus {
  outline: none;
  border-color: var(--accent);
}
.note-save {
  width: 100%;
  margin-top: 8px;
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 6px;
  padding: 7px 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.note-save:disabled {
  opacity: 0.5;
  cursor: default;
}
.note-list {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.note-list-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}
.note-list-scroll {
  max-height: 132px;
  overflow-y: auto;
}
.note-list-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  border-radius: 4px;
  padding: 4px 4px;
  text-align: left;
  cursor: pointer;
  color: var(--ink);
}
.note-list-title {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-list-date {
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}
.hint-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--gold);
  border-radius: 8px;
  padding: 12px 14px;
}
.hint-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}
.hint-body {
  font-size: 13px;
  line-height: 1.55;
}
.plan-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 12px 14px;
}
.plan-label {
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}
.plan-today {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  margin-bottom: 10px;
}
.plan-track {
  height: 4px;
  background: var(--soft);
  border-radius: 2px;
  overflow: hidden;
}
.plan-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.plan-meta {
  font-size: 11px;
  color: var(--muted);
  margin: 6px 0 10px;
}
.plan-meta .ok {
  color: var(--gold);
}
.plan-actions {
  display: flex;
  gap: 6px;
}
.plan-open {
  flex: 1;
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 6px;
  padding: 7px 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.plan-mark {
  flex: 1;
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}
.plan-mark.done {
  color: var(--gold);
  border-color: var(--gold);
}
.hint-text {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
  padding: 0 4px;
}
.loading,
.error {
  font-size: 14px;
  color: var(--muted);
}
.error {
  color: var(--accent);
}
.listenbar {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  background: var(--card);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
}
.play {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  cursor: pointer;
  font-size: 13px;
  flex-shrink: 0;
}
.listen-meta {
  min-width: 0;
}
.listen-title {
  font-size: 13px;
  font-weight: 600;
}
.listen-sub {
  font-size: 11.5px;
  color: var(--muted);
}
.listen-track {
  flex: 1;
  height: 4px;
  background: var(--soft);
  border-radius: 2px;
  overflow: hidden;
}
.listen-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.listen-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  flex-shrink: 0;
}
.empty-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-card {
  text-align: center;
  max-width: 340px;
}
.empty-mark {
  width: 14px;
  height: 14px;
  background: var(--accent);
  transform: rotate(45deg);
  margin: 0 auto 20px;
}
.empty-card h2 {
  font-size: 26px;
  font-weight: 500;
  margin: 0 0 8px;
}
.empty-card p {
  font-size: 14px;
  color: var(--muted);
  margin: 0 0 20px;
}
.empty-btn {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 8px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
</style>
