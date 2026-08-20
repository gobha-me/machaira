import { defineStore } from 'pinia'
import {
  api,
  type SttConfig,
  type SttEndpointInput,
  type SttTier
} from '../services/api'

const DEFAULT_CONFIG: SttConfig = { order: ['browser'], local: null, cloud: null }

export const useSttProvider = defineStore('sttProvider', {
  state: () => ({
    config: { ...DEFAULT_CONFIG, order: [...DEFAULT_CONFIG.order] } as SttConfig,
    loading: false,
    ready: false,
    error: null as string | null
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.config = await api.sttConfig()
        this.ready = true
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
      }
    },
    async save(input: {
      order: SttTier[]
      local: SttEndpointInput | null
      cloud: SttEndpointInput | null
    }): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.config = await api.saveSttConfig(input)
        this.ready = true
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
      }
    },
    reset(): void {
      this.config = { ...DEFAULT_CONFIG, order: [...DEFAULT_CONFIG.order] }
      this.loading = false
      this.ready = false
      this.error = null
    }
  }
})
