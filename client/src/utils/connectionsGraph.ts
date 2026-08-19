import type {
  BookEntry,
  ConnectionEdge,
  ConnectionNode,
  ConnectionSeed,
  ConnectionsPayload
} from '../services/api'
import { parsePassageRef } from './passageRef'

export interface SeedResolution {
  seeds: ConnectionSeed[]
  warnings: string[]
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Convert the persisted, user-facing note reference contract into API seeds. */
export async function resolveConnectionSeeds(
  references: readonly string[],
  defaultModule: string | null,
  loadBooks: (module: string) => Promise<BookEntry[]>,
  maxSeeds = 5
): Promise<SeedResolution> {
  const seeds: ConnectionSeed[] = []
  const warnings = new Set<string>()
  const booksByModule = new Map<string, BookEntry[] | null>()
  const seen = new Set<string>()

  for (const reference of references) {
    const parsed = parsePassageRef(reference)
    if (!parsed) {
      warnings.add(`Could not read linked passage “${reference}”`)
      continue
    }
    const module = parsed.moduleName ?? defaultModule
    if (!module) {
      warnings.add('Choose or install a default translation for unscoped linked passages')
      continue
    }
    if (!booksByModule.has(module)) {
      try {
        booksByModule.set(module, await loadBooks(module))
      } catch {
        booksByModule.set(module, null)
      }
    }
    const books = booksByModule.get(module)
    if (!books) {
      warnings.add(`${module} is not currently available`)
      continue
    }
    const bookNeedle = normalize(parsed.book)
    const book = books.find((candidate) =>
      normalize(candidate.code) === bookNeedle || normalize(candidate.name) === bookNeedle
    )
    if (!book || parsed.chapter > book.chapters) {
      warnings.add(`${parsed.book} ${parsed.chapter} is not available in ${module}`)
      continue
    }
    const seed: ConnectionSeed = {
      module,
      book: book.code,
      chapter: parsed.chapter,
      verseStart: parsed.verseStart,
      verseEnd: parsed.verseEnd
    }
    const key = `${module}/${book.code}/${seed.chapter}/${seed.verseStart ?? ''}/${seed.verseEnd ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    if (seeds.length < maxSeeds) seeds.push(seed)
    else warnings.add(`Connections use the first ${maxSeeds} linked passages`)
  }
  return { seeds, warnings: [...warnings] }
}

export interface PositionedConnectionNode extends ConnectionNode {
  x: number
  y: number
}

export interface VisibleGraph {
  nodes: ConnectionNode[]
  edges: ConnectionEdge[]
}

export function visibleConnections(
  payload: ConnectionsPayload,
  crossReferences: boolean,
  thematic: boolean
): VisibleGraph {
  const edges = payload.edges.filter((edge) =>
    (edge.kind === 'cross-reference' && crossReferences) ||
    (edge.kind === 'thematic' && thematic)
  )
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  return {
    edges,
    nodes: payload.nodes.filter((node) => node.seed || connected.has(node.id))
  }
}

/** Deterministic radial clusters keep the small, capped graph stable between renders. */
export function layoutConnections(
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  width = 360,
  height = 280
): PositionedConnectionNode[] {
  if (nodes.length === 0) return []
  const center = { x: width / 2, y: height / 2 }
  const seeds = nodes.filter((node) => node.seed)
  const roots = seeds.length > 0 ? seeds : [nodes[0]]
  const seedIds = new Set(roots.map((node) => node.id))
  const rootPositions = new Map<string, { x: number; y: number; angle: number }>()
  const rootRadius = roots.length === 1 ? 0 : Math.min(width, height) * 0.16
  roots.forEach((node, index) => {
    const angle = roots.length === 1 ? -Math.PI / 2 : (index / roots.length) * Math.PI * 2 - Math.PI / 2
    rootPositions.set(node.id, {
      x: center.x + Math.cos(angle) * rootRadius,
      y: center.y + Math.sin(angle) * rootRadius,
      angle
    })
  })

  const rootFor = new Map<string, string>()
  for (const edge of edges) {
    if (seedIds.has(edge.source) && !rootFor.has(edge.target)) rootFor.set(edge.target, edge.source)
    else if (seedIds.has(edge.target) && !rootFor.has(edge.source)) rootFor.set(edge.source, edge.target)
  }
  const fallbackRoot = roots[0].id
  const clusters = new Map<string, ConnectionNode[]>()
  for (const root of roots) clusters.set(root.id, [])
  for (const node of nodes) {
    if (seedIds.has(node.id)) continue
    const root = rootFor.get(node.id) ?? fallbackRoot
    clusters.get(root)?.push(node)
  }

  const positioned = new Map<string, PositionedConnectionNode>()
  for (const root of roots) {
    const position = rootPositions.get(root.id)!
    positioned.set(root.id, { ...root, x: position.x, y: position.y })
    const cluster = clusters.get(root.id) ?? []
    const spread = roots.length === 1 ? Math.PI * 1.75 : Math.min(Math.PI * 0.85, Math.PI * 2 / roots.length)
    const baseAngle = roots.length === 1 ? -Math.PI / 2 : position.angle
    const radius = Math.min(width * 0.34, height * 0.37)
    cluster.forEach((node, index) => {
      const fraction = cluster.length === 1 ? 0.5 : index / (cluster.length - 1)
      const angle = baseAngle - spread / 2 + spread * fraction
      positioned.set(node.id, {
        ...node,
        x: Math.max(24, Math.min(width - 24, position.x + Math.cos(angle) * radius)),
        y: Math.max(24, Math.min(height - 24, position.y + Math.sin(angle) * radius))
      })
    })
  }
  return nodes.flatMap((node) => positioned.get(node.id) ?? [])
}
