// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import userEvent from '@testing-library/user-event'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettings } from '../stores/settings'
import { useChatConversations } from '../stores/chatConversations'
import { useAiProvider } from '../stores/aiProvider'
import StudyPartnerDrawer from './StudyPartnerDrawer.vue'

let wrapper: VueWrapper
let mobile: boolean
let mediaEvents: EventTarget

beforeEach(() => {
  setActivePinia(createPinia())
  mobile = false
  mediaEvents = new EventTarget()
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    get matches() { return mobile },
    media: '(max-width: 768px)', onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: mediaEvents.addEventListener.bind(mediaEvents),
    removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents),
    dispatchEvent: mediaEvents.dispatchEvent.bind(mediaEvents)
  })
})

afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function start() {
  wrapper = mount(defineComponent({
    components: { StudyPartnerDrawer },
    setup() { return { settings: useSettings(), opener: ref<HTMLElement | null>(null) } },
    template: `<div><main><button ref="opener" aria-controls="study-partner" :aria-expanded="settings.studyPartnerOpen" @click="settings.toggle('studyPartnerOpen')">Study partner</button><input aria-label="Reading control"></main><StudyPartnerDrawer :return-focus="opener" /></div>`
  }), { attachTo: document.body })
  return wrapper.get('main button').element as HTMLButtonElement
}

describe('Study partner drawer accessibility', () => {
  it('opens by shortcut inside an editor, allows desktop focus to leave, and restores focus on Escape', async () => {
    const user = userEvent.setup()
    const opener = start()
    const reading = wrapper.get('main input').element as HTMLInputElement
    reading.focus()
    await user.keyboard('{Control>}{Shift>}Y{/Shift}{/Control}')
    await flushPromises()
    expect(useSettings().studyPartnerOpen).toBe(true)
    expect(opener.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close study partner')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.element.closest('[inert]')).toBeNull()
    reading.focus()
    await user.keyboard('{Escape}')
    expect(useSettings().studyPartnerOpen).toBe(true)
    ;(wrapper.get('.close-partner').element as HTMLElement).focus()
    await user.keyboard('{Escape}')
    await flushPromises()
    expect(wrapper.find('#study-partner').exists()).toBe(false)
    expect(document.activeElement).toBe(reading)
  })

  it('ignores repeat/composition/Alt variants and removes shortcut listeners on unmount', async () => {
    start()
    for (const extra of [{ repeat: true }, { isComposing: true }, { altKey: true }]) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, shiftKey: true, ...extra }))
      expect(useSettings().studyPartnerOpen).toBe(false)
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', metaKey: true, shiftKey: true }))
    await flushPromises()
    expect(useSettings().studyPartnerOpen).toBe(true)
    wrapper.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', metaKey: true, shiftKey: true }))
    expect(useSettings().studyPartnerOpen).toBe(true)
  })

  it('uses a labelled mobile dialog, contains Tab and programmatic focus, and restores the background on close', async () => {
    mobile = true
    const user = userEvent.setup()
    const opener = start()
    await user.click(opener)
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent?.trim()).toBe('Study partner')
    expect(dialog.querySelector('.mobile-sheet')).not.toBeNull()
    expect(wrapper.element.closest('[inert]')).not.toBeNull()
    expect(wrapper.element.closest('[aria-hidden="true"]')).not.toBeNull()
    opener.focus()
    expect(dialog.contains(document.activeElement)).toBe(true)
    const first = document.activeElement
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement).toBe(dialog.querySelector('.dn-btn'))
    await user.keyboard('{Tab}')
    expect(document.activeElement).toBe(first)
    await user.keyboard('{Escape}')
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.element.closest('[inert]')).toBeNull()
    expect(wrapper.element.closest('[aria-hidden]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps drafts and failed history across close/reopen and mobile breakpoint changes', async () => {
    const opener = start()
    useAiProvider().provider = { kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'configured', hasApiKey: false }
    const chats = useChatConversations()
    chats.draft = 'Keep this question'
    chats.error = 'History offline'
    opener.click()
    await flushPromises()
    mobile = true
    mediaEvents.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    mobile = false
    mediaEvents.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.element.closest('[inert]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close study partner')
    await wrapper.get('.close-partner').trigger('click')
    opener.click()
    await flushPromises()
    expect(chats.draft).toBe('Keep this question')
    expect(chats.error).toBe('History offline')
    expect(wrapper.get('.chat-error').text()).toBe('History offline')
  })

  it('does not stop or discard a streaming response when collapsed', async () => {
    const opener = start()
    const chats = useChatConversations()
    useAiProvider().provider = { kind: 'local', baseUrl: 'http://localhost:11434/v1', model: 'configured', hasApiKey: false }
    chats.activeId = 'streaming'
    chats.current = { id: 'streaming', title: 'In progress', createdAt: 1, updatedAt: 1, messages: [
      { id: 'reply', role: 'assistant', content: 'Partial answer', status: 'streaming', passage: null,
        replyToMessageId: 'question', error: null, createdAt: 1, updatedAt: 1 }
    ] }
    chats.sending = true
    const stop = vi.spyOn(chats, 'stop')
    opener.click()
    await flushPromises()
    await wrapper.get('.close-partner').trigger('click')
    chats.current.messages[0].content += ' received while closed'
    opener.click()
    await flushPromises()
    expect(stop).not.toHaveBeenCalled()
    expect(chats.sending).toBe(true)
    expect(wrapper.text()).toContain('Partial answer received while closed')
    expect(wrapper.get('[aria-label="Stop response"]').attributes('type')).toBe('button')
  })
})
