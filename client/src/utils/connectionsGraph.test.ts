import { describe, expect, it, vi } from 'vitest'
import type { ConnectionNode, ConnectionsPayload } from '../services/api'
import { layoutConnections, resolveConnectionSeeds, visibleConnections } from './connectionsGraph'

const nodes: ConnectionNode[] = [
  {
    id: 'seed', module: 'WEB', book: 'John', bookName: 'John', chapter: 1,
    verseStart: 1, verseEnd: 2, label: 'John 1:1–2', content: 'The Word', seed: true
  },
  {
    id: 'xref', module: 'WEB', book: 'Gen', bookName: 'Genesis', chapter: 1,
    verseStart: 1, verseEnd: 1, label: 'Genesis 1:1', content: 'Created', seed: false
  },
  {
    id: 'theme', module: 'WEB', book: 'Ps', bookName: 'Psalms', chapter: 119,
    verseStart: 105, verseEnd: 105, label: 'Psalms 119:105', content: 'A lamp', seed: false
  }
]

const payload: ConnectionsPayload = {
  nodes,
  edges: [
    { source: 'seed', target: 'xref', kind: 'cross-reference' },
    { source: 'seed', target: 'theme', kind: 'thematic', distance: 0.1 }
  ],
  semanticState: 'ready',
  warnings: []
}

describe('connection seed resolution', () => {
  it('resolves display books, modules, ranges, and duplicates', async () => {
    const loadBooks = vi.fn(async () => [
      { code: 'John', name: 'John', section: 'nt' as const, chapters: 21 },
      { code: 'Ps', name: 'Psalms', section: 'ot' as const, chapters: 150 }
    ])
    const result = await resolveConnectionSeeds([
      'John 1:1–2 · WEB', 'John 1:1-2 · WEB', 'Psalms 119:105'
    ], 'WEB', loadBooks)
    expect(result.seeds).toEqual([
      { module: 'WEB', book: 'John', chapter: 1, verseStart: 1, verseEnd: 2 },
      { module: 'WEB', book: 'Ps', chapter: 119, verseStart: 105, verseEnd: 105 }
    ])
    expect(loadBooks).toHaveBeenCalledTimes(1)
    expect(result.warnings).toEqual([])
  })

  it('keeps the first five unique linked passages and reports truncation', async () => {
    const result = await resolveConnectionSeeds(
      Array.from({ length: 6 }, (_value, index) => `John ${index + 1} · WEB`),
      'WEB',
      async () => [{ code: 'John', name: 'John', section: 'nt', chapters: 21 }]
    )
    expect(result.seeds).toHaveLength(5)
    expect(result.warnings).toEqual(['Connections use the first 5 linked passages'])
  })

  it('reports malformed and unavailable references without inventing seeds', async () => {
    const result = await resolveConnectionSeeds(
      ['not a reference', 'John 99 · Missing'],
      null,
      async () => { throw new Error('missing') }
    )
    expect(result.seeds).toEqual([])
    expect(result.warnings).toHaveLength(2)
  })
})

describe('connections graph layout', () => {
  it('is deterministic, bounded, and keeps the single seed centered', () => {
    const first = layoutConnections(nodes, payload.edges)
    expect(layoutConnections(nodes, payload.edges)).toEqual(first)
    expect(first.find((node) => node.id === 'seed')).toMatchObject({ x: 180, y: 140 })
    expect(first.every((node) => node.x >= 24 && node.x <= 336 && node.y >= 24 && node.y <= 256)).toBe(true)
    expect(new Set(first.map((node) => `${node.x}/${node.y}`)).size).toBe(nodes.length)
  })

  it('filters edge types while retaining seed nodes', () => {
    expect(visibleConnections(payload, true, false)).toEqual({
      nodes: [nodes[0], nodes[1]],
      edges: [payload.edges[0]]
    })
    expect(visibleConnections(payload, false, false)).toEqual({ nodes: [nodes[0]], edges: [] })
  })
})
