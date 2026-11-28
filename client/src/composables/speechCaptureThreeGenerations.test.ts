import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createSpeechRecognitionController, type VoiceInputEnvironment } from './useSpeechRecognition'
import type { SttConfig } from '../services/api'

type Stream = Awaited<ReturnType<NonNullable<VoiceInputEnvironment['capture']>>>

function pendingCapture() {
  let resolve!: (stream: Stream) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Stream>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function microphone() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
  return { tracks, getTracks: () => tracks }
}

describe('microphone ownership across three capture generations', () => {
  for (const provider of ['local', 'cloud'] as const) {
    for (const firstSettlement of ['success', 'failure'] as const) {
      it(`${provider}: preserves the third recording when old ${firstSettlement} settles first`, async () => {
        const first = pendingCapture()
        const second = pendingCapture()
        const third = pendingCapture()
        const capture = vi.fn<NonNullable<VoiceInputEnvironment['capture']>>()
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(second.promise)
          .mockReturnValueOnce(third.promise)
        const stale = microphone()
        const current = microphone()
        const fallbackStart = vi.fn()
        class BrowserRecognition {
          continuous = false
          interimResults = false
          lang = ''
          onstart = null
          onresult = null
          onerror = null
          onend = null
          start = fallbackStart
          stop() {}
          abort() {}
        }
        const recorder = {
          mimeType: 'audio/webm', state: 'inactive',
          ondataavailable: null as ((event: { data: Blob }) => void) | null,
          onerror: null as (() => void) | null,
          onstop: null as (() => void) | null,
          start: vi.fn(() => { recorder.state = 'recording' }),
          stop: vi.fn(() => { recorder.state = 'inactive'; recorder.onstop?.() })
        }
        const createRecorder = vi.fn(() => recorder)
        const transcribe = vi.fn<VoiceInputEnvironment['transcribe']>()
        const setTimer = vi.fn<VoiceInputEnvironment['setTimer']>(
          () => 1 as unknown as ReturnType<typeof setTimeout>
        )
        const endpoint = {
          provider: 'openai-compatible' as const, baseUrl: 'http://localhost:8000/v1',
          model: 'Systran/faster-whisper-small', hasApiKey: false
        }
        const config: SttConfig = {
          order: [provider, 'browser'],
          local: provider === 'local' ? endpoint : null,
          cloud: provider === 'cloud' ? endpoint : null
        }
        const draft = ref('')
        const controller = createSpeechRecognitionController(draft, { config: () => config }, {
          capture, createRecorder, transcribe, setTimer,
          clearTimer: vi.fn(), now: () => 1000, recognition: BrowserRecognition
        })
        const firstStart = controller.start()
        controller.cancel()
        const secondStart = controller.start()
        controller.cancel()
        const thirdStart = controller.start()
        try {
          third.resolve(current)
          await thirdStart
          if (firstSettlement === 'success') {
            first.resolve(stale)
            await firstStart
            second.reject(new DOMException('Permission denied', 'NotAllowedError'))
            await secondStart
          } else {
            second.reject(new DOMException('Permission denied', 'NotAllowedError'))
            await secondStart
            first.resolve(stale)
            await firstStart
          }
          expect(stale.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1])
          expect(current.tracks.map((track) => track.stop.mock.calls.length)).toEqual([0, 0])
          expect(controller.phase.value).toBe('recording')
          expect(controller.currentProvider.value).toBe(provider)
          expect(controller.error.value).toBeNull()
          expect(controller.notice.value).toBeNull()
          expect(createRecorder).toHaveBeenCalledExactlyOnceWith(current)
          expect(recorder.start).toHaveBeenCalledExactlyOnceWith(1000)
          expect(fallbackStart).toHaveBeenCalledTimes(1)
          expect(setTimer).toHaveBeenCalledTimes(1)
          controller.cancel()
          expect(current.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1])
          expect(recorder.stop).toHaveBeenCalledTimes(1)
          expect(transcribe).not.toHaveBeenCalled()
          expect(draft.value).toBe('')
        } finally {
          first.resolve(stale)
          second.resolve(stale)
          third.resolve(current)
          await Promise.all([firstStart, secondStart, thirdStart])
          controller.cancel()
        }
      })
    }
  }
})
