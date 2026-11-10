import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseOsisTargets } from '../src/index.ts'

describe('OSIS suffixes that are not reference separators', () => {
  for (const token of [
    'John.3.16:18',
    'John.3.16/18',
    'John.3.16\u0000',
    'John.3.16\u200b',
    'John.3.16é',
    'John.3.16-18.5',
    'John.3.16-18e2',
    'John.3.16-John.3.18.1',
    'Ps.119.105-112/113'
  ]) {
    it(`rejects the complete malformed token ${JSON.stringify(token)}`, () => {
      assert.deepEqual(parseOsisTargets(token), [])
    })

    it(`preserves the next reference after ${JSON.stringify(token)}`, () => {
      assert.deepEqual(parseOsisTargets(`${token};Gen.1.1`), [
        { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 1 }
      ])
    })
  }
})
