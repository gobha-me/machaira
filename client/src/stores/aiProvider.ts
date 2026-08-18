import { defineStore } from 'pinia'
import { api, type AiProviderConfig, type AiProviderKind } from '../services/api'

export const useAiProvider = defineStore('aiProvider', {
  state: () => ({
    provider: null as AiProviderConfig | null,
    loading: false,
    ready: false,
    error: null as string | null
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.provider = await api.aiProvider()
        this.ready = true
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
      }
    },
    async save(input: {
      kind: AiProviderKind
      baseUrl: string
      model: string
      apiKey?: string
      clearApiKey?: boolean
    }): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.provider = await api.saveAiProvider(input)
        this.ready = true
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
        await api.removeAiProvider()
        this.provider = null
        this.ready = true
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
      }
    },
    reset(): void {
      this.provider = null
      this.loading = false
      this.ready = false
      this.error = null
    }
  }
})
