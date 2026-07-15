<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { useNotes as useNotesStore } from '../stores/notes'
import { useCompare } from '../composables/useCompare'
import { useWordStudy } from '../composables/useWordStudy'
import { useNotes } from '../composables/useNotes'
import { segLead } from '../utils/text'
import PassageActions from '../components/PassageActions.vue'
import StrongsCard from '../components/StrongsCard.vue'

const reader = useReader()
const ui = useUi()
const notesStore = useNotesStore()

const { focus, rows, comparing, compareError, atStart, atEnd, loadCompare, setFocus, stepVerse } =
  useCompare({ keyboard: true })

const {
  strongsKey,
  entry: strongs,
  error: strongsError,
  loading: strongsLoading,
  tapWord
} = useWordStudy()

const {
  title: noteTitle,
  body: noteBody,
  bodyEl: noteBodyEl,
  saved: noteSaved,
  passageNotes,
  save: saveNote,
  openNote,
  focusComposer,
  relDate: noteRelDate
} = useNotes()

const strongsBoxEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  notesStore.load()
  if (!reader.ready) await reader.init()
  focus.value = reader.selectedVerse ?? 1
  await loadCompare()
})

// Tapping a word both focuses its verse (so the comparison follows) and looks it up.
async function studyWord(n: number, keys: string[]) {
  if (focus.value !== n) await setFocus(n)
  await tapWord(keys)
}

// ── Passage action menu: shared PassageActions component, same keystone as Read ──
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

function cverseBg(n: number): string {
  const hl = reader.highlightColor(n)
  if (hl) return hl
  if (reader.selectedVerses.includes(n) || n === focus.value)
    return 'color-mix(in oklab, var(--accent) 12%, transparent)'
  return 'transparent'
}

// Left click: set the compare focus — Study's core deep-dive gesture. Dismiss any menu.
function onContextClick(v: { n: number }) {
  setFocus(v.n)
  menuDismissed.value = true
}

// Right click: open the passage action menu at the pointer. Shift extends the range so
// Highlight/Note act on the whole passage, without moving the compare focus.
function onContextMenu(v: { n: number }, e: MouseEvent) {
  e.preventDefault()
  if (e.shiftKey && reader.selectedVerse != null) reader.extendSelection(v.n)
  else if (reader.selectedVerse !== v.n || reader.hasRange) reader.selectVerse(v.n)
  menuPos.value = { x: e.clientX, y: e.clientY }
  menuDismissed.value = false
}

function menuWordStudy() {
  strongsBoxEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  menuDismissed.value = true
}
function menuCompare() {
  if (reader.selectedVerse != null) setFocus(reader.selectedVerse)
  menuDismissed.value = true
}
function menuHighlight() {
  reader.toggleHighlightRange(reader.selectedVerses)
  menuDismissed.value = true
}
function menuNote() {
  focusComposer()
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
        <div ref="strongsBoxEl" class="strongs-box">
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
            :style="{ background: cverseBg(v.n) }"
            @click="onContextClick(v)"
            @contextmenu="onContextMenu(v, $event)"
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

        <!-- Notes: shared capability, anchored to the focused passage -->
        <div class="section-label">
          Notes<template v-if="reader.currentRef"> · {{ reader.currentRef }}</template>
        </div>
        <div class="note-box">
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
          <div class="note-actions">
            <span v-if="noteSaved" class="note-saved">Saved ✓</span>
            <button class="note-save" :disabled="!noteBody.trim()" @click="saveNote">Save note</button>
          </div>
          <div v-if="passageNotes.length" class="note-list">
            <div class="note-list-label">On this passage</div>
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
