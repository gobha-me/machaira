import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { registerSecurity } from '../../../server/src/security'
import { api, type TtsConfig } from '../services/api'
import { createReadAloudController } from './useReadAloud'

const app = Fastify()
let mediaSources: string[]
let controller: ReturnType<typeof createReadAloudController> | undefined

beforeAll(async () => {
  await registerSecurity(app, true)
  app.get('/', async () => 'reader')
  const response = await app.inject('/')
  const csp = String(response.headers['content-security-policy'])
  mediaSources = csp.split(';').map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'media-src')!.slice(1)
})

afterAll(async () => { await app.close() })
afterEach(() => {
  controller?.stop()
  controller = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(tier: 'local' | 'cloud' = 'local', count = 1) {
  const sources: string[] = []
  const instances: BrowserAudio[] = []
  class BrowserAudio {
    private source = ''
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    play = vi.fn(async () => undefined)
    pause = vi.fn()
    removeAttribute = vi.fn()
    load = vi.fn()
    constructor() { instances.push(this) }
    set src(url: string) { this.source = url; sources.push(url) }
    get src() { return this.source }
  }
  vi.stubGlobal('Audio', BrowserAudio)
  const createUrl = vi.spyOn(URL, 'createObjectURL')
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL')
  const fetchAudio = vi.spyOn(api, 'ttsSpeech')
    .mockResolvedValue(new Blob(['verse audio'], { type: 'audio/mpeg' }))
  const config: TtsConfig = {
    order: [tier], remoteAudioCacheSize: 4,
    local: {
      provider: 'openai-compatible', baseUrl: 'http://tts.local/v1',
      model: 'kokoro', voice: 'af_heart', hasApiKey: false
    },
    cloud: {
      provider: 'venice', baseUrl: 'https://api.venice.ai/api/v1',
      model: 'tts-kokoro', voice: 'af_sky', hasApiKey: true
    }
  }
  controller = createReadAloudController({
    verses: () => Array.from({ length: count }, (_, index) => ({ n: index + 1, text: `Verse ${index + 1}` })),
    startVerse: () => null,
    config: () => config
  })
  return { control: controller, sources, instances, createUrl, revokeUrl, fetchAudio }
}

function expectCspAllows(sources: string[]) {
  expect(mediaSources).toEqual(["'self'", 'blob:'])
  for (const source of sources) {
    expect(mediaSources).toContain(new URL(source).protocol)
  }
}

describe('browser read-aloud audio and the server CSP', () => {
  it.each(['local', 'cloud'] as const)('allows the unlock and all six %s verse URLs, advancing and completing', async (tier) => {
    const { control, sources, instances, createUrl, revokeUrl, fetchAudio } = setup(tier, 6)
    control.start()
    // Mobile unlock must call play synchronously, before awaiting synthesis.
    const audio = instances[0]!
    expect(audio.play).toHaveBeenCalledOnce()
    expect(audio.play.mock.invocationCallOrder[0]).toBeLessThan(fetchAudio.mock.invocationCallOrder[0]!)
    expect(sources).toHaveLength(1)
    expectCspAllows(sources)
    const unlockBlob = createUrl.mock.calls[0]![0] as Blob
    expect(unlockBlob.type).toBe('audio/wav')
    const wav = new Uint8Array(await unlockBlob.arrayBuffer())
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(wav.slice(44)).toEqual(new Uint8Array(800).fill(128))

    for (let verse = 1; verse <= 6; verse += 1) {
      await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(verse + 1))
      expect(control.currentVerse.value).toBe(verse)
      expect(control.playing.value).toBe(true)
      expectCspAllows(sources)
      audio.onended?.()
    }
    await vi.waitFor(() => expect(control.completed.value).toBe(true))
    expect(control.playing.value).toBe(false)
    expect(control.progress.value).toBe(100)
    expect(sources).toHaveLength(7)
    expect(instances).toHaveLength(1)
    expect(fetchAudio).toHaveBeenCalledTimes(6)
    expect(revokeUrl.mock.calls.map(([url]) => url)).toEqual(sources)
  })

  it('releases the unlock URL and aborts synthesis when stopped during preparation', async () => {
    const { control, sources, instances, revokeUrl, fetchAudio } = setup()
    fetchAudio.mockImplementation(() => new Promise<Blob>(() => {}))
    control.start()
    expect(control.preparing.value).toBe(true)
    expectCspAllows(sources)
    control.stop()
    await vi.waitFor(() => expect(fetchAudio.mock.calls[0]![2]!.aborted).toBe(true))
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(sources[0])
    expect(instances[0]!.pause).toHaveBeenCalledOnce()
    expect(control.active.value).toBe(false)
    expect(control.currentVerse.value).toBeNull()
  })

  it('releases a replaced unlock URL on retry, including a rejected unlock play', async () => {
    const { control, sources, instances, revokeUrl, fetchAudio } = setup()
    fetchAudio.mockRejectedValue(new TypeError('offline'))
    control.start()
    await vi.waitFor(() => expect(control.error.value).not.toBeNull())
    instances[0]!.play.mockRejectedValueOnce(new DOMException('Gesture needed', 'NotAllowedError'))
    control.retry()
    expect(sources).toHaveLength(2)
    expectCspAllows(sources)
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(sources[0])
    control.stop()
    expect(revokeUrl.mock.calls.map(([url]) => url)).toEqual(sources)
  })

  it('retries mobile autoplay rejection synchronously on the same blob and element', async () => {
    const { control, sources, instances, fetchAudio } = setup()
    control.start()
    const audio = instances[0]!
    audio.play.mockRejectedValueOnce(new DOMException('Gesture needed', 'NotAllowedError'))
    await vi.waitFor(() => expect(control.needsAudioGesture.value).toBe(true))
    expect(sources).toHaveLength(2)
    expectCspAllows(sources)
    control.recoverAudio()
    expect(audio.play).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(control.playing.value).toBe(true))
    expect(sources).toHaveLength(2)
    expect(fetchAudio).toHaveBeenCalledOnce()
    audio.onended?.()
    await vi.waitFor(() => expect(control.completed.value).toBe(true))
  })
})
