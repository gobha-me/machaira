<script setup lang="ts">
import { onMounted, nextTick, watch, type ComponentPublicInstance } from 'vue'
import { useReader } from '../stores/reader'
import { useCommentary } from '../composables/useCommentary'

// Verse-keyed commentary notes for the current chapter, from one installed commentary module.
// Shared by Read (rail card) and Study (page panel). The panel is only mounted while visible,
// so it loads on mount and follows reader.book/chapter via the composable's watch. The verse
// matching reader.selectedVerse is emphasized and scrolled into view.
withDefaults(
  defineProps<{
    variant?: 'rail' | 'page'
    closable?: boolean
  }>(),
  { variant: 'rail', closable: false }
)

defineEmits<{ (e: 'close'): void }>()

const reader = useReader()
const { entries, loading, error, locked, activeModule, installedCommentaries, load, setModule } =
  useCommentary()

onMounted(load)

// Map verse number → its rendered entry element, for scroll-into-view on selection.
const entryEls = new Map<number, HTMLElement>()
function setEntryRef(n: number, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) entryEls.set(n, el)
  else entryEls.delete(n)
}

function onPick(e: Event) {
  const name = (e.target as HTMLSelectElement).value
  if (name) setModule(name)
}

// Bring the selected verse's note forward whenever the selection or the loaded set changes.
watch(
  () => [reader.selectedVerse, entries.value.length] as const,
  () => {
    const v = reader.selectedVerse
    if (v == null) return
    nextTick(() => entryEls.get(v)?.scrollIntoView({ block: 'nearest' }))
  }
)
</script>

<template>
  <div class="commentary-card" :class="variant">
    <div class="cc-head">
      <span class="cc-label">Commentary<template v-if="activeModule"> · {{ activeModule }}</template></span>
      <select
        v-if="installedCommentaries.length > 1"
        class="cc-picker"
        :value="activeModule ?? ''"
        @change="onPick"
      >
        <option v-for="name in installedCommentaries" :key="name" :value="name">{{ name }}</option>
      </select>
      <div class="cc-spacer"></div>
      <button v-if="closable" class="cc-close hover-ink" @click="$emit('close')">✕</button>
    </div>

    <div v-if="loading" class="cc-state">Loading notes…</div>
    <p v-else-if="error" class="cc-error">{{ error }}</p>
    <p v-else-if="!installedCommentaries.length" class="cc-state">
      Install a commentary (e.g. the Geneva Bible notes) in the Library to read verse-by-verse
      notes here.
    </p>
    <p v-else-if="locked" class="cc-state">
      {{ activeModule }} is locked — its notes need an unlock key, so nothing can be shown.
    </p>
    <p v-else-if="!entries.length" class="cc-state">
      No notes in {{ activeModule }} for {{ reader.bookName }} {{ reader.chapter }}.
    </p>
    <div v-else class="cc-list">
      <div
        v-for="e in entries"
        :key="e.n"
        :ref="(el) => setEntryRef(e.n, el)"
        class="cc-entry"
        :class="{ current: e.n === reader.selectedVerse }"
      >
        <span class="cc-verse">{{ e.n }}</span>
        <span class="cc-text serif">{{ e.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.commentary-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 12px 14px;
}
.cc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.cc-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.cc-spacer {
  flex: 1;
}
.cc-picker {
  max-width: 40%;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
  font-family: inherit;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}
.cc-picker:focus {
  outline: none;
  border-color: var(--accent);
}
.cc-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  padding: 2px;
}
.cc-state {
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
  margin: 0;
}
.cc-error {
  font-size: 13px;
  color: var(--accent);
  margin: 0;
}
.cc-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail .cc-list {
  max-height: 300px;
}
.page .cc-list {
  max-height: 460px;
}
.cc-entry {
  display: flex;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  scroll-margin: 8px;
}
.cc-entry.current {
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}
.cc-verse {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  flex-shrink: 0;
  min-width: 18px;
  text-align: right;
  padding-top: 3px;
  font-family: 'Instrument Sans', sans-serif;
}
.cc-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
}
.page .cc-text {
  font-size: 15px;
}
</style>
