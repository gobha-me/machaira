// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import JournalScreen from './JournalScreen.vue'
import userEvent from '@testing-library/user-event'
import { api, type Note } from '../services/api'
import { useNotes } from '../stores/notes'
import { useReader } from '../stores/reader'

const note: Note = {
  id: 'note', title: 'Keep this note', body: 'Content', tags: [], refs: [], createdAt: 1, updatedAt: 1
}
let wrapper: VueWrapper

beforeEach(() => {
  vi.restoreAllMocks()
  const pinia = createPinia()
  setActivePinia(pinia)
  useNotes().resetPersonalData()
  useReader().ready = true
  wrapper = mount(JournalScreen, { attachTo: document.body, global: { plugins: [pinia], stubs: { MarkdownEditor: true } } })
})
afterEach(() => {
  wrapper.unmount()
  document.body.innerHTML = ''
  useNotes().resetPersonalData()
})

describe('journal mutation feedback', () => {
  it('renders a create failure even with an empty journal and permits retry', async () => {
    vi.spyOn(api, 'createNote').mockRejectedValueOnce(new Error('Create forbidden')).mockResolvedValueOnce(note)
    await wrapper.get('button.new').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Create forbidden')
    expect(useNotes().list).toEqual([])
    await wrapper.get('button.new').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('.title-input').element).toHaveProperty('value', note.title)
  })

  it('renders delete and restore failures, retains content, and restores through Undo', async () => {
    vi.spyOn(api, 'deleteNote').mockRejectedValueOnce(new Error('Delete forbidden')).mockResolvedValueOnce()
    vi.spyOn(api, 'createNote').mockRejectedValueOnce(new Error('Restore offline'))
      .mockResolvedValueOnce({ ...note, id: 'restored' })
    const notes = useNotes()
    notes.list = [note]
    notes.currentId = note.id
    await flushPromises()
    await wrapper.get('button.del').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Delete forbidden')
    expect(wrapper.get('.title-input').element).toHaveProperty('value', note.title)
    expect(wrapper.find('.undo-note').exists()).toBe(false)

    await wrapper.get('button.del').trigger('click')
    await flushPromises()
    expect(wrapper.find('.title-input').exists()).toBe(false)
    await wrapper.get('.undo-note button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Restore offline')
    expect(wrapper.get('.undo-note button').attributes('disabled')).toBeUndefined()
    await wrapper.get('.undo-note button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('.undo-note').exists()).toBe(false)
    expect(notes.current).toMatchObject({ body: note.body, title: note.title })
  })
})


describe('journal keyboard selection', () => {
  it.each(['{Enter}', ' '])('selects an untitled failed-save row with %s without losing its draft', async (key) => {
    const user = userEvent.setup()
    const notes = useNotes()
    notes.list = [note, { ...note, id: 'untitled', title: '', body: 'Unsaved draft', tags: ['tag'] }]
    notes.currentId = note.id
    notes.saveErrors.untitled = 'Offline'
    await flushPromises()
    const rows = wrapper.findAll('button.item')
    expect(rows.map((row) => row.attributes('aria-pressed'))).toEqual(['true', 'false'])
    expect(rows[1].text()).toContain('Untitled note')
    expect(rows[1].get('[role="status"]').text()).toContain('Save failed')
    ;(rows[1].element as HTMLElement).focus()
    await user.keyboard(key)
    expect(notes.currentId).toBe('untitled')
    expect(notes.current?.body).toBe('Unsaved draft')
    expect(rows.map((row) => row.attributes('aria-pressed'))).toEqual(['false', 'true'])
    expect(wrapper.find('button.item button').exists()).toBe(false)
  })
})
