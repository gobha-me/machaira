// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import ReadScreen from './screens/ReadScreen.vue'
import { api } from './services/api'
import { readingPlanDb } from './services/db'
import { useAuth } from './stores/auth'
import { useNotes } from './stores/notes'
import { pathologicalModule } from './test/fixtures/moduleInfo'

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

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
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
})

async function startApp() {
  wrapper = mount(App, { global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function expectRead(app: VueWrapper) {
  expect(app.findComponent(ReadScreen).exists()).toBe(true)
  expect(app.get('.read h1').text()).toBe('Genesis 1')
  expect(app.find('.personal-error-page').exists()).toBe(false)
  expect(app.find('.loading-page').exists()).toBe(false)
}

describe('startup failure isolation', () => {
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
