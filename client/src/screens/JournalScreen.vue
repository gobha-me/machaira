<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useNotes } from '../stores/notes'
import { useReader } from '../stores/reader'

const notes = useNotes()
const reader = useReader()
const tagDraft = ref('')

onMounted(() => notes.load())

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
function onBody(e: Event) {
  notes.save({ body: (e.target as HTMLTextAreaElement).value })
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
        <div class="edit-meta">{{ dateLabel }}</div>

        <div class="refs">
          <button v-for="r in notes.current.refs" :key="r" class="refchip" @click="removeRef(r)" :title="'Remove ' + r">
            {{ r }} ✕
          </button>
          <button class="refchip add" @click="linkPassage">+ Link current passage</button>
        </div>

        <textarea
          class="body-input serif"
          :value="notes.current.body"
          @input="onBody"
          placeholder="Write freely…"
        ></textarea>

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

    <!-- connections (honest placeholder) -->
    <div class="conn-col">
      <div class="conn-label">Connections</div>
      <div class="conn-placeholder">
        <svg viewBox="0 0 230 200" class="conn-svg">
          <circle cx="115" cy="100" r="15" fill="var(--soft)" stroke="var(--line)" stroke-width="1.5" />
          <circle cx="50" cy="46" r="9" fill="none" stroke="var(--line)" stroke-width="1.5" />
          <circle cx="184" cy="52" r="9" fill="none" stroke="var(--line)" stroke-width="1.5" />
          <circle cx="60" cy="160" r="9" fill="none" stroke="var(--line)" stroke-width="1.5" />
          <circle cx="176" cy="150" r="9" fill="none" stroke="var(--line)" stroke-width="1.5" />
          <line x1="115" y1="100" x2="50" y2="46" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" />
          <line x1="115" y1="100" x2="184" y2="52" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" />
          <line x1="115" y1="100" x2="60" y2="160" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" />
          <line x1="115" y1="100" x2="176" y2="150" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" />
        </svg>
      </div>
      <div class="conn-note">
        A thematic graph — linking notes by cross-references and shared tags — arrives with the
        semantic index. Not built yet.
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
.body-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 320px;
  background: none;
  border: none;
  outline: none;
  resize: vertical;
  font-size: 17px;
  line-height: 1.8;
  color: var(--ink);
  padding: 0;
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
  width: clamp(180px, 19vw, 270px);
  flex-shrink: 0;
  border-left: 1px solid var(--line);
  padding: 24px 20px;
  overflow-y: auto;
}
.conn-label {
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 14px;
}
.conn-svg {
  width: 100%;
  height: auto;
  opacity: 0.7;
}
.conn-note {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
  margin-top: 10px;
}
</style>
