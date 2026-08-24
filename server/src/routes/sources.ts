import type { FastifyInstance, FastifyReply } from 'fastify'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import {
  ensureRepoConfig,
  refreshRepoConfig,
  listRepositories,
  listAvailableModules,
  listInstalledModules,
  installModule,
  uninstallModule,
  listCatalog,
  repositoryDiagnostics,
  getGeneralBookEntries,
  type ModuleType
} from '../sword.js'
import { importSwordZip, SwordImportError } from '../sword-import.js'

const VALID_TYPES: ModuleType[] = ['BIBLE', 'GENBOOK', 'DICT', 'COMMENTARY']

export async function registerSources(app: FastifyInstance): Promise<void> {
  app.get('/api/repositories', async () => {
    await ensureRepoConfig()
    return { repositories: await listRepositories() }
  })

  app.post('/api/repositories/refresh', async () => {
    const refresh = await refreshRepoConfig()
    return { repositories: await listRepositories(), refresh }
  })

  app.get('/api/catalog', async () => {
    await ensureRepoConfig()
    return { modules: await listCatalog(), diagnostics: await repositoryDiagnostics() }
  })

  app.post('/api/catalog/refresh', async () => {
    const diagnostics = await refreshRepoConfig()
    return { modules: await listCatalog(), diagnostics }
  })

  app.get<{ Querystring: { type?: string } }>('/api/sources', async (req) => {
    await ensureRepoConfig()
    const type = (req.query.type?.toUpperCase() as ModuleType) ?? 'BIBLE'
    if (!VALID_TYPES.includes(type)) {
      return { modules: [], error: `invalid type; expected one of ${VALID_TYPES.join(', ')}` }
    }
    return { modules: await listAvailableModules(type) }
  })

  app.get('/api/sources/installed', async () => {
    return { modules: await listInstalledModules() }
  })

  app.delete<{ Params: { module: string } }>('/api/sources/:module', async (req) => {
    await uninstallModule(req.params.module)
    return { ok: true }
  })

  const streamInstall = async (repository: string, moduleName: string, reply: FastifyReply) => {
    await ensureRepoConfig()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      let last = -1
      await installModule(repository, moduleName, (pct) => {
        if (pct !== last) {
          last = pct
          send('progress', { module: moduleName, pct })
        }
      })
      send('done', { module: moduleName })
    } catch (err) {
      send('error', { module: moduleName, message: (err as Error).message })
    } finally {
      reply.raw.end()
    }
  }

  // Repository is part of the identity: duplicate module names never install
  // from an arbitrary first match.
  app.post<{ Body: { repository?: string; module?: string } }>('/api/sources/install', async (req, reply) => {
    const repository = req.body?.repository?.trim()
    const moduleName = req.body?.module?.trim()
    if (!repository || !moduleName) return reply.code(400).send({ error: 'repository and module are required' })
    return streamInstall(repository, moduleName, reply)
  })

  app.get<{ Params: { module: string }; Querystring: { limit?: string } }>('/api/general-books/:module/entries', async (req, reply) => {
    const limit = req.query.limit === undefined ? 100000 : Number(req.query.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) return reply.code(400).send({ error: 'limit must be between 1 and 100000' })
    return { entries: await getGeneralBookEntries(req.params.module, limit) }
  })

  app.post('/api/sources/import', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' })
    if (!req.isMultipart()) return reply.code(400).send({ error: 'A multipart SWORD ZIP is required' })
    const part = await req.file()
    if (!part || !/\.zip$/i.test(part.filename)) return reply.code(400).send({ error: 'Choose a .zip SWORD module archive' })
    const scratch = await mkdtemp(join(tmpdir(), 'machaira-upload-'))
    const zipPath = join(scratch, 'module.zip')
    try {
      await pipeline(part.file, createWriteStream(zipPath, { flags: 'wx' }))
      if (part.file.truncated) return reply.code(413).send({ error: 'SWORD ZIP exceeds the 8 MiB upload limit' })
      return await importSwordZip(zipPath)
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send({ error: 'SWORD ZIP exceeds the 8 MiB upload limit' })
      }
      if (error instanceof SwordImportError) return reply.code(400).send({ error: error.message })
      throw error
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
}
