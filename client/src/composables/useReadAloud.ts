import { computed, onBeforeUnmount, ref, type ComputedRef } from 'vue'
import { api, type TtsConfig, type TtsTier } from '../services/api'
import { useTtsProvider } from '../stores/ttsProvider'

export interface SpokenVerse {
  n: number
  text: string
}

interface SpeechSynthesisUtteranceLike {
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}

interface SpeechSynthesisLike {
  readonly paused: boolean
  speak(utterance: SpeechSynthesisUtteranceLike): void
  cancel(): void
  pause(): void
  resume(): void
}

interface AudioLike {
  onended: (() => void) | null
  onerror: (() => void) | null
  play(): Promise<void>
  pause(): void
}

export interface ReadAloudEnvironment {
  synthesis: SpeechSynthesisLike | null
  createUtterance: ((text: string) => SpeechSynthesisUtteranceLike) | null
  createAudio: ((blob: Blob) => { audio: AudioLike; release: () => void }) | null
  fetchAudio: (provider: 'local' | 'cloud', text: string, signal: AbortSignal) => Promise<Blob>
}

export interface ReadAloudOptions {
  verses: () => readonly SpokenVerse[]
  startVerse: () => number | null
  config: () => TtsConfig
  onComplete?: () => void
}

function browserEnvironment(): ReadAloudEnvironment {
  const speechAvailable = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof SpeechSynthesisUtterance !== 'undefined'
  const audioAvailable = typeof Audio !== 'undefined'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function'
  return {
    synthesis: speechAvailable ? {
      get paused() { return window.speechSynthesis.paused },
      speak: (utterance) => window.speechSynthesis.speak(
        utterance as unknown as SpeechSynthesisUtterance
      ),
      cancel: () => window.speechSynthesis.cancel(),
      pause: () => window.speechSynthesis.pause(),
      resume: () => window.speechSynthesis.resume()
    } : null,
    createUtterance: speechAvailable
      ? (text) => new SpeechSynthesisUtterance(text) as unknown as SpeechSynthesisUtteranceLike
      : null,
    createAudio: audioAvailable ? (blob) => {
      const url = URL.createObjectURL(blob)
      return {
        audio: new Audio(url) as unknown as AudioLike,
        release: () => URL.revokeObjectURL(url)
      }
    } : null,
    fetchAudio: (provider, text, signal) => api.ttsSpeech(provider, text, signal)
  }
}

function tierLabel(tier: TtsTier): string {
  if (tier === 'browser') return 'Browser voice'
  if (tier === 'local') return 'Local TTS'
  return 'Cloud TTS'
}

export function createReadAloudController(
  options: ReadAloudOptions,
  environment: ReadAloudEnvironment = browserEnvironment()
) {
  const active = ref(false)
  const playing = ref(false)
  const currentVerse = ref<number | null>(null)
  const currentProvider = ref<TtsTier | null>(null)
  const completed = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  let generation = 0
  let abort: AbortController | null = null
  let currentAudio: AudioLike | null = null
  let releaseAudio: (() => void) | null = null
  let settleAudio: ((failure?: Error) => void) | null = null
  let settleBrowser: ((failure?: Error) => void) | null = null
  let armBrowserWatchdog: (() => void) | null = null
  let browserWatchdog: ReturnType<typeof setTimeout> | null = null
  const audioCache = new Map<string, Promise<Blob>>()
  const unavailable = new Set<TtsTier>()

  const browserSupported = !!environment.synthesis && !!environment.createUtterance
  const remoteSupported = !!environment.createAudio
  const supported = computed(() => options.config().order.some((tier) => {
    if (tier === 'browser') return browserSupported
    return remoteSupported && !!options.config()[tier]
  }))

  const progress = computed(() => {
    if (completed.value) return 100
    if (currentVerse.value == null) return 0
    const verses = options.verses()
    const index = verses.findIndex((verse) => verse.n === currentVerse.value)
    return index < 0 || !verses.length ? 0 : Math.round(((index + 1) / verses.length) * 100)
  })

  function cleanupAudio(): void {
    const settle = settleAudio
    settleAudio = null
    currentAudio?.pause()
    currentAudio = null
    releaseAudio?.()
    releaseAudio = null
    settle?.()
  }

  function cancelPlayback(): void {
    abort?.abort()
    abort = null
    settleBrowser?.()
    settleBrowser = null
    armBrowserWatchdog = null
    if (browserWatchdog) clearTimeout(browserWatchdog)
    browserWatchdog = null
    try {
      environment.synthesis?.cancel()
    } catch {
      // The browser speech queue is already empty.
    }
    cleanupAudio()
    audioCache.clear()
  }

  function fetchVerse(tier: 'local' | 'cloud', verse: SpokenVerse, index: number): Promise<Blob> {
    const key = `${tier}:${index}`
    const existing = audioCache.get(key)
    if (existing) return existing
    if (!abort) return Promise.reject(new Error('Read-aloud was cancelled'))
    const request = environment.fetchAudio(tier, verse.text, abort.signal)
    audioCache.set(key, request)
    return request
  }

  function playBrowser(text: string, token: number): Promise<void> {
    const synthesis = environment.synthesis
    const createUtterance = environment.createUtterance
    if (!synthesis || !createUtterance) return Promise.reject(new Error('Browser speech is unavailable'))
    return new Promise((resolve, reject) => {
      const utterance = createUtterance(text)
      const finish = (failure?: Error) => {
        if (browserWatchdog) clearTimeout(browserWatchdog)
        browserWatchdog = null
        armBrowserWatchdog = null
        settleBrowser = null
        if (failure) reject(failure)
        else resolve()
      }
      const timeoutMs = Math.max(30_000, Math.min(120_000, text.length * 200))
      armBrowserWatchdog = () => {
        if (browserWatchdog) clearTimeout(browserWatchdog)
        browserWatchdog = setTimeout(() => {
          finish(new Error('Browser speech did not respond'))
          try { synthesis.cancel() } catch { /* already stopped */ }
        }, timeoutMs)
      }
      settleBrowser = finish
      utterance.onend = () => finish()
      utterance.onerror = (event) => {
        if (token !== generation || event.error === 'canceled' || event.error === 'interrupted') {
          finish()
          return
        }
        finish(new Error('Browser speech stopped unexpectedly'))
      }
      synthesis.speak(utterance)
      armBrowserWatchdog()
    })
  }

  async function playRemote(
    tier: 'local' | 'cloud',
    verse: SpokenVerse,
    index: number,
    verses: readonly SpokenVerse[],
    token: number
  ): Promise<void> {
    if (!environment.createAudio) throw new Error('Audio playback is unavailable in this browser')
    const blob = await fetchVerse(tier, verse, index)
    if (token !== generation) throw new Error('Read-aloud was cancelled')
    cleanupAudio()
    const created = environment.createAudio(blob)
    currentAudio = created.audio
    releaseAudio = created.release
    if (index + 1 < verses.length) {
      void fetchVerse(tier, verses[index + 1], index + 1).catch(() => undefined)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (failure?: Error) => {
          if (settleAudio !== finish) return
          settleAudio = null
          if (failure) reject(failure)
          else resolve()
        }
        settleAudio = finish
        created.audio.onended = () => finish()
        created.audio.onerror = () => finish(new Error('Generated audio could not be played'))
        created.audio.play().catch((failure) => finish(
          failure instanceof Error ? failure : new Error('Generated audio could not be played')
        ))
      })
    } finally {
      cleanupAudio()
    }
  }

  async function playVerse(verse: SpokenVerse, index: number, token: number): Promise<void> {
    const verses = options.verses()
    const order = options.config().order.filter((tier) => !unavailable.has(tier))
    let lastFailure = 'No read-aloud provider is available'
    for (const tier of order) {
      if (tier === 'browser' && !browserSupported) continue
      if (tier !== 'browser' && (!remoteSupported || !options.config()[tier])) continue
      try {
        currentProvider.value = tier
        currentVerse.value = verse.n
        if (tier === 'browser') await playBrowser(verse.text, token)
        else await playRemote(tier, verse, index, verses, token)
        return
      } catch (failure) {
        if (token !== generation || abort?.signal.aborted) throw failure
        lastFailure = (failure as Error).message
        unavailable.add(tier)
        const next = order.find((candidate) => {
          if (unavailable.has(candidate)) return false
          if (candidate === 'browser') return browserSupported
          return remoteSupported && !!options.config()[candidate]
        })
        notice.value = next
          ? `${tierLabel(tier)} failed; continuing with ${tierLabel(next)}`
          : null
      }
    }
    throw new Error(lastFailure)
  }

  async function run(token: number, startIndex: number): Promise<void> {
    const verses = options.verses()
    try {
      for (let index = startIndex; index < verses.length; index += 1) {
        if (token !== generation) return
        await playVerse(verses[index], index, token)
      }
      if (token !== generation) return
      playing.value = false
      completed.value = true
      currentProvider.value = null
      options.onComplete?.()
    } catch (failure) {
      if (token !== generation || abort?.signal.aborted) return
      playing.value = false
      error.value = (failure as Error).message
      currentProvider.value = null
    }
  }

  function start(): void {
    const verses = options.verses()
    if (!supported.value || !verses.length) return
    cancelPlayback()
    unavailable.clear()
    const token = ++generation
    abort = new AbortController()
    active.value = true
    playing.value = true
    completed.value = false
    error.value = null
    notice.value = null
    currentVerse.value = null
    const requestedVerse = options.startVerse()
    const found = verses.findIndex((verse) => verse.n === requestedVerse)
    void run(token, Math.max(0, found))
  }

  function toggle(): void {
    if (active.value) stop()
    else start()
  }

  function togglePlayback(): void {
    if (completed.value || error.value) {
      start()
      return
    }
    if (!active.value) {
      start()
      return
    }
    if (playing.value) {
      if (currentProvider.value === 'browser') {
        if (browserWatchdog) clearTimeout(browserWatchdog)
        browserWatchdog = null
        environment.synthesis?.pause()
      }
      else currentAudio?.pause()
      playing.value = false
      return
    }
    if (currentProvider.value === 'browser' && environment.synthesis?.paused) {
      environment.synthesis.resume()
      armBrowserWatchdog?.()
    } else if (currentAudio) {
      void currentAudio.play().catch((failure) => {
        settleAudio?.(failure instanceof Error
          ? failure
          : new Error('Generated audio could not be resumed'))
      })
    }
    playing.value = true
  }

  function stop(): void {
    generation += 1
    cancelPlayback()
    unavailable.clear()
    active.value = false
    playing.value = false
    currentVerse.value = null
    currentProvider.value = null
    completed.value = false
    error.value = null
    notice.value = null
  }

  return {
    supported: supported as ComputedRef<boolean>,
    active,
    playing,
    currentVerse,
    currentProvider,
    completed,
    error,
    notice,
    progress,
    start,
    toggle,
    togglePlayback,
    stop
  }
}

export function useReadAloud(options: Omit<ReadAloudOptions, 'config'>) {
  const tts = useTtsProvider()
  const controller = createReadAloudController({ ...options, config: () => tts.config })
  onBeforeUnmount(controller.stop)
  return controller
}
