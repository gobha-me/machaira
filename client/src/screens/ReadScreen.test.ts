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
import { useUi } from '../stores/ui'
import { useNotes } from '../stores/notes'
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
  useNotes().resetPersonalData()
  localStorage.clear()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function firstText(element: Node): Node {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) if (node.textContent) return node
  throw new Error('Expected Scripture text')
}
async function selectText(start: Node, from: number, end = start, to = start.textContent!.length, event = 'selectionchange') {
  const range = document.createRange()
  range.setStart(start, from)
  range.setEnd(end, to)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event(event))
  await flushPromises()
}
function textActions() {
  return document.querySelector<HTMLElement>('[aria-label="Selected text actions"]')
}
function textAction(label: string) {
  return [...textActions()!.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!
}

describe('translation picker labels', () => {
  it('shows a friendly label with missing metadata and still selects the original module ID', async () => {
    const module = { ...pathologicalModule, name: 'enggnv1599eb', description: '', abbreviation: '', installed: true }
    useLibrary().modules = [module]
    useReader().moduleName = module.name
    await flushPromises()
    const control = wrapper.get('[aria-controls="reader-translation-picker"]')
    expect(control.text()).toContain('Geneva 1599')
    expect(control.attributes('title')).toContain(module.name)
    await control.trigger('click')
    const pick = vi.spyOn(useReader(), 'setModule').mockResolvedValue()
    const option = wrapper.get('#reader-translation-picker .trans-item')
    expect(option.text()).toBe('Geneva 1599')
    await option.trigger('click')
    expect(pick).toHaveBeenCalledExactlyOnceWith(module.name)
  })
})

describe('word and phrase selection actions', () => {
  it('cancels a pending tagged-word lookup for double-click selection, Escape, and navigation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const lookup = vi.spyOn(api, 'strongs').mockRejectedValue(new Error('unavailable'))
    const word = wrapper.get('button.wtap')
    await word.trigger('click', { detail: 1 })
    expect(wrapper.get('.rail-side').classes()).not.toContain('open')
    await selectText(word.element.firstChild!, 0)
    await word.trigger('click', { detail: 2 })
    await vi.advanceTimersByTimeAsync(600)
    expect(lookup).not.toHaveBeenCalled()
    expect(textActions()).not.toBeNull()
    expect(useReader().selectedVerses).toEqual([])
    window.getSelection()!.removeAllRanges()
    await word.trigger('click', { detail: 1 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.advanceTimersByTimeAsync(600)
    expect(lookup).not.toHaveBeenCalled()
    await word.trigger('click', { detail: 1 })
    useReader().chapter = 2
    await vi.advanceTimersByTimeAsync(600)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('retains single-click tagged-word lookup after the double-click interval, including failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const lookup = vi.spyOn(api, 'strongs').mockRejectedValue(new Error('unavailable'))
    await wrapper.get('button.wtap').trigger('click', { detail: 1 })
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()
    expect(lookup).toHaveBeenCalledExactlyOnceWith('G3056')
    expect(useReader().selectedVerses).toEqual([])
    expect(textActions()!.querySelector('[role="alert"]')!.textContent).toContain('Word lookup failed for G3056')
  })

  it.each([false, true])('double-clicks prose without changing an existing verse selection (Strong’s display: %s)', async (showStrongs) => {
    useSettings().showStrongs = showStrongs
    useReader().selectVerse(2)
    await flushPromises()
    const prose = wrapper.get('[data-selection-text]')
    // The first click precedes native word selection. Testing only detail=2 misses the bug.
    await prose.trigger('click', { detail: 1 })
    expect(useReader().selectedVerses).toEqual([2])
    const word = firstText(prose.element)
    await selectText(word, 7, word, 16)
    await prose.trigger('click', { detail: 2 })
    await prose.trigger('dblclick', { detail: 2 })
    expect(useReader().selectedVerses).toEqual([2])
    expect(textActions()).not.toBeNull()
    expect(window.getSelection()!.toString()).toBe('beginning')
  })

  it('selects and extends through the gutter while leaving plain and Shift prose clicks quiet', async () => {
    const reader = useReader()
    const prose = wrapper.findAll('[data-selection-text]')
    await prose[0].trigger('click', { detail: 1 })
    expect(reader.selectedVerses).toEqual([])
    await wrapper.findAll('.verse')[0].trigger('click', { detail: 1 })
    expect(reader.selectedVerses).toEqual([1])
    expect(wrapper.findAll('.verse')[1].attributes('style')).toContain('opacity: 0.7')
    const shiftDown = new MouseEvent('mousedown', { shiftKey: true, bubbles: true, cancelable: true })
    prose[1].element.dispatchEvent(shiftDown)
    expect(shiftDown.defaultPrevented).toBe(false)
    await prose[1].trigger('click', { shiftKey: true, detail: 1 })
    expect(reader.selectedVerses).toEqual([1])
    await wrapper.findAll('.verse')[1].trigger('click', { shiftKey: true, detail: 1 })
    expect(reader.selectedVerses).toEqual([1, 2])
    expect(wrapper.findAll('.verse').every((verse) => verse.attributes('style')?.includes('opacity: 1'))).toBe(true)
  })

  it('searches partial text across verses without changing the verse selection or blocking native copy', async () => {
    const related = vi.spyOn(useUi(), 'findRelated').mockImplementation(() => {})
    const verses = wrapper.findAll('[data-selection-text]')
    const first = firstText(verses[0].element)
    const second = firstText(verses[1].element)
    await selectText(first, 7, second, 8)
    expect(textActions()!.textContent).toContain('Find related')
    await wrapper.findAll('.verse')[1].trigger('click')
    expect(useReader().selectedVerses).toEqual([])
    const nativeMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    verses[0].element.dispatchEvent(nativeMenu)
    expect(nativeMenu.defaultPrevented).toBe(false)
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    document.dispatchEvent(copy)
    expect(copy.defaultPrevented).toBe(false)
    expect(window.getSelection()!.isCollapsed).toBe(false)
    textAction('Find related').click()
    expect(related).toHaveBeenCalledExactlyOnceWith('beginning was the Word, and the Word was with God, and the Word was God. The same')
  })

  it('resolves selected Strong’s tags even when word display is off, and shows lookup failures', async () => {
    useSettings().showStrongs = false
    await flushPromises()
    const lookup = vi.spyOn(api, 'strongs').mockRejectedValue(new Error('unavailable'))
    const word = wrapper.get('[data-strongs="G3056"]').element
    await selectText(word.firstChild!, 0)
    textAction('Word study').click()
    await flushPromises()
    expect(lookup).toHaveBeenCalledExactlyOnceWith('G3056')
    expect(textActions()!.querySelector('[role="alert"]')!.textContent).toContain('Word lookup failed for G3056')
  })

  it('offers a choice for multiple tagged words and explains a selection without tags', async () => {
    const verses = wrapper.findAll('[data-selection-text]')
    await selectText(firstText(verses[0].element), 0, wrapper.get('[data-strongs="G2316"]').element.firstChild!, 3)
    textAction('Word study').click()
    await flushPromises()
    expect(textActions()!.textContent).toContain('G3056')
    expect(textActions()!.textContent).toContain('G2316')
    const lookup = vi.spyOn(api, 'strongs').mockRejectedValue(new Error('missing'))
    ;[...textActions()!.querySelectorAll('button')].find((button) => button.textContent?.includes('G2316'))!.click()
    await flushPromises()
    expect(lookup).toHaveBeenCalledExactlyOnceWith('G2316')
    const first = firstText(verses[0].element)
    await selectText(first, 0, first, 6)
    textAction('Word study').click()
    await flushPromises()
    expect(textActions()!.querySelector('[role="status"]')!.textContent).toContain('No Strong’s tags')
    expect(lookup).toHaveBeenCalledOnce()
  })

  it('ignores empty/whitespace selections and dismisses on Escape without immediately reopening', async () => {
    const first = firstText(wrapper.get('[data-selection-text]').element)
    await selectText(first, 2, first, 3)
    expect(textActions()).toBeNull()
    await selectText(first, 0, first, 0)
    expect(textActions()).toBeNull()
    await selectText(first, 0, first, 6)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }))
    document.dispatchEvent(new Event('selectionchange'))
    await flushPromises()
    expect(textActions()).toBeNull()
    expect(window.getSelection()!.toString()).toBe('In the')
  })

  it('invalidates an open selection on navigation, including reused DOM and late selection events', async () => {
    const first = firstText(wrapper.get('[data-selection-text]').element)
    await selectText(first, 0, first, 6)
    const staleAction = textAction('Note')
    useReader().chapter = 2
    await flushPromises()
    document.dispatchEvent(new Event('selectionchange'))
    await flushPromises()
    expect(textActions()).toBeNull()
    staleAction.click()
    expect(wrapper.find('[aria-label="Note body"]').exists()).toBe(false)
  })

  it('pins a range note and its quoted text to the original reference after navigation', async () => {
    const create = vi.spyOn(api, 'createNote').mockResolvedValue({
      id: 'range-note', title: 'John 1:1–2 · KJV', body: 'note', refs: ['John 1:1–2 · KJV'], tags: [], createdAt: 1, updatedAt: 1
    })
    const verses = wrapper.findAll('[data-selection-text]')
    await selectText(firstText(verses[0].element), 7, firstText(verses[1].element), 8)
    textAction('Note').click()
    await flushPromises()
    expect(wrapper.get('.note-anchor').text()).toBe('John 1:1–2 · KJV')
    expect((wrapper.get('[aria-label="Note body"]').element as HTMLTextAreaElement).value).toContain('> beginning was the Word')
    useReader().chapter = 2
    await flushPromises()
    await wrapper.get('button.note-save').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ refs: ['John 1:1–2 · KJV'] }))
  })

  it('keeps the range snapshot when keyboard focus collapses native selection on an action', async () => {
    const user = userEvent.setup()
    const first = firstText(wrapper.get('[data-selection-text]').element)
    await selectText(first, 7, first, 16)
    textAction('Note').focus()
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await flushPromises()
    expect(textActions()).not.toBeNull()
    await user.keyboard('{Enter}')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[aria-label="Note body"]').element)
    expect(wrapper.get('[aria-label="Note body"]').element).toHaveProperty('value', '> beginning\n\n')
    expect(wrapper.get('.note-anchor').text()).toBe('John 1:1 · KJV')
  })

  it('lets native touch long-press select text without opening the passage menu or suppressing its context menu', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const prose = wrapper.get('[data-selection-text]')
    await prose.trigger('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 60 })
    await vi.advanceTimersByTimeAsync(600)
    const nativeMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    prose.element.dispatchEvent(nativeMenu)
    expect(nativeMenu.defaultPrevented).toBe(false)
    expect(document.querySelector('.passage-actions')).toBeNull()
    const first = firstText(prose.element)
    await selectText(first, 0, first, 6)
    await prose.trigger('pointerup', { pointerType: 'touch', pointerId: 1 })
    expect(textActions()).not.toBeNull()
    expect(useReader().selectedVerses).toEqual([])
    wrapper.unmount()
    expect(textActions()).toBeNull()
  })
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

  it('returns focus to the selected verse when Escape closes the connections rail', async () => {
    const user = userEvent.setup()
    const number = wrapper.get('button.vnum').element as HTMLElement
    number.focus()
    await user.keyboard('{Enter}')
    await flushPromises()
    ;(wrapper.get('.connections-card h2').element as HTMLElement).focus()
    await user.keyboard('{Escape}')
    await flushPromises()
    expect(wrapper.get('.rail-side').classes()).not.toContain('open')
    expect(wrapper.find('.connections-card').exists()).toBe(false)
    expect(useReader().selectedVerses).toEqual([1])
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
    expect(textActions()!.querySelector('[role="alert"]')!.textContent).toContain('Word lookup failed for G3056.')
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

describe('inline verse notes', () => {
  const rangeNote = {
    id: 'range-note', title: 'The Word', body: 'Original', refs: ['John 1:1–2 · KJV'],
    tags: ['study'], createdAt: 1, updatedAt: 1
  }
  function button(label: string) {
    return wrapper.findAll('button').find((entry) => entry.text() === label)!
  }
  async function beginNote() {
    await wrapper.get('button.vnum').trigger('keydown', { key: 'F10', shiftKey: true })
    await flushPromises()
    const action = [...document.querySelectorAll<HTMLButtonElement>('.passage-actions button')]
      .find((entry) => entry.textContent?.trim() === 'Note')!
    action.click()
    await flushPromises()
  }

  it('focuses before the Note click returns and keeps input delivered before Vue renders', async () => {
    const first = firstText(wrapper.get('[data-selection-text]').element)
    await selectText(first, 7, first, 16)
    textAction('Note').click()
    // Deliberately do not yield: nextTick focus loses this first input.
    const editor = document.activeElement as HTMLTextAreaElement
    expect(editor.getAttribute('aria-label')).toBe('Note body')
    expect(editor.value).toBe('> beginning\n\n')
    expect(editor.selectionStart).toBe(editor.value.length)
    editor.setRangeText('First keystrokes', editor.selectionStart, editor.selectionEnd, 'end')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange'))
    await flushPromises()
    expect(document.activeElement).toBe(editor)
    expect(wrapper.get('[aria-label="Note body"]').element).toHaveProperty('value', '> beginning\n\nFirst keystrokes')
    expect(textActions()).toBeNull()
    expect(window.getSelection()!.isCollapsed).toBe(true)
  })

  it('focuses synchronously from passage actions and preserves a draft when another anchor is rejected', async () => {
    await wrapper.get('button.vnum').trigger('keydown', { key: 'F10', shiftKey: true })
    const action = () => [...document.querySelectorAll<HTMLButtonElement>('.passage-actions button')]
      .find((entry) => entry.textContent?.trim() === 'Note')!
    action().click()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Note body')
    await wrapper.get('[aria-label="Note body"]').setValue('Keep my draft')
    await wrapper.findAll('button.vnum')[1]!.trigger('keydown', { key: 'F10', shiftKey: true })
    action().click()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Note body')
    await flushPromises()
    expect(wrapper.get('[aria-label="Note body"]').element).toHaveProperty('value', 'Keep my draft')
    expect(wrapper.get('.note-anchor').text()).toBe('John 1:1 · KJV')
    expect(wrapper.get('[role="alert"]').text()).toContain('Save the current note')
    expect(wrapper.findAll('.note-composer')).toHaveLength(1)
  })

  it('reuses the editor when a blank draft moves backwards and removes its host on unmount', async () => {
    await wrapper.findAll('button.vnum')[1]!.trigger('keydown', { key: 'F10', shiftKey: true })
    const action = [...document.querySelectorAll<HTMLButtonElement>('.passage-actions button')]
      .find((entry) => entry.textContent?.trim() === 'Note')!
    action.click()
    const editor = document.activeElement
    await flushPromises()
    await beginNote()
    expect(document.activeElement).toBe(editor)
    expect(wrapper.get('.note-anchor').text()).toBe('John 1:1 · KJV')
    expect(wrapper.get('.note-composer').element.parentElement?.previousElementSibling?.getAttribute('data-verse')).toBe('1')
    const host = editor?.parentElement?.parentElement
    wrapper.unmount()
    expect(host?.isConnected).toBe(false)
    expect(host?.querySelector('textarea')).toBeNull()
    // Keep the shared cleanup and stores exercised after a normal remount too.
    wrapper = mount(ReadScreen, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.note-composer').exists()).toBe(false)
  })

  it('preserves a newer unrelated selection while a delete is pending and after it succeeds', async () => {
    let finishDelete!: () => void
    vi.spyOn(api, 'deleteNote').mockImplementation(() => new Promise<void>((resolve) => { finishDelete = resolve }))
    const reader = useReader()
    useNotes().list = [{ ...rangeNote, refs: ['John 1:1 · KJV'] }]
    reader.selectVerse(1)
    await flushPromises()
    await wrapper.get('.verse-note-marker').trigger('click')
    await button('Delete note').trigger('click')
    expect(button('Delete note').attributes('disabled')).toBeDefined()
    expect(reader.selectedVerses).toEqual([1])
    reader.selectVerse(2)
    const prose = firstText(wrapper.findAll('[data-selection-text]')[1]!.element)
    await selectText(prose, 0, prose, 8)
    finishDelete()
    await flushPromises()
    expect(wrapper.find('.inline-note').exists()).toBe(false)
    expect(reader.selectedVerses).toEqual([2])
    expect(window.getSelection()!.toString()).toBe('The same')
    expect(textActions()).not.toBeNull()
  })

  it('keeps markers through a real translation switch and opens a range note once beneath its last verse', async () => {
    const notes = useNotes()
    notes.list = [rangeNote,
      { ...rangeNote, id: 'bad', refs: ['John 1:0', 'John 1:2–1', 'not a reference'] },
      { ...rangeNote, id: 'other', refs: ['John 2:1'] }
    ]
    await flushPromises()
    expect(wrapper.findAll('.verse-note-marker')).toHaveLength(2)
    expect(wrapper.find('.inline-note').exists()).toBe(false)
    vi.spyOn(api, 'books').mockResolvedValue(useReader().books)
    vi.spyOn(api, 'chapter').mockResolvedValue({ ...useReader().data!, module: 'WEB' })
    await useReader().setModule('WEB')
    await flushPromises()
    expect(wrapper.findAll('.verse-note-marker')).toHaveLength(2)
    const marker = wrapper.get('.verse-note-marker')
    ;(marker.element as HTMLElement).focus()
    await userEvent.setup().keyboard('{Enter}')
    await flushPromises()
    expect(wrapper.findAll('.inline-note')).toHaveLength(1)
    const entry = wrapper.get('.inline-note')
    expect(entry.element.previousElementSibling?.getAttribute('data-verse')).toBe('2')
    expect(useReader().selectedVerses).toEqual([])
    expect(document.activeElement?.textContent?.trim()).toBe('Edit note')
  })

  it('blocks whitespace, preserves a failed create and its verse anchor offline, then confirms its Journal destination', async () => {
    const create = vi.spyOn(api, 'createNote').mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ...rangeNote, refs: ['John 1:1 · KJV'], body: 'Keep this' })
    const go = vi.spyOn(useUi(), 'go').mockImplementation(() => {})
    await beginNote()
    expect(wrapper.find('.rail-side .note-composer').exists()).toBe(false)
    expect(wrapper.get('.note-composer').element.parentElement?.previousElementSibling?.getAttribute('data-verse')).toBe('1')
    await wrapper.get('[aria-label="Note body"]').setValue('  \n ')
    await wrapper.get('.note-composer').trigger('submit')
    expect(create).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="Note title"]').setValue('Draft')
    await wrapper.get('[aria-label="Note body"]').setValue('Keep this')
    await wrapper.get('.note-composer').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Failed to fetch')
    expect(wrapper.find('.inline-confirmation').exists()).toBe(false)
    useReader().selectedVerse = 2
    await flushPromises()
    expect(wrapper.get('.note-anchor').text()).toBe('John 1:1 · KJV')
    expect(wrapper.get('[aria-label="Note body"]').element).toHaveProperty('value', 'Keep this')
    await wrapper.get('.note-composer').trigger('submit')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Draft', body: 'Keep this', refs: ['John 1:1 · KJV'] }))
    expect(wrapper.get('.inline-confirmation').text()).toContain('Note filed under John 1:1 · KJV')
    await wrapper.get('.inline-confirmation a').trigger('click')
    expect(useNotes().currentId).toBe('range-note')
    expect(go).toHaveBeenCalledWith('journal')
    expect(wrapper.find('.note-composer').exists()).toBe(false)
  })


  it('retains offline inline edits across remount/account draft recovery and retries the right note', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const update = vi.spyOn(api, 'updateNote').mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ ...rangeNote, body: 'Offline edit' })
    const notes = useNotes()
    notes.activateUser('inline-reader')
    notes.list = [rangeNote, { ...rangeNote, id: 'other', refs: [] }]
    notes.select('other')
    await flushPromises()
    await wrapper.get('.verse-note-marker').trigger('click')
    await button('Edit note').trigger('click')
    await wrapper.get('[aria-label="Edit note body"]').setValue('Offline edit')
    // Editing inline must not move the Journal's current note or save it accidentally.
    expect(notes.currentId).toBe('other')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.get('.inline-note [role="alert"]').text()).toContain('offline')
    expect(notes.dirty['range-note']).toBe(true)
    wrapper.unmount()
    notes.activateUser('inline-reader')
    wrapper = mount(ReadScreen, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('.verse-note-marker').trigger('click')
    expect(wrapper.get('.inline-note').text()).toContain('Offline edit')
    await button('Retry').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith('range-note', expect.objectContaining({ body: 'Offline edit', tags: ['study'], refs: rangeNote.refs }), false)
    expect(notes.dirty).toEqual({})
    expect(wrapper.find('.inline-note [role="alert"]').exists()).toBe(false)
  })

  it('keeps a note on failed delete, preserves undo after failed restore, and restores beneath its range', async () => {
    const remove = vi.spyOn(api, 'deleteNote').mockRejectedValueOnce(new Error('Forbidden')).mockResolvedValueOnce()
    vi.spyOn(api, 'createNote').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...rangeNote, id: 'restored' })
    const notes = useNotes()
    notes.list = [rangeNote]
    const reader = useReader()
    reader.selectVerse(1)
    reader.extendSelection(2)
    reader.highlights = { 'KJV/John/1/1': '#ffcc00' }
    await flushPromises()
    await wrapper.get('.verse-note-marker').trigger('click')
    const prose = firstText(wrapper.get('[data-selection-text]').element)
    await selectText(prose, 0, prose, 6)
    await button('Delete note').trigger('click')
    await flushPromises()
    expect(wrapper.get('.inline-note [role="alert"]').text()).toContain('Forbidden')
    expect(wrapper.findAll('.verse-note-marker')).toHaveLength(2)
    expect(wrapper.find('.inline-undo').exists()).toBe(false)
    expect(reader.selectedVerses).toEqual([1, 2])
    expect(window.getSelection()!.isCollapsed).toBe(false)
    await button('Delete note').trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.verse-note-marker').exists()).toBe(false)
    expect(reader.selectedVerses).toEqual([])
    expect(window.getSelection()!.isCollapsed).toBe(true)
    expect(textActions()).toBeNull()
    expect(reader.highlights).toEqual({ 'KJV/John/1/1': '#ffcc00' })
    expect(wrapper.findAll('.verse')[1]!.attributes('style')).toContain('background: transparent')
    await button('Undo').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not restore note: offline')
    expect(wrapper.find('.inline-undo').exists()).toBe(true)
    await button('Undo').trigger('click')
    await flushPromises()
    expect(wrapper.find('.inline-undo').exists()).toBe(false)
    expect(wrapper.get('.inline-note').attributes('data-note-id')).toBe('restored')
    expect(wrapper.get('.inline-note').element.previousElementSibling?.getAttribute('data-verse')).toBe('2')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})
