<script setup lang="ts">
import type { ScriptureTarget } from '@machaira/scripture'
import { computed, nextTick, ref, watch } from 'vue'
import { useAiProvider } from '../stores/aiProvider'
import { useChatConversations } from '../stores/chatConversations'
import { useSettings } from '../stores/settings'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import type { ChatMessage } from '../services/api'
import MarkdownContent from './MarkdownContent.vue'
import VoiceInputButton from './VoiceInputButton.vue'

const props = defineProps<{
  passage: { reference: string; module: string; content: string }
}>()

const aiProvider = useAiProvider()
const chats = useChatConversations()
const settings = useSettings()
const reader = useReader()
const ui = useUi()
const bodyEl = ref<HTMLElement | null>(null)
const historyOpen = ref(false)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const copyFeedback = ref<Record<string, { kind: 'success' | 'error'; text: string }>>({})
const referenceErrors = ref<Record<string, string>>({})

const messages = computed(() => chats.current?.messages ?? [])

watch(
  () => messages.value.map((item) => `${item.id}:${item.content.length}:${item.status}`).join('|'),
  async () => {
    await nextTick()
    if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight
  }
)

function relativeDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function contextBefore(index: number): ChatMessage['passage'] {
  const current = messages.value[index]
  if (current.role !== 'user' || !current.passage) return null
  const prior = messages.value.slice(0, index).reverse().find((item) => item.role === 'user')
  if (!prior?.passage
    || prior.passage.reference !== current.passage.reference
    || prior.passage.module !== current.passage.module) return current.passage
  return null
}

function retryable(message: ChatMessage, index: number): boolean {
  if (message.role !== 'assistant'
    || (message.status !== 'failed' && message.status !== 'interrupted')
    || !message.replyToMessageId) return false
  const latestUser = [...messages.value].reverse().find((item) => item.role === 'user')
  if (latestUser?.id !== message.replyToMessageId) return false
  return !messages.value.slice(index + 1).some((item) => (
    item.role === 'assistant'
    && item.replyToMessageId === message.replyToMessageId
  ))
}

async function send(): Promise<void> {
  await chats.send(props.passage, {
    alwaysCite: settings.alwaysCite,
    drawApocrypha: settings.drawApocrypha
  })
}

async function retry(message: ChatMessage): Promise<void> {
  await chats.retry(message.id, {
    alwaysCite: settings.alwaysCite,
    drawApocrypha: settings.drawApocrypha
  })
}

async function selectConversation(id: string): Promise<void> {
  await chats.select(id).catch(() => undefined)
  if (!chats.error) historyOpen.value = false
}

function newConversation(): void {
  chats.newChat()
  historyOpen.value = false
}

function beginRename(id: string, title: string): void {
  renamingId.value = id
  renameDraft.value = title
}

async function saveRename(id: string): Promise<void> {
  const title = renameDraft.value.trim()
  if (!title) return
  await chats.rename(id, title)
  if (!chats.error) renamingId.value = null
}

async function removeConversation(id: string, title: string): Promise<void> {
  if (!window.confirm(`Delete “${title}” and its full transcript?`)) return
  await chats.remove(id)
}

async function copyResponse(message: ChatMessage): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable')
    await navigator.clipboard.writeText(message.content)
    copyFeedback.value = {
      ...copyFeedback.value,
      [message.id]: { kind: 'success', text: 'Copied' }
    }
  } catch {
    copyFeedback.value = {
      ...copyFeedback.value,
      [message.id]: { kind: 'error', text: 'Copy failed' }
    }
  }
}

async function openScripture(messageId: string, target: ScriptureTarget): Promise<void> {
  const result = await reader.openAvailableRef(target)
  const next = { ...referenceErrors.value }
  if (result.ok) delete next[messageId]
  else next[messageId] = result.error
  referenceErrors.value = next
}
</script>

<template>
  <aside class="partner">
    <div class="partner-topbar">
      <div class="mark"></div>
      <span class="ptitle">Study partner</span>
      <div class="spacer"></div>
      <div class="history-wrap">
        <button
          class="history-toggle"
          :disabled="chats.sending"
          :aria-expanded="historyOpen"
          aria-haspopup="menu"
          @click="historyOpen = !historyOpen"
        >History</button>
        <div v-if="historyOpen" class="history-menu" role="menu" aria-label="Conversation history">
          <button class="new-chat" role="menuitem" @click="newConversation">＋ New Chat</button>
          <div v-if="!chats.list.length" class="history-empty">No saved conversations yet.</div>
          <div
            v-for="conversation in chats.list"
            :key="conversation.id"
            class="history-item"
            :class="{ active: conversation.id === chats.activeId }"
          >
            <form
              v-if="renamingId === conversation.id"
              class="rename-form"
              @submit.prevent="saveRename(conversation.id)"
            >
              <input v-model="renameDraft" maxlength="120" aria-label="Conversation title" />
              <button type="submit" :disabled="!renameDraft.trim()">Save</button>
              <button type="button" @click="renamingId = null">Cancel</button>
            </form>
            <template v-else>
              <button class="history-select" role="menuitem" @click="selectConversation(conversation.id)">
                <span>{{ conversation.title }}</span>
                <small>{{ relativeDate(conversation.updatedAt) }}</small>
              </button>
              <button
                class="history-action"
                title="Rename conversation"
                :aria-label="`Rename ${conversation.title}`"
                @click="beginRename(conversation.id, conversation.title)"
              >✎</button>
              <button
                class="history-action danger"
                title="Delete conversation"
                :aria-label="`Delete ${conversation.title}`"
                @click="removeConversation(conversation.id, conversation.title)"
              >×</button>
            </template>
          </div>
        </div>
      </div>
      <span class="model">{{ aiProvider.provider?.model ?? 'not connected' }}</span>
    </div>

    <div ref="bodyEl" class="partner-body" :class="{ chatting: messages.length }">
      <div v-if="aiProvider.loading && !aiProvider.ready" class="disabled-note">
        <div class="dn-title serif">Connecting…</div>
      </div>
      <div v-else-if="!aiProvider.provider" class="disabled-note">
        <div class="dn-title serif">Bring your own model</div>
        <p>
          The study partner talks to an LLM — any OpenAI-compatible endpoint, Claude, or a local
          model. Connect a provider in Settings to enable chat about this passage.
        </p>
        <button class="dn-btn" @click="ui.go('settings')">Open Settings →</button>
      </div>
      <div v-else-if="chats.loading" class="disabled-note">
        <div class="dn-title serif">Loading conversation…</div>
      </div>
      <div v-else-if="!messages.length" class="disabled-note">
        <div class="dn-title serif">Ask about this passage</div>
        <p :title="`${passage.reference} · ${passage.module}`">
          {{ passage.reference }} from {{ passage.module }} is included as context.
          Conversations are saved to your account.
        </p>
        <p v-if="chats.error" class="chat-error" role="alert">{{ chats.error }}</p>
      </div>
      <div v-else class="messages" aria-live="polite">
        <template v-for="(message, index) in messages" :key="message.id">
          <div
            v-if="contextBefore(index)"
            class="context-chip"
            :title="`Context · ${contextBefore(index)!.reference} · ${contextBefore(index)!.module}`"
          >Context · {{ contextBefore(index)!.reference }} · {{ contextBefore(index)!.module }}</div>
          <div class="message" :class="message.role">
            <div class="message-head">
              <div class="message-role">{{ message.role === 'user' ? 'You' : 'Study partner' }}</div>
              <template v-if="message.role === 'assistant'">
                <button
                  class="copy-response"
                  type="button"
                  :disabled="!message.content"
                  :aria-label="`Copy response from ${message.createdAt ? new Date(message.createdAt).toLocaleString() : 'study partner'}`"
                  @click="copyResponse(message)"
                >Copy</button>
                <span
                  v-if="copyFeedback[message.id]"
                  class="copy-feedback"
                  :class="copyFeedback[message.id].kind"
                  :role="copyFeedback[message.id].kind === 'error' ? 'alert' : 'status'"
                >{{ copyFeedback[message.id].text }}</span>
              </template>
            </div>
            <div v-if="message.role === 'user'" class="message-content plain-message">
              {{ message.content }}
            </div>
            <div v-else class="message-content assistant-message">
              <MarkdownContent
                v-if="message.content"
                :source="message.content"
                scripture-links
                @open-scripture="openScripture(message.id, $event)"
              />
              <span v-if="message.status === 'streaming'" class="stream-cursor"></span>
              <div v-if="referenceErrors[message.id]" class="reference-error" role="alert">
                {{ referenceErrors[message.id] }}
              </div>
              <div v-if="message.status === 'failed' || message.status === 'interrupted'" class="message-status">
                <span>{{ message.status === 'interrupted' ? 'Response interrupted.' : (message.error || 'Response failed.') }}</span>
                <button v-if="retryable(message, index)" :disabled="chats.sending" @click="retry(message)">Retry</button>
              </div>
            </div>
          </div>
        </template>
        <div v-if="chats.error" class="chat-error" role="alert">{{ chats.error }}</div>
      </div>
    </div>

    <form class="composer" @submit.prevent="send">
      <input
        v-model="chats.draft"
        aria-label="Ask the study partner"
        :disabled="!aiProvider.provider || chats.sending"
        :placeholder="aiProvider.provider ? `Ask about ${passage.reference}` : 'Connect a provider in Settings to chat'"
      />
      <VoiceInputButton
        v-model="chats.draft"
        label="study question"
        :disabled="!aiProvider.provider || chats.sending"
      />
      <button v-if="chats.sending" type="button" class="send cancel" title="Stop response" @click="chats.stop">■</button>
      <button v-else type="submit" class="send" :disabled="!aiProvider.provider || !chats.draft.trim() || !passage.content">→</button>
    </form>
  </aside>
</template>

<style scoped>
.partner { width: clamp(320px, 40vw, 430px); flex-shrink: 0; display: flex; flex-direction: column; background: var(--card); }
.partner-topbar { height: 58px; flex-shrink: 0; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; padding: 0 16px; position: relative; }
.mark { width: 8px; height: 8px; background: var(--accent); transform: rotate(45deg); flex-shrink: 0; }
.ptitle { font-size: 14px; font-weight: 700; }
.spacer { flex: 1; }
.model { color: var(--muted); font-size: 10.5px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-wrap { position: relative; }
.history-toggle { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 11px; }
.history-toggle:disabled { opacity: .45; cursor: default; }
.history-menu { position: absolute; z-index: 20; top: calc(100% + 12px); right: 0; width: min(310px, 82vw); max-height: 420px; overflow-y: auto; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); box-shadow: 0 16px 45px #0003; }
.new-chat { width: 100%; margin-bottom: 6px; padding: 9px 10px; border: 1px dashed var(--line); border-radius: 7px; background: none; color: var(--accent); font-weight: 600; cursor: pointer; text-align: left; }
.history-empty { padding: 12px 8px; color: var(--muted); font-size: 11.5px; }
.history-item { display: flex; align-items: center; border-radius: 7px; }
.history-item.active { background: var(--soft); }
.history-select { min-width: 0; flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 9px 8px; border: 0; background: none; color: var(--ink); cursor: pointer; text-align: left; }
.history-select span { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.history-select small { color: var(--muted); font-size: 10px; }
.history-action { width: 28px; height: 28px; border: 0; border-radius: 5px; background: none; color: var(--muted); cursor: pointer; }
.history-action.danger:hover { color: #a23b32; }
.rename-form { display: flex; flex-wrap: wrap; gap: 5px; padding: 7px; }
.rename-form input { width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: 6px; padding: 7px; background: var(--card); color: var(--ink); }
.rename-form button { border: 0; background: none; color: var(--accent); cursor: pointer; font-size: 10.5px; }
.partner-body { flex: 1; overflow-y: auto; padding: 20px; display: flex; align-items: center; justify-content: center; }
.partner-body.chatting { display: block; padding: 18px 16px 28px; }
.disabled-note { text-align: center; max-width: 300px; }
.dn-title { font-size: 18px; margin-bottom: 8px; }
.disabled-note p { font-size: 13px; line-height: 1.6; color: var(--muted); margin: 0 0 16px; overflow-wrap: anywhere; }
.dn-btn { background: none; border: 1px solid var(--accent); color: var(--accent); border-radius: 8px; padding: 9px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.messages { display: flex; flex-direction: column; gap: 16px; }
.context-chip { align-self: center; max-width: 100%; padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.message { min-width: 0; max-width: 92%; }
.message.user { align-self: flex-end; background: var(--soft); border-radius: 12px 12px 3px 12px; padding: 10px 12px; }
.message.assistant { align-self: flex-start; }
.message-head { min-height: 19px; margin-bottom: 4px; display: flex; align-items: center; gap: 7px; }
.message-role { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.copy-response { margin-left: auto; border: 0; padding: 1px 3px; background: none; color: var(--accent); cursor: pointer; font-size: 10px; font-weight: 600; }
.copy-response:disabled { opacity: .45; cursor: default; }
.copy-feedback { font-size: 10px; color: var(--muted); }
.copy-feedback.error, .reference-error { color: #a23b32; }
.reference-error { margin-top: 6px; font-size: 11.5px; }
.message-content { color: var(--ink); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.plain-message { white-space: pre-wrap; }
.assistant-message { min-width: 0; }
.stream-cursor { display: inline-block; width: 6px; height: 12px; margin-left: 2px; background: var(--accent); animation: pulse .8s ease-in-out infinite alternate; }
.message-status { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: #a23b32; font-size: 11.5px; }
.message-status button { border: 1px solid currentColor; border-radius: 6px; padding: 3px 7px; background: none; color: inherit; cursor: pointer; }
.chat-error { color: #a23b32; font-size: 12px; }
.composer { flex-shrink: 0; border-top: 1px solid var(--line); padding: 14px 20px; display: flex; align-items: center; gap: 10px; }
.composer input { flex: 1; min-width: 0; background: var(--paper); border: 1px solid var(--line); border-radius: 9px; padding: 11px 13px; font-size: 13px; color: var(--ink); outline: none; }
.send { width: 40px; height: 40px; border-radius: 9px; background: var(--accent); color: var(--on-accent); border: none; font-size: 16px; cursor: pointer; }
.send.cancel { font-size: 11px; }
.send:disabled, .composer input:disabled { opacity: .5; cursor: not-allowed; }
@keyframes pulse { to { opacity: .35; } }
@media (max-width: 768px) {
  .partner { width: 100%; min-height: 70dvh; border-top: 1px solid var(--line); }
  .partner-body { min-height: 320px; }
  .composer { padding: 12px 14px; }
}
</style>
