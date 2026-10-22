import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import { CrossReferenceService } from '../src/cross-references.js'
import { CrossReferenceMapService, MapInputError, canonicalReference, mapModule, mapScope } from '../src/cross-reference-map.js'
import { registerCrossReferenceMap } from '../src/routes/cross-reference-map.js'
import { mapVersificationReferences } from '../src/sword.js'
import { buildApp } from '../src/app.js'

const refs = new CrossReferenceService(':memory:')
const map = new CrossReferenceMapService(refs, (module, values, direction) =>
  mapVersificationReferences(values, direction === 'from-canonical' ? 'OpenBible' : module, direction === 'from-canonical' ? module : 'OpenBible'))
after(() => refs.db.close())

describe('cross-reference map over the entire real snapshot', () => {
  it('accounts for all 344,799 links, including loops and ranged targets, without expanding or truncating', () => {
    const graph = map.graph({})
    assert.equal(graph.totalLinks, 344799)
    assert.equal(graph.matchedLinks, 344799)
    assert.equal(graph.edges.reduce((sum, edge) => sum + edge.count, 0), 344799)
    assert.equal(graph.nodes.length, 66)
    assert.equal(graph.nodes[0].book, 'Gen')
    assert.equal(graph.nodes.at(-1)?.book, 'Rev')
    const ids = new Set(graph.nodes.map((node) => node.id))
    assert.ok(graph.edges.some((edge) => edge.source === edge.target))
    assert.ok(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)))
    for (const edge of graph.edges) {
      canonicalReference(edge.sample.source)
      canonicalReference(edge.sample.target)
      assert.ok(refs.db.prepare(`SELECT 1 FROM cross_references WHERE source = ? AND (target = ? OR target LIKE ?)`)
        .get(edge.sample.source, edge.sample.target, `${edge.sample.target}-%`))
    }
  })

  it('includes incoming and outgoing links and keeps every aggregate on the focused axis', () => {
    for (const scope of [{ book: 'Ps' }, { book: 'Ps', chapter: 119 }, { book: '3John', chapter: 1 }, { book: 'Rev', chapter: 22 }]) {
      const graph = map.graph(scope)
      const ids = new Set(graph.nodes.map((node) => node.id))
      assert.ok(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)))
      const prefix = `${scope.book}.${scope.chapter ? `${scope.chapter}.` : ''}`
      // Independent source-data oracle; target ranges count only their starting endpoint.
      const expected = refs.db.prepare('SELECT count(*) AS n FROM cross_references WHERE source LIKE ? OR target LIKE ?').get(`${prefix}%`, `${prefix}%`) as { n: number }
      assert.equal(graph.matchedLinks, expected.n)
      assert.ok(graph.edges.some((edge) => !edge.sample.source.startsWith(prefix) && edge.sample.target.startsWith(prefix)))
      assert.ok(graph.edges.some((edge) => edge.sample.source.startsWith(prefix) && !edge.sample.target.startsWith(prefix)))
    }
    const last = map.graph({ book: '3John', chapter: 1 })
    assert.ok(last.nodes.some((node) => node.id === '3John.1.15'))
    assert.ok(!last.nodes.some((node) => node.id === '3John.1.16'))
  })

  it('rejects hostile scopes and references before database or native work', async () => {
    for (const value of [null, [], '', { chapter: 1 }, { book: '' }, { book: '__proto__' }, { book: 'constructor' }, { book: 'Tob' },
      { book: 'Gen', chapter: '1' }, { book: 'Gen', chapter: 0 }, { book: 'Gen', chapter: 51 }, { book: 'Gen', chapter: 1.5 },
      { book: 'Gen', chapter: Infinity }, { book: 'Gen', chapter: NaN }, { book: 'Gen', unexpected: true }]) {
      assert.throws(() => mapScope(value), MapInputError)
      assert.throws(() => map.graph(value), MapInputError)
    }
    for (const value of ['Gen.1.0', 'Gen.1.32', 'Gen.51.1', '3John.1.16', 'Mal.4.7', 'Gen.1.1-Gen.1.2', 'Gen.1.1junk', 'Gen.01.1', 'Gen.1.1;DROP TABLE', '__proto__.1.1', {}, null]) {
      assert.throws(() => canonicalReference(value), MapInputError)
      await assert.rejects(map.resolve('KJV', value), MapInputError)
    }
    for (const value of ['', '../KJV', 'KJV/Gen', null, [], 'a'.repeat(129)]) assert.throws(() => mapModule(value), MapInputError)
    assert.equal(map.graph({}).totalLinks, 344799)
  })

  it('maps boundary verses into the reader translation, handles missing targets and propagates engine failures', async () => {
    assert.deepEqual(await map.resolve('KJV', '3John.1.15'), { book: '3John', chapter: 1, verseStart: 14, verseEnd: 14 })
    assert.equal(await map.resolve('German', 'Gen.1.1'), null)
    const broken = new CrossReferenceMapService(refs, async () => { throw new Error('engine failed') })
    await assert.rejects(broken.resolve('KJV', 'Gen.1.1'), /engine failed/)
    const split = new CrossReferenceMapService(refs, async () => [[
      { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 1 }, { book: 'Gen', chapter: 2, verseStart: 1, verseEnd: 1 }
    ]])
    assert.equal(await split.resolve('KJV', 'Gen.1.1'), null)
  })

  it('maps chapter similarity by individual verses across merged Psalms instead of borrowing the whole receiving chapter', async () => {
    const capture: Array<{ id: string; chapter: number | null; verse: number | null }> = []
    await map.similarities('user-1', 'Synodal', { book: 'Ps' }, { async mapDistances(userId, module, nodes, edges) {
      assert.equal(userId, 'user-1')
      assert.equal(module, 'Synodal')
      capture.push(...nodes)
      return { state: 'ready', distances: edges.map(() => null) }
    } })
    const ninth = capture.filter((node) => node.id === 'Ps.9')
    const tenth = capture.filter((node) => node.id === 'Ps.10')
    assert.ok(ninth.length > 0 && tenth.length > 0)
    assert.ok([...ninth, ...tenth].every((node) => node.chapter === 9 && node.verse !== null))
    assert.ok(Math.max(...ninth.map((node) => node.verse!)) < Math.min(...tenth.map((node) => node.verse!)),
      'two canonical Psalms must use disjoint portions of the merged translation chapter')
  })

  it('keeps cold/warm query and response budgets for the real dataset (runs in the CI server suite)', (t) => {
    const coldRefs = new CrossReferenceService(':memory:')
    t.after(() => coldRefs.db.close())
    const fresh = new CrossReferenceMapService(coldRefs)
    let start = performance.now()
    const overview = fresh.graph({})
    const cold = performance.now() - start
    assert.ok(cold < 4000, `cold aggregation ${cold.toFixed(0)}ms exceeds 4000ms`)
    assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 450_000, 'overview exceeds 450KB')
    start = performance.now()
    const worstBook = fresh.graph({ book: 'Ps' })
    const focused = performance.now() - start
    assert.ok(focused < 1500, `focused aggregation ${focused.toFixed(0)}ms exceeds 1500ms`)
    assert.ok(worstBook.edges.length < 20_000, 'Psalms exceeds the 20k aggregate arc budget')
    assert.ok(Buffer.byteLength(JSON.stringify(worstBook)) < 2_000_000, 'focused response exceeds 2MB')
    start = performance.now()
    assert.equal(fresh.graph({ book: 'Ps' }), worstBook)
    assert.ok(performance.now() - start < 50, 'cached aggregate lookup exceeds 50ms')
    t.diagnostic(`344,799 links: cold ${cold.toFixed(0)}ms, Psalms ${focused.toFixed(0)}ms / ${worstBook.edges.length} arcs`)
  })
})

it('protects map routes with the existing session boundary and degrades similarity failures without leaking details', async () => {
  const app = await buildApp({ databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false })
  await registerCrossReferenceMap(app, map, { async mapDistances() { throw new Error('private index details') } })
  try {
    for (const path of ['', '/resolve', '/similarity']) assert.equal((await app.inject({ method: 'POST', url: `/api/cross-reference-map${path}`, payload: {} })).statusCode, 401)
    const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { username: 'Owner', password: 'correct horse battery staple' } })
    const header = bootstrap.headers['set-cookie']
    const cookie = (Array.isArray(header) ? header[0] : header)!.split(';', 1)[0]
    const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/cross-reference-map${path}`, payload: JSON.stringify(payload), headers: { cookie, 'content-type': 'application/json' } })
    const graph = await post('', {})
    assert.equal(graph.statusCode, 200)
    assert.equal(graph.json().totalLinks, 344799)
    for (const input of [null, [], { book: 'Gen', chapter: '1' }]) assert.equal((await post('', input)).statusCode, 400)
    assert.equal((await post('/resolve', { module: '../KJV', reference: 'Gen.1.1' })).statusCode, 400)
    assert.equal((await post('/similarity', { module: 'KJV', scope: { chapter: 1 } })).statusCode, 400)
    assert.deepEqual((await post('/similarity', { module: 'KJV', scope: {} })).json(), { state: 'unavailable', distances: [] })
    assert.equal((await post('', { book: 'x'.repeat(2048) })).statusCode, 413)
    assert.equal((await post('', {})).json().totalLinks, 344799)
  } finally { await app.close() }
})

it('returns server failures rather than silently replacing the canonical map with an empty success', async () => {
  const dbRefs = new CrossReferenceService(':memory:')
  const app = Fastify()
  await registerCrossReferenceMap(app, new CrossReferenceMapService(dbRefs), { async mapDistances() { return { state: 'empty', distances: [] } } })
  dbRefs.db.close()
  try { assert.equal((await app.inject({ method: 'POST', url: '/api/cross-reference-map', payload: {} })).statusCode, 500) }
  finally { await app.close() }
})
