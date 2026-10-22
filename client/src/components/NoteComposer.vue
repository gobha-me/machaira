<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ title: string; body: string; anchor: string; saving: boolean; error: string | null }>()
defineEmits<{ 'update:title': [value: string]; 'update:body': [value: string]; save: [] }>()
const bodyEl = ref<HTMLTextAreaElement | null>(null)
defineExpose({
  focus: (body: string) => {
    if (!bodyEl.value) return
    // The click can seed a quotation before Vue patches props. Put the caret after it
    // now so input arriving in the same turn cannot replace the quote or get overwritten.
    bodyEl.value.value = body
    bodyEl.value.focus()
    bodyEl.value.setSelectionRange(body.length, body.length)
  }
})
</script>

<template>
  <form
    class="note-composer"
    aria-label="New inline note"
    @submit.prevent="$emit('save')"
  >
    <div class="note-anchor">
      {{ anchor }}
    </div>
    <input
      :value="title"
      aria-label="Note title"
      placeholder="Title (optional)"
      @input="$emit('update:title', ($event.target as HTMLInputElement).value)"
    >
    <textarea
      ref="bodyEl"
      :value="body"
      aria-label="Note body"
      placeholder="Jot a note on this passage…"
      @input="$emit('update:body', ($event.target as HTMLTextAreaElement).value)"
    />
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <button
      type="submit"
      class="note-save"
      :disabled="!body.trim() || saving"
    >
      {{ saving ? 'Saving…' : 'Save note' }}
    </button>
  </form>
</template>

<style scoped>
.note-composer { display: block; margin: 12px 0; padding: 12px; background: var(--card); border-left: 2px solid var(--accent); font: 14px/1.5 'Instrument Sans', sans-serif; }
.note-anchor { color: var(--muted); margin-bottom: 8px; }
input, textarea { display: block; width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 8px; background: var(--bg); color: var(--ink); border: 1px solid var(--line); font: inherit; }
textarea { min-height: 100px; resize: vertical; }
button { color: var(--accent); }
</style>
