import type { FastifyInstance } from 'fastify'
import {
  ensureRepoConfig,
  refreshRepoConfig,
  listRepositories,
  listAvailableModules,
  listInstalledModules,
  installModule,
  uninstallModule,
  type ModuleType
} from '../sword.js'

const VALID_TYPES: ModuleType[] = ['BIBLE', 'DICT', 'COMMENTARY']

export async function registerSources(app: FastifyInstance): Promise<void> {
  app.get('/api/repositories', async () => {
    await ensureRepoConfig()
    return { repositories: await listRepositories() }
  })

  app.post('/api/repositories/refresh', async () => {
    await refreshRepoConfig()
    return { repositories: await listRepositories() }
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

  // Install streams progress as Server-Sent Events so the Library % bar is live.
  app.post<{ Params: { module: string } }>('/api/sources/:module/install', async (req, reply) => {
    await ensureRepoConfig()
    const moduleName = req.params.module

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
      await installModule(moduleName, (pct) => {
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
  })
}
