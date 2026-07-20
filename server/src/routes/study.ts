import type { FastifyInstance } from 'fastify'
import { compareRange, lookupStrongs, searchModules } from '../sword.js'
import { bookInfo } from '../books.js'

export async function registerStudy(app: FastifyInstance): Promise<void> {
  // Compare a verse (or verse range "lo-hi") across several installed translations.
  app.get<{
    Params: { book: string; chapter: string; verse: string }
    Querystring: { modules?: string }
  }>('/api/compare/:book/:chapter/:verse', async (req) => {
    const { book } = req.params
    const chapter = Number(req.params.chapter)
    // :verse is either "N" (single verse) or "lo-hi" (a range).
    const [a, b] = req.params.verse.split('-').map(Number)
    const lo = Math.min(a, b || a)
    const hi = Math.max(a, b || a)
    const requested = (req.query.modules ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const translations = await compareRange(book, chapter, lo, hi, requested)
    return { book, bookName: bookInfo(book).name, chapter, verseStart: lo, verseEnd: hi, translations }
  })

  // Strong's lexicon entry (e.g. G2638). Requires the StrongsGreek/StrongsHebrew module.
  app.get<{ Params: { key: string } }>('/api/strongs/:key', async (req, reply) => {
    const result = await lookupStrongs(req.params.key)
    if (result.status === 'missing-module') {
      reply.code(409)
      return {
        error: 'strongs-module-missing',
        message: `Install ${
          result.language === 'greek' ? "Strong's Greek" : "Strong's Hebrew"
        } in the Library to enable word study.`
      }
    }
    if (result.status === 'not-found') {
      reply.code(404)
      return { error: 'not-found', message: result.message }
    }
    return result.entry
  })

  // Real full-text search across one or more installed modules.
  app.get<{ Querystring: { modules?: string; q?: string; type?: string } }>(
    '/api/search',
    async (req) => {
      const q = (req.query.q ?? '').trim()
      if (!q) return { query: q, results: [] }
      const modules = (req.query.modules ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const searchType = req.query.type === 'word' ? 'multiWord' : 'phrase'
      const results = await searchModules(modules, q, searchType)
      return { query: q, count: results.length, results }
    }
  )
}
