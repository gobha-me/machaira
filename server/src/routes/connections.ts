import type { FastifyInstance, FastifyReply } from 'fastify'
import { ConnectionInputError, type ConnectionsService } from '../connections.js'

export async function registerConnections(
  app: FastifyInstance,
  connections: Pick<ConnectionsService, 'graph'>
): Promise<void> {
  app.post<{ Body: unknown }>('/api/connections', {
    bodyLimit: 32 * 1024,
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply: FastifyReply) => {
    try {
      return await connections.graph(request.authUser!.id, request.body)
    } catch (error) {
      if (error instanceof ConnectionInputError) {
        return reply.code(400).send({ error: error.message })
      }
      throw error
    }
  })
}
