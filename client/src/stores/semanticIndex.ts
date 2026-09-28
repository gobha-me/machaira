import { defineStore } from 'pinia'
import {
  api,
  type EmbeddingProviderConfig,
  type EmbeddingProviderKind,
  type SemanticIndexStatus
} from '../services/api'

const EMPTY_STATUS: SemanticIndexStatus = {
  state: 'unconfigured',
  chunkCount: 0,
  modules: [],
  model: null,
  updatedAt: null,
  lastError: null
}

const rebuilds = new WeakMap<object, AbortController>()

export const useSemanticIndex = defineStore('semanticIndex', {
  state: () => ({
    generation: 0,
    provider: null as EmbeddingProviderConfig | null,
    status: { ...EMPTY_STATUS } as SemanticIndexStatus,
    loading: false,
    building: false,
    processed: 0,
    currentModule: '',
    effectiveBatchSize: 0,
    error: null as string | null
  }),
  getters: {
    searchable: (state): boolean => state.status.state === 'ready',
    statusText: (state): string => {
      if (state.building) {
        const batch = state.effectiveBatchSize ? ` · up to ${state.effectiveBatchSize}/request` : ''
        return `Indexing ${state.currentModule || 'library'} · ${state.processed.toLocaleString()} verses${batch}`
      }
      switch (state.status.state) {
        case 'ready': return `${state.status.chunkCount.toLocaleString()} verses across ${state.status.modules.length} module${state.status.modules.length === 1 ? '' : 's'}`
        case 'stale': return `${state.status.chunkCount.toLocaleString()} indexed verses · rebuild required`
        case 'failed': return state.status.lastError ?? 'The last rebuild failed'
        case 'empty': return 'No semantic index has been built'
        case 'unconfigured': return 'Configure an embedding provider to enable meaning-based search'
        case 'building': return 'Index rebuild in progress'
      }
    }
  },
  actions: {
    async load(): Promise<void> {
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        const [provider, status] = await Promise.all([
          api.embeddingProvider(),
          api.semanticIndexStatus()
        ])
        if (generation !== this.generation) return
        this.provider = provider
        this.effectiveBatchSize = provider?.batchSize ?? 0
        this.status = status
      } catch (error) {
        if (generation !== this.generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (generation === this.generation) this.loading = false
      }
    },
    async save(input: {
      kind: EmbeddingProviderKind
      baseUrl: string
      model: string
      batchSize?: number
      apiKey?: string
      clearApiKey?: boolean
    }): Promise<void> {
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        const provider = await api.saveEmbeddingProvider(input)
        if (generation !== this.generation) return
        this.provider = provider
        this.effectiveBatchSize = this.provider.batchSize
        const status = await api.semanticIndexStatus()
        if (generation !== this.generation) return
        this.status = status
      } catch (error) {
        if (generation !== this.generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (generation === this.generation) this.loading = false
      }
    },
    async remove(): Promise<void> {
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        await api.removeEmbeddingProvider()
        if (generation !== this.generation) return
        this.provider = null
        this.effectiveBatchSize = 0
        this.status = { ...EMPTY_STATUS }
      } catch (error) {
        if (generation !== this.generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (generation === this.generation) this.loading = false
      }
    },
    async rebuild(): Promise<void> {
      if (this.building) return
      const generation = this.generation
      const controller = new AbortController()
      rebuilds.set(this, controller)
      this.building = true
      this.processed = 0
      this.currentModule = ''
      this.effectiveBatchSize = this.provider?.batchSize ?? 0
      this.error = null
      try {
        const status = await api.rebuildSemanticIndex(({ module, processed, batchSize }) => {
          if (generation !== this.generation) return
          this.currentModule = module
          this.processed = processed
          this.effectiveBatchSize = batchSize
        }, controller.signal)
        if (generation !== this.generation) return
        this.status = status
      } catch (error) {
        if (generation !== this.generation) return
        this.error = (error as Error).message
        const status = await api.semanticIndexStatus().catch(() => null)
        if (generation !== this.generation) return
        if (status) this.status = status
        throw error
      } finally {
        if (generation === this.generation) this.building = false
        if (rebuilds.get(this) === controller) rebuilds.delete(this)
      }
    },
    reset(): void {
      this.generation += 1
      rebuilds.get(this)?.abort()
      rebuilds.delete(this)
      this.provider = null
      this.status = { ...EMPTY_STATUS }
      this.loading = false
      this.building = false
      this.processed = 0
      this.currentModule = ''
      this.effectiveBatchSize = 0
      this.error = null
    }
  }
})
