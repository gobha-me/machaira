import type { CrossReferenceMapScope, CrossReferenceMapNode, CrossReferenceMapPayload, ScriptureTarget } from '@machaira/scripture'
import { validModuleName } from '@machaira/scripture'
import { readFileSync } from 'node:fs'
import { bookInfo } from './books.js'
import { type CrossReferenceService } from './cross-references.js'
import { mapModuleReferences } from './sword.js'
import type { SemanticIndexService } from './semantic.js'

const bounds: Record<string, number[]> = JSON.parse(readFileSync(new URL('../resources/canonical-verses.json', import.meta.url), 'utf8'))
export class MapInputError extends Error {}

export function mapScope(input: unknown): CrossReferenceMapScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MapInputError('Map scope is required')
  const body = input as Record<string, unknown>
  if (Object.keys(body).some((key) => key !== 'book' && key !== 'chapter')) throw new MapInputError('Unknown map scope field')
  if (body.book !== undefined && (typeof body.book !== 'string' || !Object.hasOwn(bounds, body.book))) throw new MapInputError('Unknown canonical book')
  if (body.chapter !== undefined && (!body.book || !Number.isSafeInteger(body.chapter) || Number(body.chapter) < 1 || Number(body.chapter) > bounds[String(body.book)].length)) {
    throw new MapInputError('Invalid canonical chapter')
  }
  return { book: body.book as string | undefined, chapter: body.chapter as number | undefined }
}

export function canonicalReference(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40) throw new MapInputError('Invalid canonical verse')
  const match = /^([1-3]?[A-Za-z]+)\.([1-9]\d*)\.([1-9]\d*)$/.exec(value)
  if (!match || !Object.hasOwn(bounds, match[1]) || Number(match[3]) > (bounds[match[1]][Number(match[2]) - 1] ?? 0)) throw new MapInputError('Invalid canonical verse')
  return value
}

export function mapModule(value: unknown): string {
  if (!validModuleName(value)) throw new MapInputError('Invalid translation')
  return value
}

/** Aggregation stays beside the verified SQLite resource: no 340k-row JSON transfer. */
export class CrossReferenceMapService {
  private initialized = false
  private readonly cache = new Map<string, CrossReferenceMapPayload>()
  constructor(private readonly refs: Pick<CrossReferenceService, 'db'>, private readonly mapper = mapModuleReferences) {}

  graph(input: unknown): CrossReferenceMapPayload {
    const scope = mapScope(input)
    const cacheKey = JSON.stringify(scope)
    const cached = this.cache.get(cacheKey)
    if (cached) return cached
    const db = this.refs.db
    if (!this.initialized) {
      // Each dataset row counts once. Ranged targets are plotted at their first verse;
      // expanding ranges would overstate the link count and distort the overview.
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS map_links AS
        WITH starts AS (
          SELECT source, target, CASE WHEN instr(target, '-') > 0 THEN substr(target, 1, instr(target, '-') - 1) ELSE target END AS t
          FROM cross_references
        ), parts AS (
          SELECT source, target, substr(source, 1, instr(source, '.') - 1) AS sb,
            substr(source, instr(source, '.') + 1) AS srest,
            substr(t, 1, instr(t, '.') - 1) AS tb, substr(t, instr(t, '.') + 1) AS trest, t
          FROM starts
        ) SELECT source, t AS target, sb, CAST(srest AS INTEGER) AS sc,
          CAST(substr(srest, instr(srest, '.') + 1) AS INTEGER) AS sv,
          tb, CAST(trest AS INTEGER) AS tc,
          CAST(substr(trest, instr(trest, '.') + 1) AS INTEGER) AS tv FROM parts;
        CREATE INDEX IF NOT EXISTS temp.map_source ON map_links(sb, sc);
        CREATE INDEX IF NOT EXISTS temp.map_target ON map_links(tb, tc);`)
      this.initialized = true
    }
    const nodes: CrossReferenceMapNode[] = []
    for (const [book, chapters] of Object.entries(bounds)) {
      if (book !== scope.book) nodes.push({ id: book, book, chapter: null, verse: null, label: bookInfo(book).name })
      else if (scope.chapter === undefined) {
        for (let chapter = 1; chapter <= chapters.length; chapter++) nodes.push({ id: `${book}.${chapter}`, book, chapter, verse: null, label: `${bookInfo(book).name} ${chapter}` })
      } else {
        for (let verse = 1; verse <= chapters[scope.chapter - 1]; verse++) nodes.push({ id: `${book}.${scope.chapter}.${verse}`, book, chapter: scope.chapter, verse, label: `${bookInfo(book).name} ${scope.chapter}:${verse}` })
      }
    }
    // At verse zoom, other chapters in the focused book remain on the axis.
    if (scope.chapter !== undefined) {
      for (let chapter = 1; chapter <= bounds[scope.book!].length; chapter++) {
        if (chapter !== scope.chapter) nodes.push({ id: `${scope.book}.${chapter}`, book: scope.book!, chapter, verse: null, label: `${bookInfo(scope.book!).name} ${chapter}` })
      }
      const order = Object.keys(bounds)
      nodes.sort((a, b) => order.indexOf(a.book) - order.indexOf(b.book) || (a.chapter ?? 0) - (b.chapter ?? 0) || (a.verse ?? 0) - (b.verse ?? 0))
    }
    const key = (prefix: 's' | 't') => `CASE WHEN ${prefix}b = @book THEN
      CASE WHEN @chapter IS NULL OR ${prefix}c != @chapter THEN ${prefix}b || '.' || ${prefix}c
      ELSE ${prefix}b || '.' || ${prefix}c || '.' || ${prefix}v END ELSE ${prefix}b END`
    const edges = db.prepare(`SELECT ${key('s')} AS source, ${key('t')} AS target, count(*) AS count,
        min(source || '|' || target) AS sample
      FROM map_links WHERE @book IS NULL OR
        (sb = @book AND (@chapter IS NULL OR sc = @chapter)) OR
        (tb = @book AND (@chapter IS NULL OR tc = @chapter))
      GROUP BY 1, 2 ORDER BY 1, 2`).all({ book: scope.book ?? null, chapter: scope.chapter ?? null }) as Array<{ source: string; target: string; count: number; sample: string }>
    const payload = {
      nodes,
      edges: edges.map((edge) => { const [source, target] = edge.sample.split('|'); return { ...edge, sample: { source, target } } }),
      totalLinks: (db.prepare('SELECT count(*) AS n FROM map_links').get() as { n: number }).n,
      matchedLinks: edges.reduce((sum, edge) => sum + edge.count, 0)
    }
    // Bounded shared cache contains only account-independent canonical aggregates.
    if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(cacheKey, payload)
    return payload
  }

  async resolve(module: unknown, reference: unknown): Promise<ScriptureTarget | null> {
    const mapped = await this.mapper(mapModule(module), [canonicalReference(reference)], 'from-canonical')
    const targets = mapped[0] ?? []
    // Never silently choose one part of a split, cross-chapter canonical verse.
    return targets.length === 1 ? targets[0] : null
  }

  async similarities(userId: string, module: unknown, scope: unknown, semantic: Pick<SemanticIndexService, 'mapDistances'>) {
    const name = mapModule(module)
    const graph = this.graph(scope)
    const references: string[] = [], owners: CrossReferenceMapNode[] = []
    for (const node of graph.nodes) {
      if (node.chapter === null) continue
      const first = node.verse ?? 1, last = node.verse ?? bounds[node.book][node.chapter - 1]
      for (let verse = first; verse <= last; verse++) {
        references.push(`${node.book}.${node.chapter}.${verse}`)
        owners.push(node)
      }
    }
    // Resolve every canonical verse, not just chapter one/endpoints: translations
    // can merge Psalms, split chapters, or number headings. A chapter centroid must
    // include exactly its mapped verses, rather than the entire receiving chapter.
    const mapped = await this.mapper(name, references, 'from-canonical')
    const nodes = graph.nodes.filter((node) => node.chapter === null)
    for (const [index, targets] of mapped.entries()) {
      const owner = owners[index]
      for (const target of targets) {
        for (let verse = target.verseStart!; verse <= target.verseEnd!; verse++) {
          nodes.push({ ...owner, book: target.book, chapter: target.chapter, verse })
        }
      }
    }
    return semantic.mapDistances(userId, name, nodes, graph.edges)
  }
}
