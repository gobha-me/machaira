import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReadAloudController, type ReadAloudEnvironment } from './useReadAloud'
import type { TtsConfig } from '../services/api'

const controllers: ReturnType<typeof createReadAloudController>[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop()
})

function setup(text: string, provider: 'local' | 'cloud') {
  const pending: Array<(blob: Blob) => void> = []
  const fetchAudio = vi.fn<ReadAloudEnvironment['fetchAudio']>(() => new Promise((resolve) => pending.push(resolve)))
  const audio = {
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play: vi.fn(async () => {}), pause: vi.fn()
  }
  const setSource = vi.fn(() => vi.fn())
  const createAudio = vi.fn(() => ({ audio, setSource, unlock: vi.fn(), dispose: vi.fn() }))
  const endpoint = {
    provider: 'openai-compatible' as const, baseUrl: 'http://localhost:8000/v1',
    model: 'kokoro', voice: 'af_heart', hasApiKey: false
  }
  const config: TtsConfig = {
    order: [provider], remoteAudioCacheSize: 8,
    local: provider === 'local' ? endpoint : null, cloud: provider === 'cloud' ? endpoint : null
  }
  const controller = createReadAloudController({
    verses: () => [{ n: 1, text: '' }, { n: 2, text }],
    startVerse: () => 2, config: () => config
  }, { synthesis: null, createUtterance: null, createAudio, fetchAudio })
  controllers.push(controller)
  return { controller, fetchAudio, pending, audio, setSource, createAudio }
}

describe('oversized read-aloud input at the remote request boundary', () => {
  for (const provider of ['local', 'cloud'] as const) {
    for (const text of ['x'.repeat(2600), `${'x'.repeat(499)}${'😀'.repeat(1050)}`]) {
      it(`${provider}: caps ${text.length} UTF-16 units, preserves every character, and counts one prepared verse`, async () => {
        const t = setup(text, provider)
        t.controller.start()
        expect(t.fetchAudio.mock.calls[0]![1].length).toBeLessThanOrEqual(500)
        expect(t.fetchAudio).toHaveBeenCalledTimes(1)
        expect(t.controller.preparationTarget.value).toBe(1)

        for (let chunk = 0; chunk < 6; chunk += 1) {
          expect(t.pending).toHaveLength(chunk + 1)
          t.pending[chunk]!(new Blob())
          if (chunk < 5) {
            await vi.waitFor(() => expect(t.fetchAudio).toHaveBeenCalledTimes(chunk + 2))
            expect(t.controller.preparedCount.value).toBe(0)
          } else {
            await vi.waitFor(() => expect(t.controller.preparedCount.value).toBe(1))
          }
        }
        await vi.waitFor(() => expect(t.audio.play).toHaveBeenCalledTimes(1))
        const requests = t.fetchAudio.mock.calls.map((call) => call[1])
        expect(requests.join('')).toBe(text)
        expect(requests.every((part) => part.length > 0 && part.length <= 500)).toBe(true)
        expect(requests.every((part) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part))).toBe(true)
        expect(t.fetchAudio.mock.calls.every((call) => call[0] === provider)).toBe(true)
        expect(t.controller.currentVerse.value).toBe(2)
        expect(t.createAudio).toHaveBeenCalledTimes(1)
        for (let played = 1; played < 6; played += 1) {
          t.audio.onended?.()
          await vi.waitFor(() => expect(t.audio.play).toHaveBeenCalledTimes(played + 1))
          expect(t.controller.currentVerse.value).toBe(2)
        }
        t.audio.onended?.()
        await vi.waitFor(() => expect(t.controller.completed.value).toBe(true))
        expect(t.fetchAudio).toHaveBeenCalledTimes(6)
        expect(t.setSource).toHaveBeenCalledTimes(6)
      })
    }

    it(`${provider}: aborts later bounded requests and ignores their result after stop`, async () => {
      const t = setup('x'.repeat(2600), provider)
      t.controller.start()
      expect(t.fetchAudio.mock.calls[0]![1].length).toBeLessThanOrEqual(500)
      t.pending[0]!(new Blob())
      await vi.waitFor(() => expect(t.audio.play).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(t.fetchAudio).toHaveBeenCalledTimes(2))
      const pendingSignal = t.fetchAudio.mock.calls[1]![2]
      t.controller.stop()
      expect(pendingSignal.aborted).toBe(true)
      t.pending[1]!(new Blob())
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(t.fetchAudio).toHaveBeenCalledTimes(2)
      expect(t.audio.play).toHaveBeenCalledTimes(1)
      expect(t.setSource).toHaveBeenCalledTimes(1)
      expect(t.controller.active.value).toBe(false)
    })
  }
})
