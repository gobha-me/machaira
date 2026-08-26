import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  AiInputError,
  type AiProviderService,
  streamProviderChat
} from '../ai.js'
import {
  ChatConflictError,
  type ChatConversationService,
  ChatInputError,
  ChatNotFoundError,
  type StartedChat
} from '../chat.js'

function badInput(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof AiInputError || error instanceof ChatInputError) {
    return reply.code(400).send({ error: error.message })
  }
  if (error instanceof ChatNotFoundError) return reply.code(404).send({ error: error.message })
  if (error instanceof ChatConflictError) return reply.code(409).send({ error: error.message })
  return null
}

const chatRateLimit = {
  max: 10,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) => request.authUser?.id ?? request.ip
}

export async function registerAi(
  app: FastifyInstance,
  ai: AiProviderService,
  chats: ChatConversationService
): Promise<void> {
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

  app.get('/api/ai/conversations', async (request) => ({
    conversations: chats.list(request.authUser!.id)
  }))

  app.post('/api/ai/conversations', async (request, reply) => (
    reply.code(201).send({ conversation: chats.create(request.authUser!.id) })
  ))

  app.get<{ Params: { id: string } }>('/api/ai/conversations/:id', async (request, reply) => {
    try {
      const conversation = chats.get(request.authUser!.id, request.params.id)
      if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })
      return { conversation }
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/ai/conversations/:id',
    async (request, reply) => {
      try {
        const conversation = chats.rename(
          request.authUser!.id,
          request.params.id,
          request.body ?? {}
        )
        if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })
        return { conversation }
      } catch (error) {
        const response = badInput(reply, error)
        if (response) return response
        throw error
      }
    }
  )

  app.delete<{ Params: { id: string } }>('/api/ai/conversations/:id', async (request, reply) => {
    try {
      if (!chats.delete(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'Conversation not found' })
      }
      return reply.code(204).send()
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  const stream = async (
    request: FastifyRequest,
    reply: FastifyReply,
    started: StartedChat,
    credentials: ReturnType<AiProviderService['credentials']>
  ): Promise<void> => {
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
    send('accepted', {
      conversation: started.conversation,
      userMessage: started.userMessage,
      assistantMessage: started.assistantMessage
    })

    try {
      for await (const delta of streamProviderChat(credentials, started.providerInput, abort.signal)) {
        chats.appendDelta(
          request.authUser!.id,
          started.conversation.id,
          started.assistantMessage.id,
          delta
        )
        send('delta', { messageId: started.assistantMessage.id, text: delta })
      }
      const assistantMessage = chats.complete(
        request.authUser!.id,
        started.conversation.id,
        started.assistantMessage.id
      )
      send('done', { assistantMessage })
    } catch (error) {
      const interrupted = abort.signal.aborted
      const assistantMessage = chats.fail(
        request.authUser!.id,
        started.conversation.id,
        started.assistantMessage.id,
        interrupted ? 'interrupted' : 'failed',
        interrupted ? 'Response interrupted' : (error as Error).message
      )
      if (!interrupted) send('error', { message: (error as Error).message, assistantMessage })
    } finally {
      reply.raw.end()
    }
  }

  app.post<{ Params: { id: string }; Body: unknown }>('/api/ai/conversations/:id/messages', {
    bodyLimit: 256 * 1024,
    config: { rateLimit: chatRateLimit }
  }, async (request, reply) => {
    let started
    let credentials
    try {
      chats.assertOwned(request.authUser!.id, request.params.id)
      credentials = ai.credentials(request.authUser!.id)
      started = chats.startTurn(request.authUser!.id, request.params.id, request.body)
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
    await stream(request, reply, started, credentials)
  })

  app.post<{ Params: { id: string; messageId: string }; Body: unknown }>(
    '/api/ai/conversations/:id/messages/:messageId/retry',
    { bodyLimit: 16 * 1024, config: { rateLimit: chatRateLimit } },
    async (request, reply) => {
      let started
      let credentials
      try {
        chats.assertOwned(request.authUser!.id, request.params.id)
        credentials = ai.credentials(request.authUser!.id)
        started = chats.startRetry(
          request.authUser!.id,
          request.params.id,
          request.params.messageId,
          request.body ?? {}
        )
      } catch (error) {
        const response = badInput(reply, error)
        if (response) return response
        throw error
      }
      await stream(request, reply, started, credentials)
    }
  )
}
