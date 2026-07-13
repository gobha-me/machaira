<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useReader } from '../stores/reader'
import { useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import { api, type SearchHit } from '../services/api'
import { notesDb, type Note } from '../services/db'

const reader = useReader()
const lib = useLibrary()
const ui = useUi()

const SCOPES = ['Everything', 'Scripture', 'Apocrypha', 'Notes & journal'] as const
type Scope = (typeof SCOPES)[number]

// Deuterocanon/apocrypha OSIS codes (mirrors the server's book table) for scope filtering.
const APOCRYPHA = new Set([
  'Tob', 'Jdt', 'AddEsth', 'Wis', 'Sir', 'Bar', 'EpJer', 'PrAzar', 'Sus', 'Bel',
  '1Macc', '2Macc', '1Esd', '2Esd', 'PrMan', 'Ps151', '3Macc', '4Macc'
])

const q = ref('')
const scope = ref<Scope>('Everything')
const searched = ref(false)
const loading = ref(false)
const hits = ref<SearchHit[]>([])
const noteHits = ref<Note[]>([])
const error = ref<string | null>(null)

onMounted(() => lib.load())

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
      tasks.push(api.search(query, installedNames.value).then((r) => { hits.value = r }))
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
  } finally {
    loading.value = false
  }
}

async function searchNotes(query: string): Promise<Note[]> {
  const all = await notesDb.all()
  const needle = query.toLowerCase()
  return all.filter(
    (n) =>
      n.title.toLowerCase().includes(needle) ||
      n.body.toLowerCase().includes(needle) ||
      n.tags.some((t) => t.toLowerCase().includes(needle))
  )
}

function openHit(h: SearchHit) {
  reader.openRef(h.module, h.book, h.chapter, h.verse)
  ui.go('read')
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
        Full-text search across your installed modules and notes. Meaning-based ranking is coming
        with the semantic index.
      </div>

      <input
        v-model="q"
        class="query serif focus-accent"
        placeholder="Search words or phrases…"
        @keydown.enter="run"
      />

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
          @click="scope = s; searched && run()"
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
            <div class="rtext serif" v-html="highlight(h.content)"></div>
          </div>

          <div
            v-for="n in (showNotes ? noteHits : [])"
            :key="n.id"
            class="result note-result hover-line"
            @click="ui.go('journal')"
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
  width: 100%;
  box-sizing: border-box;
  background: var(--card);
  border: 1.5px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
  font-size: 17px;
  color: var(--ink);
  outline: none;
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
</style>
