import { defineStore } from 'pinia'
import { api, type AiProviderConfig, type AiProviderKind } from '../services/api'

export const useAiProvider = defineStore('aiProvider', {
  state: () => ({
    generation: 0,
    provider: null as AiProviderConfig | null,
    loading: false,
    ready: false,
    error: null as string | null
  }),
  actions: {
    async load(): Promise<void> {
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        const provider = await api.aiProvider()
        if (generation !== this.generation) return
        this.provider = provider
        this.ready = true
      } catch (error) {
        if (generation !== this.generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (generation === this.generation) this.loading = false
      }
    },
    async save(input: {
      kind: AiProviderKind
      baseUrl: string
      model: string
      apiKey?: string
      clearApiKey?: boolean
    }): Promise<void> {
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        const provider = await api.saveAiProvider(input)
        if (generation !== this.generation) return
        this.provider = provider
        this.ready = true
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
        await api.removeAiProvider()
        if (generation !== this.generation) return
        this.provider = null
        this.ready = true
      } catch (error) {
        if (generation !== this.generation) return
        this.error = (error as Error).message
        throw error
      } finally {
        if (generation === this.generation) this.loading = false
      }
    },
    reset(): void {
      this.generation += 1
      this.provider = null
      this.loading = false
      this.ready = false
      this.error = null
    }
  }
})
