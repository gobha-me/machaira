<script setup lang="ts">
import type { ModuleInfo } from '../../services/api'

const props = defineProps<{
  module: ModuleInfo
  installed: boolean
  installing: boolean
  progress: number
  last?: boolean
}>()

const emit = defineEmits<{
  (e: 'install', name: string): void
  (e: 'uninstall', name: string): void
}>()

function title(m: ModuleInfo): string {
  return m.name
}

function subtitle(m: ModuleInfo): string {
  const bits: string[] = []
  if (m.description?.trim() && m.description.trim() !== m.name) bits.push(m.description.trim())
  if (m.language) bits.push(m.language.toUpperCase())
  if (m.distributionLicense) bits.push(m.distributionLicense)
  if (m.abbreviation && m.abbreviation !== m.name) bits.push(m.abbreviation)
  return bits.join(' · ')
}

function fullLabel(m: ModuleInfo): string {
  return `${title(m)} · ${subtitle(m)}`
}
</script>

<template>
  <div class="row" :class="{ last }">
    <div class="row-main" :title="fullLabel(module)">
      <div class="row-title">{{ title(module) }}</div>
      <div class="row-sub">{{ subtitle(module) }}</div>
    </div>
    <div class="row-actions">
      <template v-if="installing">
        <div class="bar"><div class="bar-fill" :style="{ width: progress + '%' }"></div></div>
        <span class="state installing">Installing {{ progress }}%</span>
      </template>

      <template v-else-if="installed">
        <span class="state done">Installed ✓</span>
        <button
          class="remove hover-accent-text"
          :aria-label="`Remove ${title(module)}`"
          @click="emit('uninstall', module.name)"
        >Remove</button>
      </template>

      <template v-else>
        <button
          class="get hover-soft-accent"
          :aria-label="`Install ${title(module)}`"
          @click="emit('install', module.name)"
        >Get</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.row.last {
  border-bottom: none;
}
.row-main {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.row-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
}
.row-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  line-height: 1.4;
}
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  flex: 0 0 auto;
}
.state {
  font-size: 11.5px;
  font-weight: 600;
}
.state.done {
  color: var(--muted);
}
.state.installing {
  color: var(--gold);
}
.bar {
  width: 90px;
  flex: 0 0 90px;
  height: 4px;
  background: var(--soft);
  border-radius: 2px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  background: var(--gold);
  transition: width 0.2s;
}
.remove {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  padding: 0;
}
.get {
  background: none;
  border: 1px solid var(--accent);
  color: var(--accent);
  border-radius: 7px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.hover-soft-accent:hover {
  background: color-mix(in oklab, var(--accent) 8%, transparent);
}

@media (max-width: 480px) {
  .row {
    align-items: flex-start;
    flex-direction: column;
  }
  .row-actions {
    align-self: stretch;
    flex-wrap: wrap;
  }
  .bar {
    flex: 1 1 90px;
  }
}
</style>
