<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLibrary, type LibraryCategory } from '../stores/library'
import { useAuth } from '../stores/auth'
import type { ModuleInfo } from '../services/api'
import SourceRow from '../components/ui/SourceRow.vue'

const library = useLibrary()
const auth = useAuth()
const selected = ref<ModuleInfo | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const healthOpen = ref(false)
const importMessage = ref('')

const categories: Array<{ key: LibraryCategory; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'installed', label: 'Installed' },
  { key: 'scripture', label: 'Bibles' }, { key: 'deuterocanon', label: 'Deuterocanon' },
  { key: 'ancient-writings', label: 'Ancient writings' },
  { key: 'commentary', label: 'Commentaries' }, { key: 'lexicon', label: 'Lexicons' }
]

const canonModules = computed(() => library.modules.filter((module) => module.collection === 'deuterocanon'))

onMounted(() => { void library.load() })

async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importMessage.value = ''
  try {
    const names = await library.importSword(file)
    importMessage.value = `Imported ${names.join(', ')}`
  } catch { /* store displays the actionable error */ }
  input.value = ''
}

async function toggleAi(module: ModuleInfo, enabled: boolean): Promise<void> {
  if (enabled && module.aiEligibility === 'review-required') {
    const accepted = window.confirm(`Allow ${module.name} to be sent to your configured embedding provider? Review its license first: ${module.distributionLicense || 'license not specified'}.`)
    if (!accepted) return
  }
  await library.setAiEnabled(module, enabled)
}
</script>

<template>
  <div class="scroll">
    <main class="wrap">
      <header class="header">
        <div>
          <p class="eyebrow">Source library</p>
          <h1 class="serif">Build your study corpus</h1>
          <p class="intro">Install legally distributed SWORD texts for reading, search, and—when you allow it—local or hosted language tools.</p>
        </div>
        <div class="header-actions">
          <button v-if="auth.isAdmin" class="secondary" @click="fileInput?.click()">Import SWORD ZIP</button>
          <input ref="fileInput" hidden type="file" accept=".zip,application/zip" @change="importFile" />
          <button class="primary" :disabled="library.loading" @click="library.load(true)">{{ library.loading ? 'Refreshing…' : 'Refresh sources' }}</button>
        </div>
      </header>

      <button class="health" :class="{ warning: library.repositoryProblems.length }" @click="healthOpen = !healthOpen">
        <span class="dot"></span>
        <span>{{ library.repositoryProblems.length ? `${library.repositoryProblems.length} source refresh failed; cached catalog in use` : `${library.diagnostics.length} repositories · ${library.modules.length.toLocaleString()} sources` }}</span>
        <span class="chevron">{{ healthOpen ? '−' : '+' }}</span>
      </button>
      <div v-if="healthOpen" class="health-detail">
        <div v-for="repo in library.diagnostics" :key="repo.name">
          <strong>{{ repo.name }}</strong><span>{{ repo.moduleCount.toLocaleString() }} modules · {{ repo.status }}</span>
        </div>
      </div>

      <p v-if="library.error" class="error">{{ library.error }}</p>
      <p v-if="importMessage" class="success">{{ importMessage }}</p>

      <section v-if="library.loaded" class="canon-callout">
        <div>
          <p class="eyebrow">Canon collection</p>
          <h2 class="serif">Beyond a single table of contents</h2>
          <p>Compare editions with Deuterocanon and discover legally distributed ancient writings such as Enoch or Jubilees. Coverage is shown per exact module version—never inferred from a title.</p>
        </div>
        <button @click="library.category = 'deuterocanon'">Explore {{ canonModules.length }} sources</button>
      </section>

      <section v-if="library.loaded" class="controls">
        <div class="search"><span>⌕</span><input v-model="library.query" type="search" placeholder="Search title, language, repository, license, or book…" /></div>
        <select v-model="library.language"><option value="">All languages</option><option v-for="language in library.languages" :key="language.code" :value="language.code">{{ language.label }} ({{ language.count }})</option></select>
      </section>
      <nav v-if="library.loaded" class="categories" aria-label="Library categories">
        <button v-for="category in categories" :key="category.key" :class="{ active: library.category === category.key }" @click="library.category = category.key">{{ category.label }}</button>
      </nav>

      <div v-if="!library.loaded && library.loading" class="empty">Loading the official SWORD catalogs…</div>
      <template v-else-if="library.loaded">
        <div class="result-head"><span>{{ library.filteredModules.length.toLocaleString() }} sources</span><span>{{ library.installedCount }} installed</span></div>
        <div class="grid">
          <SourceRow v-for="module in library.filteredModules" :key="module.id" :module="module" :installing="library.installing.has(module.id)" :progress="library.progress[module.id] ?? 0" @install="library.install" @uninstall="library.uninstall" @details="selected = $event" />
        </div>
        <div v-if="!library.filteredModules.length" class="empty">No sources match these filters.</div>
      </template>
    </main>

    <div v-if="selected" class="scrim" @click.self="selected = null">
      <aside class="drawer">
        <button class="close" aria-label="Close details" @click="selected = null">×</button>
        <p class="eyebrow">{{ selected.repository || 'Local import' }}</p>
        <h2 class="serif">{{ selected.description || selected.name }}</h2>
        <p class="muted">{{ selected.name }} · {{ selected.language.toUpperCase() }}<template v-if="selected.version"> · version {{ selected.version }}</template></p>
        <p v-if="selected.about">{{ selected.about }}</p>
        <dl>
          <div><dt>Kind</dt><dd>{{ selected.kind }}</dd></div>
          <div><dt>Tradition</dt><dd>{{ selected.tradition || 'Not audited' }}</dd></div>
          <div><dt>License</dt><dd>{{ selected.distributionLicense || 'Not specified by repository' }}</dd></div>
          <div><dt>Versification</dt><dd>{{ selected.versification || 'Not specified' }}</dd></div>
          <div><dt>Coverage evidence</dt><dd>{{ selected.coverageSource === 'unknown' ? 'This exact version has not been audited yet' : selected.coverageSource }}</dd></div>
          <div><dt>Edition coverage</dt><dd>{{ selected.coverageSummary }}</dd></div>
        </dl>
        <div v-if="selected.coverage.length" class="coverage"><span v-for="book in selected.coverage" :key="book">{{ book }}</span></div>
        <label v-if="selected.installed && (selected.kind === 'scripture' || selected.kind === 'general-book')" class="ai-toggle">
          <input type="checkbox" :checked="selected.aiEligibility === 'public-domain' || library.preferences[selected.name]" :disabled="selected.aiEligibility === 'public-domain'" @change="toggleAi(selected, ($event.target as HTMLInputElement).checked)" />
          <span><strong>Allow AI and semantic indexing</strong><small>{{ selected.aiEligibility === 'public-domain' ? 'Automatically eligible: repository marks this public domain.' : 'Off until you review the license and opt in.' }}</small></span>
        </label>
        <div class="drawer-actions">
          <button v-if="selected.installed" class="secondary" @click="library.uninstall(selected.name); selected = null">Remove</button>
          <button v-else class="primary" @click="library.install(selected)">Install from {{ selected.repository }}</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.scroll{flex:1;overflow-y:auto}.wrap{max-width:1080px;margin:0 auto;padding:56px 32px 100px}.header{display:flex;gap:32px;justify-content:space-between;align-items:flex-end}.eyebrow{margin:0 0 8px;color:var(--accent);font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase}h1{margin:0;font-size:38px;font-weight:500}.intro{max-width:650px;margin:8px 0 0;color:var(--muted);font-size:14px;line-height:1.55}.header-actions{display:flex;gap:8px;flex-shrink:0}button,select,input{font:inherit}.primary,.secondary{border-radius:8px;padding:10px 14px;font-size:12px;font-weight:650;cursor:pointer}.primary{border:1px solid var(--accent);background:var(--accent);color:var(--on-accent)}.secondary{border:1px solid var(--line);background:var(--card);color:var(--ink)}button:disabled{opacity:.55;cursor:default}.health{display:flex;width:100%;align-items:center;gap:9px;margin:26px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--muted);cursor:pointer;font-size:11px}.health.warning{color:var(--gold)}.dot{width:7px;height:7px;border-radius:50%;background:#4f9b70}.warning .dot{background:var(--gold)}.chevron{margin-left:auto}.health-detail{padding:8px 12px;border:1px solid var(--line);border-top:0;border-radius:0 0 9px 9px}.health-detail div{display:flex;justify-content:space-between;padding:4px;font-size:11px;color:var(--muted)}.canon-callout{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:center;margin:28px 0;padding:25px;border-radius:16px;background:linear-gradient(120deg,color-mix(in oklab,var(--accent) 12%,var(--card)),var(--card));border:1px solid color-mix(in oklab,var(--accent) 20%,var(--line))}.canon-callout h2{margin:0;font-size:25px}.canon-callout p:not(.eyebrow){max-width:700px;margin:7px 0 0;color:var(--muted);font-size:12px;line-height:1.55}.canon-callout button{border:0;border-radius:8px;padding:10px 14px;background:var(--ink);color:var(--paper);font-size:11px;font-weight:700;cursor:pointer}.controls{display:grid;grid-template-columns:1fr 210px;gap:10px}.search{position:relative}.search span{position:absolute;left:13px;top:10px;color:var(--muted)}.search input,select{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);padding:10px 12px;font-size:12px}.search input{padding-left:34px}.categories{display:flex;gap:7px;overflow-x:auto;padding:13px 0 25px}.categories button{white-space:nowrap;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--muted);padding:7px 11px;font-size:11px;cursor:pointer}.categories button.active{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}.result-head{display:flex;justify-content:space-between;margin-bottom:10px;color:var(--muted);font-size:11px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.empty{padding:50px 0;text-align:center;color:var(--muted);font-size:13px}.error,.success{padding:10px 12px;border-radius:8px;font-size:12px}.error{color:var(--accent);background:color-mix(in oklab,var(--accent) 8%,transparent)}.success{color:#4f9b70}.scrim{position:fixed;z-index:30;inset:0;background:#0006;display:flex;justify-content:flex-end}.drawer{width:min(440px,90vw);height:100%;box-sizing:border-box;overflow:auto;padding:36px 30px;background:var(--paper);box-shadow:-12px 0 40px #0003}.close{float:right;border:0;background:none;color:var(--muted);font-size:27px;cursor:pointer}.drawer h2{font-size:28px;margin:0 0 5px}.muted{color:var(--muted);font-size:12px}.drawer>p:not(.eyebrow,.muted){font-size:13px;line-height:1.6}dl{margin:25px 0}dl div{display:grid;grid-template-columns:120px 1fr;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}dt{color:var(--muted)}dd{margin:0}.coverage{display:flex;flex-wrap:wrap;gap:6px}.coverage span{padding:5px 8px;border-radius:6px;background:var(--soft);font-size:10px}.ai-toggle{display:flex;gap:10px;margin:24px 0;padding:13px;border:1px solid var(--line);border-radius:10px;font-size:12px}.ai-toggle small{display:block;margin-top:4px;color:var(--muted);line-height:1.4}.drawer-actions{display:flex;gap:8px;margin-top:25px}.drawer-actions .primary{flex:1}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.header{align-items:flex-start;flex-direction:column}.canon-callout{grid-template-columns:1fr}}@media(max-width:560px){.wrap{padding:34px 16px 80px}.grid{grid-template-columns:1fr}.controls{grid-template-columns:1fr}.header-actions{width:100%}.header-actions button{flex:1}.health-detail div{gap:20px}.canon-callout{padding:19px}}
</style>
