import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { fixtureZip, type ZipMember } from './fixtures/sword-import/zip.js'

// Each zText verse index record is ten bytes. Zero records describe a module
// with no verse content and allow SWORD to enumerate its books without EOFs.
const emptyVerseIndex = Buffer.alloc(320_000)

function moduleMembers(name: string): ZipMember[] {
  const fixture = (filename: string) => new URL(`./fixtures/sword-import/${filename}`, import.meta.url)
  const config = readFileSync(fixture(`${name}.conf`))
  const paths = JSON.parse(readFileSync(fixture(`${name}-files.json`), 'utf8')) as string[]
  // These archives exercise installation and catalog registration. The data
  // entries stand in for the module text and index bytes from CrossWire.
  return paths.map((path) => {
    if (path.endsWith('.conf')) return [path, config]
    if (path.endsWith('.bzv')) return [path, emptyVerseIndex]
    return [path, Buffer.alloc(0)]
  })
}

const asv = moduleMembers('asv')
const rawLd = moduleMembers('2babdict')

describe('SWORD ZIP uploads', () => {
  let app: FastifyInstance
  let sandbox: string
  let cookie: string
  let swordHome: string
  let dataDir: string

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'machaira-sword-http-test-'))
    // Use an isolated native catalog. The production SWORD home is relative to
    // the server module, so load an unmodified copy as in the source query tests.
    const server = join(sandbox, 'server')
    await mkdir(server)
    await cp(new URL('../src/', import.meta.url), join(server, 'src'), { recursive: true })
    await cp(new URL('../package.json', import.meta.url), join(server, 'package.json'))
    await symlink(await realpath(new URL('../../node_modules', import.meta.url)), join(sandbox, 'node_modules'), 'dir')
    await symlink(fileURLToPath(new URL('../resources/', import.meta.url)), join(server, 'resources'), 'dir')
    const moduleUrl = (name: string) => pathToFileURL(join(server, 'src', name)).href
    const { buildApp } = await import(moduleUrl('app.ts')) as typeof import('../src/app.js')
    const { registerSources } = await import(moduleUrl('routes/sources.ts')) as typeof import('../src/routes/sources.js')
    const { SWORD_HOME, SWORD_DATA_DIR } = await import(moduleUrl('sword.ts')) as typeof import('../src/sword.js')
    swordHome = SWORD_HOME
    dataDir = SWORD_DATA_DIR
    app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false, registerFeatureRoutes: false
    })
    await registerSources(app)
    const bootstrap = await app.inject({
      method: 'POST', url: '/api/auth/bootstrap',
      payload: { username: 'SwordImportTester', password: 'isolated SWORD import account' }
    })
    assert.equal(bootstrap.statusCode, 201, bootstrap.body)
    const session = bootstrap.cookies.find((entry) => entry.name === 'machaira_session')
    assert.ok(session)
    cookie = `${session.name}=${session.value}`
  })

  after(async () => {
    try {
      await app?.close()
    } finally {
      if (sandbox) await rm(sandbox, { recursive: true, force: true })
    }
  })

  function upload(zip: Buffer) {
    const boundary = 'machaira-sword-import-boundary'
    const header = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="module.zip"',
      'Content-Type: application/zip', '', ''
    ].join('\r\n')
    return app.inject({
      method: 'POST', url: '/api/sources/import',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(header), zip, Buffer.from(`\r\n--${boundary}--\r\n`)])
    })
  }

  async function installedModules() {
    const response = await app.inject({ url: '/api/sources/installed', headers: { cookie } })
    assert.equal(response.statusCode, 200, response.body)
    return response.json<{ modules: { name: string; installed: boolean }[] }>().modules
  }

  async function installationState() {
    const modules = await installedModules()
    const entries = await readdir(swordHome, { recursive: true, withFileTypes: true })
    const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const path = join(entry.parentPath, entry.name)
      return [relative(swordHome, path), await readFile(path)] as const
    }))
    return { modules, files: Object.fromEntries(files) }
  }

  async function rejectedUpload(zip: Buffer, statusCode: number, message?: string) {
    const before = await installationState()
    const response = await upload(zip)
    assert.deepEqual(await installationState(), before, 'rejected ZIP changed the installed catalog or files')
    assert.equal(response.statusCode, statusCode, response.body)
    if (message) assert.deepEqual(response.json(), { error: message })
  }

  it('leaves both modules uninstalled when a later module has no matching data', async () => {
    const entries = [...asv, ...rawLd.filter(([path]) => path.endsWith('.conf'))]
    await rejectedUpload(fixtureZip(entries), 400, 'Module 2BabDict is missing its configured data files')
  })

  it('rejects an invalid configured path before installing any archive members', async () => {
    const entries = asv.map(([path, contents]): ZipMember => [path, path.endsWith('.conf')
      ? Buffer.from(contents.toString('utf8').replace(/^DataPath=.*$/m, 'DataPath=./modules/texts/ztext/../ztext/asv/'))
      : contents])
    await rejectedUpload(fixtureZip(entries), 400, 'Module configuration has an unsafe DataPath')
  })

  it('returns a client error for a truncated ZIP', async () => {
    const zip = fixtureZip(asv)
    await rejectedUpload(zip.subarray(0, zip.length - 22), 400)
  })

  it('returns a client error for a damaged ZIP directory header', async () => {
    const zip = fixtureZip(asv)
    const directoryHeader = zip.indexOf(Buffer.from('504b0102', 'hex'))
    assert.ok(directoryHeader > 0)
    zip[directoryHeader] = 0
    await rejectedUpload(zip, 400)
  })

  it('returns a client error when a later ZIP entry has a damaged file header', async () => {
    const zip = fixtureZip(asv)
    const secondLocalHeader = zip.indexOf(Buffer.from('504b0304', 'hex'), 4)
    assert.ok(secondLocalHeader > 0)
    zip[secondLocalHeader] = 0
    await rejectedUpload(zip, 400)
  })

  it('keeps a local storage failure a server error and rolls back earlier files', async () => {
    const blockedDirectory = join(dataDir, 'modules', 'blocked')
    await mkdir(dirname(blockedDirectory), { recursive: true })
    await writeFile(blockedDirectory, 'existing local file')
    try {
      const zip = fixtureZip([asv[0], ['modules/blocked/entry', Buffer.alloc(0)], ...asv.slice(1)])
      await rejectedUpload(zip, 500)
    } finally {
      await rm(blockedDirectory)
    }
  })

  for (const [name, entries] of [['ASV', asv], ['2BabDict', rawLd]] as const) {
    it(`installs the standard CrossWire ${name} layout through the upload route`, async () => {
      const response = await upload(fixtureZip(entries))
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(response.json(), { modules: [name] })
      for (const [path, contents] of entries) {
        assert.deepEqual(await readFile(join(dataDir, path)), contents, path)
      }
      assert.ok((await installedModules()).some((module) => module.name === name && module.installed))
    })
  }
})
