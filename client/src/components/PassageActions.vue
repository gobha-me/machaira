<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type CSSProperties } from 'vue'

// Floating, presentational action menu for a selected passage. Teleported to <body> and
// fixed-positioned at the click point so the scrollable reading/study panes can't clip it.
// Emits capability intents; each surface wires them to its own cards.
const props = defineProps<{
  refLabel: string
  highlighted: boolean
  pos: { x: number; y: number }
}>()

defineEmits<{
  (e: 'word-study'): void
  (e: 'compare'): void
  (e: 'commentary'): void
  (e: 'cross-refs'): void
  (e: 'highlight'): void
  (e: 'note'): void
}>()

const root = ref<HTMLElement | null>(null)
const size = ref({ w: 320, h: 44 })

function measure() {
  if (root.value) size.value = { w: root.value.offsetWidth, h: root.value.offsetHeight }
}

onMounted(async () => {
  await nextTick()
  measure()
})

watch(
  () => [props.pos, props.refLabel],
  async () => {
    await nextTick()
    measure()
  },
  { deep: true }
)

const MARGIN = 8
const OFFSET = 12

// Sit just below-right of the click; clamp within the viewport and flip above when the
// menu would spill past the bottom edge.
const style = computed<CSSProperties>(() => {
  const { w, h } = size.value
  let left = Math.min(props.pos.x + OFFSET, window.innerWidth - w - MARGIN)
  left = Math.max(MARGIN, left)
  let top = props.pos.y + OFFSET
  if (top + h + MARGIN > window.innerHeight) top = props.pos.y - h - OFFSET
  top = Math.max(MARGIN, top)
  return { left: `${left}px`, top: `${top}px` }
})
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="passage-actions" :style="style">
      <span class="pa-ref">{{ refLabel }}</span>
      <button class="pa-act hover-soft" @click="$emit('word-study')">Word study</button>
      <button class="pa-act hover-soft" @click="$emit('compare')">Compare</button>
      <button class="pa-act hover-soft" @click="$emit('commentary')">Commentary</button>
      <button class="pa-act hover-soft" @click="$emit('cross-refs')">Cross-references</button>
      <button class="pa-act hover-soft" @click="$emit('highlight')">
        {{ highlighted ? 'Unhighlight' : 'Highlight' }}
      </button>
      <button class="pa-act hover-soft" @click="$emit('note')">Note</button>
    </div>
  </Teleport>
</template>

<style scoped>
.passage-actions {
  position: fixed;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--card);
  border: 1px solid color-mix(in oklab, var(--line), var(--muted) 40%);
  border-radius: 10px;
  padding: 8px 10px;
  box-shadow:
    0 1px 2px rgba(30, 22, 10, 0.14),
    0 16px 40px rgba(30, 22, 10, 0.26);
}
.pa-ref {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  margin-right: 2px;
  white-space: nowrap;
}
.pa-act {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  padding: 6px 8px;
  border-radius: 6px;
  white-space: nowrap;
  font-family: inherit;
}
</style>
