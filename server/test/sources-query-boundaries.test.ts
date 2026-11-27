import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { RepoModuleInfo } from '../src/sword.js'

const repeated = [
  'type=BIBLE&type=COMMENTARY',
  'type=BIBLE&type=BIBLE',
  'type=&type=BIBLE',
  'type=BIBLE&type=',
  'type=BIBLE&type=DICT&type=GENBOOK',
  '%74ype=BIBLE&type=DICT',
  'type=BIBLE&type=%00'
]

async function tree(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name)
    const relative = path.slice(root.length + 1)
    result.push(entry.isFile()
      ? `${relative}:${createHash('sha256').update(await readFile(path)).digest('hex')}`
      : `${relative}/`)
  }
  return result.sort()
}

describe('authenticated source query boundaries with native SWORD', () => {
  let sandbox: string
  let app: FastifyInstance
  let cookie: string
  let nativeHome: string
  let sword: typeof import('../src/sword.js')

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'machaira-source-query-'))
    // Each test process receives unchanged production bytes and its own native
    // singleton/home, so other server tests cannot initialize this catalog.
    await mkdir(join(sandbox, 'server'))
    await cp(new URL('../src/', import.meta.url), join(sandbox, 'server/src'), { recursive: true })
    await cp(new URL('../package.json', import.meta.url), join(sandbox, 'server/package.json'))
    await symlink(await realpath(new URL('../../node_modules', import.meta.url)), join(sandbox, 'node_modules'), 'dir')
    await symlink(fileURLToPath(new URL('../resources/', import.meta.url)), join(sandbox, 'server/resources'), 'dir')
    const moduleUrl = (name: string) => pathToFileURL(join(sandbox, 'server/src', name)).href
    const { buildApp } = await import(moduleUrl('app.ts')) as typeof import('../src/app.js')
    const { registerSources } = await import(moduleUrl('routes/sources.ts')) as typeof import('../src/routes/sources.js')
    sword = await import(moduleUrl('sword.ts')) as typeof import('../src/sword.js')
    nativeHome = sword.SWORD_HOME
    const manager = join(sword.SWORD_DATA_DIR, 'InstallMgr')
    const cache = join(manager, 'ftp.crosswire.org/mods.d')
    await mkdir(cache, { recursive: true })
    await writeFile(join(manager, 'InstallMgr.conf'), '[General]\nPassiveFTP=true\n[Sources]\nFTPSource=CrossWire|ftp.crosswire.org|/pub/sword/raw/\n')
    for (const name of ['asv.conf', '2babdict.conf']) {
      await cp(new URL(`./fixtures/source-catalog/${name}`, import.meta.url), join(cache, name))
    }
    app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await registerSources(app)
    const bootstrap = await app.inject({
      method: 'POST', url: '/api/auth/bootstrap',
      payload: { username: 'SourceQueryTester', password: 'independent source query regression password' }
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

  it('rejects every repeated shape before initializing the fresh native home', async () => {
    const beforeFiles = await tree(nativeHome)
    assert.equal(beforeFiles.some((path) => path.startsWith('.sword/mods.d')), false)
    for (const query of repeated) {
      const response = await app.inject({ method: 'GET', url: `/api/sources?${query}`, headers: { cookie } })
      assert.equal(response.statusCode, 400, `${query}: ${response.body}`)
      assert.deepEqual(response.json(), { error: 'type must be a single string' })
      assert.deepEqual(await tree(nativeHome), beforeFiles, query)
    }
  })

  for (const query of repeated) {
    it(`isolates ${query} from later default and case-insensitive catalog requests`, async () => {
      const beforeCatalog = await sword.listCatalog()
      const beforeFiles = await tree(nativeHome)
      const rejected = await app.inject({ method: 'GET', url: `/api/sources?${query}`, headers: { cookie } })
      assert.equal(rejected.statusCode, 400, rejected.body)
      assert.deepEqual(rejected.json(), { error: 'type must be a single string' })
      assert.deepEqual(await tree(nativeHome), beforeFiles)
      assert.deepEqual(await sword.listCatalog(), beforeCatalog)

      for (const [suffix, expected] of [['', ['ASV']], ['?type=bIbLe', ['ASV']], ['?type=dIcT', ['2BabDict']]] as const) {
        const response = await app.inject({ method: 'GET', url: `/api/sources${suffix}`, headers: { cookie } })
        assert.equal(response.statusCode, 200, response.body)
        const modules = response.json<{ modules: RepoModuleInfo[] }>().modules
        assert.deepEqual(modules.map((module) => module.name).sort(), [...expected])
        assert.equal(modules.every((module) => module.repository === 'CrossWire' && !module.installed), true)
      }
      assert.deepEqual(await tree(nativeHome), beforeFiles)
      assert.deepEqual(await sword.listCatalog(), beforeCatalog)
    })
  }

  it('keeps unauthorized and unsupported scalar responses intact after a repeated query', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: `/api/sources?${repeated[0]}` })
    assert.equal(unauthorized.statusCode, 401)
    assert.deepEqual(unauthorized.json(), { error: 'Authentication required' })
    const rejected = await app.inject({ method: 'GET', url: `/api/sources?${repeated[0]}`, headers: { cookie } })
    assert.equal(rejected.statusCode, 400, rejected.body)
    for (const type of ['UNKNOWN', '']) {
      const response = await app.inject({ method: 'GET', url: `/api/sources?type=${type}`, headers: { cookie } })
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(response.json(), {
        modules: [], error: 'invalid type; expected one of BIBLE, GENBOOK, DICT, COMMENTARY'
      })
    }
  })

  it('does not poison valid catalog requests interleaved with rejected arrays', async () => {
    const beforeCatalog = await sword.listCatalog()
    const beforeFiles = await tree(nativeHome)
    const urls = [
      `/api/sources?${repeated[0]}`, '/api/sources?type=dIcT',
      `/api/sources?${repeated[2]}`, '/api/sources', `/api/sources?${repeated[4]}`
    ]
    const responses = await Promise.all(urls.map((url) => app.inject({ method: 'GET', url, headers: { cookie } })))
    assert.deepEqual(responses.map((response) => response.statusCode), [400, 200, 400, 200, 400])
    assert.deepEqual(responses[1].json<{ modules: RepoModuleInfo[] }>().modules.map((module) => module.name), ['2BabDict'])
    assert.deepEqual(responses[3].json<{ modules: RepoModuleInfo[] }>().modules.map((module) => module.name), ['ASV'])
    assert.deepEqual(await tree(nativeHome), beforeFiles)
    assert.deepEqual(await sword.listCatalog(), beforeCatalog)
  })
})
