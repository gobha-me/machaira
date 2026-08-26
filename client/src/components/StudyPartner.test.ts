// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../services/api'
import { useAiProvider } from '../stores/aiProvider'
import { useChatConversations } from '../stores/chatConversations'
import { useSettings } from '../stores/settings'
import StudyPartner from './StudyPartner.vue'

let pinia: ReturnType<typeof createPinia>

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  passage: ChatMessage['passage'],
  status: ChatMessage['status'] = 'completed',
  replyToMessageId: string | null = null
): ChatMessage {
  return {
    id, role, content, passage, status, replyToMessageId,
    error: status === 'interrupted' ? 'Response interrupted' : null,
    createdAt: 100,
    updatedAt: 100
  }
}

describe('StudyPartner', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.restoreAllMocks()
  })

  it('renders saved passage changes and retryable interrupted attempts', async () => {
    const chats = useChatConversations()
    const ai = useAiProvider()
    const settings = useSettings()
    settings.drawApocrypha = false
    ai.provider = {
      kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama', hasApiKey: false
    }
    ai.ready = true
    chats.activeId = 'conversation-1'
    chats.list = [{ id: 'conversation-1', title: 'Grace', createdAt: 100, updatedAt: 100 }]
    chats.current = {
      ...chats.list[0],
      messages: [
        message('user-1', 'user', 'First question', { reference: 'John 1:1', module: 'WEB' }),
        message('assistant-1', 'assistant', '**First answer**', null, 'completed', 'user-1'),
        message('user-2', 'user', 'Second question', { reference: 'Romans 8:1', module: 'WEB' }),
        message('assistant-2', 'assistant', 'Partial answer', null, 'interrupted', 'user-2')
      ]
    }
    vi.spyOn(chats, 'retry').mockResolvedValue()
    const wrapper = mount(StudyPartner, {
      props: { passage: { reference: 'Romans 8:1', module: 'WEB', content: 'No condemnation' } },
      global: { plugins: [pinia] }
    })

    expect(wrapper.findAll('.context-chip').map((item) => item.text())).toEqual([
      'Context · John 1:1 · WEB',
      'Context · Romans 8:1 · WEB'
    ])
    expect(wrapper.get('strong').text()).toBe('First answer')
    expect(wrapper.get('.message-status').text()).toContain('Response interrupted')
    await wrapper.get('.message-status button').trigger('click')
    expect(chats.retry).toHaveBeenCalledWith('assistant-2', {
      alwaysCite: true,
      drawApocrypha: false
    })
  })

  it('exposes history and starts a clean unsaved chat', async () => {
    const chats = useChatConversations()
    const ai = useAiProvider()
    ai.provider = {
      kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama', hasApiKey: false
    }
    ai.ready = true
    chats.activeId = 'conversation-1'
    chats.list = [{ id: 'conversation-1', title: 'Saved chat', createdAt: 100, updatedAt: 100 }]
    chats.current = { ...chats.list[0], messages: [] }
    const wrapper = mount(StudyPartner, {
      props: { passage: { reference: 'John 1:1', module: 'WEB', content: 'The Word' } },
      global: { plugins: [pinia] }
    })

    await wrapper.get('.history-toggle').trigger('click')
    expect(wrapper.get('.history-menu').text()).toContain('Saved chat')
    await wrapper.get('.new-chat').trigger('click')
    expect(chats.activeId).toBeNull()
    expect(chats.current).toBeNull()
  })
})
