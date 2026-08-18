import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildApp } from '../src/app.ts'

describe('production static application', () => {
  it('serves client assets publicly while keeping API routes protected', async () => {
    const clientPath = await mkdtemp(join(tmpdir(), 'machaira-client-'))
    await mkdir(join(clientPath, 'assets'))
    await writeFile(join(clientPath, 'index.html'), '<main>Sword client</main>')
    await writeFile(join(clientPath, 'assets', 'app.js'), 'globalThis.sword = true')

    const app = await buildApp({
      databasePath: ':memory:',
      secretKey: randomBytes(32),
      logger: false,
      registerFeatureRoutes: false,
      clientPath
    })
    await app.ready()

    try {
      const index = await app.inject({ method: 'GET', url: '/' })
      assert.equal(index.statusCode, 200)
      assert.match(index.body, /Sword client/)
      assert.match(index.headers['content-type'] ?? '', /^text\/html/)

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
      assert.equal(asset.statusCode, 200)
      assert.match(asset.body, /globalThis\.sword/)

      const missingPage = await app.inject({ method: 'GET', url: '/missing' })
      assert.equal(missingPage.statusCode, 404)

      const protectedApi = await app.inject({ method: 'GET', url: '/api/missing' })
      assert.equal(protectedApi.statusCode, 401)
    } finally {
      await app.close()
      await rm(clientPath, { recursive: true, force: true })
    }
  })
})
