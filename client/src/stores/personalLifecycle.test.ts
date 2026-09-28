import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api, type Note, type SemanticIndexStatus } from '../services/api'
import { useAiProvider } from './aiProvider'
import { useTtsProvider } from './ttsProvider'
import { useSttProvider } from './sttProvider'
import { useSemanticIndex } from './semanticIndex'
import { useNotes } from './notes'
import { useReader } from './reader'
import { useLibrary } from './library'
import { pathologicalModule } from '../test/fixtures/moduleInfo'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const chatConfig = { kind: 'local' as const, baseUrl: 'https://provider.invalid/v1', model: 'test', hasApiKey: false }
const voiceConfig = { order: ['browser' as const], local: null, cloud: null, remoteAudioCacheSize: 4 }
const embeddingConfig = { ...chatConfig, batchSize: 16 }
const status: SemanticIndexStatus = {
  state: 'ready', chunkCount: 12, modules: ['WEB'], model: 'test', updatedAt: 1, lastError: null
}
const note: Note = { id: 'note', title: 'Title', body: 'Body', tags: [], refs: [], createdAt: 1, updatedAt: 1 }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.restoreAllMocks()
  useNotes().resetPersonalData()
})
afterEach(() => useNotes().resetPersonalData())

describe('personal request lifecycle', () => {
  for (const [label, useStore, loadMethod, saveMethod, input] of [
    ['chat', useAiProvider, 'aiProvider', 'saveAiProvider', chatConfig],
    ['speech', useTtsProvider, 'ttsConfig', 'saveTtsConfig', voiceConfig],
    ['transcription', useSttProvider, 'sttConfig', 'saveSttConfig', voiceConfig]
  ] as const) {
    for (const operation of ['load', 'save'] as const) {
      it.each(['success', 'failure'])(`${label} ${operation} ignores late %s without finishing a newer request`, async (outcome) => {
        const old = deferred<never>()
        const current = deferred<never>()
        const method = operation === 'load' ? loadMethod : saveMethod
        const mock = vi.spyOn(api, method).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
        const store = useStore()
        const run = () => operation === 'load' ? store.load() : store.save(input as never)
        const pending = run()
        store.reset()
        const active = run()
        const snapshot = JSON.stringify(store.$state)
        if (outcome === 'success') old.resolve(input as never)
        else old.reject(new Error('obsolete error'))
        await pending
        expect(JSON.stringify(store.$state)).toBe(snapshot)
        current.resolve(input as never)
        await active
        expect(store.loading).toBe(false)
        expect(store.ready).toBe(true)
        expect(store.error).toBeNull()
        expect(mock).toHaveBeenCalledTimes(2)
      })
    }
  }

  it('does not let a late provider removal clear a newer configuration', async () => {
    const old = deferred<void>()
    vi.spyOn(api, 'removeAiProvider').mockReturnValue(old.promise)
    const store = useAiProvider()
    const pending = store.remove()
    store.reset()
    store.provider = { ...chatConfig, model: 'current' }
    store.loading = true
    old.resolve()
    await pending
    expect(store.provider?.model).toBe('current')
    expect(store.loading).toBe(true)
  })

  it.each(['success', 'failure'])('ignores a late note creation %s', async (outcome) => {
    const old = deferred<Note>()
    vi.spyOn(api, 'createNote').mockReturnValue(old.promise)
    const notes = useNotes()
    const pending = notes.create()
    notes.resetPersonalData()
    notes.list = [{ ...note, id: 'current-note' }]
    notes.currentId = 'current-note'
    if (outcome === 'success') old.resolve(note)
    else old.reject(new Error('obsolete error'))
    await pending
    expect(notes.list.map((item) => item.id)).toEqual(['current-note'])
    expect(notes.currentId).toBe('current-note')
    expect(notes.error).toBeNull()
  })

  it('does not remove a current note after an obsolete deletion finishes', async () => {
    const old = deferred<void>()
    vi.spyOn(api, 'deleteNote').mockReturnValue(old.promise)
    const notes = useNotes()
    notes.list = [note]
    const pending = notes.remove(note.id)
    notes.resetPersonalData()
    notes.list = [note]
    notes.currentId = note.id
    notes.saving = true
    old.resolve()
    await pending
    expect(notes.list).toEqual([note])
    expect(notes.currentId).toBe(note.id)
    expect(notes.saving).toBe(true)
  })

  it.each(['success', 'failure'])('ignores late highlight mutation %s without starting recovery', async (outcome) => {
    const old = deferred<void>()
    vi.spyOn(api, 'updateHighlights').mockReturnValue(old.promise)
    const reload = vi.spyOn(api, 'highlights')
    const reader = useReader()
    reader.activateUser('first')
    reader.moduleName = 'WEB'
    reader.book = 'John'
    const pending = reader.toggleHighlightRange([1])
    reader.activateUser('current')
    reader.highlights = { 'WEB/Gen/1/1': 'current' }
    if (outcome === 'success') old.resolve()
    else old.reject(new Error('obsolete error'))
    await pending
    expect(reader.highlights).toEqual({ 'WEB/Gen/1/1': 'current' })
    expect(reader.highlightError).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('cancels a rebuild and ignores its late progress and completion', async () => {
    const old = deferred<SemanticIndexStatus>()
    let progress!: Parameters<typeof api.rebuildSemanticIndex>[0]
    let signal: AbortSignal | undefined
    vi.spyOn(api, 'rebuildSemanticIndex').mockImplementation((callback, suppliedSignal) => {
      progress = callback; signal = suppliedSignal; return old.promise
    })
    const store = useSemanticIndex()
    const pending = store.rebuild()
    store.reset()
    store.building = true
    store.currentModule = 'current'
    progress({ module: 'obsolete', processed: 100, batchSize: 32 })
    old.resolve(status)
    await pending
    expect(signal?.aborted).toBe(true)
    expect(store.currentModule).toBe('current')
    expect(store.processed).toBe(0)
    expect(store.status.state).toBe('unconfigured')
    expect(store.building).toBe(true)
  })

  it('guards each await in embedding configuration and failure recovery', async () => {
    const oldStatus = deferred<SemanticIndexStatus>()
    vi.spyOn(api, 'saveEmbeddingProvider').mockResolvedValue(embeddingConfig)
    vi.spyOn(api, 'semanticIndexStatus').mockReturnValue(oldStatus.promise)
    const store = useSemanticIndex()
    const pending = store.save(embeddingConfig)
    await vi.waitFor(() => expect(api.semanticIndexStatus).toHaveBeenCalledOnce())
    store.reset()
    store.status = { ...status, modules: ['current'] }
    store.loading = true
    oldStatus.resolve(status)
    await pending
    expect(store.status.modules).toEqual(['current'])
    expect(store.loading).toBe(true)
  })

  it.each(['load', 'save', 'remove'] as const)('discards embedding %s completion after reset', async (operation) => {
    const old = deferred<never>()
    vi.spyOn(api, 'embeddingProvider').mockReturnValue(old.promise)
    vi.spyOn(api, 'saveEmbeddingProvider').mockReturnValue(old.promise)
    vi.spyOn(api, 'removeEmbeddingProvider').mockReturnValue(old.promise)
    vi.spyOn(api, 'semanticIndexStatus').mockResolvedValue(status)
    const store = useSemanticIndex()
    const pending = operation === 'save' ? store.save(embeddingConfig) : store[operation]()
    store.reset()
    store.provider = { ...embeddingConfig, model: 'current' }
    store.status = { ...status, modules: ['current'] }
    store.loading = true
    old.resolve(embeddingConfig as never)
    await pending
    expect(store.provider.model).toBe('current')
    expect(store.status.modules).toEqual(['current'])
    expect(store.loading).toBe(true)
  })

  it('guards a rebuild status refresh pending during reset', async () => {
    const old = deferred<SemanticIndexStatus>()
    vi.spyOn(api, 'rebuildSemanticIndex').mockRejectedValue(new Error('rebuild failed'))
    vi.spyOn(api, 'semanticIndexStatus').mockReturnValue(old.promise)
    const store = useSemanticIndex()
    const pending = store.rebuild()
    await vi.waitFor(() => expect(api.semanticIndexStatus).toHaveBeenCalledOnce())
    store.reset()
    store.status = { ...status, modules: ['current'] }
    store.building = true
    old.resolve(status)
    await pending
    expect(store.status.modules).toEqual(['current'])
    expect(store.error).toBeNull()
    expect(store.building).toBe(true)
  })

  it('resets library preferences and discards a pending catalog preference response', async () => {
    const old = deferred<Record<string, boolean>>()
    vi.spyOn(api, 'catalog').mockResolvedValue({
      modules: [pathologicalModule], diagnostics: { repositories: [], usedCachedCatalog: false, refreshedAt: 1 }
    })
    vi.spyOn(api, 'corpusPreferences').mockReturnValue(old.promise)
    const library = useLibrary()
    library.preferences = { obsolete: true }
    const pending = library.load()
    library.resetPersonalData()
    library.loading = true
    expect(library.preferences).toEqual({})
    old.resolve({ obsolete: true })
    await pending
    expect(library.preferences).toEqual({})
    expect(library.loading).toBe(true)
  })

  it('does not apply an obsolete corpus preference mutation', async () => {
    const old = deferred<void>()
    vi.spyOn(api, 'setCorpusPreference').mockReturnValue(old.promise)
    const library = useLibrary()
    const pending = library.setAiEnabled(pathologicalModule, true)
    library.resetPersonalData()
    old.resolve()
    await pending
    expect(library.preferences).toEqual({})
  })
})
