<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { useReadingPlan } from './stores/readingPlan'
import { applyVars } from './theme'
import RailNav from './components/RailNav.vue'
import ReadScreen from './screens/ReadScreen.vue'
import PlanScreen from './screens/PlanScreen.vue'
import StudyScreen from './screens/StudyScreen.vue'
import SearchScreen from './screens/SearchScreen.vue'
import LibraryScreen from './screens/LibraryScreen.vue'
import JournalScreen from './screens/JournalScreen.vue'
import SettingsScreen from './screens/SettingsScreen.vue'

const settings = useSettings()
const ui = useUi()
const readingPlan = useReadingPlan()
const root = ref<HTMLElement | null>(null)

const screens = {
  read: ReadScreen,
  plan: PlanScreen,
  study: StudyScreen,
  search: SearchScreen,
  library: LibraryScreen,
  journal: JournalScreen,
  settings: SettingsScreen
} as const

// Fall back to Read if the plan gets turned off while its (now-hidden) tab is active.
const activeScreen = computed(() =>
  ui.screen === 'plan' && !readingPlan.enabled ? screens.read : screens[ui.screen]
)

watchEffect(() => {
  if (root.value) {
    applyVars(root.value, {
      theme: settings.theme,
      accent: settings.effectiveAccent,
      textScale: settings.textScale
    })
  }
})

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    ui.go('search')
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  readingPlan.load()
})
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div ref="root" class="app-root">
    <RailNav />
    <main class="app-main">
      <component :is="activeScreen" />
    </main>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  height: 100dvh;
  background: var(--paper);
  color: var(--ink);
  font-family: 'Instrument Sans', sans-serif;
  overflow: hidden;
}
.app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
