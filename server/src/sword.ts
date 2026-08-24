import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
// node-sword-interface is a CommonJS native addon.
import NodeSwordInterface from 'node-sword-interface'
import { bookInfo } from './books.js'
import { stripMarkup, parseVerseMarkup, type VerseNote, type VerseSegment } from './text.js'
import type { ScriptureTarget } from './scripture-reference.js'
import { auditedCoverage } from './catalog-audit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// All downloaded SWORD modules live here (gitignored). This is the "everything
// on your machine" install root from the design.
export const SWORD_HOME = resolve(__dirname, '../data/sword')
export const SWORD_DATA_DIR = resolve(SWORD_HOME, process.platform === 'win32' ? 'sword' : '.sword')
mkdirSync(SWORD_HOME, { recursive: true })

export type ModuleType = 'BIBLE' | 'GENBOOK' | 'DICT' | 'COMMENTARY'
export type CatalogKind = 'scripture' | 'general-book' | 'lexicon' | 'commentary'
export type CatalogCollection = 'bible' | 'deuterocanon' | 'ancient-writings' | 'reference'

export interface RepoModuleInfo {
  id: string
  name: string
  type: string
  description: string
  language: string
  abbreviation?: string
  distributionLicense?: string
  repository?: string
  version?: string
  versification?: string
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
  kind: CatalogKind
  collection: CatalogCollection
  tradition?: string
  coverage: string[]
  coverageSource: 'live' | 'audit' | 'unknown'
  format: 'bundled' | 'standalone' | 'reference'
  coverageSummary: string
  aiEligibility: 'public-domain' | 'review-required'
}

export interface RepositoryDiagnostic {
  name: string
  status: 'healthy' | 'failed' | 'cached' | 'unknown'
  moduleCount: number
  message?: string
}

export interface RepositoryRefreshResult {
  refreshedAt: number
  usedCachedCatalog: boolean
  repositories: RepositoryDiagnostic[]
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
let _lastRefresh: RepositoryRefreshResult | null = null

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
        await updateRepoStatusSync(nsi)
      }
    })
  }
  return _configReady
}

/** Force a refresh of the remote repository configuration. */
export function refreshRepoConfig(): Promise<RepositoryRefreshResult> {
  _configReady = withSword(async () => {
    await updateRepoStatusSync(sword())
  })
  return _configReady.then(() => _lastRefresh ?? diagnosticsFromCacheSync())
}

function diagnosticsFromCacheSync(): RepositoryRefreshResult {
  const nsi = sword()
  const repositories = nsi.getRepoNames().map((name) => ({
    name,
    status: 'cached' as const,
    moduleCount: supportedModuleCountSync(nsi, name)
  }))
  return { refreshedAt: Date.now(), usedCachedCatalog: true, repositories }
}

async function updateRepoStatusSync(nsi: NodeSwordInterface): Promise<void> {
  const hadCache = nsi.repositoryConfigExisting()
  let raw: Record<string, unknown>
  try {
    raw = await nsi.updateRepositoryConfig() as Record<string, unknown>
  } catch (error) {
    if (!hadCache) throw error
    _lastRefresh = {
      refreshedAt: Date.now(),
      usedCachedCatalog: true,
      repositories: nsi.getRepoNames().map((name) => ({
        name,
        status: 'failed',
        moduleCount: supportedModuleCountSync(nsi, name),
        message: `Refresh failed; cached catalog remains available: ${(error as Error).message}`
      }))
    }
    return
  }
  const repositories = nsi.getRepoNames().map((name) => {
    const ok = raw[name] === true
    return {
      name,
      status: ok ? 'healthy' as const : 'failed' as const,
      moduleCount: supportedModuleCountSync(nsi, name),
      message: ok ? undefined : 'Refresh failed; cached catalog remains available'
    }
  })
  _lastRefresh = {
    refreshedAt: Date.now(),
    usedCachedCatalog: repositories.some((repo) => repo.status === 'failed'),
    repositories
  }
}

// --- internal (unwrapped) helpers: only ever called from inside a withSword job ---

const LOCAL_TYPES: ModuleType[] = ['BIBLE', 'GENBOOK', 'DICT', 'COMMENTARY']

function supportedModuleCountSync(nsi: NodeSwordInterface, repository: string): number {
  return LOCAL_TYPES.reduce((count, type) => count + nsi.getAllRepoModules(repository, type).length, 0)
}

// getAllLocalModules defaults to only BIBLE modules; gather every installed type so
// dictionaries (Strong's) and commentaries are detected as installed too.
function allLocalModulesSync(): Array<Record<string, unknown>> {
  const nsi = sword()
  const out: Array<Record<string, unknown>> = []
  for (const t of LOCAL_TYPES) {
    for (const m of nsi.getAllLocalModules(t)) {
      m.type = t
      out.push(m)
    }
  }
  return out
}

function installedNamesSync(): Set<string> {
  return new Set(allLocalModulesSync().map((m) => String(m.name)))
}

function installedModulesSync(): Map<string, string | undefined> {
  return new Map(allLocalModulesSync().map((module) => [
    String(module.name),
    module.repository ? String(module.repository) : undefined
  ]))
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
  installed: Map<string, string | undefined>
): RepoModuleInfo {
  const name = String(m.name)
  const type = String(m.type ?? '')
  const kind: CatalogKind = type === 'BIBLE' || type === 'Biblical Texts'
    ? 'scripture'
    : type === 'GENBOOK' || type === 'Generic Books'
      ? 'general-book'
      : type === 'DICT' || type === 'Lexicons / Dictionaries'
        ? 'lexicon'
        : 'commentary'
  const repository = repo ?? (m.repository ? String(m.repository) : undefined)
  const version = m.version ? String(m.version) : undefined
  const audit = auditedCoverage(repository, name, version)
  const license = m.distributionLicense ? String(m.distributionLicense) : undefined
  const canonMetadata = [name, m.description, m.about, m.category, m.versification]
    .filter(Boolean).join(' ')
  const canonCandidate = kind === 'scripture' && /apocry|deutero|septuagint|\blxx\b|\bkjva\b|\bnrsva\b|vulgate|orthodox/i.test(canonMetadata)
  return {
    id: `${repository ?? 'local'}:${name}`,
    name,
    type,
    description: String(m.description ?? ''),
    language: String(m.language ?? ''),
    abbreviation: m.abbreviation ? String(m.abbreviation) : undefined,
    distributionLicense: license,
    repository,
    version,
    versification: m.versification ? String(m.versification) : undefined,
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
    installed: installed.has(name) && (!repo || !installed.get(name) || installed.get(name) === repo),
    kind,
    collection: audit?.collection ?? (canonCandidate ? 'deuterocanon' : kind === 'scripture' ? 'bible' : 'reference'),
    tradition: audit?.tradition,
    coverage: audit?.books ?? [],
    coverageSource: audit ? 'audit' : 'unknown',
    format: kind === 'scripture' ? 'bundled' : kind === 'general-book' ? 'standalone' : 'reference',
    coverageSummary: audit?.name === 'KJVA'
      ? 'Complete 14-book KJV Apocrypha · bundled with a Bible'
      : audit?.collection === 'ancient-writings'
        ? 'Standalone ancient writing'
        : audit
          ? `${audit.books.length} separately keyed additional books · bundled with a Bible`
          : 'Exact book coverage has not been audited',
    aiEligibility: /public domain/i.test(license ?? '') ? 'public-domain' : 'review-required'
  }
}

// --- public (serialized) API ---

export function listRepositories(): Promise<string[]> {
  return withSword(() => sword().getRepoNames())
}

export function repositoryDiagnostics(): Promise<RepositoryRefreshResult> {
  return withSword(() => {
    if (_lastRefresh) {
      return {
        ..._lastRefresh,
        repositories: _lastRefresh.repositories.map((repo) => ({
          ...repo,
          moduleCount: supportedModuleCountSync(sword(), repo.name)
        }))
      }
    }
    return diagnosticsFromCacheSync()
  })
}

export function listCatalog(): Promise<RepoModuleInfo[]> {
  return withSword(() => {
    const nsi = sword()
    const installed = installedModulesSync()
    const modules: RepoModuleInfo[] = []
    for (const repository of nsi.getRepoNames()) {
      for (const type of LOCAL_TYPES) {
        for (const raw of nsi.getAllRepoModules(repository, type)) {
          raw.type = type
          const module = mapModule(raw, repository, installed)
          if (module.installed && module.kind === 'scripture') {
            module.coverage = (nsi.getBookList(module.name) ?? []).filter((code) => bookInfo(code).section === 'apocrypha')
            module.coverageSource = 'live'
            module.coverageSummary = `${module.coverage.length} separately keyed additional books · bundled with a Bible`
            if (module.coverage.some((code) => bookInfo(code).section === 'apocrypha')) module.collection = 'deuterocanon'
          }
          modules.push(module)
        }
      }
    }
    for (const raw of allLocalModulesSync()) {
      const name = String(raw.name)
      if (!modules.some((module) => module.name === name)) {
        const module = mapModule(raw, raw.repository ? String(raw.repository) : 'Local import', installed)
        if (module.kind === 'scripture') {
          const codes = (nsi.getBookList(name) ?? []).filter((code) => bookInfo(code).section === 'apocrypha')
          module.coverage = codes
          module.coverageSource = 'live'
          module.coverageSummary = `${codes.length} separately keyed additional books · bundled with a Bible`
          if (codes.some((code) => bookInfo(code).section === 'apocrypha')) module.collection = 'deuterocanon'
        }
        modules.push(module)
      }
    }
    return modules
  })
}

/** Available modules across all repositories for a given type, flagged installed. */
export function listAvailableModules(type: ModuleType): Promise<RepoModuleInfo[]> {
  return withSword(() => {
    const nsi = sword()
    const installed = installedModulesSync()
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
    const installed = installedModulesSync()
    return allLocalModulesSync().map((m) => {
      const module = mapModule(m, m.repository ? String(m.repository) : undefined, installed)
      if (module.kind === 'scripture') {
        module.coverage = (sword().getBookList(module.name) ?? []).filter((code) => bookInfo(code).section === 'apocrypha')
        module.coverageSource = 'live'
        module.coverageSummary = `${module.coverage.length} separately keyed additional books · bundled with a Bible`
        if (module.coverage.some((code) => bookInfo(code).section === 'apocrypha')) module.collection = 'deuterocanon'
      }
      return module
    })
  })
}

interface InstallProgress {
  totalPercent: number
  filePercent: number
  message: string
}

export function installModule(
  repository: string,
  moduleName: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return withSword(async () => {
    const nsi = sword()
    if (!nsi.getRepoNames().includes(repository) || !nsi.isModuleAvailableInRepo(moduleName, repository)) {
      throw new Error(`Module ${moduleName} is not available from ${repository}`)
    }
    await nsi.installModule(repository, moduleName, (progress: InstallProgress) => {
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

export function refreshLocalModules(): Promise<void> {
  return withSword(() => sword().refreshLocalModules())
}

export interface ModuleBook {
  code: string
  name: string
  section: string
  chapters: number
}

export interface GeneralBookEntry {
  key: string
  title: string
  content: string
  depth: number
}

export function getGeneralBookEntries(module: string, limit = 100000): Promise<GeneralBookEntry[]> {
  return withSword(() => {
    const local = sword().getLocalModule(module)
    if (!local || String(local.type) !== 'Generic Books') return []
    return sword().getGenBookEntries(module, limit)
      .map((entry) => {
        const key = String(entry.key || '').trim()
        const pieces = key.split('/').filter(Boolean)
        return {
          key,
          title: pieces.at(-1) ?? key,
          content: stripMarkup(String(entry.content ?? '')).trim(),
          depth: Math.max(0, pieces.length - 1)
        }
      })
      .filter((entry) => entry.key.length > 0)
  })
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
  crossReferences: string[]
  crossReferenceTargets: ScriptureTarget[]
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
        return {
          n: v.verseNr,
          text: parsed.text,
          notes: parsed.notes,
          segments: parsed.segments,
          crossReferences: parsed.crossReferences,
          crossReferenceTargets: parsed.crossReferenceTargets
        }
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
  hasStrongs: boolean
  license: string
  verses: { n: number; text: string | null }[]
}

/**
 * Compare a verse range across the requested (installed) translations. A single verse is just
 * lo === hi. getChapterText already reads the whole chapter, so a range is a filter — no extra
 * native read. hasStrongs/license are per-translation; the per-verse text is plain (markup off).
 */
export function compareRange(
  book: string,
  chapter: number,
  lo: number,
  hi: number,
  requestedModules: string[]
): Promise<CompareRow[]> {
  return withSword(() => {
    const nsi = sword()
    const installed = installedNamesSync()
    const modules = requestedModules.filter((m) => installed.has(m))
    return modules.map((module) => {
      // getChapterText over-reads single-chapter books (Jude, Philemon, …) into the next book's
      // chapter 1; keep only verses belonging to the requested book (same guard as readChapter).
      const chapterVerses = readChapterSync(module, book, chapter).filter(
        (v) => v.bibleBookShortTitle === book
      )
      const verses = chapterVerses
        .filter((v) => v.verseNr >= lo && v.verseNr <= hi)
        .sort((a, b) => a.verseNr - b.verseNr)
        .map((v) => ({ n: v.verseNr, text: stripMarkup(v.content) as string | null }))
      const local = nsi.getLocalModule(module)
      return {
        module,
        hasStrongs: Boolean(local?.hasStrongs),
        license: local?.distributionLicense ?? '',
        verses
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

export interface ScriptureSearchHit {
  kind: 'scripture'
  module: string
  book: string
  bookName: string
  chapter: number
  verse: number
  content: string
}

export interface GeneralBookSearchHit {
  kind: 'general-book'
  module: string
  key: string
  title: string
  content: string
}

export type SearchHit = ScriptureSearchHit | GeneralBookSearchHit

export interface PlainVerse {
  module: string
  book: string
  bookName: string
  chapter: number
  verse: number
  content: string
}

/** Plain verse text for indexing. Markup stays disabled and single-chapter over-read is removed. */
export function readPlainChapter(
  module: string,
  book: string,
  chapter: number
): Promise<PlainVerse[]> {
  return withSword(() => readChapterSync(module, book, chapter)
    .filter((verse) => verse.bibleBookShortTitle === book)
    .map((verse) => ({
      module,
      book,
      bookName: bookInfo(book).name,
      chapter,
      verse: verse.verseNr,
      content: stripMarkup(verse.content).trim()
    }))
    .filter((verse) => verse.content.length > 0))
}

/** Real full-text search across one or more installed modules. */
export function searchModules(
  requestedModules: string[],
  q: string,
  searchType: 'multiWord' | 'phrase'
): Promise<SearchHit[]> {
  return withSword(async () => {
    const nsi = sword()
    const local = allLocalModulesSync()
    const installed = new Map(local.map((module) => [String(module.name), String(module.type)]))
    const modules = requestedModules.filter((m) => installed.has(m))
    const results: SearchHit[] = []
    for (const module of modules) {
      if (installed.get(module) === 'GENBOOK') {
        const terms = q.toLocaleLowerCase().split(/\s+/).filter(Boolean)
        for (const entry of nsi.getGenBookEntries(module, 100000)) {
          const key = String(entry.key ?? '')
          const content = stripMarkup(String(entry.content ?? '')).trim()
          const haystack = `${key} ${content}`.toLocaleLowerCase()
          const matches = searchType === 'phrase'
            ? haystack.includes(q.toLocaleLowerCase())
            : terms.every((term) => haystack.includes(term))
          if (!matches) continue
          const title = key.split('/').filter(Boolean).at(-1) ?? key
          results.push({ kind: 'general-book', module, key, title, content })
          if (results.length >= 200) break
        }
        continue
      }
      if (installed.get(module) !== 'BIBLE') continue
      const hits: SwordVerse[] = await nsi.getModuleSearchResults(module, q, undefined, searchType)
      for (const h of hits.slice(0, 50)) {
        results.push({
          kind: 'scripture',
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
