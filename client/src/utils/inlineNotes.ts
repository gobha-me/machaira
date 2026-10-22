import { parsePassageRef } from './passageRef'

// Match Scripture independently of the translation recorded when the note was written.
// Clamp to visible verses so a range ending in a verse absent from another translation
// still has a home. Chapter notes belong after the chapter's last verse.
export function inlineNoteVerses(refs: readonly string[], book: string, chapter: number, verses: readonly number[]): number[] {
  const matched = new Set<number>()
  for (const ref of refs) {
    const passage = parsePassageRef(ref)
    if (!passage || passage.book !== book || passage.chapter !== chapter) continue
    if (passage.verseStart === null) {
      const last = verses.at(-1)
      if (last !== undefined) matched.add(last)
    } else {
      for (const verse of verses) {
        if (verse >= passage.verseStart && verse <= (passage.verseEnd ?? passage.verseStart)) matched.add(verse)
      }
    }
  }
  return [...matched].sort((a, b) => a - b)
}
