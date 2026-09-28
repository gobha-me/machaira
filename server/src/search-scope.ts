import { isDeuterocanonicalBook } from '@machaira/scripture'

export type SearchScope = 'all' | 'scripture' | 'apocrypha' | 'ancient-writings'

export function parseSearchScope(value: unknown): SearchScope {
  if (value === undefined) return 'all'
  if (value === 'all' || value === 'scripture' || value === 'apocrypha' || value === 'ancient-writings') return value
  throw new Error('Invalid search scope')
}

export function scopeIncludesKind(scope: SearchScope, kind: string): boolean {
  return scope === 'all' ? kind === 'scripture' || kind === 'general-book'
    : scope === 'ancient-writings' ? kind === 'general-book' : kind === 'scripture'
}

export function scopedScriptureHits<T extends { bibleBookShortTitle: string }>(
  hits: T[], scope: SearchScope, limit = 50
): T[] {
  return hits.filter((hit) => scope !== 'apocrypha' || isDeuterocanonicalBook(hit.bibleBookShortTitle)).slice(0, limit)
}
