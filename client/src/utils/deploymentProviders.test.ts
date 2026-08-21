import { describe, expect, it } from 'vitest'
import { providerDefaults, providerReadiness, providerTitle } from './deploymentProviders'

describe('deployment provider settings helpers', () => {
  it('maps deployment choices into editable provider defaults', () => {
    const provider = {
      source: 'bundled' as const,
      engine: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'all-minilm:22m',
      batchSize: 16,
      readiness: { state: 'ready' as const, checkedAt: 1 }
    }
    expect(providerDefaults({ embeddings: provider }, 'embeddings')).toEqual({
      baseUrl: provider.baseUrl,
      model: provider.model,
      batchSize: 16
    })
    expect(providerTitle(provider)).toBe('Bundled ollama')
    expect(providerReadiness(provider)).toBe('ready')
  })

  it('preserves actionable readiness without inventing a health result', () => {
    expect(providerReadiness({
      source: 'external', engine: 'openai-compatible', baseUrl: 'https://provider.example/v1',
      model: 'model', readiness: { state: 'unchecked', checkedAt: null }
    })).toBe('configured · test before saving')
    expect(providerReadiness({
      source: 'bundled', engine: 'speaches', baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'whisper', readiness: { state: 'unavailable', checkedAt: 1, message: 'model is not loaded' }
    })).toBe('unavailable · model is not loaded')
  })
})
