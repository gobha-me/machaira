// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import userEvent from '@testing-library/user-event'
import LibraryScreen from './LibraryScreen.vue'
import { useLibrary } from '../stores/library'
import { api } from '../services/api'
import { pathologicalModule } from '../test/fixtures/moduleInfo'

let wrapper: VueWrapper
beforeEach(() => {
  vi.restoreAllMocks()
  const pinia = createPinia()
  setActivePinia(pinia)
  const library = useLibrary()
  library.loaded = true
  library.modules = [{ ...pathologicalModule, installed: true, aiEligibility: 'public-domain' }]
  wrapper = mount(LibraryScreen, { attachTo: document.body, global: { plugins: [pinia] } })
})
afterEach(() => {
  wrapper.unmount()
  document.body.innerHTML = ''
})

describe('library dialog accessibility', () => {
  it.each(['Escape', 'button', 'backdrop'])('opens details with the keyboard, traps focus, and returns it after %s dismissal', async (dismissal) => {
    const user = userEvent.setup()
    const details = wrapper.get('button.details').element as HTMLElement
    details.focus()
    await user.keyboard('{Enter}')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(pathologicalModule.description)
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!
    expect(document.activeElement).toBe(close)
    await user.tab({ shift: true })
    expect(document.activeElement?.textContent?.trim()).toBe('Remove')
    await user.tab()
    expect(document.activeElement).toBe(close)
    // Public-domain consent is disabled and must be skipped by Tab.
    await user.tab()
    expect(document.activeElement?.textContent?.trim()).toBe('Remove')
    if (dismissal === 'Escape') await user.keyboard('{Escape}')
    else if (dismissal === 'button') await user.click(close)
    else await user.click(dialog)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(details)
  })

  it('announces a failed source refresh while preserving cached sources', async () => {
    vi.spyOn(api, 'catalog').mockRejectedValueOnce(new Error('Repository offline'))
    vi.spyOn(api, 'corpusPreferences').mockResolvedValueOnce({})
    await useLibrary().load(true)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Repository offline')
    expect(wrapper.find('button.details').exists()).toBe(true)
  })
})
