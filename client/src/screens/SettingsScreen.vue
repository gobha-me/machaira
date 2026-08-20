<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useSettings } from '../stores/settings'
import { useReadingPlan } from '../stores/readingPlan'
import { useReader } from '../stores/reader'
import { useNotes } from '../stores/notes'
import { useAuth } from '../stores/auth'
import { useAiProvider } from '../stores/aiProvider'
import { useSemanticIndex } from '../stores/semanticIndex'
import { useTtsProvider } from '../stores/ttsProvider'
import { useSttProvider } from '../stores/sttProvider'
import { ACCENTS } from '../theme'
import {
  exportAll,
  legacyImportComplete,
  legacyPersonalData,
  markLegacyImportComplete
} from '../services/db'
import {
  api,
  type AiProviderKind,
  type EmbeddingProviderKind,
  type Highlight,
  type Note,
  type SttEndpointInput,
  type SttProviderKind,
  type SttTier,
  type TtsEndpointInput,
  type TtsProviderKind,
  type TtsTier
} from '../services/api'
import Toggle from '../components/ui/Toggle.vue'
import AccountSettings from '../components/AccountSettings.vue'

const settings = useSettings()
const readingPlan = useReadingPlan()
const reader = useReader()
const notes = useNotes()
const auth = useAuth()
const aiProvider = useAiProvider()
const semanticIndex = useSemanticIndex()
const ttsProvider = useTtsProvider()
const sttProvider = useSttProvider()
const exporting = ref(false)
const importing = ref(false)
const importDone = ref(false)
const importMessage = ref('')
const legacyNotes = ref<Note[]>([])
const legacyHighlights = ref<Highlight[]>([])
const providerKind = ref<AiProviderKind>(aiProvider.provider?.kind ?? 'openai-compatible')
const providerBaseUrl = ref(aiProvider.provider?.baseUrl ?? 'https://api.openai.com/v1')
const providerModel = ref(aiProvider.provider?.model ?? '')
const providerApiKey = ref('')
const providerMessage = ref('')
const embeddingKind = ref<EmbeddingProviderKind>(semanticIndex.provider?.kind ?? 'openai-compatible')
const embeddingBaseUrl = ref(semanticIndex.provider?.baseUrl ?? 'https://api.openai.com/v1')
const embeddingModel = ref(semanticIndex.provider?.model ?? '')
const embeddingBatchSize = ref(semanticIndex.provider?.batchSize ?? 32)
const embeddingApiKey = ref('')
const embeddingMessage = ref('')
const browserTtsPriority = ref(priorityOf('browser'))
const localTtsPriority = ref(priorityOf('local'))
const cloudTtsPriority = ref(priorityOf('cloud'))
const localTtsBaseUrl = ref(ttsProvider.config.local?.baseUrl ?? 'http://127.0.0.1:8880/v1')
const localTtsModel = ref(ttsProvider.config.local?.model ?? 'kokoro')
const localTtsVoice = ref(ttsProvider.config.local?.voice ?? 'af_heart')
const localTtsApiKey = ref('')
const localTtsRemoved = ref(false)
const cloudTtsProvider = ref<TtsProviderKind>(ttsProvider.config.cloud?.provider ?? 'venice')
const cloudTtsBaseUrl = ref(ttsProvider.config.cloud?.baseUrl ?? 'https://api.venice.ai/api/v1')
const cloudTtsModel = ref(ttsProvider.config.cloud?.model ?? 'tts-kokoro')
const cloudTtsVoice = ref(ttsProvider.config.cloud?.voice ?? 'af_sky')
const cloudTtsApiKey = ref('')
const cloudTtsRemoved = ref(false)
const ttsMessage = ref('')
const browserSttPriority = ref(sttPriorityOf('browser'))
const localSttPriority = ref(sttPriorityOf('local'))
const cloudSttPriority = ref(sttPriorityOf('cloud'))
const localSttBaseUrl = ref(sttProvider.config.local?.baseUrl ?? 'http://127.0.0.1:8000/v1')
const localSttModel = ref(sttProvider.config.local?.model ?? 'Systran/faster-whisper-small')
const localSttApiKey = ref('')
const localSttRemoved = ref(false)
const cloudSttProvider = ref<SttProviderKind>(sttProvider.config.cloud?.provider ?? 'venice')
const cloudSttBaseUrl = ref(sttProvider.config.cloud?.baseUrl ?? 'https://api.venice.ai/api/v1')
const cloudSttModel = ref(sttProvider.config.cloud?.model ?? 'nvidia/parakeet-tdt-0.6b-v3')
const cloudSttApiKey = ref('')
const cloudSttRemoved = ref(false)
const sttMessage = ref('')
const checkingStt = ref<SttTier | null>(null)
const embeddingBatchSizeValid = computed(() => Number.isSafeInteger(embeddingBatchSize.value)
  && embeddingBatchSize.value >= 1 && embeddingBatchSize.value <= 64)
const defaultModuleLabel = computed(() => {
  if (!settings.defaultModuleName) return 'Automatic (WEB)'
  const module = reader.installedBibles.find((item) => item.name === settings.defaultModuleName)
  return module ? `${module.name} — ${module.description}` : settings.defaultModuleName
})

const PROVIDER_DEFAULTS: Record<AiProviderKind, string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  local: 'http://127.0.0.1:11434/v1'
}

const EMBEDDING_DEFAULTS: Record<EmbeddingProviderKind, string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  local: 'http://127.0.0.1:11434/v1'
}

function priorityOf(tier: TtsTier): number {
  const index = ttsProvider.config.order.indexOf(tier)
  return index < 0 ? 0 : index + 1
}

const ttsOrder = computed<TtsTier[]>(() => {
  const entries: { tier: TtsTier; priority: number }[] = [
    { tier: 'browser', priority: browserTtsPriority.value },
    { tier: 'local', priority: localTtsPriority.value },
    { tier: 'cloud', priority: cloudTtsPriority.value }
  ]
  return entries.filter((entry) => entry.priority > 0)
    .sort((a, b) => a.priority - b.priority)
    .map((entry) => entry.tier)
})

const ttsOrderValid = computed(() => {
  const enabled = [browserTtsPriority.value, localTtsPriority.value, cloudTtsPriority.value]
    .filter((priority) => priority > 0)
    .sort((a, b) => a - b)
  return new Set(enabled).size === enabled.length
    && enabled.every((priority, index) => priority === index + 1)
})

const localTtsComplete = computed(() => !!(
  localTtsBaseUrl.value.trim() && localTtsModel.value.trim() && localTtsVoice.value.trim()
))
const cloudTtsComplete = computed(() => !!(
  cloudTtsBaseUrl.value.trim() && cloudTtsModel.value.trim() && cloudTtsVoice.value.trim()
))
const cloudTtsKeyReady = computed(() => cloudTtsRemoved.value
  || (cloudTtsPriority.value === 0
    && !ttsProvider.config.cloud
    && !cloudTtsApiKey.value.trim())
  || !!cloudTtsApiKey.value.trim()
  || (ttsProvider.config.cloud?.hasApiKey === true
    && ttsProvider.config.cloud.provider === cloudTtsProvider.value
    && ttsProvider.config.cloud.baseUrl === cloudTtsBaseUrl.value.trim()))
const ttsReadyToSave = computed(() => ttsOrderValid.value
  && (localTtsPriority.value === 0 || localTtsComplete.value)
  && (cloudTtsPriority.value === 0 || cloudTtsComplete.value)
  && cloudTtsKeyReady.value)

function sttPriorityOf(tier: SttTier): number {
  const index = sttProvider.config.order.indexOf(tier)
  return index < 0 ? 0 : index + 1
}

const sttOrder = computed<SttTier[]>(() => {
  const entries: { tier: SttTier; priority: number }[] = [
    { tier: 'browser', priority: browserSttPriority.value },
    { tier: 'local', priority: localSttPriority.value },
    { tier: 'cloud', priority: cloudSttPriority.value }
  ]
  return entries.filter((entry) => entry.priority > 0)
    .sort((a, b) => a.priority - b.priority)
    .map((entry) => entry.tier)
})

const sttOrderValid = computed(() => {
  const enabled = [browserSttPriority.value, localSttPriority.value, cloudSttPriority.value]
    .filter((priority) => priority > 0)
    .sort((a, b) => a - b)
  return new Set(enabled).size === enabled.length
    && enabled.every((priority, index) => priority === index + 1)
})
const localSttComplete = computed(() => !!(localSttBaseUrl.value.trim() && localSttModel.value.trim()))
const cloudSttComplete = computed(() => !!(cloudSttBaseUrl.value.trim() && cloudSttModel.value.trim()))
const cloudSttKeyReady = computed(() => cloudSttRemoved.value
  || (cloudSttPriority.value === 0
    && !sttProvider.config.cloud
    && !cloudSttApiKey.value.trim())
  || !!cloudSttApiKey.value.trim()
  || (sttProvider.config.cloud?.hasApiKey === true
    && sttProvider.config.cloud.provider === cloudSttProvider.value
    && sttProvider.config.cloud.baseUrl === cloudSttBaseUrl.value.trim()))
const sttReadyToSave = computed(() => sttOrderValid.value
  && (localSttPriority.value === 0 || localSttComplete.value)
  && (cloudSttPriority.value === 0 || cloudSttComplete.value)
  && cloudSttKeyReady.value)

onMounted(async () => {
  const legacy = await legacyPersonalData()
  legacyNotes.value = legacy.notes
  legacyHighlights.value = legacy.highlights
  if (auth.user) importDone.value = legacyImportComplete(auth.user.id)
})

function resetPlan() {
  if (window.confirm('Reset reading-plan progress? This restarts the plan from today.')) {
    readingPlan.reset()
  }
}

async function doExport() {
  exporting.value = true
  try {
    const highlights = Object.entries(reader.highlights).map(([key, color]) => ({ key, color }))
    const { markdown, json } = await exportAll(notes.list, highlights)
    download('sword-journal.md', markdown, 'text/markdown')
    download('sword-journal.json', json, 'application/json')
  } finally {
    exporting.value = false
  }
}

async function importLegacyData() {
  if (!auth.user || importDone.value) return
  const noteCount = legacyNotes.value.length
  const highlightCount = legacyHighlights.value.length
  const confirmed = window.confirm(
    `Import ${noteCount} browser note${noteCount === 1 ? '' : 's'} and `
      + `${highlightCount} highlight${highlightCount === 1 ? '' : 's'} into ${auth.user.username}? `
      + 'Existing server records will not be overwritten.'
  )
  if (!confirmed) return
  importing.value = true
  importMessage.value = ''
  try {
    const result = await api.importPersonalData(legacyNotes.value, legacyHighlights.value)
    markLegacyImportComplete(auth.user.id)
    importDone.value = true
    importMessage.value = `Imported ${result.notesImported} notes and ${result.highlightsImported} highlights`
    await Promise.all([notes.load(), reader.loadHighlights()])
  } catch (error) {
    importMessage.value = `Import failed: ${(error as Error).message}`
  } finally {
    importing.value = false
  }
}

function inCompare(name: string): boolean {
  if (name === reader.effectiveDefaultModule) return true // default translation is always compared
  const s = settings.compareModuleNames
  return s === null ? true : s.includes(name) // null = all installed
}

function toggleCompare(name: string) {
  const installed = reader.installedBibles.map((m) => m.name)
  const current = settings.compareModuleNames ?? installed.slice() // materialize on first edit
  settings.setCompareModules(
    current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
  )
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function resetProviderEndpoint(): void {
  providerBaseUrl.value = PROVIDER_DEFAULTS[providerKind.value]
  providerApiKey.value = ''
  providerMessage.value = ''
}

async function saveProvider(): Promise<void> {
  providerMessage.value = ''
  try {
    await aiProvider.save({
      kind: providerKind.value,
      baseUrl: providerBaseUrl.value,
      model: providerModel.value,
      ...(providerApiKey.value.trim() ? { apiKey: providerApiKey.value.trim() } : {})
    })
    providerApiKey.value = ''
    providerMessage.value = 'Provider saved'
  } catch (error) {
    providerMessage.value = (error as Error).message
  }
}

async function removeProvider(): Promise<void> {
  if (!window.confirm('Disconnect this provider and delete its stored API key?')) return
  providerMessage.value = ''
  try {
    await aiProvider.remove()
    providerKind.value = 'openai-compatible'
    providerBaseUrl.value = PROVIDER_DEFAULTS['openai-compatible']
    providerModel.value = ''
    providerApiKey.value = ''
    providerMessage.value = 'Provider disconnected'
  } catch (error) {
    providerMessage.value = (error as Error).message
  }
}

function resetEmbeddingEndpoint(): void {
  embeddingBaseUrl.value = EMBEDDING_DEFAULTS[embeddingKind.value]
  embeddingApiKey.value = ''
  embeddingMessage.value = ''
}

async function saveEmbeddingProvider(): Promise<void> {
  embeddingMessage.value = ''
  try {
    await semanticIndex.save({
      kind: embeddingKind.value,
      baseUrl: embeddingBaseUrl.value,
      model: embeddingModel.value,
      batchSize: embeddingBatchSize.value,
      ...(embeddingApiKey.value.trim() ? { apiKey: embeddingApiKey.value.trim() } : {})
    })
    embeddingApiKey.value = ''
    embeddingMessage.value = semanticIndex.status.state === 'stale'
      ? 'Provider saved · rebuild required'
      : 'Embedding provider saved'
  } catch (error) {
    embeddingMessage.value = (error as Error).message
  }
}

async function removeEmbeddingProvider(): Promise<void> {
  if (!window.confirm('Disconnect the embedding provider and delete its stored API key?')) return
  embeddingMessage.value = ''
  try {
    await semanticIndex.remove()
    embeddingKind.value = 'openai-compatible'
    embeddingBaseUrl.value = EMBEDDING_DEFAULTS['openai-compatible']
    embeddingModel.value = ''
    embeddingBatchSize.value = 32
    embeddingApiKey.value = ''
    embeddingMessage.value = 'Embedding provider disconnected'
  } catch (error) {
    embeddingMessage.value = (error as Error).message
  }
}

function resetCloudTtsEndpoint(): void {
  if (cloudTtsProvider.value === 'venice') {
    cloudTtsBaseUrl.value = 'https://api.venice.ai/api/v1'
    cloudTtsModel.value = 'tts-kokoro'
    cloudTtsVoice.value = 'af_sky'
  } else {
    cloudTtsBaseUrl.value = 'https://api.openai.com/v1'
    cloudTtsModel.value = 'gpt-4o-mini-tts'
    cloudTtsVoice.value = 'alloy'
  }
  cloudTtsApiKey.value = ''
  cloudTtsRemoved.value = false
  ttsMessage.value = ''
}

function endpointInput(
  tier: 'local' | 'cloud'
): TtsEndpointInput | null {
  if (tier === 'local') {
    if (localTtsRemoved.value
      || (localTtsPriority.value === 0 && !ttsProvider.config.local && !localTtsApiKey.value.trim())
      || (!localTtsComplete.value && !ttsProvider.config.local)) return null
    return {
      provider: 'openai-compatible',
      baseUrl: localTtsBaseUrl.value,
      model: localTtsModel.value,
      voice: localTtsVoice.value,
      ...(localTtsApiKey.value.trim() ? { apiKey: localTtsApiKey.value.trim() } : {})
    }
  }
  if (cloudTtsRemoved.value
    || (cloudTtsPriority.value === 0 && !ttsProvider.config.cloud && !cloudTtsApiKey.value.trim())
    || (!cloudTtsComplete.value && !ttsProvider.config.cloud)) return null
  return {
    provider: cloudTtsProvider.value,
    baseUrl: cloudTtsBaseUrl.value,
    model: cloudTtsModel.value,
    voice: cloudTtsVoice.value,
    ...(cloudTtsApiKey.value.trim() ? { apiKey: cloudTtsApiKey.value.trim() } : {})
  }
}

async function saveTtsConfig(): Promise<void> {
  ttsMessage.value = ''
  try {
    await ttsProvider.save({
      order: ttsOrder.value,
      local: endpointInput('local'),
      cloud: endpointInput('cloud')
    })
    localTtsApiKey.value = ''
    cloudTtsApiKey.value = ''
    localTtsRemoved.value = false
    cloudTtsRemoved.value = false
    ttsMessage.value = 'Read-aloud providers saved'
  } catch (error) {
    ttsMessage.value = (error as Error).message
  }
}

function removeLocalTts(): void {
  localTtsPriority.value = 0
  localTtsRemoved.value = true
  localTtsApiKey.value = ''
  ttsMessage.value = 'Save to remove the local provider and its key'
}

function removeCloudTts(): void {
  cloudTtsPriority.value = 0
  cloudTtsRemoved.value = true
  cloudTtsApiKey.value = ''
  ttsMessage.value = 'Save to remove the cloud provider and its key'
}

function resetCloudSttEndpoint(): void {
  if (cloudSttProvider.value === 'venice') {
    cloudSttBaseUrl.value = 'https://api.venice.ai/api/v1'
    cloudSttModel.value = 'nvidia/parakeet-tdt-0.6b-v3'
  } else {
    cloudSttBaseUrl.value = 'https://api.openai.com/v1'
    cloudSttModel.value = 'gpt-4o-mini-transcribe'
  }
  cloudSttApiKey.value = ''
  cloudSttRemoved.value = false
  sttMessage.value = ''
}

function sttEndpointInput(tier: 'local' | 'cloud'): SttEndpointInput | null {
  if (tier === 'local') {
    if (localSttRemoved.value
      || (localSttPriority.value === 0 && !sttProvider.config.local && !localSttApiKey.value.trim())
      || (!localSttComplete.value && !sttProvider.config.local)) return null
    return {
      provider: 'openai-compatible',
      baseUrl: localSttBaseUrl.value,
      model: localSttModel.value,
      ...(localSttApiKey.value.trim() ? { apiKey: localSttApiKey.value.trim() } : {})
    }
  }
  if (cloudSttRemoved.value
    || (cloudSttPriority.value === 0 && !sttProvider.config.cloud && !cloudSttApiKey.value.trim())
    || (!cloudSttComplete.value && !sttProvider.config.cloud)) return null
  return {
    provider: cloudSttProvider.value,
    baseUrl: cloudSttBaseUrl.value,
    model: cloudSttModel.value,
    ...(cloudSttApiKey.value.trim() ? { apiKey: cloudSttApiKey.value.trim() } : {})
  }
}

async function checkStt(tier: 'local' | 'cloud'): Promise<void> {
  const endpoint = sttEndpointInput(tier)
  if (!endpoint) return
  checkingStt.value = tier
  sttMessage.value = ''
  try {
    const result = await api.checkStt(tier, endpoint)
    sttMessage.value = result.message
  } catch (error) {
    sttMessage.value = (error as Error).message
  } finally {
    checkingStt.value = null
  }
}

async function saveSttConfig(): Promise<void> {
  sttMessage.value = ''
  if (sttOrder.value.includes('cloud') && !sttProvider.config.order.includes('cloud')) {
    const confirmed = window.confirm(
      'Enable cloud voice input? Microphone recordings will be sent to the configured cloud provider '
      + 'when Cloud STT is reached in this saved order.'
    )
    if (!confirmed) return
  }
  try {
    await sttProvider.save({
      order: sttOrder.value,
      local: sttEndpointInput('local'),
      cloud: sttEndpointInput('cloud')
    })
    localSttApiKey.value = ''
    cloudSttApiKey.value = ''
    localSttRemoved.value = false
    cloudSttRemoved.value = false
    sttMessage.value = 'Voice-input providers saved'
  } catch (error) {
    sttMessage.value = (error as Error).message
  }
}

function removeLocalStt(): void {
  localSttPriority.value = 0
  localSttRemoved.value = true
  localSttApiKey.value = ''
  sttMessage.value = 'Save to remove the local provider and its key'
}

function removeCloudStt(): void {
  cloudSttPriority.value = 0
  cloudSttRemoved.value = true
  cloudSttApiKey.value = ''
  sttMessage.value = 'Save to remove the cloud provider and its key'
}

async function rebuildSemanticIndex(): Promise<void> {
  if (!window.confirm(
    'Rebuild the semantic index? Every installed Bible verse will be sent to your embedding '
      + 'provider in batches. External providers may charge for this usage.'
  )) return
  embeddingMessage.value = ''
  try {
    await semanticIndex.rebuild()
    const batch = semanticIndex.effectiveBatchSize
      ? ` · batches up to ${semanticIndex.effectiveBatchSize}`
      : ''
    embeddingMessage.value = `Indexed ${semanticIndex.status.chunkCount.toLocaleString()} verses${batch}`
  } catch (error) {
    embeddingMessage.value = `Rebuild failed: ${(error as Error).message}`
  }
}
</script>

<template>
  <div class="scroll">
    <div class="wrap">
      <h1 class="serif">Settings</h1>

      <AccountSettings />

      <!-- Appearance -->
      <div class="section-label">Appearance</div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Theme</div>
            <div class="row-sub">Paper for daylight, ink for evenings</div>
          </div>
          <div class="spacer"></div>
          <div class="segmented">
            <button
              v-for="t in (['paper', 'ink'] as const)"
              :key="t"
              class="seg"
              :style="{
                background: settings.theme === t ? 'var(--accent)' : 'transparent',
                color: settings.theme === t ? 'var(--on-accent)' : 'var(--muted)'
              }"
              @click="settings.setTheme(t)"
            >{{ t === 'paper' ? 'Paper' : 'Ink' }}</button>
          </div>
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">Accent</div>
            <div class="row-sub">Verse numbers, highlights, and actions</div>
          </div>
          <div class="spacer"></div>
          <div class="swatches">
            <button
              v-for="c in ACCENTS"
              :key="c"
              class="swatch"
              :title="c"
              :style="{ background: c, boxShadow: c === settings.accent ? '0 0 0 2px var(--card), 0 0 0 4px var(--ink)' : '0 0 0 1px var(--line)' }"
              @click="settings.setAccent(c)"
            ></button>
          </div>
        </div>
      </div>

      <!-- Reading -->
      <div class="section-label">Reading</div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Scripture text size</div>
            <div class="row-sub">Applies to the reader and study panes</div>
          </div>
          <div class="spacer"></div>
          <div class="stepper">
            <button class="step hover-soft" @click="settings.bumpTextScale(-0.05)">–</button>
            <span class="step-val">{{ settings.textScalePct }}</span>
            <button class="step hover-soft" @click="settings.bumpTextScale(0.05)">+</button>
          </div>
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Extra letter &amp; word spacing</div>
            <div class="row-sub">Easier tracking for tired or dyslexic eyes</div>
          </div>
          <div class="spacer"></div>
          <Toggle :model-value="settings.extraSpacing" @update:model-value="settings.toggle('extraSpacing')" />
        </div>
        <div class="row bordered translation-default-row">
          <div class="row-text">
            <div class="row-title">Default translation</div>
            <div class="row-sub">Opens on a fresh start when no reading position is saved</div>
          </div>
          <div class="spacer"></div>
          <select
            class="setting-select"
            :value="settings.defaultModuleName ?? ''"
            :title="defaultModuleLabel"
            aria-label="Default translation"
            @change="settings.setDefaultModule(($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">Automatic (WEB)</option>
            <option v-for="m in reader.installedBibles" :key="m.name" :value="m.name">
              {{ m.name }} — {{ m.description }}
            </option>
          </select>
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">Footnotes</div>
            <div class="row-sub">Show translators’ notes inline and collected under each chapter</div>
          </div>
          <div class="spacer"></div>
          <Toggle :model-value="settings.showFootnotes" @update:model-value="settings.toggle('showFootnotes')" />
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">Strong’s numbers</div>
            <div class="row-sub">Tap a word to open its lexicon entry — on tagged translations (e.g. KJVA)</div>
          </div>
          <div class="spacer"></div>
          <Toggle :model-value="settings.showStrongs" @update:model-value="settings.toggle('showStrongs')" />
        </div>
      </div>

      <!-- Compare -->
      <div class="section-label">Compare</div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Translations to compare</div>
            <div class="row-sub">
              Which translations appear side-by-side in Compare. Your reading translation is
              always included.
            </div>
          </div>
        </div>
        <div
          v-for="(m, i) in reader.installedBibles"
          :key="m.name"
          class="row"
          :class="{ bordered: i < reader.installedBibles.length - 1 }"
        >
          <div class="row-text" :title="`${m.name} — ${m.description}`">
            <div class="row-title">
              {{ m.name }}
              <span v-if="m.name === reader.effectiveDefaultModule" class="badge">Primary</span>
            </div>
            <div class="row-sub">{{ m.description }}</div>
          </div>
          <div class="spacer"></div>
          <Toggle
            :model-value="inCompare(m.name)"
            :disabled="m.name === reader.effectiveDefaultModule"
            @update:model-value="toggleCompare(m.name)"
          />
        </div>
      </div>

      <!-- Listening -->
      <div class="section-label">
        Listening
        <span class="soon">{{ ttsOrder.length ? ttsOrder.join(' → ') : 'disabled' }}</span>
      </div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Browser voice</div>
            <div class="row-sub">Uses the browser or operating system speech service when available</div>
          </div>
          <div class="spacer"></div>
          <select v-model.number="browserTtsPriority" class="setting-select priority-select" aria-label="Browser voice priority">
            <option :value="0">Disabled</option>
            <option :value="1">First</option>
            <option :value="2">Second</option>
            <option :value="3">Third</option>
          </select>
        </div>
        <div class="row bordered provider-heading">
          <div class="row-text">
            <div class="row-title">Local TTS</div>
            <div class="row-sub">Text stays on the configured local network or Kubernetes sidecar</div>
          </div>
          <div class="spacer"></div>
          <select v-model.number="localTtsPriority" class="setting-select priority-select" aria-label="Local TTS priority" @change="localTtsRemoved = false">
            <option :value="0">Disabled</option>
            <option :value="1">First</option>
            <option :value="2">Second</option>
            <option :value="3">Third</option>
          </select>
        </div>
        <div class="row bordered compact-provider-row">
          <input v-model="localTtsBaseUrl" class="provider-input provider-url" type="url" aria-label="Local TTS base URL" />
          <input v-model="localTtsModel" class="provider-input" placeholder="Model" aria-label="Local TTS model" />
          <input v-model="localTtsVoice" class="provider-input" placeholder="Voice" aria-label="Local TTS voice" />
        </div>
        <div class="row bordered compact-provider-row">
          <input
            v-model="localTtsApiKey"
            class="provider-input provider-key"
            type="password"
            autocomplete="off"
            :placeholder="ttsProvider.config.local?.hasApiKey ? 'Encrypted key stored — blank keeps it' : 'Optional local API key'"
            aria-label="Local TTS API key"
          />
          <button
            v-if="ttsProvider.config.local && !localTtsRemoved"
            class="pill action danger"
            type="button"
            @click="removeLocalTts"
          >Remove local</button>
        </div>
        <div class="row bordered provider-heading">
          <div class="row-text">
            <div class="row-title">Cloud TTS</div>
            <div class="row-sub">Enabled only through this explicit priority list; verse text is sent to the selected provider</div>
          </div>
          <div class="spacer"></div>
          <select v-model.number="cloudTtsPriority" class="setting-select priority-select" aria-label="Cloud TTS priority" @change="cloudTtsRemoved = false">
            <option :value="0">Disabled</option>
            <option :value="1">First</option>
            <option :value="2">Second</option>
            <option :value="3">Third</option>
          </select>
        </div>
        <div class="row bordered compact-provider-row">
          <select v-model="cloudTtsProvider" class="setting-select" @change="resetCloudTtsEndpoint">
            <option value="venice">Venice</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
          <input v-model="cloudTtsBaseUrl" class="provider-input provider-url" type="url" aria-label="Cloud TTS base URL" />
        </div>
        <div class="row bordered compact-provider-row">
          <input v-model="cloudTtsModel" class="provider-input" placeholder="Model" aria-label="Cloud TTS model" />
          <input v-model="cloudTtsVoice" class="provider-input" placeholder="Voice" aria-label="Cloud TTS voice" />
          <input
            v-model="cloudTtsApiKey"
            class="provider-input provider-key"
            type="password"
            autocomplete="off"
            :placeholder="ttsProvider.config.cloud?.hasApiKey ? 'Encrypted key stored' : 'API key'"
            aria-label="Cloud TTS API key"
          />
          <button
            v-if="ttsProvider.config.cloud && !cloudTtsRemoved"
            class="pill action danger"
            type="button"
            @click="removeCloudTts"
          >Remove cloud</button>
        </div>
        <div v-if="!ttsOrderValid" class="row bordered provider-warning" role="alert">
          Enabled providers need unique, consecutive priorities beginning with First.
        </div>
        <div class="row bordered provider-actions">
          <span class="provider-message" :class="{ failed: ttsProvider.error || !ttsOrderValid }">{{ ttsMessage }}</span>
          <div class="spacer"></div>
          <button
            class="pill action save-provider"
            :disabled="ttsProvider.loading || !ttsReadyToSave"
            @click="saveTtsConfig"
          >{{ ttsProvider.loading ? 'Saving…' : 'Save read-aloud' }}</button>
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">Follow along</div>
            <div class="row-sub">Highlight each verse as it’s read aloud</div>
          </div>
          <div class="spacer"></div>
          <Toggle :model-value="settings.followAlong" @update:model-value="settings.toggle('followAlong')" />
        </div>
      </div>

      <!-- Voice input -->
      <div class="section-label">
        Voice input
        <span class="soon">{{ sttOrder.length ? sttOrder.join(' → ') : 'disabled' }}</span>
      </div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Browser recognition</div>
            <div class="row-sub">Uses the browser’s recognition service when genuinely available; the browser vendor may process audio remotely</div>
          </div>
          <div class="spacer"></div>
          <select v-model.number="browserSttPriority" class="setting-select priority-select" aria-label="Browser STT priority">
            <option :value="0">Disabled</option>
            <option :value="1">First</option>
            <option :value="2">Second</option>
            <option :value="3">Third</option>
          </select>
        </div>
        <div class="row bordered provider-heading">
          <div class="row-text">
            <div class="row-title">Local STT</div>
            <div class="row-sub">Records in this browser, then sends audio only to the configured local network or private sidecar</div>
          </div>
          <div class="spacer"></div>
          <select v-model.number="localSttPriority" class="setting-select priority-select" aria-label="Local STT priority" @change="localSttRemoved = false">
            <option :value="0">Disabled</option>
            <option :value="1">First</option>
            <option :value="2">Second</option>
            <option :value="3">Third</option>
          </select>
        </div>
        <div class="row bordered compact-provider-row">
          <input v-model="localSttBaseUrl" class="provider-input provider-url" type="url" aria-label="Local STT base URL" />
          <input v-model="localSttModel" class="provider-input" placeholder="Model" aria-label="Local STT model" />
        </div>
        <div class="row bordered compact-provider-row">
          <input
            v-model="localSttApiKey"
            class="provider-input provider-key"
            type="password"
            autocomplete="off"
            :placeholder="sttProvider.config.local?.hasApiKey ? 'Encrypted key stored — blank keeps it' : 'Optional local API key'"
            aria-label="Local STT API key"
          />
          <button class="pill action" type="button" :disabled="checkingStt !== null || !localSttComplete" @click="checkStt('local')">
            {{ checkingStt === 'local' ? 'Testing…' : 'Test local' }}
          </button>
          <button
            v-if="sttProvider.config.local && !localSttRemoved"
            class="pill action danger"
            type="button"
            @click="removeLocalStt"
          >Remove local</button>
        </div>
        <div class="row bordered provider-heading">
          <div class="row-text">
            <div class="row-title">Cloud STT</div>
            <div class="row-sub">Microphone audio leaves this deployment only when this tier is explicitly present in the saved order</div>
          </div>
          <div class="spacer"></div>
          <select v-model.number="cloudSttPriority" class="setting-select priority-select" aria-label="Cloud STT priority" @change="cloudSttRemoved = false">
            <option :value="0">Disabled</option>
            <option :value="1">First</option>
            <option :value="2">Second</option>
            <option :value="3">Third</option>
          </select>
        </div>
        <div class="row bordered compact-provider-row">
          <select v-model="cloudSttProvider" class="setting-select" aria-label="Cloud STT provider" @change="resetCloudSttEndpoint">
            <option value="venice">Venice</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
          <input v-model="cloudSttBaseUrl" class="provider-input provider-url" type="url" aria-label="Cloud STT base URL" />
        </div>
        <div class="row bordered compact-provider-row">
          <input v-model="cloudSttModel" class="provider-input" placeholder="Model" aria-label="Cloud STT model" />
          <input
            v-model="cloudSttApiKey"
            class="provider-input provider-key"
            type="password"
            autocomplete="off"
            :placeholder="sttProvider.config.cloud?.hasApiKey ? 'Encrypted key stored' : 'API key'"
            aria-label="Cloud STT API key"
          />
          <button class="pill action" type="button" :disabled="checkingStt !== null || !cloudSttComplete || !cloudSttKeyReady" @click="checkStt('cloud')">
            {{ checkingStt === 'cloud' ? 'Testing…' : 'Test cloud' }}
          </button>
          <button
            v-if="sttProvider.config.cloud && !cloudSttRemoved"
            class="pill action danger"
            type="button"
            @click="removeCloudStt"
          >Remove cloud</button>
        </div>
        <div v-if="!sttOrderValid" class="row bordered provider-warning" role="alert">
          Enabled providers need unique, consecutive priorities beginning with First.
        </div>
        <div class="row provider-actions">
          <span class="provider-message" :class="{ failed: sttProvider.error || !sttOrderValid }">{{ sttMessage }}</span>
          <div class="spacer"></div>
          <button
            class="pill action save-provider"
            :disabled="sttProvider.loading || checkingStt !== null || !sttReadyToSave"
            @click="saveSttConfig"
          >{{ sttProvider.loading ? 'Saving…' : 'Save voice input' }}</button>
        </div>
      </div>

      <!-- Reading plan -->
      <div class="section-label">Reading plan</div>
      <div class="card">
        <div class="row" :class="{ bordered: readingPlan.enabled }">
          <div class="row-text">
            <div class="row-title">Bible in a year</div>
            <div class="row-sub">Read Genesis to Revelation over 365 days — adds a Plan tab and a card in Read</div>
          </div>
          <div class="spacer"></div>
          <Toggle :model-value="readingPlan.enabled" @update:model-value="readingPlan.toggle()" />
        </div>
        <div v-if="readingPlan.enabled" class="row">
          <div class="row-text">
            <div class="row-title">Progress</div>
            <div class="row-sub">
              Day {{ readingPlan.currentDay }} of 365 · {{ readingPlan.chaptersRead }} of
              {{ readingPlan.totalChapters }} chapters read
            </div>
          </div>
          <div class="spacer"></div>
          <button class="pill action hover-line" @click="resetPlan">Reset</button>
        </div>
      </div>

      <!-- Study partner -->
      <div class="section-label">
        Study partner
        <span class="soon">{{ aiProvider.provider ? 'connected' : 'not connected' }}</span>
      </div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Provider</div>
            <div class="row-sub">Any OpenAI-compatible endpoint, Claude, or local Llama</div>
          </div>
          <div class="spacer"></div>
          <select v-model="providerKind" class="setting-select" @change="resetProviderEndpoint">
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
            <option value="local">Local</option>
          </select>
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Base URL</div>
            <div class="row-sub">Resolved by the Sword server, including inside containers</div>
          </div>
          <div class="spacer"></div>
          <input v-model="providerBaseUrl" class="provider-input provider-url" type="url" />
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Model</div>
            <div class="row-sub">Exact model identifier expected by this provider</div>
          </div>
          <div class="spacer"></div>
          <input v-model="providerModel" class="provider-input" placeholder="Model name" />
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">API key</div>
            <div class="row-sub">
              <template v-if="aiProvider.provider?.hasApiKey">Encrypted key stored — leave blank to keep it</template>
              <template v-else-if="providerKind === 'local'">Optional for a local endpoint</template>
              <template v-else>Stored encrypted on the server</template>
            </div>
          </div>
          <div class="spacer"></div>
          <input
            v-model="providerApiKey"
            class="provider-input"
            type="password"
            autocomplete="off"
            :placeholder="aiProvider.provider?.hasApiKey ? '••••••••' : 'API key'"
          />
        </div>
        <div class="row bordered provider-actions">
          <span class="provider-message" :class="{ failed: aiProvider.error }">{{ providerMessage }}</span>
          <div class="spacer"></div>
          <button
            v-if="aiProvider.provider"
            class="pill action danger"
            :disabled="aiProvider.loading"
            @click="removeProvider"
          >Disconnect</button>
          <button
            class="pill action save-provider"
            :disabled="aiProvider.loading || !providerModel.trim() || !providerBaseUrl.trim()"
            @click="saveProvider"
          >{{ aiProvider.loading ? 'Saving…' : 'Save provider' }}</button>
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Draw on the apocrypha</div>
            <div class="row-sub">Include non-canonical sources in answers, always labeled</div>
          </div>
          <div class="spacer"></div>
          <Toggle :model-value="settings.drawApocrypha" @update:model-value="settings.toggle('drawApocrypha')" />
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">Always cite</div>
            <div class="row-sub">Every claim links to a passage in your library</div>
          </div>
          <div class="spacer"></div>
          <Toggle :model-value="settings.alwaysCite" @update:model-value="settings.toggle('alwaysCite')" />
        </div>
      </div>

      <!-- Semantic search -->
      <div class="section-label">
        Semantic search
        <span class="soon">{{ semanticIndex.status.state }}</span>
      </div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Vector index</div>
            <div class="row-sub">
              {{ semanticIndex.statusText }}
              <template v-if="semanticIndex.status.model"> · {{ semanticIndex.status.model }}</template>
            </div>
          </div>
          <div class="spacer"></div>
          <button
            class="pill action hover-line"
            :disabled="semanticIndex.building || !semanticIndex.provider"
            @click="rebuildSemanticIndex"
          >{{ semanticIndex.building ? 'Rebuilding…' : semanticIndex.status.chunkCount ? 'Rebuild' : 'Build index' }}</button>
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Embedding provider</div>
            <div class="row-sub">OpenAI-compatible API or a local embeddings server</div>
          </div>
          <div class="spacer"></div>
          <select v-model="embeddingKind" class="setting-select" @change="resetEmbeddingEndpoint">
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="local">Local</option>
          </select>
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Embedding base URL</div>
            <div class="row-sub">The Sword server calls its /embeddings endpoint</div>
          </div>
          <div class="spacer"></div>
          <input v-model="embeddingBaseUrl" class="provider-input provider-url" type="url" />
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Embedding model</div>
            <div class="row-sub">Use a model intended for semantic similarity</div>
          </div>
          <div class="spacer"></div>
          <input v-model="embeddingModel" class="provider-input" placeholder="Embedding model" />
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Rebuild batch size</div>
            <div class="row-sub">Maximum verses per provider request (1–64); oversized batches retry smaller</div>
          </div>
          <div class="spacer"></div>
          <input
            v-model.number="embeddingBatchSize"
            class="provider-input batch-size-input"
            type="number"
            min="1"
            max="64"
            step="1"
            inputmode="numeric"
            aria-label="Embedding rebuild batch size"
          />
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Embedding API key</div>
            <div class="row-sub">
              <template v-if="semanticIndex.provider?.hasApiKey">Encrypted key stored — leave blank to keep it</template>
              <template v-else-if="embeddingKind === 'local'">Optional for a local endpoint</template>
              <template v-else>Stored encrypted on the server</template>
            </div>
          </div>
          <div class="spacer"></div>
          <input
            v-model="embeddingApiKey"
            class="provider-input"
            type="password"
            autocomplete="off"
            :placeholder="semanticIndex.provider?.hasApiKey ? '••••••••' : 'API key'"
          />
        </div>
        <div class="row provider-actions">
          <span class="provider-message" :class="{ failed: semanticIndex.error }">{{ embeddingMessage }}</span>
          <div class="spacer"></div>
          <button
            v-if="semanticIndex.provider"
            class="pill action danger"
            :disabled="semanticIndex.loading || semanticIndex.building"
            @click="removeEmbeddingProvider"
          >Disconnect</button>
          <button
            class="pill action save-provider"
            :disabled="semanticIndex.loading || semanticIndex.building || !embeddingModel.trim() || !embeddingBaseUrl.trim() || !embeddingBatchSizeValid"
            @click="saveEmbeddingProvider"
          >{{ semanticIndex.loading ? 'Saving…' : 'Save embedding provider' }}</button>
        </div>
      </div>

      <!-- Library & data -->
      <div class="section-label">Library &amp; data</div>
      <div class="card">
        <div
          v-if="legacyNotes.length || legacyHighlights.length"
          class="row bordered"
        >
          <div class="row-text">
            <div class="row-title">Legacy browser data</div>
            <div class="row-sub">
              {{ legacyNotes.length }} notes and {{ legacyHighlights.length }} highlights found in this browser.
              <template v-if="importMessage"> {{ importMessage }}.</template>
              <template v-else-if="importDone"> Already imported for {{ auth.user?.username }}.</template>
            </div>
          </div>
          <div class="spacer"></div>
          <button
            class="pill action hover-line"
            :disabled="importing || importDone"
            @click="importLegacyData"
          >
            {{ importing ? 'Importing…' : importDone ? 'Imported' : `Import into ${auth.user?.username}` }}
          </button>
        </div>
        <div class="row">
          <div class="row-text">
            <div class="row-title">Export everything</div>
            <div class="row-sub">Notes and highlights as Markdown + JSON — yours, portable</div>
          </div>
          <div class="spacer"></div>
          <button class="pill action hover-line" :disabled="exporting" @click="doExport">
            {{ exporting ? 'Exporting…' : 'Export' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scroll {
  flex: 1;
  overflow-y: auto;
}
.wrap {
  max-width: 640px;
  margin: 0 auto;
  padding: 64px 32px 100px;
}
h1 {
  font-weight: 500;
  font-size: 34px;
  margin: 0 0 36px;
}
.section-label {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
.soon {
  letter-spacing: 0;
  text-transform: none;
  color: var(--muted);
  font-weight: 400;
  margin-left: 6px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 30px;
}
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px 18px;
}
.row.bordered {
  border-bottom: 1px solid var(--line);
}
.row-title {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.row-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.row-text {
  min-width: 0;
}
.spacer {
  flex: 1;
  min-width: 0;
}
.segmented {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.seg {
  border: none;
  cursor: pointer;
  padding: 8px 16px;
  font-size: 12.5px;
  font-weight: 600;
}
.swatches {
  display: flex;
  gap: 10px;
  align-items: center;
}
.swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
}
.stepper {
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.step {
  background: none;
  border: none;
  cursor: pointer;
  padding: 8px 13px;
  font-size: 15px;
  color: var(--ink);
}
.step-val {
  font-size: 12.5px;
  font-weight: 700;
  min-width: 48px;
  text-align: center;
}
.pill {
  background: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 13px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.badge {
  margin-left: 7px;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--soft);
  border: 1px solid var(--line);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  vertical-align: middle;
}
.setting-select {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 13px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
  width: min(260px, 42vw);
  min-width: 0;
  max-width: 260px;
  text-overflow: ellipsis;
}
.provider-input {
  width: 220px;
  box-sizing: border-box;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 11px;
  color: var(--ink);
  font: inherit;
  font-size: 12.5px;
}
.provider-url { width: 270px; }
.batch-size-input { width: 88px; }
.provider-input:focus { outline: none; border-color: var(--accent); }
.priority-select { min-width: 92px; }
.provider-heading { background: color-mix(in srgb, var(--soft) 42%, transparent); }
.compact-provider-row { align-items: stretch; flex-wrap: wrap; }
.compact-provider-row .provider-input { flex: 1 1 130px; width: auto; }
.compact-provider-row .provider-url { flex-basis: 260px; }
.compact-provider-row .provider-key { flex-basis: 220px; }
.provider-warning { color: var(--accent); font-size: 12px; }
.provider-actions { gap: 8px; }
.provider-message { font-size: 12px; color: var(--muted); }
.provider-message.failed { color: var(--accent); }
.save-provider { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.danger { color: var(--accent); }
.pill.disabled {
  color: var(--muted);
  opacity: 0.7;
}
.pill.action {
  cursor: pointer;
}
.pill.action:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (max-width: 560px) {
  .wrap {
    padding: 36px 16px 80px;
  }
  .row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .provider-input,
  .provider-url {
    width: 100%;
  }
  .provider-actions {
    width: 100%;
    flex-wrap: wrap;
  }
  .translation-default-row {
    align-items: stretch;
    flex-direction: column;
  }
  .translation-default-row .spacer {
    display: none;
  }
  .setting-select {
    width: 100%;
    max-width: none;
  }
}
</style>
