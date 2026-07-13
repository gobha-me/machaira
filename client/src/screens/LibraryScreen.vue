<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLibrary } from '../stores/library'
import SourceRow from '../components/ui/SourceRow.vue'

const lib = useLibrary()
const showAll = ref(false)

// Everything on the user's machine, pinned to the top of the catalog.
const installedSources = computed(() => [...lib.installedBibles, ...lib.installedDicts])
const availableBibles = computed(() => lib.featuredBibles.length + lib.otherBibles.length)
// When nothing featured remains (all featured already installed), show the rest directly.
const showOthers = computed(() => showAll.value || lib.featuredBibles.length === 0)

onMounted(() => lib.load())
</script>

<template>
  <div class="scroll">
    <div class="wrap">
      <div class="head">
        <h1 class="serif">Library</h1>
        <div class="spacer"></div>
        <button class="add hover-dim" :disabled="lib.loading" @click="lib.load(true)">
          {{ lib.loading ? 'Scanning…' : 'Refresh' }}
        </button>
      </div>
      <div class="subtitle">
        <template v-if="lib.loaded && lib.filterActive">
          {{ lib.resultCount }} source{{ lib.resultCount === 1 ? '' : 's' }} match ·
          {{ lib.installedCount }} installed
        </template>
        <template v-else-if="lib.loaded">
          {{ lib.installedCount }} source{{ lib.installedCount === 1 ? '' : 's' }} on your machine ·
          {{ lib.bibles.length }} translations available from CrossWire
        </template>
        <template v-else>Loading catalog from CrossWire repositories…</template>
      </div>

      <p v-if="lib.error" class="error">{{ lib.error }}</p>

      <div v-if="lib.loaded" class="toolbar">
        <div class="search">
          <span class="search-icon">⌕</span>
          <input
            v-model="lib.query"
            type="search"
            class="search-input"
            placeholder="Search name, language, or description…"
          />
        </div>
        <select v-model="lib.language" class="lang-select">
          <option value="">All languages</option>
          <option v-for="l in lib.languages" :key="l.code" :value="l.code">
            {{ l.label }} ({{ l.count }})
          </option>
        </select>
        <button v-if="lib.filterActive" class="clear hover-dim" @click="lib.clearFilter()">
          Clear
        </button>
      </div>

      <!-- Filtered results: a flat view across the whole catalog -->
      <template v-if="lib.loaded && lib.filterActive">
        <template v-if="lib.filteredBibles.length">
          <div class="section-label">Translations</div>
          <div class="card">
            <SourceRow
              v-for="(m, i) in lib.filteredBibles"
              :key="m.name"
              :module="m"
              :installed="lib.isInstalled(m.name)"
              :installing="lib.installing.has(m.name)"
              :progress="lib.progress[m.name] ?? 0"
              :last="i === lib.filteredBibles.length - 1"
              @install="lib.install"
              @uninstall="lib.uninstall"
            />
          </div>
        </template>
        <template v-if="lib.filteredDicts.length">
          <div class="section-label">Originals &amp; lexicons</div>
          <div class="card">
            <SourceRow
              v-for="(m, i) in lib.filteredDicts"
              :key="m.name"
              :module="m"
              :installed="lib.isInstalled(m.name)"
              :installing="lib.installing.has(m.name)"
              :progress="lib.progress[m.name] ?? 0"
              :last="i === lib.filteredDicts.length - 1"
              @install="lib.install"
              @uninstall="lib.uninstall"
            />
          </div>
        </template>
        <div v-if="lib.resultCount === 0" class="no-results">
          No sources match “{{ lib.query }}”<template v-if="lib.language"> in {{ lib.languages.find((l) => l.code === lib.language)?.label }}</template>.
        </div>
      </template>

      <template v-else-if="lib.loaded">
        <!-- On your machine: everything installed, surfaced first -->
        <template v-if="installedSources.length">
          <div class="section-label">On your machine</div>
          <div class="card">
            <SourceRow
              v-for="(m, i) in installedSources"
              :key="m.name"
              :module="m"
              :installed="true"
              :installing="lib.installing.has(m.name)"
              :progress="lib.progress[m.name] ?? 0"
              :last="i === installedSources.length - 1"
              @install="lib.install"
              @uninstall="lib.uninstall"
            />
          </div>
        </template>

        <!-- Translations (available to add) -->
        <template v-if="availableBibles">
          <div class="section-label">Translations</div>
          <div class="card">
            <SourceRow
              v-for="(m, i) in lib.featuredBibles"
              :key="m.name"
              :module="m"
              :installed="false"
              :installing="lib.installing.has(m.name)"
              :progress="lib.progress[m.name] ?? 0"
              :last="!showOthers && i === lib.featuredBibles.length - 1"
              @install="lib.install"
              @uninstall="lib.uninstall"
            />
            <template v-if="showOthers">
              <SourceRow
                v-for="(m, i) in lib.otherBibles"
                :key="m.name"
                :module="m"
                :installed="false"
                :installing="lib.installing.has(m.name)"
                :progress="lib.progress[m.name] ?? 0"
                :last="i === lib.otherBibles.length - 1"
                @install="lib.install"
                @uninstall="lib.uninstall"
              />
            </template>
          </div>
          <button
            v-if="lib.otherBibles.length && lib.featuredBibles.length"
            class="more hover-accent-text"
            @click="showAll = !showAll"
          >
            {{ showAll ? 'Show fewer' : `Show all ${availableBibles} translations` }}
          </button>
        </template>

        <!-- Originals & lexicons (available to add) -->
        <div class="section-label">Originals &amp; lexicons</div>
        <div class="card">
          <SourceRow
            v-for="(m, i) in lib.lexicons"
            :key="m.name"
            :module="m"
            :installed="false"
            :installing="lib.installing.has(m.name)"
            :progress="lib.progress[m.name] ?? 0"
            :last="i === lib.lexicons.length - 1"
            @install="lib.install"
            @uninstall="lib.uninstall"
          />
          <div v-if="!lib.lexicons.length" class="empty">
            {{ lib.installedDicts.length ? 'All available lexicons are installed.' : 'No lexicon modules offered by the configured repositories.' }}
          </div>
        </div>

        <!-- Honest disabled sections -->
        <div class="section-label">Voices</div>
        <div class="card">
          <div class="note-row">
            <div class="row-main">
              <div class="row-title">Read-aloud voices</div>
              <div class="row-sub">Uses your browser's built-in speech voices — no download needed.</div>
            </div>
            <span class="pending">Built in</span>
          </div>
        </div>

        <div class="section-label">Semantic index</div>
        <div class="card">
          <div class="note-row last">
            <div class="row-main">
              <div class="row-title">Vector search</div>
              <div class="row-sub">Meaning-based ranking needs an embedding index — not built yet.</div>
            </div>
            <span class="pending">Coming soon</span>
          </div>
        </div>
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
  max-width: 760px;
  margin: 0 auto;
  padding: 64px 32px 100px;
}
.head {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 6px;
}
h1 {
  font-weight: 500;
  font-size: 34px;
  margin: 0;
}
.spacer {
  flex: 1;
}
.add {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.add:disabled {
  opacity: 0.6;
  cursor: default;
}
.subtitle {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 20px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 30px;
}
.search {
  position: relative;
  flex: 1;
  min-width: 0;
}
.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted);
  font-size: 15px;
  pointer-events: none;
}
.search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px 10px 32px;
  font-size: 13.5px;
  font-family: inherit;
  color: var(--ink);
}
.search-input:focus {
  outline: none;
  border-color: var(--accent);
}
.search-input::placeholder {
  color: var(--muted);
}
.lang-select {
  flex-shrink: 0;
  max-width: 220px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}
.lang-select:focus {
  outline: none;
  border-color: var(--accent);
}
.clear {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
}
.no-results {
  font-size: 13px;
  color: var(--muted);
  padding: 8px 2px 30px;
}
.error {
  color: var(--accent);
  font-size: 13px;
}
.section-label {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 14px;
}
.more {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
  padding: 0 0 30px;
}
.note-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.note-row.last {
  border-bottom: none;
}
.row-main {
  min-width: 0;
  flex: 1;
}
.row-title {
  font-size: 14px;
  font-weight: 600;
}
.row-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}
.pending {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
}
.empty {
  padding: 16px 18px;
  font-size: 12.5px;
  color: var(--muted);
}
.section-label:not(:first-of-type) {
  margin-top: 16px;
}
</style>
