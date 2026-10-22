<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { bookName, type CrossReferenceMapEdge, type CrossReferenceMapPayload, type CrossReferenceMapScope } from '@machaira/scripture'
import { api } from '../services/api'
import { useLibrary } from '../stores/library'
import { useReader } from '../stores/reader'
import { useSemanticIndex } from '../stores/semanticIndex'
import { passageRoute } from '../router'
import CrossReferenceMapCanvas from '../components/CrossReferenceMapCanvas.vue'

const library = useLibrary(), reader = useReader(), semantic = useSemanticIndex(), router = useRouter()
const payload = shallowRef<CrossReferenceMapPayload | null>(null)
const overview = shallowRef<CrossReferenceMapPayload | null>(null)
const book = ref(''), chapter = ref(''), retry = ref(0)
const moduleName = ref(reader.moduleName || library.installedBibles[0]?.name || '')
const list = ref(false), loading = ref(false), error = ref(''), navigationError = ref(''), navigating = ref(false)
const hovered = shallowRef<CrossReferenceMapEdge | null>(null)
const page = ref(0), similarity = ref(false), maximum = ref(2), distances = shallowRef<Array<number | null>>([])
const similarityState = ref(''), similarityLoading = ref(false)
const scope = computed<CrossReferenceMapScope>(() => ({ ...(book.value ? { book: book.value } : {}), ...(chapter.value ? { chapter: Number(chapter.value) } : {}) }))
const books = computed(() => overview.value?.nodes ?? [])
const chapters = computed(() => !chapter.value ? payload.value?.nodes.filter((node) => node.book === book.value && node.chapter !== null).map((node) => node.chapter!) ?? [] : chapterOptions.value)
const chapterOptions = ref<number[]>([])
const eligible = computed(() => semantic.status?.state === 'ready' && Boolean(moduleName.value) && semantic.status.modules.includes(moduleName.value))
const visibleEdges = computed(() => (payload.value?.edges ?? []).filter((_edge, index) => !similarity.value || (distances.value[index] != null && distances.value[index]! <= maximum.value)))
const rows = computed(() => visibleEdges.value.slice(page.value * 40, (page.value + 1) * 40))
const title = computed(() => book.value ? `${bookName(book.value)}${chapter.value ? ` ${chapter.value}` : ''}` : 'All Scripture')
const labels = computed(() => new Map(payload.value?.nodes.map((node) => [node.id, node.label])))
function sampleLabel(reference: string) {
  const [code, c, verse] = reference.split('.')
  return `${bookName(code)} ${c}:${verse}`
}
function describe(edge: CrossReferenceMapEdge) {
  return `${labels.value.get(edge.source)} → ${labels.value.get(edge.target)} · ${edge.count.toLocaleString()} links. Example: ${sampleLabel(edge.sample.source)} → ${sampleLabel(edge.sample.target)}`
}
function changeBook() { chapter.value = ''; chapterOptions.value = [] }
watch([scope, retry], async (_value, _old, onCleanup) => {
  const controller = new AbortController()
  let current = true
  onCleanup(() => { current = false; controller.abort() })
  payload.value = null; error.value = ''; hovered.value = null; page.value = 0; loading.value = true
  try {
    const data = await api.crossReferenceMap(scope.value, controller.signal)
    if (!current) return
    payload.value = data
    if (!book.value) overview.value = data
    else if (!chapter.value) chapterOptions.value = data.nodes.filter((node) => node.book === book.value).map((node) => node.chapter!)
  } catch {
    if (current) error.value = 'Could not load the cross-reference map. Try again.'
  } finally { if (current) loading.value = false }
}, { immediate: true })
watch([payload, moduleName, eligible], async (_value, _old, onCleanup) => {
  const controller = new AbortController()
  let current = true
  onCleanup(() => { current = false; controller.abort() })
  distances.value = []; similarity.value = false; similarityState.value = ''; similarityLoading.value = false
  if (!payload.value || !eligible.value) return
  similarityLoading.value = true
  try {
    const result = await api.mapSimilarity(moduleName.value, scope.value, controller.signal)
    if (current) { distances.value = result.distances; similarityState.value = result.state }
  } catch { if (current) similarityState.value = 'unavailable' }
  finally { if (current) similarityLoading.value = false }
}, { immediate: true })
watch([similarity, maximum], () => { page.value = 0; hovered.value = null })
const similarityAvailable = computed(() => eligible.value && similarityState.value === 'ready' && distances.value.some((distance) => distance !== null))

let navigationGeneration = 0
watch([moduleName, scope], () => { navigationGeneration++; navigating.value = false; navigationError.value = '' })
onScopeDispose(() => { navigationGeneration++ })
async function open(reference: string) {
  if (!moduleName.value || navigating.value) return
  const module = moduleName.value
  const generation = ++navigationGeneration
  navigating.value = true; navigationError.value = ''
  try {
    const result = await api.resolveMapReference(module, reference)
    if (generation !== navigationGeneration) return
    if (!result.target) { navigationError.value = 'This canonical verse is unavailable in the selected translation. Choose another translation.'; return }
    await router.push(passageRoute({ moduleName: module, ...result.target }))
  } catch { if (generation === navigationGeneration) navigationError.value = 'Could not open this passage. Try again.' }
  finally { if (generation === navigationGeneration) navigating.value = false }
}
</script>

<template>
  <div class="map-screen">
    <header class="map-header">
      <p class="eyebrow">
        Explore the connections
      </p>
      <h1 class="serif">
        The cross-link map
      </h1>
      <p class="intro">
        One story, woven through Scripture. Follow the threads between its books, chapters, and verses.
      </p>
    </header>
    <div class="controls">
      <div class="field">
        <label for="map-book">Book</label>
        <select
          id="map-book"
          v-model="book"
          @change="changeBook"
        >
          <option value="">
            All books
          </option>
          <option
            v-for="node in books"
            :key="node.id"
            :value="node.book"
          >
            {{ node.label }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="map-chapter">Chapter</label>
        <select
          id="map-chapter"
          v-model="chapter"
          :disabled="!book || loading"
        >
          <option value="">
            All chapters
          </option>
          <option
            v-for="number in chapters"
            :key="number"
            :value="String(number)"
          >
            {{ number }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="map-translation">Open passages in</label>
        <select
          id="map-translation"
          v-model="moduleName"
          :disabled="!library.installedBibles.length"
        >
          <option
            v-if="!library.installedBibles.length"
            value=""
          >
            Install a Bible in Library
          </option>
          <option
            v-for="module in library.installedBibles"
            :key="module.name"
            :value="module.name"
          >
            {{ module.name }}
          </option>
        </select>
      </div>
      <button
        class="view-toggle"
        :aria-pressed="list"
        @click="list = !list"
      >
        {{ list ? 'Show arc diagram' : 'Show accessible list' }}
      </button>
    </div>
    <div class="similarity-controls">
      <label class="check"><input
        v-model="similarity"
        type="checkbox"
        :disabled="!similarityAvailable"
      > Colour and filter by embedding similarity</label>
      <label v-if="similarity">Maximum L2 distance: {{ maximum.toFixed(2) }}
        <input
          v-model.number="maximum"
          type="range"
          min="0"
          max="2"
          step="0.05"
        >
      </label>
      <span
        v-if="!similarityAvailable"
        class="notice"
      >{{ similarityLoading ? 'Loading stored similarity…' : eligible ? 'Similarity unavailable for this view. Cross-references remain available.' : 'Similarity needs a ready meaning index for this translation (Settings).' }}</span>
      <span
        v-else
        class="notice"
      >Means of stored verse embeddings · lower distance = more similar · unindexed links omitted when enabled</span>
    </div>
    <p
      v-if="loading"
      role="status"
    >
      Loading cross-references…
    </p>
    <div
      v-else-if="error"
      role="alert"
    >
      <p>{{ error }}</p><button @click="retry++">
        Retry map
      </button>
    </div>
    <template v-else-if="payload">
      <section
        class="map-card"
        :aria-label="title"
      >
        <div class="map-meta">
          <h2>{{ title }}</h2><span>{{ payload.matchedLinks.toLocaleString() }} / {{ payload.totalLinks.toLocaleString() }} links</span>
        </div>
        <template v-if="!list">
          <CrossReferenceMapCanvas
            :payload="payload"
            :distances="distances"
            :similarity="similarity"
            :maximum="maximum"
            @preview="hovered = $event"
            @open="open($event.sample.target)"
          />
          <p
            class="hover-detail"
            aria-live="polite"
          >
            {{ hovered ? describe(hovered) : 'Hover an arc to see its connection. Tap or click to open its example target in Read.' }}
          </p>
          <div class="legend">
            <span>{{ similarity ? 'More similar' : 'Genesis' }}</span><span
              class="spectrum"
              :class="{ similarity }"
            /><span>{{ similarity ? 'Less similar' : 'Revelation' }}</span>
          </div>
        </template>
        <template v-else>
          <p class="list-help">
            Each row represents an aggregate. Open either verse of its real example, or use Book and Chapter to zoom further.
          </p>
          <ul class="link-list">
            <li
              v-for="edge in rows"
              :key="`${edge.source}/${edge.target}`"
            >
              <p>{{ labels.get(edge.source) }} → {{ labels.get(edge.target) }} <span>· {{ edge.count.toLocaleString() }} links</span></p>
              <button
                :disabled="!moduleName || navigating"
                @click="open(edge.sample.source)"
              >
                {{ sampleLabel(edge.sample.source) }}
              </button>
              <span aria-hidden="true"> → </span>
              <button
                :disabled="!moduleName || navigating"
                @click="open(edge.sample.target)"
              >
                {{ sampleLabel(edge.sample.target) }}
              </button>
            </li>
          </ul>
          <nav
            class="pagination"
            aria-label="Connection pages"
          >
            <button
              :disabled="page === 0"
              @click="page--"
            >
              Previous
            </button>
            <span>Page {{ page + 1 }} of {{ Math.max(1, Math.ceil(visibleEdges.length / 40)) }}</span>
            <button
              :disabled="(page + 1) * 40 >= visibleEdges.length"
              @click="page++"
            >
              Next
            </button>
          </nav>
        </template>
        <p
          v-if="!visibleEdges.length"
          role="status"
        >
          No connections match this view or similarity filter.
        </p>
      </section>
      <p
        v-if="navigationError"
        role="alert"
      >
        {{ navigationError }}
      </p>
      <p
        v-if="!moduleName"
        role="status"
      >
        Install a Bible in Library to open passages in Read.
      </p>
      <p class="map-explanation">
        {{ book ? 'Showing incoming and outgoing links for this selection. Other books stay grouped.' : 'All 66 books in canonical order. Choose a book, then a chapter, to zoom to individual verses.' }} Arc width reflects link count; {{ similarity ? 'colour reflects distance between mean embeddings.' : 'colour follows the source along the axis.' }}
      </p>
      <p class="credits">
        Data: <a href="https://www.openbible.info/labs/cross-references/">OpenBible.info Bible Cross References</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Aggregated for display; ranges plotted at their starting verse. Canonical coordinates are mapped to your translation when opening Read. Inspired by Chris Harrison’s arc diagrams.
      </p>
    </template>
  </div>
</template>

<style scoped>
.map-screen { overflow: auto; padding: 28px 32px 24px; color: var(--ink); }
.map-header { max-width: 740px; margin-bottom: 24px; }
.eyebrow { text-transform: uppercase; letter-spacing: .18em; font-size: 10px; color: var(--accent); font-weight: 700; }
h1 { font-size: 40px; font-weight: 500; margin: 8px 0 10px; line-height: 1.1; }
.intro { color: var(--muted); font-size: 14px; line-height: 1.6; margin: 0; }
.controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
.field { display: flex; flex-direction: column; gap: 6px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 11px; color: var(--muted); }
select, button { font: inherit; font-size: 12px; color: var(--ink); border: 1px solid var(--line); border-radius: 6px; background: var(--card); padding: 8px 12px; min-height: 40px; }
select { max-width: 210px; }
button { cursor: pointer; }
button:disabled, select:disabled { opacity: .5; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.view-toggle { margin-left: auto; color: var(--accent); }
.similarity-controls { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; margin: 16px 0 20px; }
.check { flex-direction: row; align-items: center; min-height: 28px; }
input { accent-color: var(--accent); }
.notice { color: var(--muted); font-size: 11px; line-height: 1.5; }
.map-card { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 18px 20px 14px; }
.map-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
h2 { font-size: 14px; font-weight: 600; margin: 0; }
.map-meta > span { font-size: 11px; color: var(--muted); text-align: right; }
.hover-detail { min-height: 34px; font-size: 12px; line-height: 1.5; color: var(--muted); margin: 6px 0 10px; }
.legend { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 10px; color: var(--muted); }
.spectrum { width: 120px; height: 3px; background: linear-gradient(90deg, hsl(25 60% 48%), hsl(120 60% 48%), hsl(210 60% 48%), hsl(285 60% 48%)); }
.spectrum.similarity { background: linear-gradient(90deg, hsl(265 65% 48%), hsl(155 65% 48%), hsl(45 65% 48%)); }
.map-explanation, .credits, .list-help { font-size: 12px; color: var(--muted); line-height: 1.7; }
.credits { font-size: 10px; max-width: 860px; }
a { color: inherit; }
.link-list { list-style: none; padding: 0; }
.link-list li { padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
.link-list p { margin: 0 0 6px; }
.link-list span { color: var(--muted); }
.pagination { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; }
@media (max-width: 768px) {
  .map-screen { padding: 20px 16px; }
  h1 { font-size: 32px; }
  .map-header { margin-bottom: 18px; }
  .controls { gap: 10px; }
  .controls .field { flex: 1 1 40%; min-width: 0; }
  select { width: 100%; max-width: 100%; min-height: 44px; }
  .view-toggle { flex: 1 1 40%; margin: 0; }
  button { min-height: 44px; }
  .similarity-controls { margin: 12px 0; }
  .map-card { padding: 14px 12px; }
  .map-meta { align-items: center; }
  .map-meta > span { max-width: 135px; }
}
</style>
