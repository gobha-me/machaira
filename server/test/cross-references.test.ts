import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { after, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { CrossReferenceService, CROSS_REFERENCE_ATTRIBUTION, type ReferenceMapper } from '../src/cross-references.js'
import { mapModuleReferences, mapVersificationReferences } from '../src/sword.js'
import { registerRead } from '../src/routes/read.js'
import type { ScriptureTarget } from '../src/scripture-reference.js'

// Real module versification declarations; tests use the real bundled dataset and
// native mapper offline, without downloading whole translations in CI.
const systems: Record<string, string> = { Geneva1599: 'NRSV', LSV: 'NRSV', KJV: 'KJV', RusSynodal: 'Synodal' }
const mapper: ReferenceMapper = async (module, references, direction) => {
  const system = systems[module]
  if (!system) return references.map(() => [])
  return mapVersificationReferences(references,
    direction === 'to-canonical' ? system : 'OpenBible',
    direction === 'to-canonical' ? 'OpenBible' : system)
}
const service = new CrossReferenceService(':memory:', mapper)
after(() => service.db.close())
const gen: ScriptureTarget = { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 1 }

function target(book: string, chapter: number, verseStart: number, verseEnd = verseStart): ScriptureTarget {
  return { book, chapter, verseStart, verseEnd }
}

describe('offline OpenBible SQLite resource', () => {
  it('imports all 344,799 real links, retaining signed votes and original attribution', () => {
    assert.deepEqual(service.db.prepare('SELECT COUNT(*) AS count FROM cross_references').get(), { count: 344799 })
    assert.ok(service.db.prepare('SELECT 1 FROM cross_references WHERE votes < 0').get())
    assert.deepEqual(service.db.prepare("SELECT votes FROM cross_references WHERE source = 'Gen.1.1' AND target = 'Rev.14.7'").get(), { votes: 82 })
    assert.equal(CROSS_REFERENCE_ATTRIBUTION.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/')
  })

  it('rejects corruption before mutation and rolls back an interrupted replacement', () => {
    assert.throws(() => service.importSnapshot(Buffer.from('corrupt')), /checksum mismatch/)
    service.db.exec("CREATE TEMP TRIGGER fail_import BEFORE INSERT ON cross_references BEGIN SELECT RAISE(ABORT, 'disk failure'); END;")
    try {
      assert.throws(() => service.importSnapshot(readFileSync(new URL('../resources/openbible-cross-references.tsv.gz', import.meta.url))), /disk failure/)
      assert.deepEqual(service.db.prepare('SELECT COUNT(*) AS count FROM cross_references').get(), { count: 344799 })
      assert.ok(service.db.prepare('SELECT sha256 FROM dataset').get())
    } finally { service.db.exec('DROP TRIGGER fail_import') }
  })

  it('reuses the verified persistent snapshot without importing on each startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'machaira-xrefs-'))
    const path = join(dir, 'refs.sqlite')
    try {
      const first = new CrossReferenceService(path, mapper)
      first.db.exec("CREATE TRIGGER prevent_reimport BEFORE DELETE ON cross_references BEGIN SELECT RAISE(ABORT, 'unexpected import'); END;")
      first.db.close()
      const reopened = new CrossReferenceService(path, mapper)
      try {
        assert.deepEqual(reopened.db.prepare('SELECT COUNT(*) AS count FROM cross_references').get(), { count: 344799 })
        assert.equal(statSync(path).mode & 0o777, 0o600)
      } finally { reopened.db.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('translation-resolved verse and range lookup', () => {
  for (const module of ['Geneva1599', 'LSV']) {
    it(`provides Genesis 1:1 refs in ${module}, ordered by votes`, async () => {
      const refs = await service.refs(module, gen)
      assert.ok(refs.length > 10)
      assert.ok(refs.every((ref) => ref.module === module))
      assert.ok(refs.every((ref, i) => i === 0 || refs[i - 1].votes >= ref.votes))
      assert.ok(refs.some((ref) => ref.target.book === 'John' && ref.target.chapter === 1))
      assert.ok(refs.some((ref) => ref.target.verseEnd! > ref.target.verseStart!))
      assert.equal(new Set(refs.map((ref) => JSON.stringify(ref.target))).size, refs.length)
    })
  }

  it('unions inclusive source ranges, keeps the highest vote, and deduplicates resolved targets', async () => {
    const single = await service.refs('KJV', gen, 200)
    const second = await service.refs('KJV', { ...gen, verseStart: 2, verseEnd: 2 }, 200)
    const range = await service.refs('KJV', { ...gen, verseEnd: 2 }, 200)
    const union = new Map<string, number>()
    for (const ref of [...single, ...second]) {
      const key = JSON.stringify(ref.target)
      union.set(key, Math.max(union.get(key) ?? -Infinity, ref.votes))
    }
    assert.equal(range.length, union.size)
    for (const ref of range) assert.equal(ref.votes, union.get(JSON.stringify(ref.target)))
    assert.ok(range.some((ref) => ref.sourceVerse === 2))
    assert.equal((await service.refs('KJV', gen, 1)).length, 1)
  })

  it('preserves cross-chapter and cross-book targets as navigable chapter ranges', async () => {
    const chapters = await service.refs('KJV', target('Gen', 11, 31), 200)
    assert.ok(chapters.some((ref) => JSON.stringify(ref.target) === JSON.stringify(target('Gen', 11, 32))))
    assert.ok(chapters.some((ref) => JSON.stringify(ref.target) === JSON.stringify(target('Gen', 12, 1))))
    const books = await service.refs('KJV', target('Num', 3, 1), 200)
    assert.ok(books.some((ref) => ref.target.book === 'Lev' && ref.target.chapter === 27 && ref.target.verseStart === 34))
    assert.ok(books.some((ref) => ref.target.book === 'Num' && ref.target.chapter === 1 && ref.target.verseStart === 1))
  })

  it('returns empty for unknown, partly invalid, reversed, oversized, non-integer, and unsupported input', async () => {
    for (const input of [
      { ...gen, book: 'NotABook' }, { ...gen, book: 'Tob' }, { ...gen, chapter: 51 },
      { ...gen, chapter: NaN }, { ...gen, chapter: Infinity }, { ...gen, chapter: 1.5 },
      { ...gen, verseStart: 0 }, { ...gen, verseStart: null }, { ...gen, verseEnd: NaN },
      { ...gen, verseStart: 2, verseEnd: 1 }, { ...gen, verseEnd: 32 },
      { ...gen, verseEnd: 201 }, { ...gen, verseStart: 1.5 },
      target('3John', 2, 1), target('3John', 1, 16), target('Mal', 4, 7)
    ]) assert.deepEqual(await service.refs('KJV', input), [], JSON.stringify(input))
    for (const limit of [0, -1, 201, 1.5, NaN, Infinity]) assert.deepEqual(await service.refs('KJV', gen, limit), [])
    for (const module of ['', 'unknown', 'x'.repeat(201)]) assert.deepEqual(await service.refs(module, gen), [])
    assert.deepEqual(await mapModuleReferences('not-installed', ['Gen.1.1'], 'to-canonical'), [[]])
  })

  it('filters missing target books before applying the result limit', async () => {
    const partial = new CrossReferenceService(':memory:', async (module, refs, direction) => {
      const mapped = await mapper(module, refs, direction)
      return direction === 'from-canonical'
        ? mapped.map((targets) => targets.some((item) => item.book === 'John') ? [] : targets)
        : mapped
    })
    try {
      const refs = await partial.refs('LSV', gen, 1)
      assert.equal(refs.length, 1)
      assert.equal(refs[0].target.book, 'Heb')
      assert.equal(refs[0].votes, 277)
    } finally { partial.db.close() }
  })

  it('propagates resolver failures instead of caching a false empty success', async () => {
    const original = new Error('native engine failed')
    const failing = new CrossReferenceService(':memory:', async () => { throw original })
    try { await assert.rejects(failing.refs('KJV', gen), (error) => error === original) }
    finally { failing.db.close() }
  })
})

describe('adversarial native versification mapping', () => {
  it('rejects headings, normalized overflow, partial parses, and unsupported systems', async () => {
    const invalid = ['Ps.3.0', 'Ps.0.1', 'Ps.151.1', 'Mal.4.7', 'Mal.5.1', '3John.2.1', '3John.1.16', 'Gen.1.1junk', 'Gen.1.1-Gen.1.2', 'Gen.1.-1', 'Fake.1.1', 'Gen.1.1;John.1.1']
    assert.deepEqual(await mapVersificationReferences(invalid, 'OpenBible', 'KJV'), invalid.map(() => []))
    assert.deepEqual(await mapVersificationReferences(['Gen.1.1', 'Mal.4.1'], 'OpenBible', 'German'), [[], []])
    assert.deepEqual(await mapVersificationReferences(['Gen.1.1'], 'FutureSystem', 'OpenBible'), [[]])
  })

  it('maps numbered Psalms headings without confusing the heading with canonical verse one', async () => {
    assert.deepEqual(await mapVersificationReferences(['Ps.3.1', 'Ps.51.1'], 'OpenBible', 'Synodal'), [[target('Ps', 3, 2)], [target('Ps', 50, 3)]])
    assert.deepEqual(await mapVersificationReferences(['Ps.3.1', 'Ps.3.2', 'Ps.50.3'], 'Synodal', 'OpenBible'), [[], [target('Ps', 3, 1)], [target('Ps', 51, 1)]])
    const refs = await service.refs('RusSynodal', target('Ps', 50, 3))
    assert.ok(refs.length > 0)
    assert.deepEqual(await service.refs('RusSynodal', target('Ps', 3, 1)), [])
  })

  it('keeps the last Malachi verse inside its book and never spills into Matthew', async () => {
    assert.deepEqual(await mapVersificationReferences(['Mal.4.1', 'Mal.4.6', 'Mal.4.7'], 'OpenBible', 'NRSV'), [[target('Mal', 4, 1)], [target('Mal', 4, 6)], []])
    assert.ok((await service.refs('Geneva1599', target('Mal', 4, 6))).length > 0)
    assert.deepEqual(await service.refs('Geneva1599', target('Mal', 4, 6, 7)), [])
  })

  it('maps split and merged 3 John endings in both directions without crossing into Jude', async () => {
    assert.deepEqual(await mapVersificationReferences(['3John.1.14', '3John.1.15', '3John.1.16'], 'OpenBible', 'KJV'), [[target('3John', 1, 14)], [target('3John', 1, 14)], []])
    assert.deepEqual(await mapVersificationReferences(['3John.1.14', '3John.1.15'], 'KJV', 'OpenBible'), [[target('3John', 1, 14, 15)], []])
    assert.deepEqual(await mapVersificationReferences(['3John.1.15'], 'OpenBible', 'NRSV'), [[target('3John', 1, 15)]])
    assert.ok((await service.refs('KJV', target('3John', 1, 14))).length > 0)
    assert.deepEqual(await service.refs('KJV', target('3John', 1, 15)), [])
    assert.ok((await service.refs('Geneva1599', target('3John', 1, 15))).length > 0)
  })
})

it('exposes a range API with attribution and honest empty responses for hostile query parameters', async () => {
  const app = Fastify()
  await registerRead(app, service)
  try {
    const response = await app.inject('/api/cross-references/Geneva1599/Gen/1?verseStart=1&verseEnd=2')
    assert.equal(response.statusCode, 200)
    assert.ok(response.json().references.length > 0)
    assert.equal(response.json().attribution.license, 'CC BY 4.0')
    for (const path of [
      '/unknown/Gen/1?verseStart=1', '/KJV/Gen/1?verseStart=31&verseEnd=32',
      '/KJV/Gen/1?verseStart=1&verseEnd=0', '/KJV/Gen/1?verseStart=1&limit=Infinity',
      '/KJV/Gen/1?verseStart=1%20OR%201=1', '/KJV/Gen/1?verseStart=1e0',
      '/KJV/Gen/1?verseStart=0x1', '/KJV/Gen/1?verseStart=1&verseStart=2', '/KJV/Gen/1', '/KJV/Gen/nope?verseStart=1'
    ]) {
      const empty = await app.inject(`/api/cross-references${path}`)
      assert.equal(empty.statusCode, 200)
      assert.deepEqual(empty.json().references, [])
    }
  } finally { await app.close() }
})

it('requires a session for the new reference API and serves attribution after login', async () => {
  const app = await buildApp({
    databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
  })
  await registerRead(app, service)
  const url = '/api/cross-references/LSV/Gen/1?verseStart=1'
  try {
    assert.equal((await app.inject(url)).statusCode, 401)
    const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/bootstrap',
      payload: { username: 'Owner', password: 'correct horse battery staple' } })
    assert.equal(bootstrap.statusCode, 201)
    const header = bootstrap.headers['set-cookie']
    const cookie = (Array.isArray(header) ? header[0] : header)!.split(';', 1)[0]
    const response = await app.inject({ url, headers: { cookie } })
    assert.equal(response.statusCode, 200)
    assert.ok(response.json().references.length > 0)
    assert.equal(response.json().attribution.name, CROSS_REFERENCE_ATTRIBUTION.name)
  } finally { await app.close() }
})
