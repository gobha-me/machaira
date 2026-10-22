<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { api, type ConnectionNode, type ConnectionSeed, type ConnectionsPayload } from '../services/api'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import CrossReferenceCredits from './CrossReferenceCredits.vue'

const props = withDefaults(defineProps<{
  variant?: 'rail' | 'page'
  closable?: boolean
  passage?: { verseStart: number; verseEnd: number }
}>(), { variant: 'rail', closable: true, passage: undefined })

const emit = defineEmits<{ (event: 'close'): void; (event: 'navigated', verse: number | null): void }>()
const reader = useReader()
const ui = useUi()
const payload = ref<ConnectionsPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const navigationError = ref<string | null>(null)
const navigating = ref(false)
const retry = ref(0)
const history = ref<ConnectionSeed[]>([])
const heading = ref<HTMLElement | null>(null)
let navigationGeneration = 0

defineExpose({ focus: () => heading.value?.focus() })

const seed = computed<ConnectionSeed | null>(() => {
  const bounds = props.passage
    ? { lo: props.passage.verseStart, hi: props.passage.verseEnd }
    : reader.selectionBounds
  return reader.moduleName && reader.book && bounds ? {
    module: reader.moduleName, book: reader.book, chapter: reader.chapter,
    verseStart: bounds.lo, verseEnd: bounds.hi
  } : null
})
const selectionKey = computed(() => JSON.stringify([
  reader.activeUserId, reader.moduleName, reader.book, reader.chapter, seed.value
]))

// Manual passage/translation/account changes start a fresh trail. Connections navigation
// preserves it so following several links still offers a way back to the original verse.
watch(selectionKey, () => {
  if (!navigating.value) {
    history.value = []
    navigationError.value = null
    navigationGeneration += 1
  }
}, { flush: 'sync' })

watch([selectionKey, retry], async (_value, _old, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  payload.value = null
  error.value = null
  loading.value = false
  if (!seed.value) return
  loading.value = true
  try {
    const result = await api.connections([seed.value])
    if (current) payload.value = result
  } catch {
    if (current) error.value = 'Could not load connections. Try again.'
  } finally {
    if (current) loading.value = false
  }
}, { immediate: true })

const groups = computed(() => (['cross-reference', 'thematic'] as const).map((kind) => {
  const ids = new Set(payload.value?.edges.filter((edge) => edge.kind === kind).map((edge) => edge.target))
  return {
    kind,
    title: kind === 'cross-reference' ? 'Cross-references' : 'Related by meaning',
    nodes: payload.value?.nodes.filter((node) => !node.seed && ids.has(node.id)) ?? []
  }
}))
const visibleGroups = computed(() => props.variant === 'page'
  ? groups.value.filter((group) => group.nodes.length > 0)
  : groups.value)
const hasConnections = computed(() => groups.value.some((group) => group.nodes.length > 0))
const reference = computed(() => props.passage
  ? `${reader.bookName} ${reader.chapter}:${props.passage.verseStart}${props.passage.verseStart === props.passage.verseEnd ? '' : `–${props.passage.verseEnd}`}`
  : reader.selectionRef)
const semanticNotice = computed(() => {
  switch (payload.value?.semanticState) {
    case 'ready': return null
    case 'stale': return 'The meaning index is stale. Rebuild it in Settings to see related passages.'
    case 'building': return 'The meaning index is building. Check its progress in Settings.'
    case 'failed': return 'The meaning index failed. Retry the build in Settings.'
    case 'unavailable': return 'Related passages could not be loaded. Retry connections or check Settings.'
    case 'unconfigured': return 'Set up an embedding provider and build the meaning index in Settings.'
    default: return 'Build the meaning index in Settings to see related passages.'
  }
})

async function navigate(target: ConnectionSeed, back = false) {
  // Chapter-level references clear verse selection, but must still allow Back.
  if (navigating.value || (!back && !seed.value)) return
  const origin = seed.value ? { ...seed.value } : null
  const originKey = selectionKey.value
  const generation = ++navigationGeneration
  navigating.value = true
  navigationError.value = null
  try {
    const result = await reader.openRoute({
      moduleName: target.module, book: target.book, chapter: target.chapter,
      verseStart: target.verseStart, verseEnd: target.verseEnd
    }, () => generation === navigationGeneration && selectionKey.value === originKey)
    if (generation !== navigationGeneration) return
    if (!result.ok) {
      if (selectionKey.value !== originKey) {
        history.value = []
        return
      }
      navigationError.value = result.error
      return
    }
    if (back) history.value.pop()
    else if (origin) history.value.push(origin)
    emit('navigated', target.verseStart)
    await nextTick()
    heading.value?.focus()
  } finally {
    navigating.value = false
  }
}

function open(node: ConnectionNode) {
  void navigate(node)
}
function goBack() {
  const target = history.value.at(-1)
  if (target) void navigate(target, true)
}
onScopeDispose(() => { navigationGeneration += 1 })
</script>

<template>
  <section
    class="connections-panel"
    :class="{ 'connections-card': variant === 'rail' || hasConnections }"
    aria-label="Connections"
    :aria-busy="loading || navigating"
  >
    <div class="head">
      <h2
        ref="heading"
        tabindex="-1"
      >
        Connections
      </h2>
      <button
        v-if="history.length"
        :disabled="navigating"
        @click="goBack"
      >
        ← Back
      </button>
      <button
        v-if="closable"
        aria-label="Close connections"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>
    <p class="reference">
      {{ reference }} · {{ reader.moduleName }}
    </p>
    <p
      v-if="navigationError"
      role="alert"
    >
      {{ navigationError }}
    </p>
    <p
      v-if="!seed"
      role="status"
    >
      Select a verse to see connections.
    </p>
    <p
      v-else-if="loading"
      role="status"
    >
      Loading connections…
    </p>
    <div
      v-else-if="error"
      role="alert"
    >
      <p>{{ error }}</p>
      <button @click="retry++">
        Retry connections
      </button>
    </div>
    <template v-else-if="payload">
      <p
        v-if="variant === 'page' && !hasConnections"
        role="status"
      >
        No connections found for this passage.
      </p>
      <p
        v-if="variant === 'page' && semanticNotice"
        role="status"
      >
        {{ semanticNotice }}
        <button @click="ui.openSemanticSettings()">
          Open index settings
        </button>
        <button
          v-if="payload.semanticState === 'unavailable'"
          @click="retry++"
        >
          Retry connections
        </button>
      </p>
      <section
        v-for="group in visibleGroups"
        :key="group.kind"
        :aria-label="group.title"
      >
        <h3>{{ group.title }}</h3>
        <template v-if="variant === 'rail' && group.kind === 'thematic' && semanticNotice">
          <p role="status">
            {{ semanticNotice }}
          </p>
          <button
            v-if="payload.semanticState === 'unavailable'"
            @click="retry++"
          >
            Retry connections
          </button>
          <button @click="ui.openSemanticSettings()">
            {{ payload.semanticState === 'stale' ? 'Rebuild index in Settings' : 'Open index settings' }}
          </button>
        </template>
        <template v-else>
          <p
            v-if="!group.nodes.length"
            role="status"
          >
            {{ group.kind === 'cross-reference' ? 'No cross-references available for this passage in this translation.' : 'No related passages found in the current translation.' }}
          </p>
          <ul v-else>
            <li
              v-for="node in group.nodes"
              :key="node.id"
            >
              <button
                class="passage"
                :disabled="navigating"
                @click="open(node)"
              >
                <span class="label">{{ node.label }}</span>
                <span class="preview serif">{{ node.content }}</span>
              </button>
            </li>
          </ul>
        </template>
      </section>
      <p
        v-for="warning in payload.warnings"
        :key="warning"
        class="warning"
      >
        {{ warning }}
      </p>
      <CrossReferenceCredits v-if="payload.crossReferenceAttribution" />
    </template>
  </section>
</template>

<style scoped>
.connections-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 12px 14px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* Move controls to another row before the inherited overflow-wrap can split the title. */
h2 { flex: 1 0 auto; margin: 0; font-size: 15px; white-space: nowrap; }
.head button { flex-shrink: 0; white-space: nowrap; }
h3 { font-size: 13px; margin: 16px 0 8px; }
p { font-size: 13px; line-height: 1.5; color: var(--muted); }
.reference, .warning { font-size: 11px; }
button {
  font: inherit;
  font-size: 12px;
  background: var(--card);
  color: var(--accent);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: wait; }
button:focus-visible, h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.passage { display: block; width: 100%; text-align: left; }
.label { display: block; font-weight: 700; }
.preview { display: block; margin-top: 4px; color: var(--ink); font-size: 14px; line-height: 1.6; }
@media (max-width: 768px) { button { min-height: 44px; } }
</style>
