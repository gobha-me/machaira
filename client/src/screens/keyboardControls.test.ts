// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import userEvent from '@testing-library/user-event'
import PlanScreen from './PlanScreen.vue'
import StudyScreen from './StudyScreen.vue'
import { useReadingPlan } from '../stores/readingPlan'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { api } from '../services/api'

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('screen keyboard controls', () => {
  it('keeps opening a plan chapter separate from marking it read, including when no module is installed', async () => {
    const plan = useReadingPlan()
    plan.enabled = true
    const persist = vi.spyOn(plan, 'persist').mockImplementation(() => {})
    const open = vi.spyOn(useReader(), 'openRef').mockRejectedValue(new Error('Must not open without a module'))
    const go = vi.spyOn(useUi(), 'go')
    const wrapper = mount(PlanScreen, { attachTo: document.body })
    const user = userEvent.setup()
    try {
      const row = wrapper.get('.read-row')
      expect(row.find('button button').exists()).toBe(false)
      ;(row.get('.open').element as HTMLElement).focus()
      await user.keyboard('{Enter}')
      expect(go).toHaveBeenCalledWith('library')
      expect(open).not.toHaveBeenCalled()
      expect(plan.completed.size).toBe(0)
      expect(persist).not.toHaveBeenCalled()
      ;(row.get('.read-toggle').element as HTMLElement).focus()
      await user.keyboard(' ')
      expect(plan.completed.size).toBe(1)
      expect(row.get('.read-toggle').attributes('aria-pressed')).toBe('true')
      await user.keyboard('{Enter}')
      expect(plan.completed.size).toBe(0)
      expect(row.get('.read-toggle').attributes('aria-pressed')).toBe('false')
    } finally {
      wrapper.unmount()
    }
  })

  it('selects and deselects a Study verse and exposes failed word lookup through native keyboard controls', async () => {
    const reader = useReader()
    reader.ready = true
    reader.moduleName = 'KJV'
    reader.book = 'John'
    reader.chapter = 1
    reader.data = {
      module: 'KJV', book: 'John', bookName: 'John', chapter: 1,
      verses: [{
        n: 1, text: 'In the beginning was the Word', notes: [], crossReferences: [],
        segments: [
          { kind: 'text', text: 'In the beginning was the ' },
          { kind: 'word', text: 'Word', strongs: ['G3056'] }
        ]
      }]
    }
    const lookup = vi.spyOn(api, 'strongs').mockRejectedValue(new Error('Lexicon unavailable'))
    const wrapper = mount(StudyScreen, {
      attachTo: document.body,
      global: { stubs: { CommentaryPanel: true, ComparePanel: true, CrossReferencesPanel: true, StudyPartner: true } }
    })
    const user = userEvent.setup()
    try {
      await flushPromises()
      const number = wrapper.get('button.cvnum')
      ;(number.element as HTMLElement).focus()
      await user.keyboard('{Enter}')
      expect(reader.selectedVerses).toEqual([1])
      await user.keyboard(' ')
      expect(reader.selectedVerses).toEqual([])
      await user.keyboard('{F10}')
      expect(wrapper.find('[role="toolbar"]').exists()).toBe(false)
      const word = wrapper.get('button.wtap')
      expect(word.attributes('aria-label')).toBe('Study Word (G3056)')
      ;(word.element as HTMLElement).focus()
      await user.keyboard('{Enter}')
      await flushPromises()
      expect(lookup).toHaveBeenCalledWith('G3056')
      expect(reader.selectedVerses).toEqual([1])
      expect(wrapper.get('.strongs-error').text()).toBe('No entry for G3056.')
      expect(wrapper.find('button button').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })
})
