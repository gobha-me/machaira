import type { FastifyInstance, FastifyReply } from 'fastify'
import { AudioValidationError, normalizeRecordedAudio } from '../audio-normalizer.js'
import {
  SttBusyError,
  SttInputError,
  SttProviderError,
  type SttService
} from '../stt.js'

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

function knownError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof SttInputError || error instanceof AudioValidationError) {
    return reply.code(400).send({ error: error.message })
  }
  if (error instanceof SttBusyError) {
    return reply.header('retry-after', '2').code(429).send({ error: error.message })
  }
  if (error instanceof SttProviderError) return reply.code(502).send({ error: error.message })
  return null
}

function fieldValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requestAbort(applyTo: { raw: NodeJS.EventEmitter }, reply: FastifyReply): AbortController {
  const abort = new AbortController()
  applyTo.raw.once('aborted', () => abort.abort())
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) abort.abort()
  })
  return abort
}

export async function registerStt(app: FastifyInstance, stt: SttService): Promise<void> {
  app.get('/api/stt/config', async (request) => ({ config: stt.get(request.authUser!.id) }))

  app.put<{ Body: unknown }>('/api/stt/config', async (request, reply) => {
    try {
      return { config: stt.save(request.authUser!.id, request.body) }
    } catch (error) {
      const response = knownError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post<{ Body: unknown }>('/api/stt/check', {
    bodyLimit: 16 * 1024,
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply) => {
    const abort = requestAbort(request, reply)
    try {
      return await stt.check(request.authUser!.id, request.body, abort.signal)
    } catch (error) {
      const response = knownError(reply, error)
      if (response) return response
      throw error
    }
  })

  app.post('/api/stt/transcriptions', {
    bodyLimit: MAX_UPLOAD_BYTES + 64 * 1024,
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async (request, reply) => {
    const abort = requestAbort(request, reply)
    try {
      if (!request.isMultipart()) throw new SttInputError('A multipart recording is required')
      let provider: string | undefined
      let duration: string | undefined
      let audio: Buffer | null = null
      let mimetype = ''
      for await (const part of request.parts({
        limits: { fields: 2, files: 1, parts: 3, fileSize: MAX_UPLOAD_BYTES, fieldSize: 200 }
      })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || audio) throw new SttInputError('Exactly one recording file is required')
          mimetype = part.mimetype
          audio = await part.toBuffer()
        } else if (part.fieldname === 'provider') {
          provider = fieldValue(part.value)
        } else if (part.fieldname === 'durationMs') {
          duration = fieldValue(part.value)
        } else {
          throw new SttInputError('Recording form contains an unknown field')
        }
      }
      if (provider !== 'local' && provider !== 'cloud') {
        throw new SttInputError('Transcription provider must be local or cloud')
      }
      if (!audio) throw new SttInputError('Recording file is required')
      const durationMs = Number(duration)
      const normalized = await normalizeRecordedAudio(audio, mimetype, durationMs, abort.signal)
      const text = await stt.transcribe(request.authUser!.id, provider, normalized.audio, abort.signal)
      return reply.header('cache-control', 'no-store').send({ text })
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send({ error: 'Recording is larger than 8 MiB' })
      }
      if (
        error instanceof app.multipartErrors.FieldsLimitError
        || error instanceof app.multipartErrors.FilesLimitError
        || error instanceof app.multipartErrors.PartsLimitError
      ) {
        return reply.code(413).send({ error: 'Recording form exceeds the allowed limits' })
      }
      const response = knownError(reply, error)
      if (response) return response
      throw error
    }
  })
}
