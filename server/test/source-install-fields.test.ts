import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  return Promise.all(entries.map(async (entry) => {
    const path = join(entry.parentPath, entry.name)
    const relative = path.slice(root.length + 1)
    return entry.isFile()
      ? `${relative}:${createHash('sha256').update(await readFile(path)).digest('hex')}`
      : `${relative}/`
  })).then((paths) => paths.sort())
}

describe('SWORD installation JSON field validation (issue #195)', () => {
  let sandbox: string
  let app: FastifyInstance
  let cookie: string
  let nativeHome: string

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'machaira-install-fields-'))
    // Isolate the unchanged real SWORD singleton and filesystem from other tests.
    await mkdir(join(sandbox, 'server'))
    await cp(new URL('../src/', import.meta.url), join(sandbox, 'server/src'), { recursive: true })
    await cp(new URL('../package.json', import.meta.url), join(sandbox, 'server/package.json'))
    await symlink(await realpath(new URL('../../node_modules', import.meta.url)), join(sandbox, 'node_modules'), 'dir')
    await symlink(fileURLToPath(new URL('../resources/', import.meta.url)), join(sandbox, 'server/resources'), 'dir')
    const moduleUrl = (name: string) => pathToFileURL(join(sandbox, 'server/src', name)).href
    const { buildApp } = await import(moduleUrl('app.ts')) as typeof import('../src/app.js')
    const { registerSources } = await import(moduleUrl('routes/sources.ts')) as typeof import('../src/routes/sources.js')
    const sword = await import(moduleUrl('sword.ts')) as typeof import('../src/sword.js')
    nativeHome = sword.SWORD_HOME
    const manager = join(sword.SWORD_DATA_DIR, 'InstallMgr')
    const cache = join(manager, '127.0.0.1/mods.d')
    await mkdir(cache, { recursive: true })
    // Any accidental provider access is confined to loopback. Real cached ASV metadata.
    await writeFile(join(manager, 'InstallMgr.conf'), '[General]\nPassiveFTP=true\n[Sources]\nFTPSource=CrossWire|127.0.0.1|/pub/sword/raw/\n')
    await cp(new URL('./fixtures/source-catalog/asv.conf', import.meta.url), join(cache, 'asv.conf'))
    app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await registerSources(app)
    const bootstrap = await app.inject({
      method: 'POST', url: '/api/auth/bootstrap',
      payload: { username: 'InstallFieldTester', password: 'independent installation field regression password' }
    })
    assert.equal(bootstrap.statusCode, 201)
    const session = bootstrap.cookies.find((entry) => entry.name === 'machaira_session')
    assert.ok(session)
    cookie = `${session.name}=${session.value}`
  })

  after(async () => {
    await app?.close()
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
  })

  async function reject(payload?: Record<string, unknown>): Promise<void> {
    const beforeFiles = await tree(nativeHome)
    const response = await app.inject({
      method: 'POST', url: '/api/sources/install', headers: { cookie }, payload
    })
    // These checks still run when the known bug returns 500 instead of 400.
    assert.deepEqual(await tree(nativeHome), beforeFiles, 'validation must not initialize or change native storage')
    assert.match(String(response.headers['content-type']), /^application\/json(?:;|$)/)
    const body = response.json<{ error: unknown }>()
    assert.equal(typeof body.error, 'string')
    assert.notEqual(body.error, '', 'controlled validation errors explain the rejection')
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`)
  }

  it('rejects an empty object with both fields absent', async () => {
    await reject({})
  })

  it('rejects a request with no body and both fields absent', async () => {
    await reject()
  })

  for (const field of ['repository', 'module'] as const) {
    for (const [name, value] of [
      ['null', null], ['empty', ''], ['spaces', '   '], ['mixed whitespace', '\t\r\n ']
    ] as const) {
      it(`rejects ${field}: ${name} without SSE or native side effects`, async () => {
        await reject({ repository: 'CrossWire', module: 'ASV', [field]: value })
      })
    }

    it(`rejects a missing ${field} without SSE or native side effects`, async () => {
      await reject(field === 'repository' ? { module: 'ASV' } : { repository: 'CrossWire' })
    })

    for (const [name, value] of [
      ['number', 123], ['zero', 0], ['false', false], ['true', true],
      ['array', ['ASV']], ['empty array', []], ['object', { value: 'ASV' }], ['empty object', {}]
    ] as const) {
      // Bug #195: non-string installation fields throw during trimming on main.
      // Node TODO executes the assertion; remove this marker when a code lane fixes it.
      it(`rejects ${field}: ${name} before trimming`, {
        todo: 'Bug #195: non-string SWORD installation fields produce 500 before validation'
      }, async () => {
        await reject({ repository: 'CrossWire', module: 'ASV', [field]: value })
      })
    }
  }

  it('returns the same controlled error for trimmed and untrimmed unknown module names', async () => {
    const request = (repository: string, module: string) => app.inject({
      method: 'POST', url: '/api/sources/install', headers: { cookie }, payload: { repository, module }
    })
    const canonical = await request('CrossWire', 'MissingInstallFieldRegressionModule')
    const padded = await request(' \tCrossWire\r\n', '\t MissingInstallFieldRegressionModule \n')
    assert.equal(canonical.statusCode, 200, canonical.body)
    assert.match(String(canonical.headers['content-type']), /^text\/event-stream(?:;|$)/)
    assert.equal(canonical.body, 'event: error\ndata: {"module":"MissingInstallFieldRegressionModule","message":"Module MissingInstallFieldRegressionModule is not available from CrossWire"}\n\n')
    assert.equal(padded.body, canonical.body)
    assert.equal(padded.statusCode, canonical.statusCode)
  })
})
