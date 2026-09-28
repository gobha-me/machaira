import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseSearchScope, scopedScriptureHits, scopeIncludesKind } from '../src/search-scope.ts'

it('applies book scope before the exact-search result cap', () => {
  const hits = [
    ...Array.from({ length: 80 }, () => ({ bibleBookShortTitle: 'John' })),
    { bibleBookShortTitle: 'Tob' }, { bibleBookShortTitle: 'Wis' }
  ]
  assert.equal(scopedScriptureHits(hits, 'all').length, 50)
  assert.deepEqual(scopedScriptureHits(hits, 'apocrypha').map((hit) => hit.bibleBookShortTitle), ['Tob', 'Wis'])
})

it('validates scopes and excludes unrelated module kinds', () => {
  assert.equal(parseSearchScope(undefined), 'all')
  assert.throws(() => parseSearchScope('invalid'), /Invalid search scope/)
  assert.equal(scopeIncludesKind('scripture', 'general-book'), false)
  assert.equal(scopeIncludesKind('ancient-writings', 'scripture'), false)
  assert.equal(scopeIncludesKind('ancient-writings', 'general-book'), true)
  assert.equal(scopeIncludesKind('apocrypha', 'scripture'), true)
  assert.equal(scopeIncludesKind('all', 'lexicon'), false)
})
