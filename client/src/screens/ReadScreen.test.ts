// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import userEvent from '@testing-library/user-event'
import ReadScreen from './ReadScreen.vue'
import { useLibrary } from '../stores/library'
import { useReader } from '../stores/reader'
import { useSettings } from '../stores/settings'
import { api } from '../services/api'
import { pathologicalModule } from '../test/fixtures/moduleInfo'

let wrapper: VueWrapper
beforeEach(() => {
  vi.restoreAllMocks()
  const pinia = createPinia()
  setActivePinia(pinia)
  useLibrary().modules = [{ ...pathologicalModule, name: 'KJV', installed: true }]
  const reader = useReader()
  reader.ready = true
  reader.moduleName = 'KJV'
  reader.book = 'John'
  reader.chapter = 1
  reader.books = [{ code: 'John', name: 'John', chapters: 21, section: 'nt' }]
  reader.data = {
    module: 'KJV', book: 'John', bookName: 'John', chapter: 1,
    verses: [
      { n: 1, text: 'In the beginning was the Word, and the Word was with God, and the Word was God.', notes: [], crossReferences: [], segments: [
        { kind: 'text', text: 'In the beginning was the ' },
        { kind: 'word', text: 'Word', strongs: ['G3056'] },
        { kind: 'text', text: ', and the Word was with God, and the Word was God.' }
      ] },
      { n: 2, text: 'The same was in the beginning with God.', notes: [], crossReferences: [], segments: [
        { kind: 'text', text: 'The same was in the beginning with ' },
        { kind: 'word', text: 'God', strongs: ['G2316'] },
        { kind: 'text', text: '.' }
      ] }
    ]
  }
  useSettings().showStrongs = true
  wrapper = mount(ReadScreen, { attachTo: document.body, global: { plugins: [pinia] } })
})
afterEach(() => {
  wrapper.unmount()
  document.body.innerHTML = ''
})

describe('reader keyboard accessibility', () => {
  it('selects, extends, and clears verses from native buttons without nesting word controls', async () => {
    const user = userEvent.setup()
    const reader = useReader()
    const numbers = wrapper.findAll('button.vnum')
    expect(numbers[0].attributes('aria-label')).toBe('Select verse 1')
    expect(numbers.map((button) => button.attributes('aria-pressed'))).toEqual(['false', 'false'])
    ;(numbers[0].element as HTMLElement).focus()
    await user.keyboard('{Enter}')
    expect(reader.selectedVerses).toEqual([1])
    await user.keyboard(' ')
    expect(reader.selectedVerses).toEqual([])
    await user.keyboard('{Enter}')
    ;(numbers[1].element as HTMLElement).focus()
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(reader.selectedVerses).toEqual([1, 2])
    expect(numbers.map((button) => button.attributes('aria-pressed'))).toEqual(['true', 'true'])
    await user.keyboard('{Escape}')
    expect(reader.selectedVerses).toEqual([])
    expect(wrapper.find('.verse button button').exists()).toBe(false)
    await user.tab()
    expect(document.activeElement).toBe(wrapper.findAll('button.wtap')[1].element)
  })

  it.each(['{Shift>}{F10}{/Shift}', '{ContextMenu}'])('opens passage actions with %s and restores focus on Escape', async (key) => {
    const user = userEvent.setup()
    const number = wrapper.get('button.vnum').element as HTMLElement
    number.focus()
    await user.keyboard('{F10}')
    expect(document.querySelector('[role="toolbar"]')).toBeNull()
    await user.keyboard(key)
    await flushPromises()
    expect(useReader().selectedVerses).toEqual([1])
    const toolbar = document.querySelector('[role="toolbar"]')!
    expect(toolbar.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.textContent).toBe('Word study')
    await user.keyboard('{Escape}')
    expect(document.querySelector('[role="toolbar"]')).toBeNull()
    expect(document.activeElement).toBe(number)
  })

  it.each(['{Enter}', ' '])('looks up a word with %s and announces a failed lookup without changing verse selection', async (key) => {
    const user = userEvent.setup()
    const lookup = vi.spyOn(api, 'strongs').mockRejectedValueOnce(new Error('Lexicon unavailable'))
    useReader().selectVerse(2)
    const word = wrapper.get('button.wtap')
    expect(word.attributes('aria-label')).toBe('Study Word (G3056)')
    ;(word.element as HTMLElement).focus()
    await user.keyboard(key)
    await flushPromises()
    expect(lookup).toHaveBeenCalledExactlyOnceWith('G3056')
    expect(useReader().selectedVerses).toEqual([2])
    expect(wrapper.get('[role="alert"]').text()).toContain('No entry for G3056.')
    expect(wrapper.find('.strongs-card').exists()).toBe(false)
  })

  it('retains keyboard verse selection when word study is hidden, and announces chapter errors', async () => {
    const user = userEvent.setup()
    useSettings().showStrongs = false
    await flushPromises()
    expect(wrapper.find('button.wtap').exists()).toBe(false)
    const number = wrapper.get('button.vnum').element as HTMLElement
    number.focus()
    await user.keyboard(' ')
    expect(useReader().selectedVerses).toEqual([1])
    useReader().error = 'Chapter unavailable'
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Chapter unavailable')
    expect(wrapper.find('button.vnum').exists()).toBe(false)
  })
})
