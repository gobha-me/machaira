import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { api, ApiError, type StrongsPayload } from '../services/api'

// Strong's word study: look up a tagged word's lexicon entry. Shared by Read and Study so
// the capability is built once and surfaced on both panes.
export function useWordStudy() {
  const strongsKey = ref<string | null>(null)
  const entry = ref<StrongsPayload | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)
  let generation = 0

  async function tapWord(keys: string[]) {
    const key = keys[0]
    if (!key) return
    const activeGeneration = ++generation
    strongsKey.value = key
    loading.value = true
    error.value = null
    entry.value = null
    try {
      const result = await api.strongs(key)
      if (activeGeneration !== generation) return
      entry.value = result
    } catch (e) {
      if (activeGeneration !== generation) return
      entry.value = null
      error.value =
        e instanceof ApiError && e.status === 409 ? e.message : `No entry for ${key}.`
    } finally {
      if (activeGeneration === generation) loading.value = false
    }
  }

  function clear() {
    generation += 1
    strongsKey.value = null
    entry.value = null
    error.value = null
    loading.value = false
  }

  if (getCurrentScope()) onScopeDispose(clear)

  return { strongsKey, entry, error, loading, tapWord, clear }
}
