<script setup lang="ts">
import { nextTick, ref } from 'vue'
import MarkdownContent from './MarkdownContent.vue'

withDefaults(defineProps<{
  source: string
  placeholder?: string
}>(), {
  placeholder: 'Write freely…'
})

const emit = defineEmits<{
  'update:source': [source: string]
}>()

const mode = ref<'edit' | 'preview'>('edit')
const bodyEl = ref<HTMLTextAreaElement | null>(null)

function onInput(event: Event): void {
  emit('update:source', (event.target as HTMLTextAreaElement).value)
}

async function setMode(nextMode: 'edit' | 'preview'): Promise<void> {
  mode.value = nextMode
  if (nextMode === 'edit') {
    await nextTick()
    bodyEl.value?.focus()
  }
}
</script>

<template>
  <div class="markdown-editor">
    <div class="mode-toggle" role="group" aria-label="Note body view">
      <button
        type="button"
        :class="{ active: mode === 'edit' }"
        :aria-pressed="mode === 'edit'"
        @click="setMode('edit')"
      >Edit</button>
      <button
        type="button"
        :class="{ active: mode === 'preview' }"
        :aria-pressed="mode === 'preview'"
        @click="setMode('preview')"
      >Preview</button>
    </div>

    <textarea
      v-if="mode === 'edit'"
      ref="bodyEl"
      class="body-input serif"
      :value="source"
      :placeholder="placeholder"
      aria-label="Note Markdown"
      @input="onInput"
    ></textarea>
    <div v-else class="preview serif" role="region" aria-label="Note preview">
      <MarkdownContent v-if="source" :source="source" />
      <p v-else class="preview-empty">Nothing to preview yet.</p>
    </div>
  </div>
</template>

<style scoped>
.markdown-editor { min-width: 0; }
.mode-toggle {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 14px;
}
.mode-toggle button {
  border: 1px solid var(--line);
  padding: 5px 10px;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.mode-toggle button:first-child { border-radius: 6px 0 0 6px; }
.mode-toggle button:last-child {
  margin-left: -1px;
  border-radius: 0 6px 6px 0;
}
.mode-toggle button.active {
  position: relative;
  border-color: var(--accent);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
  color: var(--accent);
}
.mode-toggle button:focus-visible {
  position: relative;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.body-input,
.preview {
  box-sizing: border-box;
  width: 100%;
  min-height: 320px;
  color: var(--ink);
  font-size: 17px;
  line-height: 1.8;
}
.body-input {
  border: none;
  padding: 0;
  background: none;
  outline: none;
  resize: vertical;
}
.preview {
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
.preview-empty {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
  font-style: italic;
}
</style>
