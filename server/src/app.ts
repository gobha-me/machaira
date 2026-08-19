import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import { AuthService, SESSION_COOKIE } from './auth.js'
import { openDatabase } from './database.js'
import { registerAuth } from './routes/auth.js'
import { registerSources } from './routes/sources.js'
import { registerRead } from './routes/read.js'
import { registerStudy } from './routes/study.js'
import { registerCommentary } from './routes/commentary.js'
import { SecretStore } from './secrets.js'
import { PersonalDataService } from './personal-data.js'
import { registerPersonalData } from './routes/personal-data.js'
import { AiProviderService } from './ai.js'
import { registerAi } from './routes/ai.js'
import { EmbeddingProviderService, SemanticIndexService } from './semantic.js'
import { registerSemantic } from './routes/semantic.js'

export interface AppOptions {
  databasePath: string
  secretKey: Buffer
  origin?: string
  production?: boolean
  logger?: boolean
  registerFeatureRoutes?: boolean
  clientPath?: string
}

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/bootstrap',
  '/api/auth/login'
])

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true })
  const db = openDatabase(options.databasePath)
  const auth = new AuthService(db)
  const personalData = new PersonalDataService(db)

  const secrets = new SecretStore(db, options.secretKey)
  const ai = new AiProviderService(db, secrets)
  const embeddingProviders = new EmbeddingProviderService(db, secrets)
  const semanticIndex = new SemanticIndexService(db, embeddingProviders)

  app.addHook('onClose', async () => db.close())
  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  await app.register(cors, {
    origin: options.origin ? [options.origin] : false,
    credentials: true
  })

  app.decorateRequest('authUser', null)
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0]
    if (!path.startsWith('/api/')) return
    if (request.method === 'OPTIONS' || PUBLIC_API_PATHS.has(path)) return
    const user = auth.authenticate(request.cookies[SESSION_COOKIE])
    if (!user) return reply.code(401).send({ error: 'Authentication required' })
    request.authUser = user
  })

  app.get('/api/health', async () => ({ ok: true }))
  await registerAuth(app, auth, options.production ?? false)
  await registerPersonalData(app, personalData)
  await registerAi(app, ai)
  await registerSemantic(app, embeddingProviders, semanticIndex)

  if (options.registerFeatureRoutes ?? true) {
    await registerSources(app)
    await registerRead(app)
    await registerStudy(app)
    await registerCommentary(app)
  }

  if (options.clientPath) {
    await app.register(staticFiles, {
      root: options.clientPath,
      prefix: '/'
    })
  }

  return app
}
