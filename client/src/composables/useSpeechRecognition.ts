import { onBeforeUnmount, ref, type Ref } from 'vue'

interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionEventLike {
  readonly results: ArrayLike<SpeechRecognitionResultLike>
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

interface SpeechRecognitionGlobals {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

export interface SpeechRecognitionEnvironment {
  recognition?: SpeechRecognitionConstructor
  language?: string
}

function browserEnvironment(): SpeechRecognitionEnvironment {
  const globals = globalThis as typeof globalThis & SpeechRecognitionGlobals
  return {
    recognition: globals.SpeechRecognition ?? globals.webkitSpeechRecognition,
    language: typeof navigator === 'undefined' ? 'en-US' : navigator.language
  }
}

function recognitionErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was denied'
    case 'audio-capture':
      return 'No microphone is available'
    case 'no-speech':
      return 'No speech was detected'
    case 'network':
      return 'Speech recognition could not reach its service'
    default:
      return 'Voice input stopped unexpectedly'
  }
}

function joinTranscript(base: string, spoken: string): string {
  const cleanSpoken = spoken.trim()
  if (!base) return cleanSpoken
  if (!cleanSpoken) return base
  return `${base} ${cleanSpoken}`
}

export function createSpeechRecognitionController(
  draft: Ref<string>,
  environment: SpeechRecognitionEnvironment = browserEnvironment()
) {
  const supported = ref(!!environment.recognition)
  const active = ref(false)
  const error = ref<string | null>(null)
  let recognition: SpeechRecognitionLike | null = null
  let generation = 0

  function start(): void {
    if (!environment.recognition || active.value || recognition) return

    const token = ++generation
    const base = draft.value.trimEnd()
    const next = new environment.recognition()
    recognition = next
    error.value = null
    active.value = true
    next.continuous = true
    next.interimResults = true
    next.lang = environment.language || 'en-US'

    next.onstart = () => {
      if (token === generation) active.value = true
    }
    next.onresult = (event) => {
      if (token !== generation) return
      let transcript = ''
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i]?.[0]?.transcript ?? ''
      }
      draft.value = joinTranscript(base, transcript)
    }
    next.onerror = (event) => {
      if (token !== generation) return
      active.value = false
      if (event.error !== 'aborted') error.value = recognitionErrorMessage(event.error)
    }
    next.onend = () => {
      if (token !== generation) return
      active.value = false
      recognition = null
    }

    try {
      next.start()
    } catch {
      if (token !== generation) return
      active.value = false
      recognition = null
      error.value = 'Voice input could not start'
    }
  }

  function stop(): void {
    if (!recognition) return
    active.value = false
    try {
      recognition.stop()
    } catch {
      // Some engines throw when stop races their own end event. The onend path owns cleanup.
    }
  }

  function cancel(): void {
    generation += 1
    active.value = false
    const current = recognition
    recognition = null
    try {
      current?.abort()
    } catch {
      // The recognizer has already ended.
    }
  }

  return { supported, active, error, start, stop, cancel }
}

export function useSpeechRecognition(draft: Ref<string>) {
  const controller = createSpeechRecognitionController(draft)
  onBeforeUnmount(controller.cancel)
  return controller
}
