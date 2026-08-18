<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { useAuth } from './stores/auth'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { useReadingPlan } from './stores/readingPlan'
import { useNotes } from './stores/notes'
import { useReader } from './stores/reader'
import { useAiProvider } from './stores/aiProvider'
import { useSemanticIndex } from './stores/semanticIndex'
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
const notes = useNotes()
const reader = useReader()
const aiProvider = useAiProvider()
const semanticIndex = useSemanticIndex()
const personalLoading = ref(false)
const personalReady = ref(false)
const personalError = ref<string | null>(null)
let personalLoadGeneration = 0

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

async function loadPersonalData(userId: string): Promise<void> {
  const generation = ++personalLoadGeneration
  personalLoading.value = true
  personalReady.value = false
  personalError.value = null
  try {
    await Promise.all([
      notes.load(), reader.loadHighlights(), readingPlan.load(), aiProvider.load(), semanticIndex.load()
    ])
    if (generation === personalLoadGeneration && auth.user?.id === userId) {
      personalReady.value = true
    }
  } catch (error) {
    if (generation === personalLoadGeneration && auth.user?.id === userId) {
      personalError.value = (error as Error).message
    }
  } finally {
    if (generation === personalLoadGeneration) personalLoading.value = false
  }
}

function retryPersonalData(): void {
  if (auth.user) void loadPersonalData(auth.user.id)
}

watch(
  () => auth.user?.id ?? null,
  (userId) => {
    personalLoadGeneration += 1
    notes.resetPersonalData()
    reader.resetPersonalData()
    aiProvider.reset()
    semanticIndex.reset()
    personalReady.value = false
    personalError.value = null
    if (userId) void loadPersonalData(userId)
    else personalLoading.value = false
  }
)
</script>

<template>
  <div v-if="auth.state === 'loading' || (auth.authenticated && personalLoading)" class="loading-page">
    <div class="loading-mark"></div>
  </div>
  <AuthScreen v-else-if="!auth.authenticated" />
  <div v-else-if="personalError || !personalReady" class="personal-error-page">
    <div class="personal-error-card">
      <h1>Couldn’t load your account data</h1>
      <p>{{ personalError ?? 'Personal data is not ready yet.' }}</p>
      <button @click="retryPersonalData">Try again</button>
    </div>
  </div>
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
.personal-error-page {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--paper);
  color: var(--ink);
}
.personal-error-card {
  max-width: 420px;
  text-align: center;
}
.personal-error-card h1 {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-weight: 500;
}
.personal-error-card p { color: var(--muted); }
.personal-error-card button {
  border: 0;
  border-radius: 7px;
  padding: 9px 16px;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
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
