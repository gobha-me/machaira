import type { FastifyInstance } from 'fastify'
import { readCommentaryChapter } from '../sword.js'
import { bookInfo } from '../books.js'

export async function registerCommentary(app: FastifyInstance): Promise<void> {
  // Per-verse notes for a chapter from an installed commentary module (e.g. Geneva).
  app.get<{ Params: { module: string; book: string; chapter: string } }>(
    '/api/commentary/:module/:book/:chapter',
    async (req, reply) => {
      const { module, book } = req.params
      const chapter = Number(req.params.chapter)
      const result = await readCommentaryChapter(module, book, chapter)
      if (!result) {
        reply.code(404)
        return { error: `commentary ${module} not installed` }
      }
      return {
        module,
        book,
        bookName: bookInfo(book).name,
        chapter,
        locked: result.locked,
        entries: result.entries
      }
    }
  )
}
