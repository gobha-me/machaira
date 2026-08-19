import { bookCode, bookReferenceNames } from './books.js'

export interface ScriptureTarget {
  book: string
  chapter: number
  verseStart: number | null
  verseEnd: number | null
}

function target(
  book: string,
  chapterText: string,
  verseStartText?: string,
  verseEndText?: string
): ScriptureTarget | null {
  const code = bookCode(book)
  const chapter = Number.parseInt(chapterText, 10)
  const verseStart = verseStartText == null ? null : Number.parseInt(verseStartText, 10)
  const verseEnd = verseEndText == null ? verseStart : Number.parseInt(verseEndText, 10)
  if (
    !code || !Number.isSafeInteger(chapter) || chapter < 1 ||
    (verseStart !== null && (!Number.isSafeInteger(verseStart) || verseStart < 1)) ||
    (verseEnd !== null && (!Number.isSafeInteger(verseEnd) || verseEnd < (verseStart ?? 1)))
  ) return null
  return { book: code, chapter, verseStart, verseEnd }
}

function key(value: ScriptureTarget): string {
  return `${value.book}/${value.chapter}/${value.verseStart ?? ''}/${value.verseEnd ?? ''}`
}

function unique(values: ScriptureTarget[]): ScriptureTarget[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Parse explicit OSIS references such as Isa.40.3 and Isa.40.3-Isa.40.5. */
export function parseOsisTargets(value: string): ScriptureTarget[] {
  const results: ScriptureTarget[] = []
  const pattern = /(?:^|[\s;,])([1-4]?[A-Za-z]+)\.(\d+)\.(\d+)(?:-([1-4]?[A-Za-z]+)\.(\d+)\.(\d+)|-(\d+))?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    const endBook = match[4] ?? match[1]
    const endChapter = match[5] ?? match[2]
    // Cross-book or cross-chapter ranges cannot be represented by one graph node safely.
    if (bookCode(endBook) !== bookCode(match[1]) || endChapter !== match[2]) continue
    const parsed = target(match[1], match[2], match[3], match[6] ?? match[7])
    if (parsed) results.push(parsed)
  }
  return unique(results)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const DISPLAY_BOOKS = bookReferenceNames().map(escapeRegex).join('|')
const DISPLAY_REFERENCE = new RegExp(
  `(?:^|[;,(]|\\s)(?:see\\s+)?(${DISPLAY_BOOKS})\\s+(\\d+)(?::(\\d+)(?:\\s*[–-]\\s*(\\d+))?)?`,
  'gi'
)

/**
 * Parse only references that spell out a recognized book and chapter. Shorthand such as
 * "v. 4" or "& 13" is intentionally ignored rather than guessed.
 */
export function parseDisplayTargets(value: string): ScriptureTarget[] {
  const results: ScriptureTarget[] = []
  DISPLAY_REFERENCE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DISPLAY_REFERENCE.exec(value)) !== null) {
    const parsed = target(match[1], match[2], match[3], match[4])
    if (parsed) results.push(parsed)
  }
  return unique(results)
}

export function parseCrossReferenceTargets(markup: string, label: string): ScriptureTarget[] {
  const osisValues: string[] = []
  const osisAttribute = /\bosisRef\s*=\s*["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = osisAttribute.exec(markup)) !== null) osisValues.push(match[1])
  const structured = unique(osisValues.flatMap(parseOsisTargets))
  return structured.length > 0 ? structured : parseDisplayTargets(label)
}
