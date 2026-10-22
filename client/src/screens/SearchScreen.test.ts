// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import userEvent from '@testing-library/user-event'
import { useReader } from '../stores/reader'
import { useNotes } from '../stores/notes'
import { api, ApiError, type SearchHit } from '../services/api'
import { useUi } from '../stores/ui'
import { useLibrary } from '../stores/library'
import { useSemanticIndex } from '../stores/semanticIndex'
import { pathologicalModule } from '../test/fixtures/moduleInfo'
import SearchScreen from './SearchScreen.vue'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '../router'

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
  const router = createAppRouter(createMemoryHistory())
  wrapper = mount(SearchScreen, { attachTo: document.body, global: { plugins: [pinia, router], stubs: { VoiceInputButton: true } } })
})
afterEach(() => {
  wrapper.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
async function search(query: string) {
  await wrapper.get('input.query').setValue(query)
  await wrapper.get('input.query').trigger('keydown.enter')
}
async function scope(label: string) {
  await wrapper.findAll('button.scope').find((button) => button.text() === label)!.trigger('click')
}

describe('search request ownership and scopes', () => {
  it.each(['stale', 'failed', 'unconfigured'] as const)(
    'shows exact-search results through /api/search with a %s semantic index', async (state) => {
      useSemanticIndex().status.state = state
      useSemanticIndex().status.lastError = state === 'failed' ? 'Embedding provider unavailable' : null
      const meaning = vi.spyOn(api, 'semanticSearch').mockRejectedValue(new Error('Semantic search must not run'))
      const index = vi.spyOn(api, 'semanticIndexStatus').mockRejectedValue(new Error('Index status unavailable'))
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [hit('In the beginning')] })))
      vi.stubGlobal('fetch', fetch)

      await search('beginning')
      await flushPromises()

      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/search?q=beginning&modules=WEB%2CAncient&scope=all', { credentials: 'same-origin' })
      expect(wrapper.get('.result').text()).toContain('In the beginning')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('Exact-word search does not use the semantic index.')
      expect(meaning).not.toHaveBeenCalled()
      expect(index).not.toHaveBeenCalled()
    }
  )

  it.each(['unconfigured', 'empty', 'stale', 'failed', 'building'] as const)(
    'shows the %s state, last rebuild error, and a direct Settings link', async (state) => {
      const semantic = useSemanticIndex()
      semantic.status.state = state
      semantic.status.lastError = 'Embedding request timed out or was cancelled <script>alert(1)</script>'
      await flushPromises()
      const status = wrapper.get('[role="status"]')
      expect(status.text()).toContain(`Semantic index: ${state}`)
      expect(status.text()).toContain(semantic.status.lastError)
      expect(status.find('script').exists()).toBe(false)
      expect(wrapper.findAll('button.mode')[1].attributes('disabled')).toBeDefined()
      await status.get('button').trigger('click')
      await flushPromises()
      expect(useUi().screen).toBe('settings')
      expect(useUi().settingsSection).toBe('semantic-search')
      semantic.status.lastError = null
      await flushPromises()
      expect(wrapper.get('[role="status"]').text()).toContain('Settings → Semantic search')
      expect(wrapper.text()).not.toContain('Last rebuild error:')
    }
  )

  it('shows a status fetch failure and a Settings link even when the last known index was ready', async () => {
    useSemanticIndex().error = 'Could not load index status'
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Could not load index status')
    expect(wrapper.get('[role="status"] button').text()).toBe('Settings → Semantic search')
  })

  it('keeps meaning search enabled after a failed rebuild and explains that it uses the old index', async () => {
    const semantic = useSemanticIndex()
    semantic.status.lastError = 'Embedding request failed after 3 attempts at batch size 1'
    const meaning = vi.spyOn(api, 'semanticSearch').mockResolvedValue([{ ...hit('Previous index result'), distance: 0 }])
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('The last rebuild failed')
    expect(wrapper.get('[role="status"]').text()).toContain(semantic.status.lastError)
    expect(wrapper.get('[role="status"]').text()).toContain('still uses the old index')
    expect(wrapper.findAll('button.mode')[1].attributes('disabled')).toBeUndefined()
    await wrapper.findAll('button.mode')[1].trigger('click')
    await search('love')
    await flushPromises()
    expect(meaning).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Previous index result')

    semantic.status.lastError = null
    await flushPromises()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it('does not advertise searching an old index when the failed rebuild has no usable index', async () => {
    const semantic = useSemanticIndex()
    semantic.status.state = 'failed'
    semantic.status.lastError = 'provider offline'
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Semantic index: failed')
    expect(wrapper.get('[role="status"]').text()).not.toContain('still uses the old index')
    expect(wrapper.findAll('button.mode')[1].attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('provider offline')
  })

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
    expect(wrapper.get('[role="alert"]').text()).toContain('offline')
    expect(wrapper.text()).not.toContain('No matches')
    expect(wrapper.find('.count').exists()).toBe(false)
    expect(wrapper.find('.hint').exists()).toBe(false)
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

describe('temporary search outages', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))

  // Ingress failures can be HTML rather than the API's normal JSON error body.
  function outage(failure: number | 'network'): Promise<Response> {
    return failure === 'network'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(new Response('<html>upstream unavailable</html>', { status: failure }))
  }

  it.each([502, 503, 504, 'network'] as const)('recovers from %s with exactly one delayed retry', async (failure) => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => outage(failure))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [hit('Recovered result')] })))
    vi.stubGlobal('fetch', fetch)
    await search('love')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('The server is temporarily unavailable. Retrying…')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('.count').exists()).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(749)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(wrapper.get('.result').text()).toContain('Recovered result')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0])
  })

  it.each([502, 503, 504, 'network'] as const)('stops after two %s failures and offers a working Retry', async (failure) => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => outage(failure))
      .mockImplementationOnce(() => outage(failure))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [hit('Manual retry result')] })))
    vi.stubGlobal('fetch', fetch)
    await scope('Scripture')
    await search(' love ')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(750)
    await flushPromises()

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('The server is temporarily unavailable. Please try again.')
    expect(alert.text()).not.toContain('HTTP')
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.find('.count').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('No matches')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(2)

    expect(alert.get('button').text()).toBe('Retry')
    await alert.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.result').text()).toContain('Manual retry result')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.every((call) => call[0] === '/api/search?q=love&modules=WEB&scope=scripture')).toBe(true)
  })

  it.each([400, 401, 403, 404, 429, 500])('makes HTTP %s actionable without automatically retrying it', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status }))
    vi.stubGlobal('fetch', fetch)
    await search('word')
    await flushPromises()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain(`HTTP ${status}`)
    expect(alert.text()).toContain('Please try again.')
    expect(alert.get('button').text()).toBe('Retry')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves an actionable API validation error when the retry fails differently', async () => {
    vi.spyOn(api, 'search')
      .mockRejectedValueOnce(new ApiError(503, {}))
      .mockRejectedValueOnce(new ApiError(400, { message: 'Invalid search scope' }))
    await search('word')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(750)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Invalid search scope. Please try again.')
    expect(wrapper.text()).not.toContain('Retrying…')
  })

  it.each(['edit', 'query', 'scope', 'mode', 'unmount'])(
    'cancels the backoff on %s without sending an obsolete retry', async (change) => {
      const exact = vi.spyOn(api, 'search')
        .mockRejectedValueOnce(new ApiError(503, {}))
        .mockResolvedValue([hit('Current result')])
      vi.spyOn(api, 'semanticSearch').mockResolvedValue([{ ...hit('Meaning result'), distance: 0 }])
      await search('word')
      await flushPromises()
      expect(wrapper.get('[role="status"]').text()).toContain('Retrying…')
      if (change === 'edit') await wrapper.get('input.query').setValue('unfinished')
      if (change === 'query') await search('second')
      if (change === 'scope') await scope('Scripture')
      if (change === 'mode') await wrapper.findAll('button.mode')[1].trigger('click')
      if (change === 'unmount') wrapper.unmount()
      await flushPromises()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(exact).toHaveBeenCalledTimes(change === 'query' || change === 'scope' ? 2 : 1)
      if (change === 'unmount') return
      expect(wrapper.text()).not.toContain('Retrying…')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      if (change === 'query' || change === 'scope') expect(wrapper.get('.result').text()).toContain('Current result')
      if (change === 'mode') expect(wrapper.get('.result').text()).toContain('Meaning result')
    }
  )

  it('does not schedule a retry for a late failure from an older request', async () => {
    const old = deferred<SearchHit[]>()
    const exact = vi.spyOn(api, 'search').mockReturnValueOnce(old.promise).mockResolvedValueOnce([hit('Current result')])
    await search('first')
    await search('second')
    await flushPromises()
    old.reject(new ApiError(503, {}))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exact).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.result').text()).toContain('Current result')
  })

  it.each(['success', 'failure'])('discards a retry %s after the query changes', async (outcome) => {
    const retry = deferred<SearchHit[]>()
    const exact = vi.spyOn(api, 'search')
      .mockRejectedValueOnce(new ApiError(503, {}))
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce([hit('Current result')])
    await search('first')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(750)
    await search('second')
    await flushPromises()
    if (outcome === 'success') retry.resolve([hit('Obsolete result')])
    else retry.reject(new ApiError(503, {}))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exact).toHaveBeenCalledTimes(3)
    expect(wrapper.get('.result').text()).toContain('Current result')
    expect(wrapper.text()).not.toContain('Obsolete result')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})


describe('search accessibility', () => {
  it('labels the query and exposes mode/scope state through keyboard toggles', async () => {
    const user = userEvent.setup()
    expect(wrapper.get('input.query').attributes('aria-label')).toBe('Search words or phrases')
    const modes = wrapper.findAll('button.mode')
    expect(modes.map((button) => button.attributes('aria-pressed'))).toEqual(['true', 'false'])
    ;(modes[1].element as HTMLElement).focus()
    await user.keyboard(' ')
    expect(modes.map((button) => button.attributes('aria-pressed'))).toEqual(['false', 'true'])
    const notesScope = wrapper.findAll('button.scope').at(-1)!
    ;(notesScope.element as HTMLElement).focus()
    await user.keyboard('{Enter}')
    expect(notesScope.attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('button.scope').slice(0, -1).every((button) => button.attributes('aria-pressed') === 'false')).toBe(true)
    expect(modes[0].attributes('aria-pressed')).toBe('true')
    expect(modes[1].attributes('disabled')).toBeDefined()
    ;(modes[1].element as HTMLElement).focus()
    await user.keyboard(' ')
    expect(modes[1].attributes('aria-pressed')).toBe('false')
  })

  it('keeps idle, loading, failure, and empty states mutually exclusive, including blank input', async () => {
    const pending = deferred<SearchHit[]>()
    const request = vi.spyOn(api, 'search').mockReturnValueOnce(pending.promise).mockResolvedValueOnce([])
    await search('   ')
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.find('.hint').exists()).toBe(true)
    await search('word')
    expect(wrapper.get('[role="status"]').text()).toBe('Searching…')
    expect(wrapper.find('.hint').exists()).toBe(false)
    pending.reject(new Error('Unavailable'))
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Unavailable')
    expect(wrapper.text()).not.toContain('No matches')
    expect(wrapper.find('.hint').exists()).toBe(false)
    await wrapper.get('input.query').trigger('keydown.enter')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No matches')
    expect(wrapper.find('.hint').exists()).toBe(false)
    await search('')
    expect(wrapper.find('.hint').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No matches')
  })

  it.each([null, new Error('')])('announces a useful error for an uninformative rejection (%s)', async (error) => {
    vi.spyOn(api, 'search').mockRejectedValueOnce(error)
    await search('word')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Search failed. Please try again.')
    expect(wrapper.text()).not.toContain('No matches')
  })

  it.each(['{Enter}', ' '])('opens scripture and journal results with %s', async (key) => {
    const user = userEvent.setup()
    vi.spyOn(api, 'search').mockResolvedValue([hit('In the beginning')])
    const open = vi.spyOn(useReader(), 'openRef').mockResolvedValue()
    useNotes().list = [{ id: 'note', title: 'beginning', body: '<script>unsafe</script>', refs: [], tags: [], createdAt: 1, updatedAt: 1 }]
    await search('beginning')
    await flushPromises()
    const results = wrapper.findAll('button.result')
    expect(results).toHaveLength(2)
    ;(results[0].element as HTMLElement).focus()
    await user.keyboard(key)
    expect(open).toHaveBeenCalledWith('WEB', 'John', 1, 1)
    ;(results[1].element as HTMLElement).focus()
    await user.keyboard(key)
    await flushPromises()
    expect(useNotes().currentId).toBe('note')
    expect(useUi().screen).toBe('journal')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('.hint').exists()).toBe(false)
  })

  it('opens a named ancient-writing dialog from the keyboard and returns focus after close', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'search').mockResolvedValue([
      { kind: 'general-book', module: 'Ancient', key: 'Entry', title: 'Entry <script>', content: '<script>unsafe</script>' }
    ])
    await search('entry')
    await flushPromises()
    const result = wrapper.get('button.result').element as HTMLElement
    result.focus()
    await user.keyboard('{Enter}')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Entry <script>')
    expect(dialog.querySelector('script')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close')
    await user.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close')
    await user.keyboard('{Escape}')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(result)
    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(result)
  })
})
