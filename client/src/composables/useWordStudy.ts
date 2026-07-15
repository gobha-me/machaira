import { ref } from 'vue'
import { api, ApiError, type StrongsPayload } from '../services/api'

// Strong's word study: look up a tagged word's lexicon entry. Shared by Read and Study so
// the capability is built once and surfaced on both panes.
export function useWordStudy() {
  const strongsKey = ref<string | null>(null)
  const entry = ref<StrongsPayload | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)

  async function tapWord(keys: string[]) {
    const key = keys[0]
    if (!key) return
    strongsKey.value = key
    loading.value = true
    error.value = null
    entry.value = null
    try {
      entry.value = await api.strongs(key)
    } catch (e) {
      entry.value = null
      error.value =
        e instanceof ApiError && e.status === 409 ? e.message : `No entry for ${key}.`
    } finally {
      loading.value = false
    }
  }

  function clear() {
    strongsKey.value = null
    entry.value = null
    error.value = null
  }

  return { strongsKey, entry, error, loading, tapWord, clear }
}
