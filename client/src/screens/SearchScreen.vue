<script setup lang="ts">
import { computed, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { isDeuterocanonicalBook } from '@machaira/scripture'
import { useReader } from '../stores/reader'
import { useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import { useNotes } from '../stores/notes'
import { useSemanticIndex } from '../stores/semanticIndex'
import { api, ApiError, type Note, type SearchHit, type SearchScope } from '../services/api'
import ModalDialog from '../components/ui/ModalDialog.vue'
import VoiceInputButton from '../components/VoiceInputButton.vue'

const reader = useReader()
const lib = useLibrary()
const ui = useUi()
const notes = useNotes()
const semantic = useSemanticIndex()

const SCOPES = ['Everything', 'Scripture', 'Apocrypha', 'Ancient writings', 'Notes & journal'] as const
type Scope = (typeof SCOPES)[number]
type SearchMode = 'exact' | 'meaning'

const q = ref('')
const scope = ref<Scope>('Everything')
const mode = ref<SearchMode>('exact')
const searched = ref(false)
const loading = ref(false)
const retrying = ref(false)
const hits = ref<SearchHit[]>([])
const noteHits = ref<Note[]>([])
const error = ref<string | null>(null)
const selectedGeneral = ref<SearchHit | null>(null)
let generation = 0
let cancelBackoff: (() => void) | undefined

function invalidate(): void {
  generation += 1
  cancelBackoff?.()
  loading.value = false
  retrying.value = false
  hits.value = []
  noteHits.value = []
  error.value = null
  selectedGeneral.value = null
}

watch(q, () => {
  invalidate()
  searched.value = false
}, { flush: 'sync' })
watch([scope, mode], invalidate, { flush: 'sync' })
onUnmounted(invalidate)
// Search is cached by the router. Its modal must release the background on navigation
// while the query, results, and any pending search remain available for Back.
onDeactivated(() => { selectedGeneral.value = null })

onMounted(() => {
  void Promise.all([lib.load(), semantic.load()]).catch(() => undefined)
})

const installedNames = computed(() => (
  scope.value === 'Ancient writings' ? lib.installedGeneralBooks
    : scope.value === 'Scripture' || scope.value === 'Apocrypha' ? lib.installedBibles
      : [...lib.installedBibles, ...lib.installedGeneralBooks]
).map((m) => m.name))

const scriptureHits = computed(() => {
  if (scope.value === 'Scripture') return hits.value.filter((h) => h.kind === 'scripture')
  if (scope.value === 'Apocrypha') return hits.value.filter((h) => h.kind === 'scripture' && isDeuterocanonicalBook(h.book))
  if (scope.value === 'Ancient writings') return hits.value.filter((h) => h.kind === 'general-book')
  return hits.value
})

const showScripture = computed(() => scope.value !== 'Notes & journal')
const showNotes = computed(() => scope.value === 'Everything' || scope.value === 'Notes & journal')

function temporarilyUnavailable(error: unknown): boolean {
  // Browser fetch rejects network failures with TypeError; HTTP errors retain their status.
  return error instanceof ApiError ? [502, 503, 504].includes(error.status) : error instanceof TypeError
}

function backoff(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      cancelBackoff = undefined
      resolve()
    }
    const timer = setTimeout(finish, 750)
    cancelBackoff = finish
  })
}

async function run() {
  const query = q.value.trim()
  invalidate()
  if (!query) { searched.value = false; return }
  const activeGeneration = generation
  const requestedMode = mode.value
  const requestedScope = scope.value
  const corpusScope: SearchScope = requestedScope === 'Ancient writings' ? 'ancient-writings'
    : requestedScope === 'Apocrypha' ? 'apocrypha' : requestedScope === 'Scripture' ? 'scripture' : 'all'
  const modules = [...installedNames.value]
  loading.value = true
  error.value = null
  searched.value = true
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const [corpusResults, notesResults] = await Promise.all([
          requestedScope !== 'Notes & journal' && modules.length
            ? requestedMode === 'meaning' ? api.semanticSearch(query, modules, 50, corpusScope)
              : api.search(query, modules, corpusScope)
            : Promise.resolve([]),
          requestedScope === 'Everything' || requestedScope === 'Notes & journal' ? searchNotes(query) : Promise.resolve([])
        ])
        if (activeGeneration !== generation) return
        hits.value = corpusResults
        noteHits.value = notesResults
        return
      } catch (e) {
        if (activeGeneration !== generation) return
        if (attempt > 0 || !temporarilyUnavailable(e)) throw e
        retrying.value = true
        await backoff()
        if (activeGeneration !== generation) return
      }
    }
  } catch (e) {
    if (activeGeneration !== generation) return
    const message = e instanceof Error ? e.message.trim() : ''
    error.value = temporarilyUnavailable(e)
      ? 'The server is temporarily unavailable. Please try again.'
      : message
        ? `Search failed: ${message}${/[.!?]$/.test(message) ? '' : '.'} Please try again.`
        : 'Search failed. Please try again.'
    if (requestedMode === 'meaning') void semantic.load().catch(() => undefined)
  } finally {
    if (activeGeneration === generation) {
      loading.value = false
      retrying.value = false
    }
  }
}

async function searchNotes(query: string): Promise<Note[]> {
  const all = notes.list
  const needle = query.toLowerCase()
  return all.filter(
    (n) =>
      n.title.toLowerCase().includes(needle) ||
      n.body.toLowerCase().includes(needle) ||
      n.tags.some((t) => t.toLowerCase().includes(needle))
  )
}

function openNote(id: string) {
  notes.select(id)
  ui.go('journal')
}

function openHit(h: SearchHit) {
  if (h.kind === 'general-book') {
    selectedGeneral.value = h
    return
  }
  reader.openRef(h.module, h.book, h.chapter, h.verse)
  ui.go('read')
}

function selectScope(next: Scope): void {
  scope.value = next
  if (next === 'Notes & journal') mode.value = 'exact'
  if (searched.value) void run()
}

function highlight(text: string): string {
  const query = q.value.trim()
  if (!query) return escapeHtml(text)
  const terms = query.split(/\s+/).filter(Boolean).map(escapeReg)
  const re = new RegExp(`(${terms.join('|')})`, 'gi')
  return escapeHtml(text).replace(re, '<mark>$1</mark>')
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
}
function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const resultCount = computed(() => scriptureHits.value.length + (showNotes.value ? noteHits.value.length : 0))
</script>

<template>
  <div class="scroll">
    <div class="wrap">
      <h1 class="serif">Search your library</h1>
      <div class="subtitle">
        Search installed scripture and ancient writings by exact text or meaning. Notes and journal entries use exact text.
      </div>

      <div class="query-row">
        <input
          v-model="q"
          class="query serif focus-accent"
          aria-label="Search words or phrases"
          placeholder="Search words or phrases…"
          @keydown.enter="run"
        />
        <VoiceInputButton v-model="q" label="search query" />
      </div>

      <div class="modes" role="group" aria-label="Search mode">
        <button
          class="mode"
          :class="{ active: mode === 'exact' }"
          :aria-pressed="mode === 'exact'"
          @click="mode = 'exact'; searched && run()"
        >Exact words</button>
        <button
          class="mode"
          :class="{ active: mode === 'meaning' }"
          :aria-pressed="mode === 'meaning'"
          :disabled="!semantic.searchable || scope === 'Notes & journal'"
          :title="scope === 'Notes & journal'
            ? 'Notes use exact-text search'
            : semantic.searchable ? 'Rank scripture by semantic similarity' : semantic.statusText"
          @click="mode = 'meaning'; searched && run()"
        >By meaning</button>
      </div>

      <div v-if="!semantic.searchable || semantic.status.lastError || semantic.error" class="status" role="status">
        <div v-if="!semantic.searchable">Semantic index: {{ semantic.status.state }} · {{ semantic.statusText }}</div>
        <div v-else-if="semantic.status.lastError">The last rebuild failed; meaning search still uses the old index.</div>
        <div v-if="semantic.status.lastError">Last rebuild error: {{ semantic.status.lastError }}</div>
        <div v-if="semantic.error">{{ semantic.error }}</div>
        <div>Exact-word search does not use the semantic index.</div>
        <button class="mode" type="button" @click="ui.openSemanticSettings()">Settings → Semantic search</button>
      </div>

      <div class="scopes" role="group" aria-label="Search scope">
        <button
          v-for="s in SCOPES"
          :key="s"
          class="scope"
          :aria-pressed="scope === s"
          :style="{
            background: scope === s ? 'var(--accent)' : 'var(--card)',
            color: scope === s ? 'var(--on-accent)' : 'var(--muted)',
            borderColor: scope === s ? 'var(--accent)' : 'var(--line)'
          }"
          @click="selectScope(s)"
        >{{ s }}</button>
      </div>

      <template v-if="loading">
        <div class="status" role="status">{{ retrying ? 'The server is temporarily unavailable. Retrying…' : 'Searching…' }}</div>
      </template>

      <div v-else-if="error" class="error" role="alert">
        <p>{{ error }}</p>
        <button class="mode" type="button" @click="run">Retry</button>
      </div>

      <template v-else-if="searched">
        <div class="count" aria-live="polite">
          Showing {{ resultCount }} result{{ resultCount === 1 ? '' : 's' }}
          <template v-if="showScripture && installedNames.length"> · {{ mode === 'meaning' ? 'top 50 corpus matches' : 'up to 50 matches per Scripture module; 200 per ancient writing' }}</template>
          <template v-if="showScripture && !installedNames.length"> · install a translation to search scripture</template>
        </div>

        <div class="results">
          <button
            type="button"
            v-for="(h, i) in scriptureHits"
            :key="'s' + i"
            class="result hover-line"
            @click="openHit(h)"
          >
            <span class="result-head">
              <span class="rref">{{ h.kind === 'scripture' ? `${h.bookName} ${h.chapter}:${h.verse}` : h.title }}</span>
              <span class="badge">{{ h.module }}</span>
            </span>
            <span
              class="rtext serif"
              v-html="mode === 'exact' ? highlight(h.content) : escapeHtml(h.content)"
            ></span>
          </button>

          <button
            type="button"
            v-for="n in (showNotes ? noteHits : [])"
            :key="n.id"
            class="result note-result hover-line"
            @click="openNote(n.id)"
          >
            <span class="result-head">
              <span class="rref">{{ n.title }}</span>
              <span class="badge">Your journal</span>
            </span>
            <span class="rtext-note" v-html="highlight(n.body.slice(0, 200))"></span>
          </button>

          <div v-if="resultCount === 0" class="status">
            No matches for “{{ q }}”. Try different words, or broaden the scope.
          </div>
        </div>
      </template>

      <div v-else class="status hint">Type a word or phrase and press Enter.</div>

      <ModalDialog v-if="selectedGeneral?.kind === 'general-book'" labelledby="search-entry-title" @close="selectedGeneral = null">
        <article class="entry-dialog">
          <button aria-label="Close" @click="selectedGeneral = null">×</button>
          <div class="badge">{{ selectedGeneral.module }}</div>
          <h2 id="search-entry-title" class="serif">{{ selectedGeneral.title }}</h2>
          <p class="entry-key">{{ selectedGeneral.key }}</p>
          <div class="entry-text serif">{{ selectedGeneral.content }}</div>
        </article>
      </ModalDialog>
    </div>
  </div>
</template>

<style scoped>
.scroll {
  flex: 1;
  overflow-y: auto;
}
.wrap {
  max-width: 720px;
  margin: 0 auto;
  padding: 64px 32px 100px;
}
h1 {
  font-weight: 500;
  font-size: 34px;
  margin: 0 0 6px;
}
.subtitle {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 26px;
}
.query {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  background: var(--card);
  border: 1.5px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
  font-size: 17px;
  color: var(--ink);
  outline: none;
}
.query-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.query-row :deep(.voice-button) {
  width: 52px;
  height: 52px;
  border-radius: 12px;
}
.modes {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.mode {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 7px 12px;
  background: var(--card);
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.mode.active {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.mode:disabled {
  cursor: default;
  opacity: 0.5;
}
.mode-note {
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scopes {
  display: flex;
  gap: 8px;
  margin: 14px 0 30px;
  flex-wrap: wrap;
}
.scope {
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.count {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 12px;
}
.results {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.result {
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 16px 18px;
  cursor: pointer;
}
.entry-dialog{position:relative;width:min(700px,92vw);max-height:82vh;box-sizing:border-box;overflow:auto;padding:28px;border-radius:14px;background:var(--paper);box-shadow:0 20px 60px #0004}.entry-dialog>button{position:absolute;right:16px;top:12px;border:0;background:none;color:var(--muted);font-size:26px;cursor:pointer}.entry-dialog h2{margin:14px 0 3px}.entry-key{color:var(--muted);font-size:11px}.entry-text{white-space:pre-wrap;font-size:16px;line-height:1.7}
.note-result {
  border-left: 3px solid var(--gold);
}
.result-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.rref {
  font-size: 14px;
  font-weight: 700;
}
.badge {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 2px 7px;
}
.rtext {
  font-size: 15.5px;
  line-height: 1.6;
}
.rtext-note {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink);
}
.rtext :deep(mark),
.rtext-note :deep(mark) {
  background: rgba(201, 162, 39, 0.28);
  border-radius: 2px;
  padding: 0 2px;
  color: inherit;
}
.status {
  font-size: 13px;
  color: var(--muted);
  padding: 8px 0;
}
.hint {
  padding-top: 4px;
}
.error {
  font-size: 13px;
  color: var(--accent);
}
@media (max-width: 768px) {
  .wrap {
    padding: 36px 16px 80px;
  }
  .modes {
    flex-wrap: wrap;
  }
  .mode-note {
    flex-basis: 100%;
    white-space: normal;
  }
}
</style>
