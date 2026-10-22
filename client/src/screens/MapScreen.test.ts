// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import userEvent from '@testing-library/user-event'
import { getByRole } from '@testing-library/dom'
import type { CrossReferenceMapPayload } from '@machaira/scripture'
import { api } from '../services/api'
import { useLibrary } from '../stores/library'
import { useReader } from '../stores/reader'
import { useSemanticIndex } from '../stores/semanticIndex'
import { createAppRouter } from '../router'
import MapScreen from './MapScreen.vue'

// Real dataset row from the bundled OpenBible snapshot, not production fallback data.
const graph: CrossReferenceMapPayload = {
  nodes: [{ id: 'Gen', book: 'Gen', label: 'Genesis', chapter: null, verse: null }, { id: 'Rev', book: 'Rev', label: 'Revelation', chapter: null, verse: null }],
  edges: [{ source: 'Gen', target: 'Rev', count: 82, sample: { source: 'Gen.1.1', target: 'Rev.14.7' } }], totalLinks: 344799, matchedLinks: 344799
}
let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(api, 'crossReferenceMap').mockResolvedValue(graph)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); document.body.innerHTML = '' })
async function render(installed = true) {
  const library = useLibrary()
  if (installed) library.modules = [{ name: 'KJV', kind: 'scripture', installed: true } as typeof library.modules[number]]
  useReader().moduleName = installed ? 'KJV' : ''
  const router = createAppRouter(createMemoryHistory())
  await router.push('/map')
  wrapper = mount(MapScreen, { attachTo: document.body, global: { plugins: [router], stubs: { CrossReferenceMapCanvas: true } } })
  await flushPromises()
  return { router, wrapper }
}
function button(label: string) { return [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)! }

describe('cross-reference map failure paths and keyboard alternative', () => {
  it('shows the full map without an index or Bible and disables unavailable actions', async () => {
    const similarity = vi.spyOn(api, 'mapSimilarity')
    const { wrapper } = await render(false)
    expect(wrapper.text()).toContain('344,799')
    expect(wrapper.text()).toContain('Install a Bible in Library')
    expect(wrapper.get('input[type=checkbox]').attributes('disabled')).toBeDefined()
    expect(similarity).not.toHaveBeenCalled()
    button('Show accessible list').click()
    await flushPromises()
    expect(button('Revelation 14:7').disabled).toBe(true)
  })

  it('reports initial failures, retries, and ignores out-of-order or unmounted responses', async () => {
    vi.mocked(api.crossReferenceMap).mockRejectedValueOnce(new Error('disk offline'))
    const { wrapper } = await render()
    expect(wrapper.get('[role=alert]').text()).toContain('Could not load')
    await wrapper.get('[role=alert] button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('344,799')
    let resolve!: (value: CrossReferenceMapPayload) => void
    vi.mocked(api.crossReferenceMap).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    await wrapper.findAll('select')[0].setValue('Gen')
    await wrapper.findAll('select')[0].setValue('Rev')
    await flushPromises()
    resolve({ ...graph, totalLinks: 1 })
    await flushPromises()
    expect(wrapper.text()).toContain('344,799')
    expect(wrapper.text()).not.toContain('1 / 1 links')
    wrapper.unmount()
  })

  it('zooms book to chapter to verse using native select controls and keeps page size bounded', async () => {
    const { wrapper } = await render()
    vi.mocked(api.crossReferenceMap).mockResolvedValueOnce({ ...graph, nodes: [
      { id: 'Gen.1', book: 'Gen', chapter: 1, verse: null, label: 'Genesis 1' },
      { id: 'Gen.2', book: 'Gen', chapter: 2, verse: null, label: 'Genesis 2' }, graph.nodes[1]
    ] })
    const user = userEvent.setup()
    await user.selectOptions(getByRole(document.body, 'combobox', { name: 'Book' }), 'Gen')
    await flushPromises()
    expect(wrapper.findAll('select')[1].attributes('disabled')).toBeUndefined()
    await user.selectOptions(getByRole(document.body, 'combobox', { name: 'Chapter' }), '2')
    await flushPromises()
    expect(api.crossReferenceMap).toHaveBeenLastCalledWith({ book: 'Gen', chapter: 2 }, expect.any(AbortSignal))
    button('Show accessible list').click()
    await flushPromises()
    expect(wrapper.findAll('.link-list li')).toHaveLength(1)
    expect(button('Previous').disabled).toBe(true)
    expect(button('Next').disabled).toBe(true)
  })

  it('opens a mapped passage in Read with Enter, and reports missing verses and resolver failures', async () => {
    const { router, wrapper } = await render()
    const resolve = vi.spyOn(api, 'resolveMapReference').mockResolvedValueOnce({ target: null }).mockRejectedValueOnce(new Error('offline'))
    button('Show accessible list').click()
    await flushPromises()
    const target = button('Revelation 14:7')
    const user = userEvent.setup()
    target.focus()
    await user.keyboard('{Enter}')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('unavailable in the selected translation')
    expect(router.currentRoute.value.name).toBe('map')
    await user.keyboard('{Enter}')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('Could not open')
    resolve.mockResolvedValueOnce({ target: { book: 'Rev', chapter: 14, verseStart: 7, verseEnd: 7 } })
    await user.keyboard('{Enter}')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/read/KJV/Rev/14/7')
    expect(resolve).toHaveBeenCalledWith('KJV', 'Rev.14.7')
  })

  it('discards a passage resolution after the view changes or is unmounted', async () => {
    const { router, wrapper } = await render()
    let finish!: (value: { target: { book: string; chapter: number; verseStart: number; verseEnd: number } }) => void
    vi.spyOn(api, 'resolveMapReference').mockImplementation(() => new Promise((done) => { finish = done }))
    button('Show accessible list').click()
    await flushPromises()
    button('Revelation 14:7').click()
    await flushPromises()
    await wrapper.findAll('select')[0].setValue('Gen')
    finish({ target: { book: 'Rev', chapter: 14, verseStart: 7, verseEnd: 7 } })
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('map')
    const push = vi.spyOn(router, 'push')
    button('Revelation 14:7').click()
    await flushPromises()
    wrapper.unmount()
    finish({ target: { book: 'Rev', chapter: 14, verseStart: 7, verseEnd: 7 } })
    await flushPromises()
    expect(push).not.toHaveBeenCalled()
  })

  it('disables similarity after index failure and never hides curated arcs because of a failed optional request', async () => {
    useSemanticIndex().status = { state: 'ready', modules: ['KJV'], chunkCount: 3, model: 'local', updatedAt: 1, lastError: null }
    vi.spyOn(api, 'mapSimilarity').mockRejectedValue(new Error('index unavailable'))
    const { wrapper } = await render()
    expect(wrapper.text()).toContain('Similarity unavailable')
    expect(wrapper.get('input[type=checkbox]').attributes('disabled')).toBeDefined()
    button('Show accessible list').click()
    await flushPromises()
    expect(wrapper.findAll('.link-list li')).toHaveLength(1)
  })

  it('filters only scored links and restores the complete list when similarity is turned off', async () => {
    useSemanticIndex().status = { state: 'ready', modules: ['KJV'], chunkCount: 3, model: 'local', updatedAt: 1, lastError: null }
    vi.spyOn(api, 'mapSimilarity').mockResolvedValue({ state: 'ready', distances: [0.5] })
    const { wrapper } = await render()
    await wrapper.get('input[type=checkbox]').setValue(true)
    button('Show accessible list').click()
    await flushPromises()
    await wrapper.get('input[type=range]').setValue('0')
    expect(wrapper.text()).toContain('No connections match')
    await wrapper.get('input[type=checkbox]').setValue(false)
    expect(wrapper.findAll('.link-list li')).toHaveLength(1)
  })
})
