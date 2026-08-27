export interface BookInfo {
  code: string
  name: string
  section: 'ot' | 'nt' | 'apocrypha'
}

type BookDefinition = readonly [
  code: string,
  name: string,
  section: BookInfo['section'],
  aliases?: readonly string[]
]

// OSIS code, display name, testament, and conservative unambiguous display aliases.
const DEFINITIONS: readonly BookDefinition[] = [
  ['Gen', 'Genesis', 'ot'], ['Exod', 'Exodus', 'ot', ['Ex']], ['Lev', 'Leviticus', 'ot'],
  ['Num', 'Numbers', 'ot'], ['Deut', 'Deuteronomy', 'ot', ['Dt']], ['Josh', 'Joshua', 'ot'],
  ['Judg', 'Judges', 'ot', ['Jdg']], ['Ruth', 'Ruth', 'ot'],
  ['1Sam', '1 Samuel', 'ot', ['1 Sam']], ['2Sam', '2 Samuel', 'ot', ['2 Sam']],
  ['1Kgs', '1 Kings', 'ot', ['1 Kgs']], ['2Kgs', '2 Kings', 'ot', ['2 Kgs']],
  ['1Chr', '1 Chronicles', 'ot', ['1 Chr']], ['2Chr', '2 Chronicles', 'ot', ['2 Chr']],
  ['Ezra', 'Ezra', 'ot'], ['Neh', 'Nehemiah', 'ot'], ['Esth', 'Esther', 'ot'],
  ['Job', 'Job', 'ot'], ['Ps', 'Psalms', 'ot', ['Psalm', 'Psa']],
  ['Prov', 'Proverbs', 'ot', ['Prv']], ['Eccl', 'Ecclesiastes', 'ot', ['Ecc']],
  ['Song', 'Song of Solomon', 'ot', ['Song of Songs', 'Canticles']],
  ['Isa', 'Isaiah', 'ot'], ['Jer', 'Jeremiah', 'ot'], ['Lam', 'Lamentations', 'ot'],
  ['Ezek', 'Ezekiel', 'ot'], ['Dan', 'Daniel', 'ot'], ['Hos', 'Hosea', 'ot'],
  ['Joel', 'Joel', 'ot'], ['Amos', 'Amos', 'ot'], ['Obad', 'Obadiah', 'ot'],
  ['Jonah', 'Jonah', 'ot'], ['Mic', 'Micah', 'ot'], ['Nah', 'Nahum', 'ot'],
  ['Hab', 'Habakkuk', 'ot'], ['Zeph', 'Zephaniah', 'ot'], ['Hag', 'Haggai', 'ot'],
  ['Zech', 'Zechariah', 'ot'], ['Mal', 'Malachi', 'ot'],
  ['Matt', 'Matthew', 'nt', ['Mt']], ['Mark', 'Mark', 'nt', ['Mk']],
  ['Luke', 'Luke', 'nt', ['Lk']], ['John', 'John', 'nt', ['Jn']],
  ['Acts', 'Acts', 'nt'], ['Rom', 'Romans', 'nt'],
  ['1Cor', '1 Corinthians', 'nt', ['1 Cor']], ['2Cor', '2 Corinthians', 'nt', ['2 Cor']],
  ['Gal', 'Galatians', 'nt'], ['Eph', 'Ephesians', 'nt'], ['Phil', 'Philippians', 'nt'],
  ['Col', 'Colossians', 'nt'],
  ['1Thess', '1 Thessalonians', 'nt', ['1 Thess']],
  ['2Thess', '2 Thessalonians', 'nt', ['2 Thess']],
  ['1Tim', '1 Timothy', 'nt', ['1 Tim']], ['2Tim', '2 Timothy', 'nt', ['2 Tim']],
  ['Titus', 'Titus', 'nt'], ['Phlm', 'Philemon', 'nt', ['Phm']],
  ['Heb', 'Hebrews', 'nt'], ['Jas', 'James', 'nt', ['Jam']],
  ['1Pet', '1 Peter', 'nt', ['1 Pet']], ['2Pet', '2 Peter', 'nt', ['2 Pet']],
  ['1John', '1 John', 'nt', ['1 Jn']], ['2John', '2 John', 'nt', ['2 Jn']],
  ['3John', '3 John', 'nt', ['3 Jn']], ['Jude', 'Jude', 'nt'],
  ['Rev', 'Revelation', 'nt', ['Revelation of John']],
  ['Tob', 'Tobit', 'apocrypha'], ['Jdt', 'Judith', 'apocrypha'],
  ['AddEsth', 'Additions to Esther', 'apocrypha'],
  ['Wis', 'Wisdom of Solomon', 'apocrypha'], ['Sir', 'Sirach', 'apocrypha'],
  ['Bar', 'Baruch', 'apocrypha'], ['EpJer', 'Epistle of Jeremiah', 'apocrypha'],
  ['PrAzar', 'Prayer of Azariah', 'apocrypha'], ['Sus', 'Susanna', 'apocrypha'],
  ['Bel', 'Bel and the Dragon', 'apocrypha'],
  ['1Macc', '1 Maccabees', 'apocrypha', ['1 Macc']],
  ['2Macc', '2 Maccabees', 'apocrypha', ['2 Macc']],
  ['1Esd', '1 Esdras', 'apocrypha', ['1 Esd']],
  ['2Esd', '2 Esdras', 'apocrypha', ['2 Esd']],
  ['PrMan', 'Prayer of Manasseh', 'apocrypha'],
  ['AddPs', 'Additional Psalm', 'apocrypha'], ['Ps151', 'Psalm 151', 'apocrypha'],
  ['3Macc', '3 Maccabees', 'apocrypha', ['3 Macc']],
  ['4Macc', '4 Maccabees', 'apocrypha', ['4 Macc']],
  ['EpLao', 'Epistle to the Laodiceans', 'apocrypha']
]

const BOOKS: BookInfo[] = DEFINITIONS.map(([code, name, section]) => ({ code, name, section }))
const BY_CODE = new Map(BOOKS.map((book) => [book.code, book]))

function normalizedBook(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const BY_NAME = new Map<string, BookInfo>()
const REFERENCE_NAMES = new Set<string>()
for (const [code, name, _section, aliases = []] of DEFINITIONS) {
  const book = BY_CODE.get(code)!
  for (const value of [code, name, ...aliases]) {
    BY_NAME.set(normalizedBook(value), book)
    REFERENCE_NAMES.add(value)
  }
}

export function bookName(code: string): string {
  return BY_CODE.get(code)?.name ?? code
}

export function bookInfo(code: string): BookInfo {
  return BY_CODE.get(code) ?? { code, name: code, section: 'apocrypha' }
}

export function isDeuterocanonicalBook(code: string): boolean {
  return bookInfo(code).section === 'apocrypha'
}

/** Resolve an OSIS code, full English name, or an unambiguous display alias. */
export function bookCode(value: string): string | null {
  return BY_NAME.get(normalizedBook(value))?.code ?? null
}

/** Names accepted by bookCode(), longest first so reference parsers do not match prefixes. */
export function bookReferenceNames(): string[] {
  return [...REFERENCE_NAMES].sort((left, right) => right.length - left.length)
}

export interface ScriptureTarget {
  book: string
  chapter: number
  verseStart: number | null
  verseEnd: number | null
}

export interface ScriptureReferenceMatch {
  start: number
  end: number
  label: string
  target: ScriptureTarget
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
  `(${DISPLAY_BOOKS})\\s+(\\d+)(?::(\\d+)(?:\\s*[–-]\\s*(\\d+))?)?`,
  'giu'
)
const WORD_CHARACTER = /[\p{L}\p{N}_]/u

/** Find explicit display references while retaining their exact source spans for rendering. */
export function findDisplayReferences(value: string): ScriptureReferenceMatch[] {
  const results: ScriptureReferenceMatch[] = []
  DISPLAY_REFERENCE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DISPLAY_REFERENCE.exec(value)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if ((start > 0 && WORD_CHARACTER.test(value[start - 1])) || WORD_CHARACTER.test(value[end] ?? '')) {
      continue
    }
    const parsed = target(match[1], match[2], match[3], match[4])
    if (parsed) results.push({ start, end, label: match[0], target: parsed })
  }
  return results
}

/** Parse only references that spell out a recognized book and chapter. */
export function parseDisplayTargets(value: string): ScriptureTarget[] {
  return unique(findDisplayReferences(value).map((match) => match.target))
}

export function parseCrossReferenceTargets(markup: string, label: string): ScriptureTarget[] {
  const osisValues: string[] = []
  const osisAttribute = /\bosisRef\s*=\s*["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = osisAttribute.exec(markup)) !== null) osisValues.push(match[1])
  const structured = unique(osisValues.flatMap(parseOsisTargets))
  return structured.length > 0 ? structured : parseDisplayTargets(label)
}
