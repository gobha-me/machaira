import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { parseSecretKey } from './secrets.js'
import { ensureRepoConfig } from './sword.js'

const PORT = Number(process.env.PORT ?? 5274)
const HOST = process.env.HOST ?? '127.0.0.1'
const production = process.env.NODE_ENV === 'production'
const databasePath = process.env.MACHAIRA_DB_PATH
  ?? fileURLToPath(new URL('../data/machaira.sqlite', import.meta.url))
const clientPath = fileURLToPath(new URL('../../client/dist', import.meta.url))
const encodedKey = process.env.MACHAIRA_SECRET_KEY
if (!encodedKey) throw new Error('MACHAIRA_SECRET_KEY is required; generate one with: openssl rand -base64 32')

const app = await buildApp({
  databasePath,
  secretKey: parseSecretKey(encodedKey),
  origin: process.env.MACHAIRA_ORIGIN,
  production,
  clientPath: production ? clientPath : undefined
})

// Warm the repository config in the background so the Library loads fast.
ensureRepoConfig().catch((err) => app.log.warn({ err }, 'repo config warm-up failed'))

app
  .listen({ port: PORT, host: HOST })
  .then(() => app.log.info(`Sword server listening on http://${HOST}:${PORT}`))
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
