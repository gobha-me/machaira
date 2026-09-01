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
  createAudio: ((blob: Blob) => { audio: AudioLike; release: () => void }) | null
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

  async prepare(
    tier: RemoteTier,
    startIndex: number,
    onReady: () => void
  ): Promise<number> {
    this.clear()
    const target = Math.min(this.capacity, this.verses.length - startIndex)
    const requests: Promise<Blob>[] = []
    for (let index = startIndex; index < startIndex + target; index += 1) {
      requests.push(this.request(tier, index, true).then((blob) => {
        onReady()
        return blob
      }))
    }
    await Promise.all(requests)
    return target
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
  const safeMessages = new Set([
    'Audio playback is unavailable in this browser',
    'Browser speech is unavailable',
    'Browser speech did not respond',
    'Browser speech stopped unexpectedly',
    'Generated audio could not be played',
    'Generated audio could not be resumed'
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
  let currentAudio: AudioLike | null = null
  let cancelAudio: (() => void) | null = null
  let failAudio: ((failure: Error) => void) | null = null
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
    failAudio = null
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
    if (!environment.createAudio) throw new Error('Audio playback is unavailable in this browser')
    if (token !== generation) throw new ReadAloudCancelledError()
    cleanupAudio()
    const created = environment.createAudio(blob)
    currentAudio = created.audio
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let released = false
      let playSettled = false
      let releaseAfterPlaySettles = false

      const release = () => {
        if (released) return
        released = true
        created.release()
      }
      const clearOwnership = () => {
        created.audio.onended = null
        created.audio.onerror = null
        if (currentAudio !== created.audio) return
        currentAudio = null
        cancelAudio = null
        failAudio = null
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
      failAudio = (failure) => finish(failure)
      created.audio.onended = () => finish()
      created.audio.onerror = () => finish(new Error('Generated audio could not be played'))

      let playPromise: Promise<void>
      try {
        playPromise = created.audio.play()
      } catch (failure) {
        playSettled = true
        finish(failure instanceof Error ? failure : new Error('Generated audio could not be played'))
        return
      }
      void playPromise.then(
        () => {
          playSettled = true
          if (releaseAfterPlaySettles) release()
        },
        (failure) => {
          playSettled = true
          if (releaseAfterPlaySettles) release()
          finish(failure instanceof Error ? failure : new Error('Generated audio could not be played'))
        }
      )
    })
  }

  function isCurrentRun(token: number, playToken: number): boolean {
    return token === generation && playToken === playbackGeneration
  }

  async function prepareRemote(
    tier: RemoteTier,
    index: number,
    token: number,
    playToken: number
  ): Promise<void> {
    if (!buffer) throw new ReadAloudCancelledError()
    preparing.value = true
    preparedCount.value = 0
    preparationTarget.value = Math.min(config!.remoteAudioCacheSize, options.verses().length - index)
    try {
      await buffer.prepare(tier, index, () => {
        if (isCurrentRun(token, playToken)) preparedCount.value += 1
      })
      bufferedTier = tier
    } finally {
      if (isCurrentRun(token, playToken)) preparing.value = false
    }
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
          if (bufferedTier !== tier) await prepareRemote(tier, index, token, playToken)
          if (!isCurrentRun(token, playToken)) throw new ReadAloudCancelledError()
          const blob = await currentRemoteBlob(tier, index, token, playToken)
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

  function togglePlayback(): void {
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
    } else if (currentAudio) {
      void currentAudio.play().catch((failure) => {
        failAudio?.(failure instanceof Error
          ? failure
          : new Error('Generated audio could not be resumed'))
      })
    }
    playing.value = true
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
