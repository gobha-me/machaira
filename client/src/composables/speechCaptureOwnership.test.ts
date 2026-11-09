import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createSpeechRecognitionController, type VoiceInputEnvironment } from './useSpeechRecognition'
import type { SttConfig } from '../services/api'

type CapturedStream = Awaited<ReturnType<NonNullable<VoiceInputEnvironment['capture']>>>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function microphone() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
  return { tracks, getTracks: () => tracks }
}

function harness(provider: 'local' | 'cloud') {
  const first = deferred<CapturedStream>()
  const second = deferred<CapturedStream>()
  const capture = vi.fn<NonNullable<VoiceInputEnvironment['capture']>>()
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
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
  const setTimer = vi.fn<VoiceInputEnvironment['setTimer']>(() => 1 as unknown as ReturnType<typeof setTimeout>)
  const clearTimer = vi.fn<VoiceInputEnvironment['clearTimer']>()
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
    capture, createRecorder, transcribe, setTimer, clearTimer, now: () => 1000,
    recognition: BrowserRecognition
  })
  return { first, second, controller, draft, recorder, createRecorder, transcribe, setTimer, fallbackStart }
}

describe('microphone capture generation ownership', () => {
  for (const provider of ['local', 'cloud'] as const) {
    it(`${provider}: a late cancelled stream cannot erase the active microphone cleanup handle`, async () => {
      const h = harness(provider)
      const stale = microphone()
      const current = microphone()
      const oldStart = h.controller.start()
      h.controller.cancel()
      const currentStart = h.controller.start()
      try {
        h.second.resolve(current)
        await currentStart
        h.first.resolve(stale)
        await oldStart
        h.controller.cancel()
        expect(current.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1])
        expect(stale.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1])
        expect(h.createRecorder).toHaveBeenCalledExactlyOnceWith(current)
        expect(h.fallbackStart).toHaveBeenCalledTimes(1)
        expect(h.setTimer).toHaveBeenCalledTimes(1)
        expect(h.transcribe).not.toHaveBeenCalled()
        expect(h.draft.value).toBe('')
      } finally { h.controller.cancel() }
    })

    for (const failure of [new DOMException('Permission denied', 'NotAllowedError'), new Error('Capture failed')]) {
      it(`${provider}: stale ${failure.name} cannot stop a newer recording or restart browser fallback`, async () => {
        const h = harness(provider)
        const current = microphone()
        const oldStart = h.controller.start()
        h.controller.cancel()
        const currentStart = h.controller.start()
        try {
          h.second.resolve(current)
          await currentStart
          h.first.reject(failure)
          await oldStart
          expect(current.tracks.map((track) => track.stop.mock.calls.length)).toEqual([0, 0])
          expect(h.controller.phase.value).toBe('recording')
          expect(h.controller.currentProvider.value).toBe(provider)
          expect(h.controller.error.value).toBeNull()
          expect(h.controller.notice.value).toBeNull()
          expect(h.recorder.state).toBe('recording')
          expect(h.createRecorder).toHaveBeenCalledExactlyOnceWith(current)
          expect(h.fallbackStart).toHaveBeenCalledTimes(1)
          expect(h.setTimer).toHaveBeenCalledTimes(1)
          h.controller.cancel()
          expect(current.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1])
          expect(h.transcribe).not.toHaveBeenCalled()
        } finally { h.controller.cancel() }
      })
    }

    it(`${provider}: a stale failure cannot finish the second capture while permission is still pending`, async () => {
      const h = harness(provider)
      const current = microphone()
      const oldStart = h.controller.start()
      h.controller.cancel()
      const currentStart = h.controller.start()
      try {
        h.first.reject(new DOMException('Permission denied', 'NotAllowedError'))
        await oldStart
        expect(h.controller.phase.value).toBe('starting')
        expect(h.controller.currentProvider.value).toBe(provider)
        expect(h.controller.error.value).toBeNull()
        expect(h.fallbackStart).not.toHaveBeenCalled()
        expect(h.setTimer).not.toHaveBeenCalled()
        h.second.resolve(current)
        await currentStart
        expect(h.controller.phase.value).toBe('recording')
      } finally {
        h.second.resolve(current)
        await currentStart
        h.controller.cancel()
      }
    })

    it(`${provider}: cancelling one pending capture cannot start a fallback when its rejection arrives`, async () => {
      const h = harness(provider)
      const start = h.controller.start()
      h.controller.cancel()
      h.first.reject(new Error('Capture failed'))
      await start
      try {
        expect(h.controller.phase.value).toBe('idle')
        expect(h.controller.currentProvider.value).toBeNull()
        expect(h.controller.notice.value).toBe('Voice input cancelled')
        expect(h.controller.error.value).toBeNull()
        expect(h.createRecorder).not.toHaveBeenCalled()
        expect(h.fallbackStart).not.toHaveBeenCalled()
        expect(h.setTimer).not.toHaveBeenCalled()
        expect(h.transcribe).not.toHaveBeenCalled()
        expect(h.draft.value).toBe('')
      } finally { h.controller.cancel() }
    })
  }
})
