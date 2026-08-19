import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ConnectionInputError,
  ConnectionsService,
  type ConnectionSemanticSource,
  type ConnectionSources
} from '../src/connections.ts'
import type { ReadChapterResult, RepoModuleInfo } from '../src/sword.ts'

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
