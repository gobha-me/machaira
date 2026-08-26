import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  api,
  type ChatConversation,
  type ChatMessage,
  type ConversationStreamHandlers
} from '../services/api'
import { useChatConversations } from './chatConversations'

function userMessage(id = 'user-1'): ChatMessage {
  return {
    id,
    role: 'user',
    content: 'What does this mean?',
    status: 'completed',
    replyToMessageId: null,
    passage: { reference: 'John 1:1', module: 'WEB' },
    error: null,
    createdAt: 100,
    updatedAt: 100
  }
}

function assistantMessage(
  status: ChatMessage['status'] = 'streaming',
  content = '',
  id = 'assistant-1'
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    status,
    replyToMessageId: 'user-1',
    passage: null,
    error: status === 'failed' ? 'Provider failed' : null,
    createdAt: 101,
    updatedAt: 101
  }
}

const conversationSummary = {
  id: 'conversation-1',
  title: 'What does this mean?',
  createdAt: 100,
  updatedAt: 100
}

const conversation: ChatConversation = {
  ...conversationSummary,
  messages: []
}

describe('chat conversations store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('restores the most recently updated server conversation', async () => {
    vi.spyOn(api, 'chatConversations').mockResolvedValue([
      { ...conversation, id: 'older', updatedAt: 100 },
      { ...conversation, id: 'newer', updatedAt: 200 }
    ])
    vi.spyOn(api, 'chatConversation').mockResolvedValue({
      ...conversation, id: 'newer', updatedAt: 200, messages: [userMessage()]
    })
    const chats = useChatConversations()

    await chats.load()

    expect(chats.activeId).toBe('newer')
    expect(chats.current?.messages).toHaveLength(1)
  })

  it('creates lazily and reconciles persisted streaming events', async () => {
    vi.spyOn(api, 'createChatConversation').mockResolvedValue({
      ...conversation, title: 'New chat', messages: []
    })
    vi.spyOn(api, 'streamConversationMessage').mockImplementation(async (
      _id,
      _input,
      handlers: ConversationStreamHandlers
    ) => {
      handlers.accepted({
        conversation: conversationSummary,
        userMessage: userMessage(),
        assistantMessage: assistantMessage()
      })
      handlers.delta('assistant-1', 'Grace')
      handlers.done(assistantMessage('completed', 'Grace'))
    })
    const chats = useChatConversations()
    chats.draft = 'What does this mean?'

    await chats.send(
      { reference: 'John 1:1', module: 'WEB', content: 'The Word' },
      { alwaysCite: true, drawApocrypha: false }
    )

    expect(api.createChatConversation).toHaveBeenCalledTimes(1)
    expect(chats.current?.messages.map((message) => message.content)).toEqual([
      'What does this mean?', 'Grace'
    ])
    expect(chats.current?.messages[1].status).toBe('completed')
    expect(chats.draft).toBe('')
    expect(chats.sending).toBe(false)
  })

  it('keeps failed attempts and appends a retry response', async () => {
    const chats = useChatConversations()
    chats.current = {
      ...conversation,
      messages: [userMessage(), assistantMessage('failed')]
    }
    chats.activeId = conversation.id
    vi.spyOn(api, 'retryConversationMessage').mockImplementation(async (
      _conversationId,
      _messageId,
      _preferences,
      handlers
    ) => {
      const retry = assistantMessage('streaming', '', 'assistant-2')
      handlers.accepted({ conversation: conversationSummary, userMessage: null, assistantMessage: retry })
      handlers.delta(retry.id, 'A complete answer')
      handlers.done({ ...retry, content: 'A complete answer', status: 'completed', updatedAt: 200 })
    })

    await chats.retry('assistant-1', { alwaysCite: true, drawApocrypha: false })

    expect(chats.current.messages).toHaveLength(3)
    expect(chats.current.messages[1].status).toBe('failed')
    expect(chats.current.messages[2]).toMatchObject({ status: 'completed', content: 'A complete answer' })
  })

  it('retains streamed partial text when the response is stopped', async () => {
    vi.spyOn(api, 'createChatConversation').mockResolvedValue({ ...conversation, messages: [] })
    vi.spyOn(api, 'streamConversationMessage').mockImplementation(async (
      _id,
      _input,
      handlers,
      signal
    ) => {
      handlers.accepted({
        conversation: conversationSummary,
        userMessage: userMessage(),
        assistantMessage: assistantMessage()
      })
      handlers.delta('assistant-1', 'Partial answer')
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('Aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    })
    const chats = useChatConversations()
    chats.draft = 'What does this mean?'
    const sending = chats.send(
      { reference: 'John 1:1', module: 'WEB', content: 'The Word' },
      { alwaysCite: true, drawApocrypha: false }
    )
    await vi.waitFor(() => expect(chats.sending).toBe(true))

    chats.stop()
    await sending

    expect(chats.current?.messages[1]).toMatchObject({
      content: 'Partial answer',
      status: 'interrupted'
    })
    expect(chats.sending).toBe(false)
  })

  it('clears personal conversation state on account reset', () => {
    const chats = useChatConversations()
    chats.list = [conversation]
    chats.current = conversation
    chats.activeId = conversation.id
    chats.draft = 'Unsaved question'

    chats.reset()

    expect(chats.list).toEqual([])
    expect(chats.current).toBeNull()
    expect(chats.activeId).toBeNull()
    expect(chats.draft).toBe('')
  })
})
