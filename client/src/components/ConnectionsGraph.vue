<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ConnectionNode, ConnectionsPayload } from '../services/api'
import { layoutConnections, visibleConnections } from '../utils/connectionsGraph'

const props = defineProps<{
  payload: ConnectionsPayload
  selectedId: string | null
}>()

const emit = defineEmits<{ (event: 'select', node: ConnectionNode): void }>()
const showCrossReferences = ref(true)
const showThematic = ref(true)

const hasCrossReferences = computed(() =>
  props.payload.edges.some((edge) => edge.kind === 'cross-reference')
)
const hasThematic = computed(() => props.payload.edges.some((edge) => edge.kind === 'thematic'))
const visible = computed(() => visibleConnections(
  props.payload,
  showCrossReferences.value,
  showThematic.value
))
const positioned = computed(() => layoutConnections(visible.value.nodes, visible.value.edges))
const positions = computed(() => new Map(positioned.value.map((node) => [node.id, node])))
const drawnEdges = computed(() => visible.value.edges.flatMap((edge) => {
  const source = positions.value.get(edge.source)
  const target = positions.value.get(edge.target)
  return source && target ? [{ ...edge, sourceNode: source, targetNode: target }] : []
}))

function shortLabel(label: string): string {
  return label.length > 20 ? `${label.slice(0, 19)}…` : label
}
</script>

<template>
  <div class="graph-wrap">
    <div class="filters" aria-label="Connection types">
      <button
        class="filter cross"
        :class="{ active: showCrossReferences }"
        :disabled="!hasCrossReferences"
        :aria-pressed="showCrossReferences"
        @click="showCrossReferences = !showCrossReferences"
      ><span></span>References</button>
      <button
        class="filter theme"
        :class="{ active: showThematic }"
        :disabled="!hasThematic"
        :aria-pressed="showThematic"
        @click="showThematic = !showThematic"
      ><span></span>Thematic</button>
    </div>

    <svg
      class="graph"
      viewBox="0 0 360 280"
      role="group"
      aria-label="Interactive graph of connected Scripture passages"
    >
      <line
        v-for="edge in drawnEdges"
        :key="`${edge.source}-${edge.target}-${edge.kind}`"
        :x1="edge.sourceNode.x"
        :y1="edge.sourceNode.y"
        :x2="edge.targetNode.x"
        :y2="edge.targetNode.y"
        class="edge"
        :class="edge.kind"
      />
      <g
        v-for="node in positioned"
        :key="node.id"
        class="node"
        :class="{ seed: node.seed, selected: node.id === selectedId }"
        role="button"
        tabindex="0"
        :aria-label="`${node.label}, ${node.module}${node.seed ? ', linked passage' : ''}`"
        @click="emit('select', node)"
        @keydown.enter.prevent="emit('select', node)"
        @keydown.space.prevent="emit('select', node)"
      >
        <circle :cx="node.x" :cy="node.y" :r="node.seed ? 12 : 9" />
        <circle v-if="node.id === selectedId" class="focus-ring" :cx="node.x" :cy="node.y" :r="node.seed ? 17 : 14" />
        <text :x="node.x" :y="node.y + (node.seed ? 27 : 23)" text-anchor="middle">
          {{ shortLabel(node.label) }}
        </text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.graph-wrap {
  min-width: 0;
}
.filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 8px;
  background: var(--card);
  color: var(--muted);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  opacity: 0.5;
}
.filter.active { opacity: 1; }
.filter:disabled { cursor: default; opacity: 0.3; }
.filter span {
  width: 13px;
  height: 2px;
  background: var(--accent);
}
.filter.theme span {
  background: var(--muted);
  background-image: linear-gradient(90deg, var(--muted) 50%, transparent 50%);
}
.graph {
  display: block;
  width: 100%;
  min-height: 260px;
  overflow: visible;
}
.edge {
  stroke-width: 1.35;
  vector-effect: non-scaling-stroke;
}
.edge.cross-reference { stroke: color-mix(in oklab, var(--accent) 68%, var(--line)); }
.edge.thematic {
  stroke: var(--muted);
  stroke-dasharray: 4 5;
  opacity: 0.72;
}
.node { cursor: pointer; outline: none; }
.node circle {
  fill: var(--card);
  stroke: var(--muted);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  transition: fill 120ms ease, stroke 120ms ease;
}
.node.seed circle {
  fill: color-mix(in oklab, var(--accent) 13%, var(--card));
  stroke: var(--accent);
  stroke-width: 2;
}
.node:hover circle,
.node:focus circle,
.node.selected circle {
  fill: color-mix(in oklab, var(--accent) 19%, var(--card));
  stroke: var(--accent);
}
.node .focus-ring {
  fill: none;
  stroke: color-mix(in oklab, var(--accent) 42%, transparent);
  stroke-width: 2;
}
.node text {
  fill: var(--ink);
  font-family: 'Instrument Sans', sans-serif;
  font-size: 9.5px;
  pointer-events: none;
}
.node.seed text { font-weight: 700; }
</style>
