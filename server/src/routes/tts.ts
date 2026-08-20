import type { FastifyInstance, FastifyReply } from 'fastify'
import { TtsInputError, TtsProviderError, type TtsService } from '../tts.js'

function knownError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof TtsInputError) return reply.code(400).send({ error: error.message })
  if (error instanceof TtsProviderError) return reply.code(502).send({ error: error.message })
  return null
}

export async function registerTts(app: FastifyInstance, tts: TtsService): Promise<void> {
  app.get('/api/tts/config', async (request) => ({ config: tts.get(request.authUser!.id) }))

  app.put<{ Body: unknown }>('/api/tts/config', async (request, reply) => {
    try {
      return { config: tts.save(request.authUser!.id, request.body) }
    } catch (error) {
      const response = knownError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post<{ Body: unknown }>('/api/tts/speech', {
    bodyLimit: 16 * 1024,
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply) => {
    const abort = new AbortController()
    request.raw.once('aborted', () => abort.abort())
    try {
      const result = await tts.speech(request.authUser!.id, request.body, abort.signal)
      return reply
        .header('cache-control', 'no-store')
        .type(result.contentType)
        .send(result.audio)
    } catch (error) {
      const response = knownError(reply, error)
      if (response) return response
      throw error
    }
  })
}
