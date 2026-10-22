<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { useCompare } from '../composables/useCompare'
import { useWordStudy } from '../composables/useWordStudy'
import { useNotes } from '../composables/useNotes'
import { usePassageMenu } from '../composables/usePassageMenu'
import { segLead } from '../utils/text'
import PassageActions from '../components/PassageActions.vue'
import TextSelectionActions from '../components/TextSelectionActions.vue'
import StrongsCard from '../components/StrongsCard.vue'
import CommentaryPanel from '../components/CommentaryPanel.vue'
import ComparePanel from '../components/ComparePanel.vue'
import ConnectionsPanel from '../components/ConnectionsPanel.vue'

const reader = useReader()
const ui = useUi()

const {
  focus,
  focusEnd,
  focusLabel,
  rows,
  comparing,
  compareError,
  atStart,
  atEnd,
  syncFromSelection,
  stepVerse,
  verseNums
} = useCompare({ keyboard: true, followSelection: true })

const {
  strongsKey,
  entry: strongs,
  error: strongsError,
  loading: strongsLoading,
  tapWord,
  clear: clearWordStudy
} = useWordStudy()

// A selected-word request must not populate the next passage after navigation.
watch(() => [reader.moduleName, reader.book, reader.chapter], clearWordStudy, { flush: 'sync' })

const {
  anchor: noteAnchor,
  anchorSelection: anchorNoteSelection,
  title: noteTitle,
  body: noteBody,
  bodyEl: noteBodyEl,
  saved: noteSaved,
  error: noteError,
  saving: noteSaving,
  passageNotes,
  save: saveNote,
  openNote,
  focusComposer,
  relDate: noteRelDate
} = useNotes()

const selectionRoot = ref<HTMLElement | null>(null)
function selectionNote(reference: string, quote: string) {
  anchorNoteSelection(reference, quote)
  menuNote()
}
async function selectionWordStudy(keys: string[]) {
  activeTab.value = 'word-study'
  await tapWord(keys)
}

const tabs = [
  { id: 'compare', label: 'Compare' },
  { id: 'commentary', label: 'Commentary' },
  { id: 'connections', label: 'Connections' },
  { id: 'word-study', label: 'Word study' }
] as const
type StudyTab = typeof tabs[number]['id']
const activeTab = ref<StudyTab>('compare')
const notesOpen = ref(false)
const passage = computed(() => ({ verseStart: focus.value, verseEnd: focusEnd.value }))
const focusedVerses = computed(() => reader.data?.verses.filter(
  (verse) => verse.n >= focus.value && verse.n <= focusEnd.value
) ?? [])

function pickVerse(event: Event, end = false) {
  const value = Number((event.target as HTMLSelectElement).value)
  if (!Number.isInteger(value) || !verseNums.value.includes(value)) return
  const lo = end ? Math.min(focus.value, value) : value
  const hi = end ? Math.max(focus.value, value) : value
  // Set the range directly: picking the current verse must never toggle the selection off.
  reader.selectedVerse = lo
  reader.rangeEnd = hi === lo ? null : hi
}

function onTabKey(event: KeyboardEvent, index: number) {
  let next: number
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = tabs.length - 1
  else return
  event.preventDefault()
  event.stopPropagation()
  activeTab.value = tabs[next].id
  document.getElementById(`study-tab-${activeTab.value}`)?.focus()
}

onMounted(async () => {
  if (!reader.ready) await reader.init()
  syncFromSelection()
})

// Word lookup is independent of the verse-number/gutter selection gesture.
async function studyWord(_n: number, keys: string[]) {
  activeTab.value = 'word-study'
  await tapWord(keys)
}

// ── Passage action menu: shared PassageActions component, same keystone as Read ──
// Gestures, menu state and the selection's presentation come from usePassageMenu, so a plain
// click means the same thing on both screens. Compare follows the selection (followSelection),
// so selecting is all Study's deep-dive gesture has to do.
const {
  menuPos,
  menuOpen,
  selectionLabel,
  selectionHighlighted,
  verseOpacity,
  verseBg,
  onVerseClick,
  onVerseContext,
  onVerseKeydown,
  onVerseMouseDown,
  onVersePointerDown,
  onVersePointerMove,
  onVersePointerEnd,
  onWordClick,
  dismiss
} = usePassageMenu({ onWordTap: studyWord })

// Mark the compared passage even when nothing is selected — on a fresh mount, and after a
// deselect (where the followSelection watch deliberately holds the last comparison), the top bar
// and the panel would otherwise point at a verse with nothing on screen indicating which one.
// Compare follows the selection, so this can never accent a verse outside an active range.
function cverseBg(n: number): string {
  const base = verseBg(n)
  if (base !== 'transparent') return base
  if (n >= focus.value && n <= focusEnd.value)
    return 'color-mix(in oklab, var(--accent) 12%, transparent)'
  return 'transparent'
}

// Passage actions reveal the corresponding tab without adding another panel to the page.
function revealTab(tab: StudyTab) {
  activeTab.value = tab
  dismiss()
  void nextTick(() => document.getElementById(`study-tab-${tab}`)?.focus())
}
function menuWordStudy() { revealTab('word-study') }
function menuCompare() { revealTab('compare') }
function menuCommentary() { revealTab('commentary') }
function menuCrossReferences() { revealTab('connections') }
function menuHighlight() {
  void reader.toggleHighlightRange(reader.selectedVerses)
  dismiss()
}
function menuNote() {
  notesOpen.value = true
  void nextTick(focusComposer)
  dismiss()
}
</script>

<template>
  <div class="study">
    <div class="topbar">
      <div class="passage-heading">
        <span class="eyebrow">Study passage</span>
        <h1 class="ref">
          {{ reader.bookName }} {{ reader.chapter }}:{{ focusLabel }}
        </h1>
      </div>
      <div class="stepper">
        <button
          class="step hover-ink"
          :disabled="atStart"
          title="Previous verse"
          aria-label="Previous verse"
          @click="stepVerse(-1)"
        >
          ‹
        </button>
        <button
          class="step hover-ink"
          :disabled="atEnd"
          title="Next verse"
          aria-label="Next verse"
          @click="stepVerse(1)"
        >
          ›
        </button>
      </div>
      <div class="spacer" />
      <button
        class="back hover-ink"
        @click="ui.go('read')"
      >
        ← Back to reading
      </button>
    </div>

    <div class="scroll">
      <div class="verse-picker">
        <label>Verse
          <select
            aria-label="From verse"
            :value="focus"
            :disabled="!verseNums.length"
            @change="pickVerse($event)"
          >
            <option
              v-for="n in verseNums"
              :key="n"
              :value="n"
            >{{ n }}</option>
          </select>
        </label>
        <label>through
          <select
            aria-label="Through verse"
            :value="focusEnd"
            :disabled="!verseNums.length"
            @change="pickVerse($event, true)"
          >
            <option
              v-for="n in verseNums"
              :key="n"
              :value="n"
            >{{ n }}</option>
          </select>
        </label>
        <span class="sub">{{ reader.moduleName }}</span>
      </div>
      <div
        v-if="reader.data"
        ref="selectionRoot"
        data-passage-context
        class="context serif"
      >
        <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events, vuejs-accessibility/no-static-element-interactions -- Prose gestures supplement the native verse-number and word buttons. -->
        <span
          v-for="v in focusedVerses"
          :key="v.n"
          class="cverse"
          :data-verse="v.n"
          :style="{ background: cverseBg(v.n), opacity: verseOpacity(v.n) }"
          @mousedown="onVerseMouseDown"
          @pointerdown="onVersePointerDown(v.n, $event)"
          @pointermove="onVersePointerMove"
          @pointerup="onVersePointerEnd"
          @pointercancel="onVersePointerEnd"
          @click="onVerseClick(v.n, $event)"
          @contextmenu="onVerseContext(v.n, $event)"
        ><button
          type="button"
          class="cvnum"
          :aria-label="`Select verse ${v.n}`"
          :aria-pressed="reader.selectedVerses.includes(v.n)"
          aria-keyshortcuts="Shift+F10"
          @click.stop="onVerseClick(v.n, $event)"
          @keydown="onVerseKeydown(v.n, $event)"
        >{{ v.n }}</button><span data-selection-text><template
          v-for="(seg, i) in v.segments"
          :key="i"
        ><template v-if="seg.kind === 'word'">{{ segLead(v.segments, i) }}<button
          type="button"
          class="wtap"
          :data-strongs="seg.strongs.join(' ')"
          :aria-label="`Study ${seg.text} (${seg.strongs.join(', ')})`"
          @click.stop="onWordClick(v.n, seg.strongs, $event)"
        >{{ seg.text }}</button></template><template
          v-else-if="seg.kind === 'note'"
        /><template v-else>{{ segLead(v.segments, i) + seg.text }}</template></template></span>{{ ' ' }}</span>
      </div>
      <p
        v-if="reader.highlightError"
        class="error"
      >
        {{ reader.highlightError }}
      </p>

      <p
        v-if="reader.error"
        class="error"
        role="alert"
      >
        {{ reader.error }}
      </p>
      <p
        v-else-if="reader.loadingChapter"
        class="loading"
        role="status"
      >
        Loading passage…
      </p>
      <p
        v-else-if="!focusedVerses.length"
        class="empty"
      >
        Choose a passage in Read to begin studying.
      </p>

      <div
        class="study-tabs"
        role="tablist"
        aria-label="Study tools"
      >
        <button
          v-for="(tab, index) in tabs"
          :id="`study-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`study-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
          @keydown="onTabKey($event, index)"
        >
          {{ tab.label }}
        </button>
      </div>
      <section
        v-for="tab in tabs"
        v-show="activeTab === tab.id"
        :id="`study-panel-${tab.id}`"
        :key="tab.id"
        role="tabpanel"
        :aria-labelledby="`study-tab-${tab.id}`"
        tabindex="0"
        class="tool-panel"
      >
        <template v-if="activeTab === tab.id">
          <ComparePanel
            v-if="tab.id === 'compare'"
            variant="page"
            :rows="rows.filter((row) => row.verses.some((verse) => verse.text?.trim()))"
            :comparing="comparing"
            :error="compareError"
          />
          <CommentaryPanel
            v-else-if="tab.id === 'commentary'"
            variant="page"
            :passage="passage"
          />
          <ConnectionsPanel
            v-else-if="tab.id === 'connections'"
            variant="page"
            :passage="passage"
            :closable="false"
          />
          <template v-else>
            <p
              v-if="strongsKey"
              class="sub"
            >
              Strong’s lexicon · {{ strongsKey }}
            </p>
            <div
              :class="{ 'strongs-box': strongs }"
            >
              <p
                v-if="strongsError"
                class="strongs-error"
              >
                {{ strongsError }}
              </p>
              <div
                v-else-if="strongsLoading"
                class="loading"
              >
                Looking up…
              </div>
              <StrongsCard
                v-else-if="strongs"
                :entry="strongs"
                class="strongs-result"
              />
              <p
                v-else
                class="strongs-hint"
              >
                Tap any word in the passage above to open its Greek or Hebrew entry. Needs a
                Strong’s-tagged translation (e.g. KJVA) and the Strong’s modules from the Library.
              </p>
            </div>
          </template>
        </template>
      </section>

      <details
        class="notes-disclosure"
        :open="notesOpen"
        @toggle="notesOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary>
          Notes<template v-if="passageNotes.length">
            · {{ passageNotes.length }}
          </template>
        </summary>
        <div class="note-box">
          <p class="sub">
            {{ noteAnchor }}
          </p>
          <input
            v-model="noteTitle"
            aria-label="Note title"
            class="note-title-input"
            type="text"
            placeholder="Title (optional)"
          >
          <textarea
            ref="noteBodyEl"
            v-model="noteBody"
            aria-label="Note body"
            class="note-input"
            placeholder="Jot a note on this passage…"
          />
          <div class="note-actions">
            <span
              v-if="noteSaved"
              class="note-saved"
            >Saved ✓</span>
            <button
              class="note-save"
              :disabled="!noteBody.trim() || noteSaving"
              @click="saveNote"
            >
              Save note
            </button>
          </div>
          <p
            v-if="noteError"
            class="error"
            role="alert"
          >
            {{ noteError }}
          </p>
          <div
            v-if="passageNotes.length"
            class="note-list"
          >
            <div class="note-list-label">
              On this passage
            </div>
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
      </details>
    </div>

    <TextSelectionActions
      :root="selectionRoot"
      @open="dismiss"
      @word-study="selectionWordStudy"
      @note="selectionNote"
    />
    <PassageActions
      v-if="menuOpen"
      :ref-label="selectionLabel"
      :highlighted="selectionHighlighted"
      :pos="menuPos"
      :cross-references-available="true"
      connections
      cross-references-reason=""
      @word-study="menuWordStudy"
      @compare="menuCompare"
      @commentary="menuCommentary"
      @cross-refs="menuCrossReferences"
      @highlight="menuHighlight"
      @note="menuNote"
    />
  </div>
</template>

<style scoped>
.study {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.topbar {
  min-height: 78px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 22px;
}
.ref {
  font-size: 24px;
  font-weight: 600;
  margin: 2px 0 0;
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
  padding: 20px 28px 48px;
  width: 100%;
  max-width: 960px;
  box-sizing: border-box;
  margin: 0 auto;
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
  font-size: 20px;
  line-height: 1.75;
  margin: 16px 0 28px;
  text-wrap: pretty;
}
.cverse {
  cursor: text;
  border-radius: 3px;
  padding: 1px 2px;
}
.wtap {
  user-select: text;
  -webkit-user-select: text;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.12s;
}
.wtap:hover {
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}
.cvnum {
  padding: 4px 6px;
  border: 0;
  background: none;
  cursor: pointer;
  vertical-align: super;
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
.note-box {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
}
.note-title-input,
.note-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13.5px;
  color: var(--ink);
  font-family: inherit;
}
.note-title-input {
  margin-bottom: 8px;
}
.note-input {
  min-height: 88px;
  line-height: 1.55;
  resize: vertical;
}
.note-title-input:focus,
.note-input:focus {
  outline: none;
  border-color: var(--accent);
}
.note-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 10px;
}
.note-saved {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gold);
}
.note-save {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 8px;
  padding: 9px 18px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.note-save:disabled {
  opacity: 0.5;
  cursor: default;
}
.note-list {
  margin-top: 16px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
.note-list-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8px;
}
.note-list-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 6px 6px;
  text-align: left;
  cursor: pointer;
  color: var(--ink);
}
.note-list-title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-list-date {
  font-size: 11.5px;
  color: var(--muted);
  flex-shrink: 0;
}
.eyebrow { font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted); }
.verse-picker { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--muted); }
.verse-picker label { display: flex; align-items: center; gap: 8px; }
.verse-picker select { padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); font: inherit; }
.verse-picker .sub { margin-left: auto; overflow-wrap: anywhere; min-width: 0; }
.study-tabs { display: flex; border-bottom: 1px solid var(--line); gap: 6px; }
.study-tabs button { flex: 1; min-height: 44px; padding: 12px 8px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 13px; white-space: nowrap; }
.study-tabs button[aria-selected="true"] { border-bottom-color: var(--accent); color: var(--accent); font-weight: 700; }
.tool-panel { padding: 20px 0 0; min-width: 0; }
button:focus-visible, select:focus-visible, summary:focus-visible, .tool-panel:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.notes-disclosure { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 16px; }
.notes-disclosure summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 8px 0; }
.note-box { margin-top: 12px; }
@media (max-width: 768px) {
  .study-tabs { gap: 0; }
  .study-tabs button { padding: 12px 5px; font-size: 12px; }
  .topbar {
    height: auto;
    min-height: 58px;
    flex-wrap: wrap;
    gap: 7px 9px;
    padding: 10px 14px;
  }
  .topbar .back {
    margin-left: auto;
  }
  .step {
    width: 44px;
    height: 44px;
  }
  .scroll {
    min-height: 0;
    padding: 16px 16px 32px;
  }
  .ref { font-size: 21px; }
  .context { font-size: 18px; }
  .verse-picker select { min-height: 44px; }
  .back { font-size: 12px; }
  .cverse {
    padding: 3px 2px;
  }
  .cvnum {
    touch-action: pan-y;
    -webkit-touch-callout: none;
  }
}
</style>
