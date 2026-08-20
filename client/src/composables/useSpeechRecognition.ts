import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import { api, type SttConfig, type SttTier } from '../services/api'
import { useSttProvider } from '../stores/sttProvider'

interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechRecognitionAlternativeLike
}
interface SpeechRecognitionEventLike { readonly results: ArrayLike<SpeechRecognitionResultLike> }
interface SpeechRecognitionErrorEventLike { readonly error: string }
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

interface MediaStreamLike { getTracks(): { stop(): void }[] }
interface MediaRecorderLike {
  readonly mimeType: string
  readonly state: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onerror: (() => void) | null
  onstop: (() => void) | null
  start(timeslice?: number): void
  stop(): void
}

interface SpeechRecognitionGlobals {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

export type VoiceInputPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

export interface VoiceInputEnvironment {
  recognition?: SpeechRecognitionConstructor
  language?: string
  capture?: () => Promise<MediaStreamLike>
  createRecorder?: (stream: MediaStreamLike) => MediaRecorderLike
  transcribe: (
    provider: 'local' | 'cloud', audio: Blob, durationMs: number, signal: AbortSignal
  ) => Promise<string>
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
}

export interface VoiceInputOptions {
  config: () => SttConfig
}

const MAX_RECORDING_MS = 60_000
const MAX_RECORDING_BYTES = 8 * 1024 * 1024
const MIME_PREFERENCES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']

function browserEnvironment(): VoiceInputEnvironment {
  const globals = globalThis as typeof globalThis & SpeechRecognitionGlobals
  const mediaAvailable = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined'
  return {
    recognition: globals.SpeechRecognition ?? globals.webkitSpeechRecognition,
    language: typeof navigator === 'undefined' ? 'en-US' : navigator.language,
    capture: mediaAvailable
      ? () => navigator.mediaDevices.getUserMedia({ audio: true }) as unknown as Promise<MediaStreamLike>
      : undefined,
    createRecorder: mediaAvailable ? (stream) => {
      const mimeType = MIME_PREFERENCES.find((type) => MediaRecorder.isTypeSupported(type))
      return new MediaRecorder(
        stream as unknown as MediaStream,
        mimeType ? { mimeType } : undefined
      ) as unknown as MediaRecorderLike
    } : undefined,
    transcribe: (provider, audio, durationMs, signal) =>
      api.sttTranscription(provider, audio, durationMs, signal),
    now: () => performance.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer)
  }
}

function recognitionErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed': return 'Microphone access was denied'
    case 'audio-capture': return 'No microphone is available'
    case 'no-speech': return 'No speech was detected'
    case 'network': return 'Browser recognition could not reach its service'
    default: return 'Browser voice input stopped unexpectedly'
  }
}

function tierLabel(tier: SttTier): string {
  if (tier === 'browser') return 'Browser STT'
  if (tier === 'local') return 'Local STT'
  return 'Cloud STT'
}

function joinTranscript(base: string, spoken: string): string {
  const cleanSpoken = spoken.trim()
  if (!base) return cleanSpoken
  if (!cleanSpoken) return base
  return `${base} ${cleanSpoken}`
}

export function createSpeechRecognitionController(
  draft: Ref<string>,
  options: VoiceInputOptions,
  environment: VoiceInputEnvironment = browserEnvironment()
) {
  const phase = ref<VoiceInputPhase>('idle')
  const currentProvider = ref<SttTier | null>(null)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const active = computed(() => phase.value !== 'idle')
  const viableTiers = computed(() => options.config().order.filter((tier) => {
    if (tier === 'browser') return !!environment.recognition
    return !!options.config()[tier] && !!environment.capture && !!environment.createRecorder
  }))
  const supported = computed(() => viableTiers.value.length > 0)

  let generation = 0
  let recognition: SpeechRecognitionLike | null = null
  let recorder: MediaRecorderLike | null = null
  let stream: MediaStreamLike | null = null
  let chunks: Blob[] = []
  let chunkBytes = 0
  let startedAt = 0
  let baseDraft = ''
  let browserTranscript = ''
  let browserFailure: string | null = null
  let recorderFailure: string | null = null
  let stopRequested = false
  let durationTimer: ReturnType<typeof setTimeout> | null = null
  let uploadAbort: AbortController | null = null
  let recognitionStopped: Promise<void> = Promise.resolve()
  let settleRecognition: (() => void) | null = null
  let recorderStopped: Promise<void> = Promise.resolve()
  let settleRecorder: (() => void) | null = null

  function clearDurationTimer(): void {
    if (durationTimer) environment.clearTimer(durationTimer)
    durationTimer = null
  }

  function stopTracks(): void {
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
  }

  function startBrowser(token: number): void {
    if (!environment.recognition || !options.config().order.includes('browser')) return
    const next = new environment.recognition()
    recognition = next
    recognitionStopped = new Promise<void>((resolve) => { settleRecognition = resolve })
    next.continuous = true
    next.interimResults = true
    next.lang = environment.language || 'en-US'
    next.onstart = () => undefined
    next.onresult = (event) => {
      if (token !== generation) return
      let transcript = ''
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i]?.[0]?.transcript ?? ''
      }
      browserTranscript = transcript.trim()
    }
    next.onerror = (event) => {
      settleRecognition?.()
      settleRecognition = null
      if (token !== generation || event.error === 'aborted') return
      browserFailure = recognitionErrorMessage(event.error)
    }
    next.onend = () => {
      settleRecognition?.()
      settleRecognition = null
      if (token === generation) recognition = null
    }
    try {
      next.start()
    } catch {
      recognition = null
      settleRecognition?.()
      settleRecognition = null
      browserFailure = 'Browser voice input could not start'
    }
  }

  async function start(): Promise<void> {
    if (phase.value !== 'idle' || !supported.value) return
    const token = ++generation
    phase.value = 'starting'
    error.value = null
    notice.value = null
    baseDraft = draft.value.trimEnd()
    browserTranscript = ''
    browserFailure = null
    recorderFailure = null
    chunks = []
    chunkBytes = 0
    stopRequested = false
    currentProvider.value = viableTiers.value[0] ?? null

    const needsRecording = viableTiers.value.some((tier) => tier !== 'browser')
    if (needsRecording && environment.capture && environment.createRecorder) {
      try {
        stream = await environment.capture()
        if (token !== generation) {
          stopTracks()
          return
        }
        recorder = environment.createRecorder(stream)
        recorderStopped = new Promise<void>((resolve) => { settleRecorder = resolve })
        recorder.ondataavailable = (event) => {
          if (token !== generation || !event.data.size) return
          chunkBytes += event.data.size
          if (chunkBytes > MAX_RECORDING_BYTES) {
            recorderFailure = 'Recording is larger than 8 MiB'
            try { recorder?.stop() } catch { /* already stopped */ }
            void stop()
            return
          }
          chunks.push(event.data)
        }
        recorder.onerror = () => { recorderFailure = 'Microphone recording failed' }
        recorder.onstop = () => {
          settleRecorder?.()
          settleRecorder = null
        }
        recorder.start(1000)
      } catch (captureError) {
        stopTracks()
        recorder = null
        recorderFailure = (captureError as DOMException).name === 'NotAllowedError'
          ? 'Microphone access was denied'
          : 'Microphone recording could not start'
      }
    }

    startBrowser(token)
    if (!recorder && !recognition) {
      phase.value = 'idle'
      currentProvider.value = null
      error.value = recorderFailure ?? browserFailure ?? 'Voice input could not start'
      return
    }
    startedAt = environment.now()
    phase.value = 'recording'
    durationTimer = environment.setTimer(() => {
      notice.value = 'Maximum 60-second recording reached'
      void stop()
    }, MAX_RECORDING_MS)
    if (stopRequested) void stop()
  }

  async function stop(): Promise<void> {
    if (phase.value === 'starting') {
      stopRequested = true
      return
    }
    if (phase.value !== 'recording') return
    const token = generation
    clearDurationTimer()
    const durationMs = Math.max(1, Math.min(MAX_RECORDING_MS, Math.round(environment.now() - startedAt)))
    try { recognition?.stop() } catch { /* recognizer already ended */ }
    if (recorder?.state !== 'inactive') {
      try { recorder?.stop() } catch { settleRecorder?.() }
    }
    await Promise.all([recognitionStopped, recorderStopped])
    stopTracks()
    if (token !== generation) return
    phase.value = 'transcribing'

    const mimeType = recorder?.mimeType || chunks[0]?.type || 'audio/webm'
    const audio = chunks.length ? new Blob(chunks, { type: mimeType }) : null
    recorder = null
    const transcriptionAbort = new AbortController()
    uploadAbort = transcriptionAbort
    const failures: string[] = []
    for (const tier of options.config().order) {
      if (token !== generation) return
      currentProvider.value = tier
      if (tier === 'browser') {
        if (browserTranscript && !browserFailure) {
          draft.value = joinTranscript(baseDraft, browserTranscript)
          notice.value = 'Transcribed with Browser STT'
          finish()
          return
        }
        failures.push(browserFailure ?? 'Browser recognition returned no speech')
      } else if (!options.config()[tier] || !audio || recorderFailure) {
        failures.push(recorderFailure ?? `${tierLabel(tier)} is unavailable`)
      } else {
        try {
          notice.value = failures.length ? `${failures.at(-1)} · trying ${tierLabel(tier)}` : `Using ${tierLabel(tier)}`
          const transcript = await environment.transcribe(tier, audio, durationMs, transcriptionAbort.signal)
          if (token !== generation) return
          draft.value = joinTranscript(baseDraft, transcript)
          notice.value = `Transcribed with ${tierLabel(tier)}`
          finish()
          return
        } catch (providerError) {
          if (transcriptionAbort.signal.aborted || token !== generation) return
          failures.push((providerError as Error).message || `${tierLabel(tier)} failed`)
        }
      }
    }
    if (token !== generation) return
    error.value = failures.at(-1) ?? 'No configured voice-input provider succeeded'
    finish(false)
  }

  function finish(keepNotice = true): void {
    clearDurationTimer()
    stopTracks()
    recognition = null
    recorder = null
    chunks = []
    chunkBytes = 0
    uploadAbort = null
    currentProvider.value = null
    phase.value = 'idle'
    if (!keepNotice) notice.value = null
  }

  function cancel(): void {
    generation += 1
    clearDurationTimer()
    uploadAbort?.abort()
    uploadAbort = null
    try { recognition?.abort() } catch { /* recognizer already ended */ }
    recognition = null
    settleRecognition?.()
    settleRecognition = null
    try {
      if (recorder?.state !== 'inactive') recorder?.stop()
    } catch { /* recorder already stopped */ }
    recorder = null
    settleRecorder?.()
    settleRecorder = null
    stopTracks()
    chunks = []
    chunkBytes = 0
    currentProvider.value = null
    phase.value = 'idle'
    notice.value = 'Voice input cancelled'
  }

  return { supported, active, phase, currentProvider, error, notice, start, stop, cancel }
}

export function useSpeechRecognition(draft: Ref<string>) {
  const stt = useSttProvider()
  const controller = createSpeechRecognitionController(draft, { config: () => stt.config })
  onBeforeUnmount(controller.cancel)
  return controller
}
