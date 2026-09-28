// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { api, type SearchHit } from '../services/api'
import { useLibrary } from '../stores/library'
import { useSemanticIndex } from '../stores/semanticIndex'
import { pathologicalModule } from '../test/fixtures/moduleInfo'
import SearchScreen from './SearchScreen.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function hit(content: string): SearchHit {
  return { kind: 'scripture', module: 'WEB', book: 'John', bookName: 'John', chapter: 1, verse: 1, content }
}
let wrapper: VueWrapper
beforeEach(() => {
  vi.restoreAllMocks()
  const pinia = createPinia()
  setActivePinia(pinia)
  const library = useLibrary()
  library.modules = [
    { ...pathologicalModule, id: 'WEB', name: 'WEB', type: 'BIBLE', kind: 'scripture', installed: true },
    { ...pathologicalModule, id: 'Ancient', name: 'Ancient', type: 'GENBOOK', kind: 'general-book', installed: true }
  ]
  vi.spyOn(library, 'load').mockResolvedValue()
  const semantic = useSemanticIndex()
  semantic.status.state = 'ready'
  vi.spyOn(semantic, 'load').mockResolvedValue()
  wrapper = mount(SearchScreen, { global: { plugins: [pinia], stubs: { VoiceInputButton: true } } })
})
afterEach(() => wrapper.unmount())
async function search(query: string) {
  await wrapper.get('input.query').setValue(query)
  await wrapper.get('input.query').trigger('keydown.enter')
}
async function scope(label: string) {
  await wrapper.findAll('button.scope').find((button) => button.text() === label)!.trigger('click')
}

describe('search request ownership and scopes', () => {
  it.each(['success', 'failure'])('discards an older query %s without finishing the current request', async (outcome) => {
    const first = deferred<SearchHit[]>()
    const second = deferred<SearchHit[]>()
    vi.spyOn(api, 'search').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await search('first')
    await search('second')
    if (outcome === 'success') first.resolve([hit('obsolete')])
    else first.reject(new Error('obsolete failure'))
    await flushPromises()
    expect(wrapper.text()).toContain('Searching…')
    expect(wrapper.text()).not.toContain('obsolete')
    second.resolve([hit('Current answer')])
    await flushPromises()
    expect(wrapper.text()).toContain('Current answer')
  })

  it('does not replace newer results with an older response', async () => {
    const first = deferred<SearchHit[]>()
    vi.spyOn(api, 'search').mockReturnValueOnce(first.promise).mockResolvedValueOnce([hit('Current answer')])
    await search('first')
    await search('second')
    await flushPromises()
    first.resolve([hit('Obsolete answer')])
    await flushPromises()
    expect(wrapper.text()).toContain('Current answer')
    expect(wrapper.text()).not.toContain('Obsolete answer')
  })

  it('clears old results after failure and when the query is emptied', async () => {
    vi.spyOn(api, 'search').mockResolvedValueOnce([hit('Old result')]).mockRejectedValueOnce(new Error('offline'))
    await search('first')
    await flushPromises()
    await search('second')
    await flushPromises()
    expect(wrapper.findAll('.result')).toHaveLength(0)
    expect(wrapper.text()).toContain('offline')
    await wrapper.get('input.query').setValue('')
    expect(wrapper.text()).not.toContain('offline')
    expect(wrapper.find('.count').exists()).toBe(false)
  })

  it('invalidates a pending query immediately on editing without resubmission', async () => {
    const pending = deferred<SearchHit[]>()
    vi.spyOn(api, 'search').mockReturnValue(pending.promise)
    await search('first')
    await wrapper.get('input.query').setValue('not submitted')
    pending.resolve([hit('Old result')])
    await flushPromises()
    expect(wrapper.findAll('.result')).toHaveLength(0)
    expect(wrapper.find('.count').exists()).toBe(false)
  })

  it('sends scoped module lists and book scopes in exact and semantic searches', async () => {
    const exact = vi.spyOn(api, 'search').mockResolvedValue([])
    const meaning = vi.spyOn(api, 'semanticSearch').mockResolvedValue([])
    await scope('Scripture')
    await search('love')
    expect(exact).toHaveBeenLastCalledWith('love', ['WEB'], 'scripture')
    await scope('Apocrypha')
    expect(exact).toHaveBeenLastCalledWith('love', ['WEB'], 'apocrypha')
    await wrapper.findAll('button.mode')[1].trigger('click')
    expect(meaning).toHaveBeenLastCalledWith('love', ['WEB'], 50, 'apocrypha')
    await scope('Ancient writings')
    expect(meaning).toHaveBeenLastCalledWith('love', ['Ancient'], 50, 'ancient-writings')
    await scope('Notes & journal')
    await flushPromises()
    expect(wrapper.findAll('button.mode')[1].attributes('disabled')).toBeDefined()
  })

  it('discards a pending exact response after mode and scope change', async () => {
    const pending = deferred<SearchHit[]>()
    vi.spyOn(api, 'search').mockReturnValue(pending.promise)
    vi.spyOn(api, 'semanticSearch').mockResolvedValue([
      { kind: 'general-book', module: 'Ancient', key: 'Entry', title: 'Entry', content: 'Current meaning result', distance: 0 }
    ])
    await search('love')
    await wrapper.findAll('button.mode')[1].trigger('click')
    await scope('Ancient writings')
    await flushPromises()
    pending.resolve([hit('Obsolete exact result')])
    await flushPromises()
    expect(wrapper.text()).toContain('Current meaning result')
    expect(wrapper.text()).not.toContain('Obsolete exact result')
    expect(wrapper.text()).toContain('top 50 corpus matches')
  })
})
