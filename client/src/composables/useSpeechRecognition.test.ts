import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import {
  createSpeechRecognitionController,
  type SpeechRecognitionConstructor
} from './useSpeechRecognition'

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
  start = vi.fn()
  stop = vi.fn()
  abort = vi.fn()

  constructor() {
    FakeRecognition.instances.push(this)
  }

  result(...transcripts: string[]): void {
    this.onresult?.({
      results: transcripts.map((transcript) => ({
        0: { transcript },
        isFinal: true,
        length: 1
      }))
    })
  }
}

const FakeConstructor = FakeRecognition as unknown as SpeechRecognitionConstructor

afterEach(() => {
  FakeRecognition.instances = []
  vi.unstubAllGlobals()
})

describe('speech recognition controller', () => {
  it('reports an honest unsupported state', () => {
    const controller = createSpeechRecognitionController(ref(''), {})

    expect(controller.supported.value).toBe(false)
    controller.start()
    expect(controller.active.value).toBe(false)
  })

  it('uses the standard recognizer and appends live transcription to the draft', () => {
    vi.stubGlobal('SpeechRecognition', FakeConstructor)
    const draft = ref('faith')
    const controller = createSpeechRecognitionController(draft)

    controller.start()
    const recognition = FakeRecognition.instances[0]
    expect(controller.supported.value).toBe(true)
    expect(controller.active.value).toBe(true)
    expect(recognition.start).toHaveBeenCalledOnce()
    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)

    recognition.result(' grows')
    expect(draft.value).toBe('faith grows')
    recognition.result(' grows', ' daily')
    expect(draft.value).toBe('faith grows daily')

    controller.stop()
    expect(controller.active.value).toBe(false)
    expect(recognition.stop).toHaveBeenCalledOnce()

    controller.start()
    expect(FakeRecognition.instances).toHaveLength(1)
    recognition.onend?.()
    controller.start()
    expect(FakeRecognition.instances).toHaveLength(2)
  })

  it('falls back to the prefixed recognizer and surfaces permission denial', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeConstructor)
    const controller = createSpeechRecognitionController(ref(''))

    controller.start()
    const recognition = FakeRecognition.instances[0]
    recognition.onerror?.({ error: 'not-allowed' })

    expect(controller.supported.value).toBe(true)
    expect(controller.active.value).toBe(false)
    expect(controller.error.value).toBe('Microphone access was denied')
  })

  it('aborts on teardown and ignores stale recognition events', () => {
    const draft = ref('original')
    const controller = createSpeechRecognitionController(draft, {
      recognition: FakeConstructor,
      language: 'en-GB'
    })

    controller.start()
    const recognition = FakeRecognition.instances[0]
    expect(recognition.lang).toBe('en-GB')

    controller.cancel()
    recognition.result('stale')

    expect(recognition.abort).toHaveBeenCalledOnce()
    expect(controller.active.value).toBe(false)
    expect(draft.value).toBe('original')
  })
})
