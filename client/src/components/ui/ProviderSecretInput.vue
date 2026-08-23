<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  id: string
  modelValue: string
  label: string
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const revealed = ref(false)
</script>

<template>
  <div class="provider-secret">
    <input
      :id="id"
      :name="id"
      :value="modelValue"
      class="secret-input"
      :type="revealed ? 'text' : 'password'"
      autocomplete="new-password"
      autocapitalize="off"
      :aria-label="label"
      data-1p-ignore="true"
      data-bwignore="true"
      data-lpignore="true"
      :placeholder="placeholder"
      spellcheck="false"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      type="button"
      class="reveal"
      :aria-controls="id"
      :aria-label="`${revealed ? 'Hide' : 'Show'} ${label}`"
      :aria-pressed="revealed"
      @click="revealed = !revealed"
    >{{ revealed ? 'Hide' : 'Show' }}</button>
  </div>
</template>

<style scoped>
.provider-secret {
  display: flex;
  width: 220px;
  min-width: 0;
}
.secret-input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  background: var(--paper);
  border: 1px solid var(--line);
  border-right: 0;
  border-radius: 8px 0 0 8px;
  padding: 8px 11px;
  color: var(--ink);
  font: inherit;
  font-size: 12.5px;
}
.secret-input:focus {
  outline: none;
  border-color: var(--accent);
}
.reveal {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 0 8px 8px 0;
  padding: 0 10px;
  background: var(--card);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
.reveal:hover,
.reveal:focus-visible {
  color: var(--ink);
  border-color: var(--accent);
  outline: none;
}
</style>
