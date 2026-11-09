// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import { api, type CompareRow, type ModuleInfo } from '../services/api'
import { useLibrary } from '../stores/library'
import { useReader } from '../stores/reader'
import { useCompare } from './useCompare'

type CompareReply = Awaited<ReturnType<typeof api.compare>>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const kjv: ModuleInfo = {
  id: 'CrossWire:KJV', name: 'KJV', type: 'BIBLE', description: 'King James Version',
  language: 'en', hasStrongs: true, hasGreekStrongsKeys: true, hasHebrewStrongsKeys: true,
  hasFootnotes: false, hasHeadings: false, hasRedLetterWords: false, hasCrossReferences: false,
  locked: false, installed: true, kind: 'scripture', collection: 'bible', coverage: [],
  coverageSource: 'unknown', format: 'bundled',
  coverageSummary: 'Exact book coverage has not been audited', aiEligibility: 'public-domain'
}

function reply(verse: number): CompareReply {
  const row: CompareRow = { module: 'KJV', hasStrongs: true, license: 'Public Domain', verses: [{ n: verse, text: null }] }
  return { bookName: 'John', translations: [row] }
}

const mounted: VueWrapper[] = []

function harness() {
  vi.useFakeTimers()
  const pinia = createPinia()
  setActivePinia(pinia)
  const library = useLibrary()
  library.modules = [kjv]
  const reader = useReader()
  reader.$patch({ moduleName: 'KJV', book: 'John', chapter: 3, selectedVerse: 1, rangeEnd: null })
  const active = ref(true)
  const first = deferred<CompareReply>()
  const second = deferred<CompareReply>()
  const fetch = vi.spyOn(api, 'compare').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  let compare!: ReturnType<typeof useCompare>
  const wrapper = mount(defineComponent({
    setup() {
      compare = useCompare({ active, followSelection: true })
      return () => h('div')
    }
  }), { global: { plugins: [pinia] } })
  mounted.push(wrapper)
  compare.syncFromSelection()
  return { reader, library, active, compare, wrapper, first, second, fetch }
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('comparison request ownership before the selection debounce', () => {
  for (const result of ['success', 'failure'] as const) {
    it(`ignores stale ${result} throughout the debounce and fetches the final range once`, async () => {
      const t = harness()
      t.reader.selectVerse(2)
      await nextTick()
      if (result === 'success') t.first.resolve(reply(1))
      else t.first.reject(new Error('Old verse comparison failed'))
      await flushPromises()
      expect(t.compare.comparing.value).toBe(true)
      expect(t.compare.rows.value).toEqual([])
      expect(t.compare.compareError.value).toBeNull()

      t.reader.rangeEnd = 4
      await nextTick()
      await vi.advanceTimersByTimeAsync(149)
      expect(t.fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(t.fetch).toHaveBeenCalledTimes(2)
      expect(t.fetch).toHaveBeenLastCalledWith('John', 3, 2, 4, ['KJV'])
      t.second.resolve(reply(2))
      await flushPromises()
      expect(t.compare.rows.value).toEqual(reply(2).translations)
      expect(t.compare.compareError.value).toBeNull()
      expect(t.compare.comparing.value).toBe(false)
    })

    it(`ignores a pending ${result} after unmount and cancels the scheduled fetch`, async () => {
      const t = harness()
      t.reader.selectVerse(2)
      await nextTick()
      t.wrapper.unmount()
      mounted.splice(mounted.indexOf(t.wrapper), 1)
      const before = {
        rows: t.compare.rows.value, error: t.compare.compareError.value, loading: t.compare.comparing.value
      }
      if (result === 'success') t.first.resolve(reply(1))
      else t.first.reject(new Error('Disposed comparison failed'))
      await flushPromises()
      await vi.advanceTimersByTimeAsync(150)
      expect({
        rows: t.compare.rows.value, error: t.compare.compareError.value, loading: t.compare.comparing.value
      }).toEqual(before)
      expect(t.fetch).toHaveBeenCalledTimes(1)
    })

    for (const unavailable of ['inactive', 'missing book', 'no translations'] as const) {
      it(`does not accept an old ${result} after loadCompare clears ${unavailable}`, async () => {
        const t = harness()
        if (unavailable === 'inactive') t.active.value = false
        else if (unavailable === 'missing book') t.reader.book = null
        else t.library.modules = []
        t.compare.loadCompare()
        await nextTick()
        if (result === 'success') t.first.resolve(reply(1))
        else t.first.reject(new Error('Unavailable comparison failed'))
        await flushPromises()
        expect(t.compare.rows.value).toEqual([])
        expect(t.compare.compareError.value).toBeNull()
        expect(t.compare.comparing.value).toBe(false)
        await vi.advanceTimersByTimeAsync(150)
        expect(t.fetch).toHaveBeenCalledTimes(1)
      })
    }
  }
})
