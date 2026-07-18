import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
// node-sword-interface is a CommonJS native addon.
import NodeSwordInterface from 'node-sword-interface'
import { bookInfo } from './books.js'
import { stripMarkup, parseVerseMarkup, type VerseNote, type VerseSegment } from './text.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// All downloaded SWORD modules live here (gitignored). This is the "everything
// on your machine" install root from the design.
export const SWORD_HOME = resolve(__dirname, '../data/sword')
mkdirSync(SWORD_HOME, { recursive: true })

export type ModuleType = 'BIBLE' | 'DICT' | 'COMMENTARY'

export interface RepoModuleInfo {
  name: string
  type: string
  description: string
  language: string
  abbreviation?: string
  distributionLicense?: string
  repository?: string
  version?: string
  size?: number
  about?: string
  hasStrongs: boolean
  hasGreekStrongsKeys: boolean
  hasHebrewStrongsKeys: boolean
  hasFootnotes: boolean
  hasHeadings: boolean
  hasRedLetterWords: boolean
  hasCrossReferences: boolean
  locked: boolean
  installed: boolean
}

export interface SwordVerse {
  moduleCode: string
  bibleBookShortTitle: string
  chapter: number
  verseNr: number
  content: string
}

let _nsi: NodeSwordInterface | null = null
let _configReady: Promise<void> | null = null

function sword(): NodeSwordInterface {
  if (!_nsi) {
    _nsi = new NodeSwordInterface(SWORD_HOME)
  }
  return _nsi
}

// libsword is not reentrant: a native call issued while another (e.g. the network
// `updateRepositoryConfig` fetch) is in flight crashes the addon and surfaces as a
// 500. Every access to the singleton is therefore funneled through this promise-chain
// mutex so at most one native operation runs at a time. Reads simply queue behind a
// long-running install/refresh, which is correct for a single local instance.
let _chain: Promise<unknown> = Promise.resolve()

function withSword<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = _chain.then(() => fn())
  // Keep the chain alive regardless of this job's outcome, without leaking rejections.
  _chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Ensure the remote repository configuration has been fetched at least once. */
export function ensureRepoConfig(): Promise<void> {
  if (!_configReady) {
    _configReady = withSword(async () => {
      const nsi = sword()
      if (!nsi.repositoryConfigExisting()) {
        await nsi.updateRepositoryConfig()
      }
    })
  }
  return _configReady
}

/** Force a refresh of the remote repository configuration. */
export function refreshRepoConfig(): Promise<void> {
  _configReady = withSword(async () => {
    await sword().updateRepositoryConfig()
  })
  return _configReady
}

// --- internal (unwrapped) helpers: only ever called from inside a withSword job ---

const LOCAL_TYPES: ModuleType[] = ['BIBLE', 'DICT', 'COMMENTARY']

// getAllLocalModules defaults to only BIBLE modules; gather every installed type so
// dictionaries (Strong's) and commentaries are detected as installed too.
function allLocalModulesSync(): Array<Record<string, unknown>> {
  const nsi = sword()
  const out: Array<Record<string, unknown>> = []
  for (const t of LOCAL_TYPES) {
    for (const m of nsi.getAllLocalModules(t)) out.push(m)
  }
  return out
}

function installedNamesSync(): Set<string> {
  return new Set(allLocalModulesSync().map((m) => String(m.name)))
}

function repoForModuleSync(moduleName: string): string | undefined {
  const nsi = sword()
  for (const repo of nsi.getRepoNames()) {
    if (nsi.isModuleAvailableInRepo(moduleName, repo)) return repo
  }
  return undefined
}

// getModuleSearchResults enables markup process-wide; force plain output before any
// read so footnote/heading markup doesn't leak into verse text.
function readChapterSync(module: string, book: string, chapter: number): SwordVerse[] {
  const nsi = sword()
  nsi.disableMarkup()
  return nsi.getChapterText(module, book, chapter) as SwordVerse[]
}

// Markup ON exposes footnotes/headings/Strong's tags in the rendered content so the
// reading view can pull notes out (parseVerseMarkup). Safe because every native call
// is serialized through withSword, so the process-wide flag can't be observed mid-flip.
function readChapterMarkupSync(module: string, book: string, chapter: number): SwordVerse[] {
  const nsi = sword()
  nsi.enableMarkup()
  return nsi.getChapterText(module, book, chapter) as SwordVerse[]
}

function mapModule(
  m: Record<string, unknown>,
  repo: string | undefined,
  installed: Set<string>
): RepoModuleInfo {
  const name = String(m.name)
  return {
    name,
    type: String(m.type ?? ''),
    description: String(m.description ?? ''),
    language: String(m.language ?? ''),
    abbreviation: m.abbreviation ? String(m.abbreviation) : undefined,
    distributionLicense: m.distributionLicense ? String(m.distributionLicense) : undefined,
    repository: repo ?? (m.repository ? String(m.repository) : undefined),
    version: m.version ? String(m.version) : undefined,
    size: typeof m.size === 'number' ? m.size : undefined,
    about: m.about ? String(m.about) : undefined,
    hasStrongs: Boolean(m.hasStrongs),
    hasGreekStrongsKeys: Boolean(m.hasGreekStrongsKeys),
    hasHebrewStrongsKeys: Boolean(m.hasHebrewStrongsKeys),
    hasFootnotes: Boolean(m.hasFootnotes),
    hasHeadings: Boolean(m.hasHeadings),
    hasRedLetterWords: Boolean(m.hasRedLetterWords),
    hasCrossReferences: Boolean(m.hasCrossReferences),
    locked: Boolean(m.locked),
    installed: installed.has(name)
  }
}

// --- public (serialized) API ---

export function listRepositories(): Promise<string[]> {
  return withSword(() => sword().getRepoNames())
}

/** Available modules across all repositories for a given type, flagged installed. */
export function listAvailableModules(type: ModuleType): Promise<RepoModuleInfo[]> {
  return withSword(() => {
    const nsi = sword()
    const installed = installedNamesSync()
    const out: RepoModuleInfo[] = []
    for (const repo of nsi.getRepoNames()) {
      for (const m of nsi.getAllRepoModules(repo, type)) {
        out.push(mapModule(m, repo, installed))
      }
    }
    return out
  })
}

export function listInstalledModules(): Promise<RepoModuleInfo[]> {
  return withSword(() => {
    const installed = installedNamesSync()
    return allLocalModulesSync().map((m) =>
      mapModule(m, m.repository ? String(m.repository) : undefined, installed)
    )
  })
}

interface InstallProgress {
  totalPercent: number
  filePercent: number
  message: string
}

export function installModule(
  moduleName: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return withSword(async () => {
    const nsi = sword()
    const repo = repoForModuleSync(moduleName)
    if (!repo) throw new Error(`Module ${moduleName} not found in any repository`)
    await nsi.installModule(repo, moduleName, (progress: InstallProgress) => {
      onProgress(Math.max(0, Math.min(100, Math.round(progress?.totalPercent ?? 0))))
    })
    nsi.refreshLocalModules()
  })
}

export function uninstallModule(moduleName: string): Promise<void> {
  return withSword(async () => {
    const nsi = sword()
    await nsi.uninstallModule(moduleName)
    nsi.refreshLocalModules()
  })
}

export interface ModuleBook {
  code: string
  name: string
  section: string
  chapters: number
}

/** Books present in an installed module, with display names + chapter counts. */
export function getModuleBooks(module: string): Promise<ModuleBook[]> {
  return withSword(() => {
    const nsi = sword()
    const codes: string[] = nsi.getBookList(module)
    if (!codes || codes.length === 0) return []
    return codes.map((code) => {
      const info = bookInfo(code)
      return {
        code,
        name: info.name,
        section: info.section,
        chapters: nsi.getBookChapterCount(module, code)
      }
    })
  })
}

export interface ReadVerse {
  n: number
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
}

export interface ReadChapterResult {
  verses: ReadVerse[]
}

/** A single chapter of an installed module: reading text plus extracted footnotes. */
export function readChapter(
  module: string,
  book: string,
  chapter: number
): Promise<ReadChapterResult | null> {
  return withSword(() => {
    const raw = readChapterMarkupSync(module, book, chapter)
    // getChapterText over-reads single-chapter books (Jude, Philemon, …) into the next
    // book's chapter 1. Keep only verses belonging to the requested book.
    const inBook = raw.filter((v) => v.bibleBookShortTitle === book)
    if (inBook.length === 0) return null
    return {
      verses: inBook.map((v) => {
        const parsed = parseVerseMarkup(v.content)
        return { n: v.verseNr, text: parsed.text, notes: parsed.notes, segments: parsed.segments }
      })
    }
  })
}

export interface CommentaryEntry {
  n: number
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
}

export interface CommentaryChapterResult {
  module: string
  locked: boolean
  license: string
  entries: CommentaryEntry[]
}

/**
 * A chapter of an installed commentary module: per-verse notes, keyed by verse number.
 * Commentaries share the Bible key space, so they read through the same markup pipeline as
 * readChapter. Returns null when the module isn't installed. Locked modules can't have their
 * content read, so they return no entries (the caller shows an honest locked state).
 */
export function readCommentaryChapter(
  module: string,
  book: string,
  chapter: number
): Promise<CommentaryChapterResult | null> {
  return withSword(() => {
    const local = sword().getLocalModule(module)
    if (!local) return null
    const license = local.distributionLicense ?? ''
    if (local.locked) return { module, locked: true, license, entries: [] }
    const raw = readChapterMarkupSync(module, book, chapter)
    // getChapterText over-reads single-chapter books into the next book's chapter 1; keep
    // only entries belonging to the requested book (same guard as readChapter).
    const entries = raw
      .filter((v) => v.bibleBookShortTitle === book)
      .map((v) => {
        const parsed = parseVerseMarkup(v.content)
        return { n: v.verseNr, text: parsed.text, notes: parsed.notes, segments: parsed.segments }
      })
      // Commentaries only carry entries for annotated verses; drop empty ones.
      .filter((e) => e.text.length > 0 || e.notes.length > 0)
    return { module, locked: false, license, entries }
  })
}

export interface CompareRow {
  module: string
  text: string | null
  hasStrongs: boolean
  license: string
}

/** Compare a single verse across the requested (installed) translations. */
export function compareVerse(
  book: string,
  chapter: number,
  verse: number,
  requestedModules: string[]
): Promise<CompareRow[]> {
  return withSword(() => {
    const nsi = sword()
    const installed = installedNamesSync()
    const modules = requestedModules.filter((m) => installed.has(m))
    return modules.map((module) => {
      const chapterVerses = readChapterSync(module, book, chapter)
      const hit = chapterVerses.find((v) => v.verseNr === verse)
      const local = nsi.getLocalModule(module)
      return {
        module,
        text: hit ? stripMarkup(hit.content) : null,
        hasStrongs: Boolean(local?.hasStrongs),
        license: local?.distributionLicense ?? ''
      }
    })
  })
}

export type StrongsLookup =
  | { status: 'missing-module'; language: 'greek' | 'hebrew' }
  | { status: 'not-found'; message: string }
  | {
      status: 'ok'
      entry: {
        key: string
        transcription: string
        phonetic: string
        definition: string
        references: unknown[]
      }
    }

/** Strong's lexicon entry (e.g. G2638). Requires StrongsGreek/StrongsHebrew installed. */
export function lookupStrongs(rawKey: string): Promise<StrongsLookup> {
  return withSword(() => {
    const key = rawKey.toUpperCase()
    const nsi = sword()
    const isGreek = key.startsWith('G')
    const available = isGreek ? nsi.greekStrongsAvailable() : nsi.hebrewStrongsAvailable()
    if (!available) {
      return { status: 'missing-module', language: isGreek ? 'greek' : 'hebrew' }
    }
    try {
      const e = nsi.getStrongsEntry(key)
      if (!e) return { status: 'not-found', message: `No Strong's entry for ${key}` }
      return {
        status: 'ok',
        entry: {
          key: e.key,
          transcription: e.transcription,
          phonetic: e.phoneticTranscription,
          definition: (e.definition ?? '').trim(),
          references: e.references ?? []
        }
      }
    } catch (err) {
      return { status: 'not-found', message: (err as Error).message }
    }
  })
}

export interface SearchHit {
  module: string
  book: string
  bookName: string
  chapter: number
  verse: number
  content: string
}

/** Real full-text search across one or more installed modules. */
export function searchModules(
  requestedModules: string[],
  q: string,
  searchType: 'multiWord' | 'phrase'
): Promise<SearchHit[]> {
  return withSword(async () => {
    const nsi = sword()
    const installed = installedNamesSync()
    const modules = requestedModules.filter((m) => installed.has(m))
    const results: SearchHit[] = []
    for (const module of modules) {
      const hits: SwordVerse[] = await nsi.getModuleSearchResults(module, q, undefined, searchType)
      for (const h of hits.slice(0, 50)) {
        results.push({
          module,
          book: h.bibleBookShortTitle,
          bookName: bookInfo(h.bibleBookShortTitle).name,
          chapter: h.chapter,
          verse: h.verseNr,
          content: stripMarkup(h.content)
        })
      }
    }
    return results
  })
}
