<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { CrossReferenceMapPayload, CrossReferenceMapEdge } from '@machaira/scripture'
import { mapArcs, hitMapArc, mapArcColor, type MapArc } from '../utils/crossReferenceMap'

const props = defineProps<{ payload: CrossReferenceMapPayload; distances: Array<number | null>; similarity: boolean; maximum: number }>()
const emit = defineEmits<{ preview: [edge: CrossReferenceMapEdge | null]; open: [edge: CrossReferenceMapEdge] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
let observer: ResizeObserver | null = null
let frame = 0
let arcs: MapArc[] = []
let selected: MapArc | null = null
let point: { x: number; y: number } | null = null

function draw() {
  frame = 0
  const element = canvas.value
  if (!element) return
  const width = element.clientWidth, height = element.clientHeight
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  element.width = Math.round(width * ratio)
  element.height = Math.round(height * ratio)
  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  arcs = mapArcs(props.payload, width, height).filter((arc) => !props.similarity || (props.distances[arc.index] != null && props.distances[arc.index]! <= props.maximum))
  selected = point ? hitMapArc(arcs, point.x, point.y) : null
  emit('preview', selected?.edge ?? null)
  const positions = new Map(props.payload.nodes.map((node, index) => [node.id, index]))
  const stroke = (arc: MapArc, highlight = false) => {
    ctx.beginPath()
    ctx.moveTo(arc.x1, arc.y)
    ctx.quadraticCurveTo((arc.x1 + arc.x2) / 2, arc.y - arc.rise * 2, arc.x2, arc.y)
    ctx.strokeStyle = mapArcColor(positions.get(arc.edge.source) ?? 0, props.payload.nodes.length, props.similarity ? props.distances[arc.index] : null)
    ctx.globalAlpha = highlight ? 1 : selected ? 0.08 : 0.11 + Math.min(0.28, Math.log1p(arc.edge.count) / 25)
    ctx.lineWidth = highlight ? 2.5 : 0.7 + Math.min(1.2, Math.log1p(arc.edge.count) / 8)
    ctx.stroke()
  }
  for (const arc of arcs) stroke(arc)
  if (selected) stroke(selected, true)
  ctx.globalAlpha = 1
  const tokens = getComputedStyle(element)
  const ink = tokens.getPropertyValue('--muted').trim() || '#6b665f'
  const step = (width - 32) / Math.max(1, props.payload.nodes.length)
  props.payload.nodes.forEach((node, index) => {
    const x = 16 + index * step
    ctx.fillStyle = mapArcColor(index, props.payload.nodes.length)
    ctx.fillRect(x, height - 37, Math.max(1, step - 0.5), 5)
    if (index % Math.max(1, Math.ceil(38 / step)) === 0) {
      ctx.fillStyle = ink
      ctx.font = '10px sans-serif'
      ctx.fillText(node.verse !== null ? String(node.verse) : node.chapter !== null ? String(node.chapter) : node.book, x, height - 15)
    }
  })
}
function schedule() { if (!frame) frame = requestAnimationFrame(draw) }
function move(event: PointerEvent) {
  const rect = canvas.value!.getBoundingClientRect()
  point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  schedule()
}
function leave() { point = null; schedule() }
function open(event: PointerEvent) {
  move(event)
  // Resolve the actual pointer position on touch as well as mouse, without a prior hover.
  const rect = canvas.value!.getBoundingClientRect()
  const hit = hitMapArc(arcs, event.clientX - rect.left, event.clientY - rect.top)
  if (hit) emit('open', hit.edge)
}
watch(() => [props.payload, props.distances, props.similarity, props.maximum], () => { point = null; schedule() })
onMounted(() => {
  observer = new ResizeObserver(schedule)
  observer.observe(canvas.value!)
  schedule()
})
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(frame) })
</script>

<template>
  <canvas
    ref="canvas"
    role="img"
    aria-label="Cross-reference arcs in canonical book order. Use the list view for keyboard access to every connection."
    @pointermove="move"
    @pointerleave="leave"
    @pointerup="open"
  >
    Cross-reference arcs. Use the list view to explore every connection.
  </canvas>
</template>

<style scoped>
canvas { display: block; width: 100%; height: clamp(240px, 39vh, 380px); touch-action: pan-y; cursor: crosshair; }
@media (max-width: 768px) { canvas { height: 240px; } }
</style>
