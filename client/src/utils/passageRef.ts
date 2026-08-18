export interface PassageRef {
  book: string
  chapter: number
  verseStart?: number | null
  verseEnd?: number | null
  moduleName?: string | null
}

export interface ParsedPassageRef {
  book: string
  chapter: number
  verseStart: number | null
  verseEnd: number | null
  moduleName: string | null
}

export interface PassageSelection {
  book: string
  chapter: number
  verses: readonly number[]
}

// Passage references are persisted in notes, so formatting is a data contract rather than
// presentation-only copy. Keep its punctuation here with the parser that reads it back.
export function formatPassageRef(ref: PassageRef): string {
  const start = ref.verseStart ?? null
  const end = ref.verseEnd ?? start
  let passage = `${ref.book} ${ref.chapter}`

  if (start != null) {
    const lo = Math.min(start, end ?? start)
    const hi = Math.max(start, end ?? start)
    passage += `:${lo}${lo === hi ? '' : `–${hi}`}`
  }

  const moduleName = ref.moduleName?.trim()
  return moduleName ? `${passage} · ${moduleName}` : passage
}

// Accept the canonical en dash and the ASCII hyphen used by older/imported note data. The
// formatter always writes the canonical form; tolerance here keeps persisted references readable.
export function parsePassageRef(value: string): ParsedPassageRef | null {
  const match = value
    .trim()
    .match(/^(.+?)\s+(\d+)(?::(\d+)(?:\s*[–-]\s*(\d+))?)?(?:\s+·\s+(.+))?$/u)
  if (!match) return null

  const chapter = Number.parseInt(match[2], 10)
  const verseStart = match[3] == null ? null : Number.parseInt(match[3], 10)
  const verseEnd = match[4] == null ? verseStart : Number.parseInt(match[4], 10)
  if (
    chapter < 1 ||
    (verseStart != null && verseStart < 1) ||
    (verseEnd != null && (verseEnd < 1 || (verseStart != null && verseEnd < verseStart)))
  ) {
    return null
  }

  return {
    book: match[1].trim(),
    chapter,
    verseStart,
    verseEnd,
    moduleName: match[5]?.trim() || null
  }
}

export function passageRefMatchesSelection(value: string, selection: PassageSelection): boolean {
  const passage = parsePassageRef(value)
  if (!passage || passage.book !== selection.book || passage.chapter !== selection.chapter) {
    return false
  }
  if (selection.verses.length === 0 || passage.verseStart == null) return true

  const start = passage.verseStart
  const end = passage.verseEnd ?? start
  return selection.verses.some((verse) => verse >= start && verse <= end)
}
