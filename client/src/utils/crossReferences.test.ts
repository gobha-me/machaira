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

it('ranks selected external references across a range, keeps negative votes, and deduplicates by resolved target', () => {
  const target = { book: 'John', chapter: 1, verseStart: 1, verseEnd: 3 }
  const chapter: ChapterVerse[] = [
    { ...verse(1, [' Authored shorthand ']), externalCrossReferences: [
      { sourceVerse: 1, module: 'LSV', target, label: 'John 1:1–3', votes: -2 }
    ] },
    { ...verse(2, []), externalCrossReferences: [
      { sourceVerse: 2, module: 'LSV', target, label: 'John 1:1–3', votes: 383 },
      { sourceVerse: 2, module: 'LSV', target: { ...target, verseStart: 4, verseEnd: 4 }, label: 'John 1:4', votes: -3 }
    ] }
  ]
  expect(crossReferencesForVerses(chapter, [1, 2])).toEqual([
    { verse: 2, text: 'John 1:1–3', target, votes: 383 },
    { verse: 2, text: 'John 1:4', target: { ...target, verseStart: 4, verseEnd: 4 }, votes: -3 },
    { verse: 1, text: 'Authored shorthand' }
  ])
  expect(crossReferencesForVerses(chapter, [99])).toEqual([])
  expect(crossReferencesForVerses(chapter, [1])[0]?.votes).toBe(-2)
})
