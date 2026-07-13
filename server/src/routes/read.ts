import type { FastifyInstance } from 'fastify'
import { getModuleBooks, readChapter } from '../sword.js'
import { bookInfo } from '../books.js'

export async function registerRead(app: FastifyInstance): Promise<void> {
  // Books present in an installed module (with display names + chapter counts).
  app.get<{ Params: { module: string } }>('/api/modules/:module/books', async (req, reply) => {
    const books = await getModuleBooks(req.params.module)
    if (books.length === 0) {
      reply.code(404)
      return { error: `module ${req.params.module} not installed or has no books` }
    }
    return { module: req.params.module, books }
  })

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
      return {
        module,
        book,
        bookName: bookInfo(book).name,
        chapter,
        verses: result.verses
      }
    }
  )
}
