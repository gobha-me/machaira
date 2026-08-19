<script setup lang="ts">
import { computed, watch } from 'vue'
import { useSpeechRecognition } from '../composables/useSpeechRecognition'

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  disabled?: boolean
}>(), {
  disabled: false
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const draft = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const { supported, active, error, start, stop, cancel } = useSpeechRecognition(draft)
const unavailable = computed(() => props.disabled || !supported.value)
const title = computed(() => {
  if (!supported.value) return 'Voice input is not available in this browser'
  if (props.disabled) return `Voice input for ${props.label} is currently unavailable`
  if (error.value) return error.value
  return active.value ? 'Release to stop dictating' : `Hold to dictate ${props.label}`
})

watch(() => props.disabled, (disabled) => {
  if (disabled) cancel()
})

function beginPointer(event: PointerEvent): void {
  if (unavailable.value) return
  event.preventDefault()
  const button = event.currentTarget as HTMLButtonElement
  button.setPointerCapture?.(event.pointerId)
  start()
}

function endPointer(event: PointerEvent): void {
  if (unavailable.value && !active.value) return
  event.preventDefault()
  stop()
  const button = event.currentTarget as HTMLButtonElement
  if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId)
}

function beginKey(event: KeyboardEvent): void {
  if (unavailable.value || event.repeat || ![' ', 'Enter'].includes(event.key)) return
  event.preventDefault()
  start()
}

function endKey(event: KeyboardEvent): void {
  if ((unavailable.value && !active.value) || ![' ', 'Enter'].includes(event.key)) return
  event.preventDefault()
  stop()
}
</script>

<template>
  <div class="voice-control">
    <button
      type="button"
      class="voice-button"
      :class="{ active, failed: error }"
      :disabled="unavailable"
      :title="title"
      :aria-label="title"
      :aria-pressed="active"
      @pointerdown="beginPointer"
      @pointerup="endPointer"
      @pointercancel="endPointer"
      @lostpointercapture="stop"
      @keydown="beginKey"
      @keyup="endKey"
      @contextmenu.prevent
    >{{ active ? '●' : '🎙' }}</button>
    <div v-if="error" class="voice-error" role="alert">{{ error }}</div>
  </div>
</template>

<style scoped>
.voice-control {
  position: relative;
  flex-shrink: 0;
}
.voice-button {
  width: 40px;
  height: 40px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--paper);
  color: var(--muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  touch-action: none;
  user-select: none;
}
.voice-button:hover:not(:disabled),
.voice-button:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}
.voice-button.active {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.voice-button.failed {
  border-color: var(--accent);
}
.voice-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.voice-error {
  position: absolute;
  right: 0;
  bottom: calc(100% + 7px);
  z-index: 60;
  width: max-content;
  max-width: 260px;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: var(--card);
  color: var(--accent);
  padding: 6px 8px;
  box-shadow: 0 6px 18px rgba(30, 22, 10, 0.12);
  font-size: 11px;
  line-height: 1.35;
}
</style>
