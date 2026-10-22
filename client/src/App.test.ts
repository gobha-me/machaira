// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import ReadScreen from './screens/ReadScreen.vue'
import { api, type ChapterPayload } from './services/api'
import { readingPlanDb } from './services/db'
import { useAuth } from './stores/auth'
import { useNotes } from './stores/notes'
import { useSettings } from './stores/settings'
import { pathologicalModule } from './test/fixtures/moduleInfo'
import { createAppRouter } from './router'
import { createMemoryHistory, createWebHashHistory, type Router, type RouterHistory } from 'vue-router'
import { useReader } from './stores/reader'
import SearchScreen from './screens/SearchScreen.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const user = { id: 'reader', username: 'Reader', role: 'member' as const }
const optionalLoads = [
  ['Notes', () => vi.mocked(api.notes)],
  ['Highlights', () => vi.mocked(api.highlights)],
  ['Reading plan', () => vi.mocked(readingPlanDb.get)],
  ['Study partner', () => vi.mocked(api.aiProvider)],
  ['Meaning search', () => vi.mocked(api.embeddingProvider)],
  ['Meaning search', () => vi.mocked(api.semanticIndexStatus)],
  ['Read aloud', () => vi.mocked(api.ttsConfig)],
  ['Voice input', () => vi.mocked(api.sttConfig)],
  ['Chat history', () => vi.mocked(api.chatConversations)]
] as const

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
let router: Router

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  pinia = createPinia()
  setActivePinia(pinia)
  useNotes().resetPersonalData()
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))
  vi.spyOn(api, 'authStatus').mockResolvedValue({ state: 'authenticated', user })
  vi.spyOn(api, 'catalog').mockResolvedValue({
    modules: [{ ...pathologicalModule, id: 'WEB', name: 'WEB', installed: true }],
    diagnostics: { repositories: [], usedCachedCatalog: false, refreshedAt: 1 }
  })
  vi.spyOn(api, 'corpusPreferences').mockResolvedValue({})
  vi.spyOn(api, 'readingCursor').mockResolvedValue(null)
  vi.spyOn(api, 'preferences').mockResolvedValue(null)
  vi.spyOn(api, 'saveReadingCursor').mockImplementation(async (value) => value)
  vi.spyOn(api, 'books').mockResolvedValue([{ code: 'Gen', name: 'Genesis', section: 'ot', chapters: 50 }])
  vi.spyOn(api, 'chapter').mockResolvedValue({ module: 'WEB', book: 'Gen', bookName: 'Genesis', chapter: 1, verses: [] })
  vi.spyOn(api, 'notes').mockResolvedValue([])
  vi.spyOn(api, 'highlights').mockResolvedValue([])
  vi.spyOn(readingPlanDb, 'get').mockResolvedValue(undefined)
  vi.spyOn(api, 'aiProvider').mockResolvedValue(null)
  vi.spyOn(api, 'embeddingProvider').mockResolvedValue(null)
  vi.spyOn(api, 'semanticIndexStatus').mockResolvedValue({
    state: 'unconfigured', chunkCount: 0, modules: [], model: null, updatedAt: null, lastError: null
  })
  vi.spyOn(api, 'ttsConfig').mockResolvedValue({ order: ['browser'], local: null, cloud: null, remoteAudioCacheSize: 4 })
  vi.spyOn(api, 'sttConfig').mockResolvedValue({ order: ['browser'], local: null, cloud: null })
  vi.spyOn(api, 'chatConversations').mockResolvedValue([])
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  useNotes().resetPersonalData()
  useReader().activateUser(null)
  useSettings().activateUser(null)
  router?.options.history.destroy()
})

async function startApp(path = '/read', history: RouterHistory = createMemoryHistory()) {
  router = createAppRouter(history)
  await router.push(path)
  wrapper = mount(App, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

function passage(chapter: number, module = 'WEB'): ChapterPayload {
  return {
    module, book: 'Gen', bookName: 'Genesis', chapter,
    verses: [1, 2, 3].map((n) => ({ n, text: '', notes: [], segments: [], crossReferences: [] }))
  }
}

async function navigate(app: VueWrapper, label: string) {
  await app.findAll('.rail-btn').find((button) => button.text() === label)!.trigger('click')
  await flushPromises()
}

describe('hash navigation and passage URLs', () => {
  beforeEach(() => {
    vi.mocked(api.chapter).mockImplementation(async (module, _book, chapter) => passage(chapter, module))
  })

  it('opens a hash deep link after a slow newer server cursor instead of displaying or saving that cursor', async () => {
    const saved = deferred<Awaited<ReturnType<typeof api.readingCursor>>>()
    vi.mocked(api.readingCursor).mockReturnValueOnce(saved.promise)
    localStorage.setItem('sword.reader.pos.v2:reader', JSON.stringify({ moduleName: 'WEB', book: 'Gen', chapter: 3, updated_at: 10 }))
    window.history.replaceState(null, '', '/#/read/WEB/Gen/2/1-3')
    const history = createWebHashHistory()
    router = createAppRouter(history)
    wrapper = mount(App, { global: { plugins: [pinia, router] } })
    await flushPromises()
    expect(api.chapter).not.toHaveBeenCalled()
    saved.resolve({ moduleName: 'WEB', book: 'Gen', chapter: 4, updated_at: Date.now() + 1000 })
    await flushPromises()

    expect(wrapper.get('.read h1').text()).toBe('Genesis 2')
    expect(useReader().selectedVerses).toEqual([1, 2, 3])
    expect(api.chapter).toHaveBeenCalledExactlyOnceWith('WEB', 'Gen', 2)
    expect(JSON.parse(localStorage.getItem('sword.reader.pos.v2:reader')!).chapter).toBe(2)
    expect(window.location.hash).toBe('#/read/WEB/Gen/2/1-3')
    expect(window.location.pathname).toBe('/')
  })

  it('restores the saved cursor when there is no explicit passage', async () => {
    vi.mocked(api.readingCursor).mockResolvedValue({ moduleName: 'WEB', book: 'Gen', chapter: 4, updated_at: 10 })
    const app = await startApp('/')
    expect(app.get('.read h1').text()).toBe('Genesis 4')
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/4')
  })

  it('lets an explicit translation and verse win over a different saved translation', async () => {
    vi.mocked(api.catalog).mockResolvedValue({
      modules: ['WEB', 'KJV'].map((name) => ({ ...pathologicalModule, id: name, name, installed: true })),
      diagnostics: { repositories: [], usedCachedCatalog: false, refreshedAt: 1 }
    })
    vi.mocked(api.readingCursor).mockResolvedValue({ moduleName: 'WEB', book: 'Gen', chapter: 4, updated_at: 10 })
    const app = await startApp('/read/KJV/Gen/2/3')
    expect(app.get('.read h1').text()).toBe('Genesis 2')
    expect(useReader().moduleName).toBe('KJV')
    expect(useReader().selectedVerse).toBe(3)
    expect(api.books).toHaveBeenCalledExactlyOnceWith('KJV')
    expect(api.chapter).toHaveBeenCalledExactlyOnceWith('KJV', 'Gen', 2)
    expect(router.currentRoute.value.path).toBe('/read/KJV/Gen/2/3')
  })

  it.each(['books', 'chapter'] as const)('uses the saved passage if a deep link %s request fails at startup', async (method) => {
    vi.mocked(api.readingCursor).mockResolvedValue({ moduleName: 'WEB', book: 'Gen', chapter: 4, updated_at: 10 })
    vi.mocked(api[method]).mockRejectedValueOnce(new Error('Linked passage offline'))
    const app = await startApp('/read/WEB/Gen/2/3')
    expect(app.get('.read h1').text()).toBe('Genesis 4')
    expect(app.find('.personal-error-page').exists()).toBe(false)
    expect(useReader().selectedVerse).toBeNull()
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/4')
    expect(JSON.parse(localStorage.getItem('sword.reader.pos.v2:reader')!).chapter).toBe(4)
  })

  it('rejects a verse range with a missing interior verse even when both endpoints exist', async () => {
    vi.mocked(api.chapter).mockImplementation(async (_module, _book, chapter) => {
      const data = passage(chapter)
      if (chapter === 2) data.verses = data.verses.filter((verse) => verse.n !== 2)
      return data
    })
    const app = await startApp('/read/WEB/Gen/2/1-3')
    expectRead(app)
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/1')
    expect(useReader().selectedVerse).toBeNull()
  })

  it('falls back from a direct Plan link when the reading plan is disabled', async () => {
    const app = await startApp('/plan')
    expectRead(app)
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/1')
    expect(app.findAll('.rail-btn').some((button) => button.text() === 'Plan')).toBe(false)
  })

  it.each([
    '/unknown', '/read/WEB', '/read/WEB/Gen', '/read/WEB/Gen/0', '/read/WEB/Gen/-1',
    '/read/WEB/Gen/1.5', '/read/WEB/Gen/1e2', '/read/WEB/Gen/9007199254740992',
    '/read/WEB/Gen/1/0', '/read/WEB/Gen/1/3-1', '/read/WEB/Gen/1/1/extra',
    '/read/WEB%2Fother/Gen/1', '/read/WEB/Gen%2Fother/1', '/read/WEB/Gen/1/%ZZ',
    '/read/MISSING/Gen/1', '/read/WEB/Unknown/1', '/read/WEB/Gen/51',
    '/read/WEB/Gen/1/4', '/read/WEB/Gen/1/1-9007199254740991'
  ])('falls back safely for invalid or unavailable route %s', async (path) => {
    const app = await startApp(path)
    expectRead(app)
    expect(useReader().selectedVerse).toBeNull()
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/1')
    expect(vi.mocked(api.chapter).mock.calls.every(([module, book, chapter]) =>
      module === 'WEB' && book === 'Gen' && chapter >= 1 && chapter <= 50)).toBe(true)
  })

  it('replaces an unavailable link with the saved passage instead of persisting invalid input', async () => {
    vi.mocked(api.readingCursor).mockResolvedValue({ moduleName: 'WEB', book: 'Gen', chapter: 4, updated_at: 10 })
    const app = await startApp('/read/WEB/Gen/51')
    expect(app.get('.read h1').text()).toBe('Genesis 4')
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/4')
    expect(api.chapter).toHaveBeenCalledExactlyOnceWith('WEB', 'Gen', 4)
  })

  it('returns Back and Forward through screens and chapter changes without extra history entries', async () => {
    const app = await startApp('/read', createWebHashHistory())
    await navigate(app, 'Search')
    await navigate(app, 'Read')
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/1')
    await useReader().setChapter(2)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/2')
    useReader().selectVerse(2)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/2/2')
    window.history.back()
    await vi.waitFor(() => expect(app.get('.read h1').text()).toBe('Genesis 1'))
    window.history.back()
    await vi.waitFor(() => expect(app.findComponent(SearchScreen).exists()).toBe(true))
    expect(router.currentRoute.value.path).toBe('/search')
    window.history.forward()
    await vi.waitFor(() => expect(app.get('.read h1').text()).toBe('Genesis 1'))
    window.history.forward()
    await vi.waitFor(() => expect(useReader().selectedVerse).toBe(2))
    expect(app.get('.read h1').text()).toBe('Genesis 2')
    expect(window.location.hash).toBe('#/read/WEB/Gen/2/2')
    expect(window.location.pathname).toBe('/')
  })

  it.each(['success', 'failure'] as const)('keeps Search query, scope, mode and pending %s across navigation', async (outcome) => {
    vi.mocked(api.semanticIndexStatus).mockResolvedValue({
      state: 'ready', chunkCount: 1, modules: ['WEB'], model: 'configured-model', updatedAt: 1, lastError: null
    })
    const pending = deferred<Awaited<ReturnType<typeof api.semanticSearch>>>()
    vi.spyOn(api, 'semanticSearch').mockReturnValueOnce(pending.promise)
    const app = await startApp('/search')
    await app.findAll('button.scope').find((button) => button.text() === 'Scripture')!.trigger('click')
    await app.findAll('button.mode')[1].trigger('click')
    await app.get('input.query').setValue('beginning')
    await app.get('input.query').trigger('keydown.enter')
    await navigate(app, 'Read')
    if (outcome === 'success') pending.resolve([
      { kind: 'scripture', module: 'WEB', book: 'Gen', bookName: 'Genesis', chapter: 1, verse: 1, content: '', distance: 0 }
    ])
    else pending.reject(new Error('Search offline'))
    router.back()
    await flushPromises()
    expect((app.get('input.query').element as HTMLInputElement).value).toBe('beginning')
    expect(app.get('button.mode.active').text()).toBe('By meaning')
    expect(api.semanticSearch).toHaveBeenCalledExactlyOnceWith('beginning', ['WEB'], 50, 'scripture')
    if (outcome === 'success') expect(app.get('.result').text()).toContain('Genesis 1:1')
    else expect(app.get('.error').text()).toBe('Search offline')
    await navigate(app, 'Library')
    await navigate(app, 'Search')
    expect((app.get('input.query').element as HTMLInputElement).value).toBe('beginning')
    expect(api.semanticSearch).toHaveBeenCalledOnce()
  })

  it('opens a search hit as a verse URL and preserves completed results on Back', async () => {
    vi.spyOn(api, 'search').mockResolvedValue([
      { kind: 'scripture', module: 'WEB', book: 'Gen', bookName: 'Genesis', chapter: 2, verse: 3, content: '' }
    ])
    const app = await startApp('/search')
    await app.get('input.query').setValue('beginning')
    await app.get('input.query').trigger('keydown.enter')
    await flushPromises()
    await app.get('.result').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/2/3')
    router.back()
    await flushPromises()
    expect(app.get('.result').text()).toContain('Genesis 2:3')
    expect((app.get('input.query').element as HTMLInputElement).value).toBe('beginning')
    expect(api.search).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'] as const)('ignores a late passage %s after leaving its route', async (outcome) => {
    const app = await startApp()
    const pending = deferred<ChapterPayload>()
    vi.mocked(api.chapter).mockReturnValueOnce(pending.promise)
    await router.push('/read/WEB/Gen/2')
    await navigate(app, 'Search')
    if (outcome === 'success') pending.resolve(passage(2))
    else pending.reject(new Error('Offline'))
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/search')
    expect(useReader().chapter).toBe(1)
    expect(app.findComponent(SearchScreen).exists()).toBe(true)
    expect(app.text()).not.toContain('passage link is not available')
  })

  it.each(['success', 'failure'] as const)('keeps a newer passage when an earlier link has a late %s', async (outcome) => {
    const app = await startApp()
    const pending = deferred<ChapterPayload>()
    vi.mocked(api.chapter).mockReturnValueOnce(pending.promise)
    await router.push('/read/WEB/Gen/2')
    await router.push('/read/WEB/Gen/3/1-3')
    await flushPromises()
    if (outcome === 'success') pending.resolve(passage(2))
    else pending.reject(new Error('Obsolete failure'))
    await flushPromises()
    expect(app.get('.read h1').text()).toBe('Genesis 3')
    expect(useReader().selectedVerses).toEqual([1, 2, 3])
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/3/1-3')
    expect(app.text()).not.toContain('passage link is not available')
    expect(JSON.parse(localStorage.getItem('sword.reader.pos.v2:reader')!).chapter).toBe(3)
  })

  it('keeps the current passage and reports failure when a linked chapter request fails', async () => {
    const app = await startApp()
    vi.mocked(api.chapter).mockRejectedValueOnce(new Error('Offline'))
    await router.push('/read/WEB/Gen/2')
    await flushPromises()
    expectRead(app)
    expect(router.currentRoute.value.path).toBe('/read/WEB/Gen/1')
    expect(app.text()).toContain('This passage link is not available in your library.')
    expect(JSON.parse(localStorage.getItem('sword.reader.pos.v2:reader')!).chapter).toBe(1)
  })

  it('discards cached Search state and pending results when accounts change', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.search>>>()
    vi.spyOn(api, 'search').mockReturnValueOnce(pending.promise)
    const app = await startApp('/search')
    await app.get('input.query').setValue('private query')
    await app.get('input.query').trigger('keydown.enter')
    await navigate(app, 'Read')
    useAuth().user = { ...user, id: 'other-reader' }
    await flushPromises()
    pending.resolve([{ kind: 'scripture', module: 'WEB', book: 'Gen', bookName: 'Genesis', chapter: 1, verse: 1, content: '' }])
    await navigate(app, 'Search')
    expect((app.get('input.query').element as HTMLInputElement).value).toBe('')
    expect(app.find('.result').exists()).toBe(false)
  })
})

function expectRead(app: VueWrapper) {
  expect(app.findComponent(ReadScreen).exists()).toBe(true)
  expect(app.get('.read h1').text()).toBe('Genesis 1')
  expect(app.find('.personal-error-page').exists()).toBe(false)
  expect(app.find('.loading-page').exists()).toBe(false)
}

describe('startup failure isolation', () => {
  it('renders passage note creation failures without losing the composer input', async () => {
    vi.spyOn(api, 'createNote').mockRejectedValue(new Error('Note creation unavailable'))
    const app = await startApp()
    await app.get('.note-title-input').setValue('Keep the title')
    await app.get('.note-input').setValue('Keep the body')
    await app.get('.note-save').trigger('click')
    await flushPromises()
    expect(app.get('[role="alert"]').text()).toContain('Note creation unavailable')
    expect(app.get('.note-input').element).toHaveProperty('value', 'Keep the body')
    expect(app.find('.note-saved').exists()).toBe(false)
  })

  it('flushes drafts on hidden/pagehide and removes lifecycle listeners on unmount', async () => {
    const app = await startApp()
    const notes = useNotes()
    const flush = vi.spyOn(notes, 'flushPending')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(flush).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(2)
    expect(notes.userId).toBe(user.id)
    app.unmount()
    wrapper = undefined
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('keeps failed pagehide drafts while reconnecting account sync and removes the reconnect listener', async () => {
    const note = { id: 'draft', title: 'Draft', body: 'Original', tags: [], refs: [], createdAt: 1, updatedAt: 1 }
    vi.mocked(api.notes).mockResolvedValueOnce([note])
    vi.spyOn(api, 'updateNote').mockRejectedValue(new Error('Pagehide save interrupted'))
    const preferences = vi.spyOn(api, 'preferences').mockRejectedValueOnce(new Error('Preferences offline'))
      .mockResolvedValue({ preferences: { extraSpacing: true }, updated_at: Date.now() + 1000 })
    const cursor = vi.spyOn(api, 'readingCursor').mockRejectedValueOnce(new Error('Cursor offline'))
      .mockResolvedValue(null)
    const app = await startApp()
    expectRead(app)

    const notes = useNotes()
    notes.save({ body: 'Keep my unsynced edit' })
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(api.updateNote).toHaveBeenCalledWith(note.id, expect.objectContaining({ body: 'Keep my unsynced edit' }), true)
    expect(notes.saveError).toBe('Pagehide save interrupted')

    window.dispatchEvent(new Event('online'))
    await flushPromises()
    expect(preferences).toHaveBeenCalledTimes(2)
    expect(cursor).toHaveBeenCalledTimes(2)
    expect(useSettings().extraSpacing).toBe(true)
    expect(notes.current?.body).toBe('Keep my unsynced edit')
    expect(localStorage.getItem(`machaira:note-drafts:${user.id}`)).toContain('Keep my unsynced edit')
    expectRead(app)

    app.unmount()
    wrapper = undefined
    window.dispatchEvent(new Event('online'))
    await flushPromises()
    expect(preferences).toHaveBeenCalledTimes(2)
    expect(cursor).toHaveBeenCalledTimes(2)
  })

  for (const [label, getMock] of optionalLoads) {
    it(`keeps Read usable when ${label} fails and retries only that feature (${getMock().name})`, async () => {
      const request = getMock()
      request.mockRejectedValueOnce(new Error('Service offline'))
      const app = await startApp()

      expectRead(app)
      expect(app.findAll('.feature-error')).toHaveLength(1)
      expect(app.get('[role="status"]').text()).toContain(`${label} unavailable: Service offline`)
      expect(api.chapter).toHaveBeenCalledOnce()

      await app.get('.feature-error button').trigger('click')
      await flushPromises()

      expectRead(app)
      expect(app.find('.feature-errors').exists()).toBe(false)
      expect(request).toHaveBeenCalledTimes(2)
      expect(api.catalog).toHaveBeenCalledOnce()
      expect(api.books).toHaveBeenCalledOnce()
      expect(api.chapter).toHaveBeenCalledOnce()
      for (const [otherLabel, otherMock] of optionalLoads) {
        if (otherLabel !== label) expect(otherMock()).toHaveBeenCalledOnce()
      }
    })

    it(`opens Read while ${label} is still pending (${getMock().name})`, async () => {
      const pending = deferred<never>()
      getMock().mockReturnValueOnce(pending.promise)
      const app = await startApp()

      expectRead(app)
      pending.reject(new Error('Late failure'))
      await flushPromises()

      expectRead(app)
      expect(app.get('.feature-error').text()).toContain(`${label} unavailable: Late failure`)
    })
  }

  it('shows individual failures without waiting for another optional request to finish', async () => {
    const pending = deferred<never>()
    vi.mocked(api.notes).mockReturnValueOnce(pending.promise)
    vi.mocked(api.highlights).mockRejectedValueOnce(new Error('Highlights offline'))
    vi.mocked(readingPlanDb.get).mockRejectedValueOnce(null)
    const app = await startApp()

    expectRead(app)
    expect(app.findAll('.feature-error')).toHaveLength(2)
    expect(app.text()).toContain('Highlights unavailable: Highlights offline')
    expect(app.text()).toContain('Reading plan unavailable: Could not load this feature.')

    pending.reject(new Error('Notes offline'))
    await flushPromises()
    expect(app.findAll('.feature-error')).toHaveLength(3)
    expectRead(app)
  })

  it('keeps the warning and disables duplicate retries until a failed retry settles', async () => {
    const retry = deferred<never>()
    vi.mocked(api.notes).mockRejectedValueOnce(new Error('Offline')).mockReturnValueOnce(retry.promise)
    const app = await startApp()
    await app.get('.feature-error button').trigger('click')

    expectRead(app)
    expect(app.get('.feature-error button').attributes('disabled')).toBeDefined()
    expect(app.get('.feature-error button').text()).toBe('Retrying…')
    await app.get('.feature-error button').trigger('click')
    expect(api.notes).toHaveBeenCalledTimes(2)

    retry.reject(new Error('Still offline'))
    await flushPromises()
    expect(app.get('.feature-error').text()).toContain('Still offline')
    expect(app.get('.feature-error button').attributes('disabled')).toBeUndefined()
    expectRead(app)
  })

  for (const method of ['catalog', 'corpusPreferences', 'books', 'chapter'] as const) {
    it(`blocks startup and recovers via retry when essential ${method} fails`, async () => {
      vi.mocked(api[method]).mockRejectedValueOnce(new Error('Reader offline'))
      const app = await startApp()

      expect(app.findComponent(ReadScreen).exists()).toBe(false)
      expect(app.get('.personal-error-page').text()).toContain('Reader offline')
      expect(api.notes).not.toHaveBeenCalled()

      await app.get('.personal-error-card button').trigger('click')
      await flushPromises()

      expectRead(app)
      expect(app.find('.feature-errors').exists()).toBe(false)
    })
  }

  it('offers retry for a failed session lookup without loading account data', async () => {
    vi.mocked(api.authStatus).mockRejectedValueOnce(new Error('Session offline'))
    const app = await startApp()

    expect(app.get('.personal-error-page').text()).toContain('Couldn’t load your session')
    expect(app.text()).toContain('Session offline')
    expect(app.findComponent(ReadScreen).exists()).toBe(false)
    expect(api.catalog).not.toHaveBeenCalled()

    await app.get('.personal-error-card button').trigger('click')
    await flushPromises()
    expectRead(app)
  })

  it('preserves the Read empty state when the library has no installed translations', async () => {
    vi.mocked(api.catalog).mockResolvedValueOnce({
      modules: [], diagnostics: { repositories: [], usedCachedCatalog: false, refreshedAt: 1 }
    })
    vi.mocked(api.notes).mockRejectedValueOnce(new Error('Offline'))
    const app = await startApp()

    expect(app.findComponent(ReadScreen).exists()).toBe(true)
    expect(app.text()).toContain('No translations yet')
    expect(app.text()).toContain('Notes unavailable: Offline')
    expect(app.find('.personal-error-page').exists()).toBe(false)
    expect(api.books).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'])('discards optional %s after switching accounts', async (outcome) => {
    const old = deferred<Awaited<ReturnType<typeof api.notes>>>()
    vi.mocked(api.notes).mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('Current failure'))
    const app = await startApp()
    useAuth().user = { ...user, id: 'current' }
    await flushPromises()
    expectRead(app)
    expect(app.get('.feature-error').text()).toContain('Current failure')

    if (outcome === 'success') old.resolve([])
    else old.reject(new Error('Obsolete failure'))
    await flushPromises()

    expectRead(app)
    expect(app.findAll('.feature-error')).toHaveLength(1)
    expect(app.get('.feature-error').text()).toContain('Current failure')
    expect(app.text()).not.toContain('Obsolete failure')
  })

  it('does not open Read for an obsolete essential load after sign-out', async () => {
    const old = deferred<Awaited<ReturnType<typeof api.catalog>>>()
    vi.mocked(api.catalog).mockReturnValueOnce(old.promise)
    const app = await startApp()
    expect(app.find('.loading-page').exists()).toBe(true)
    useAuth().user = null
    useAuth().state = 'anonymous'
    old.reject(new Error('Obsolete failure'))
    await flushPromises()

    expect(app.find('.auth-page').exists()).toBe(true)
    expect(app.findComponent(ReadScreen).exists()).toBe(false)
    expect(app.find('.personal-error-page').exists()).toBe(false)
    expect(api.notes).not.toHaveBeenCalled()
  })
})
