import { describe, expect, it } from 'vitest'
import { inlineNoteVerses } from './inlineNotes'

describe('inline note anchors', () => {
  it('ignores malformed, reversed, zero and unrelated references instead of placing them on a verse', () => {
    expect(inlineNoteVerses(['John 0:1', 'John 1:0', 'John 1:3–1', 'invalid', 'John 2:1', 'Mark 1:1'], 'John', 1, [1, 2])).toEqual([])
  })
  it('deduplicates overlapping references independently of translation and handles absent range ends', () => {
    expect(inlineNoteVerses(['John 1:1-3 · KJV', 'John 1:2 · WEB'], 'John', 1, [1, 2])).toEqual([1, 2])
    expect(inlineNoteVerses(['John 1:3 · KJV'], 'John', 1, [1, 2])).toEqual([])
  })
  it('places chapter notes last and tolerates empty chapters', () => {
    expect(inlineNoteVerses(['John 1 · KJV'], 'John', 1, [1, 2])).toEqual([2])
    expect(inlineNoteVerses(['John 1', 'John 1:1–9'], 'John', 1, [])).toEqual([])
  })
})
