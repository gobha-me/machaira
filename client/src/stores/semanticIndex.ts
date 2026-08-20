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

export const useSemanticIndex = defineStore('semanticIndex', {
  state: () => ({
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
      this.loading = true
      this.error = null
      try {
        const [provider, status] = await Promise.all([
          api.embeddingProvider(),
          api.semanticIndexStatus()
        ])
        this.provider = provider
        this.effectiveBatchSize = provider?.batchSize ?? 0
        this.status = status
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
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
      this.loading = true
      this.error = null
      try {
        this.provider = await api.saveEmbeddingProvider(input)
        this.effectiveBatchSize = this.provider.batchSize
        this.status = await api.semanticIndexStatus()
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
      }
    },
    async remove(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.removeEmbeddingProvider()
        this.provider = null
        this.effectiveBatchSize = 0
        this.status = { ...EMPTY_STATUS }
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
      }
    },
    async rebuild(): Promise<void> {
      this.building = true
      this.processed = 0
      this.currentModule = ''
      this.effectiveBatchSize = this.provider?.batchSize ?? 0
      this.error = null
      try {
        this.status = await api.rebuildSemanticIndex(({ module, processed, batchSize }) => {
          this.currentModule = module
          this.processed = processed
          this.effectiveBatchSize = batchSize
        })
      } catch (error) {
        this.error = (error as Error).message
        this.status = await api.semanticIndexStatus().catch(() => this.status)
        throw error
      } finally {
        this.building = false
      }
    },
    reset(): void {
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
