// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import userEvent from '@testing-library/user-event'
import ConnectionsPanel from './ConnectionsPanel.vue'
import { api, type ChapterPayload, type ConnectionNode, type ConnectionsPayload } from '../services/api'
import { useReader } from '../stores/reader'
import { useLibrary } from '../stores/library'
import { useUi } from '../stores/ui'
import { pathologicalModule } from '../test/fixtures/moduleInfo'

const origin: ChapterPayload = {
  module: 'KJV', book: 'John', bookName: 'John', chapter: 1,
  verses: [1, 2].map((n) => ({ n, text: 'In the beginning was the Word.', notes: [], crossReferences: [], segments: [] }))
}
const target: ConnectionNode = {
  id: 'gen', module: 'KJV', book: 'Gen', bookName: 'Genesis', chapter: 1,
  verseStart: 1, verseEnd: 1, label: 'Genesis 1:1', content: 'In the beginning God created the heaven and the earth.', seed: false
}
function graph(state: ConnectionsPayload['semanticState'] = 'ready'): ConnectionsPayload {
  return {
    nodes: [target], edges: [{ source: 'origin', target: target.id, kind: 'cross-reference' }],
    semanticState: state, warnings: []
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  useLibrary().modules = [{ ...pathologicalModule, name: 'KJV', installed: true }]
  useReader().$patch({
    activeUserId: 'user-1', ready: true, moduleName: 'KJV', book: 'John', chapter: 1,
    selectedVerse: 1, rangeEnd: 2, data: origin,
    books: [
      { code: 'John', name: 'John', chapters: 21, section: 'nt' },
      { code: 'Gen', name: 'Genesis', chapters: 50, section: 'ot' }
    ]
  })
  vi.spyOn(api, 'connections').mockResolvedValue(graph())
  vi.spyOn(api, 'chapter').mockImplementation(async (_module, book) => book === 'John' ? origin : {
    ...origin, book: 'Gen', bookName: 'Genesis', verses: [{ ...origin.verses[0], text: target.content }]
  })
})
afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
function render() {
  wrapper = mount(ConnectionsPanel, { attachTo: document.body })
  return wrapper
}

describe('verse connections', () => {
  it('keeps curated previews first and follows a reference and Back using only the keyboard', async () => {
    render()
    const user = userEvent.setup()
    await flushPromises()
    expect(api.connections).toHaveBeenCalledWith([{
      module: 'KJV', book: 'John', chapter: 1, verseStart: 1, verseEnd: 2
    }])
    expect(wrapper.findAll('h3').map((h) => h.text())).toEqual(['Cross-references', 'Related by meaning'])
    expect(wrapper.get('.preview').text()).toBe(target.content)
    await user.tab() // Close connections
    await user.tab() // Curated reference
    expect(document.activeElement).toBe(wrapper.get('.passage').element)
    await user.keyboard('{Enter}')
    await flushPromises()
    expect(api.chapter).toHaveBeenCalledWith('KJV', 'Gen', 1)
    expect(useReader().book).toBe('Gen')
    expect(useReader().selectedVerses).toEqual([1])
    expect(document.activeElement).toBe(wrapper.get('h2').element)
    await user.tab()
    expect(document.activeElement?.textContent).toContain('Back')
    await user.keyboard(' ')
    await flushPromises()
    expect(useReader().book).toBe('John')
    expect(useReader().selectedVerses).toEqual([1, 2])
    expect(wrapper.text()).not.toContain('← Back')
    expect(document.activeElement).toBe(wrapper.get('h2').element)
  })

  it.each([
    ['stale', 'stale', 'Rebuild index in Settings'],
    ['empty', 'Build the meaning index', 'Open index settings'],
    ['unconfigured', 'Set up an embedding provider', 'Open index settings'],
    ['building', 'index is building', 'Open index settings'],
    ['failed', 'index failed', 'Open index settings'],
    ['unavailable', 'could not be loaded', 'Open index settings']
  ] as const)('distinguishes %s from empty results and hides meaning links with an actionable CTA', async (state, notice, cta) => {
    const response = graph(state)
    response.edges.push({ source: 'origin', target: target.id, kind: 'thematic' })
    vi.mocked(api.connections).mockResolvedValue(response)
    render()
    const openSettings = vi.spyOn(useUi(), 'openSemanticSettings')
    await flushPromises()
    const semantic = wrapper.get('section[aria-label="Related by meaning"]')
    expect(semantic.text()).toContain(notice)
    expect(semantic.find('.passage').exists()).toBe(false)
    expect(wrapper.get('section[aria-label="Cross-references"] .passage').text()).toContain(target.content)
    const button = semantic.findAll('button').find((b) => b.text() === cta)!
    await button.trigger('click')
    expect(openSettings).toHaveBeenCalledOnce()
    expect(useUi().settingsSection).toBe('semantic-search')
  })

  it('distinguishes an empty ready index from a request error and retries failed requests', async () => {
    vi.mocked(api.connections).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      nodes: [], edges: [], semanticState: 'ready', warnings: []
    })
    render()
    expect(wrapper.text()).toContain('Loading connections')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load connections')
    expect(wrapper.text()).not.toContain('No cross-references available')
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No cross-references available')
    expect(wrapper.text()).toContain('No related passages found')
  })

  it.each(['resolve', 'reject'] as const)('ignores a stale request that finishes with %s after translation/selection changes', async (finish) => {
    const pending = deferred<ConnectionsPayload>()
    vi.mocked(api.connections).mockReturnValueOnce(pending.promise).mockResolvedValue({
      nodes: [], edges: [], semanticState: 'stale', warnings: []
    })
    render()
    useReader().moduleName = 'WEB'
    useReader().selectedVerse = 2
    await flushPromises()
    if (finish === 'resolve') pending.resolve(graph())
    else pending.reject(new Error('old request failed'))
    await flushPromises()
    expect(wrapper.text()).toContain('WEB')
    expect(wrapper.text()).toContain('index is stale')
    expect(wrapper.find('.passage').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(api.connections).toHaveBeenLastCalledWith([expect.objectContaining({ module: 'WEB', verseStart: 2 })])
  })

  it('invalidates a pending request when selection clears', async () => {
    const pending = deferred<ConnectionsPayload>()
    vi.mocked(api.connections).mockReturnValue(pending.promise)
    render()
    useReader().clearSelection()
    await flushPromises()
    pending.reject(new Error('late failure'))
    await flushPromises()
    expect(wrapper.text()).toContain('Select a verse')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.attributes('aria-busy')).toBe('false')
  })

  it('retains origin and Back after a navigation failure, and reports failure to return', async () => {
    render()
    await flushPromises()
    vi.mocked(api.chapter).mockRejectedValueOnce(new Error('uninstalled'))
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('John')
    expect(useReader().selectedVerses).toEqual([1, 2])
    expect(wrapper.get('[role="alert"]').text()).toContain('not available')
    expect(wrapper.text()).not.toContain('← Back')
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    vi.mocked(api.chapter).mockRejectedValueOnce(new Error('offline'))
    await wrapper.findAll('button').find((b) => b.text().includes('Back'))!.trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('Gen')
    expect(wrapper.text()).toContain('← Back')
    expect(wrapper.get('[role="alert"]').text()).toContain('not available')
  })

  it('returns to the origin after opening a chapter-level reference without a verse selection', async () => {
    const response = graph()
    response.nodes = [{ ...target, verseStart: null, verseEnd: null, label: 'Genesis 1' }]
    vi.mocked(api.connections).mockResolvedValue(response)
    render()
    await flushPromises()
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('Gen')
    expect(useReader().selectedVerses).toEqual([])
    await wrapper.findAll('button').find((b) => b.text().includes('Back'))!.trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('John')
    expect(useReader().selectedVerses).toEqual([1, 2])
    expect(wrapper.text()).not.toContain('← Back')
  })

  it('discards chapter-level Back history after manual navigation without a selection', async () => {
    const response = graph()
    response.nodes = [{ ...target, verseStart: null, verseEnd: null }]
    vi.mocked(api.connections).mockResolvedValue(response)
    render()
    await flushPromises()
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('← Back')
    useReader().chapter = 2
    await flushPromises()
    expect(wrapper.text()).not.toContain('← Back')
  })

  it('retries a failed meaning lookup while keeping curated previews available', async () => {
    vi.mocked(api.connections).mockResolvedValueOnce(graph('unavailable')).mockResolvedValue(graph())
    render()
    await flushPromises()
    expect(wrapper.get('section[aria-label="Cross-references"] .preview').text()).toBe(target.content)
    await wrapper.get('section[aria-label="Related by meaning"] button').trigger('click')
    await flushPromises()
    expect(api.connections).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('No related passages found')
    expect(wrapper.text()).not.toContain('could not be loaded')
  })

  it.each(['selection', 'account', 'unmount'] as const)('does not navigate after %s changes during a pending chapter fetch', async (change) => {
    const pending = deferred<ChapterPayload>()
    vi.mocked(api.chapter).mockReturnValue(pending.promise)
    render()
    await flushPromises()
    await wrapper.get('.passage').trigger('click')
    if (change === 'selection') useReader().selectVerse(2)
    else if (change === 'account') useReader().activeUserId = 'user-2'
    else wrapper.unmount()
    pending.resolve({ ...origin, book: 'Gen' })
    await flushPromises()
    expect(useReader().book).toBe('John')
    expect(wrapper.emitted('navigated')).toBeUndefined()
  })

  it('preserves a multi-link trail and discards it when the reader changes passage manually', async () => {
    const next = { ...target, id: 'john2', book: 'John', bookName: 'John', verseStart: 2, verseEnd: 2, label: 'John 1:2' }
    vi.mocked(api.connections).mockResolvedValueOnce(graph()).mockResolvedValue({
      ...graph(), nodes: [next], edges: [{ source: 'gen', target: next.id, kind: 'cross-reference' }]
    })
    render()
    await flushPromises()
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('John')
    expect(useReader().selectedVerses).toEqual([2])
    await wrapper.findAll('button').find((b) => b.text().includes('Back'))!.trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('Gen')
    expect(wrapper.text()).toContain('← Back')
    await wrapper.findAll('button').find((b) => b.text().includes('Back'))!.trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('John')
    expect(useReader().selectedVerses).toEqual([1, 2])
    expect(wrapper.text()).not.toContain('← Back')
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('← Back')
    useReader().clearSelection()
    await flushPromises()
    expect(wrapper.text()).not.toContain('← Back')
    expect(wrapper.text()).toContain('Select a verse')
  })

  it('serializes repeated activation while navigation is pending', async () => {
    const pending = deferred<ChapterPayload>()
    vi.mocked(api.chapter).mockReturnValue(pending.promise)
    render()
    await flushPromises()
    const button = wrapper.get('.passage')
    await button.trigger('click')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(api.chapter).toHaveBeenCalledTimes(1)
    pending.resolve({ ...origin, book: 'Gen' })
    await flushPromises()
    expect(wrapper.emitted('navigated')).toHaveLength(1)
  })

  it('rejects a destination whose verse is missing without changing the current passage', async () => {
    vi.mocked(api.chapter).mockResolvedValue({ ...origin, verses: [] })
    render()
    await flushPromises()
    await wrapper.get('.passage').trigger('click')
    await flushPromises()
    expect(useReader().book).toBe('John')
    expect(wrapper.get('[role="alert"]').text()).toContain('not available')
    expect(wrapper.emitted('navigated')).toBeUndefined()
  })
})
