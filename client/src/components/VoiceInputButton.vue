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

const {
  supported, active, phase, currentProvider, error, notice, start, stop, cancel
} = useSpeechRecognition(draft)
const unavailable = computed(() => props.disabled || !supported.value)
const providerLabel = computed(() => {
  if (currentProvider.value === 'browser') return 'Browser STT'
  if (currentProvider.value === 'local') return 'Local STT'
  if (currentProvider.value === 'cloud') return 'Cloud STT'
  return ''
})
const title = computed(() => {
  if (!supported.value) return 'No configured voice-input provider is available in this browser'
  if (props.disabled) return `Voice input for ${props.label} is currently unavailable`
  if (phase.value === 'starting') return 'Requesting microphone access'
  if (phase.value === 'recording') return `Release to transcribe with ${providerLabel.value}`
  if (phase.value === 'transcribing') return `${providerLabel.value} is transcribing · press to cancel`
  if (error.value) return error.value
  if (notice.value) return notice.value
  return `Hold to dictate ${props.label}`
})

watch(() => props.disabled, (disabled) => {
  if (disabled && active.value) cancel()
})

function beginPointer(event: PointerEvent): void {
  if (phase.value === 'transcribing') {
    event.preventDefault()
    cancel()
    return
  }
  if (unavailable.value || active.value) return
  event.preventDefault()
  const button = event.currentTarget as HTMLButtonElement
  button.setPointerCapture?.(event.pointerId)
  void start()
}

function endPointer(event: PointerEvent): void {
  if (!['starting', 'recording'].includes(phase.value)) return
  event.preventDefault()
  void stop()
  const button = event.currentTarget as HTMLButtonElement
  if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId)
}

function beginKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && active.value) {
    event.preventDefault()
    cancel()
    return
  }
  if (phase.value === 'transcribing' && [' ', 'Enter'].includes(event.key)) {
    event.preventDefault()
    cancel()
    return
  }
  if (unavailable.value || event.repeat || ![' ', 'Enter'].includes(event.key)) return
  event.preventDefault()
  void start()
}

function endKey(event: KeyboardEvent): void {
  if (!['starting', 'recording'].includes(phase.value) || ![' ', 'Enter'].includes(event.key)) return
  event.preventDefault()
  void stop()
}
</script>

<template>
  <div class="voice-control">
    <button
      type="button"
      class="voice-button"
      :class="{ active, failed: error }"
      :disabled="unavailable && !active"
      :title="title"
      :aria-label="title"
      :aria-pressed="active"
      @pointerdown="beginPointer"
      @pointerup="endPointer"
      @pointercancel="cancel"
      @lostpointercapture="phase === 'recording' && stop()"
      @keydown="beginKey"
      @keyup="endKey"
      @contextmenu.prevent
    >{{ phase === 'recording' ? '●' : phase === 'transcribing' || phase === 'starting' ? '…' : '🎙' }}</button>
    <div
      v-if="error || notice || currentProvider"
      class="voice-status"
      :class="{ failed: error }"
      :role="error ? 'alert' : 'status'"
    >{{ error || notice || providerLabel }}</div>
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
.voice-status {
  position: absolute;
  right: 0;
  bottom: calc(100% + 7px);
  z-index: 60;
  width: max-content;
  max-width: 260px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--card);
  color: var(--muted);
  padding: 6px 8px;
  box-shadow: 0 6px 18px rgba(30, 22, 10, 0.12);
  font-size: 11px;
  line-height: 1.35;
}
.voice-status.failed {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
