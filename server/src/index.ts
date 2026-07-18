import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerSources } from './routes/sources.js'
import { registerRead } from './routes/read.js'
import { registerStudy } from './routes/study.js'
import { registerCommentary } from './routes/commentary.js'
import { ensureRepoConfig } from './sword.js'

const PORT = Number(process.env.PORT ?? 5274)

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

app.get('/api/health', async () => ({ ok: true }))

await registerSources(app)
await registerRead(app)
await registerStudy(app)
await registerCommentary(app)

// Warm the repository config in the background so the Library loads fast.
ensureRepoConfig().catch((err) => app.log.warn({ err }, 'repo config warm-up failed'))

app
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(() => app.log.info(`Sword server listening on http://127.0.0.1:${PORT}`))
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
