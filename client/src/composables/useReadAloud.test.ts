import { describe, expect, it, vi } from 'vitest'
import {
  createReadAloudController,
  type ReadAloudEnvironment
} from './useReadAloud'
import { ApiError, type TtsConfig } from '../services/api'

class FakeUtterance {
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null

  constructor(readonly text: string) {}
}

class FakeAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn<() => Promise<void>>(async () => undefined)
  pause = vi.fn()
}

function config(order: TtsConfig['order'] = ['browser']): TtsConfig {
  return {
    order,
    remoteAudioCacheSize: 4,
    local: {
      provider: 'openai-compatible', baseUrl: 'http://tts.local/v1',
      model: 'kokoro', voice: 'af_heart', hasApiKey: false
    },
    cloud: {
      provider: 'venice', baseUrl: 'https://api.venice.ai/api/v1',
      model: 'tts-kokoro', voice: 'af_sky', hasApiKey: true
    }
  }
}

function environment() {
  const utterances: FakeUtterance[] = []
  const audios: FakeAudio[] = []
  const releases: ReturnType<typeof vi.fn>[] = []
  const synthesis = {
    paused: false,
    speak: vi.fn((utterance: FakeUtterance) => utterances.push(utterance)),
    cancel: vi.fn(),
    pause: vi.fn(() => { synthesis.paused = true }),
    resume: vi.fn(() => { synthesis.paused = false })
  }
  const fetchAudio = vi.fn(async (
    _provider: 'local' | 'cloud',
    _text: string,
    _signal: AbortSignal
  ) => new Blob(['audio'], { type: 'audio/mpeg' }))
  const result: ReadAloudEnvironment = {
    synthesis,
    createUtterance: (text) => new FakeUtterance(text),
    createAudio: () => {
      const audio = new FakeAudio()
      const release = vi.fn()
      audios.push(audio)
      releases.push(release)
      return { audio, release }
    },
    fetchAudio
  }
  return { result, utterances, audios, releases, synthesis, fetchAudio }
}

describe('read-aloud controller', () => {
  it('reports an honest unsupported state and never invokes unlisted remote providers', () => {
    const fetchAudio = vi.fn(async () => new Blob(['audio']))
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'In the beginning' }],
      startVerse: () => null,
      config: () => config(['browser'])
    }, {
      synthesis: null,
      createUtterance: null,
      createAudio: () => ({ audio: new FakeAudio(), release: vi.fn() }),
      fetchAudio
    })

    expect(controller.supported.value).toBe(false)
    controller.start()
    expect(controller.active.value).toBe(false)
    expect(fetchAudio).not.toHaveBeenCalled()
  })

  it('starts browser speech at the selected verse and completes naturally', async () => {
    const complete = vi.fn()
    const { result, utterances } = environment()
    const controller = createReadAloudController({
      verses: () => [
        { n: 1, text: 'one' },
        { n: 2, text: 'two' },
        { n: 3, text: 'three' }
      ],
      startVerse: () => 2,
      config: () => config(['browser']),
      onComplete: complete
    }, result)

    controller.start()
    expect(controller.currentVerse.value).toBe(2)
    expect(controller.currentProvider.value).toBe('browser')
    expect(utterances.map((utterance) => utterance.text)).toEqual(['two'])
    utterances[0].onend?.()
    await vi.waitFor(() => expect(utterances).toHaveLength(2))
    expect(controller.currentVerse.value).toBe(3)
    utterances[1].onend?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(controller.progress.value).toBe(100)
    expect(complete).toHaveBeenCalledOnce()
  })

  it('prepares the bounded remote startup window and releases audio objects', async () => {
    const { result, fetchAudio, audios, releases } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }, { n: 2, text: 'two' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    expect(controller.preparationTarget.value).toBe(2)
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    expect(fetchAudio).toHaveBeenCalledTimes(2)
    expect(fetchAudio.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['local', 'one'], ['local', 'two']
    ])
    expect(controller.preparedCount.value).toBe(2)
    audios[0].onended?.()
    await vi.waitFor(() => expect(audios).toHaveLength(2))
    expect(releases[0]).toHaveBeenCalledOnce()
    audios[1].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(releases[1]).toHaveBeenCalledOnce()
  })

  it('shows remote preparation and ignores pause until audio is ready', async () => {
    let resolveFetch!: (blob: Blob) => void
    const { result, audios } = environment()
    result.fetchAudio = vi.fn(() => new Promise<Blob>((resolve) => {
      resolveFetch = resolve
    }))
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    expect(controller.preparing.value).toBe(true)
    expect(controller.playing.value).toBe(true)
    controller.togglePlayback()
    expect(controller.playing.value).toBe(true)

    resolveFetch(new Blob(['audio'], { type: 'audio/mpeg' }))
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    expect(controller.preparing.value).toBe(false)
    audios[0].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
  })

  it('defers URL release when restarting during a pending play attempt', async () => {
    let resolveFirstPlay!: () => void
    const complete = vi.fn()
    const { result, audios, releases } = environment()
    const createAudio = result.createAudio!
    let audioCount = 0
    result.createAudio = (blob) => {
      const created = createAudio(blob)
      if (audioCount === 0) {
        const audio = created.audio as FakeAudio
        audio.play.mockImplementationOnce(
          () => new Promise<void>((resolve) => { resolveFirstPlay = resolve })
        )
      }
      audioCount += 1
      return created
    }
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['local']),
      onComplete: complete
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(2))

    expect(audios[0].pause).toHaveBeenCalledOnce()
    expect(releases[0]).not.toHaveBeenCalled()
    expect(controller.error.value).toBeNull()
    expect(complete).not.toHaveBeenCalled()

    resolveFirstPlay()
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledOnce())
    audios[1].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(releases[1]).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })

  it('visibly falls back in the configured order without reaching cloud', async () => {
    const { result, utterances, fetchAudio, audios } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['browser', 'local', 'cloud'])
    }, result)

    controller.start()
    utterances[0].onerror?.({ error: 'synthesis-failed' })
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    expect(controller.notice.value).toBe('Browser voice failed at verse 1; continuing with Local TTS')
    expect(fetchAudio).toHaveBeenCalledWith('local', 'one', expect.any(AbortSignal))
    expect(fetchAudio.mock.calls.some((call) => call[0] === 'cloud')).toBe(false)
    audios[0].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
  })

  it('surfaces an initial remote playback failure through provider fallback', async () => {
    const { result, audios, releases, fetchAudio } = environment()
    const createAudio = result.createAudio!
    let audioCount = 0
    result.createAudio = (blob) => {
      const created = createAudio(blob)
      if (audioCount === 0) {
        const audio = created.audio as FakeAudio
        audio.play.mockRejectedValueOnce(new Error('playback blocked'))
      }
      audioCount += 1
      return created
    }
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['local', 'cloud'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(2))
    expect(releases[0]).toHaveBeenCalledOnce()
    expect(controller.notice.value).toBe('Local TTS failed at verse 1; continuing with Cloud TTS')
    expect(fetchAudio.mock.calls.map((call) => call[0])).toEqual(['local', 'cloud'])
    audios[1].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
  })

  it('falls back when browser speech stalls', async () => {
    vi.useFakeTimers()
    try {
      const { result, audios, synthesis } = environment()
      const controller = createReadAloudController({
        verses: () => [{ n: 1, text: 'one' }],
        startVerse: () => null,
        config: () => config(['browser', 'local'])
      }, result)

      controller.start()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(synthesis.cancel).toHaveBeenCalled()
      expect(audios).toHaveLength(1)
      expect(controller.notice.value).toBe('Browser voice failed at verse 1; continuing with Local TTS')
      audios[0].onended?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.completed.value).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses, resumes, and aborts pending remote work on stop', async () => {
    const request = { signal: null as AbortSignal | null }
    const { result, audios } = environment()
    result.fetchAudio = vi.fn(async (_provider, _text, signal) => {
      request.signal = signal
      return new Blob(['audio'])
    })
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    controller.togglePlayback()
    expect(audios[0].pause).toHaveBeenCalledOnce()
    expect(controller.playing.value).toBe(false)
    controller.togglePlayback()
    expect(audios[0].play).toHaveBeenCalledTimes(2)
    controller.stop()
    expect(request.signal?.aborted).toBe(true)
    expect(controller.active.value).toBe(false)
    expect(controller.currentVerse.value).toBeNull()
  })

  it('falls back when generated audio cannot resume', async () => {
    const { result, audios, fetchAudio } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['local', 'cloud'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    controller.togglePlayback()
    audios[0].play.mockRejectedValueOnce(new Error('resume failed'))
    controller.togglePlayback()

    await vi.waitFor(() => expect(audios).toHaveLength(2))
    expect(controller.notice.value).toBe('Local TTS failed at verse 1; continuing with Cloud TTS')
    expect(fetchAudio.mock.calls.map((call) => call[0])).toEqual(['local', 'cloud'])
    audios[1].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
  })

  it('waits for the configured startup target and runs at most two syntheses concurrently', async () => {
    const { result, audios } = environment()
    const resolvers: Array<() => void> = []
    let activeRequests = 0
    let peakRequests = 0
    result.fetchAudio = vi.fn((_provider, _text, signal) => new Promise<Blob>((resolve, reject) => {
      activeRequests += 1
      peakRequests = Math.max(peakRequests, activeRequests)
      const finish = () => {
        activeRequests -= 1
        resolve(new Blob(['audio'], { type: 'audio/mpeg' }))
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      resolvers.push(finish)
    }))
    const controller = createReadAloudController({
      verses: () => [
        { n: 1, text: 'one' }, { n: 2, text: 'two' },
        { n: 3, text: 'three' }, { n: 4, text: 'four' },
        { n: 5, text: 'five' }
      ],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(result.fetchAudio).toHaveBeenCalledTimes(2))
    expect(controller.preparationTarget.value).toBe(4)
    expect(controller.preparedCount.value).toBe(0)
    expect(audios).toHaveLength(0)

    resolvers[0]!()
    await vi.waitFor(() => expect(result.fetchAudio).toHaveBeenCalledTimes(3))
    expect(controller.preparedCount.value).toBe(1)
    expect(audios).toHaveLength(0)
    resolvers[1]!()
    await vi.waitFor(() => expect(result.fetchAudio).toHaveBeenCalledTimes(4))
    resolvers[2]!()
    resolvers[3]!()

    await vi.waitFor(() => expect(audios).toHaveLength(1))
    expect(controller.preparedCount.value).toBe(4)
    expect(controller.preparationProgress.value).toBe(100)
    expect(controller.preparing.value).toBe(false)
    expect(peakRequests).toBe(2)
    controller.stop()
  })

  it('retries a failed background prefetch when the verse reaches the playhead', async () => {
    const { result, audios } = environment()
    const attempts = new Map<string, number>()
    result.fetchAudio = vi.fn(async (_provider, text) => {
      const attempt = (attempts.get(text) ?? 0) + 1
      attempts.set(text, attempt)
      if (text === 'five' && attempt === 1) throw new Error('transient provider failure')
      return new Blob([text], { type: 'audio/mpeg' })
    })
    const controller = createReadAloudController({
      verses: () => [
        { n: 1, text: 'one' }, { n: 2, text: 'two' },
        { n: 3, text: 'three' }, { n: 4, text: 'four' },
        { n: 5, text: 'five' }
      ],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    audios[0]!.onended?.()
    await vi.waitFor(() => expect(audios).toHaveLength(2))
    audios[1]!.onended?.()
    await vi.waitFor(() => expect(attempts.get('five')).toBe(1))
    await vi.waitFor(() => expect(audios).toHaveLength(3))
    audios[2]!.onended?.()
    await vi.waitFor(() => expect(audios).toHaveLength(4))
    audios[3]!.onended?.()
    await vi.waitFor(() => expect(attempts.get('five')).toBe(2))
    await vi.waitFor(() => expect(audios).toHaveLength(5))
    audios[4]!.onended?.()

    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(controller.error.value).toBeNull()
  })

  it('replays the retained previous verse without another synthesis request', async () => {
    const { result, audios, fetchAudio, releases } = environment()
    const controller = createReadAloudController({
      verses: () => [
        { n: 1, text: 'one' }, { n: 2, text: 'two' },
        { n: 3, text: 'three' }, { n: 4, text: 'four' }
      ],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    audios[0]!.onended?.()
    await vi.waitFor(() => expect(audios).toHaveLength(2))
    expect(controller.canPrevious.value).toBe(true)
    controller.previous()
    await vi.waitFor(() => expect(audios).toHaveLength(3))

    expect(fetchAudio.mock.calls.filter((call) => call[1] === 'one')).toHaveLength(1)
    expect(releases[1]).toHaveBeenCalledOnce()
    expect(controller.currentVerse.value).toBe(1)
    controller.stop()
  })

  it('reports a tier and verse without exposing provider response bodies', async () => {
    const { result } = environment()
    result.fetchAudio = vi.fn(async () => {
      throw new ApiError(502, { error: 'secret upstream response body' })
    })
    const controller = createReadAloudController({
      verses: () => [{ n: 7, text: 'seven' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(controller.error.value).not.toBeNull())
    expect(controller.error.value).toContain('Local TTS failed at verse 7')
    expect(controller.error.value).toContain('HTTP 502')
    expect(controller.error.value).not.toContain('secret upstream response body')
  })
})
