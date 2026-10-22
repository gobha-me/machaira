<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { CrossReferenceMapPayload, CrossReferenceMapEdge, CrossReferenceMapNode } from '@machaira/scripture'
import { mapArcs, hitMapArc, mapArcColor, mapArcWeight, initialMapViewport, panMap, zoomMap, type MapArc } from '../utils/crossReferenceMap'

const props = defineProps<{ payload: CrossReferenceMapPayload; distances: Array<number | null>; similarity: boolean; maximum: number }>()
const emit = defineEmits<{ preview: [edge: CrossReferenceMapEdge | null]; open: [edge: CrossReferenceMapEdge]; select: [node: CrossReferenceMapNode] }>()
const viewport = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const tooltip = ref<HTMLDivElement | null>(null)
const view = ref(initialMapViewport())
const size = ref({ width: 0, height: 0 })
const selected = shallowRef<MapArc | null>(null)
const selectedNode = shallowRef<CrossReferenceMapNode | null>(null)
const dragging = ref(false)
const tooltipPosition = ref({ left: '0px', top: '0px' })
let observer: ResizeObserver | null = null
let frame = 0
let arcs: MapArc[] = []
let point: { x: number; y: number } | null = null
let gesture: { id: number; x: number; y: number; view: typeof view.value; dragged: boolean; capture: Element } | null = null
let suppressClick = false

const axis = computed(() => {
  const step = (size.value.width - 32) / Math.max(1, props.payload.nodes.length)
  const labelEvery = Math.max(1, Math.ceil(38 / (step * view.value.scale)))
  return props.payload.nodes.map((node, index) => ({
    node, showLabel: index % labelEvery === 0,
    left: (16 + index * step) * view.value.scale + view.value.x,
    width: step * view.value.scale,
    top: (size.value.height - 40) * view.value.scale + view.value.y,
    color: mapArcColor(index, props.payload.nodes.length)
  })).filter((item) => item.width > 0 && item.left + item.width > 0 && item.left < size.value.width && item.top >= 0 && item.top < size.value.height)
})
const labels = computed(() => new Map(props.payload.nodes.map((node) => [node.id, node.label])))
const overview = computed(() => props.payload.nodes.every((node) => node.chapter === null && node.verse === null))

function localPoint(event: { clientX: number; clientY: number }) {
  const rect = canvas.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}
function clearHover() {
  point = null
  selected.value = null
  selectedNode.value = null
  emit('preview', null)
}
function placeTooltip() {
  if (!point || !tooltip.value) return
  const { offsetWidth: width, offsetHeight: height } = tooltip.value
  tooltipPosition.value = {
    left: `${Math.max(8, Math.min(point.x + 14, size.value.width - width - 8))}px`,
    top: `${Math.max(8, Math.min(point.y + 14 + height > size.value.height ? point.y - height - 14 : point.y + 14, size.value.height - height - 8))}px`
  }
}
function draw() {
  frame = 0
  const element = canvas.value
  if (!element) return
  const width = element.clientWidth, height = element.clientHeight
  size.value = { width, height }
  view.value = panMap(view.value, view.value.x, view.value.y, width, height)
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  element.width = Math.round(width * ratio)
  element.height = Math.round(height * ratio)
  const ctx = element.getContext('2d')
  if (!ctx) { arcs = []; clearHover(); return }
  ctx.scale(ratio, ratio)
  ctx.translate(view.value.x, view.value.y)
  ctx.scale(view.value.scale, view.value.scale)
  arcs = mapArcs(props.payload, width, height, props.similarity ? { distances: props.distances, maximum: props.maximum } : undefined)
  selected.value = point && !selectedNode.value && !gesture?.dragged
    ? hitMapArc(arcs, (point.x - view.value.x) / view.value.scale, (point.y - view.value.y) / view.value.scale, 6 / view.value.scale) : null
  emit('preview', selected.value?.edge ?? null)
  const positions = new Map(props.payload.nodes.map((node, index) => [node.id, index]))
  const maximumCount = arcs.reduce((maximum, arc) => Math.max(maximum, arc.edge.count), 1)
  const stroke = (arc: MapArc, highlight = false) => {
    const weight = mapArcWeight(arc.edge.count, maximumCount)
    ctx.beginPath()
    ctx.moveTo(arc.x1, arc.y)
    ctx.quadraticCurveTo((arc.x1 + arc.x2) / 2, arc.y - arc.rise * 2, arc.x2, arc.y)
    ctx.strokeStyle = mapArcColor(positions.get(arc.edge.source) ?? 0, props.payload.nodes.length, arc.distance)
    ctx.globalAlpha = highlight ? 1 : selected.value ? weight.opacity * 0.25 : weight.opacity
    // Preserve legible strokes as geometry zooms; link counts still determine their relative weight.
    ctx.lineWidth = (highlight ? Math.max(2.5, weight.width) : weight.width) / view.value.scale
    ctx.stroke()
  }
  // Draw the strongest connections last so faint pairs cannot obscure them.
  arcs.sort((a, b) => a.edge.count - b.edge.count)
  for (const arc of arcs) stroke(arc)
  if (selected.value) stroke(selected.value, true)
  void nextTick(placeTooltip)
}
function schedule() { if (!frame) frame = requestAnimationFrame(draw) }
function move(event: PointerEvent) {
  if (gesture && event.pointerId !== gesture.id) return
  point = localPoint(event)
  if (gesture) {
    const dx = point.x - gesture.x, dy = point.y - gesture.y
    if (Math.hypot(dx, dy) > 4) gesture.dragged = true
    if (gesture.dragged) {
      dragging.value = true
      view.value = panMap(gesture.view, gesture.view.x + dx, gesture.view.y + dy, size.value.width, size.value.height)
      selectedNode.value = null
      suppressClick = true
      schedule()
      return
    }
  }
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-node]') : null
  selectedNode.value = button ? props.payload.nodes.find((node) => node.id === button.dataset.node) ?? null : null
  schedule()
}
function start(event: PointerEvent) {
  if (event.button !== 0 || gesture) return
  point = localPoint(event)
  const capture = event.target instanceof Element ? event.target.closest('[data-node]') ?? canvas.value! : canvas.value!
  gesture = { id: event.pointerId, ...point, view: { ...view.value }, dragged: false, capture }
  suppressClick = false
  // Keep capture on the original control: transferring it mid-drag would emit
  // lostpointercapture and cancel the gesture (especially with touch input).
  capture.setPointerCapture(event.pointerId)
}
function releaseGesture() {
  const previous = gesture
  gesture = null
  dragging.value = false
  if (previous?.capture.hasPointerCapture(previous.id)) previous.capture.releasePointerCapture(previous.id)
}
function finish(event: PointerEvent) {
  if (!gesture || event.pointerId !== gesture.id) return
  // Pointerup may arrive without a final move (including touch input).
  move(event)
  const dragged = gesture.dragged
  releaseGesture()
  if (!dragged && event.target === canvas.value) {
    const position = localPoint(event)
    const hit = hitMapArc(arcs, (position.x - view.value.x) / view.value.scale, (position.y - view.value.y) / view.value.scale, 6 / view.value.scale)
    if (hit) emit('open', hit.edge)
  }
  clearHover()
  schedule()
}
function cancel(event: PointerEvent) {
  if (!gesture || event.pointerId !== gesture.id) return
  releaseGesture()
  suppressClick = true
  clearHover()
  schedule()
}
function leave() { clearHover(); schedule() }
function select(node: CrossReferenceMapNode, event: MouseEvent) {
  if (suppressClick && event.detail !== 0) return
  emit('select', node)
}
function focusNode(node: CrossReferenceMapNode, event: FocusEvent) {
  const rect = (event.target as HTMLElement).getBoundingClientRect()
  point = localPoint({ clientX: rect.left + rect.width / 2, clientY: rect.top })
  selectedNode.value = node
  schedule()
}
function zoom(factor: number, at = { x: size.value.width / 2, y: size.value.height / 2 }) {
  view.value = zoomMap(view.value, factor, at.x, at.y, size.value.width, size.value.height)
  clearHover()
  schedule()
}
function wheel(event: WheelEvent) {
  if (!Number.isFinite(event.deltaY) || !event.deltaY || gesture) return
  event.preventDefault()
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.value.height : 1)
  zoom(Math.exp(-Math.max(-600, Math.min(600, delta)) * 0.002), localPoint(event))
}
function reset() { releaseGesture(); view.value = initialMapViewport(); clearHover(); schedule() }
watch(() => [props.payload, props.distances, props.similarity, props.maximum], reset)
onMounted(() => {
  observer = new ResizeObserver(schedule)
  observer.observe(canvas.value!)
  schedule()
})
onBeforeUnmount(() => { releaseGesture(); observer?.disconnect(); cancelAnimationFrame(frame) })
</script>

<template>
  <div class="map-tools">
    <span>Wheel to zoom · drag to pan · choose an axis label to explore</span>
    <button
      aria-label="Zoom out"
      :disabled="view.scale === 1"
      @click="zoom(1 / 1.5)"
    >
      −
    </button>
    <button
      aria-label="Reset map view"
      @click="reset"
    >
      Reset {{ Math.round(view.scale * 100) }}%
    </button>
    <button
      aria-label="Zoom in"
      :disabled="view.scale === 8"
      @click="zoom(1.5)"
    >
      +
    </button>
  </div>
  <div
    ref="viewport"
    class="map-viewport"
    :class="{ dragging }"
    @wheel="wheel"
    @pointerdown="start"
    @pointermove="move"
    @pointerleave="leave"
    @pointerup="finish"
    @pointercancel="cancel"
    @lostpointercapture="cancel"
  >
    <canvas
      ref="canvas"
      role="img"
      aria-label="Cross-reference arcs in canonical book order. Wheel to zoom and drag to pan. Use the list view for keyboard access to every connection."
    >
      Cross-reference arcs. Use the list view to explore every connection.
    </canvas>
    <button
      v-for="item in axis"
      :key="item.node.id"
      class="axis-node"
      :data-node="item.node.id"
      :aria-label="`Explore ${item.node.label}`"
      :title="item.node.label"
      :style="{ left: `${item.left}px`, top: `${item.top}px`, width: `${item.width}px`, '--node-color': item.color }"
      @click="select(item.node, $event)"
      @focus="focusNode(item.node, $event)"
      @blur="leave"
    >
      <span :class="{ 'label-hidden': !item.showLabel }">{{ item.node.verse ?? item.node.chapter ?? item.node.book }}</span>
    </button>
    <div
      v-if="selected || selectedNode"
      ref="tooltip"
      role="tooltip"
      class="map-tooltip"
      :style="tooltipPosition"
    >
      <template v-if="selectedNode">
        {{ selectedNode.label }} · Click to explore
      </template>
      <template v-else-if="selected">
        <slot
          name="tooltip"
          :edge="selected.edge"
          :overview="overview"
        >
          {{ labels.get(selected.edge.source) }} {{ overview ? '↔' : '→' }} {{ labels.get(selected.edge.target) }} · {{ selected.edge.count.toLocaleString() }} links
        </slot>
      </template>
    </div>
  </div>
</template>

<style scoped>
.map-tools { display: flex; align-items: center; gap: 6px; margin-top: 12px; font-size: 11px; color: var(--muted); }
.map-tools span { margin-right: auto; }
.map-tools button { border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--ink); padding: 5px 8px; cursor: pointer; white-space: nowrap; }
.map-tools button:disabled { opacity: .5; cursor: default; }
.map-viewport { position: relative; overflow: hidden; touch-action: none; user-select: none; cursor: grab; }
.map-viewport.dragging { cursor: grabbing; }
canvas { display: block; width: 100%; height: clamp(240px, 39vh, 380px); }
.axis-node { position: absolute; box-sizing: border-box; height: 40px; padding: 12px 0 0; border: 0; border-top: 5px solid var(--node-color); border-radius: 0; background: transparent; color: var(--muted); font: 10px sans-serif; text-align: center; cursor: pointer; }
.axis-node span { display: block; white-space: nowrap; pointer-events: none; }
.label-hidden { visibility: hidden; }
.axis-node:hover, .axis-node:focus-visible { background: var(--paper); color: var(--ink); z-index: 1; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.map-tooltip { position: absolute; z-index: 2; box-sizing: border-box; max-width: min(320px, calc(100% - 16px)); padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); box-shadow: 0 3px 12px #0002; font-size: 12px; line-height: 1.5; pointer-events: none; }
@media (max-width: 768px) { canvas { height: 240px; } .map-tools { flex-wrap: wrap; } .map-tools span { flex-basis: 100%; } }
</style>
