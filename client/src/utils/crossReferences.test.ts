import { describe, expect, it } from 'vitest'
import type { ChapterVerse } from '../services/api'
import { crossReferencesForVerses } from './crossReferences'

function verse(n: number, crossReferences: string[]): ChapterVerse {
  return { n, text: '', notes: [], segments: [], crossReferences }
}

describe('passage cross-references', () => {
  const chapter = [
    verse(3, []),
    verse(4, [' Isaiah 40:3 ', '']),
    verse(5, ['Psalm 91:11-12']),
    verse(6, [])
  ]

  it('returns references for a selected verse and preserves their source verse', () => {
    expect(crossReferencesForVerses(chapter, [4])).toEqual([
      { verse: 4, text: 'Isaiah 40:3' }
    ])
  })

  it('collects references across a range in chapter order', () => {
    expect(crossReferencesForVerses(chapter, [3, 4, 5, 6])).toEqual([
      { verse: 4, text: 'Isaiah 40:3' },
      { verse: 5, text: 'Psalm 91:11-12' }
    ])
  })

  it('returns an honest empty result when the selection has no embedded references', () => {
    expect(crossReferencesForVerses(chapter, [3, 6])).toEqual([])
    expect(crossReferencesForVerses(chapter, [])).toEqual([])
  })
})
