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
    generation: 0,
    config: { ...DEFAULT_CONFIG, order: [...DEFAULT_CONFIG.order] } as SttConfig,
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
        const config = await api.sttConfig()
        if (generation !== this.generation) return
        this.config = config
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
      order: SttTier[]
      local: SttEndpointInput | null
      cloud: SttEndpointInput | null
    }): Promise<void> {
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        const config = await api.saveSttConfig(input)
        if (generation !== this.generation) return
        this.config = config
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
      this.config = { ...DEFAULT_CONFIG, order: [...DEFAULT_CONFIG.order] }
      this.loading = false
      this.ready = false
      this.error = null
    }
  }
})
