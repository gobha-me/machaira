import { describe, expect, it } from 'vitest'
import type { CrossReferenceMapPayload } from '@machaira/scripture'
import { mapArcs, hitMapArc, mapArcColor } from './crossReferenceMap'

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

  it('lays out and hit-tests 20k aggregate arcs within the CI interaction budget', () => {
    // Adversarial maximum aggregate workload, not fabricated application content.
    const dense = { ...payload, edges: Array.from({ length: 20_000 }, () => payload.edges[0]) }
    const start = performance.now()
    const arcs = mapArcs(dense, 1280, 380)
    expect(arcs).toHaveLength(20_000)
    for (let index = 0; index < 20; index++) hitMapArc(arcs, 100 + index * 40, 200)
    expect(performance.now() - start).toBeLessThan(500)
  })
})
