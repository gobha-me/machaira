<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
  filterDiscoveryChoices,
  isStaleDiscoveryChoice,
  type DiscoveryChoice
} from './discoveryChoices'

export type { DiscoveryChoice } from './discoveryChoices'

const props = withDefaults(defineProps<{
  id: string
  modelValue: string
  options: DiscoveryChoice[]
  loaded: boolean
  loading?: boolean
  label: string
  placeholder?: string
}>(), {
  loading: false,
  placeholder: 'Enter an ID or load available options'
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  select: [value: string]
  commit: [value: string]
}>()

const open = ref(false)
const activeIndex = ref(-1)
const query = ref('')
const editing = ref(false)
const input = ref<HTMLInputElement | null>(null)
const listboxId = `discovery-${Math.random().toString(36).slice(2)}`

const filtered = computed(() => {
  return filterDiscoveryChoices(props.options, editing.value ? query.value : '')
})

const confirmed = computed(() => filtered.value.filter((choice) => choice.compatibility === 'confirmed'))
const unknown = computed(() => filtered.value.filter((choice) => choice.compatibility === 'unknown'))
const stale = computed(() => isStaleDiscoveryChoice(props.options, props.modelValue, props.loaded))

function update(value: string): void {
  query.value = value
  editing.value = true
  emit('update:modelValue', value)
  open.value = true
  activeIndex.value = -1
}

function select(choice: DiscoveryChoice): void {
  emit('update:modelValue', choice.id)
  emit('select', choice.id)
  open.value = false
  activeIndex.value = -1
  query.value = ''
  editing.value = false
}

function commitManual(): void {
  if (!editing.value) return
  const value = query.value.trim()
  if (value !== props.modelValue) emit('update:modelValue', value)
  emit('commit', value)
  query.value = ''
  editing.value = false
}

function toggle(): void {
  if (!props.options.length) return
  open.value = !open.value
  query.value = ''
  editing.value = false
  activeIndex.value = open.value ? 0 : -1
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    open.value = false
    activeIndex.value = -1
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
  if (!open.value) {
    if (!filtered.value.length) return
    query.value = ''
    open.value = true
    activeIndex.value = 0
    event.preventDefault()
    return
  }
  if (event.key === 'Enter') {
    const choice = filtered.value[activeIndex.value]
    if (choice) {
      select(choice)
    } else {
      commitManual()
      open.value = false
      activeIndex.value = -1
    }
    event.preventDefault()
    return
  }
  if (!filtered.value.length) return
  const direction = event.key === 'ArrowDown' ? 1 : -1
  if (activeIndex.value < 0) {
    activeIndex.value = direction > 0 ? 0 : filtered.value.length - 1
  } else {
    activeIndex.value = (activeIndex.value + direction + filtered.value.length) % filtered.value.length
  }
  event.preventDefault()
}

function onFocus(): void {
  query.value = ''
  editing.value = false
  activeIndex.value = -1
  void nextTick(() => input.value?.select())
  if (!props.options.length) {
    open.value = false
    return
  }
  open.value = true
}

function closeSoon(): void {
  commitManual()
  window.setTimeout(() => { open.value = false }, 100)
}
</script>

<template>
  <div class="discovery-combobox">
    <div class="input-wrap">
      <input
        ref="input"
        :id="id"
        :name="id"
        :value="modelValue"
        class="discovery-input"
        :placeholder="placeholder"
        role="combobox"
        aria-autocomplete="list"
        autocomplete="off"
        autocapitalize="off"
        data-1p-ignore="true"
        data-bwignore="true"
        data-lpignore="true"
        spellcheck="false"
        :aria-label="label"
        :aria-expanded="open"
        :aria-controls="listboxId"
        :aria-activedescendant="open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined"
        @input="update(($event.target as HTMLInputElement).value)"
        @focus="onFocus"
        @blur="closeSoon"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="toggle"
        :disabled="!options.length"
        :aria-label="`Show ${label} options`"
        tabindex="-1"
        @mousedown.prevent="toggle"
      >{{ loading ? '…' : '⌄' }}</button>
    </div>
    <div v-if="open" :id="listboxId" class="options" role="listbox">
      <template v-if="filtered.length">
        <div v-if="confirmed.length" class="group-label">Provider-confirmed</div>
        <button
          v-for="choice in confirmed"
          :id="`${listboxId}-${filtered.indexOf(choice)}`"
          :key="choice.id"
          type="button"
          class="option"
          :class="{ active: filtered.indexOf(choice) === activeIndex }"
          role="option"
          :aria-selected="choice.id === modelValue"
          @mousedown.prevent="select(choice)"
        >
          <span class="option-name">{{ choice.name }}</span>
          <span class="option-id">{{ choice.id }}</span>
          <span v-if="choice.meta" class="option-meta">{{ choice.meta }}</span>
        </button>
        <div v-if="unknown.length" class="group-label">Compatibility not reported</div>
        <button
          v-for="choice in unknown"
          :id="`${listboxId}-${filtered.indexOf(choice)}`"
          :key="choice.id"
          type="button"
          class="option"
          :class="{ active: filtered.indexOf(choice) === activeIndex }"
          role="option"
          :aria-selected="choice.id === modelValue"
          @mousedown.prevent="select(choice)"
        >
          <span class="option-name">{{ choice.name }}</span>
          <span class="option-id">{{ choice.id }}</span>
          <span v-if="choice.meta" class="option-meta">{{ choice.meta }}</span>
        </button>
      </template>
      <div v-else class="empty">No loaded option matches. The entered ID can still be saved manually.</div>
    </div>
    <div v-if="stale" class="stale">This saved or manual ID is not in the latest provider list. It will be preserved.</div>
  </div>
</template>

<style scoped>
.discovery-combobox { position: relative; width: 270px; max-width: 100%; }
.input-wrap { position: relative; display: flex; }
.discovery-input {
  width: 100%; box-sizing: border-box; background: var(--paper); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 34px 8px 11px; color: var(--ink); font: inherit; font-size: 12.5px;
}
.discovery-input:focus { outline: none; border-color: var(--accent); }
.toggle {
  position: absolute; inset: 1px 1px 1px auto; width: 32px; border: 0; border-left: 1px solid var(--line);
  border-radius: 0 7px 7px 0; background: var(--card); color: var(--muted); cursor: pointer;
}
.toggle:disabled { cursor: default; opacity: 0.5; }
.options {
  position: absolute; z-index: 20; top: calc(100% + 5px); right: 0; width: min(390px, 82vw); max-height: 300px;
  overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 9px;
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 16%, transparent);
}
.group-label {
  padding: 8px 10px 5px; color: var(--muted); background: var(--soft); font-size: 10px;
  font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
}
.option { display: grid; width: 100%; gap: 2px; padding: 9px 11px; text-align: left; border: 0; border-top: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
.option:hover, .option.active { background: var(--soft); }
.option-name { font-size: 12.5px; font-weight: 650; }
.option-id, .option-meta { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.empty { padding: 12px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.stale { margin-top: 5px; color: var(--accent); font-size: 11px; line-height: 1.35; }
@media (max-width: 560px) { .discovery-combobox { width: 100%; } .options { left: 0; right: auto; width: 100%; } }
</style>
