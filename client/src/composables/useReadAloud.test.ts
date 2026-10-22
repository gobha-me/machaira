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
  error: { code: number } | null = null
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
  const unlock = vi.fn()
  const dispose = vi.fn()
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
      audios.push(audio)
      return {
        audio, unlock, dispose,
        setSource: () => {
          const release = vi.fn()
          releases.push(release)
          return release
        }
      }
    },
    fetchAudio
  }
  return { result, utterances, audios, releases, synthesis, fetchAudio, unlock, dispose }
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
      createAudio: null,
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

  it('reuses one audio element and releases each verse source', async () => {
    const { result, fetchAudio, audios, releases } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }, { n: 2, text: 'two' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    expect(controller.preparationTarget.value).toBe(1)
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(1))
    expect(fetchAudio).toHaveBeenCalledTimes(2)
    expect(fetchAudio.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['local', 'one'], ['local', 'two']
    ])
    expect(controller.preparedCount.value).toBe(1)
    audios[0].onended?.()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(2))
    expect(releases[0]).toHaveBeenCalledOnce()
    audios[0].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(releases[1]).toHaveBeenCalledOnce()
    expect(audios).toHaveLength(1)
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
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(1))
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
    result.createAudio = () => {
      const created = createAudio()
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
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    controller.start()
    await vi.waitFor(() => expect(releases).toHaveLength(2))

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
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(1))
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
    result.createAudio = () => {
      const created = createAudio()
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
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(2))
    expect(releases[0]).toHaveBeenCalledOnce()
    expect(controller.notice.value).toBe('Local TTS failed at verse 1; continuing with Cloud TTS')
    expect(fetchAudio.mock.calls.map((call) => call[0])).toEqual(['local', 'cloud'])
    audios[0].onended?.()
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
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(1))
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
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(1))
    controller.togglePlayback()
    audios[0].play.mockRejectedValueOnce(new Error('resume failed'))
    controller.togglePlayback()

    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(3))
    expect(controller.notice.value).toBe('Local TTS failed at verse 1; continuing with Cloud TTS')
    expect(fetchAudio.mock.calls.map((call) => call[0])).toEqual(['local', 'cloud'])
    audios[0].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
  })

  it('unlocks synchronously and plays the first verse while later verses remain unresolved', async () => {
    const { result, audios, unlock, releases } = environment()
    const resolvers: Array<() => void> = []
    let activeRequests = 0
    let peakRequests = 0
    result.fetchAudio = vi.fn(() => new Promise<Blob>((resolve) => {
      activeRequests += 1
      peakRequests = Math.max(peakRequests, activeRequests)
      resolvers.push(() => {
        activeRequests -= 1
        resolve(new Blob(['audio'], { type: 'audio/mpeg' }))
      })
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
    expect(audios).toHaveLength(1)
    expect(unlock).toHaveBeenCalledOnce()
    expect(unlock.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(result.fetchAudio).mock.invocationCallOrder[0]!)
    expect(result.fetchAudio).toHaveBeenCalledTimes(2)
    expect(controller.preparationTarget.value).toBe(1)
    expect(audios[0].play).not.toHaveBeenCalled()

    resolvers[0]!()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledOnce())
    expect(result.fetchAudio).toHaveBeenCalledTimes(3)
    expect(controller.preparing.value).toBe(false)
    expect(controller.preparationProgress.value).toBe(100)
    expect(peakRequests).toBe(2)
    expect(audios).toHaveLength(1)
    audios[0].onended?.()
    await vi.waitFor(() => expect(controller.preparing.value).toBe(true))
    expect(audios[0].play).toHaveBeenCalledOnce()
    controller.stop()
    expect(releases[0]).toHaveBeenCalledOnce()
    for (const resolve of resolvers) resolve()
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
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(1))
    audios[0]!.onended?.()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(2))
    audios[0]!.onended?.()
    await vi.waitFor(() => expect(attempts.get('five')).toBe(1))
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(3))
    audios[0]!.onended?.()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(4))
    audios[0]!.onended?.()
    await vi.waitFor(() => expect(attempts.get('five')).toBe(2))
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(5))
    audios[0]!.onended?.()

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
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(1))
    audios[0]!.onended?.()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(2))
    expect(controller.canPrevious.value).toBe(true)
    controller.previous()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(3))

    expect(fetchAudio.mock.calls.filter((call) => call[1] === 'one')).toHaveLength(1)
    expect(releases[1]).toHaveBeenCalledOnce()
    expect(controller.currentVerse.value).toBe(1)
    controller.stop()
  })

  it('does not let a later synthesis failure prevent or interrupt ready audio', async () => {
    const { result, audios } = environment()
    result.fetchAudio = vi.fn(async (_provider, text) => {
      if (text === 'two') throw new ApiError(503, { error: 'private provider details' })
      return new Blob(['audio'])
    })
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }, { n: 2, text: 'two' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledOnce())
    expect(controller.error.value).toBeNull()
    expect(controller.playing.value).toBe(true)
    expect(audios[0].pause).not.toHaveBeenCalled()
    audios[0].onended?.()
    await vi.waitFor(() => expect(controller.error.value).toContain('HTTP 503'))
    expect(controller.error.value).toContain('verse 2')
    expect(controller.error.value).not.toContain('private')
    expect(controller.completed.value).toBe(false)
    controller.stop()
  })

  it.each(['reject', 'throw', 'resume', 'foreign'] as const)('recovers from NotAllowedError (%s) without refetching or falling back', async (mode) => {
    const { result, audios, releases, fetchAudio } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['local', 'cloud'])
    }, result)
    controller.start()
    const blocked = new DOMException('secret browser diagnostic', 'NotAllowedError')
    if (mode === 'resume') {
      await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledOnce())
      controller.togglePlayback()
      audios[0].play.mockRejectedValueOnce(blocked)
      controller.togglePlayback()
    } else if (mode === 'foreign') {
      audios[0].play.mockRejectedValueOnce({ name: 'NotAllowedError', message: 'secret browser diagnostic' })
    } else if (mode === 'throw') {
      audios[0].play.mockImplementationOnce(() => { throw blocked })
    } else {
      audios[0].play.mockRejectedValueOnce(blocked)
    }
    await vi.waitFor(() => expect(controller.needsAudioGesture.value).toBe(true))
    expect(controller.error.value).toBeNull()
    expect(controller.notice.value).toBeNull()
    expect(controller.playing.value).toBe(false)
    expect(releases[0]).not.toHaveBeenCalled()
    const attempts = audios[0].play.mock.calls.length
    // A second denial must keep recovery available, including synchronous throws.
    audios[0].play.mockImplementationOnce(() => { throw blocked })
    controller.recoverAudio()
    expect(audios[0].play).toHaveBeenCalledTimes(attempts + 1)
    expect(controller.needsAudioGesture.value).toBe(true)
    controller.togglePlayback()
    expect(audios[0].play).toHaveBeenCalledTimes(attempts + 2)
    await vi.waitFor(() => expect(controller.needsAudioGesture.value).toBe(false))
    expect(controller.playing.value).toBe(true)
    expect(fetchAudio).toHaveBeenCalledOnce()
    expect(audios).toHaveLength(1)
    audios[0].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(releases[0]).toHaveBeenCalledOnce()
  })

  it('clears blocked playback on stop and ignores a late rejection after seeking', async () => {
    const { result, audios, releases, dispose } = environment()
    let rejectPlay!: (failure: Error) => void
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }, { n: 2, text: 'two' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)
    controller.start()
    audios[0].play.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject }))
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledOnce())
    controller.next()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledTimes(2))
    rejectPlay(new DOMException('blocked', 'NotAllowedError'))
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledOnce())
    expect(controller.needsAudioGesture.value).toBe(false)
    expect(controller.currentVerse.value).toBe(2)
    controller.togglePlayback()
    audios[0].play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
    controller.togglePlayback()
    await vi.waitFor(() => expect(controller.needsAudioGesture.value).toBe(true))
    controller.stop()
    controller.recoverAudio()
    expect(audios[0].play).toHaveBeenCalledTimes(3)
    expect(controller.needsAudioGesture.value).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
    expect(releases[1]).toHaveBeenCalledOnce()
    expect(controller.completed.value).toBe(false)
  })

  it.each([
    [new DOMException('token=secret', 'NotSupportedError'), 'audio format is not supported'],
    [new DOMException('token=secret', 'AbortError'), 'was interrupted'],
    [new TypeError('https://secret@example.com'), 'network request failed'],
    [new Error('token=secret'), 'remote playback failed unexpectedly'],
    ['secret', 'Generated audio could not be played']
  ])('reports a safe playback cause for %s', async (failure, expected) => {
    const { result, audios } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 9, text: 'nine' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)
    controller.start()
    audios[0].play.mockRejectedValueOnce(failure)
    await vi.waitFor(() => expect(controller.error.value).not.toBeNull())
    expect(controller.error.value?.toLowerCase()).toContain(expected.toLowerCase())
    expect(controller.error.value).not.toContain('secret')
    expect(controller.needsAudioGesture.value).toBe(false)
    controller.stop()
  })

  it.each([[2, 'download failed'], [3, 'could not be decoded'], [4, 'format is not supported']] as const)('reports media error code %s safely', async (code, expected) => {
    const { result, audios } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)
    controller.start()
    await vi.waitFor(() => expect(audios[0].play).toHaveBeenCalledOnce())
    audios[0].error = { code }
    audios[0].onerror?.()
    await vi.waitFor(() => expect(controller.error.value).toContain(expected))
    controller.stop()
  })

  it('does not allocate audio or synthesize for an empty chapter or disabled configuration', () => {
    const { result, audios, fetchAudio } = environment()
    for (const [verses, order] of [
      [[], ['local']], [[{ n: 1, text: 'one' }], []]
    ] as const) {
      const controller = createReadAloudController({
        verses: () => verses,
        startVerse: () => -1,
        config: () => config([...order])
      }, result)
      controller.start()
      expect(controller.active.value).toBe(false)
    }
    expect(audios).toHaveLength(0)
    expect(fetchAudio).not.toHaveBeenCalled()
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
