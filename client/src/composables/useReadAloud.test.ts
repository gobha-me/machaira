import { describe, expect, it, vi } from 'vitest'
import {
  createReadAloudController,
  type ReadAloudEnvironment
} from './useReadAloud'
import type { TtsConfig } from '../services/api'

class FakeUtterance {
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null

  constructor(readonly text: string) {}
}

class FakeAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn(async () => undefined)
  pause = vi.fn()
}

function config(order: TtsConfig['order'] = ['browser']): TtsConfig {
  return {
    order,
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

  it('prefetches one remote verse and releases audio objects', async () => {
    const { result, fetchAudio, audios, releases } = environment()
    const controller = createReadAloudController({
      verses: () => [{ n: 1, text: 'one' }, { n: 2, text: 'two' }],
      startVerse: () => null,
      config: () => config(['local'])
    }, result)

    controller.start()
    await vi.waitFor(() => expect(audios).toHaveLength(1))
    expect(fetchAudio).toHaveBeenCalledTimes(2)
    expect(fetchAudio.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['local', 'one'], ['local', 'two']
    ])
    audios[0].onended?.()
    await vi.waitFor(() => expect(audios).toHaveLength(2))
    expect(releases[0]).toHaveBeenCalledOnce()
    audios[1].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(releases[1]).toHaveBeenCalledOnce()
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
    expect(controller.notice.value).toBe('Browser voice failed; continuing with Local TTS')
    expect(fetchAudio).toHaveBeenCalledWith('local', 'one', expect.any(AbortSignal))
    expect(fetchAudio.mock.calls.some((call) => call[0] === 'cloud')).toBe(false)
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
      expect(controller.notice.value).toBe('Browser voice failed; continuing with Local TTS')
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
    expect(controller.notice.value).toBe('Local TTS failed; continuing with Cloud TTS')
    expect(fetchAudio.mock.calls.map((call) => call[0])).toEqual(['local', 'cloud'])
    audios[1].onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
  })
})
