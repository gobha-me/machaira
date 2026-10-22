// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import userEvent from '@testing-library/user-event'
import StudyScreen from './StudyScreen.vue'
import { api } from '../services/api'
import { useReader } from '../stores/reader'
import { useLibrary } from '../stores/library'
import { pathologicalModule } from '../test/fixtures/moduleInfo'

let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  useLibrary().modules = [
    { ...pathologicalModule, name: 'KJV', kind: 'scripture', installed: true },
    { ...pathologicalModule, name: 'Geneva', kind: 'commentary', installed: true }
  ]
  const reader = useReader()
  reader.ready = true
  reader.moduleName = 'KJV'
  reader.book = 'John'
  reader.chapter = 1
  reader.books = [{ code: 'John', name: 'John', chapters: 21, section: 'nt' }]
  reader.data = {
    module: 'KJV', book: 'John', bookName: 'John', chapter: 1,
    verses: [1, 2, 3].map((n) => ({
      n, text: `Verse ${n}`, segments: [{ kind: 'text', text: `Verse ${n}` }],
      notes: [], crossReferences: []
    }))
  }
  vi.spyOn(api, 'compare').mockResolvedValue({
    bookName: 'John', translations: []
  })
  vi.spyOn(api, 'commentary').mockResolvedValue({
    module: 'Geneva', book: 'John', bookName: 'John', chapter: 1, locked: false,
    entries: [{ n: 1, text: 'Only the first verse has a note.', notes: [], segments: [] }, { n: 3, text: '  ', notes: [], segments: [] }]
  })
  vi.spyOn(api, 'connections').mockResolvedValue({ nodes: [], edges: [], warnings: [], semanticState: 'ready' })
  wrapper = mount(StudyScreen, { attachTo: document.body })
})
afterEach(() => {
  wrapper.unmount()
  vi.restoreAllMocks()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})
const tab = (id: string) => wrapper.get(`#study-tab-${id}`)
const pick = (n: string, end = false) => wrapper.get(`select[aria-label="${end ? 'Through' : 'From'} verse"]`).setValue(n)

describe('focused Study tools', () => {
  it('keeps the first prose click of a word double-click independent of verse selection', async () => {
    await flushPromises()
    const prose = wrapper.get('[data-selection-text]')
    await prose.trigger('click', { detail: 1 })
    expect(useReader().selectedVerses).toEqual([])
    const range = document.createRange()
    range.selectNodeContents(prose.element)
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await prose.trigger('click', { detail: 2 })
    await prose.trigger('dblclick', { detail: 2 })
    await flushPromises()
    expect(document.querySelector('[aria-label="Selected text actions"]')).not.toBeNull()
    expect(useReader().selectedVerses).toEqual([])
  })

  it('defaults to Compare without mounting unavailable tools, chat, or an open notes card', async () => {
    await flushPromises()
    expect(tab('compare').attributes('aria-selected')).toBe('true')
    expect(wrapper.findAll('[role="tabpanel"]').filter((panel) => panel.isVisible())).toHaveLength(1)
    expect(wrapper.findAll('[data-verse]')).toHaveLength(1)
    expect(wrapper.get('[data-verse]').attributes('data-verse')).toBe('1')
    expect(api.commentary).not.toHaveBeenCalled()
    expect(api.connections).not.toHaveBeenCalled()
    expect(wrapper.find('.commentary-card, .connections-card, .strongs-box, [aria-controls="study-partner"]').exists()).toBe(false)
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
  })

  it('hides translation cards whose selected verses are missing or blank', async () => {
    vi.mocked(api.compare).mockResolvedValueOnce({
      bookName: 'John',
      translations: [null, '   '].map((text, index) => ({
        module: `Missing${index}`, hasStrongs: false, license: '', verses: [{ n: 1, text }]
      }))
    })
    wrapper.unmount()
    wrapper = mount(StudyScreen, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.cp-list, .cp-row').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Missing0')
    expect(wrapper.text()).not.toContain('Missing1')
  })

  it('removes unrelated commentary when the selected verse has no note, including whitespace-only entries', async () => {
    await tab('commentary').trigger('click')
    await flushPromises()
    expect(wrapper.get('.commentary-card').text()).toContain('Only the first verse')
    await pick('2')
    expect(wrapper.find('.commentary-card').exists()).toBe(false)
    expect(wrapper.get('#study-panel-commentary').text()).toContain('No notes in Geneva for John 1:2.')
    expect(wrapper.text()).not.toContain('Only the first verse')
    await pick('3')
    expect(wrapper.find('.commentary-card').exists()).toBe(false)
    expect(wrapper.get('#study-panel-commentary').text()).toContain('John 1:3.')
    expect(api.commentary).toHaveBeenCalledTimes(1)
  })

  it('renders only notes inside the inclusive range and handles a reversed end or repeated selection', async () => {
    vi.mocked(api.commentary).mockResolvedValue({
      module: 'Geneva', book: 'John', bookName: 'John', chapter: 1, locked: false,
      entries: [1, 2, 3].map((n) => ({ n, text: `Comment ${n}`, notes: [], segments: [] }))
    })
    await pick('2')
    await pick('3', true)
    await tab('commentary').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.cc-entry').map((entry) => entry.text())).toEqual(['2Comment 2', '3Comment 3'])
    expect(wrapper.text()).not.toContain('Comment 1')
    await pick('1', true)
    expect(useReader().selectedVerses).toEqual([1, 2])
    expect(wrapper.findAll('.cc-entry').map((entry) => entry.text())).toEqual(['1Comment 1', '2Comment 2'])
    await pick('1')
    await pick('1')
    expect(useReader().selectedVerses).toEqual([1])
  })

  it('rejects invalid, fractional, and out-of-chapter picker values without changing the passage', async () => {
    const select = wrapper.get('select[aria-label="From verse"]')
    for (const invalid of ['0', '-1', '1.5', '999', 'NaN', '']) {
      const option = document.createElement('option')
      option.value = invalid
      select.element.append(option)
      await select.setValue(invalid)
      expect(wrapper.get('h1').text()).toBe('John 1:1')
      expect(useReader().selectedVerse).toBeNull()
      option.remove()
    }
  })

  it('uses tab arrow keys, wraparound, Home and End without stepping the passage', async () => {
    const user = userEvent.setup()
    ;(tab('compare').element as HTMLElement).focus()
    await user.keyboard('{ArrowLeft}')
    expect(tab('word-study').attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('word-study').element)
    expect(wrapper.find('.strongs-box').exists()).toBe(false)
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(tab('commentary').attributes('aria-selected')).toBe('true')
    await user.keyboard('{End}')
    expect(tab('word-study').attributes('aria-selected')).toBe('true')
    await user.keyboard('{Home}')
    expect(tab('compare').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('h1').text()).toBe('John 1:1')
    ;(wrapper.get('select').element as HTMLElement).focus()
    await user.keyboard('{ArrowRight}')
    expect(wrapper.get('h1').text()).toBe('John 1:1')
  })

  it('shows recoverable commentary errors without an empty card or old chapter notes', async () => {
    await tab('commentary').trigger('click')
    await flushPromises()
    vi.mocked(api.commentary).mockRejectedValueOnce(new Error('Commentary unavailable'))
    useReader().chapter = 2
    await flushPromises()
    expect(wrapper.find('.commentary-card').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Only the first verse')
    expect(wrapper.get('.cc-error').text()).toContain('Commentary unavailable')
    await wrapper.get('.cc-retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('.cc-error').exists()).toBe(false)
    expect(wrapper.find('.commentary-card').exists()).toBe(true)
  })


  it('discards an old chapter failure after a newer chapter succeeds', async () => {
    let rejectOld!: (cause: Error) => void
    vi.mocked(api.commentary).mockReturnValueOnce(new Promise((_, reject) => { rejectOld = reject }))
    await tab('commentary').trigger('click')
    useReader().chapter = 2
    await flushPromises()
    expect(wrapper.get('.commentary-card').text()).toContain('Only the first verse')
    rejectOld(new Error('obsolete chapter failure'))
    await flushPromises()
    expect(wrapper.find('.cc-error').exists()).toBe(false)
    expect(wrapper.get('.commentary-card').text()).toContain('Only the first verse')
  })

  it('invalidates a pending commentary request when its module is uninstalled', async () => {
    const previous = await api.commentary('Geneva', 'John', 1)
    let resolveOld!: (payload: typeof previous) => void
    vi.mocked(api.commentary).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
    await tab('commentary').trigger('click')
    useLibrary().modules = []
    await flushPromises()
    resolveOld(previous)
    await flushPromises()
    expect(wrapper.text()).toContain('Install a commentary')
    expect(wrapper.text()).not.toContain('Only the first verse')
    expect(wrapper.find('.commentary-card').exists()).toBe(false)
  })

  it('shows missing and locked commentary as compact notices', async () => {
    vi.mocked(api.commentary).mockResolvedValue({
      module: 'Geneva', book: 'John', bookName: 'John', chapter: 1, locked: true, entries: []
    })
    await tab('commentary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Geneva is locked')
    expect(wrapper.find('.commentary-card').exists()).toBe(false)
    useLibrary().modules = useLibrary().modules.filter((module) => module.kind !== 'commentary')
    await flushPromises()
    expect(wrapper.text()).toContain('Install a commentary')
    expect(wrapper.text()).not.toContain('Geneva is locked')
    expect(wrapper.find('.commentary-card').exists()).toBe(false)
  })

  it('scopes Connections to the focused passage even with no selection and hides empty groups', async () => {
    await tab('connections').trigger('click')
    await flushPromises()
    expect(api.connections).toHaveBeenLastCalledWith([{
      module: 'KJV', book: 'John', chapter: 1, verseStart: 1, verseEnd: 1
    }])
    expect(wrapper.text()).toContain('No connections found')
    expect(wrapper.find('.connections-card, [aria-label="Close connections"]').exists()).toBe(false)
    expect(wrapper.findAll('.connections-panel h3')).toHaveLength(0)
    await pick('2', true)
    await flushPromises()
    expect(api.connections).toHaveBeenLastCalledWith([{
      module: 'KJV', book: 'John', chapter: 1, verseStart: 1, verseEnd: 2
    }])
  })

  it('opens Connections from passage actions without embedded references and reveals notes only on request', async () => {
    await wrapper.get('.cverse').trigger('contextmenu', { clientX: 20, clientY: 20 })
    await flushPromises()
    const connections = document.querySelector<HTMLButtonElement>('[aria-label="Connections"]')!
    expect(connections.disabled).toBe(false)
    connections.click()
    await flushPromises()
    expect(tab('connections').attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('connections').element)
    await wrapper.get('.cverse').trigger('contextmenu', { clientX: 20, clientY: 20 })
    await flushPromises()
    const note = [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')]
      .find((button) => button.textContent?.trim() === 'Note')!
    note.click()
    await flushPromises()
    expect(wrapper.get('details').attributes('open')).toBeDefined()
    expect(document.activeElement).toBe(wrapper.get('textarea').element)
  })

  it('keeps Connections failures actionable without an empty card', async () => {
    vi.mocked(api.connections).mockRejectedValueOnce(new Error('offline'))
    await tab('connections').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load connections')
    expect(wrapper.find('.connections-card').exists()).toBe(false)
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No connections found')
  })
})
