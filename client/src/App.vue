<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, watchEffect } from 'vue'
import { useAuth } from './stores/auth'
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
import AuthScreen from './components/AuthScreen.vue'

const auth = useAuth()
const settings = useSettings()
const ui = useUi()
const readingPlan = useReadingPlan()

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

// Apply the palette on :root so the whole document — including Teleported overlays
// (PassageActions, etc.) that live outside .app-root — inherits the theme tokens.
watchEffect(() => {
  applyVars(document.documentElement, {
    theme: settings.theme,
    accent: settings.effectiveAccent,
    textScale: settings.textScale
  })
})

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    ui.go('search')
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  auth.initialize()
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

watch(
  () => auth.authenticated,
  (authenticated) => {
    if (authenticated) readingPlan.load()
  }
)
</script>

<template>
  <div v-if="auth.state === 'loading'" class="loading-page">
    <div class="loading-mark"></div>
  </div>
  <AuthScreen v-else-if="!auth.authenticated" />
  <div v-else class="app-root">
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
.loading-page {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  background: var(--paper);
}
.loading-mark {
  width: 10px;
  height: 10px;
  background: var(--accent);
  transform: rotate(45deg);
  animation: pulse 1s ease-in-out infinite alternate;
}
@keyframes pulse { to { opacity: 0.35; } }
</style>
