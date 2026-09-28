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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const passage = { reference: 'John 1:1', module: 'WEB', content: 'The Word' }
const preferences = { alwaysCite: true, drawApocrypha: false }

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

  it('locks the first send before creating a conversation', async () => {
    const creation = deferred<ChatConversation>()
    const create = vi.spyOn(api, 'createChatConversation').mockReturnValue(creation.promise)
    const stream = vi.spyOn(api, 'streamConversationMessage').mockResolvedValue()
    const chats = useChatConversations()
    chats.draft = 'Question'
    const first = chats.send(passage, preferences)
    expect(chats.sending).toBe(true)
    await chats.send(passage, preferences)
    expect(create).toHaveBeenCalledTimes(1)
    creation.resolve({ ...conversation, messages: [] })
    await first
    expect(stream).toHaveBeenCalledTimes(1)
    expect(chats.sending).toBe(false)
  })

  it('stops pending creation without consuming the draft or starting a stream', async () => {
    const creation = deferred<ChatConversation>()
    const create = vi.spyOn(api, 'createChatConversation').mockReturnValue(creation.promise)
    const stream = vi.spyOn(api, 'streamConversationMessage')
    const chats = useChatConversations()
    chats.draft = 'Question'
    const pending = chats.send(passage, preferences)
    chats.stop()
    creation.resolve({ ...conversation, messages: [] })
    await pending
    expect(create.mock.calls[0][0]?.aborted).toBe(true)
    expect(chats.draft).toBe('Question')
    expect(chats.current).toBeNull()
    expect(chats.sending).toBe(false)
    expect(stream).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'])('ignores an older history selection %s and its loading cleanup', async (outcome) => {
    const first = deferred<ChatConversation>()
    const second = deferred<ChatConversation>()
    vi.spyOn(api, 'chatConversation').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const chats = useChatConversations()
    const selectingFirst = chats.select('first')
    const selectingSecond = chats.select('second')
    if (outcome === 'success') first.resolve({ ...conversation, id: 'first', messages: [] })
    else first.reject(new Error('obsolete error'))
    await selectingFirst
    expect(chats.loading).toBe(true)
    expect(chats.error).toBeNull()
    second.resolve({ ...conversation, id: 'second', messages: [] })
    await selectingSecond
    expect(chats.activeId).toBe('second')
    expect(chats.loading).toBe(false)
  })

  it('keeps the latest selection when history responses resolve in reverse order', async () => {
    const first = deferred<ChatConversation>()
    vi.spyOn(api, 'chatConversation').mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ...conversation, id: 'second', messages: [] })
    const chats = useChatConversations()
    const selectingFirst = chats.select('first')
    await chats.select('second')
    chats.draft = 'Current draft'
    first.resolve({ ...conversation, id: 'first', messages: [] })
    await selectingFirst
    expect(chats.activeId).toBe('second')
    expect(chats.draft).toBe('Current draft')
  })

  it('invalidates history selection when starting a new chat', async () => {
    const selected = deferred<ChatConversation>()
    vi.spyOn(api, 'chatConversation').mockReturnValue(selected.promise)
    const chats = useChatConversations()
    const selecting = chats.select('first')
    chats.newChat()
    chats.draft = 'New question'
    selected.resolve({ ...conversation, id: 'first', messages: [] })
    await selecting
    expect(chats.current).toBeNull()
    expect(chats.activeId).toBeNull()
    expect(chats.draft).toBe('New question')
    expect(chats.loading).toBe(false)
  })

  it('does not send into the previous conversation while selection is pending', async () => {
    const selected = deferred<ChatConversation>()
    vi.spyOn(api, 'chatConversation').mockReturnValue(selected.promise)
    const stream = vi.spyOn(api, 'streamConversationMessage')
    const chats = useChatConversations()
    chats.current = { ...conversation, messages: [] }
    chats.activeId = conversation.id
    chats.draft = 'Question'
    const selecting = chats.select('second')
    await chats.send(passage, preferences)
    expect(stream).not.toHaveBeenCalled()
    selected.resolve({ ...conversation, id: 'second', messages: [] })
    await selecting
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
    await vi.waitFor(() => expect(chats.current?.messages[1]?.content).toBe('Partial answer'))

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

  it.each(['offline', 'streaming', 'completed'] as const)(
    'reconciles accepted partial responses after transport failure (%s)', async (recovery) => {
      vi.spyOn(api, 'createChatConversation').mockResolvedValue({ ...conversation, messages: [] })
      vi.spyOn(api, 'streamConversationMessage').mockImplementation(async (_id, _input, handlers) => {
        handlers.accepted({
          conversation: conversationSummary, userMessage: userMessage(), assistantMessage: assistantMessage()
        })
        handlers.delta('assistant-1', 'Partial answer')
        throw new Error('Response stream ended before completion')
      })
      const refresh = vi.spyOn(api, 'chatConversation')
      if (recovery === 'offline') refresh.mockRejectedValue(new Error('offline'))
      else refresh.mockResolvedValue({
        ...conversation, messages: [userMessage(), assistantMessage(recovery, recovery === 'completed' ? 'Full answer' : 'Partial')]
      })
      const chats = useChatConversations()
      chats.draft = 'Question'
      await chats.send(
        { reference: 'John 1:1', module: 'WEB', content: 'The Word' },
        { alwaysCite: true, drawApocrypha: false }
      )
      expect(refresh).toHaveBeenCalledWith(conversation.id)
      expect(chats.current?.messages[1]).toMatchObject({
        content: recovery === 'completed' ? 'Full answer' : 'Partial answer',
        status: recovery === 'completed' ? 'completed' : 'interrupted'
      })
      expect(chats.error).toBe(recovery === 'completed' ? null : 'Response stream ended before completion')
      expect(chats.sending).toBe(false)
    }
  )
})
