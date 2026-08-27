import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bookCode,
  findDisplayReferences,
  parseDisplayTargets,
  parseOsisTargets
} from '../src/index.ts'

describe('shared Scripture references', () => {
  it('recognizes full names, aliases, numbered books, and same-chapter ranges', () => {
    assert.deepEqual(parseDisplayTargets('Genesis 1:1; Gen 1:1–3; 1 Cor 13:4-7'), [
      { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 1 },
      { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 3 },
      { book: '1Cor', chapter: 13, verseStart: 4, verseEnd: 7 }
    ])
    assert.equal(bookCode('1 Corinthians'), '1Cor')
    assert.equal(bookCode('1Cor'), '1Cor')
  })

  it('returns exact source spans without deduplicating rendered occurrences', () => {
    const source = 'See John 3:16, then John 3:16.'
    assert.deepEqual(findDisplayReferences(source).map(({ start, end, label }) => ({ start, end, label })), [
      { start: 4, end: 13, label: 'John 3:16' },
      { start: 20, end: 29, label: 'John 3:16' }
    ])
  })

  it('rejects ambiguous shorthand, embedded words, and invalid ranges', () => {
    assert.deepEqual(parseDisplayTargets('verse 4; vv. 4-8; notJohn 3:16; John 3:8-4'), [])
  })

  it('retains OSIS parsing and rejects cross-chapter ranges', () => {
    assert.deepEqual(parseOsisTargets('Isa.40.3 Ps.91.11-Ps.91.12'), [
      { book: 'Isa', chapter: 40, verseStart: 3, verseEnd: 3 },
      { book: 'Ps', chapter: 91, verseStart: 11, verseEnd: 12 }
    ])
    assert.deepEqual(parseOsisTargets('John.3.16-John.4.2'), [])
  })
})
