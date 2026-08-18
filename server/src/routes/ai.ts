import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  AiInputError,
  type AiProviderService,
  parseChatInput,
  streamProviderChat
} from '../ai.js'

function badInput(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof AiInputError) return reply.code(400).send({ error: error.message })
  return null
}

export async function registerAi(app: FastifyInstance, ai: AiProviderService): Promise<void> {
  app.get('/api/ai/provider', async (request) => ({ provider: ai.get(request.authUser!.id) }))

  app.put<{ Body: unknown }>('/api/ai/provider', async (request, reply) => {
    try {
      return { provider: ai.save(request.authUser!.id, request.body) }
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.delete('/api/ai/provider', async (request, reply) => {
    ai.remove(request.authUser!.id)
    return reply.code(204).send()
  })

  app.post<{ Body: unknown }>('/api/ai/chat', {
    bodyLimit: 256 * 1024,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply) => {
    let input
    let credentials
    try {
      input = parseChatInput(request.body)
      credentials = ai.credentials(request.authUser!.id)
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }

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
      for await (const delta of streamProviderChat(credentials, input, abort.signal)) {
        send('delta', { text: delta })
      }
      send('done', {})
    } catch (error) {
      if (!abort.signal.aborted) send('error', { message: (error as Error).message })
    } finally {
      reply.raw.end()
    }
  })
}
