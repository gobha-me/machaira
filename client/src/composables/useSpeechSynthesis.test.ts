import { describe, expect, it, vi } from 'vitest'
import { createSpeechSynthesisController } from './useSpeechSynthesis'

class FakeUtterance {
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null

  constructor(readonly text: string) {}
}

function speechEnvironment() {
  const utterances: FakeUtterance[] = []
  const synthesis = {
    paused: false,
    speak: vi.fn((utterance: FakeUtterance) => utterances.push(utterance)),
    cancel: vi.fn(),
    pause: vi.fn(() => { synthesis.paused = true }),
    resume: vi.fn(() => { synthesis.paused = false })
  }
  return {
    utterances,
    synthesis,
    environment: {
      synthesis,
      createUtterance: (text: string) => new FakeUtterance(text)
    }
  }
}

describe('speech synthesis controller', () => {
  it('reports an honest unsupported state', () => {
    const controller = createSpeechSynthesisController({
      verses: () => [{ n: 1, text: 'In the beginning' }],
      startVerse: () => null
    }, { synthesis: null, createUtterance: null })

    expect(controller.supported.value).toBe(false)
    controller.start()
    expect(controller.active.value).toBe(false)
  })

  it('starts at the selected verse and completes the remaining chapter', () => {
    const complete = vi.fn()
    const { environment, utterances } = speechEnvironment()
    const controller = createSpeechSynthesisController({
      verses: () => [
        { n: 1, text: 'one' },
        { n: 2, text: 'two' },
        { n: 3, text: 'three' }
      ],
      startVerse: () => 2,
      onComplete: complete
    }, environment)

    controller.start()
    expect(controller.active.value).toBe(true)
    expect(controller.playing.value).toBe(true)
    expect(controller.currentVerse.value).toBe(2)
    expect(utterances.map((utterance) => utterance.text)).toEqual(['two'])
    expect(controller.progress.value).toBe(67)

    utterances[0].onend?.()
    expect(controller.currentVerse.value).toBe(3)
    expect(utterances.map((utterance) => utterance.text)).toEqual(['two', 'three'])
    utterances[1].onend?.()

    expect(controller.playing.value).toBe(false)
    expect(controller.completed.value).toBe(true)
    expect(controller.progress.value).toBe(100)
    expect(complete).toHaveBeenCalledOnce()
  })

  it('pauses, resumes, and invalidates callbacks after cancellation', () => {
    const { environment, synthesis, utterances } = speechEnvironment()
    const controller = createSpeechSynthesisController({
      verses: () => [{ n: 1, text: 'one' }, { n: 2, text: 'two' }],
      startVerse: () => null
    }, environment)

    controller.start()
    const first = utterances[0]
    controller.togglePlayback()
    expect(controller.playing.value).toBe(false)
    expect(synthesis.pause).toHaveBeenCalledOnce()

    controller.togglePlayback()
    expect(controller.playing.value).toBe(true)
    expect(synthesis.resume).toHaveBeenCalledOnce()

    controller.stop()
    first.onend?.()
    expect(synthesis.cancel).toHaveBeenCalledTimes(2)
    expect(utterances).toHaveLength(1)
    expect(controller.active.value).toBe(false)
    expect(controller.currentVerse.value).toBeNull()
  })

  it('surfaces synthesis failures without marking the chapter complete', () => {
    const complete = vi.fn()
    const { environment, utterances } = speechEnvironment()
    const controller = createSpeechSynthesisController({
      verses: () => [{ n: 1, text: 'one' }],
      startVerse: () => 1,
      onComplete: complete
    }, environment)

    controller.start()
    utterances[0].onerror?.({ error: 'synthesis-failed' })

    expect(controller.error.value).toBe('Read-aloud stopped unexpectedly')
    expect(controller.playing.value).toBe(false)
    expect(controller.completed.value).toBe(false)
    expect(complete).not.toHaveBeenCalled()
  })
})
