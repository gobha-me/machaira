import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  PersonalDataInputError,
  type PersonalDataService
} from '../personal-data.js'

function badInput(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof PersonalDataInputError) {
    return reply.code(400).send({ error: error.message })
  }
  return null
}

export async function registerPersonalData(
  app: FastifyInstance,
  personalData: PersonalDataService
): Promise<void> {
  app.get('/api/notes', async (request) => ({
    notes: personalData.listNotes(request.authUser!.id)
  }))

  app.post<{ Body: unknown }>('/api/notes', async (request, reply) => {
    try {
      const note = personalData.createNote(request.authUser!.id, request.body ?? {})
      return reply.code(201).send({ note })
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/notes/:id', async (request, reply) => {
    try {
      const note = personalData.updateNote(request.authUser!.id, request.params.id, request.body ?? {})
      if (!note) return reply.code(404).send({ error: 'Note not found' })
      return { note }
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (request, reply) => {
    try {
      if (!personalData.deleteNote(request.authUser!.id, request.params.id)) {
        return reply.code(404).send({ error: 'Note not found' })
      }
      return reply.code(204).send()
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.get('/api/highlights', async (request) => ({
    highlights: personalData.listHighlights(request.authUser!.id)
  }))

  app.put<{ Body: unknown }>('/api/highlights', async (request, reply) => {
    try {
      personalData.setHighlight(request.authUser!.id, request.body)
      return reply.code(204).send()
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.delete<{ Params: { key: string } }>('/api/highlights/:key', async (request, reply) => {
    try {
      personalData.deleteHighlight(request.authUser!.id, request.params.key)
      return reply.code(204).send()
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post<{ Body: unknown }>('/api/highlights/batch', async (request, reply) => {
    try {
      personalData.updateHighlights(request.authUser!.id, request.body)
      return reply.code(204).send()
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post<{ Body: unknown }>('/api/personal-data/import', {
    bodyLimit: 20 * 1024 * 1024
  }, async (request, reply) => {
    try {
      return personalData.importLegacy(request.authUser!.id, request.body)
    } catch (error) {
      const response = badInput(reply, error)
      if (response) return response
      throw error
    }
  })
}
