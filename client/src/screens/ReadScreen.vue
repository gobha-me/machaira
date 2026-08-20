<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useReadingPlan } from '../stores/readingPlan'
import { PLAN_DAYS } from '../services/plan'
import { type BookEntry } from '../services/api'
import { useCompare } from '../composables/useCompare'
import { useWordStudy } from '../composables/useWordStudy'
import { useNotes } from '../composables/useNotes'
import { usePassageMenu } from '../composables/usePassageMenu'
import { useSpeechSynthesis } from '../composables/useSpeechSynthesis'
import { segLead } from '../utils/text'
import PassageActions from '../components/PassageActions.vue'
import StrongsCard from '../components/StrongsCard.vue'
import CommentaryPanel from '../components/CommentaryPanel.vue'
import ComparePanel from '../components/ComparePanel.vue'
import CrossReferencesPanel from '../components/CrossReferencesPanel.vue'

const reader = useReader()
const ui = useUi()
const settings = useSettings()
const plan = useReadingPlan()

function openTodayReading() {
  const first = plan.firstUnreadToday
  if (first && reader.moduleName) reader.openRef(reader.moduleName, first.book, first.chapter)
}

const versesStyle = computed(() => ({
  fontSize: 'calc(var(--reader-font-base, 20px) * var(--vs))',
  letterSpacing: settings.extraSpacing ? '0.03em' : 'normal',
  wordSpacing: settings.extraSpacing ? '0.12em' : 'normal'
}))

const transOpen = ref(false)
const bookOpen = ref(false)
const draftBook = ref<string | null>(null)
const activeTranslation = computed(() =>
  reader.installedBibles.find((module) => module.name === reader.moduleName)
)
const activeTranslationLabel = computed(() => {
  const module = activeTranslation.value
  if (!module) return reader.moduleName ?? 'Translation'
  return `${module.name} — ${module.description}`
})

onMounted(() => {
  // Guard the init like Study already does. Screens are swapped, not kept alive, so a bare
  // init() re-ran loadChapter on every visit to Read — which nulls the selection and refetches
  // the chapter, so a range built in Study evaporated on the way back.
  if (!reader.ready) reader.init()
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
  transOpen.value = false
  bookOpen.value = !bookOpen.value
}

function openTranslationPicker() {
  bookOpen.value = false
  transOpen.value = !transOpen.value
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
const {
  supported: hasTTS,
  active: listening,
  playing,
  currentVerse: spokenVerse,
  completed: listeningComplete,
  error: listeningError,
  progress: progressPct,
  toggle: toggleListen,
  togglePlayback: togglePlay,
  stop: stopListening
} = useSpeechSynthesis({
  verses: () => reader.data?.verses ?? [],
  startVerse: () => reader.selectedVerse,
  onComplete: () => {
    // Only a natural end marks the chapter read; cancellation and synthesis errors do not.
    if (plan.enabled && reader.book) plan.markChapterRead(reader.book, reader.chapter)
  }
})

// The verse being read aloud outranks both the highlight and the selection tint; everything
// else is the shared selection presentation (usePassageMenu).
function verseBg(n: number): string {
  if (settings.followAlong && spokenVerse.value === n) {
    return 'color-mix(in oklab, var(--accent) 18%, transparent)'
  }
  return baseVerseBg(n)
}

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
const toolsOpen = ref(false)
const toolsToggleEl = ref<HTMLButtonElement | null>(null)
const toolsCloseEl = ref<HTMLButtonElement | null>(null)

async function openTools() {
  toolsOpen.value = true
  await nextTick()
  toolsCloseEl.value?.focus()
}

async function closeTools() {
  toolsOpen.value = false
  await nextTick()
  toolsToggleEl.value?.focus()
}

function onReadEscape() {
  bookOpen.value = false
  transOpen.value = false
  if (toolsOpen.value) void closeTools()
}
const {
  strongsKey,
  entry: strongsEntry,
  error: strongsError,
  loading: strongsLoading,
  tapWord,
  clear: clearWordStudy
} = useWordStudy()

async function tapReaderWord(keys: string[]) {
  openTools()
  await tapWord(keys)
}

// Whether the chapter renders word segments at all. Deliberately chapter-wide rather than
// per-verse: gating the segment subtree on the selection would swap ~130 DOM nodes per verse
// between the segment path and the plain-text fallback on every click.
const wordsRevealed = computed(() => settings.showStrongs || wordStudyOn.value)

// Which of those words are actually tappable. The global Strong's setting lights up the whole
// chapter. The menu's "Word study" lights only the selected range, so the rest of the chapter
// reads as plain prose and the reveal follows the brought-forward passage; it falls back to the
// whole chapter once the selection clears, so an open word-study card is never a dead end.
function wordsTappableIn(n: number): boolean {
  if (settings.showStrongs) return true
  if (!wordStudyOn.value) return false
  const vs = reader.selectedVerses
  return vs.length === 0 || vs.includes(n)
}

const chapterHasStrongs = computed(
  () => !!reader.data?.verses.some((v) => v.segments?.some((s) => s.kind === 'word'))
)

function openWordStudy() {
  wordStudyOn.value = true
  openTools()
}

function closeWordStudy() {
  clearWordStudy()
  wordStudyOn.value = false
}

// Changing passage is not a word-study gesture. loadChapter clears the selection, so a sticky
// reveal would silently light up every word of a chapter the user never invoked it on.
watch(
  () => [reader.moduleName, reader.book, reader.chapter],
  () => {
    stopListening()
    toolsOpen.value = false
    bookOpen.value = false
    transOpen.value = false
    if (wordStudyOn.value) closeWordStudy()
  }
)

// ── Compare: same capability as Study, surfaced as a rail card scoped to the selected verse ──
const compareOpen = ref(false)
const {
  focusLabel: compareFocusLabel,
  rows: compareRows,
  comparing,
  compareError,
  syncFromSelection: syncCompare
} = useCompare({ active: compareOpen, followSelection: true })

function openCompare() {
  // Set active first — loadCompare reads it synchronously.
  compareOpen.value = true
  openTools()
  syncCompare()
}

function closeCompare() {
  compareOpen.value = false
}

// ── Commentary: shared capability, surfaced as a rail card scoped to the current chapter ──
const commentaryOpen = ref(false)
function openCommentary() {
  commentaryOpen.value = true
  openTools()
}
function closeCommentary() {
  commentaryOpen.value = false
}

// ── Cross-references: real embedded SWORD notes for the selected passage ──
const crossReferencesOpen = ref(false)
function openCrossReferences() {
  crossReferencesOpen.value = true
  openTools()
}
function closeCrossReferences() {
  crossReferencesOpen.value = false
}

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
// Gestures, menu state and the selection's presentation come from usePassageMenu, so Read and
// Study can't drift apart. Only the word lookup is per-surface: here it fills the rail card.
const {
  menuPos,
  menuOpen,
  selectionLabel,
  selectionHighlighted,
  selectionCrossReferences,
  crossReferencesAvailable,
  crossReferencesReason,
  verseOpacity,
  verseBg: baseVerseBg,
  onVerseClick,
  onVerseContext,
  onVerseMouseDown,
  onVersePointerDown,
  onVersePointerMove,
  onVersePointerEnd,
  onWordClick,
  dismiss
} = usePassageMenu({ onWordTap: (_n, keys) => tapReaderWord(keys) })

function menuWordStudy() {
  openWordStudy()
  dismiss()
}
function menuCompare() {
  openCompare()
  dismiss()
}
function menuCommentary() {
  openCommentary()
  dismiss()
}
function menuCrossReferences() {
  openCrossReferences()
  dismiss()
}
function menuHighlight() {
  reader.toggleHighlightRange(reader.selectedVerses)
  dismiss()
}
async function menuNote() {
  openTools()
  dismiss()
  await nextTick()
  focusNoteComposer()
}
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

  <div v-else class="read" @keydown.esc="onReadEscape">
    <!-- top bar -->
    <div class="topbar">
      <div class="pick">
        <button
          class="chip hover-line"
          :title="`${reader.bookName} ${reader.chapter}`"
          aria-controls="reader-book-picker"
          :aria-expanded="bookOpen"
          @click="openBookPicker"
        >
          <span class="chip-label">{{ reader.bookName }} {{ reader.chapter }}</span>
          <span class="caret">▾</span>
        </button>
        <div v-if="bookOpen" id="reader-book-picker" class="panel book-panel">
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

      <div class="pick trans-pick">
        <button
          class="chip chip-accent hover-line"
          :title="activeTranslationLabel"
          :aria-label="`Choose translation. Current: ${activeTranslationLabel}`"
          aria-controls="reader-translation-picker"
          :aria-expanded="transOpen"
          @click="openTranslationPicker"
        >
          <span class="chip-label">{{ reader.moduleName }}</span><span class="caret">▾</span>
        </button>
        <div v-if="transOpen" id="reader-translation-picker" class="panel trans-panel">
          <button
            v-for="m in reader.installedBibles"
            :key="m.name"
            class="trans-item hover-soft"
            :title="`${m.name} — ${m.description}`"
            :aria-label="`${m.name}: ${m.description}`"
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
        ref="toolsToggleEl"
        class="tools-toggle hover-line"
        aria-controls="passage-tools"
        :aria-expanded="toolsOpen"
        @click="toolsOpen ? closeTools() : openTools()"
      >Tools</button>
      <button
        class="listen"
        :class="{ disabled: !hasTTS }"
        :disabled="!hasTTS || !reader.data?.verses.length"
        :aria-pressed="listening"
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
            <div class="meta" :title="activeTranslationLabel">{{ reader.data.verses.length }} verses · {{ reader.moduleName }}</div>

            <div class="verses serif" :style="versesStyle">
              <span
                v-for="v in reader.data.verses"
                :key="v.n"
                class="verse"
                :style="{ background: verseBg(v.n), opacity: verseOpacity(v.n) }"
                @mousedown="onVerseMouseDown"
                @pointerdown="onVersePointerDown(v.n, $event)"
                @pointermove="onVersePointerMove"
                @pointerup="onVersePointerEnd"
                @pointercancel="onVersePointerEnd"
                @click="onVerseClick(v.n, $event)"
                @contextmenu="onVerseContext(v.n, $event)"
              ><sup class="vnum">{{ v.n }}</sup><template
                  v-if="(settings.showFootnotes && v.notes.length) || wordsRevealed"
                ><template v-for="(seg, i) in v.segments" :key="i"><template
                    v-if="seg.kind === 'word' && wordsTappableIn(v.n)"
                  >{{ segLead(seg.text, i) }}<span
                      class="wtap"
                      @click.stop="onWordClick(v.n, seg.strongs, $event)"
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

        <div
          v-if="toolsOpen"
          class="tools-backdrop"
          aria-hidden="true"
          @click="closeTools"
        ></div>

        <aside
          id="passage-tools"
          class="rail-side"
          :class="{ open: toolsOpen }"
          aria-label="Passage tools"
          @keydown.esc.stop="closeTools"
        >
          <div class="tools-drawer-head">
            <span>Passage tools</span>
            <button ref="toolsCloseEl" class="word-card-close hover-ink" aria-label="Close passage tools" @click="closeTools">✕</button>
          </div>
          <div
            v-if="compareOpen"
            class="word-card"
          >
            <div class="word-card-head">
              <span class="word-card-label">Compare · {{ reader.bookName }} {{ reader.chapter }}:{{ compareFocusLabel }}</span>
              <button class="word-card-close hover-ink" @click="closeCompare">✕</button>
            </div>
            <ComparePanel
              variant="rail"
              :rows="compareRows"
              :comparing="comparing"
              :error="compareError"
            />
          </div>

          <CommentaryPanel v-if="commentaryOpen" closable @close="closeCommentary" />

          <CrossReferencesPanel
            v-if="crossReferencesOpen"
            :entries="selectionCrossReferences"
            :module-name="reader.moduleName ?? ''"
            :ref-label="selectionLabel"
            :empty-reason="crossReferencesReason"
            closable
            @close="closeCrossReferences"
          />

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
            <div class="hint-body" :title="activeTranslationLabel">
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

          <div v-if="reader.highlightError" class="error">{{ reader.highlightError }}</div>
          <div class="hint-text desktop-hint">Select any verse to compare, highlight, or start a note.</div>
          <div class="hint-text mobile-hint">Tap a verse to select it. Long-press another verse to select a range and open its actions.</div>
        </aside>
      </div>
    </div>

    <PassageActions
      v-if="menuOpen"
      :ref-label="selectionLabel"
      :highlighted="selectionHighlighted"
      :pos="menuPos"
      :cross-references-available="crossReferencesAvailable"
      :cross-references-reason="crossReferencesReason"
      @word-study="menuWordStudy"
      @compare="menuCompare"
      @commentary="menuCommentary"
      @cross-refs="menuCrossReferences"
      @highlight="menuHighlight"
      @note="menuNote"
    />

    <!-- listen bar -->
    <div v-if="listening" class="listenbar">
      <button
        class="play"
        :title="playing ? 'Pause read-aloud' : listeningComplete ? 'Replay chapter' : 'Resume read-aloud'"
        :aria-label="playing ? 'Pause read-aloud' : listeningComplete ? 'Replay chapter' : 'Resume read-aloud'"
        @click="togglePlay"
      >{{ playing ? '❚❚' : '▶' }}</button>
      <div class="listen-meta">
        <div class="listen-title" :title="`${reader.bookName} ${reader.chapter} · ${activeTranslationLabel}`">{{ reader.bookName }} {{ reader.chapter }} · {{ reader.moduleName }}</div>
        <div class="listen-sub" :class="{ error: listeningError }" aria-live="polite">
          {{ listeningError
            ? listeningError
            : listeningComplete
              ? 'Chapter complete'
              : spokenVerse
                ? `Following along — verse ${spokenVerse}`
                : 'Ready' }}
        </div>
      </div>
      <div
        class="listen-track"
        role="progressbar"
        aria-label="Read-aloud progress"
        :aria-valuenow="progressPct"
        aria-valuemin="0"
        aria-valuemax="100"
      ><div class="listen-fill" :style="{ width: progressPct + '%' }"></div></div>
      <button class="listen-close hover-ink" aria-label="Close read-aloud" @click="stopListening">Close</button>
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
.trans-pick {
  min-width: 0;
  max-width: min(220px, 28vw);
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
  max-width: 100%;
}
.chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-accent {
  color: var(--accent);
}
.caret {
  color: var(--muted);
  font-size: 11px;
  flex-shrink: 0;
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
.listen.disabled,
.listen:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tools-toggle {
  display: none;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
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
  width: min(330px, calc(100vw - 32px));
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
  min-width: 0;
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
  max-width: 100px;
  flex: 0 1 100px;
  overflow-wrap: anywhere;
}
.trans-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--muted);
  white-space: normal;
  line-height: 1.35;
  overflow-wrap: anywhere;
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
  overflow-wrap: anywhere;
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
.tools-drawer-head,
.tools-backdrop,
.mobile-hint {
  display: none;
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
  overflow-wrap: anywhere;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.listen-sub {
  font-size: 11.5px;
  color: var(--muted);
}
.listen-sub.error {
  color: var(--accent);
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

@media (max-width: 768px) {
  .read {
    --reader-font-base: 18px;
  }
  .topbar {
    height: auto;
    min-height: 104px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 8px;
    padding: 10px 12px;
  }
  .topbar > .pick:first-child {
    grid-column: 1 / 3;
    min-width: 0;
  }
  .topbar > .pick:first-child .chip {
    width: 100%;
  }
  .trans-pick {
    grid-column: 3;
    width: 72px;
    max-width: none;
  }
  .trans-pick .chip {
    width: 100%;
    justify-content: center;
  }
  .topbar .spacer {
    display: none;
  }
  .ghost {
    grid-column: 1;
    min-height: 44px;
    padding: 8px 2px;
    text-align: left;
  }
  .tools-toggle {
    display: block;
    grid-column: 2;
    min-height: 44px;
  }
  .listen {
    grid-column: 3;
    min-height: 44px;
    justify-content: center;
    padding: 8px 12px;
  }
  .panel {
    position: fixed;
    z-index: 70;
    top: 124px;
    right: 8px;
    bottom: calc(66px + env(safe-area-inset-bottom));
    left: 8px;
    width: auto;
    max-height: none;
  }
  .trans-panel {
    overflow-y: auto;
    padding: 8px;
  }
  .book-cols {
    height: 100%;
    min-height: 0;
  }
  .book-list {
    width: 52%;
  }
  .book-item,
  .trans-item {
    min-height: 44px;
  }
  .chapter-grid {
    grid-template-columns: repeat(4, minmax(34px, 1fr));
  }
  .body {
    min-height: 0;
  }
  .cols {
    display: block;
    padding: 34px 16px 96px;
  }
  .reading {
    width: 100%;
    max-width: 680px;
    margin: 0 auto;
  }
  h1 {
    font-size: 38px;
  }
  .meta {
    margin-bottom: 26px;
  }
  .verse {
    padding: 3px 2px;
    touch-action: pan-y;
    -webkit-touch-callout: none;
  }
  .tools-backdrop {
    display: block;
    position: fixed;
    z-index: 54;
    inset: 0 0 calc(58px + env(safe-area-inset-bottom));
    width: 100%;
    border: 0;
    padding: 0;
    background: color-mix(in oklab, var(--ink) 28%, transparent);
    cursor: pointer;
  }
  .rail-side {
    display: none;
    position: fixed;
    z-index: 55;
    right: 8px;
    bottom: calc(58px + env(safe-area-inset-bottom));
    left: 8px;
    width: auto;
    max-height: min(74dvh, 680px);
    overflow-y: auto;
    padding: 0 14px 18px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-bottom: 0;
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -18px 44px rgba(30, 22, 10, 0.2);
  }
  .rail-side.open {
    display: flex;
  }
  .tools-drawer-head {
    position: sticky;
    z-index: 1;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 -14px;
    padding: 14px;
    border-bottom: 1px solid var(--line);
    background: var(--paper);
    color: var(--ink);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .tools-drawer-head .word-card-close {
    width: 44px;
    height: 44px;
    margin: -10px;
  }
  .desktop-hint {
    display: none;
  }
  .mobile-hint {
    display: block;
  }
  .listenbar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px 12px;
    padding: 10px 12px;
  }
  .play {
    width: 44px;
    height: 44px;
  }
  .listen-track {
    grid-column: 2 / 4;
  }
  .listen-close {
    min-height: 44px;
  }
  .empty-screen {
    padding: 24px 16px;
  }
}

@media (min-width: 600px) and (max-width: 768px) {
  .topbar {
    min-height: 58px;
    grid-template-columns: minmax(140px, auto) 80px minmax(0, 1fr) auto auto auto;
  }
  .topbar > .pick:first-child {
    grid-column: 1;
  }
  .trans-pick {
    grid-column: 2;
    width: 80px;
  }
  .ghost {
    grid-column: 4;
    text-align: center;
  }
  .tools-toggle {
    grid-column: 5;
  }
  .listen {
    grid-column: 6;
  }
  .panel {
    top: 66px;
  }
}

@media (max-width: 360px) {
  .topbar {
    gap: 6px;
  }
  .trans-pick {
    width: 64px;
  }
  .chip,
  .listen,
  .tools-toggle {
    padding-right: 10px;
    padding-left: 10px;
  }
  .cols {
    padding-right: 13px;
    padding-left: 13px;
  }
}

@media (max-width: 480px) {
  .book-list {
    width: 45%;
  }
  .chapter-grid {
    grid-template-columns: repeat(3, minmax(44px, 1fr));
    padding: 8px;
  }
}
</style>
