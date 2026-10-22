import { describe, expect, it } from 'vitest'
import type { CrossReferenceMapPayload } from '@machaira/scripture'
import { mapArcs, hitMapArc, mapArcColor, mapArcWeight, initialMapViewport, panMap, zoomMap } from './crossReferenceMap'

const payload: CrossReferenceMapPayload = {
  nodes: [
    { id: 'Gen', book: 'Gen', label: 'Genesis', chapter: null, verse: null },
    { id: 'Rev', book: 'Rev', label: 'Revelation', chapter: null, verse: null }
  ],
  edges: [{ source: 'Gen', target: 'Rev', count: 82, sample: { source: 'Gen.1.1', target: 'Rev.14.7' } }],
  totalLinks: 82, matchedLinks: 82
}

describe('canvas arc geometry and work budget', () => {
  it('rejects invalid viewports, broken endpoints and corrupt link counts without NaN geometry', () => {
    for (const [width, height] of [[0, 800], [390, 0], [NaN, 800], [Infinity, 844], [1280, -1]]) expect(mapArcs(payload, width, height)).toEqual([])
    for (const count of [NaN, Infinity, -1, 0, 1.5]) expect(mapArcs({ ...payload, edges: [{ ...payload.edges[0], count }] }, 390, 844)).toEqual([])
    expect(mapArcs({ ...payload, edges: [{ ...payload.edges[0], source: 'missing' }] }, 390, 844)).toEqual([])
    expect(mapArcs({ ...payload, nodes: [] }, 390, 844)).toEqual([])
  })

  it('hits the drawn quadratic curve, including self links, and rejects distant or invalid pointers', () => {
    const arcs = mapArcs(payload, 1280, 380)
    const arc = arcs[0]
    expect(hitMapArc(arcs, (arc.x1 + arc.x2) / 2, arc.y - arc.rise)).toBe(arc)
    for (const [x, y] of [[0, 0], [Infinity, 200], [NaN, 200], [arc.x2 + 1, arc.y]]) expect(hitMapArc(arcs, x, y)).toBeNull()
    const self = mapArcs({ ...payload, edges: [{ ...payload.edges[0], target: 'Gen' }] }, 390, 280)[0]
    expect(self.x2).toBeGreaterThan(self.x1)
    expect(hitMapArc([self], (self.x1 + self.x2) / 2, self.y - self.rise)).toBe(self)
    expect(mapArcColor(0, 0, NaN)).not.toContain('NaN')
    expect(mapArcColor(0, 1, 0)).not.toBe(mapArcColor(0, 1, 2))
  })

  it('combines reciprocal overview pairs without changing source data or losing their real sample', () => {
    const reverse = { ...payload.edges[0], source: 'Rev', target: 'Gen', count: 18, sample: { source: 'Rev.14.7', target: 'Gen.1.1' } }
    const graph = { ...payload, edges: [...payload.edges, reverse] }
    const [pair] = mapArcs(graph, 800, 300)
    expect(mapArcs(graph, 800, 300)).toHaveLength(1)
    expect(pair.edge.count).toBe(100)
    expect(pair.edge.sample).toEqual(payload.edges[0].sample)
    expect(payload.edges[0].count).toBe(82)
    const filtered = mapArcs(graph, 800, 300, { distances: [0.5, 1.5], maximum: 2 })
    expect(filtered[0].distance).toBeCloseTo(0.68)
    expect(mapArcs(graph, 800, 300, { distances: [0.5, 1.5], maximum: 1 })[0].edge.count).toBe(82)
    for (const distance of [null, NaN, Infinity, -1]) {
      expect(mapArcs(graph, 800, 300, { distances: [distance, 0.5], maximum: 1 })[0].edge.count).toBe(18)
    }
    expect(mapArcs(graph, 800, 300, { distances: [], maximum: 2 })).toEqual([])
    expect(mapArcs(graph, 800, 300, { distances: [0.5], maximum: NaN })).toEqual([])
    const overflow = { ...payload, edges: [{ ...payload.edges[0], count: Number.MAX_SAFE_INTEGER }, reverse] }
    expect(mapArcs(overflow, 800, 300)[0].edge.count).toBe(Number.MAX_SAFE_INTEGER)
    expect(mapArcWeight(1, 1000).opacity).toBeLessThan(mapArcWeight(1000, 1000).opacity / 10)
    expect(mapArcWeight(1, 1000).width).toBeLessThan(mapArcWeight(1000, 1000).width)
    // Chapter views preserve direction for incoming/outgoing connections.
    expect(mapArcs({ ...graph, nodes: [{ ...payload.nodes[0], chapter: 1 }, payload.nodes[1]] }, 800, 300)).toHaveLength(2)
  })

  it('lays out and hit-tests 20k directed arcs within the CI interaction budget', () => {
    // Adversarial maximum aggregate workload, not fabricated application content.
    const dense = { ...payload, nodes: [{ ...payload.nodes[0], chapter: 1 }, payload.nodes[1]], edges: Array.from({ length: 20_000 }, () => payload.edges[0]) }
    const start = performance.now()
    const arcs = mapArcs(dense, 1280, 380)
    expect(arcs).toHaveLength(20_000)
    for (let index = 0; index < 20; index++) hitMapArc(arcs, 100 + index * 40, 200)
    expect(performance.now() - start).toBeLessThan(500)
    expect(mapArcs({ ...dense, nodes: payload.nodes }, 1280, 380)).toHaveLength(1)
  })
})

describe('bounded map navigation', () => {
  it('anchors wheel zoom at the cursor and clamps extreme zoom/pan to the content', () => {
    const zoomed = zoomMap(initialMapViewport(), 2, 200, 100, 800, 300)
    expect((200 - zoomed.x) / zoomed.scale).toBe(200)
    expect((100 - zoomed.y) / zoomed.scale).toBe(100)
    expect(zoomMap(zoomed, 0.5, 200, 100, 800, 300)).toEqual(initialMapViewport())
    expect(zoomMap(zoomed, 1e10, 200, 100, 800, 300).scale).toBe(8)
    expect(panMap(zoomed, -1e10, 1e10, 800, 300)).toEqual({ scale: 2, x: -800, y: 0 })
    expect(panMap(zoomed, 1e10, -1e10, 800, 300)).toEqual({ scale: 2, x: 0, y: -300 })
    expect(zoomMap(zoomed, 1e-10, 200, 100, 800, 300)).toEqual(initialMapViewport())
  })

  it('ignores invalid wheel input, pointer coordinates and unavailable viewports', () => {
    const view = initialMapViewport()
    for (const factor of [0, -1, NaN, Infinity]) expect(zoomMap(view, factor, 200, 100, 800, 300)).toBe(view)
    expect(zoomMap(view, 2, NaN, 100, 800, 300)).toBe(view)
    for (const [x, y, width, height] of [[NaN, 0, 800, 300], [0, Infinity, 800, 300], [0, 0, 0, 300], [0, 0, 800, -1]]) {
      expect(panMap(view, x, y, width, height)).toBe(view)
    }
  })
})
