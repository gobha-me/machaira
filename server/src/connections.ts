import { bookInfo } from './books.js'
import type {
  SemanticIndexService,
  SemanticIndexStatus,
  SemanticNeighborResult,
  SemanticPassageSeed
} from './semantic.js'
import {
  getModuleBooks,
  listInstalledModules,
  readChapter,
  type ModuleBook,
  type ReadChapterResult,
  type RepoModuleInfo
} from './sword.js'
import type { ScriptureTarget } from './scripture-reference.js'

export type ConnectionKind = 'cross-reference' | 'thematic'

export interface ConnectionSeed extends ScriptureTarget {
  module: string
}

export interface ConnectionNode extends ConnectionSeed {
  id: string
  bookName: string
  label: string
  content: string
  seed: boolean
}

export interface ConnectionEdge {
  source: string
  target: string
  kind: ConnectionKind
  distance?: number
}

export interface ConnectionsPayload {
  nodes: ConnectionNode[]
  edges: ConnectionEdge[]
  semanticState: SemanticIndexStatus['state'] | 'unavailable'
  warnings: string[]
}

export interface ConnectionSources {
  installed(): Promise<RepoModuleInfo[]>
  books(module: string): Promise<ModuleBook[]>
  chapter(module: string, book: string, chapter: number): Promise<ReadChapterResult | null>
}

export interface ConnectionSemanticSource {
  neighbors(
    userId: string,
    seed: SemanticPassageSeed,
    limit?: number
  ): Promise<SemanticNeighborResult>
}

const DEFAULT_SOURCES: ConnectionSources = {
  installed: listInstalledModules,
  books: getModuleBooks,
  chapter: readChapter
}

const MAX_SEEDS = 5
const MAX_NODES = 40
const MAX_CROSS_REFERENCES = 6
const MAX_THEMATIC = 4

export class ConnectionInputError extends Error {}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConnectionInputError(`${name} is required`)
  const result = value.trim()
  if (result.length > 200) throw new ConnectionInputError(`${name} is too long`)
  return result
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ConnectionInputError(`${name} must be a positive integer`)
  }
  return Number(value)
}

function optionalPositiveInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null
  return positiveInteger(value, name)
}

function parseSeeds(input: unknown): ConnectionSeed[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConnectionInputError('Connections request is required')
  }
  const body = input as Record<string, unknown>
  if (!Array.isArray(body.seeds) || body.seeds.length < 1 || body.seeds.length > MAX_SEEDS) {
    throw new ConnectionInputError(`Seeds must contain between 1 and ${MAX_SEEDS} passages`)
  }
  return body.seeds.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConnectionInputError(`Seed ${index + 1} is invalid`)
    }
    const seed = value as Record<string, unknown>
    const verseStart = optionalPositiveInteger(seed.verseStart, `Seed ${index + 1} verseStart`)
    const verseEnd = optionalPositiveInteger(seed.verseEnd, `Seed ${index + 1} verseEnd`)
    if (verseStart === null && verseEnd !== null) {
      throw new ConnectionInputError(`Seed ${index + 1} cannot have verseEnd without verseStart`)
    }
    if (verseStart !== null && verseEnd !== null && verseEnd < verseStart) {
      throw new ConnectionInputError(`Seed ${index + 1} verseEnd cannot precede verseStart`)
    }
    return {
      module: requiredString(seed.module, `Seed ${index + 1} module`),
      book: requiredString(seed.book, `Seed ${index + 1} book`),
      chapter: positiveInteger(seed.chapter, `Seed ${index + 1} chapter`),
      verseStart,
      verseEnd: verseStart === null ? null : (verseEnd ?? verseStart)
    }
  })
}

function nodeId(seed: ConnectionSeed): string {
  return [
    encodeURIComponent(seed.module), encodeURIComponent(seed.book), seed.chapter,
    seed.verseStart ?? '', seed.verseEnd ?? ''
  ].join('/')
}

function passageLabel(seed: Pick<ConnectionSeed, 'book' | 'chapter' | 'verseStart' | 'verseEnd'>): string {
  let label = `${bookInfo(seed.book).name} ${seed.chapter}`
  if (seed.verseStart !== null) {
    label += `:${seed.verseStart}`
    if (seed.verseEnd !== null && seed.verseEnd !== seed.verseStart) label += `–${seed.verseEnd}`
  }
  return label
}

function snippet(value: string, max = 320): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function targetKey(target: ScriptureTarget): string {
  return `${target.book}/${target.chapter}/${target.verseStart ?? ''}/${target.verseEnd ?? ''}`
}

function selectedVerses(chapter: ReadChapterResult, seed: ScriptureTarget) {
  return chapter.verses.filter((verse) =>
    seed.verseStart === null || (
      verse.n >= seed.verseStart && verse.n <= (seed.verseEnd ?? seed.verseStart)
    )
  )
}

function nodeContent(chapter: ReadChapterResult, seed: ScriptureTarget): string {
  return snippet(selectedVerses(chapter, seed).map((verse) => verse.text).join(' '))
}

function overlaps(left: ConnectionSeed, right: ConnectionSeed): boolean {
  if (left.module !== right.module || left.book !== right.book || left.chapter !== right.chapter) return false
  if (left.verseStart === null || right.verseStart === null) return true
  const leftEnd = left.verseEnd ?? left.verseStart
  const rightEnd = right.verseEnd ?? right.verseStart
  return left.verseStart <= rightEnd && right.verseStart <= leftEnd
}

export class ConnectionsService {
  constructor(
    private readonly semantic: ConnectionSemanticSource | SemanticIndexService,
    private readonly sources: ConnectionSources = DEFAULT_SOURCES
  ) {}

  async graph(userId: string, input: unknown): Promise<ConnectionsPayload> {
    const requestedSeeds = parseSeeds(input)
    const warnings = new Set<string>()
    const nodes = new Map<string, ConnectionNode>()
    const edges = new Map<string, ConnectionEdge>()
    let semanticState: ConnectionsPayload['semanticState'] = 'unavailable'

    const installed = new Map(
      (await this.sources.installed())
        .filter((module) => module.type === 'BIBLE' && !module.locked)
        .map((module) => [module.name, module])
    )
    const books = new Map<string, ModuleBook[]>()
    const chapters = new Map<string, ReadChapterResult | null>()
    const booksFor = async (module: string): Promise<ModuleBook[]> => {
      if (!books.has(module)) books.set(module, await this.sources.books(module))
      return books.get(module)!
    }
    const chapterFor = async (module: string, book: string, chapter: number) => {
      const key = `${module}/${book}/${chapter}`
      if (!chapters.has(key)) chapters.set(key, await this.sources.chapter(module, book, chapter))
      return chapters.get(key) ?? null
    }
    const validTarget = async (module: string, value: ScriptureTarget) => {
      const book = (await booksFor(module)).find((candidate) => candidate.code === value.book)
      if (!book || value.chapter > book.chapters) return null
      const chapter = await chapterFor(module, value.book, value.chapter)
      if (!chapter) return null
      const selected = selectedVerses(chapter, value)
      if (selected.length === 0) return null
      if (value.verseStart !== null) {
        const verseNumbers = new Set(chapter.verses.map((verse) => verse.n))
        if (!verseNumbers.has(value.verseStart) || !verseNumbers.has(value.verseEnd ?? value.verseStart)) {
          return null
        }
      }
      return chapter
    }
    const addNode = (
      seed: ConnectionSeed,
      content: string,
      isSeed: boolean
    ): ConnectionNode | null => {
      const id = nodeId(seed)
      const existing = nodes.get(id)
      if (existing) {
        if (isSeed) existing.seed = true
        return existing
      }
      if (nodes.size >= MAX_NODES) {
        warnings.add(`Graph limited to ${MAX_NODES} passages`)
        return null
      }
      const node: ConnectionNode = {
        ...seed,
        id,
        bookName: bookInfo(seed.book).name,
        label: passageLabel(seed),
        content,
        seed: isSeed
      }
      nodes.set(id, node)
      return node
    }
    const addEdge = (edge: ConnectionEdge) => {
      const id = `${edge.source}|${edge.target}|${edge.kind}`
      if (!edges.has(id)) edges.set(id, edge)
    }

    const validSeeds: Array<{ seed: ConnectionSeed; chapter: ReadChapterResult; node: ConnectionNode }> = []
    for (const seed of requestedSeeds) {
      if (!installed.has(seed.module)) {
        warnings.add(`${seed.module} is not an installed, unlocked Bible module`)
        continue
      }
      const chapter = await validTarget(seed.module, seed)
      if (!chapter) {
        warnings.add(`${passageLabel(seed)} is not available in ${seed.module}`)
        continue
      }
      const node = addNode(seed, nodeContent(chapter, seed), true)
      if (node) validSeeds.push({ seed, chapter, node })
    }

    for (const { seed, chapter, node: sourceNode } of validSeeds) {
      const authoredTargets: ScriptureTarget[] = []
      let authoredLabels = 0
      for (const verse of selectedVerses(chapter, seed)) {
        authoredLabels += verse.crossReferences.length
        authoredTargets.push(...verse.crossReferenceTargets)
      }
      const seenTargets = new Set<string>()
      const distinctTargets = authoredTargets.filter((value) => {
        const id = targetKey(value)
        if (seenTargets.has(id)) return false
        seenTargets.add(id)
        return true
      })
      if (authoredLabels > 0 && distinctTargets.length === 0) {
        warnings.add('Some authored cross-references could not be resolved safely')
      }
      if (distinctTargets.length > MAX_CROSS_REFERENCES) {
        warnings.add(`Cross-references limited to ${MAX_CROSS_REFERENCES} per linked passage`)
      }
      for (const target of distinctTargets.slice(0, MAX_CROSS_REFERENCES)) {
        const linkedSeed: ConnectionSeed = { module: seed.module, ...target }
        if (overlaps(seed, linkedSeed)) continue
        const linkedChapter = await validTarget(seed.module, target)
        if (!linkedChapter) {
          warnings.add('Some authored cross-references point outside the installed module')
          continue
        }
        const linkedNode = addNode(linkedSeed, nodeContent(linkedChapter, target), false)
        if (linkedNode) addEdge({ source: sourceNode.id, target: linkedNode.id, kind: 'cross-reference' })
      }

      const semantic = await this.semantic.neighbors(userId, seed, MAX_THEMATIC)
      semanticState = semantic.state
      if (semantic.state !== 'ready') {
        warnings.add('Thematic links require a ready semantic index; cross-references remain available')
        continue
      }
      for (const neighbor of semantic.results.slice(0, MAX_THEMATIC)) {
        const linkedSeed: ConnectionSeed = {
          module: neighbor.module,
          book: neighbor.book,
          chapter: neighbor.chapter,
          verseStart: neighbor.verse,
          verseEnd: neighbor.verse
        }
        if (overlaps(seed, linkedSeed)) continue
        const linkedNode = addNode(linkedSeed, snippet(neighbor.content), false)
        if (linkedNode) {
          addEdge({
            source: sourceNode.id,
            target: linkedNode.id,
            kind: 'thematic',
            distance: neighbor.distance
          })
        }
      }
    }

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      semanticState,
      warnings: [...warnings]
    }
  }
}
