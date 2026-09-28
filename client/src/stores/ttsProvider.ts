import { defineStore } from 'pinia'
import {
  api,
  type TtsConfig,
  type TtsEndpointInput,
  type TtsTier
} from '../services/api'

const DEFAULT_CONFIG: TtsConfig = {
  order: ['browser'], local: null, cloud: null, remoteAudioCacheSize: 4
}

export const useTtsProvider = defineStore('ttsProvider', {
  state: () => ({
    generation: 0,
    config: { ...DEFAULT_CONFIG, order: [...DEFAULT_CONFIG.order] } as TtsConfig,
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
        const config = await api.ttsConfig()
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
      order: TtsTier[]
      local: TtsEndpointInput | null
      cloud: TtsEndpointInput | null
      remoteAudioCacheSize: number
    }): Promise<void> {
      const generation = this.generation
      this.loading = true
      this.error = null
      try {
        const config = await api.saveTtsConfig(input)
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
