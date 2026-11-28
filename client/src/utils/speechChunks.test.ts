import { describe, expect, it } from 'vitest'
import { MAX_SPEECH_CHARS, splitSpeechText } from './speechChunks'

describe('bounded read-aloud text', () => {
  it('keeps short sentences together and prefers a sentence boundary before the cap', () => {
    const first = `${'First sentence '.repeat(20).trim()}.`
    const second = `${'Second sentence '.repeat(20).trim()}.`
    expect(splitSpeechText(`${first} ${second}`)).toEqual([first, second])
    expect(splitSpeechText('One. Two! Three?')).toEqual(['One. Two! Three?'])
  })

  it('uses word boundaries when a sentence is too long', () => {
    const input = 'word '.repeat(260).trim()
    const chunks = splitSpeechText(input)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.join(' ')).toBe(input)
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= MAX_SPEECH_CHARS && !chunk.startsWith(' '))).toBe(true)
    expect(chunks.every((chunk) => /^(word)( word)*$/.test(chunk))).toBe(true)
  })

  it('caps unpunctuated long words without losing text or splitting surrogate pairs', () => {
    for (const input of ['x'.repeat(2600), `${'x'.repeat(499)}${'😀'.repeat(400)}`]) {
      const chunks = splitSpeechText(input)
      expect(chunks.join('')).toBe(input)
      expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= MAX_SPEECH_CHARS)).toBe(true)
      for (const chunk of chunks) {
        expect(Array.from(chunk).every((character) => character.length === 2 || !/[\uD800-\uDFFF]/.test(character))).toBe(true)
      }
    }
  })

  it('ignores empty input and normalizes whitespace without empty requests', () => {
    for (const input of ['', ' ', '\n\t\r']) expect(splitSpeechText(input)).toEqual([])
    expect(splitSpeechText('  One\n\t two.  ')).toEqual(['One two.'])
    expect(splitSpeechText('x'.repeat(MAX_SPEECH_CHARS))).toEqual(['x'.repeat(MAX_SPEECH_CHARS)])
  })
})
