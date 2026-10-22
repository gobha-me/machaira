import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ConnectionInputError,
  ConnectionsService,
  type ConnectionSemanticSource,
  type ConnectionSources
} from '../src/connections.ts'
import { mapVersificationReferences, type ReadChapterResult, type RepoModuleInfo } from '../src/sword.ts'
import { CrossReferenceService } from '../src/cross-references.js'

const web: RepoModuleInfo = {
  name: 'WEB', type: 'BIBLE', description: 'World English Bible', language: 'en',
  hasStrongs: false, hasGreekStrongsKeys: false, hasHebrewStrongsKeys: false,
  hasFootnotes: false, hasHeadings: false, hasRedLetterWords: false,
  hasCrossReferences: true, locked: false, installed: true
}

function chapter(verses: Array<{
  n: number
  text: string
  refs?: Array<{ book: string; chapter: number; verseStart: number; verseEnd: number }>
}>): ReadChapterResult {
  return {
    verses: verses.map((verse) => ({
      n: verse.n,
      text: verse.text,
      notes: [],
      segments: [{ kind: 'text' as const, text: verse.text }],
      crossReferences: verse.refs?.map((ref) => `${ref.book} ${ref.chapter}:${ref.verseStart}`) ?? [],
      crossReferenceTargets: verse.refs ?? []
    }))
  }
}

const data = new Map<string, ReadChapterResult>([
  ['WEB/John/1', chapter([
    { n: 1, text: 'In the beginning was the Word.', refs: [
      { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 1 },
      { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 1 }
    ] },
    { n: 2, text: 'He was in the beginning with God.' }
  ])],
  ['WEB/Gen/1', chapter([{ n: 1, text: 'In the beginning God created.' }])],
  ['WEB/Ps/119', chapter([{ n: 105, text: 'Your word is a lamp to my feet.' }])]
])

const sources: ConnectionSources = {
  async installed() { return [web] },
  async books() {
    return [
      { code: 'John', name: 'John', section: 'nt', chapters: 21 },
      { code: 'Gen', name: 'Genesis', section: 'ot', chapters: 50 },
      { code: 'Ps', name: 'Psalms', section: 'ot', chapters: 150 }
    ]
  },
  async chapter(module, book, chapterNumber) {
    return data.get(`${module}/${book}/${chapterNumber}`) ?? null
  }
}

describe('connections graph', () => {
  it('combines real cross-reference and stored-vector neighbors with deduplication', async () => {
    const semantic: ConnectionSemanticSource = {
      async neighbors() {
        return {
          state: 'ready',
          results: [{
            module: 'WEB', book: 'Ps', bookName: 'Psalms', chapter: 119, verse: 105,
            content: 'Your word is a lamp to my feet.', distance: 0.12
          }]
        }
      }
    }
    const result = await new ConnectionsService(semantic, sources).graph('user-1', {
      seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1, verseEnd: 2 }]
    })
    assert.equal(result.semanticState, 'ready')
    assert.deepEqual(result.nodes.map((node) => node.label), [
      'John 1:1–2', 'Genesis 1:1', 'Psalms 119:105'
    ])
    assert.deepEqual(result.edges.map((edge) => edge.kind), ['cross-reference', 'thematic'])
    assert.equal(result.nodes[0].seed, true)
    assert.match(result.nodes[0].content, /beginning was the Word.*beginning with God/)
  })

  it('keeps cross-references available when semantic search is not configured', async () => {
    const semantic: ConnectionSemanticSource = {
      async neighbors() { return { state: 'unconfigured', results: [] } }
    }
    const result = await new ConnectionsService(semantic, sources).graph('user-1', {
      seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1 }]
    })
    assert.equal(result.semanticState, 'unconfigured')
    assert.deepEqual(result.edges.map((edge) => edge.kind), ['cross-reference'])
    assert.ok(result.warnings.some((warning) => /ready semantic index/.test(warning)))
  })

  it('preserves curated references when the meaning index throws instead of reporting empty results', async () => {
    const result = await new ConnectionsService({
      async neighbors() { throw new Error('index storage failed') }
    }, sources).graph('user-1', {
      seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1 }]
    })
    assert.equal(result.semanticState, 'unavailable')
    assert.deepEqual(result.edges.map((edge) => edge.kind), ['cross-reference'])
    assert.ok(result.warnings.some((warning) => /could not be loaded/.test(warning)))
    assert.ok(!JSON.stringify(result).includes('index storage failed'))
  })

  it('preserves curated previews when reading a meaning preview fails', async () => {
    const result = await new ConnectionsService({
      async neighbors() {
        return { state: 'ready', results: [{
          kind: 'scripture', module: 'WEB', book: 'Ps', bookName: 'Psalms', chapter: 119, verse: 105,
          content: 'An indexed preview must not be used as a fallback.', distance: 0.1
        }] }
      }
    }, {
      ...sources,
      async chapter(module, book, number) {
        if (book === 'Ps') throw new Error('native read failed with private details')
        return sources.chapter(module, book, number)
      }
    }).graph('user-1', { seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1 }] })
    assert.equal(result.semanticState, 'unavailable')
    assert.deepEqual(result.edges.map((edge) => edge.kind), ['cross-reference'])
    assert.equal(result.nodes.find((node) => node.book === 'Gen')?.content, 'In the beginning God created.')
    assert.ok(!JSON.stringify(result).includes('private details'))
    assert.ok(!JSON.stringify(result).includes('fallback'))
  })

  it('does not let a later successful seed hide an earlier meaning lookup error', async () => {
    const result = await new ConnectionsService({
      async neighbors(_userId, seed) {
        if (seed.verseStart === 1) throw new Error('index failure')
        return { state: 'ready', results: [] }
      }
    }, sources).graph('user-1', { seeds: [
      { module: 'WEB', book: 'John', chapter: 1, verseStart: 1 },
      { module: 'WEB', book: 'John', chapter: 1, verseStart: 2 }
    ] })
    assert.equal(result.semanticState, 'unavailable')
    assert.deepEqual(result.edges.map((edge) => edge.kind), ['cross-reference'])
  })

  it('does not offer a reference range whose interior verses are missing in this translation', async () => {
    const result = await new ConnectionsService({
      async neighbors() { return { state: 'ready', results: [] } }
    }, {
      ...sources,
      async chapter(_module, book) {
        return book === 'John'
          ? chapter([{ n: 1, text: 'In the beginning was the Word.', refs: [
              { book: 'Gen', chapter: 1, verseStart: 1, verseEnd: 3 }
            ] }])
          : chapter([{ n: 1, text: 'In the beginning God created.' }, { n: 3, text: 'God said, Let there be light.' }])
      }
    }).graph('user-1', { seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1 }] })
    assert.deepEqual(result.edges, [])
    assert.ok(result.warnings.some((warning) => /outside the installed module/.test(warning)))
  })

  it('renders meaning previews from the current translation and excludes unavailable indexed verses', async () => {
    const result = await new ConnectionsService({
      async neighbors() {
        return {
          state: 'ready', results: [
            { module: 'WEB', book: 'Ps', bookName: 'Psalms', chapter: 119, verse: 105,
              content: 'Outdated indexed text', distance: 0.1 },
            { module: 'KJV', book: 'John', bookName: 'John', chapter: 1, verse: 2,
              content: 'Another translation must not be mapped without versification conversion', distance: 0.15 },
            { module: 'WEB', book: 'Ps', bookName: 'Psalms', chapter: 119, verse: 999,
              content: 'Unavailable indexed verse', distance: 0.2 },
            { module: 'WEB', book: 'Ps', bookName: 'Psalms', chapter: 999, verse: 1,
              content: 'Unavailable indexed chapter', distance: 0.3 }
          ]
        }
      }
    }, sources).graph('user-1', {
      seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1 }]
    })
    const thematic = result.edges.filter((edge) => edge.kind === 'thematic')
    assert.equal(thematic.length, 1)
    const preview = result.nodes.find((node) => node.id === thematic[0].target)!
    assert.equal(preview.module, 'WEB')
    assert.equal(preview.content, 'Your word is a lamp to my feet.')
    assert.ok(result.warnings.some((warning) => /not available in the current translation/.test(warning)))
  })

  it('distinguishes a stale index from a ready index without neighbors', async () => {
    for (const state of ['stale', 'ready'] as const) {
      const result = await new ConnectionsService({
        async neighbors() { return { state, results: [] } }
      }, sources).graph('user-1', {
        seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1 }]
      })
      assert.equal(result.semanticState, state)
      assert.deepEqual(result.edges.map((edge) => edge.kind), ['cross-reference'])
      assert.equal(result.warnings.some((warning) => /ready semantic index/.test(warning)), state === 'stale')
    }
  })

  it('rejects malformed, reversed, unsafe and oversized seed requests before loading sources', async () => {
    let calls = 0
    const service = new ConnectionsService({
      async neighbors() { throw new Error('Must not query invalid seeds') }
    }, { ...sources, async installed() { calls += 1; return [web] } })
    const seed = { module: 'WEB', book: 'John', chapter: 1 }
    for (const input of [
      null, [], { seeds: [null] }, { seeds: Array.from({ length: 6 }, () => seed) },
      { seeds: [{ ...seed, module: ' ' }] }, { seeds: [{ ...seed, book: 'x'.repeat(201) }] },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((chapter) => ({ seeds: [{ ...seed, chapter }] })),
      { seeds: [{ ...seed, verseEnd: 2 }] },
      { seeds: [{ ...seed, verseStart: 2, verseEnd: 1 }] },
      { seeds: [{ ...seed, verseStart: 0 }] }
    ]) {
      await assert.rejects(service.graph('user-1', input), ConnectionInputError)
    }
    assert.equal(calls, 0)
  })

  it('validates the public request and reports unavailable linked passages honestly', async () => {
    const semantic: ConnectionSemanticSource = {
      async neighbors() { return { state: 'ready', results: [] } }
    }
    const service = new ConnectionsService(semantic, sources)
    await assert.rejects(
      service.graph('user-1', { seeds: [] }),
      (error: unknown) => error instanceof ConnectionInputError && /between 1 and 5/.test(error.message)
    )
    const result = await service.graph('user-1', {
      seeds: [{ module: 'WEB', book: 'John', chapter: 99 }]
    })
    assert.deepEqual(result.nodes, [])
    assert.ok(result.warnings.some((warning) => /not available/.test(warning)))
  })

  it('applies per-seed neighbor limits and the global graph cap', async () => {
    const cappedSources: ConnectionSources = {
      async installed() { return [web] },
      async books() {
        return [
          { code: 'John', name: 'John', section: 'nt', chapters: 200 },
          { code: 'Gen', name: 'Genesis', section: 'ot', chapters: 200 },
          { code: 'Ps', name: 'Psalms', section: 'ot', chapters: 200 }
        ]
      },
      async chapter(_module, book, chapterNumber) {
        const refs = book === 'John'
          ? Array.from({ length: 8 }, (_value, index) => ({
              book: 'Gen', chapter: chapterNumber * 10 + index, verseStart: 1, verseEnd: 1
            }))
          : []
        return chapter([{ n: 1, text: `${book} ${chapterNumber}:1`, refs }])
      }
    }
    const semantic: ConnectionSemanticSource = {
      async neighbors(_userId, seed) {
        return {
          state: 'ready',
          results: Array.from({ length: 8 }, (_value, index) => ({
            module: 'WEB', book: 'Ps', bookName: 'Psalms',
            chapter: seed.chapter * 10 + index, verse: 1,
            content: `Psalms ${seed.chapter * 10 + index}:1`, distance: 0.1 + index / 100
          }))
        }
      }
    }
    const result = await new ConnectionsService(semantic, cappedSources).graph('user-1', {
      seeds: Array.from({ length: 5 }, (_value, index) => ({
        module: 'WEB', book: 'John', chapter: index + 1, verseStart: 1
      }))
    })
    assert.equal(result.nodes.length, 40)
    assert.ok(result.warnings.some((warning) => /Cross-references limited to 6/.test(warning)))
    assert.ok(result.warnings.some((warning) => /Graph limited to 40/.test(warning)))
    assert.equal(result.edges.filter((edge) => edge.kind === 'thematic').length <= 20, true)
  })
})

it('builds attributed Journal edges from the offline dataset when embedded cross-references are absent', async () => {
  const external = new CrossReferenceService(':memory:', (_module, refs, direction) =>
    mapVersificationReferences(refs, direction === 'to-canonical' ? 'KJV' : 'OpenBible',
      direction === 'to-canonical' ? 'OpenBible' : 'KJV'))
  const withoutEmbedded: ConnectionSources = {
    ...sources,
    async chapter(module, book, number) {
      const result = await sources.chapter(module, book, number)
      return result ? { verses: result.verses.map((verse) => ({
        ...verse, crossReferences: [], crossReferenceTargets: []
      })) } : null
    }
  }
  try {
    const graph = await new ConnectionsService({
      async neighbors() { return { state: 'unconfigured', results: [] } }
    }, withoutEmbedded, external).graph('user-1', {
      seeds: [{ module: 'WEB', book: 'John', chapter: 1, verseStart: 1 }]
    })
    assert.ok(graph.edges.some((edge) => edge.kind === 'cross-reference'))
    assert.ok(graph.nodes.some((node) => node.book === 'Gen' && node.chapter === 1))
    assert.ok(graph.nodes.every((node) => node.module === 'WEB'))
    assert.equal(graph.crossReferenceAttribution?.license, 'CC BY 4.0')
    assert.ok(graph.warnings.some((warning) => /outside the installed module/.test(warning)))
  } finally { external.db.close() }
})
