import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCrossReferenceTargets, parseOsisTargets } from '../src/index.ts'

describe('complete OSIS reference tokens', () => {
  for (const token of [
    'John.3.16oops',
    'John.3.16-',
    'John.3.16-18oops',
    'John.3.16-John.3.18oops',
    'John.3.16-John.3',
    'John.3.16-John.3.',
    'John.3.16.',
    'John.3.16_footnote',
    'John.3.16--18',
    'John.3.16-18-20',
    'Ps.119.105x',
    'Ps.119.105-112x',
    'Ps.119.105-Ps.119.112x'
  ]) {
    it(`does not turn the valid prefix of ${token} into a target`, () => {
      assert.deepEqual(parseOsisTargets(token), [])
    })

    it(`does not hide complete adjacent references when rejecting ${token}`, () => {
      assert.deepEqual(parseOsisTargets(`;Gen.1.1,${token};1Cor.13.4-7\nPs.91.11-Ps.91.12 `), [
        { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 1 },
        { book: '1Cor', chapter: 13, verseStart: 4, verseEnd: 7 },
        { book: 'Ps', chapter: 91, verseStart: 11, verseEnd: 12 }
      ])
    })

    it(`does not link an invalid structured reference ${token} through cross-reference extraction`, () => {
      assert.deepEqual(parseCrossReferenceTargets(`<reference osisRef="${token}"></reference>`, ''), [])
    })
  }

  for (const separator of [' ', '\t', '\n', ',', ';']) {
    it(`retains adjacent references and deduplicates them with separator ${JSON.stringify(separator)}`, () => {
      const tokens = ['John.3.16oops', 'John.3.16', 'John.3.16-18', 'John.3.16-John.3.18', '1John.4.8']
      assert.deepEqual(parseOsisTargets(tokens.join(separator)), [
        { book: 'John', chapter: 3, verseStart: 16, verseEnd: 16 },
        { book: 'John', chapter: 3, verseStart: 16, verseEnd: 18 },
        { book: '1John', chapter: 4, verseStart: 8, verseEnd: 8 }
      ])
    })
  }

  it('keeps invalid numbers and cross-chapter/book ranges rejected alongside malformed suffixes', () => {
    assert.deepEqual(parseOsisTargets([
      'Unknown.3.16', 'John.0.16', 'John.3.0', 'John.3.18-16',
      'John.3.16-John.4.18', 'John.3.16-Acts.3.18',
      'John.9007199254740992.16', 'John.3.9007199254740992',
      'John.3.16-9007199254740992', 'John.3.16oops'
    ].join(';')), [])
  })
})
