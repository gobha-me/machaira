// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import userEvent from '@testing-library/user-event'
import ReadScreen from './ReadScreen.vue'
import { parseVerseMarkup } from '../../../server/src/text'
import { useLibrary } from '../stores/library'
import { useReader } from '../stores/reader'
import { useSettings } from '../stores/settings'
import { useTtsProvider } from '../stores/ttsProvider'
import { api, ApiError } from '../services/api'
import { pathologicalModule } from '../test/fixtures/moduleInfo'

let wrapper: VueWrapper
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'connections').mockResolvedValue({
    nodes: [], edges: [], semanticState: 'empty', warnings: []
  })
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

  it('opens connections on verse selection and exposes its menu action even without embedded references', async () => {
    const user = userEvent.setup()
    const number = wrapper.get('button.vnum').element as HTMLElement
    number.focus()
    await user.keyboard('{Enter}')
    await flushPromises()
    expect(wrapper.get('.rail-side').classes()).toContain('open')
    expect(wrapper.get('.connections-card').text()).toContain('Connections')
    expect(document.activeElement).toBe(number)
    expect(api.connections).toHaveBeenCalledWith([{
      module: 'KJV', book: 'John', chapter: 1, verseStart: 1, verseEnd: 1
    }])
    await user.keyboard('{Shift>}{F10}{/Shift}')
    await user.tab()
    await user.tab()
    await user.tab()
    expect(document.activeElement?.textContent?.trim()).toBe('Connections')
    expect((document.activeElement as HTMLButtonElement).disabled).toBe(false)
    await user.keyboard('{Enter}')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('.connections-card h2').element)
    await user.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close connections')
    await user.keyboard(' ')
    await flushPromises()
    expect(wrapper.find('.connections-card').exists()).toBe(false)
    expect(document.activeElement).toBe(number)
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
    expect(document.activeElement?.textContent?.trim()).toBe('Word study')
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

describe('read-aloud listening bar', () => {
  class ListeningAudio {
    src = ''
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    play = vi.fn(async () => undefined)
    pause = vi.fn()
    removeAttribute = vi.fn()
    load = vi.fn()
  }

  async function configureLocalAudio() {
    vi.stubGlobal('Audio', ListeningAudio)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:read-aloud-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    useTtsProvider().config = {
      order: ['local'],
      local: {
        provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8880/v1',
        model: 'kokoro', voice: 'af_heart', hasApiKey: false
      },
      cloud: null,
      remoteAudioCacheSize: 4
    }
    await flushPromises()
  }

  it('shows chapter counts and a spinner before audio, then timeout and Retry, then pause after playback starts', async () => {
    vi.useFakeTimers()
    const speech = vi.spyOn(api, 'ttsSpeech').mockImplementation(() => new Promise<Blob>(() => {}))
    await configureLocalAudio()
    await wrapper.get('button.listen').trigger('click')
    expect(wrapper.get('.listen-sub').text()).toBe('Preparing local audio — 0 of 2 verses ready')
    const control = wrapper.get('button.play')
    expect(control.attributes('aria-label')).toBe('Preparing audio')
    expect(control.attributes('aria-busy')).toBe('true')
    expect(control.attributes('disabled')).toBeDefined()
    expect(control.find('.listen-spinner').exists()).toBe(true)
    expect(control.text()).not.toContain('❚❚')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0')

    await vi.advanceTimersByTimeAsync(90_000)
    expect(wrapper.get('.listen-sub.error').text()).toContain('verse 1: audio request timed out after 90 seconds')
    expect(control.attributes('aria-label')).toBe('Retry')
    expect(control.text()).toBe('Retry')
    expect(control.attributes('disabled')).toBeUndefined()
    speech.mockResolvedValue(new Blob(['audio'], { type: 'audio/mpeg' }))
    await control.trigger('click')
    await flushPromises()
    expect(control.attributes('aria-label')).toBe('Pause read-aloud')
    expect(control.text()).toBe('❚❚')
    expect(wrapper.find('.listen-sub.error').exists()).toBe(false)
    await wrapper.get('[aria-label="Close read-aloud"]').trigger('click')
    expect(wrapper.find('.listenbar').exists()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [new ApiError(503, {}), 'HTTP 503'],
    [new ApiError(502, {}), 'HTTP 502'],
    [new TypeError('private network details'), 'network request failed']
  ])('renders a request failure with Retry: %s', async (failure, expected) => {
    vi.spyOn(api, 'ttsSpeech').mockRejectedValue(failure)
    await configureLocalAudio()
    useReader().selectVerse(2)
    await wrapper.get('button.listen').trigger('click')
    await flushPromises()
    expect(wrapper.get('.listen-sub.error').text()).toContain(expected)
    expect(wrapper.get('.listen-sub.error').text()).toContain('verse 2')
    expect(wrapper.get('button.play').text()).toBe('Retry')
    expect(wrapper.get('button.play').attributes('aria-label')).toBe('Retry')
    expect(wrapper.get('button.play').attributes('disabled')).toBeUndefined()
  })
})

describe('reader verse spacing', () => {
  it.each([
    [true, true], [true, false], [false, true], [false, false]
  ])('preserves quotes and brackets with Strong’s=%s and footnotes=%s', async (strongs, footnotes) => {
    const parsed = parseVerseMarkup(
      'And God says, “<q>[<transChange type="added">' +
      '<div class="sword-markup sword-note">Added word.</div>' +
      '<w lemma="strong:H216">Let light be</w></transChange>]</q>”.'
    )
    useReader().data!.verses = [{ n: 1, ...parsed }]
    useSettings().showStrongs = strongs
    useSettings().showFootnotes = footnotes
    await flushPromises()
    const verse = wrapper.get('.verse').element.cloneNode(true) as HTMLElement
    verse.querySelectorAll('.vnum, .noteref').forEach((element) => element.remove())
    expect(verse.textContent?.trim()).toBe('And God says, “[Let light be]”.')
    expect(wrapper.findAll('button.wtap')).toHaveLength(strongs ? 1 : 0)
    expect(wrapper.findAll('.noteref')).toHaveLength(footnotes ? 1 : 0)
  })
})
