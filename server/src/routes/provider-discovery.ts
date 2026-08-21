import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  DiscoveryInputError,
  ProviderDiscoveryError,
  type ProviderDiscoveryService
} from '../provider-discovery.js'

function knownError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof DiscoveryInputError) {
    return reply.code(400).send({ error: error.message, code: error.code })
  }
  if (error instanceof ProviderDiscoveryError) {
    const status = error.code === 'provider_timeout' ? 504 : 502
    return reply.code(status).send({ error: error.message, code: error.code })
  }
  return null
}

export async function registerProviderDiscovery(
  app: FastifyInstance,
  discovery: ProviderDiscoveryService
): Promise<void> {
  app.post<{ Body: unknown }>('/api/providers/discover', {
    bodyLimit: 16 * 1024,
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply) => {
    const abort = new AbortController()
    request.raw.once('aborted', () => abort.abort())
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abort.abort()
    })
    try {
      return await discovery.discover(request.authUser!.id, request.body, abort.signal)
    } catch (error) {
      const response = knownError(reply, error)
      if (response) return response
      throw error
    }
  })
}
