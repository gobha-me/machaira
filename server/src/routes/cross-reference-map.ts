import type { FastifyInstance } from 'fastify'
import { CrossReferenceMapService, MapInputError } from '../cross-reference-map.js'
import type { SemanticIndexService } from '../semantic.js'

export async function registerCrossReferenceMap(app: FastifyInstance, map: CrossReferenceMapService, semantic: Pick<SemanticIndexService, 'mapDistances'>) {
  app.post<{ Body: unknown }>('/api/cross-reference-map', { bodyLimit: 1024 }, async (request, reply) => {
    try { return map.graph(request.body) }
    catch (error) {
      if (error instanceof MapInputError) return reply.code(400).send({ error: error.message })
      throw error
    }
  })
  app.post<{ Body: { module?: unknown; reference?: unknown } }>('/api/cross-reference-map/resolve', { bodyLimit: 1024 }, async (request, reply) => {
    try {
      const target = await map.resolve(request.body?.module, request.body?.reference)
      return { target }
    } catch (error) {
      if (error instanceof MapInputError) return reply.code(400).send({ error: error.message })
      throw error
    }
  })
  app.post<{ Body: { module?: unknown; scope?: unknown } }>('/api/cross-reference-map/similarity', {
    bodyLimit: 1024,
    config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (request) => request.authUser?.id ?? request.ip } }
  }, async (request, reply) => {
    try {
      return await map.similarities(request.authUser!.id, request.body?.module, request.body?.scope, semantic)
    } catch (error) {
      if (error instanceof MapInputError) return reply.code(400).send({ error: error.message })
      // The optional index must never make canonical cross-references unavailable.
      request.log.warn({ err: error }, 'Map similarity unavailable')
      return { state: 'unavailable', distances: [] }
    }
  })
}
