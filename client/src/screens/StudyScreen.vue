<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { api, ApiError, type CompareRow, type StrongsPayload } from '../services/api'

const reader = useReader()
const ui = useUi()

const focus = ref<number>(1)
const rows = ref<CompareRow[]>([])
const comparing = ref(false)
const compareError = ref<string | null>(null)

const strongsKey = ref('')
const strongs = ref<StrongsPayload | null>(null)
const strongsError = ref<string | null>(null)
const strongsLoading = ref(false)

onMounted(async () => {
  if (!reader.ready) await reader.init()
  focus.value = reader.selectedVerse ?? 1
  await loadCompare()
})

watch(
  () => [reader.moduleName, reader.book, reader.chapter],
  () => loadCompare()
)

const installedNames = computed(() => reader.installedBibles.map((m) => m.name))

async function loadCompare() {
  if (!reader.book || installedNames.value.length === 0) {
    rows.value = []
    return
  }
  comparing.value = true
  compareError.value = null
  try {
    const res = await api.compare(reader.book, reader.chapter, focus.value, installedNames.value)
    rows.value = res.translations
  } catch (e) {
    compareError.value = (e as Error).message
    rows.value = []
  } finally {
    comparing.value = false
  }
}

async function setFocus(n: number) {
  focus.value = n
  reader.selectVerse(n)
  await loadCompare()
}

async function lookupStrongs() {
  const key = strongsKey.value.trim().toUpperCase()
  if (!/^[GH]\d+$/.test(key)) {
    strongsError.value = 'Enter a Strong’s number like G2638 or H0430.'
    strongs.value = null
    return
  }
  strongsLoading.value = true
  strongsError.value = null
  try {
    strongs.value = await api.strongs(key)
  } catch (e) {
    strongs.value = null
    strongsError.value =
      e instanceof ApiError && e.status === 409
        ? e.message
        : `No entry for ${key}.`
  } finally {
    strongsLoading.value = false
  }
}
</script>

<template>
  <div class="study">
    <!-- left: compare + word study -->
    <div class="left">
      <div class="topbar">
        <span class="ref">{{ reader.bookName }} {{ reader.chapter }}:{{ focus }}</span>
        <span class="sub">comparing {{ rows.length }} translation{{ rows.length === 1 ? '' : 's' }}</span>
        <div class="spacer"></div>
        <button class="back hover-ink" @click="ui.go('read')">← Back to reading</button>
      </div>

      <div class="scroll">
        <p v-if="compareError" class="error">{{ compareError }}</p>
        <div v-if="comparing" class="loading">Comparing…</div>

        <div v-else-if="rows.length" class="compare-card">
          <div v-for="(r, i) in rows" :key="r.module" class="compare-row" :class="{ last: i === rows.length - 1 }">
            <span class="tag" :style="{ color: i === 0 ? 'var(--accent)' : 'var(--muted)' }">{{ r.module }}</span>
            <span class="ctext serif">{{ r.text ?? '—' }}</span>
          </div>
        </div>
        <div v-else class="empty">
          Install more than one translation in the Library to compare renderings.
        </div>

        <!-- Word study (real Strong's lookup) -->
        <div class="section-label">Word study · Strong’s lexicon</div>
        <div class="strongs-box">
          <div class="strongs-input">
            <input
              v-model="strongsKey"
              class="focus-accent"
              placeholder="e.g. G2638"
              @keydown.enter="lookupStrongs"
            />
            <button class="lookup" @click="lookupStrongs">Look up</button>
          </div>
          <p v-if="strongsError" class="strongs-error">{{ strongsError }}</p>
          <div v-else-if="strongsLoading" class="loading">Looking up…</div>
          <div v-else-if="strongs" class="strongs-result">
            <div class="strongs-head">
              <span class="strongs-word serif">{{ strongs.transcription || strongs.key }}</span>
              <span class="strongs-phon">{{ strongs.phonetic }}</span>
              <span class="strongs-key">{{ strongs.key }}</span>
            </div>
            <div class="strongs-def">{{ strongs.definition }}</div>
          </div>
          <p v-else class="strongs-hint">
            Look up any Greek (G####) or Hebrew (H####) number. Requires the Strong’s modules from the Library.
          </p>
        </div>

        <!-- Context passage (real chapter text, click to refocus) -->
        <div class="section-label">Context · {{ reader.bookName }} {{ reader.chapter }}</div>
        <div v-if="reader.data" class="context serif">
          <span
            v-for="v in reader.data.verses"
            :key="v.n"
            class="cverse"
            :style="{ background: v.n === focus ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'transparent' }"
            @click="setFocus(v.n)"
          ><sup class="cvnum">{{ v.n }}</sup>{{ v.text }} </span>
        </div>
      </div>
    </div>

    <!-- right: study partner (honest disabled) -->
    <div class="partner">
      <div class="topbar">
        <div class="mark"></div>
        <span class="ptitle">Study partner</span>
        <div class="spacer"></div>
        <span class="sub">not connected</span>
      </div>
      <div class="partner-body">
        <div class="disabled-note">
          <div class="dn-title serif">Bring your own model</div>
          <p>
            The study partner talks to an LLM — any OpenAI-compatible endpoint, Claude, or a local
            model. Connect a provider in Settings to enable chat about this passage.
          </p>
          <button class="dn-btn" @click="ui.go('settings')">Open Settings →</button>
        </div>
      </div>
      <div class="composer">
        <input disabled placeholder="Connect a provider in Settings to chat" />
        <button disabled class="send">→</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.study {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.left {
  flex: 1.2;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
}
.topbar {
  height: 58px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 22px;
}
.ref {
  font-size: 14px;
  font-weight: 700;
}
.sub {
  font-size: 12px;
  color: var(--muted);
}
.spacer {
  flex: 1;
}
.back {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px 22px 60px;
}
.compare-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 16px;
}
.compare-row {
  display: flex;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.compare-row.last {
  border-bottom: none;
}
.tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  width: 52px;
  flex-shrink: 0;
  padding-top: 3px;
}
.ctext {
  font-size: 16.5px;
  line-height: 1.6;
}
.section-label {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 24px 0 12px;
}
.strongs-box {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 6px;
}
.strongs-input {
  display: flex;
  gap: 8px;
}
.strongs-input input {
  flex: 1;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--ink);
  outline: none;
}
.lookup {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.strongs-hint,
.strongs-error {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--muted);
  margin: 10px 0 0;
}
.strongs-error {
  color: var(--accent);
}
.strongs-result {
  margin-top: 12px;
}
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
.context {
  font-size: 16px;
  line-height: 1.8;
  text-wrap: pretty;
}
.cverse {
  cursor: pointer;
  border-radius: 3px;
  padding: 1px 2px;
}
.cvnum {
  font-size: 0.58em;
  color: var(--accent);
  font-weight: 600;
  margin-right: 3px;
  font-family: 'Instrument Sans', sans-serif;
}
.empty,
.loading {
  font-size: 13px;
  color: var(--muted);
  padding: 8px 0;
}
.error {
  font-size: 13px;
  color: var(--accent);
}
/* partner */
.partner {
  width: clamp(320px, 40vw, 430px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--card);
}
.mark {
  width: 8px;
  height: 8px;
  background: var(--accent);
  transform: rotate(45deg);
  flex-shrink: 0;
}
.ptitle {
  font-size: 14px;
  font-weight: 700;
}
.partner-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.disabled-note {
  text-align: center;
  max-width: 300px;
}
.dn-title {
  font-size: 18px;
  margin-bottom: 8px;
}
.disabled-note p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
  margin: 0 0 16px;
}
.dn-btn {
  background: none;
  border: 1px solid var(--accent);
  color: var(--accent);
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.composer {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.composer input {
  flex: 1;
  min-width: 0;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 13px;
  font-size: 13px;
  color: var(--muted);
  outline: none;
}
.send {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  font-size: 16px;
  opacity: 0.5;
}
.composer input:disabled,
.send:disabled {
  cursor: not-allowed;
}
</style>
