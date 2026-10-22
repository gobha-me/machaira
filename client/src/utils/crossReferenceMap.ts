import type { CrossReferenceMapPayload, CrossReferenceMapEdge } from '@machaira/scripture'

export interface MapArc {
  edge: CrossReferenceMapEdge
  index: number
  x1: number
  x2: number
  y: number
  rise: number
  distance: number | null
}

export interface MapViewport { scale: number; x: number; y: number }
export const initialMapViewport = (): MapViewport => ({ scale: 1, x: 0, y: 0 })

export function panMap(view: MapViewport, x: number, y: number, width: number, height: number): MapViewport {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return view
  return { scale: view.scale, x: Math.max(width * (1 - view.scale), Math.min(0, x)), y: Math.max(height * (1 - view.scale), Math.min(0, y)) }
}

/** Keep the world point under the cursor fixed, except at the content boundaries. */
export function zoomMap(view: MapViewport, factor: number, x: number, y: number, width: number, height: number): MapViewport {
  if (![factor, x, y, width, height].every(Number.isFinite) || factor <= 0 || width <= 0 || height <= 0) return view
  const scale = Math.max(1, Math.min(8, view.scale * factor))
  return panMap({ ...view, scale }, x - (x - view.x) * scale / view.scale, y - (y - view.y) * scale / view.scale, width, height)
}

export function mapArcWeight(count: number, maximum: number) {
  const strength = Math.sqrt(Math.max(0, Math.min(1, count / Math.max(1, maximum))))
  return { opacity: 0.025 + strength * 0.5, width: 0.4 + strength * 3.6 }
}

/** Geometry is independent of canvas so the same bounded work is exercised in CI. */
export function mapArcs(payload: CrossReferenceMapPayload, width: number, height: number, filter?: { distances: Array<number | null>; maximum: number }): MapArc[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 40 || height < 80) return []
  const positions = new Map(payload.nodes.map((node, index) => [node.id, 16 + (index + 0.5) * (width - 32) / Math.max(1, payload.nodes.length)]))
  // Merge reciprocal book pairs only for the overview drawing. Keep the API/list
  // directed, and retain a real representative's direction and sample for opening Read.
  const overview = payload.nodes.every((node) => node.chapter === null && node.verse === null)
  const pairs = new Map<string, MapArc>()
  const arcs: MapArc[] = []
  payload.edges.forEach((edge, index) => {
    const source = positions.get(edge.source), target = positions.get(edge.target)
    if (source === undefined || target === undefined || !Number.isSafeInteger(edge.count) || edge.count < 1) return
    const distance = filter?.distances[index] ?? null
    // Filter directed edges before combining reciprocal pairs, so missing scores never leak in.
    if (filter && (distance === null || !Number.isFinite(distance) || distance < 0 || !Number.isFinite(filter.maximum) || distance > filter.maximum)) return
    const pair = JSON.stringify([Math.min(source, target), Math.max(source, target)])
    const existing = overview ? pairs.get(pair) : undefined
    if (existing) {
      const count = existing.edge.count + edge.count
      if (!Number.isSafeInteger(count)) return
      if (distance !== null && existing.distance !== null) existing.distance += (distance - existing.distance) * (edge.count / count)
      existing.edge = { ...existing.edge, count }
      return
    }
    const x1 = source === target ? source - 3 : Math.min(source, target)
    const x2 = source === target ? source + 3 : Math.max(source, target)
    const arc = { edge, index, x1, x2, y: height - 40, rise: 10 + (x2 - x1) / (width - 32) * (height - 70), distance }
    arcs.push(arc)
    if (overview) pairs.set(pair, arc)
  })
  return arcs
}

export function hitMapArc(arcs: MapArc[], x: number, y: number, tolerance = 6): MapArc | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  let best: MapArc | null = null, distance = tolerance
  for (const arc of arcs) {
    const t = (x - arc.x1) / (arc.x2 - arc.x1)
    if (t < 0 || t > 1) continue
    const expected = arc.y - 4 * arc.rise * t * (1 - t)
    const delta = Math.abs(expected - y)
    if (delta < distance) { distance = delta; best = arc }
  }
  return best
}

export function mapArcColor(index: number, count: number, distance?: number | null): string {
  if (distance != null && Number.isFinite(distance) && distance >= 0) {
    return `hsl(${265 - Math.min(1, distance / 2) * 220} 65% 48%)`
  }
  return `hsl(${25 + index / Math.max(1, count - 1) * 260} 60% 48%)`
}
