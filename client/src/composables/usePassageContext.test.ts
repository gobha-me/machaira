// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReader } from '../stores/reader'
import { usePassageContext } from './usePassageContext'

let wrapper: VueWrapper
let context: ReturnType<typeof usePassageContext>

beforeEach(() => {
  setActivePinia(createPinia())
  useReader().$patch({
    moduleName: 'WEB', book: 'Gen', chapter: 1,
    books: [{ code: 'Gen', name: 'Genesis', section: 'ot', chapters: 50 }],
    data: { module: 'WEB', book: 'Gen', bookName: 'Genesis', chapter: 1, verses: [
      { n: 1, text: 'In the beginning, God created the heavens and the earth.', segments: [], notes: [], crossReferences: [] },
      { n: 2, text: 'The earth was formless and empty.', segments: [], notes: [], crossReferences: [] }
    ] }
  })
  wrapper = mount(defineComponent({
    setup() { context = usePassageContext(); return {} },
    template: `<div><div data-passage-context><span data-verse="1"><span data-selection-text>In the beginning, God created the heavens and the earth.</span></span></div><input aria-controls="study-partner"><textarea /></div>`
  }), { attachTo: document.body })
})

afterEach(() => {
  wrapper.unmount()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

function selectProse() {
  const text = wrapper.get('[data-selection-text]').element.firstChild!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 16)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('global passage context', () => {
  it('uses the whole chapter, sorts reverse verse selections and never widens a missing selection', () => {
    const reader = useReader()
    expect(context.value.reference).toBe('Genesis 1')
    expect(context.value.content).toContain('1. In the beginning')
    expect(context.value.content).toContain('2. The earth')
    reader.selectedVerse = 2
    reader.rangeEnd = 1
    expect(context.value.reference).toBe('Genesis 1:1–2')
    reader.rangeEnd = null
    expect(context.value.content).toBe('2. The earth was formless and empty.')
    reader.selectedVerse = 999
    expect(context.value.content).toBe('')
    reader.selectedVerse = 1
    reader.data!.verses[0].text = '   '
    expect(context.value.content).toBe('')
  })

  it.each(['loading', 'failure', 'chapter', 'book', 'module', 'empty'] as const)(
    'excludes stale content after %s even when old verses are still present', (condition) => {
      selectProse()
      expect(context.value.content).toBe('In the beginning')
      const reader = useReader()
      if (condition === 'loading') reader.loadingChapter = true
      if (condition === 'failure') reader.error = 'Offline'
      if (condition === 'chapter') reader.chapter = 2
      if (condition === 'book') reader.book = 'John'
      if (condition === 'module') reader.moduleName = 'KJV'
      if (condition === 'empty') reader.data = null
      expect(context.value.content).toBe('')
      reader.loadingChapter = false
      reader.error = null
      reader.chapter = 1
      reader.book = 'Gen'
      reader.moduleName = 'WEB'
      if (condition !== 'empty') expect(context.value.content).toContain('1. In the beginning')
    }
  )

  it('captures only Scripture prose, preserves it for the composer, then clears it on a verse change', () => {
    selectProse()
    expect(context.value).toEqual({ reference: 'Genesis 1:1', module: 'WEB', content: 'In the beginning' })
    ;(wrapper.get('input').element as HTMLElement).focus()
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    expect(context.value.content).toBe('In the beginning')
    useReader().selectVerse(2)
    expect(context.value.content).toBe('2. The earth was formless and empty.')
    ;(wrapper.get('textarea').element as HTMLElement).focus()
    document.dispatchEvent(new Event('selectionchange'))
    expect(context.value.content).toBe('2. The earth was formless and empty.')
  })

  it('captures a new Scripture range while focus remains on the drawer toggle, without retaining an invalid range', () => {
    ;(wrapper.get('input').element as HTMLElement).focus()
    // Native selection of non-focusable verse prose need not move keyboard focus.
    selectProse()
    expect(context.value).toEqual({ reference: 'Genesis 1:1', module: 'WEB', content: 'In the beginning' })
    const range = window.getSelection()!.getRangeAt(0)
    range.setEnd(wrapper.get('[data-selection-text]').element.firstChild!, 6)
    document.dispatchEvent(new Event('selectionchange'))
    expect(context.value.content).toBe('In the')

    range.selectNodeContents(wrapper.element)
    document.dispatchEvent(new Event('selectionchange'))
    expect(context.value.reference).toBe('Genesis 1')
    expect(context.value.content).toContain('2. The earth')
  })

  it('rejects a range extending outside Scripture and removes its listener on unmount', () => {
    selectProse()
    const range = document.createRange()
    range.selectNodeContents(wrapper.element)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    expect(context.value.reference).toBe('Genesis 1')
    const remove = vi.spyOn(document, 'removeEventListener')
    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('selectionchange', expect.any(Function))
    remove.mockRestore()
  })
})
