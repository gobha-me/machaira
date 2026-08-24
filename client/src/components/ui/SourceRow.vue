<script setup lang="ts">
import type { ModuleInfo } from '../../services/api'

defineProps<{ module: ModuleInfo; installing: boolean; progress: number }>()
const emit = defineEmits<{
  (event: 'install', module: ModuleInfo): void
  (event: 'uninstall', name: string): void
  (event: 'details', module: ModuleInfo): void
}>()

function kindLabel(module: ModuleInfo): string {
  if (module.collection === 'deuterocanon') return 'Deuterocanon'
  if (module.kind === 'general-book') return module.collection === 'ancient-writings' ? 'Ancient writing' : 'General book'
  if (module.kind === 'scripture') return 'Bible'
  if (module.kind === 'lexicon') return 'Lexicon'
  return 'Commentary'
}
</script>

<template>
  <article class="source-card" @click="emit('details', module)">
    <div class="card-top">
      <div class="identity">
        <h3>{{ module.description || module.name }}</h3>
        <div class="code">{{ module.name }} · {{ module.language.toUpperCase() || 'UND' }}</div>
      </div>
      <span v-if="module.installed" class="installed">Installed</span>
    </div>
    <p v-if="module.about" class="about">{{ module.about }}</p>
    <div class="badges">
      <span>{{ kindLabel(module) }}</span>
      <span v-if="module.coverage.length">{{ module.coverage.length }} additional books</span>
      <span>{{ module.repository || 'Local import' }}</span>
      <span :class="{ caution: module.aiEligibility === 'review-required' }" :title="module.distributionLicense">
        {{ module.aiEligibility === 'public-domain' ? 'Public domain' : 'License review' }}
      </span>
    </div>
    <div class="actions" @click.stop>
      <template v-if="installing">
        <div class="bar" role="progressbar" :aria-valuenow="progress"><i :style="{ width: `${progress}%` }"></i></div>
        <span>Installing {{ progress }}%</span>
      </template>
      <button v-else-if="module.installed" class="secondary" @click="emit('uninstall', module.name)">Remove</button>
      <button v-else class="primary" :disabled="!module.repository" @click="emit('install', module)">Install</button>
      <button class="details" @click="emit('details', module)">Details</button>
    </div>
  </article>
</template>

<style scoped>
.source-card { display:flex; flex-direction:column; min-height:170px; padding:18px; border:1px solid var(--line); border-radius:14px; background:var(--card); cursor:pointer; transition:border-color .15s, transform .15s; }
.source-card:hover { border-color:color-mix(in oklab,var(--accent) 45%,var(--line)); transform:translateY(-1px); }
.card-top { display:flex; gap:12px; align-items:flex-start; }
.identity { min-width:0; flex:1; }
h3 { margin:0; font:600 15px/1.35 inherit; }
.code { margin-top:4px; color:var(--muted); font-size:11px; }
.installed { padding:4px 7px; border-radius:999px; color:var(--accent); background:color-mix(in oklab,var(--accent) 10%,transparent); font-size:10px; font-weight:700; }
.about { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin:10px 0 0; color:var(--muted); font-size:12px; line-height:1.45; }
.badges { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0; }
.badges span { padding:4px 7px; border-radius:6px; background:var(--soft); color:var(--muted); font-size:10px; }
.badges .caution { color:var(--gold); }
.actions { display:flex; align-items:center; gap:8px; margin-top:auto; }
button { border-radius:7px; padding:7px 11px; cursor:pointer; font:600 11px inherit; }
.primary { border:1px solid var(--accent); background:var(--accent); color:var(--on-accent); }
.secondary,.details { border:1px solid var(--line); background:transparent; color:var(--muted); }
.details { margin-left:auto; }
.bar { height:4px; flex:1; overflow:hidden; border-radius:4px; background:var(--soft); }
.bar i { display:block; height:100%; background:var(--accent); }
</style>
