// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { api } from '../services/api'
import { useNotes } from './useNotes'
import { useReader } from '../stores/reader'

const Composer = defineComponent({
  setup: () => useNotes(),
  template: `<input v-model="title"><textarea v-model="body"></textarea>
    <p v-if="error" role="alert">{{ error }}</p>
    <span v-if="saved">Saved</span>
    <button :disabled="saving" @click="save">Save</button>
    <button class="anchor-selection" @click="anchorSelection('John 1:1–2 · KJV', 'the Word')">Selection note</button>
    <span class="anchor">{{ anchor }}</span>`
})
let wrapper: VueWrapper
beforeEach(() => {
  vi.restoreAllMocks()
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(Composer, { global: { plugins: [pinia] } })
})
afterEach(() => wrapper.unmount())

describe('passage note composer', () => {
  it('keeps the selected anchor and quote through save failure and navigation, then retries against the original passage', async () => {
    const create = vi.spyOn(api, 'createNote').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      id: 'note', title: 'John 1:1–2 · KJV', body: '> the Word', refs: ['John 1:1–2 · KJV'], tags: [], createdAt: 1, updatedAt: 1
    })
    await wrapper.get('.anchor-selection').trigger('click')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('offline')
    useReader().book = 'Mark'
    useReader().chapter = 3
    await flushPromises()
    expect(wrapper.get('.anchor').text()).toBe('John 1:1–2 · KJV')
    expect(wrapper.get('textarea').element).toHaveProperty('value', '> the Word\n\n')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ refs: ['John 1:1–2 · KJV'], body: '> the Word' }))
    expect(wrapper.get('textarea').element).toHaveProperty('value', '')
  })

  it('does not overwrite or re-anchor an existing draft when another selection starts a note', async () => {
    await wrapper.get('textarea').setValue('Keep this draft')
    await wrapper.get('.anchor-selection').trigger('click')
    expect(wrapper.get('textarea').element).toHaveProperty('value', 'Keep this draft')
    expect(wrapper.get('[role="alert"]').text()).toContain('Save the current note')
    expect(wrapper.get('.anchor').text()).not.toContain('John 1:1–2')
  })

  it('preserves input and renders creation failures without claiming success', async () => {
    vi.spyOn(api, 'createNote').mockRejectedValue(new Error('Invalid reference'))
    await wrapper.get('input').setValue('Draft title')
    await wrapper.get('textarea').setValue('Draft body')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not create note: Invalid reference')
    expect(wrapper.get('input').element).toHaveProperty('value', 'Draft title')
    expect(wrapper.get('textarea').element).toHaveProperty('value', 'Draft body')
    expect(wrapper.text()).not.toContain('Saved')
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
  })

  it('rejects empty input and prevents duplicate submissions during an outstanding request', async () => {
    const create = vi.spyOn(api, 'createNote').mockReturnValue(new Promise(() => {}))
    await wrapper.get('textarea').setValue('  \n ')
    await wrapper.get('button').trigger('click')
    expect(create).not.toHaveBeenCalled()
    await wrapper.get('textarea').setValue('Draft')
    await wrapper.get('button').trigger('click')
    await wrapper.get('button').trigger('click')
    expect(create).toHaveBeenCalledOnce()
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })
})
