import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { api, type StrongsPayload } from '../services/api'
import { useWordStudy } from './useWordStudy'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const entry = (key: string): StrongsPayload => ({ key, transcription: key, phonetic: '', definition: key, references: [] })
beforeEach(() => vi.restoreAllMocks())

describe('word-study request ownership', () => {
  it.each(['success', 'failure'])('ignores superseded lookup %s and loading cleanup', async (outcome) => {
    const first = deferred<StrongsPayload>()
    const second = deferred<StrongsPayload>()
    vi.spyOn(api, 'strongs').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const study = useWordStudy()
    const old = study.tapWord(['G1'])
    const current = study.tapWord(['G2'])
    if (outcome === 'success') first.resolve(entry('G1'))
    else first.reject(new Error('old failure'))
    await old
    expect(study.loading.value).toBe(true)
    expect(study.error.value).toBeNull()
    second.resolve(entry('G2'))
    await current
    expect(study.entry.value?.key).toBe('G2')
    expect(study.strongsKey.value).toBe('G2')
  })

  it('keeps the newest result when an older lookup finishes later', async () => {
    const first = deferred<StrongsPayload>()
    vi.spyOn(api, 'strongs').mockReturnValueOnce(first.promise).mockResolvedValueOnce(entry('G2'))
    const study = useWordStudy()
    const old = study.tapWord(['G1'])
    await study.tapWord(['G2'])
    first.resolve(entry('G1'))
    await old
    expect(study.entry.value?.key).toBe('G2')
  })

  it.each(['clear', 'dispose'] as const)('invalidates pending lookup on %s', async (operation) => {
    const result = deferred<StrongsPayload>()
    vi.spyOn(api, 'strongs').mockReturnValue(result.promise)
    const scope = effectScope()
    const study = scope.run(useWordStudy)!
    const pending = study.tapWord(['G1'])
    if (operation === 'clear') study.clear()
    else scope.stop()
    result.resolve(entry('G1'))
    await pending
    expect(study.strongsKey.value).toBeNull()
    expect(study.entry.value).toBeNull()
    expect(study.error.value).toBeNull()
    expect(study.loading.value).toBe(false)
    scope.stop()
  })
})
