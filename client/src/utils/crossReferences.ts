import type { ScriptureTarget } from '@machaira/scripture'
import type { ChapterVerse } from '../services/api'

export interface PassageCrossReference {
  verse: number
  text: string
  target?: ScriptureTarget
  votes?: number
}

// Keep module-authored shorthand intact; external references already have strict,
// translation-resolved targets. Rank range selections globally and deduplicate targets.
export function crossReferencesForVerses(
  verses: readonly ChapterVerse[],
  selectedVerses: readonly number[]
): PassageCrossReference[] {
  const selected = new Set(selectedVerses)
  const entries = verses.flatMap((verse): PassageCrossReference[] => {
    if (!selected.has(verse.n)) return []
    return [
      ...(verse.externalCrossReferences ?? []).map((reference) => ({
        verse: verse.n, text: reference.label, target: reference.target, votes: reference.votes
      })),
      ...verse.crossReferences.map((text) => text.trim()).filter(Boolean)
        .map((text) => ({ verse: verse.n, text }))
    ]
  })
  entries.sort((a, b) => {
    if (a.votes === undefined) return b.votes === undefined ? 0 : 1
    if (b.votes === undefined) return -1
    return b.votes - a.votes || a.text.localeCompare(b.text) || a.verse - b.verse
  })
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (!entry.target) return true
    const key = JSON.stringify(entry.target)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
