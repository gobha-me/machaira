// "Bible in a year" schedule — factual canonical structure (book order + standard
// chapter counts for the 66-book Protestant canon, Genesis→Revelation). This is
// reference metadata, the same category as server/src/books.ts — not fabricated content.
// Book codes match the OSIS codes used everywhere else so reader.openRef() navigates.

export interface CanonBook {
  code: string
  name: string
  chapters: number
}

export interface Reading {
  book: string
  chapter: number
}

export const CANON: CanonBook[] = [
  { code: 'Gen', name: 'Genesis', chapters: 50 },
  { code: 'Exod', name: 'Exodus', chapters: 40 },
  { code: 'Lev', name: 'Leviticus', chapters: 27 },
  { code: 'Num', name: 'Numbers', chapters: 36 },
  { code: 'Deut', name: 'Deuteronomy', chapters: 34 },
  { code: 'Josh', name: 'Joshua', chapters: 24 },
  { code: 'Judg', name: 'Judges', chapters: 21 },
  { code: 'Ruth', name: 'Ruth', chapters: 4 },
  { code: '1Sam', name: '1 Samuel', chapters: 31 },
  { code: '2Sam', name: '2 Samuel', chapters: 24 },
  { code: '1Kgs', name: '1 Kings', chapters: 22 },
  { code: '2Kgs', name: '2 Kings', chapters: 25 },
  { code: '1Chr', name: '1 Chronicles', chapters: 29 },
  { code: '2Chr', name: '2 Chronicles', chapters: 36 },
  { code: 'Ezra', name: 'Ezra', chapters: 10 },
  { code: 'Neh', name: 'Nehemiah', chapters: 13 },
  { code: 'Esth', name: 'Esther', chapters: 10 },
  { code: 'Job', name: 'Job', chapters: 42 },
  { code: 'Ps', name: 'Psalms', chapters: 150 },
  { code: 'Prov', name: 'Proverbs', chapters: 31 },
  { code: 'Eccl', name: 'Ecclesiastes', chapters: 12 },
  { code: 'Song', name: 'Song of Solomon', chapters: 8 },
  { code: 'Isa', name: 'Isaiah', chapters: 66 },
  { code: 'Jer', name: 'Jeremiah', chapters: 52 },
  { code: 'Lam', name: 'Lamentations', chapters: 5 },
  { code: 'Ezek', name: 'Ezekiel', chapters: 48 },
  { code: 'Dan', name: 'Daniel', chapters: 12 },
  { code: 'Hos', name: 'Hosea', chapters: 14 },
  { code: 'Joel', name: 'Joel', chapters: 3 },
  { code: 'Amos', name: 'Amos', chapters: 9 },
  { code: 'Obad', name: 'Obadiah', chapters: 1 },
  { code: 'Jonah', name: 'Jonah', chapters: 4 },
  { code: 'Mic', name: 'Micah', chapters: 7 },
  { code: 'Nah', name: 'Nahum', chapters: 3 },
  { code: 'Hab', name: 'Habakkuk', chapters: 3 },
  { code: 'Zeph', name: 'Zephaniah', chapters: 3 },
  { code: 'Hag', name: 'Haggai', chapters: 2 },
  { code: 'Zech', name: 'Zechariah', chapters: 14 },
  { code: 'Mal', name: 'Malachi', chapters: 4 },
  { code: 'Matt', name: 'Matthew', chapters: 28 },
  { code: 'Mark', name: 'Mark', chapters: 16 },
  { code: 'Luke', name: 'Luke', chapters: 24 },
  { code: 'John', name: 'John', chapters: 21 },
  { code: 'Acts', name: 'Acts', chapters: 28 },
  { code: 'Rom', name: 'Romans', chapters: 16 },
  { code: '1Cor', name: '1 Corinthians', chapters: 16 },
  { code: '2Cor', name: '2 Corinthians', chapters: 13 },
  { code: 'Gal', name: 'Galatians', chapters: 6 },
  { code: 'Eph', name: 'Ephesians', chapters: 6 },
  { code: 'Phil', name: 'Philippians', chapters: 4 },
  { code: 'Col', name: 'Colossians', chapters: 4 },
  { code: '1Thess', name: '1 Thessalonians', chapters: 5 },
  { code: '2Thess', name: '2 Thessalonians', chapters: 3 },
  { code: '1Tim', name: '1 Timothy', chapters: 6 },
  { code: '2Tim', name: '2 Timothy', chapters: 4 },
  { code: 'Titus', name: 'Titus', chapters: 3 },
  { code: 'Phlm', name: 'Philemon', chapters: 1 },
  { code: 'Heb', name: 'Hebrews', chapters: 13 },
  { code: 'Jas', name: 'James', chapters: 5 },
  { code: '1Pet', name: '1 Peter', chapters: 5 },
  { code: '2Pet', name: '2 Peter', chapters: 3 },
  { code: '1John', name: '1 John', chapters: 5 },
  { code: '2John', name: '2 John', chapters: 1 },
  { code: '3John', name: '3 John', chapters: 1 },
  { code: 'Jude', name: 'Jude', chapters: 1 },
  { code: 'Rev', name: 'Revelation', chapters: 22 }
]

export const PLAN_DAYS = 365

// Every (book, chapter) pair in canonical order — 1189 entries.
export const FLAT: Reading[] = CANON.flatMap((b) =>
  Array.from({ length: b.chapters }, (_, i) => ({ book: b.code, chapter: i + 1 }))
)

export const TOTAL_CHAPTERS = FLAT.length

const NAME = new Map(CANON.map((b) => [b.code, b.name]))

export function bookName(code: string): string {
  return NAME.get(code) ?? code
}

export function chapterKey(book: string, chapter: number): string {
  return `${book}/${chapter}`
}

// The contiguous run of chapters assigned to a given day (0-based), ~3–4 chapters each.
export function daySlice(day: number): Reading[] {
  const d = Math.max(0, Math.min(PLAN_DAYS - 1, day))
  const start = Math.floor((d * TOTAL_CHAPTERS) / PLAN_DAYS)
  const end = Math.floor(((d + 1) * TOTAL_CHAPTERS) / PLAN_DAYS)
  return FLAT.slice(start, end)
}

// Chapters through the end of the given day (0-based) — the "expected by now" count.
export function chaptersThroughDay(day: number): number {
  const d = Math.max(0, Math.min(PLAN_DAYS - 1, day))
  return Math.floor(((d + 1) * TOTAL_CHAPTERS) / PLAN_DAYS)
}

// Compact human label for a run of readings, e.g. "Genesis 1–4" or "Malachi 3–4 · Matthew 1".
export function rangeLabel(readings: Reading[]): string {
  if (readings.length === 0) return ''
  const groups: { book: string; from: number; to: number }[] = []
  for (const r of readings) {
    const last = groups[groups.length - 1]
    if (last && last.book === r.book) last.to = r.chapter
    else groups.push({ book: r.book, from: r.chapter, to: r.chapter })
  }
  return groups
    .map((g) => `${bookName(g.book)} ${g.from === g.to ? g.from : `${g.from}–${g.to}`}`)
    .join(' · ')
}
