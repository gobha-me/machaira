// OSIS short code -> display name + testament, for the reader's book picker.
// Covers the Protestant canon plus the deuterocanon/apocrypha that SWORD modules
// like KJVA and the LXX expose.

export interface BookInfo {
  code: string
  name: string
  section: 'ot' | 'nt' | 'apocrypha'
}

const BOOKS: BookInfo[] = [
  ['Gen', 'Genesis', 'ot'], ['Exod', 'Exodus', 'ot'], ['Lev', 'Leviticus', 'ot'],
  ['Num', 'Numbers', 'ot'], ['Deut', 'Deuteronomy', 'ot'], ['Josh', 'Joshua', 'ot'],
  ['Judg', 'Judges', 'ot'], ['Ruth', 'Ruth', 'ot'], ['1Sam', '1 Samuel', 'ot'],
  ['2Sam', '2 Samuel', 'ot'], ['1Kgs', '1 Kings', 'ot'], ['2Kgs', '2 Kings', 'ot'],
  ['1Chr', '1 Chronicles', 'ot'], ['2Chr', '2 Chronicles', 'ot'], ['Ezra', 'Ezra', 'ot'],
  ['Neh', 'Nehemiah', 'ot'], ['Esth', 'Esther', 'ot'], ['Job', 'Job', 'ot'],
  ['Ps', 'Psalms', 'ot'], ['Prov', 'Proverbs', 'ot'], ['Eccl', 'Ecclesiastes', 'ot'],
  ['Song', 'Song of Solomon', 'ot'], ['Isa', 'Isaiah', 'ot'], ['Jer', 'Jeremiah', 'ot'],
  ['Lam', 'Lamentations', 'ot'], ['Ezek', 'Ezekiel', 'ot'], ['Dan', 'Daniel', 'ot'],
  ['Hos', 'Hosea', 'ot'], ['Joel', 'Joel', 'ot'], ['Amos', 'Amos', 'ot'],
  ['Obad', 'Obadiah', 'ot'], ['Jonah', 'Jonah', 'ot'], ['Mic', 'Micah', 'ot'],
  ['Nah', 'Nahum', 'ot'], ['Hab', 'Habakkuk', 'ot'], ['Zeph', 'Zephaniah', 'ot'],
  ['Hag', 'Haggai', 'ot'], ['Zech', 'Zechariah', 'ot'], ['Mal', 'Malachi', 'ot'],
  ['Matt', 'Matthew', 'nt'], ['Mark', 'Mark', 'nt'], ['Luke', 'Luke', 'nt'],
  ['John', 'John', 'nt'], ['Acts', 'Acts', 'nt'], ['Rom', 'Romans', 'nt'],
  ['1Cor', '1 Corinthians', 'nt'], ['2Cor', '2 Corinthians', 'nt'], ['Gal', 'Galatians', 'nt'],
  ['Eph', 'Ephesians', 'nt'], ['Phil', 'Philippians', 'nt'], ['Col', 'Colossians', 'nt'],
  ['1Thess', '1 Thessalonians', 'nt'], ['2Thess', '2 Thessalonians', 'nt'],
  ['1Tim', '1 Timothy', 'nt'], ['2Tim', '2 Timothy', 'nt'], ['Titus', 'Titus', 'nt'],
  ['Phlm', 'Philemon', 'nt'], ['Heb', 'Hebrews', 'nt'], ['Jas', 'James', 'nt'],
  ['1Pet', '1 Peter', 'nt'], ['2Pet', '2 Peter', 'nt'], ['1John', '1 John', 'nt'],
  ['2John', '2 John', 'nt'], ['3John', '3 John', 'nt'], ['Jude', 'Jude', 'nt'],
  ['Rev', 'Revelation', 'nt'],
  // Deuterocanon / apocrypha (KJVA, LXX, etc.)
  ['Tob', 'Tobit', 'apocrypha'], ['Jdt', 'Judith', 'apocrypha'],
  ['AddEsth', 'Additions to Esther', 'apocrypha'], ['Wis', 'Wisdom of Solomon', 'apocrypha'],
  ['Sir', 'Sirach', 'apocrypha'], ['Bar', 'Baruch', 'apocrypha'],
  ['EpJer', 'Epistle of Jeremiah', 'apocrypha'], ['PrAzar', 'Prayer of Azariah', 'apocrypha'],
  ['Sus', 'Susanna', 'apocrypha'], ['Bel', 'Bel and the Dragon', 'apocrypha'],
  ['1Macc', '1 Maccabees', 'apocrypha'], ['2Macc', '2 Maccabees', 'apocrypha'],
  ['1Esd', '1 Esdras', 'apocrypha'], ['2Esd', '2 Esdras', 'apocrypha'],
  ['PrMan', 'Prayer of Manasseh', 'apocrypha']
].map(([code, name, section]) => ({ code, name, section }) as BookInfo)

const BY_CODE = new Map(BOOKS.map((b) => [b.code, b]))

export function bookName(code: string): string {
  return BY_CODE.get(code)?.name ?? code
}

export function bookInfo(code: string): BookInfo {
  return BY_CODE.get(code) ?? { code, name: code, section: 'ot' }
}
