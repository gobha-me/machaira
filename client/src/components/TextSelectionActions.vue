<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { formatPassageRef } from '../utils/passageRef'
import { selectedScripture, type SelectedText } from '../utils/textSelection'

const props = defineProps<{ root: HTMLElement | null }>()
const emit = defineEmits<{
  note: [reference: string, quote: string]
  wordStudy: [keys: string[]]
  open: []
}>()
const reader = useReader()
const ui = useUi()
const chosen = ref<SelectedText | null>(null)
const pos = ref({ x: 8, y: 8 })
const studying = ref(false)
const toolbar = ref<HTMLElement | null>(null)
let dismissedRange: Range | null = null
const reference = computed(() => chosen.value ? formatPassageRef({
  book: reader.bookName, chapter: reader.chapter, moduleName: reader.moduleName,
  verseStart: chosen.value.verseStart, verseEnd: chosen.value.verseEnd
}) : '')

function dismiss() {
  const selection = window.getSelection()
  dismissedRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
  chosen.value = null
  studying.value = false
}
function update(event: Event) {
  if (event instanceof KeyboardEvent && event.key === 'Escape') return
  // Keyboard focus may collapse the native range on a toolbar button. Keep its snapshot
  // only while interacting with the toolbar; never retain a range from another passage.
  if (toolbar.value?.contains(document.activeElement)) return
  const next = props.root && selectedScripture(props.root, window.getSelection())
  if (!next || reader.loadingChapter || reader.error) { dismiss(); return }
  const range = window.getSelection()!.getRangeAt(0)
  if (dismissedRange && range.startContainer === dismissedRange.startContainer
    && range.endContainer === dismissedRange.endContainer
    && range.startOffset === dismissedRange.startOffset && range.endOffset === dismissedRange.endOffset) return
  if (JSON.stringify(next) !== JSON.stringify(chosen.value)) studying.value = false
  chosen.value = next
  const bounds = range.getBoundingClientRect()
  // Place above the selection to leave native touch handles and the selected text usable.
  pos.value = { x: Math.max(8, Math.min(bounds.left, window.innerWidth - 296)), y: Math.max(8, bounds.top - 58) }
  emit('open')
}
function onKey(event: KeyboardEvent) { if (event.key === 'Escape') dismiss() }
function onPointer(event: PointerEvent) {
  if (toolbar.value?.contains(event.target as Node)) return
  dismiss()
}
function study(keys: string[]) { emit('wordStudy', keys); dismiss() }
function note() {
  if (chosen.value) emit('note', reference.value, chosen.value.text)
  dismiss()
}
function related() {
  if (chosen.value) ui.findRelated(chosen.value.text)
  dismiss()
}

// Invalidate synchronously, before Vue patches reused verse nodes during navigation.
watch(() => [reader.moduleName, reader.book, reader.chapter, reader.data, reader.loadingChapter, reader.error], dismiss, { flush: 'sync' })
onMounted(() => {
  document.addEventListener('selectionchange', update)
  document.addEventListener('pointerup', update)
  document.addEventListener('keyup', update)
  document.addEventListener('pointerdown', onPointer)
  document.addEventListener('keydown', onKey)
  document.addEventListener('scroll', dismiss, true)
  window.addEventListener('resize', dismiss)
})
onUnmounted(() => {
  document.removeEventListener('selectionchange', update)
  document.removeEventListener('pointerup', update)
  document.removeEventListener('keyup', update)
  document.removeEventListener('pointerdown', onPointer)
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('scroll', dismiss, true)
  window.removeEventListener('resize', dismiss)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="chosen"
      ref="toolbar"
      class="text-selection-actions"
      role="group"
      aria-label="Selected text actions"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    >
      <div class="actions">
        <button
          type="button"
          @click="related"
        >
          Find related
        </button>
        <button
          type="button"
          :aria-expanded="studying"
          @click="chosen.words.length === 1 ? study([chosen.words[0]!.key]) : studying = !studying"
        >
          Word study
        </button>
        <button
          type="button"
          @click="note"
        >
          Note
        </button>
      </div>
      <template v-if="studying">
        <p
          v-if="!chosen.words.length"
          role="status"
        >
          No Strong’s tags for this selection in {{ reader.moduleName }}. Choose a tagged word in a Strong’s-enabled translation.
        </p>
        <div
          v-else
          class="words"
          aria-label="Choose a word to study"
        >
          <button
            v-for="word in chosen.words"
            :key="word.key"
            type="button"
            @click="study([word.key])"
          >
            {{ word.text }} · {{ word.key }}
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.text-selection-actions {
  position: fixed;
  z-index: 65;
  width: 280px;
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 16px);
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 4px;
  background: var(--card);
  color: var(--ink);
  box-shadow: 0 4px 20px #0003;
}
.actions { display: flex; }
button {
  flex: 1;
  min-height: 44px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
button:hover { background: var(--paper); }
p { margin: 8px; font-size: 12px; }
.words { display: flex; flex-wrap: wrap; }
</style>
