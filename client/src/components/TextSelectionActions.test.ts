// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import TextSelectionActions from './TextSelectionActions.vue'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('text selection toolbar layout', () => {
  it('measures expanded content, reacts to drawer changes, and disconnects on unmount', async () => {
    let resized = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe = vi.fn()
      disconnect = disconnect
    })
    const root = document.createElement('div')
    root.innerHTML = '<span data-verse="1"><span data-selection-text>In the beginning</span></span>'
    const drawer = document.createElement('aside')
    document.body.append(root, drawer)
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 620, 900))
    vi.spyOn(drawer, 'getBoundingClientRect').mockReturnValue(new DOMRect(800, 0, 200, 900))
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(500, 80, 60, 20))
    let height = 52
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('text-selection-actions') ? height : 0
    })
    const wrapper = mount(TextSelectionActions, { props: { root, avoid: drawer }, global: { plugins: [createPinia()] } })
    try {
      const range = document.createRange()
      range.selectNodeContents(root.querySelector('[data-selection-text]')!)
      window.getSelection()!.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      await flushPromises()
      const toolbar = document.querySelector<HTMLElement>('.text-selection-actions')!
      expect(toolbar.style.top).toBe('20px')
      height = 220
      ;[...toolbar.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Word study')!.click()
      await flushPromises()
      expect(toolbar.textContent).toContain('No Strong’s tags')
      expect(toolbar.style.top).toBe('108px')
      toolbar.dispatchEvent(new Event('scroll'))
      await flushPromises()
      expect(document.querySelector('.text-selection-actions')).toBe(toolbar)
      // A drawer can overlap the column on narrow screens. Recompute without a new selection.
      vi.mocked(drawer.getBoundingClientRect).mockReturnValue(new DOMRect(420, 0, 400, 900))
      resized()
      await flushPromises()
      expect(Number.parseFloat(toolbar.style.left) + Number.parseFloat(toolbar.style.width)).toBeLessThanOrEqual(412)
      vi.mocked(drawer.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 1000, 1000))
      resized()
      await flushPromises()
      expect(toolbar.style.visibility).toBe('hidden')
    } finally {
      const calls = disconnect.mock.calls.length
      wrapper.unmount()
      expect(disconnect.mock.calls.length).toBeGreaterThan(calls)
      expect(document.querySelector('.text-selection-actions')).toBeNull()
    }
  })
})
