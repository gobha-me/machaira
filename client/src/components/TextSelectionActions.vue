<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { formatPassageRef } from '../utils/passageRef'
import { selectedScripture, type SelectedText } from '../utils/textSelection'
import { placeSelectionPopover } from '../utils/selectionPopover'

const props = defineProps<{ root: HTMLElement | null; avoid?: HTMLElement | null }>()
const emit = defineEmits<{
  note: [reference: string, quote: string]
  wordStudy: [keys: string[]]
  open: []
}>()
const reader = useReader()
const ui = useUi()
const chosen = ref<SelectedText | null>(null)
const placement = ref<ReturnType<typeof placeSelectionPopover>>(null)
const studying = ref(false)
const toolbar = ref<HTMLElement | null>(null)
let dismissedRange: Range | null = null
let activeRange: Range | null = null
let resizeObserver: ResizeObserver | null = null
const reference = computed(() => chosen.value ? formatPassageRef({
  book: reader.bookName, chapter: reader.chapter, moduleName: reader.moduleName,
  verseStart: chosen.value.verseStart, verseEnd: chosen.value.verseEnd
}) : '')

function dismiss() {
  const selection = window.getSelection()
  dismissedRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
  chosen.value = null
  activeRange = null
  placement.value = null
  studying.value = false
}
function position() {
  if (!chosen.value || !activeRange || !props.root || !toolbar.value) return
  const column = props.root.getBoundingClientRect()
  const toolbarHeight = toolbar.value.scrollHeight + toolbar.value.offsetHeight - toolbar.value.clientHeight
  placement.value = placeSelectionPopover(activeRange.getBoundingClientRect(),
    { width: 280, height: Math.max(52, toolbarHeight) },
    { left: Math.max(8, column.left), right: Math.min(window.innerWidth - 8, column.right),
      top: 8, bottom: window.innerHeight - 8 },
    props.avoid ? [props.avoid.getBoundingClientRect()] : [])
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
  activeRange = range.cloneRange()
  void nextTick(position)
  emit('open')
}
function onKey(event: KeyboardEvent) { if (event.key === 'Escape') dismiss() }
function onPointer(event: PointerEvent) {
  if (toolbar.value?.contains(event.target as Node)) return
  dismiss()
}
function onScroll(event: Event) {
  if (event.target instanceof Node && toolbar.value?.contains(event.target)) return
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
function observeLayout() {
  resizeObserver?.disconnect()
  for (const element of [toolbar.value, props.root, props.avoid]) {
    if (element) resizeObserver?.observe(element)
  }
  void nextTick(position)
}
watch(() => [toolbar.value, props.root, props.avoid], observeLayout, { flush: 'post' })
watch(studying, () => { void nextTick(position) })
onMounted(() => {
  resizeObserver = new ResizeObserver(position)
  observeLayout()
  document.addEventListener('selectionchange', update)
  document.addEventListener('pointerup', update)
  document.addEventListener('keyup', update)
  document.addEventListener('pointerdown', onPointer)
  document.addEventListener('keydown', onKey)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', dismiss)
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  document.removeEventListener('selectionchange', update)
  document.removeEventListener('pointerup', update)
  document.removeEventListener('keyup', update)
  document.removeEventListener('pointerdown', onPointer)
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('scroll', onScroll, true)
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
      :style="placement ? {
        left: `${placement.left}px`, top: `${placement.top}px`,
        width: `${placement.width}px`, maxHeight: `${placement.maxHeight}px`
      } : { visibility: 'hidden' }"
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
  box-sizing: border-box;
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
