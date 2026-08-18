import type { ChapterVerse } from '../services/api'

export interface PassageCrossReference {
  verse: number
  text: string
}

// Cross-references are verse-keyed in the chapter payload. Keep selection filtering outside the
// UI components so Read and Study cannot drift, and preserve each module-authored reference as a
// single string: SWORD notes can contain shorthand and cross-chapter ranges that are unsafe to
// guess into navigation targets.
export function crossReferencesForVerses(
  verses: readonly ChapterVerse[],
  selectedVerses: readonly number[]
): PassageCrossReference[] {
  const selected = new Set(selectedVerses)
  return verses.flatMap((verse) => {
    if (!selected.has(verse.n)) return []
    return verse.crossReferences
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ verse: verse.n, text }))
  })
}
