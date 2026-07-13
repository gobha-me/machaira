<script setup lang="ts">
import type { StrongsPayload } from '../services/api'

defineProps<{ entry: StrongsPayload }>()
</script>

<template>
  <div class="strongs-card">
    <div class="strongs-head">
      <span class="strongs-word serif">{{ entry.transcription || entry.key }}</span>
      <span class="strongs-phon">{{ entry.phonetic }}</span>
      <span class="strongs-key">{{ entry.key }}</span>
    </div>
    <div class="strongs-def">{{ entry.definition }}</div>
  </div>
</template>

<style scoped>
.strongs-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.strongs-word {
  font-size: 23px;
}
.strongs-phon {
  font-size: 12px;
  color: var(--muted);
}
.strongs-key {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent);
  border: 1px solid color-mix(in oklab, var(--accent) 40%, transparent);
  border-radius: 5px;
  padding: 2px 6px;
}
.strongs-def {
  font-size: 13.5px;
  line-height: 1.65;
  margin-top: 10px;
}
</style>
