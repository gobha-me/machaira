import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  EmbeddingProviderError,
  type EmbeddingProviderService,
  SemanticInputError,
  type SemanticIndexService,
  SemanticStateError
} from '../semantic.js'

function inputError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof SemanticInputError) return reply.code(400).send({ error: error.message })
  if (error instanceof SemanticStateError) return reply.code(409).send({ error: error.message })
  if (error instanceof EmbeddingProviderError) return reply.code(502).send({ error: error.message })
  return null
}

export async function registerSemantic(
  app: FastifyInstance,
  providers: EmbeddingProviderService,
  index: SemanticIndexService
): Promise<void> {
  app.get('/api/embeddings/provider', async (request) => ({
    provider: providers.get(request.authUser!.id)
  }))

  app.put<{ Body: unknown }>('/api/embeddings/provider', async (request, reply) => {
    try {
      return { provider: providers.save(request.authUser!.id, request.body) }
    } catch (error) {
      return inputError(reply, error) ?? Promise.reject(error)
    }
  })

  app.delete('/api/embeddings/provider', async (request, reply) => {
    providers.remove(request.authUser!.id)
    return reply.code(204).send()
  })

  app.get('/api/semantic-index', async (request) => ({
    index: await index.status(request.authUser!.id)
  }))

  app.post('/api/semantic-index/rebuild', {
    config: {
      rateLimit: {
        max: 2,
        timeWindow: '1 hour',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply) => {
    const abort = new AbortController()
    request.raw.once('aborted', () => abort.abort())
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abort.abort()
    })
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    const send = (event: string, data: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      const status = await index.rebuild(
        request.authUser!.id,
        (progress) => send('progress', progress),
        abort.signal
      )
      send('done', status)
    } catch (error) {
      if (!abort.signal.aborted) send('error', { message: (error as Error).message })
    } finally {
      reply.raw.end()
    }
  })

  app.post<{ Body: unknown }>('/api/semantic-search', {
    bodyLimit: 32 * 1024,
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply) => {
    try {
      return { results: await index.search(request.authUser!.id, request.body) }
    } catch (error) {
      return inputError(reply, error) ?? Promise.reject(error)
    }
  })
}
