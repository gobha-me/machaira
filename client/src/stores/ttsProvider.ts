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
    config: { ...DEFAULT_CONFIG, order: [...DEFAULT_CONFIG.order] } as TtsConfig,
    loading: false,
    ready: false,
    error: null as string | null
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.config = await api.ttsConfig()
        this.ready = true
      } catch (error) {
        this.error = (error as Error).message
        throw error
      } finally {
        this.loading = false
      }
    },
    async save(input: {
      order: TtsTier[]
      local: TtsEndpointInput | null
      cloud: TtsEndpointInput | null
      remoteAudioCacheSize: number
    }): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.config = await api.saveTtsConfig(input)
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
