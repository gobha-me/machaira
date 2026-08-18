import { describe, expect, it } from 'vitest'
import { formatPassageRef, parsePassageRef, passageRefMatchesSelection } from './passageRef'

describe('passage references', () => {
  it.each([
    [{ book: 'John', chapter: 1 }, 'John 1'],
    [{ book: 'John', chapter: 1, verseStart: 3 }, 'John 1:3'],
    [{ book: 'John', chapter: 1, verseStart: 3, verseEnd: 6 }, 'John 1:3–6'],
    [{ book: 'John', chapter: 1, verseStart: 6, verseEnd: 3 }, 'John 1:3–6'],
    [
      { book: 'Song of Solomon', chapter: 2, verseStart: 1, verseEnd: 4, moduleName: 'WEB' },
      'Song of Solomon 2:1–4 · WEB'
    ]
  ])('formats %o as %s', (ref, expected) => {
    expect(formatPassageRef(ref)).toBe(expected)
  })

  it.each([
    ['John 1', { book: 'John', chapter: 1, verseStart: null, verseEnd: null, moduleName: null }],
    [
      '1 John 3:2 · KJV',
      { book: '1 John', chapter: 3, verseStart: 2, verseEnd: 2, moduleName: 'KJV' }
    ],
    [
      'Song of Solomon 2:1–4 · WEB',
      { book: 'Song of Solomon', chapter: 2, verseStart: 1, verseEnd: 4, moduleName: 'WEB' }
    ],
    [
      'Song of Solomon 2:1-4 · WEB',
      { book: 'Song of Solomon', chapter: 2, verseStart: 1, verseEnd: 4, moduleName: 'WEB' }
    ]
  ])('parses %s', (value, expected) => {
    expect(parsePassageRef(value)).toEqual(expected)
  })

  it.each(['', 'John', 'John 0', 'John 1:0', 'John 1:6–3', 'John 1:three']) (
    'rejects malformed reference %j',
    (value) => {
      expect(parsePassageRef(value)).toBeNull()
    }
  )

  it('round-trips the canonical format', () => {
    const ref = { book: '2 Corinthians', chapter: 5, verseStart: 17, verseEnd: 21, moduleName: 'KJVA' }
    expect(parsePassageRef(formatPassageRef(ref))).toEqual(ref)
  })

  it.each([
    ['John 1 · WEB', { book: 'John', chapter: 1, verses: [3] }, true],
    ['John 1:3 · WEB', { book: 'John', chapter: 1, verses: [3] }, true],
    ['John 1:1–4 · WEB', { book: 'John', chapter: 1, verses: [3, 4, 5] }, true],
    ['John 1:1-4 · WEB', { book: 'John', chapter: 1, verses: [3] }, true],
    ['John 1:1–2 · WEB', { book: 'John', chapter: 1, verses: [3] }, false],
    ['John 2:3 · WEB', { book: 'John', chapter: 1, verses: [3] }, false],
    ['Luke 1:3 · WEB', { book: 'John', chapter: 1, verses: [3] }, false],
    ['not a reference', { book: 'John', chapter: 1, verses: [] }, false],
    ['John 1:8 · WEB', { book: 'John', chapter: 1, verses: [] }, true]
  ])('matches %s against %o as %s', (value, selection, expected) => {
    expect(passageRefMatchesSelection(value, selection)).toBe(expected)
  })
})
