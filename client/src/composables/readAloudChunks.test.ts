import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReadAloudController, type ReadAloudEnvironment, type SpokenVerse } from './useReadAloud'
import { ApiError, type TtsConfig } from '../services/api'
import { MAX_SPEECH_CHARS } from '../utils/speechChunks'

class PlaybackAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn(async () => {})
  pause = vi.fn()
}

const controllers: ReturnType<typeof createReadAloudController>[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop()
})

const longText = `${'a'.repeat(500)}${'b'.repeat(500)}${'c'.repeat(100)}`

function setup(verses: SpokenVerse[], startVerse: number | null = null) {
  const audio = new PlaybackAudio()
  const fetchAudio = vi.fn<ReadAloudEnvironment['fetchAudio']>(async () => new Blob(['encoded audio']))
  const setSource = vi.fn((_blob: Blob) => vi.fn())
  const createAudio = vi.fn(() => ({ audio, setSource, unlock: vi.fn(), dispose: vi.fn() }))
  const config: TtsConfig = {
    order: ['local'], remoteAudioCacheSize: 4,
    local: { provider: 'openai-compatible', baseUrl: 'http://tts.local/v1', model: 'kokoro', voice: 'af_heart', hasApiKey: false },
    cloud: null
  }
  const environment: ReadAloudEnvironment = {
    synthesis: null, createUtterance: null, createAudio,
    fetchAudio: (tier, text, signal) => fetchAudio(tier, text, signal)
  }
  const controller = createReadAloudController({ verses: () => verses, startVerse: () => startVerse, config: () => config }, environment)
  controllers.push(controller)
  return { controller, fetchAudio, audio, createAudio, setSource }
}

describe('read-aloud chunk queue', () => {
  it('serializes capped syntheses, prefetches ahead of playback, and reuses one audio element', async () => {
    const { controller, fetchAudio, audio, createAudio, setSource } = setup([{ n: 7, text: longText }])
    const pending: Array<(blob: Blob) => void> = []
    fetchAudio.mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
    controller.start()
    expect(fetchAudio).toHaveBeenCalledTimes(1)
    expect(controller.preparationTarget.value).toBe(1)
    pending[0]!(new Blob(['first']))
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1))
    expect(fetchAudio).toHaveBeenCalledTimes(2)
    expect(controller.preparedCount.value).toBe(0)
    pending[1]!(new Blob(['second']))
    await vi.waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(3))
    pending[2]!(new Blob(['third']))
    await vi.waitFor(() => expect(controller.preparedCount.value).toBe(1))
    expect(audio.play).toHaveBeenCalledTimes(1)
    const progress = controller.progress.value
    audio.onended?.()
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2))
    expect(controller.currentVerse.value).toBe(7)
    expect(controller.progress.value).toBeGreaterThan(progress)
    expect(controller.canPrevious.value).toBe(false)
    expect(controller.canNext.value).toBe(false)
    audio.onended?.()
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(3))
    audio.onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
    expect(fetchAudio.mock.calls.map((call) => call[1]).join('')).toBe(longText)
    expect(fetchAudio.mock.calls.every((call) => call[1].length <= MAX_SPEECH_CHARS)).toBe(true)
    expect(createAudio).toHaveBeenCalledOnce()
    expect(setSource).toHaveBeenCalledTimes(3)
  })

  it('informs the user about a failed middle chunk and retries that chunk without replaying earlier audio', async () => {
    const { controller, fetchAudio, audio } = setup([{ n: 7, text: longText }])
    let failures = 0
    fetchAudio.mockImplementation(async (_tier, text) => {
      if (text.startsWith('b') && failures++ < 2) throw new ApiError(503, { error: 'private provider body' })
      return new Blob(['encoded audio'])
    })
    controller.start()
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1))
    audio.onended?.()
    await vi.waitFor(() => expect(controller.error.value).toContain('HTTP 503'))
    expect(controller.error.value).toContain('verse 7')
    expect(controller.error.value).not.toContain('private')
    controller.retry()
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2))
    expect(controller.error.value).toBeNull()
    expect(fetchAudio.mock.calls.filter((call) => call[1].startsWith('a'))).toHaveLength(1)
    expect(fetchAudio.mock.calls.filter((call) => call[1].startsWith('b'))).toHaveLength(3)
    audio.onended?.()
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(3))
    audio.onended?.()
    await vi.waitFor(() => expect(controller.completed.value).toBe(true))
  })

  it('aborts an in-flight later chunk on stop and ignores its late completion', async () => {
    const { controller, fetchAudio, audio, setSource } = setup([{ n: 7, text: longText }])
    const pending: Array<(blob: Blob) => void> = []
    fetchAudio.mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
    controller.start()
    pending[0]!(new Blob(['first']))
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1))
    expect(fetchAudio).toHaveBeenCalledTimes(2)
    const laterSignal = fetchAudio.mock.calls[1]![2]
    controller.stop()
    expect(laterSignal.aborted).toBe(true)
    pending[1]!(new Blob(['late second']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchAudio).toHaveBeenCalledTimes(2)
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(setSource).toHaveBeenCalledOnce()
    expect(controller.active.value).toBe(false)
  })

  it('makes no requests for empty or whitespace verses', () => {
    for (const verses of [[], [{ n: 1, text: '' }], [{ n: 1, text: ' \n\t' }]]) {
      const { controller, fetchAudio, createAudio } = setup(verses)
      controller.start()
      expect(fetchAudio).not.toHaveBeenCalled()
      expect(createAudio).not.toHaveBeenCalled()
      expect(controller.active.value).toBe(false)
    }
  })

  it('keeps selection and navigation at verse boundaries across chunked verses', async () => {
    const { controller, audio } = setup([{ n: 1, text: longText }, { n: 2, text: 'Next verse.' }])
    controller.start()
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1))
    expect(controller.canNext.value).toBe(true)
    controller.next()
    await vi.waitFor(() => expect(controller.currentVerse.value).toBe(2))
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2))
    controller.previous()
    await vi.waitFor(() => expect(controller.currentVerse.value).toBe(1))
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(3))

    const selected = setup([{ n: 1, text: longText }, { n: 2, text: 'Next verse.' }], 2)
    selected.controller.start()
    await vi.waitFor(() => expect(selected.audio.play).toHaveBeenCalledOnce())
    expect(selected.fetchAudio.mock.calls.map((call) => call[1])).toEqual(['Next verse.'])
  })
})
