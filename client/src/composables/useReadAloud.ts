import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'
import { api, ApiError, type TtsConfig, type TtsTier } from '../services/api'
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
  readonly error?: { code: number } | null
  play(): Promise<void>
  pause(): void
}

class ReadAloudCancelledError extends Error {
  constructor() {
    super('Read-aloud was cancelled')
    this.name = 'ReadAloudCancelledError'
  }
}

export interface ReadAloudEnvironment {
  synthesis: SpeechSynthesisLike | null
  createUtterance: ((text: string) => SpeechSynthesisUtteranceLike) | null
  createAudio: (() => {
    audio: AudioLike
    unlock: () => void
    setSource: (blob: Blob) => () => void
    dispose: () => void
  }) | null
  fetchAudio: (provider: 'local' | 'cloud', text: string, signal: AbortSignal) => Promise<Blob>
}

export interface ReadAloudOptions {
  verses: () => readonly SpokenVerse[]
  startVerse: () => number | null
  config: () => TtsConfig
  onComplete?: () => void
}

type RemoteTier = 'local' | 'cloud'

interface RemoteEntry {
  key: string
  tier: RemoteTier
  index: number
  controller: AbortController
  promise: Promise<Blob>
  resolve: (blob: Blob) => void
  reject: (failure: Error) => void
  priority: 0 | 1
  started: boolean
  ready: boolean
}

const MAX_SYNTHESIS_CONCURRENCY = 2

class RemoteAudioBuffer {
  private readonly entries = new Map<string, RemoteEntry>()
  private readonly failedPrefetches = new Set<string>()
  private readonly queue: RemoteEntry[] = []
  private activeRequests = 0
  private cancelled = false

  constructor(
    private readonly verses: readonly SpokenVerse[],
    private readonly capacity: number,
    private readonly fetchAudio: ReadAloudEnvironment['fetchAudio']
  ) {}

  private key(tier: RemoteTier, index: number): string {
    return `${tier}:${index}`
  }

  isReady(tier: RemoteTier, index: number): boolean {
    return this.entries.get(this.key(tier, index))?.ready === true
  }

  private request(tier: RemoteTier, index: number, foreground: boolean): Promise<Blob> {
    if (this.cancelled) return Promise.reject(new ReadAloudCancelledError())
    const key = this.key(tier, index)
    if (foreground) this.failedPrefetches.delete(key)
    const existing = this.entries.get(key)
    if (existing) {
      if (foreground && !existing.started && existing.priority !== 0) {
        existing.priority = 0
        this.queue.sort((left, right) => left.priority - right.priority)
      }
      return existing.promise
    }

    let resolve!: (blob: Blob) => void
    let reject!: (failure: Error) => void
    const promise = new Promise<Blob>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    const entry: RemoteEntry = {
      key,
      tier,
      index,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      priority: foreground ? 0 : 1,
      started: false,
      ready: false
    }
    this.entries.set(key, entry)
    this.queue.push(entry)
    this.queue.sort((left, right) => left.priority - right.priority)
    if (!foreground) {
      void promise.catch((failure) => {
        if (!(failure instanceof ReadAloudCancelledError) && !entry.controller.signal.aborted) {
          this.failedPrefetches.add(key)
        }
      })
    }
    this.pump()
    return promise
  }

  private pump(): void {
    while (!this.cancelled
      && this.activeRequests < MAX_SYNTHESIS_CONCURRENCY
      && this.queue.length) {
      const entry = this.queue.shift()!
      if (this.entries.get(entry.key) !== entry) continue
      entry.started = true
      this.activeRequests += 1
      void this.fetchAudio(
        entry.tier,
        this.verses[entry.index]!.text,
        entry.controller.signal
      ).then((blob) => {
        if (this.entries.get(entry.key) !== entry) return
        entry.ready = true
        entry.resolve(blob)
      }, (failure) => {
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
        entry.reject(failure instanceof Error ? failure : new Error('Remote synthesis failed'))
      }).finally(() => {
        this.activeRequests -= 1
        this.pump()
      })
    }
  }

  private evict(entry: RemoteEntry): void {
    if (this.entries.get(entry.key) !== entry) return
    this.entries.delete(entry.key)
    this.failedPrefetches.delete(entry.key)
    if (entry.started) {
      entry.reject(new ReadAloudCancelledError())
      entry.controller.abort()
      return
    }
    const queued = this.queue.indexOf(entry)
    if (queued >= 0) this.queue.splice(queued, 1)
    entry.reject(new ReadAloudCancelledError())
  }

  clear(): void {
    for (const entry of [...this.entries.values()]) this.evict(entry)
    this.failedPrefetches.clear()
  }

  cancelAll(): void {
    this.cancelled = true
    this.clear()
  }

  current(tier: RemoteTier, index: number): Promise<Blob> {
    return this.request(tier, index, true)
  }

  maintain(tier: RemoteTier, playhead: number): void {
    const desired = new Set<number>([playhead])
    const previousKey = playhead > 0 ? this.key(tier, playhead - 1) : null
    if (previousKey && this.entries.has(previousKey)) desired.add(playhead - 1)

    for (let index = playhead + 1;
      index < this.verses.length && desired.size < this.capacity;
      index += 1) {
      desired.add(index)
    }
    for (let index = playhead - 2; index >= 0 && desired.size < this.capacity; index -= 1) {
      if (this.entries.has(this.key(tier, index))) desired.add(index)
    }

    for (const entry of [...this.entries.values()]) {
      if (entry.tier !== tier || !desired.has(entry.index)) this.evict(entry)
    }
    for (const failed of [...this.failedPrefetches]) {
      const separator = failed.indexOf(':')
      const failedTier = failed.slice(0, separator)
      const failedIndex = Number(failed.slice(separator + 1))
      if (failedTier !== tier || !desired.has(failedIndex)) this.failedPrefetches.delete(failed)
    }
    for (const index of desired) {
      const key = this.key(tier, index)
      if (!this.entries.has(key) && !this.failedPrefetches.has(key)) {
        void this.request(tier, index, false)
      }
    }
  }
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
    createAudio: audioAvailable ? () => {
      const audio = new Audio()
      return {
        audio: audio as unknown as AudioLike,
        unlock: () => {
          // Play a short silent PCM WAV during the click, before synthesis awaits.
          // Keep the element unmuted: muted autoplay need not grant audible playback.
          const samples = 800
          const wav = new Uint8Array(44 + samples)
          const view = new DataView(wav.buffer)
          const tag = (offset: number, text: string) => {
            for (let i = 0; i < text.length; i += 1) wav[offset + i] = text.charCodeAt(i)
          }
          tag(0, 'RIFF')
          view.setUint32(4, 36 + samples, true)
          tag(8, 'WAVEfmt ')
          view.setUint32(16, 16, true)
          view.setUint16(20, 1, true)
          view.setUint16(22, 1, true)
          view.setUint32(24, 8000, true)
          view.setUint32(28, 8000, true)
          view.setUint16(32, 1, true)
          view.setUint16(34, 8, true)
          tag(36, 'data')
          view.setUint32(40, samples, true)
          wav.fill(128, 44)
          audio.src = `data:audio/wav;base64,${btoa(String.fromCharCode(...wav))}`
          // Unlock is best effort; actual verse playback offers gesture recovery.
          void audio.play().catch(() => {})
        },
        setSource: (blob) => {
          const url = URL.createObjectURL(blob)
          audio.src = url
          return () => URL.revokeObjectURL(url)
        },
        dispose: () => {
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
        }
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

function copyConfig(config: TtsConfig): TtsConfig {
  return {
    order: [...config.order],
    local: config.local ? { ...config.local } : null,
    cloud: config.cloud ? { ...config.cloud } : null,
    remoteAudioCacheSize: config.remoteAudioCacheSize
  }
}

function failureDetail(tier: TtsTier, failure: unknown): string {
  if (failure instanceof ApiError) return `request failed (HTTP ${failure.status})`
  if (!(failure instanceof Error)) return 'an unexpected playback error occurred'
  if (failure.name === 'NotSupportedError') return 'the audio format is not supported by this browser'
  if (failure.name === 'AbortError') return 'the audio request or playback was interrupted'
  if (failure instanceof TypeError) return 'the network request failed; check the connection'
  const safeMessages = new Set([
    'Audio playback is unavailable in this browser',
    'Browser speech is unavailable',
    'Browser speech did not respond',
    'Browser speech stopped unexpectedly',
    'Generated audio could not be played',
    'Audio download failed',
    'Generated audio could not be decoded',
    'Audio format is not supported by this browser'
  ])
  if (safeMessages.has(failure.message)) return failure.message.toLowerCase()
  return tier === 'browser'
    ? 'browser speech failed unexpectedly'
    : 'remote playback failed unexpectedly'
}

export function createReadAloudController(
  options: ReadAloudOptions,
  environment: ReadAloudEnvironment = browserEnvironment()
) {
  const active = ref(false)
  const playing = ref(false)
  const preparing = ref(false)
  const needsAudioGesture = ref(false)
  const preparedCount = ref(0)
  const preparationTarget = ref(0)
  const currentVerse = ref<number | null>(null)
  const currentIndex = ref<number | null>(null)
  const currentProvider = ref<TtsTier | null>(null)
  const completed = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  let generation = 0
  let playbackGeneration = 0
  let config: TtsConfig | null = null
  let buffer: RemoteAudioBuffer | null = null
  let bufferedTier: RemoteTier | null = null
  let sessionAudio: ReturnType<NonNullable<ReadAloudEnvironment['createAudio']>> | null = null
  let currentAudio: AudioLike | null = null
  let retryAudio: (() => void) | null = null
  let cancelAudio: (() => void) | null = null
  let settleBrowser: ((failure?: Error) => void) | null = null
  let armBrowserWatchdog: (() => void) | null = null
  let browserWatchdog: ReturnType<typeof setTimeout> | null = null
  const unavailable = new Set<TtsTier>()

  const browserSupported = !!environment.synthesis && !!environment.createUtterance
  const remoteSupported = !!environment.createAudio
  const supported = computed(() => options.config().order.some((tier) => {
    if (tier === 'browser') return browserSupported
    return remoteSupported && !!options.config()[tier]
  }))
  const canPrevious = computed(() => active.value
    && !preparing.value
    && !error.value
    && currentIndex.value != null
    && currentIndex.value > 0)
  const canNext = computed(() => active.value
    && !preparing.value
    && !error.value
    && currentIndex.value != null
    && currentIndex.value + 1 < options.verses().length)

  const progress = computed(() => {
    if (completed.value) return 100
    if (currentVerse.value == null) return 0
    const verses = options.verses()
    const index = verses.findIndex((verse) => verse.n === currentVerse.value)
    return index < 0 || !verses.length ? 0 : Math.round(((index + 1) / verses.length) * 100)
  })

  const preparationProgress = computed(() => preparationTarget.value
    ? Math.round((preparedCount.value / preparationTarget.value) * 100)
    : 0)

  function clearBrowserTimer(): void {
    if (browserWatchdog) clearTimeout(browserWatchdog)
    browserWatchdog = null
  }

  function clearBrowserWatchdog(): void {
    clearBrowserTimer()
    armBrowserWatchdog = null
  }

  function cleanupAudio(): void {
    cancelAudio?.()
    cancelAudio = null
    retryAudio = null
    needsAudioGesture.value = false
    currentAudio = null
  }

  function cancelCurrentPlayback(): void {
    const settle = settleBrowser
    settleBrowser = null
    clearBrowserWatchdog()
    settle?.(new ReadAloudCancelledError())
    try {
      environment.synthesis?.cancel()
    } catch {
      // The browser speech queue is already empty.
    }
    cleanupAudio()
  }

  function cancelSession(): void {
    playbackGeneration += 1
    cancelCurrentPlayback()
    sessionAudio?.dispose()
    sessionAudio = null
    buffer?.cancelAll()
    buffer = null
    bufferedTier = null
    config = null
    preparing.value = false
    preparedCount.value = 0
    preparationTarget.value = 0
  }

  function playBrowser(text: string, token: number): Promise<void> {
    const synthesis = environment.synthesis
    const createUtterance = environment.createUtterance
    if (!synthesis || !createUtterance) return Promise.reject(new Error('Browser speech is unavailable'))
    return new Promise((resolve, reject) => {
      const utterance = createUtterance(text)
      let settled = false
      const finish = (failure?: Error) => {
        if (settled) return
        settled = true
        clearBrowserWatchdog()
        settleBrowser = null
        if (failure) reject(failure)
        else resolve()
      }
      const timeoutMs = Math.max(30_000, Math.min(120_000, text.length * 200))
      armBrowserWatchdog = () => {
        clearBrowserTimer()
        browserWatchdog = setTimeout(() => {
          finish(new Error('Browser speech did not respond'))
          try { synthesis.cancel() } catch { /* already stopped */ }
        }, timeoutMs)
      }
      settleBrowser = finish
      utterance.onend = () => finish()
      utterance.onerror = (event) => {
        if (token !== generation || event.error === 'canceled' || event.error === 'interrupted') {
          finish(new ReadAloudCancelledError())
          return
        }
        finish(new Error('Browser speech stopped unexpectedly'))
      }
      synthesis.speak(utterance)
      armBrowserWatchdog()
    })
  }

  async function playRemote(blob: Blob, token: number): Promise<void> {
    if (!sessionAudio) throw new Error('Audio playback is unavailable in this browser')
    if (token !== generation) throw new ReadAloudCancelledError()
    cleanupAudio()
    const created = sessionAudio
    const releaseSource = created.setSource(blob)
    currentAudio = created.audio
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let released = false
      let playSettled = false
      let releaseAfterPlaySettles = false

      const release = () => {
        if (released) return
        released = true
        releaseSource()
      }
      const clearOwnership = () => {
        created.audio.onended = null
        created.audio.onerror = null
        if (currentAudio !== created.audio) return
        currentAudio = null
        cancelAudio = null
        retryAudio = null
        needsAudioGesture.value = false
      }
      const finish = (failure?: Error, releaseNow = true) => {
        if (settled) return
        settled = true
        clearOwnership()
        if (releaseNow) release()
        if (failure) reject(failure)
        else resolve()
      }

      cancelAudio = () => {
        if (settled) return
        const releaseAfterPause = playSettled
        if (!releaseAfterPause) releaseAfterPlaySettles = true
        finish(new ReadAloudCancelledError(), false)
        created.audio.pause()
        if (releaseAfterPause) release()
      }
      created.audio.onended = () => finish()
      created.audio.onerror = () => {
        const messages: Record<number, string> = {
          2: 'Audio download failed',
          3: 'Generated audio could not be decoded',
          4: 'Audio format is not supported by this browser'
        }
        finish(new Error(messages[created.audio.error?.code ?? 0] ?? 'Generated audio could not be played'))
      }

      const playbackFailed = (failure: unknown) => {
        if (settled) return
        if (failure && typeof failure === 'object' && 'name' in failure && failure.name === 'NotAllowedError') {
          // Keep the ready source and provider: retry play() directly in the next click.
          needsAudioGesture.value = true
          playing.value = false
          return
        }
        finish(failure instanceof Error ? failure : new Error('Generated audio could not be played'))
      }
      const attemptPlay = () => {
        playing.value = true
        let playPromise: Promise<void>
        try {
          playSettled = false
          playPromise = created.audio.play()
        } catch (failure) {
          playSettled = true
          playbackFailed(failure)
          return
        }
        void playPromise.then(
          () => {
            playSettled = true
            if (releaseAfterPlaySettles) release()
            if (settled) return
            needsAudioGesture.value = false
          },
          (failure) => {
            playSettled = true
            if (releaseAfterPlaySettles) release()
            playbackFailed(failure)
          }
        )
      }
      retryAudio = attemptPlay
      attemptPlay()
    })
  }

  function isCurrentRun(token: number, playToken: number): boolean {
    return token === generation && playToken === playbackGeneration
  }

  async function currentRemoteBlob(
    tier: RemoteTier,
    index: number,
    token: number,
    playToken: number
  ): Promise<Blob> {
    if (!buffer) throw new ReadAloudCancelledError()
    if (buffer.isReady(tier, index)) return buffer.current(tier, index)
    preparing.value = true
    preparedCount.value = 0
    preparationTarget.value = 1
    try {
      const blob = await buffer.current(tier, index)
      if (isCurrentRun(token, playToken)) preparedCount.value = 1
      return blob
    } finally {
      if (isCurrentRun(token, playToken)) preparing.value = false
    }
  }

  async function playVerse(
    verse: SpokenVerse,
    index: number,
    token: number,
    playToken: number
  ): Promise<void> {
    const selected = config!
    const order = selected.order.filter((tier) => !unavailable.has(tier))
    let lastFailure = 'No read-aloud provider is available'
    for (const tier of order) {
      if (tier === 'browser' && !browserSupported) continue
      if (tier !== 'browser' && (!remoteSupported || !selected[tier])) continue
      try {
        currentProvider.value = tier
        currentVerse.value = verse.n
        currentIndex.value = index
        if (tier === 'browser') {
          await playBrowser(verse.text, token)
        } else {
          if (bufferedTier !== tier) {
            buffer?.clear()
            bufferedTier = tier
          }
          // Queue the playhead first; later syntheses must never gate its playback.
          const pending = currentRemoteBlob(tier, index, token, playToken)
          buffer?.maintain(tier, index)
          const blob = await pending
          if (!isCurrentRun(token, playToken)) throw new ReadAloudCancelledError()
          buffer?.maintain(tier, index)
          await playRemote(blob, token)
        }
        return
      } catch (failure) {
        if (!isCurrentRun(token, playToken) || failure instanceof ReadAloudCancelledError) throw failure
        lastFailure = `${tierLabel(tier)} failed at verse ${verse.n}: ${failureDetail(tier, failure)}. Check Listening settings and provider availability.`
        unavailable.add(tier)
        if (tier !== 'browser') {
          buffer?.clear()
          bufferedTier = null
        }
        const next = order.find((candidate) => {
          if (unavailable.has(candidate)) return false
          if (candidate === 'browser') return browserSupported
          return remoteSupported && !!selected[candidate]
        })
        notice.value = next
          ? `${tierLabel(tier)} failed at verse ${verse.n}; continuing with ${tierLabel(next)}`
          : null
      }
    }
    throw new Error(lastFailure)
  }

  async function run(token: number, playToken: number, startIndex: number): Promise<void> {
    const verses = options.verses()
    try {
      for (let index = startIndex; index < verses.length; index += 1) {
        if (!isCurrentRun(token, playToken)) return
        await playVerse(verses[index]!, index, token, playToken)
      }
      if (!isCurrentRun(token, playToken)) return
      playing.value = false
      completed.value = true
      currentProvider.value = null
      options.onComplete?.()
    } catch (failure) {
      if (!isCurrentRun(token, playToken) || failure instanceof ReadAloudCancelledError) return
      playing.value = false
      error.value = (failure as Error).message
      currentProvider.value = null
    }
  }

  function beginRun(startIndex: number): void {
    const token = generation
    const playToken = ++playbackGeneration
    cancelCurrentPlayback()
    playing.value = true
    completed.value = false
    error.value = null
    notice.value = null
    void run(token, playToken, startIndex)
  }

  function start(): void {
    const verses = options.verses()
    if (!supported.value || !verses.length) return
    generation += 1
    cancelSession()
    unavailable.clear()
    config = copyConfig(options.config())
    if (config.order.some((tier) => tier !== 'browser' && config![tier]) && environment.createAudio) {
      // start() is called synchronously by Listen (also when browser speech is first).
      try {
        sessionAudio = environment.createAudio()
        sessionAudio.unlock()
      } catch {
        // An unlock failure must not prevent synthesis or explicit tap recovery.
      }
    }
    buffer = new RemoteAudioBuffer(verses, config.remoteAudioCacheSize, environment.fetchAudio)
    active.value = true
    playing.value = true
    completed.value = false
    error.value = null
    notice.value = null
    currentVerse.value = null
    currentIndex.value = null
    currentProvider.value = null
    const requestedVerse = options.startVerse()
    const found = verses.findIndex((verse) => verse.n === requestedVerse)
    beginRun(Math.max(0, found))
  }

  function toggle(): void {
    if (active.value) stop()
    else start()
  }

  function recoverAudio(): void {
    if (!needsAudioGesture.value) return
    needsAudioGesture.value = false
    retryAudio?.()
  }

  function togglePlayback(): void {
    if (needsAudioGesture.value) {
      recoverAudio()
      return
    }
    if (completed.value || error.value) {
      start()
      return
    }
    if (!active.value) {
      start()
      return
    }
    if (preparing.value) return
    if (playing.value) {
      if (currentProvider.value === 'browser') {
        clearBrowserTimer()
        environment.synthesis?.pause()
      } else {
        currentAudio?.pause()
      }
      playing.value = false
      return
    }
    if (currentProvider.value === 'browser' && environment.synthesis?.paused) {
      environment.synthesis.resume()
      armBrowserWatchdog?.()
      playing.value = true
    } else if (currentAudio) {
      retryAudio?.()
    }
  }

  function seek(offset: -1 | 1): void {
    if (!active.value || preparing.value || currentIndex.value == null) return
    const target = currentIndex.value + offset
    if (target < 0 || target >= options.verses().length) return
    beginRun(target)
  }

  function previous(): void {
    seek(-1)
  }

  function next(): void {
    seek(1)
  }

  function stop(): void {
    generation += 1
    cancelSession()
    unavailable.clear()
    active.value = false
    playing.value = false
    currentVerse.value = null
    currentIndex.value = null
    currentProvider.value = null
    completed.value = false
    error.value = null
    notice.value = null
  }

  return {
    supported: supported as ComputedRef<boolean>,
    active,
    playing,
    preparing,
    needsAudioGesture,
    preparedCount,
    preparationTarget,
    preparationProgress,
    currentVerse,
    currentProvider,
    completed,
    error,
    notice,
    progress,
    canPrevious,
    canNext,
    start,
    toggle,
    togglePlayback,
    recoverAudio,
    previous,
    next,
    stop
  }
}

export function useReadAloud(options: Omit<ReadAloudOptions, 'config'>) {
  const tts = useTtsProvider()
  const controller = createReadAloudController({ ...options, config: () => tts.config })
  watch(() => tts.config, controller.stop, { deep: true })
  onBeforeUnmount(controller.stop)
  return controller
}
