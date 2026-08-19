import { computed, onBeforeUnmount, ref } from 'vue'

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

export interface SpeechSynthesisEnvironment {
  synthesis: SpeechSynthesisLike | null
  createUtterance: ((text: string) => SpeechSynthesisUtteranceLike) | null
}

export interface SpeechSynthesisOptions {
  verses: () => readonly SpokenVerse[]
  startVerse: () => number | null
  onComplete?: () => void
}

function browserEnvironment(): SpeechSynthesisEnvironment {
  const available = typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  if (!available) return { synthesis: null, createUtterance: null }
  return {
    synthesis: {
      get paused() { return window.speechSynthesis.paused },
      speak: (utterance) => window.speechSynthesis.speak(
        utterance as unknown as SpeechSynthesisUtterance
      ),
      cancel: () => window.speechSynthesis.cancel(),
      pause: () => window.speechSynthesis.pause(),
      resume: () => window.speechSynthesis.resume()
    },
    createUtterance: (text) => (
      new SpeechSynthesisUtterance(text) as unknown as SpeechSynthesisUtteranceLike
    )
  }
}

export function createSpeechSynthesisController(
  options: SpeechSynthesisOptions,
  environment: SpeechSynthesisEnvironment = browserEnvironment()
) {
  const supported = ref(!!environment.synthesis && !!environment.createUtterance)
  const active = ref(false)
  const playing = ref(false)
  const currentVerse = ref<number | null>(null)
  const completed = ref(false)
  const error = ref<string | null>(null)
  let generation = 0

  const progress = computed(() => {
    if (completed.value) return 100
    if (currentVerse.value == null) return 0
    const verses = options.verses()
    const index = verses.findIndex((verse) => verse.n === currentVerse.value)
    return index < 0 || !verses.length ? 0 : Math.round(((index + 1) / verses.length) * 100)
  })

  function start(): void {
    const synthesis = environment.synthesis
    const createUtterance = environment.createUtterance
    const verses = options.verses()
    if (!synthesis || !createUtterance || !verses.length) return

    const token = ++generation
    synthesis.cancel()
    active.value = true
    playing.value = true
    completed.value = false
    error.value = null

    const requestedVerse = options.startVerse()
    let index = Math.max(0, verses.findIndex((verse) => verse.n === requestedVerse))

    const speakNext = () => {
      if (token !== generation || !playing.value) return
      if (index >= verses.length) {
        playing.value = false
        completed.value = true
        options.onComplete?.()
        return
      }

      const verse = verses[index]
      currentVerse.value = verse.n
      const utterance = createUtterance(verse.text)
      utterance.onend = () => {
        if (token !== generation) return
        index += 1
        speakNext()
      }
      utterance.onerror = (event) => {
        if (token !== generation || event.error === 'canceled' || event.error === 'interrupted') return
        playing.value = false
        error.value = 'Read-aloud stopped unexpectedly'
      }
      synthesis.speak(utterance)
    }

    speakNext()
  }

  function toggle(): void {
    if (active.value) stop()
    else start()
  }

  function togglePlayback(): void {
    const synthesis = environment.synthesis
    if (!synthesis) return
    if (playing.value) {
      synthesis.pause()
      playing.value = false
      return
    }
    if (synthesis.paused && !completed.value) {
      synthesis.resume()
      playing.value = true
      return
    }
    start()
  }

  function stop(): void {
    generation += 1
    try {
      environment.synthesis?.cancel()
    } catch {
      // The browser speech queue is already empty.
    }
    active.value = false
    playing.value = false
    currentVerse.value = null
    completed.value = false
    error.value = null
  }

  return {
    supported,
    active,
    playing,
    currentVerse,
    completed,
    error,
    progress,
    start,
    toggle,
    togglePlayback,
    stop
  }
}

export function useSpeechSynthesis(options: SpeechSynthesisOptions) {
  const controller = createSpeechSynthesisController(options)
  onBeforeUnmount(controller.stop)
  return controller
}
