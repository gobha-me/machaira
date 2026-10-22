<script setup lang="ts">
import { ref } from 'vue'
import type { Note } from '../services/api'
import { useNotes } from '../stores/notes'
import { useUi } from '../stores/ui'
import MarkdownContent from './MarkdownContent.vue'

const props = defineProps<{ note: Note }>()
const notes = useNotes()
const ui = useUi()
const editing = ref(false)
const error = ref<string | null>(null)

async function remove() {
  error.value = null
  try {
    await notes.remove(props.note.id)
  } catch (cause) {
    error.value = (cause as Error).message
  }
}
function openJournal() {
  notes.select(props.note.id)
  ui.go('journal')
}
</script>

<template>
  <section
    class="inline-note"
    :aria-label="`Note: ${note.title || 'Untitled note'}`"
    :data-note-id="note.id"
  >
    <template v-if="editing">
      <input
        aria-label="Edit note title"
        :value="note.title"
        :disabled="notes.deleting[note.id]"
        @input="notes.saveFor(note.id, { title: ($event.target as HTMLInputElement).value })"
      >
      <textarea
        aria-label="Edit note body"
        :value="note.body"
        :disabled="notes.deleting[note.id]"
        @input="notes.saveFor(note.id, { body: ($event.target as HTMLTextAreaElement).value })"
      />
      <button @click="editing = false">
        Done
      </button>
    </template>
    <template v-else>
      <strong>{{ note.title || 'Untitled note' }}</strong>
      <MarkdownContent :source="note.body" />
      <button @click="editing = true">
        Edit note
      </button>
    </template>
    <a
      href="#/journal"
      @click.prevent="openJournal"
    >Open in Journal</a>
    <button
      :disabled="notes.deleting[note.id]"
      @click="remove"
    >
      Delete note
    </button>
    <p
      v-if="notes.saveErrors[note.id]"
      role="alert"
    >
      Save failed: {{ notes.saveErrors[note.id] }}. Your edits are kept locally.
      <button @click="notes.retrySaveFor(note.id)">
        Retry
      </button>
    </p>
    <p
      v-else-if="notes.dirty[note.id]"
      role="status"
    >
      Saving…
    </p>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
.inline-note { display: block; margin: 10px 0; padding: 12px; border-left: 2px solid var(--line); background: var(--card); font: 14px/1.5 'Instrument Sans', sans-serif; color: var(--ink); }
button, a { margin-right: 12px; color: var(--accent); }
input, textarea { display: block; width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 8px; background: var(--bg); color: var(--ink); border: 1px solid var(--line); font: inherit; }
textarea { min-height: 100px; resize: vertical; }
</style>
