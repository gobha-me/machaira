import { defineStore } from 'pinia'
import {
  api,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatMessage,
  type ConversationMessageInput,
  type ConversationStreamHandlers
} from '../services/api'

let activeAbort: AbortController | null = null
let generation = 0

function byUpdated(items: ChatConversationSummary[]): ChatConversationSummary[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export const useChatConversations = defineStore('chatConversations', {
  state: () => ({
    list: [] as ChatConversationSummary[],
    current: null as ChatConversation | null,
    activeId: null as string | null,
    draft: '',
    loaded: false,
    loading: false,
    sending: false,
    error: null as string | null
  }),
  actions: {
    async load(): Promise<void> {
      const activeGeneration = generation
      this.loading = true
      this.error = null
      try {
        const conversations = await api.chatConversations()
        if (activeGeneration !== generation) return
        const sorted = byUpdated(conversations)
        const id = this.activeId && conversations.some((item) => item.id === this.activeId)
          ? this.activeId
          : sorted[0]?.id ?? null
        const current = id ? await api.chatConversation(id) : null
        if (activeGeneration !== generation) return
        this.list = sorted
        this.activeId = id
        this.current = current
        this.loaded = true
      } catch (error) {
        if (activeGeneration !== generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (activeGeneration === generation) this.loading = false
      }
    },

    async select(id: string): Promise<void> {
      if (this.sending || id === this.activeId) return
      const activeGeneration = generation
      this.loading = true
      this.error = null
      try {
        const current = await api.chatConversation(id)
        if (activeGeneration !== generation) return
        this.current = current
        this.activeId = id
        this.draft = ''
      } catch (error) {
        if (activeGeneration !== generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (activeGeneration === generation) this.loading = false
      }
    },

    newChat(): void {
      if (this.sending) return
      this.activeId = null
      this.current = null
      this.draft = ''
      this.error = null
    },

    async rename(id: string, title: string): Promise<void> {
      const activeGeneration = generation
      this.error = null
      try {
        const updated = await api.renameChatConversation(id, title)
        if (activeGeneration !== generation) return
        this.upsertSummary(updated)
        if (this.current?.id === id) Object.assign(this.current, updated)
      } catch (error) {
        if (activeGeneration === generation) this.error = (error as Error).message
      }
    },

    async remove(id: string): Promise<void> {
      if (this.sending) return
      const activeGeneration = generation
      this.error = null
      try {
        await api.deleteChatConversation(id)
        if (activeGeneration !== generation) return
        this.list = this.list.filter((item) => item.id !== id)
        if (this.activeId === id) {
          const next = this.list[0]?.id
          this.activeId = null
          this.current = null
          if (next) await this.select(next)
        }
      } catch (error) {
        if (activeGeneration === generation) this.error = (error as Error).message
      }
    },

    async send(
      passage: ConversationMessageInput['passage'],
      preferences: ConversationMessageInput['preferences']
    ): Promise<void> {
      const content = this.draft.trim()
      if (!content || this.sending || !passage.content) return
      let conversation
      try {
        conversation = await this.ensureConversation()
      } catch (error) {
        if ((error as Error).name !== 'AbortError') this.error = (error as Error).message
        return
      }
      this.draft = ''
      await this.runStream(
        (handlers, signal) => api.streamConversationMessage(
          conversation.id,
          { content, passage, preferences },
          handlers,
          signal
        ),
        content
      )
    },

    async retry(
      assistantMessageId: string,
      preferences: ConversationMessageInput['preferences']
    ): Promise<void> {
      if (!this.current || this.sending) return
      const conversationId = this.current.id
      await this.runStream(
        (handlers, signal) => api.retryConversationMessage(
          conversationId,
          assistantMessageId,
          preferences,
          handlers,
          signal
        )
      )
    },

    stop(): void {
      activeAbort?.abort()
      const streaming = [...(this.current?.messages ?? [])].reverse()
        .find((item) => item.status === 'streaming')
      if (streaming) {
        streaming.status = 'interrupted'
        streaming.error = 'Response interrupted'
        streaming.updatedAt = Date.now()
      }
    },

    reset(): void {
      generation += 1
      activeAbort?.abort()
      activeAbort = null
      this.list = []
      this.current = null
      this.activeId = null
      this.draft = ''
      this.loaded = false
      this.loading = false
      this.sending = false
      this.error = null
    },

    async ensureConversation(): Promise<ChatConversation> {
      if (this.current) return this.current
      const activeGeneration = generation
      const conversation = await api.createChatConversation()
      if (activeGeneration !== generation) {
        const error = new Error('Conversation request was cancelled')
        error.name = 'AbortError'
        throw error
      }
      this.current = conversation
      this.activeId = conversation.id
      this.upsertSummary(conversation)
      return conversation
    },

    async runStream(
      request: (handlers: ConversationStreamHandlers, signal: AbortSignal) => Promise<void>,
      restoreDraft = ''
    ): Promise<void> {
      const activeGeneration = generation
      this.sending = true
      this.error = null
      const controller = new AbortController()
      activeAbort = controller
      let accepted = false
      let terminalFailure = false
      const handlers: ConversationStreamHandlers = {
        accepted: ({ conversation, userMessage, assistantMessage }) => {
          if (activeGeneration !== generation) return
          accepted = true
          this.upsertSummary(conversation)
          if (!this.current || this.current.id !== conversation.id) return
          Object.assign(this.current, conversation)
          if (userMessage) this.current.messages.push(userMessage)
          this.current.messages.push(assistantMessage)
        },
        delta: (messageId, text) => {
          if (activeGeneration !== generation) return
          const target = this.current?.messages.find((item) => item.id === messageId)
          if (target) target.content += text
        },
        done: (message) => {
          if (activeGeneration !== generation) return
          this.replaceMessage(message)
          this.touchCurrent(message.updatedAt)
        },
        error: (message) => {
          if (activeGeneration !== generation) return
          terminalFailure = true
          this.replaceMessage(message)
          this.touchCurrent(message.updatedAt)
        }
      }
      try {
        await request(handlers, controller.signal)
      } catch (error) {
        if (activeGeneration !== generation) return
        if ((error as Error).name === 'AbortError') {
          const streaming = [...(this.current?.messages ?? [])].reverse()
            .find((item) => item.status === 'streaming')
          if (streaming) {
            streaming.status = 'interrupted'
            streaming.error = 'Response interrupted'
          }
        } else if (!accepted) {
          this.error = (error as Error).message
          if (restoreDraft) this.draft = restoreDraft
        } else if (!terminalFailure && !this.error) {
          this.error = (error as Error).message
        }
      } finally {
        if (activeGeneration === generation) this.sending = false
        if (activeAbort === controller) activeAbort = null
      }
    },

    replaceMessage(updated: ChatMessage): void {
      if (!this.current) return
      const index = this.current.messages.findIndex((item) => item.id === updated.id)
      if (index >= 0) this.current.messages[index] = updated
    },

    touchCurrent(updatedAt: number): void {
      if (!this.current) return
      this.current.updatedAt = updatedAt
      this.upsertSummary(this.current)
    },

    upsertSummary(updated: ChatConversationSummary): void {
      this.list = byUpdated([
        { id: updated.id, title: updated.title, createdAt: updated.createdAt, updatedAt: updated.updatedAt },
        ...this.list.filter((item) => item.id !== updated.id)
      ])
    }
  }
})
