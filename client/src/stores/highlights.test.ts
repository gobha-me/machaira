import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../services/api'
import { useReader } from './reader'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.restoreAllMocks()
  const reader = useReader()
  reader.activateUser('reader')
  reader.moduleName = 'WEB'
  reader.book = 'John'
})

describe('highlight reconciliation', () => {
  it('serializes disjoint mutations and merges them into the latest map', async () => {
    const first = deferred<void>()
    const update = vi.spyOn(api, 'updateHighlights').mockReturnValueOnce(first.promise).mockResolvedValueOnce()
    const reader = useReader()
    const one = reader.toggleHighlightRange([1])
    const two = reader.toggleHighlightRange([2])
    await Promise.resolve()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)
    reader.highlights['WEB/Gen/1/1'] = 'other'
    first.resolve()
    await Promise.all([one, two])
    expect(Object.keys(reader.highlights).sort()).toEqual(['WEB/Gen/1/1', 'WEB/John/1/1', 'WEB/John/1/2'])
  })

  it('evaluates repeated and overlapping toggles in invocation order', async () => {
    const update = vi.spyOn(api, 'updateHighlights').mockResolvedValue()
    const reader = useReader()
    await Promise.all([reader.toggleHighlightRange([1, 2]), reader.toggleHighlightRange([2, 3]), reader.toggleHighlightRange([1])])
    expect(Object.keys(reader.highlights).sort()).toEqual(['WEB/John/1/2', 'WEB/John/1/3'])
    expect(update.mock.calls[2]).toEqual([[], ['WEB/John/1/1']])
  })

  it('keeps the captured passage when navigation occurs before a queued toggle', async () => {
    const first = deferred<void>()
    const update = vi.spyOn(api, 'updateHighlights').mockReturnValueOnce(first.promise).mockResolvedValueOnce()
    const reader = useReader()
    const one = reader.toggleHighlightRange([1])
    const two = reader.toggleHighlightRange([2])
    reader.book = 'Gen'
    reader.chapter = 2
    first.resolve()
    await Promise.all([one, two])
    expect(update.mock.calls[1][0][0].key).toBe('WEB/John/1/2')
  })

  it('does not roll a successful mutation back with a stale highlight load', async () => {
    const result = deferred<Awaited<ReturnType<typeof api.highlights>>>()
    vi.spyOn(api, 'highlights').mockReturnValue(result.promise)
    vi.spyOn(api, 'updateHighlights').mockResolvedValue()
    const reader = useReader()
    const loading = reader.loadHighlights()
    await reader.toggleHighlightRange([1])
    result.resolve([])
    await loading
    expect(reader.highlights['WEB/John/1/1']).toBeTruthy()
  })

  it('discards queued mutations after reset without blocking the next lifecycle', async () => {
    const first = deferred<void>()
    const update = vi.spyOn(api, 'updateHighlights').mockReturnValueOnce(first.promise).mockResolvedValueOnce()
    const reader = useReader()
    const one = reader.toggleHighlightRange([1])
    const two = reader.toggleHighlightRange([2])
    await Promise.resolve()
    await Promise.resolve()
    reader.activateUser('current')
    reader.moduleName = 'WEB'
    reader.book = 'Gen'
    await reader.toggleHighlightRange([3])
    first.resolve()
    await Promise.all([one, two])
    expect(update).toHaveBeenCalledTimes(2)
    expect(Object.keys(reader.highlights)).toEqual(['WEB/Gen/1/3'])
  })
})
