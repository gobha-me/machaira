import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync, chmodSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { bookInfo } from './books.js'
import { mapModuleReferences } from './sword.js'
import type { ScriptureTarget } from './scripture-reference.js'

export const CROSS_REFERENCE_ATTRIBUTION = {
  name: 'OpenBible.info Bible Cross References',
  url: 'https://www.openbible.info/labs/cross-references/',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  changes: 'Recompressed for offline use; references mapped to the selected translation.'
}
const metadata: { sha256: string; rows: number; snapshot: string } = JSON.parse(
  readFileSync(new URL('../resources/openbible.json', import.meta.url), 'utf8')
)
// KJV chapter bounds from SWORD canon.h (CrossWire, GPL-2.0), with OpenBible's
// 15-verse 3 John. Keep canonical numbering independent of installed modules.
const bounds: Record<string, number[]> = JSON.parse(
  readFileSync(new URL('../resources/canonical-verses.json', import.meta.url), 'utf8')
)

export interface CrossReference {
  sourceVerse: number
  module: string
  target: ScriptureTarget
  label: string
  votes: number
}
export type ReferenceMapper = typeof mapModuleReferences

function parseVerse(value: string): ScriptureTarget | null {
  const match = /^([1-3]?[A-Za-z]+)\.([1-9]\d*)\.([1-9]\d*)$/.exec(value)
  if (!match) return null
  const [, book, c, v] = match
  const chapter = Number(c), verse = Number(v)
  if (!Number.isSafeInteger(chapter) || !Number.isSafeInteger(verse) || verse > (bounds[book]?.[chapter - 1] ?? 0)) return null
  return { book, chapter, verseStart: verse, verseEnd: verse }
}

function osis(target: ScriptureTarget, verse = target.verseStart): string {
  return `${target.book}.${target.chapter}.${verse}`
}

// Split cross-chapter targets into complete, independently navigable chapters.
// Never truncate them to their first verse or normalize past a book boundary.
function parseRange(value: string): ScriptureTarget[] {
  const parts = value.split('-')
  if (parts.length > 2) return []
  const start = parseVerse(parts[0]), end = parseVerse(parts[1] ?? parts[0])
  const books = Object.keys(bounds)
  if (!start || !end) return []
  const firstBook = books.indexOf(start.book), lastBook = books.indexOf(end.book)
  if (firstBook > lastBook || (firstBook === lastBook && (start.chapter > end.chapter ||
      (start.chapter === end.chapter && start.verseStart! > end.verseStart!)))) return []
  const targets: ScriptureTarget[] = []
  for (let index = firstBook; index <= lastBook; index++) {
    const book = books[index]
    const firstChapter = book === start.book ? start.chapter : 1
    const lastChapter = book === end.book ? end.chapter : bounds[book].length
    for (let chapter = firstChapter; chapter <= lastChapter; chapter++) {
      targets.push({
        book, chapter,
        verseStart: book === start.book && chapter === start.chapter ? start.verseStart : 1,
        verseEnd: book === end.book && chapter === end.chapter ? end.verseStart : bounds[book][chapter - 1]
      })
    }
  }
  return targets
}

export function referenceLabel(target: ScriptureTarget): string {
  const start = target.verseStart!, end = target.verseEnd ?? start
  return `${bookInfo(target.book).name} ${target.chapter}:${start}${end !== start ? `–${end}` : ''}`
}

/** A rebuildable, account-independent SQLite resource cache, separate from personal data. */
export class CrossReferenceService {
  readonly db: Database.Database

  constructor(filename: string, private readonly mapReferences: ReferenceMapper = mapModuleReferences) {
    this.db = new Database(filename)
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS dataset (id INTEGER PRIMARY KEY CHECK (id = 1), sha256 TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cross_references (
          source TEXT NOT NULL, target TEXT NOT NULL, votes INTEGER NOT NULL,
          PRIMARY KEY (source, target)
        ) WITHOUT ROWID;
      `)
      const current = this.db.prepare('SELECT sha256 FROM dataset WHERE id = 1').get() as { sha256: string } | undefined
      if (current?.sha256 !== metadata.sha256) {
        this.importSnapshot(readFileSync(new URL('../resources/openbible-cross-references.tsv.gz', import.meta.url)))
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  // Verify before mutation; a failed replacement preserves the previous snapshot.
  importSnapshot(compressed: Buffer): void {
    if (createHash('sha256').update(compressed).digest('hex') !== metadata.sha256) {
      throw new Error('Cross-reference snapshot checksum mismatch')
    }
    const lines = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8').trimEnd().split(/\r?\n/)
    const header = lines.shift()
    if (header !== `From Verse\tTo Verse\tVotes\t#www.openbible.info CC-BY ${metadata.snapshot}` || lines.length !== metadata.rows) {
      throw new Error('Unexpected cross-reference snapshot header or row count')
    }
    this.db.transaction(() => {
      this.db.exec('DELETE FROM cross_references; DELETE FROM dataset;')
      const insert = this.db.prepare('INSERT INTO cross_references (source, target, votes) VALUES (?, ?, ?)')
      for (const line of lines) {
        const [source, target, votes, extra] = line.split('\t')
        if (extra !== undefined || !parseVerse(source) || parseRange(target).length === 0 || !/^-?\d+$/.test(votes) || !Number.isSafeInteger(Number(votes))) {
          throw new Error(`Invalid cross-reference snapshot row: ${line}`)
        }
        insert.run(source, target, Number(votes))
      }
      this.db.prepare('INSERT INTO dataset VALUES (1, ?)').run(metadata.sha256)
    })()
  }

  async refs(module: string, input: ScriptureTarget, limit = 100): Promise<CrossReference[]> {
    const start = input.verseStart, end = input.verseEnd ?? start
    if (!module || module.length > 200 || !Object.hasOwn(bounds, input.book) || !Number.isSafeInteger(input.chapter) || input.chapter < 1 ||
        start === null || end === null || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 1 || end < start || end - start >= 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) return []
    const sources = Array.from({ length: end - start + 1 }, (_, i) => osis(input, start + i))
    const canonical = await this.mapReferences(module, sources, 'to-canonical')
    // Require every requested source verse to exist: a partly invalid range is empty.
    if (canonical.length !== sources.length || canonical.some((targets) => targets.length === 0)) return []
    const query = this.db.prepare('SELECT target, votes FROM cross_references WHERE source = ?')
    const rows: Array<{ sourceVerse: number; target: string; votes: number }> = []
    for (const [i, targets] of canonical.entries()) {
      for (const target of targets) {
        for (let n = target.verseStart!; n <= target.verseEnd!; n++) {
          const found = query.all(osis(target, n)) as Array<{ target: string; votes: number }>
          rows.push(...found.map((row) => ({ ...row, sourceVerse: start + i })))
        }
      }
    }
    rows.sort((a, b) => b.votes - a.votes || a.target.localeCompare(b.target) || a.sourceVerse - b.sourceVerse)
    // Resolve all candidates before limiting so missing target books don't hide valid links.
    const targets = rows.flatMap((row) => parseRange(row.target).map((target) => ({ row, target })))
    const endpoints = targets.flatMap(({ target }) => [osis(target), osis(target, target.verseEnd)])
    const mapped = await this.mapReferences(module, endpoints, 'from-canonical')
    const results: CrossReference[] = [], seen = new Set<string>()
    for (const [i, { row }] of targets.entries()) {
      const first = mapped[i * 2]?.[0], last = mapped[i * 2 + 1]?.at(-1)
      if (!first || !last || first.book !== last.book || first.chapter !== last.chapter || first.verseStart! > last.verseEnd!) continue
      const target = { ...first, verseEnd: last.verseEnd }
      const key = `${osis(target)}-${target.verseEnd}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ sourceVerse: row.sourceVerse, module, target, label: referenceLabel(target), votes: row.votes })
      if (results.length === limit) break
    }
    return results
  }

  async chapter(module: string, book: string, chapter: number, verses: readonly number[]): Promise<CrossReference[]> {
    // Preserve source-verse grouping in chapter payloads; selection ranges are ranked
    // together by refs() and by the shared client selection utility.
    const refs = await Promise.all(verses.filter((n) => n > 0).map((n) =>
      this.refs(module, { book, chapter, verseStart: n, verseEnd: n }, 20)
    ))
    return refs.flat()
  }
}
