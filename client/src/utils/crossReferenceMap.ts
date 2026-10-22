import type { CrossReferenceMapPayload, CrossReferenceMapEdge } from '@machaira/scripture'

export interface MapArc {
  edge: CrossReferenceMapEdge
  index: number
  x1: number
  x2: number
  y: number
  rise: number
}

/** Geometry is independent of canvas so the same bounded work is exercised in CI. */
export function mapArcs(payload: CrossReferenceMapPayload, width: number, height: number): MapArc[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 40 || height < 80) return []
  const positions = new Map(payload.nodes.map((node, index) => [node.id, 16 + (index + 0.5) * (width - 32) / Math.max(1, payload.nodes.length)]))
  return payload.edges.flatMap((edge, index) => {
    const source = positions.get(edge.source), target = positions.get(edge.target)
    if (source === undefined || target === undefined || !Number.isSafeInteger(edge.count) || edge.count < 1) return []
    const x1 = source === target ? source - 3 : Math.min(source, target)
    const x2 = source === target ? source + 3 : Math.max(source, target)
    return [{ edge, index, x1, x2, y: height - 40, rise: 10 + (x2 - x1) / (width - 32) * (height - 70) }]
  })
}

export function hitMapArc(arcs: MapArc[], x: number, y: number): MapArc | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  let best: MapArc | null = null, distance = 6
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
