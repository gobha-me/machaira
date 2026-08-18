<script setup lang="ts">
import type { PassageCrossReference } from '../utils/crossReferences'

withDefaults(
  defineProps<{
    entries: PassageCrossReference[]
    moduleName: string
    refLabel: string
    emptyReason: string
    variant?: 'rail' | 'page'
    closable?: boolean
  }>(),
  { variant: 'rail', closable: false }
)

defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div class="xref-card" :class="variant">
    <div class="xref-head">
      <span class="xref-label">
        Cross-references<template v-if="moduleName"> · {{ moduleName }}</template>
      </span>
      <div class="xref-spacer"></div>
      <button v-if="closable" class="xref-close hover-ink" @click="$emit('close')">✕</button>
    </div>

    <p v-if="!refLabel" class="xref-state">Select a passage to see embedded cross-references.</p>
    <p v-else-if="!entries.length" class="xref-state">{{ emptyReason }}</p>
    <div v-else class="xref-list">
      <div v-for="(entry, i) in entries" :key="`${entry.verse}-${i}`" class="xref-entry">
        <span class="xref-verse">{{ entry.verse }}</span>
        <span class="xref-text serif">{{ entry.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.xref-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 12px 14px;
}
.xref-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.xref-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.xref-spacer {
  flex: 1;
}
.xref-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  padding: 2px;
}
.xref-state {
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
  margin: 0;
}
.xref-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rail .xref-list {
  max-height: 300px;
}
.page .xref-list {
  max-height: 460px;
}
.xref-entry {
  display: flex;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in oklab, var(--accent) 7%, transparent);
}
.xref-verse {
  min-width: 18px;
  flex-shrink: 0;
  padding-top: 3px;
  text-align: right;
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  font-family: 'Instrument Sans', sans-serif;
}
.xref-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
}
.page .xref-text {
  font-size: 15px;
}
</style>
