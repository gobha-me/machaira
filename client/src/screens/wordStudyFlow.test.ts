// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ReadScreen from './ReadScreen.vue'
import StudyScreen from './StudyScreen.vue'
import { useReader } from '../stores/reader'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { api, ApiError, type StrongsPayload } from '../services/api'
import { pathologicalModule } from '../test/fixtures/moduleInfo'
import { parseVerseMarkup } from '../../../server/src/text'

let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(api, 'compare').mockResolvedValue({ bookName: 'John', translations: [] })
  vi.spyOn(api, 'connections').mockResolvedValue({ nodes: [], edges: [], warnings: [], semanticState: 'empty' })
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 300, 80, 22))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 600, 900))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  localStorage.clear()
})

function setup(screen: typeof ReadScreen | typeof StudyScreen, module: string, tagged = true) {
  // Deliberately contradict catalog metadata: returned Scripture segments own capability.
  useLibrary().modules = [{ ...pathologicalModule, name: module, hasStrongs: !tagged, installed: true }]
  const reader = useReader()
  reader.ready = true
  reader.moduleName = module
  reader.book = 'John'
  reader.chapter = 1
  reader.books = [{ code: 'John', name: 'John', chapters: 21, section: 'nt' }]
  // node-sword-interface renders KJV's OSIS lemma as class, retaining its Strong's tokens.
  const parsed = parseVerseMarkup(tagged ? 'In the beginning was the <w class="strong:G3056">Word</w>.' : 'In the beginning was that Word.')
  reader.data = { module, book: 'John', bookName: 'John', chapter: 1, verses: [{ n: 1, ...parsed }] }
  useSettings().showStrongs = true
  wrapper = mount(screen, { attachTo: document.body })
  return reader
}
function surface() { return document.querySelector<HTMLElement>('.text-selection-actions')! }
function action(label: string) {
  return [...surface().querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!
}
async function selectWord() {
  const range = document.createRange()
  range.selectNodeContents(wrapper!.get('[data-selection-text] [data-strongs]').element)
  window.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await flushPromises()
  action('Word study').click()
  await flushPromises()
}

for (const screen of [ReadScreen, StudyScreen]) {
  describe(`${screen.__name} anchored word study`, () => {
    it.each(['KJV', 'KJVA'])('keeps %s results, focus, selection and scroll in place despite contrary catalog metadata', async (module) => {
      let resolve!: (entry: StrongsPayload) => void
      const lookup = vi.spyOn(api, 'strongs').mockReturnValue(new Promise((done) => { resolve = done }))
      const reader = setup(screen, module)
      await flushPromises()
      reader.selectedVerse = 1
      await flushPromises()
      const toolsState = wrapper!.find('.rail-side.open').exists()
      const scroll = wrapper!.get(screen === ReadScreen ? '.body' : '.scroll').element
      scroll.scrollTop = 240
      const focused = document.activeElement
      const focus = vi.spyOn(HTMLElement.prototype, 'focus')
      const scrollTo = vi.spyOn(window, 'scrollTo')
      await selectWord()
      expect(surface().textContent).toContain('Looking up')
      expect(surface().textContent).not.toContain('No Strong’s tags')
      const before = surface()
      resolve({ key: 'G3056', transcription: 'λόγος', phonetic: '', definition: 'word', references: [] })
      await flushPromises()
      expect(surface()).toBe(before)
      expect(surface().querySelector('.strongs-card')!.textContent).toContain('λόγος')
      expect(lookup).toHaveBeenCalledExactlyOnceWith('G3056')
      expect(reader.selectedVerses).toEqual([1])
      expect(window.getSelection()!.toString()).toBe('Word')
      expect(scroll.scrollTop).toBe(240)
      expect(document.activeElement).toBe(focused)
      expect(focus).not.toHaveBeenCalled()
      expect(scrollTo).not.toHaveBeenCalled()
      expect(wrapper!.find('.rail-side.open').exists()).toBe(toolsState)
      if (screen === StudyScreen) expect(wrapper!.get('#study-tab-compare').attributes('aria-selected')).toBe('true')
    })

    it.each([
      [409, 'Install Strong’s Greek in the Library to enable word study.'],
      [404, 'No entry for G3056.'],
      [503, 'Word lookup failed for G3056. Try again.']
    ] as const)('keeps HTTP %s failures in the popover and allows retry', async (status, message) => {
      const lookup = vi.spyOn(api, 'strongs').mockRejectedValueOnce(new ApiError(status, { message }))
        .mockResolvedValueOnce({ key: 'G3056', transcription: 'λόγος', phonetic: '', definition: 'word', references: [] })
      setup(screen, 'KJV')
      await flushPromises()
      await selectWord()
      expect(surface().querySelector('[role="alert"]')!.textContent).toBe(message)
      expect(surface().querySelector('.strongs-card')).toBeNull()
      action('Word study').click()
      await flushPromises()
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(surface().querySelector('[role="alert"]')).toBeNull()
      expect(surface().querySelector('.strongs-card')).not.toBeNull()
    })

    it.each(['KJV', 'enggnv1599eb'])('reports missing selection tags in %s without trusting a translation name or catalog flag', async (module) => {
      const lookup = vi.spyOn(api, 'strongs')
      setup(screen, module, false)
      await flushPromises()
      const range = document.createRange()
      range.selectNodeContents(wrapper!.get('[data-selection-text]').element)
      window.getSelection()!.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      await flushPromises()
      action('Word study').click()
      await flushPromises()
      expect(surface().textContent).toContain(`No Strong’s tags for this selection in ${module}`)
      expect(surface().textContent).not.toContain('isn’t Strong’s-tagged')
      expect(lookup).not.toHaveBeenCalled()
    })

    it('keeps a direct keyboard lookup open through keyup and preserves the focused word', async () => {
      vi.spyOn(api, 'strongs').mockRejectedValue(new ApiError(409, { message: 'Install Strong’s Greek in the Library.' }))
      setup(screen, 'KJV')
      await flushPromises()
      const word = wrapper!.get('button.wtap')
      ;(word.element as HTMLElement).focus()
      await word.trigger('click', { detail: 0 })
      await word.trigger('keyup', { key: 'Enter' })
      document.dispatchEvent(new Event('selectionchange'))
      await flushPromises()
      expect(surface().querySelector('[role="alert"]')!.textContent).toContain('Install Strong’s Greek')
      expect(document.activeElement).toBe(word.element)
      expect(window.getSelection()!.isCollapsed).toBe(true)
      if (screen === StudyScreen) expect(wrapper!.get('#study-tab-compare').attributes('aria-selected')).toBe('true')
    })

    it.each(['close', 'outside', 'scroll', 'module', 'unmount'])('discards a late failure after %s', async (operation) => {
      let reject!: (error: Error) => void
      vi.spyOn(api, 'strongs').mockReturnValue(new Promise((_, fail) => { reject = fail }))
      const reader = setup(screen, 'KJV')
      await flushPromises()
      await selectWord()
      expect(surface().textContent).toContain('Looking up')
      if (operation === 'close') action('Close').click()
      else if (operation === 'outside') document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      else if (operation === 'scroll') wrapper!.get(screen === ReadScreen ? '.body' : '.scroll').element.dispatchEvent(new Event('scroll'))
      else if (operation === 'module') reader.moduleName = 'Geneva'
      else { wrapper!.unmount(); wrapper = undefined }
      reject(new Error('late failure'))
      await flushPromises()
      expect(document.querySelector('.text-selection-actions')).toBeNull()
      expect(document.body.textContent).not.toContain('Word lookup failed')
    })
  })
}
