<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useAiProvider } from '../stores/aiProvider'
import { api, type ChatMessage } from '../services/api'
import { useCompare } from '../composables/useCompare'
import { useWordStudy } from '../composables/useWordStudy'
import { useNotes } from '../composables/useNotes'
import { usePassageMenu } from '../composables/usePassageMenu'
import { segLead } from '../utils/text'
import PassageActions from '../components/PassageActions.vue'
import StrongsCard from '../components/StrongsCard.vue'
import CommentaryPanel from '../components/CommentaryPanel.vue'
import ComparePanel from '../components/ComparePanel.vue'
import CrossReferencesPanel from '../components/CrossReferencesPanel.vue'
import VoiceInputButton from '../components/VoiceInputButton.vue'

const reader = useReader()
const ui = useUi()
const settings = useSettings()
const aiProvider = useAiProvider()

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
  stepVerse
} = useCompare({ keyboard: true, followSelection: true })

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

const compareBoxEl = ref<HTMLElement | null>(null)
const strongsBoxEl = ref<HTMLElement | null>(null)
const commentaryBoxEl = ref<HTMLElement | null>(null)
const crossReferencesBoxEl = ref<HTMLElement | null>(null)
const partnerBodyEl = ref<HTMLElement | null>(null)
const chatDraft = ref('')
const chatMessages = ref<ChatMessage[]>([])
const chatError = ref<string | null>(null)
const sending = ref(false)
let chatAbort: AbortController | null = null

const passageContext = computed(() => {
  const verses = (reader.data?.verses ?? [])
    .filter((verse) => verse.n >= focus.value && verse.n <= focusEnd.value)
  return {
    reference: `${reader.bookName} ${reader.chapter}:${focusLabel.value}`,
    module: reader.moduleName ?? '',
    content: verses.map((verse) => `${verse.n}. ${verse.text}`).join('\n')
  }
})

onMounted(async () => {
  if (!reader.ready) await reader.init()
  if (!aiProvider.ready) await aiProvider.load().catch(() => undefined)
  syncFromSelection()
})
onBeforeUnmount(() => chatAbort?.abort())

async function scrollChat(): Promise<void> {
  await nextTick()
  if (partnerBodyEl.value) partnerBodyEl.value.scrollTop = partnerBodyEl.value.scrollHeight
}

async function sendChat(): Promise<void> {
  const content = chatDraft.value.trim()
  if (!content || sending.value || !aiProvider.provider || !passageContext.value.content) return
  chatDraft.value = ''
  chatError.value = null
  chatMessages.value.push({ role: 'user', content })
  // Keep an odd number so the retained window begins and ends with a user turn.
  const requestMessages = chatMessages.value.slice(-19).map((message) => ({ ...message }))
  const response: ChatMessage = { role: 'assistant', content: '' }
  let receivedText = false
  chatMessages.value.push(response)
  sending.value = true
  chatAbort = new AbortController()
  await scrollChat()
  try {
    await api.streamChat({
      passage: passageContext.value,
      messages: requestMessages,
      preferences: {
        alwaysCite: settings.alwaysCite,
        drawApocrypha: settings.drawApocrypha
      }
    }, (delta) => {
      const activeResponse = chatMessages.value.at(-1)
      if (activeResponse?.role === 'assistant') {
        activeResponse.content += delta
        receivedText = true
      }
      void scrollChat()
    }, chatAbort.signal)
  } catch (error) {
    if ((error as Error).name !== 'AbortError') chatError.value = (error as Error).message
    if (!receivedText) chatMessages.value.pop()
  } finally {
    sending.value = false
    chatAbort = null
    await scrollChat()
  }
}

function cancelChat(): void {
  chatAbort?.abort()
}

function clearChat(): void {
  if (sending.value) return
  chatMessages.value = []
  chatError.value = null
}

async function retryChat(): Promise<void> {
  if (sending.value) return
  const lastUser = chatMessages.value.map((message) => message.role).lastIndexOf('user')
  if (lastUser < 0) return
  const content = chatMessages.value[lastUser].content
  chatMessages.value.splice(lastUser)
  chatDraft.value = content
  await sendChat()
}

// Tapping a word brings its verse forward (compare follows the selection) and looks it up.
// Selecting only when the verse sits outside the current selection avoids selectVerse's
// toggle-off branch and leaves a multi-verse range intact.
async function studyWord(n: number, keys: string[]) {
  if (!reader.selectedVerses.includes(n)) reader.selectVerse(n)
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
  selectionCrossReferences,
  crossReferencesAvailable,
  crossReferencesReason,
  verseOpacity,
  verseBg,
  onVerseClick,
  onVerseContext,
  onVerseMouseDown,
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

// Study's cards all live in the one scrolling column, so its menu actions reveal rather than
// open — compare is already in step with the selection by the time the menu is up.
function menuWordStudy() {
  strongsBoxEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  dismiss()
}
function menuCompare() {
  compareBoxEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  dismiss()
}
function menuCommentary() {
  commentaryBoxEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  dismiss()
}
function menuCrossReferences() {
  crossReferencesBoxEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  dismiss()
}
function menuHighlight() {
  reader.toggleHighlightRange(reader.selectedVerses)
  dismiss()
}
function menuNote() {
  focusComposer()
  dismiss()
}
</script>

<template>
  <div class="study">
    <!-- left: compare + word study -->
    <div class="left">
      <div class="topbar">
        <span class="ref">{{ reader.bookName }} {{ reader.chapter }}:{{ focusLabel }}</span>
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
        <div ref="compareBoxEl">
          <ComparePanel
            variant="page"
            :rows="rows"
            :comparing="comparing"
            :error="compareError"
          />
        </div>

        <!-- Commentary (verse-by-verse notes from an installed commentary module) -->
        <div ref="commentaryBoxEl">
          <div class="section-label">Commentary</div>
          <CommentaryPanel variant="page" />
        </div>

        <!-- Cross-references (real embedded notes from the active translation) -->
        <div ref="crossReferencesBoxEl">
          <div class="section-label">Cross-references</div>
          <CrossReferencesPanel
            variant="page"
            :entries="selectionCrossReferences"
            :module-name="reader.moduleName ?? ''"
            :ref-label="selectionLabel"
            :empty-reason="crossReferencesReason"
          />
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
            :style="{ background: cverseBg(v.n), opacity: verseOpacity(v.n) }"
            @mousedown="onVerseMouseDown"
            @click="onVerseClick(v.n, $event)"
            @contextmenu="onVerseContext(v.n, $event)"
          ><sup class="cvnum">{{ v.n }}</sup><template
              v-for="(seg, i) in v.segments"
              :key="i"
            ><template v-if="seg.kind === 'word'"
            >{{ segLead(seg.text, i) }}<span
                class="wtap"
                @click.stop="onWordClick(v.n, seg.strongs, $event)"
              >{{ seg.text }}</span></template><template
              v-else-if="seg.kind === 'note'"
            ></template><template v-else
            >{{ segLead(seg.text, i) + seg.text }}</template></template>{{ ' ' }}</span>
        </div>
        <p v-if="reader.highlightError" class="error">{{ reader.highlightError }}</p>

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

    <!-- right: study partner -->
    <div class="partner">
      <div class="topbar">
        <div class="mark"></div>
        <span class="ptitle">Study partner</span>
        <div class="spacer"></div>
        <button v-if="chatMessages.length" class="clear-chat" :disabled="sending" @click="clearChat">Clear</button>
        <span class="sub">{{ aiProvider.provider?.model ?? 'not connected' }}</span>
      </div>
      <div ref="partnerBodyEl" class="partner-body" :class="{ chatting: chatMessages.length }">
        <div v-if="aiProvider.loading && !aiProvider.ready" class="disabled-note">
          <div class="dn-title serif">Connecting…</div>
        </div>
        <div v-else-if="!aiProvider.provider" class="disabled-note">
          <div class="dn-title serif">Bring your own model</div>
          <p>
            The study partner talks to an LLM — any OpenAI-compatible endpoint, Claude, or a local
            model. Connect a provider in Settings to enable chat about this passage.
          </p>
          <button class="dn-btn" @click="ui.go('settings')">Open Settings →</button>
        </div>
        <div v-else-if="!chatMessages.length" class="disabled-note">
          <div class="dn-title serif">Ask about this passage</div>
          <p :title="`${passageContext.reference} · ${passageContext.module}`">
            {{ passageContext.reference }} from {{ passageContext.module }} is included as context.
            Conversation history stays in this browser tab only.
          </p>
        </div>
        <div v-else class="messages" aria-live="polite">
          <div
            class="context-chip"
            :title="`Context · ${passageContext.reference} · ${passageContext.module}`"
          >Context · {{ passageContext.reference }} · {{ passageContext.module }}</div>
          <div v-for="(message, index) in chatMessages" :key="index" class="message" :class="message.role">
            <div class="message-role">{{ message.role === 'user' ? 'You' : 'Study partner' }}</div>
            <div class="message-content">{{ message.content }}<span v-if="sending && index === chatMessages.length - 1" class="stream-cursor"></span></div>
          </div>
          <div v-if="chatError" class="chat-error">
            <span>{{ chatError }}</span>
            <button @click="retryChat">Retry</button>
          </div>
        </div>
      </div>
      <form class="composer" @submit.prevent="sendChat">
        <input
          v-model="chatDraft"
          :disabled="!aiProvider.provider || sending"
          :placeholder="aiProvider.provider ? `Ask about ${passageContext.reference}` : 'Connect a provider in Settings to chat'"
        />
        <VoiceInputButton
          v-model="chatDraft"
          label="study question"
          :disabled="!aiProvider.provider || sending"
        />
        <button v-if="sending" type="button" class="send cancel" title="Stop response" @click="cancelChat">■</button>
        <button v-else type="submit" class="send" :disabled="!aiProvider.provider || !chatDraft.trim() || !passageContext.content">→</button>
      </form>
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
.partner-body.chatting {
  display: block;
  padding: 18px 16px 28px;
}
.clear-chat {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
}
.clear-chat:disabled { opacity: 0.45; cursor: default; }
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
  overflow-wrap: anywhere;
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
.messages { display: flex; flex-direction: column; gap: 16px; }
.context-chip {
  align-self: center;
  max-width: 100%;
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.message { max-width: 92%; }
.message.user {
  align-self: flex-end;
  background: var(--soft);
  border-radius: 12px 12px 3px 12px;
  padding: 10px 12px;
}
.message.assistant { align-self: flex-start; }
.message-role {
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.message-content {
  color: var(--ink);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.stream-cursor {
  display: inline-block;
  width: 6px;
  height: 12px;
  margin-left: 2px;
  background: var(--accent);
  animation: pulse 0.8s ease-in-out infinite alternate;
}
.chat-error {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent);
  font-size: 12px;
}
.chat-error button {
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 4px 8px;
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
  cursor: pointer;
}
.send.cancel { font-size: 11px; }
.send:disabled { opacity: 0.5; }
.composer input:disabled,
.send:disabled {
  cursor: not-allowed;
}
</style>
