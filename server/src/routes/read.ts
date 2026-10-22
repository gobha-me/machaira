import type { FastifyInstance } from 'fastify'
import { getModuleBooks, readChapter } from '../sword.js'
import { CROSS_REFERENCE_ATTRIBUTION, type CrossReferenceService } from '../cross-references.js'
import { bookInfo } from '../books.js'

function positiveQueryInteger(value: unknown): number {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN
}

export async function registerRead(app: FastifyInstance, crossReferences: CrossReferenceService): Promise<void> {
  // Books present in an installed module (with display names + chapter counts).
  app.get<{ Params: { module: string } }>('/api/modules/:module/books', async (req, reply) => {
    const books = await getModuleBooks(req.params.module)
    if (books.length === 0) {
      reply.code(404)
      return { error: `module ${req.params.module} not installed or has no books` }
    }
    return { module: req.params.module, books }
  })

  // A verse or inclusive range in the reader's installed translation. Invalid or
  // unsupported references are an honest empty result, never normalized by SWORD.
  app.get<{ Params: { module: string; book: string; chapter: string }; Querystring: { verseStart?: string; verseEnd?: string; limit?: string } }>(
    '/api/cross-references/:module/:book/:chapter', async (req) => {
      const { module, book, chapter } = req.params
      const verseStart = positiveQueryInteger(req.query.verseStart)
      const references = await crossReferences.refs(module, {
        book, chapter: positiveQueryInteger(chapter), verseStart,
        verseEnd: req.query.verseEnd === undefined ? verseStart : positiveQueryInteger(req.query.verseEnd)
      }, req.query.limit === undefined ? 100 : positiveQueryInteger(req.query.limit))
      return { references, attribution: CROSS_REFERENCE_ATTRIBUTION }
    }
  )

  // A single chapter of an installed module.
  app.get<{ Params: { module: string; book: string; chapter: string } }>(
    '/api/read/:module/:book/:chapter',
    async (req, reply) => {
      const { module, book } = req.params
      const chapter = Number(req.params.chapter)
      const result = await readChapter(module, book, chapter)
      if (!result) {
        reply.code(404)
        return { error: `no text for ${module} ${book} ${chapter}` }
      }
      const references = await crossReferences.chapter(module, book, chapter, result.verses.map((verse) => verse.n))
      return {
        module,
        book,
        bookName: bookInfo(book).name,
        chapter,
        crossReferenceAttribution: CROSS_REFERENCE_ATTRIBUTION,
        verses: result.verses.map((verse) => ({
          ...verse,
          externalCrossReferences: references.filter((reference) => reference.sourceVerse === verse.n)
        }))
      }
    }
  )
}
