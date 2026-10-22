<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch, watchEffect } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import { useAuth } from './stores/auth'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { useReadingPlan } from './stores/readingPlan'
import { useNotes } from './stores/notes'
import { useLibrary } from './stores/library'
import { useReader } from './stores/reader'
import { useAiProvider } from './stores/aiProvider'
import { useSemanticIndex } from './stores/semanticIndex'
import { useTtsProvider } from './stores/ttsProvider'
import { useSttProvider } from './stores/sttProvider'
import { useChatConversations } from './stores/chatConversations'
import { applyVars } from './theme'
import { invalidateAccountRequests } from './services/api'
import RailNav from './components/RailNav.vue'
import AuthScreen from './components/AuthScreen.vue'
import { useReaderRouting } from './composables/useReaderRouting'

const auth = useAuth()
const settings = useSettings()
const ui = useUi()
const readingPlan = useReadingPlan()
const notes = useNotes()
const library = useLibrary()
const reader = useReader()
const aiProvider = useAiProvider()
const semanticIndex = useSemanticIndex()
const ttsProvider = useTtsProvider()
const sttProvider = useSttProvider()
const chatConversations = useChatConversations()
const personalLoading = ref(false)
const personalReady = ref(false)
const router = useRouter()
const { initialize: initializeReader, routeError } = useReaderRouting(personalReady)
const personalError = ref<string | null>(null)
let personalLoadGeneration = 0

const optionalFeatures = reactive([
  { label: 'Notes', load: () => notes.load() },
  { label: 'Highlights', load: () => reader.loadHighlights() },
  { label: 'Reading plan', load: () => readingPlan.load() },
  { label: 'Study partner', load: () => aiProvider.load() },
  { label: 'Meaning search', load: () => semanticIndex.load() },
  { label: 'Read aloud', load: () => ttsProvider.load() },
  { label: 'Voice input', load: () => sttProvider.load() },
  { label: 'Chat history', load: () => chatConversations.load() }
].map((feature) => ({ ...feature, loading: false, error: null as string | null })))
type OptionalFeature = typeof optionalFeatures[number]
const degradedFeatures = computed(() => optionalFeatures.filter((feature) => feature.error !== null))

// Fall back to Read if the plan gets turned off while its (now-hidden) tab is active.
watch([() => ui.screen, () => readingPlan.enabled, personalReady], ([screen, enabled, ready]) => {
  if (ready && screen === 'plan' && !enabled) void router.replace({ name: 'read' })
})

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
function flushNoteDrafts(): void {
  notes.flushPending()
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') flushNoteDrafts()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('online', onOnline)
  window.addEventListener('pagehide', flushNoteDrafts)
  document.addEventListener('visibilitychange', onVisibilityChange)
  readingPlan.startClock()
  auth.initialize()
})
onUnmounted(() => {
  personalLoadGeneration += 1
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('online', onOnline)
  window.removeEventListener('pagehide', flushNoteDrafts)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  readingPlan.stopClock()
})

async function loadOptionalData(features: OptionalFeature[] = optionalFeatures): Promise<void> {
  const generation = personalLoadGeneration
  const userId = auth.user?.id
  const current = () => generation === personalLoadGeneration && auth.user?.id === userId
  await Promise.allSettled(features.map(async (feature) => {
    feature.loading = true
    try {
      await feature.load()
      if (current()) feature.error = null
    } catch (error) {
      // Report each failure immediately, even if another optional request is still pending.
      if (current()) feature.error = error instanceof Error ? error.message : 'Could not load this feature.'
      throw error
    } finally {
      if (current()) feature.loading = false
    }
  }))
}

function onOnline(): void {
  if (!auth.user) return
  void settings.restore()
  void reader.restorePosition()
}

async function loadPersonalData(userId: string): Promise<void> {
  const generation = ++personalLoadGeneration
  personalLoading.value = true
  personalReady.value = false
  personalError.value = null
  try {
    await settings.restore()
    if (generation !== personalLoadGeneration || auth.user?.id !== userId) return
    await initializeReader()
    if (generation === personalLoadGeneration && auth.user?.id === userId) {
      // These stores expose failures as state instead of rejecting their load promises.
      const essentialError = library.error ?? reader.error
      if (essentialError !== null) throw new Error(essentialError)
      personalReady.value = true
      void loadOptionalData()
    }
  } catch (error) {
    if (generation === personalLoadGeneration && auth.user?.id === userId) {
      personalError.value = error instanceof Error ? error.message : 'Could not load the reader.'
    }
  } finally {
    if (generation === personalLoadGeneration) personalLoading.value = false
  }
}

function retryPersonalData(): void {
  if (auth.state === 'error') {
    void auth.initialize()
    return
  }
  if (auth.user) void loadPersonalData(auth.user.id)
}

watch(
  () => library.installedBibles.map((module) => module.name).sort().join('|'),
  () => {
    if (personalReady.value && auth.user) void reader.reconcileInstalled()
  }
)

watch(
  () => auth.user?.id ?? null,
  (userId) => {
    invalidateAccountRequests()
    personalLoadGeneration += 1
    notes.activateUser(userId)
    library.resetPersonalData()
    settings.activateUser(userId)
    reader.activateUser(userId)
    aiProvider.reset()
    semanticIndex.reset()
    ttsProvider.reset()
    sttProvider.reset()
    chatConversations.reset()
    personalReady.value = false
    personalError.value = null
    for (const feature of optionalFeatures) {
      feature.loading = false
      feature.error = null
    }
    if (userId) void loadPersonalData(userId)
    else personalLoading.value = false
  },
  { flush: 'sync' }
)
</script>

<template>
  <div v-if="auth.state === 'loading' || (auth.authenticated && personalLoading)" class="loading-page">
    <div class="loading-mark"></div>
  </div>
  <div v-else-if="auth.state === 'error' || (auth.authenticated && (personalError || !personalReady))" class="personal-error-page">
    <div class="personal-error-card">
      <h1>{{ auth.state === 'error' ? 'Couldn’t load your session' : 'Couldn’t load your account data' }}</h1>
      <p>{{ auth.error ?? personalError ?? 'Personal data is not ready yet.' }}</p>
      <button @click="retryPersonalData">Try again</button>
    </div>
  </div>
  <AuthScreen v-else-if="!auth.authenticated" />
  <div v-else class="app-root">
    <RailNav />
    <main class="app-main">
      <div v-if="degradedFeatures.length" class="feature-errors" aria-label="Unavailable features">
        <div v-for="feature in degradedFeatures" :key="feature.label" class="feature-error" role="status">
          <span>{{ feature.label }} unavailable: {{ feature.error }}</span>
          <button :disabled="feature.loading" @click="loadOptionalData([feature])">
            {{ feature.loading ? 'Retrying…' : `Retry ${feature.label}` }}
          </button>
        </div>
      </div>
      <p v-if="notes.draftError" class="feature-error" role="alert">{{ notes.draftError }}</p>
      <div v-if="routeError" class="feature-errors" role="status">{{ routeError }}</div>
      <RouterView v-slot="{ Component }">
        <KeepAlive :key="auth.user?.id" include="SearchScreen">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
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
.feature-errors {
  flex-shrink: 0;
  max-height: 30dvh;
  overflow: auto;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--card);
  font-size: 13px;
}
.feature-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}
.feature-error span { overflow-wrap: anywhere; }
.feature-error button {
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 6px 10px;
  background: var(--paper);
  color: var(--ink);
  cursor: pointer;
}
.feature-error button:disabled { opacity: 0.65; cursor: default; }
@media (max-width: 768px) {
  .app-root {
    flex-direction: column-reverse;
  }
  .app-main {
    min-height: 0;
  }
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
