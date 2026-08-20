import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import {
  createSpeechRecognitionController,
  type SpeechRecognitionConstructor,
  type VoiceInputEnvironment
} from './useSpeechRecognition'
import type { SttConfig } from '../services/api'

interface FakeResult {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: { transcript: string }
}

class FakeRecognition {
  static instances: FakeRecognition[] = []
  continuous = false
  interimResults = false
  lang = ''
  onstart: (() => void) | null = null
  onresult: ((event: { results: ArrayLike<FakeResult> }) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn(() => this.onstart?.())
  stop = vi.fn(() => this.onend?.())
  abort = vi.fn(() => this.onend?.())

  constructor() { FakeRecognition.instances.push(this) }

  result(...transcripts: string[]): void {
    this.onresult?.({
      results: transcripts.map((transcript) => ({
        0: { transcript }, isFinal: true, length: 1
      }))
    })
  }
}

class FakeRecorder {
  mimeType = 'audio/webm;codecs=opus'
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onerror: (() => void) | null = null
  onstop: (() => void) | null = null
  start = vi.fn(() => { this.state = 'recording' })
  stop = vi.fn(() => {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: this.mimeType }) })
    this.onstop?.()
  })
}

const FakeConstructor = FakeRecognition as unknown as SpeechRecognitionConstructor
const stream = () => ({ getTracks: () => [{ stop: vi.fn() }] })
const browserOnly: SttConfig = { order: ['browser'], local: null, cloud: null }
const localEndpoint = {
  provider: 'openai-compatible' as const,
  baseUrl: 'http://localhost:8000/v1',
  model: 'Systran/faster-whisper-small',
  hasApiKey: false
}
const cloudEndpoint = {
  provider: 'venice' as const,
  baseUrl: 'https://api.venice.ai/api/v1',
  model: 'nvidia/parakeet-tdt-0.6b-v3',
  hasApiKey: true
}

function environment(overrides: Partial<VoiceInputEnvironment> = {}): VoiceInputEnvironment {
  return {
    recognition: undefined,
    language: 'en-GB',
    capture: undefined,
    createRecorder: undefined,
    transcribe: vi.fn<VoiceInputEnvironment['transcribe']>(async () => 'remote transcript'),
    now: () => 1000,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
    ...overrides
  }
}

afterEach(() => {
  FakeRecognition.instances = []
  vi.useRealTimers()
})

describe('voice-input provider controller', () => {
  it('reports an honest unsupported state when no configured tier can run', async () => {
    const controller = createSpeechRecognitionController(
      ref(''), { config: () => browserOnly }, environment()
    )

    expect(controller.supported.value).toBe(false)
    await controller.start()
    expect(controller.phase.value).toBe('idle')
  })

  it('uses browser recognition and appends its transcript without submitting', async () => {
    const draft = ref('faith')
    const controller = createSpeechRecognitionController(
      draft,
      { config: () => browserOnly },
      environment({ recognition: FakeConstructor })
    )

    await controller.start()
    const recognition = FakeRecognition.instances[0]
    expect(recognition.lang).toBe('en-GB')
    expect(controller.currentProvider.value).toBe('browser')
    recognition.result(' grows daily')
    await controller.stop()

    expect(draft.value).toBe('faith grows daily')
    expect(controller.notice.value).toBe('Transcribed with Browser STT')
    expect(controller.phase.value).toBe('idle')
  })

  it('waits for the browser final result emitted after recognition stops', async () => {
    const draft = ref('patient')
    const controller = createSpeechRecognitionController(
      draft,
      { config: () => browserOnly },
      environment({ recognition: FakeConstructor })
    )

    await controller.start()
    const recognition = FakeRecognition.instances[0]
    recognition.stop = vi.fn(() => {
      queueMicrotask(() => {
        recognition.result(' endurance')
        recognition.onend?.()
      })
    })
    await controller.stop()

    expect(draft.value).toBe('patient endurance')
    expect(controller.notice.value).toBe('Transcribed with Browser STT')
  })

  it('records independently of SpeechRecognition for a local provider', async () => {
    let now = 1000
    const recorder = new FakeRecorder()
    const transcribe = vi.fn<VoiceInputEnvironment['transcribe']>(async () => 'seek and find')
    const draft = ref('')
    const config: SttConfig = { order: ['local'], local: localEndpoint, cloud: null }
    const controller = createSpeechRecognitionController(draft, { config: () => config }, environment({
      capture: async () => stream(),
      createRecorder: () => recorder,
      transcribe,
      now: () => now
    }))

    await controller.start()
    now = 2400
    await controller.stop()

    expect(transcribe).toHaveBeenCalledOnce()
    expect(transcribe.mock.calls[0][0]).toBe('local')
    expect(transcribe.mock.calls[0][1]).toBeInstanceOf(Blob)
    expect(transcribe.mock.calls[0][2]).toBe(1400)
    expect(draft.value).toBe('seek and find')
  })

  it('preserves one recording and visibly falls back from browser to local STT', async () => {
    const recorder = new FakeRecorder()
    const transcribe = vi.fn<VoiceInputEnvironment['transcribe']>(async () => 'local result')
    const config: SttConfig = {
      order: ['browser', 'local'], local: localEndpoint, cloud: null
    }
    const draft = ref('question')
    const controller = createSpeechRecognitionController(draft, { config: () => config }, environment({
      recognition: FakeConstructor,
      capture: async () => stream(),
      createRecorder: () => recorder,
      transcribe
    }))

    await controller.start()
    FakeRecognition.instances[0].onerror?.({ error: 'no-speech' })
    await controller.stop()

    expect(transcribe).toHaveBeenCalledOnce()
    expect(controller.notice.value).toBe('Transcribed with Local STT')
    expect(draft.value).toBe('question local result')
  })

  it('tries remote tiers in the saved order and surfaces the winning cloud backend', async () => {
    const config: SttConfig = {
      order: ['local', 'cloud'], local: localEndpoint, cloud: cloudEndpoint
    }
    const transcribe = vi.fn<VoiceInputEnvironment['transcribe']>(async (tier) => {
      if (tier === 'local') throw new Error('Local endpoint unavailable')
      return 'cloud result'
    })
    const draft = ref('')
    const controller = createSpeechRecognitionController(draft, { config: () => config }, environment({
      capture: async () => stream(),
      createRecorder: () => new FakeRecorder(),
      transcribe
    }))

    await controller.start()
    await controller.stop()

    expect(transcribe.mock.calls.map((call) => call[0])).toEqual(['local', 'cloud'])
    expect(controller.notice.value).toBe('Transcribed with Cloud STT')
    expect(draft.value).toBe('cloud result')
  })

  it('aborts an in-flight upload and ignores its eventual result', async () => {
    const config: SttConfig = { order: ['local'], local: localEndpoint, cloud: null }
    let resolveTranscript!: (value: string) => void
    const transcribe = vi.fn<VoiceInputEnvironment['transcribe']>((_tier, _audio, _duration, signal) => new Promise<string>((resolve, reject) => {
      resolveTranscript = resolve
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const draft = ref('keep')
    const controller = createSpeechRecognitionController(draft, { config: () => config }, environment({
      capture: async () => stream(),
      createRecorder: () => new FakeRecorder(),
      transcribe
    }))

    await controller.start()
    const stopping = controller.stop()
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    controller.cancel()
    resolveTranscript('stale')
    await stopping

    expect(draft.value).toBe('keep')
    expect(controller.phase.value).toBe('idle')
    expect(controller.notice.value).toBe('Voice input cancelled')
  })

  it('automatically stops at the sixty-second recording limit', async () => {
    let timerCallback: (() => void) | null = null
    let now = 0
    const config: SttConfig = { order: ['local'], local: localEndpoint, cloud: null }
    const transcribe = vi.fn<VoiceInputEnvironment['transcribe']>(async () => 'limited')
    const controller = createSpeechRecognitionController(ref(''), { config: () => config }, environment({
      capture: async () => stream(),
      createRecorder: () => new FakeRecorder(),
      transcribe,
      now: () => now,
      setTimer: (callback) => { timerCallback = callback; return 1 as unknown as ReturnType<typeof setTimeout> },
      clearTimer: () => undefined
    }))

    await controller.start()
    now = 60_000
    expect(timerCallback).not.toBeNull()
    ;(timerCallback as unknown as () => void)()
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())

    expect(transcribe.mock.calls[0][2]).toBe(60_000)
  })
})
