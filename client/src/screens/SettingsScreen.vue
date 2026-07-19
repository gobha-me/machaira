<script setup lang="ts">
import { ref } from 'vue'
import { useSettings } from '../stores/settings'
import { useReadingPlan } from '../stores/readingPlan'
import { useReader } from '../stores/reader'
import { ACCENTS } from '../theme'
import { exportAll } from '../services/db'
import Toggle from '../components/ui/Toggle.vue'

const settings = useSettings()
const readingPlan = useReadingPlan()
const reader = useReader()
const exporting = ref(false)

function resetPlan() {
  if (window.confirm('Reset reading-plan progress? This restarts the plan from today.')) {
    readingPlan.reset()
  }
}

async function doExport() {
  exporting.value = true
  try {
    const { markdown, json } = await exportAll()
    download('sword-journal.md', markdown, 'text/markdown')
    download('sword-journal.json', json, 'application/json')
  } finally {
    exporting.value = false
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
</script>

<template>
  <div class="scroll">
    <div class="wrap">
      <h1 class="serif">Settings</h1>

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
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Default translation</div>
            <div class="row-sub">Opens on a fresh start when no reading position is saved</div>
          </div>
          <div class="spacer"></div>
          <select
            class="setting-select"
            :value="settings.defaultModuleName ?? ''"
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
          <div class="row-text">
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
      <div class="section-label">Listening</div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Voice</div>
            <div class="row-sub">Read-aloud uses your browser’s built-in voices</div>
          </div>
          <div class="spacer"></div>
          <span class="pill">System default</span>
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

      <!-- Study partner (honest disabled) -->
      <div class="section-label">Study partner <span class="soon">not connected</span></div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Provider</div>
            <div class="row-sub">Any OpenAI-compatible endpoint, Claude, or local Llama</div>
          </div>
          <div class="spacer"></div>
          <span class="pill disabled">Add a provider</span>
        </div>
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Model</div>
            <div class="row-sub">Chat model from the provider above</div>
          </div>
          <div class="spacer"></div>
          <span class="pill disabled">—</span>
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

      <!-- Library & data -->
      <div class="section-label">Library &amp; data</div>
      <div class="card">
        <div class="row bordered">
          <div class="row-text">
            <div class="row-title">Vector index</div>
            <div class="row-sub">Meaning-based ranking — not built yet</div>
          </div>
          <div class="spacer"></div>
          <span class="pill disabled">Coming soon</span>
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
}
.row-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}
.spacer {
  flex: 1;
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
  max-width: 260px;
}
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
</style>
