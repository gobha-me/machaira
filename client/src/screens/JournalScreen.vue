<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ConnectionsGraph from '../components/ConnectionsGraph.vue'
import MarkdownEditor from '../components/MarkdownEditor.vue'
import { api, type ConnectionNode, type ConnectionsPayload } from '../services/api'
import { useNotes } from '../stores/notes'
import { useReader } from '../stores/reader'
import { useUi, type ScreenId } from '../stores/ui'
import { resolveConnectionSeeds } from '../utils/connectionsGraph'

const notes = useNotes()
const reader = useReader()
const ui = useUi()
const tagDraft = ref('')
const connections = ref<ConnectionsPayload | null>(null)
const connectionsLoading = ref(false)
const connectionsError = ref<string | null>(null)
const connectionWarnings = ref<string[]>([])
const selectedConnectionId = ref<string | null>(null)
let connectionGeneration = 0
let mounted = false

const selectedConnection = computed(() =>
  connections.value?.nodes.find((node) => node.id === selectedConnectionId.value) ?? null
)

const dateLabel = computed(() => {
  const n = notes.current
  if (!n) return ''
  return new Date(n.updatedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
})

function onTitle(e: Event) {
  notes.save({ title: (e.target as HTMLInputElement).value })
}
function addTag() {
  const t = tagDraft.value.trim().toLowerCase()
  if (!t || !notes.current) return
  if (!notes.current.tags.includes(t)) notes.save({ tags: [...notes.current.tags, t] })
  tagDraft.value = ''
}
function removeTag(t: string) {
  if (!notes.current) return
  notes.save({ tags: notes.current.tags.filter((x) => x !== t) })
}
function linkPassage() {
  if (!notes.current || !reader.book) return
  const ref = reader.currentRef
  if (!notes.current.refs.includes(ref)) notes.save({ refs: [...notes.current.refs, ref] })
}
function removeRef(r: string) {
  if (!notes.current) return
  notes.save({ refs: notes.current.refs.filter((x) => x !== r) })
}
function relDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function loadConnections(): Promise<void> {
  const generation = ++connectionGeneration
  const note = notes.current
  connections.value = null
  selectedConnectionId.value = null
  connectionsError.value = null
  connectionWarnings.value = []
  if (!note || note.refs.length === 0) {
    connectionsLoading.value = false
    return
  }

  connectionsLoading.value = true
  try {
    const resolution = await resolveConnectionSeeds(
      note.refs,
      reader.moduleName ?? reader.effectiveDefaultModule,
      (module) => api.books(module)
    )
    if (generation !== connectionGeneration) return
    connectionWarnings.value = resolution.warnings
    if (resolution.seeds.length === 0) return
    const payload = await api.connections(resolution.seeds)
    if (generation !== connectionGeneration) return
    connections.value = payload
    connectionWarnings.value = [...new Set([...resolution.warnings, ...payload.warnings])]
    selectedConnectionId.value = payload.nodes.find((node) => node.seed)?.id ?? payload.nodes[0]?.id ?? null
  } catch (error) {
    if (generation === connectionGeneration) connectionsError.value = (error as Error).message
  } finally {
    if (generation === connectionGeneration) connectionsLoading.value = false
  }
}

function selectConnection(node: ConnectionNode): void {
  selectedConnectionId.value = node.id
}

async function openConnection(screen: Extract<ScreenId, 'read' | 'study'>): Promise<void> {
  const node = selectedConnection.value
  if (!node) return
  connectionsError.value = null
  try {
    await reader.openRef(
      node.module,
      node.book,
      node.chapter,
      node.verseStart ?? undefined,
      node.verseEnd ?? undefined
    )
    if (reader.error) throw new Error(reader.error)
    ui.go(screen)
  } catch (error) {
    connectionsError.value = `Could not open ${node.label}: ${(error as Error).message}`
  }
}

watch(
  () => [notes.currentId, notes.current?.refs.join('\u0000') ?? '', reader.moduleName] as const,
  () => { if (mounted) void loadConnections() }
)

onMounted(async () => {
  if (!reader.ready) await reader.init()
  mounted = true
  await loadConnections()
})
</script>

<template>
  <div class="journal">
    <!-- list -->
    <div class="list-col">
      <div class="list-head">
        <span class="jtitle">Journal</span>
        <div class="spacer"></div>
        <button class="new hover-accent" @click="notes.create()">New</button>
      </div>
      <div v-if="!notes.list.length" class="list-empty">
        No notes yet. Create one — or select a verse while reading and choose “Note”.
      </div>
      <div class="items">
        <div
          v-for="n in notes.list"
          :key="n.id"
          class="item"
          :class="{ active: n.id === notes.currentId }"
          @click="notes.select(n.id)"
        >
          <div class="item-title">{{ n.title || 'Untitled note' }}</div>
          <div class="item-date">{{ relDate(n.updatedAt) }}</div>
          <div v-if="n.tags.length" class="item-tags">
            <span v-for="t in n.tags" :key="t" class="tagchip">{{ t }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- editor -->
    <div class="editor-col">
      <div v-if="notes.current" class="editor">
        <input class="title-input serif" :value="notes.current.title" @input="onTitle" placeholder="Untitled note" />
        <div class="edit-meta">
          {{ dateLabel }}
          <span v-if="notes.saving && !notes.saveError"> · Saving…</span>
          <span v-if="notes.saveError && notes.saveErrorId === notes.currentId" class="save-error">
            · Save failed: {{ notes.saveError }}
            <button @click="notes.retrySave">Retry</button>
          </span>
        </div>

        <div class="refs">
          <button v-for="r in notes.current.refs" :key="r" class="refchip" @click="removeRef(r)" :title="'Remove ' + r">
            {{ r }} ✕
          </button>
          <button class="refchip add" @click="linkPassage">+ Link current passage</button>
        </div>

        <MarkdownEditor
          :key="notes.current.id"
          :source="notes.current.body"
          @update:source="notes.save({ body: $event })"
        />

        <div class="tags-row">
          <span v-for="t in notes.current.tags" :key="t" class="tag" @click="removeTag(t)" :title="'Remove #' + t">
            {{ t }} ✕
          </span>
          <input
            v-model="tagDraft"
            class="tag-input"
            placeholder="+ tag"
            @keydown.enter="addTag"
          />
          <button class="del hover-accent-text" @click="notes.remove(notes.current.id)">Delete note</button>
        </div>
      </div>
      <div v-else class="editor-empty">
        <div class="empty-mark"></div>
        <p>Select a note, or create a new one to begin.</p>
      </div>
    </div>

    <!-- real passage connections -->
    <div class="conn-col">
      <div class="conn-head">
        <div class="conn-label">Connections</div>
        <span v-if="connections" class="conn-count">
          {{ connections.nodes.length }} passage{{ connections.nodes.length === 1 ? '' : 's' }}
        </span>
      </div>

      <div v-if="connectionsLoading" class="conn-state">
        <div class="graph-loading"></div>
        Finding real passage connections…
      </div>
      <div v-else-if="!notes.current" class="conn-state">
        Select a note to explore its Scripture connections.
      </div>
      <div v-else-if="!notes.current.refs.length" class="conn-state">
        Link a passage to this note to build its connections graph.
      </div>
      <div v-else-if="connectionsError && !connections" class="conn-state error">
        {{ connectionsError }}
        <button @click="loadConnections">Try again</button>
      </div>
      <div v-else-if="!connections?.nodes.length" class="conn-state">
        None of this note’s linked passages are available in an installed translation.
      </div>
      <template v-else-if="connections">
        <ConnectionsGraph
          :payload="connections"
          :selected-id="selectedConnectionId"
          @select="selectConnection"
        />

        <div v-if="connections.edges.length === 0" class="conn-note">
          No resolvable cross-reference or thematic neighbors were found for these passages.
        </div>

        <div v-if="selectedConnection" class="conn-detail">
          <div class="detail-head">
            <strong class="serif">{{ selectedConnection.label }}</strong>
            <span>{{ selectedConnection.module }}</span>
          </div>
          <p class="serif">{{ selectedConnection.content || 'Passage text is unavailable.' }}</p>
          <div class="detail-actions">
            <button @click="openConnection('read')">Read</button>
            <button @click="openConnection('study')">Study</button>
          </div>
        </div>
      </template>

      <div v-if="connectionsError && connections" class="conn-note error">{{ connectionsError }}</div>
      <div v-for="warning in connectionWarnings" :key="warning" class="conn-note">
        {{ warning }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.journal {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.list-col {
  width: clamp(190px, 20vw, 270px);
  flex-shrink: 0;
  border-right: 1px solid var(--line);
  overflow-y: auto;
  padding: 24px 16px;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
}
.jtitle {
  font-size: 14px;
  font-weight: 700;
}
.spacer {
  flex: 1;
}
.new {
  background: none;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
}
.list-empty {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  padding: 0 4px;
}
.items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.item {
  border-radius: 9px;
  padding: 12px;
  cursor: pointer;
}
.item:hover {
  background: var(--soft);
}
.item.active {
  background: var(--soft);
}
.item-title {
  font-size: 13px;
  font-weight: 600;
}
.item-date {
  font-size: 11px;
  color: var(--muted);
  margin: 3px 0 7px;
}
.item-tags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.tagchip {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
  border-radius: 4px;
  padding: 2px 6px;
}
.editor-col {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 48px clamp(18px, 4vw, 44px) 100px;
}
.editor {
  max-width: 600px;
}
.title-input {
  width: 100%;
  box-sizing: border-box;
  background: none;
  border: none;
  outline: none;
  font-size: 30px;
  font-weight: 500;
  color: var(--ink);
  padding: 0;
  margin-bottom: 8px;
}
.edit-meta {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 16px;
}
.save-error { color: #a23b32; }
.save-error button {
  border: 0;
  background: none;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.refs {
  display: flex;
  gap: 8px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}
.refchip {
  background: color-mix(in oklab, var(--accent) 7%, transparent);
  border: 1px solid color-mix(in oklab, var(--accent) 30%, transparent);
  color: var(--accent);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.refchip.add {
  background: none;
  border-style: dashed;
  border-color: var(--line);
  color: var(--muted);
}
.tags-row {
  display: flex;
  gap: 8px;
  margin-top: 22px;
  align-items: center;
  flex-wrap: wrap;
}
.tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
  border-radius: 5px;
  padding: 3px 9px;
  cursor: pointer;
}
.tag-input {
  background: none;
  border: 1px dashed var(--line);
  color: var(--ink);
  border-radius: 5px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
  outline: none;
  width: 90px;
}
.del {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
}
.editor-empty {
  text-align: center;
  color: var(--muted);
  padding-top: 80px;
}
.empty-mark {
  width: 12px;
  height: 12px;
  background: var(--line);
  transform: rotate(45deg);
  margin: 0 auto 16px;
}
.editor-empty p {
  font-size: 14px;
}
.conn-col {
  width: clamp(280px, 30vw, 430px);
  flex-shrink: 0;
  border-left: 1px solid var(--line);
  padding: 24px 20px;
  overflow-y: auto;
}
.conn-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.conn-label {
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 14px;
}
.conn-count {
  margin-left: auto;
  color: var(--muted);
  font-size: 10px;
}
.conn-state {
  min-height: 220px;
  display: grid;
  place-content: center;
  gap: 12px;
  padding: 20px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.conn-state button {
  justify-self: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 6px 10px;
  background: var(--card);
  color: var(--accent);
  cursor: pointer;
}
.graph-loading {
  width: 11px;
  height: 11px;
  justify-self: center;
  background: var(--accent);
  transform: rotate(45deg);
  animation: graph-pulse 800ms ease-in-out infinite alternate;
}
@keyframes graph-pulse { to { opacity: 0.3; } }
.conn-detail {
  margin-top: 8px;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}
.detail-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.detail-head strong {
  color: var(--ink);
  font-size: 18px;
  font-weight: 600;
}
.detail-head span {
  margin-left: auto;
  border-radius: 999px;
  padding: 2px 7px;
  background: var(--soft);
  color: var(--muted);
  font-size: 9.5px;
}
.conn-detail p {
  margin: 9px 0 12px;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.55;
}
.detail-actions {
  display: flex;
  gap: 7px;
}
.detail-actions button {
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 6px 12px;
  background: var(--card);
  color: var(--accent);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.conn-note {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
  margin-top: 10px;
}
.error { color: #a23b32; }

@media (max-width: 1000px) {
  .journal { flex-wrap: wrap; overflow-y: auto; }
  .list-col { height: min(62vh, 620px); }
  .editor-col { height: min(62vh, 620px); }
  .conn-col {
    box-sizing: border-box;
    width: 100%;
    min-height: 420px;
    border-left: 0;
    border-top: 1px solid var(--line);
    overflow: visible;
  }
}

@media (max-width: 680px) {
  .journal { display: block; }
  .list-col,
  .editor-col,
  .conn-col {
    box-sizing: border-box;
    width: 100%;
    height: auto;
    min-height: 0;
    overflow: visible;
    border-left: 0;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .list-col { max-height: 230px; overflow-y: auto; }
  .editor-col { padding-top: 34px; }
}
</style>
