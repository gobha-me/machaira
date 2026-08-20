<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useReader } from '../stores/reader'
import { useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import { useNotes } from '../stores/notes'
import { useSemanticIndex } from '../stores/semanticIndex'
import { api, type Note, type SearchHit } from '../services/api'
import VoiceInputButton from '../components/VoiceInputButton.vue'

const reader = useReader()
const lib = useLibrary()
const ui = useUi()
const notes = useNotes()
const semantic = useSemanticIndex()

const SCOPES = ['Everything', 'Scripture', 'Apocrypha', 'Notes & journal'] as const
type Scope = (typeof SCOPES)[number]
type SearchMode = 'exact' | 'meaning'

// Deuterocanon/apocrypha OSIS codes (mirrors the server's book table) for scope filtering.
const APOCRYPHA = new Set([
  'Tob', 'Jdt', 'AddEsth', 'Wis', 'Sir', 'Bar', 'EpJer', 'PrAzar', 'Sus', 'Bel',
  '1Macc', '2Macc', '1Esd', '2Esd', 'PrMan', 'Ps151', '3Macc', '4Macc'
])

const q = ref('')
const scope = ref<Scope>('Everything')
const mode = ref<SearchMode>('exact')
const searched = ref(false)
const loading = ref(false)
const hits = ref<SearchHit[]>([])
const noteHits = ref<Note[]>([])
const error = ref<string | null>(null)

onMounted(() => {
  void Promise.all([lib.load(), semantic.load()]).catch(() => undefined)
})

const installedNames = computed(() => lib.installedBibles.map((m) => m.name))

const scriptureHits = computed(() => {
  if (scope.value === 'Apocrypha') return hits.value.filter((h) => APOCRYPHA.has(h.book))
  return hits.value
})

const showScripture = computed(() => scope.value !== 'Notes & journal')
const showNotes = computed(() => scope.value === 'Everything' || scope.value === 'Notes & journal')

async function run() {
  const query = q.value.trim()
  if (!query) return
  loading.value = true
  error.value = null
  searched.value = true
  try {
    const tasks: Promise<void>[] = []
    if (showScripture.value && installedNames.value.length) {
      const scriptureSearch = mode.value === 'meaning'
        ? api.semanticSearch(query, installedNames.value)
        : api.search(query, installedNames.value)
      tasks.push(scriptureSearch.then((r) => { hits.value = r }))
    } else {
      hits.value = []
    }
    if (showNotes.value) {
      tasks.push(searchNotes(query).then((r) => { noteHits.value = r }))
    } else {
      noteHits.value = []
    }
    await Promise.all(tasks)
  } catch (e) {
    error.value = (e as Error).message
    if (mode.value === 'meaning') void semantic.load().catch(() => undefined)
  } finally {
    loading.value = false
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
        Search installed scripture by exact text or meaning. Notes and journal entries use exact text.
      </div>

      <div class="query-row">
        <input
          v-model="q"
          class="query serif focus-accent"
          placeholder="Search words or phrases…"
          @keydown.enter="run"
        />
        <VoiceInputButton v-model="q" label="search query" />
      </div>

      <div class="modes" role="group" aria-label="Search mode">
        <button
          class="mode"
          :class="{ active: mode === 'exact' }"
          @click="mode = 'exact'; searched && run()"
        >Exact words</button>
        <button
          class="mode"
          :class="{ active: mode === 'meaning' }"
          :disabled="!semantic.searchable || scope === 'Notes & journal'"
          :title="scope === 'Notes & journal'
            ? 'Notes use exact-text search'
            : semantic.searchable ? 'Rank scripture by semantic similarity' : semantic.statusText"
          @click="mode = 'meaning'; searched && run()"
        >By meaning</button>
        <span v-if="!semantic.searchable" class="mode-note">{{ semantic.statusText }}</span>
      </div>

      <div class="scopes">
        <button
          v-for="s in SCOPES"
          :key="s"
          class="scope"
          :style="{
            background: scope === s ? 'var(--accent)' : 'var(--card)',
            color: scope === s ? 'var(--on-accent)' : 'var(--muted)',
            borderColor: scope === s ? 'var(--accent)' : 'var(--line)'
          }"
          @click="selectScope(s)"
        >{{ s }}</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <template v-if="loading">
        <div class="status">Searching…</div>
      </template>

      <template v-else-if="searched">
        <div class="count">
          {{ resultCount }} result{{ resultCount === 1 ? '' : 's' }}
          <template v-if="showScripture && !installedNames.length"> · install a translation to search scripture</template>
        </div>

        <div class="results">
          <div
            v-for="(h, i) in scriptureHits"
            :key="'s' + i"
            class="result hover-line"
            @click="openHit(h)"
          >
            <div class="result-head">
              <span class="rref">{{ h.bookName }} {{ h.chapter }}:{{ h.verse }}</span>
              <span class="badge">{{ h.module }}</span>
            </div>
            <div
              class="rtext serif"
              v-html="mode === 'exact' ? highlight(h.content) : escapeHtml(h.content)"
            ></div>
          </div>

          <div
            v-for="n in (showNotes ? noteHits : [])"
            :key="n.id"
            class="result note-result hover-line"
            @click="openNote(n.id)"
          >
            <div class="result-head">
              <span class="rref">{{ n.title }}</span>
              <span class="badge">Your journal</span>
            </div>
            <div class="rtext-note" v-html="highlight(n.body.slice(0, 200))"></div>
          </div>

          <div v-if="resultCount === 0" class="status">
            No matches for “{{ q }}”. Try different words, or broaden the scope.
          </div>
        </div>
      </template>

      <template v-else>
        <div class="status hint">Type a word or phrase and press Enter.</div>
      </template>
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
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 16px 18px;
  cursor: pointer;
}
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
