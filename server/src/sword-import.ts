import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, normalize, posix, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { SWORD_DATA_DIR, listCatalog, refreshLocalModules } from './sword.js'

const MAX_FILES = 5_000
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const MODULE_DRIVERS = new Set([
  'zText', 'RawText', 'RawText4', 'zCom', 'RawCom', 'RawCom4',
  'zLD', 'RawLD', 'RawLD4', 'RawGenBook'
])

export class SwordImportError extends Error {}

export function validateSwordArchivePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || posix.isAbsolute(value)) {
    throw new SwordImportError('Archive contains an unsafe path')
  }
  const clean = posix.normalize(value).replace(/^\.\//, '')
  if (clean === '..' || clean.startsWith('../') || !['mods.d/', 'modules/'].some((root) => clean.startsWith(root))) {
    throw new SwordImportError('Archive must contain only mods.d/ and modules/ SWORD files')
  }
  return clean
}

function isSymlink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => error || !zip ? reject(error) : resolveZip(zip))
  })
}

function entryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error) : resolveStream(stream))
  })
}

async function extractValidated(zipPath: string, staging: string): Promise<string[]> {
  const zip = await openZip(zipPath)
  const files: string[] = []
  const paths = new Set<string>()
  let entryCount = 0
  let expanded = 0
  try {
    await new Promise<void>((resolveEntries, reject) => {
      zip.once('error', reject)
      zip.once('end', resolveEntries)
      zip.on('entry', (entry) => {
        void (async () => {
          const relative = validateSwordArchivePath(entry.fileName)
          if (isSymlink(entry)) throw new SwordImportError('Symbolic links are not allowed in imports')
          entryCount += 1
          expanded += entry.uncompressedSize
          if (expanded > MAX_EXPANDED_BYTES || entryCount > MAX_FILES) {
            throw new SwordImportError('Archive exceeds the expanded size or file-count limit')
          }
          if (paths.has(relative)) throw new SwordImportError(`Archive repeats path ${relative}`)
          paths.add(relative)
          const target = resolve(staging, ...relative.split('/'))
          if (!target.startsWith(`${resolve(staging)}${sep}`)) throw new SwordImportError('Archive path escapes staging')
          if (relative.endsWith('/')) {
            await mkdir(target, { recursive: true })
          } else {
            await mkdir(dirname(target), { recursive: true })
            const stream = await entryStream(zip, entry)
            await pipeline(stream, createWriteStream(target, { flags: 'wx' }))
            files.push(relative)
          }
          zip.readEntry()
        })().catch(reject)
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
  return files
}

export function parseSwordModuleConfig(text: string): { name: string; driver: string; dataPath: string } {
  const sections = [...text.matchAll(/^\s*\[([^\]]+)]\s*$/gm)]
  if (sections.length !== 1) throw new SwordImportError('Each module configuration must contain exactly one module')
  const section = sections[0][1].trim()
  const driver = text.match(/^\s*ModDrv\s*=\s*(.+?)\s*$/mi)?.[1]?.trim()
  const dataPath = text.match(/^\s*DataPath\s*=\s*(.+?)\s*$/mi)?.[1]?.trim().replace(/^\.\//, '')
  if (!section || !/^[A-Za-z0-9_.-]{1,80}$/.test(section)) throw new SwordImportError('Module configuration has an invalid name')
  if (!driver || !MODULE_DRIVERS.has(driver)) throw new SwordImportError('Module uses an unsupported SWORD driver')
  if (!dataPath || dataPath.includes('..') || dataPath.startsWith('/')) throw new SwordImportError('Module configuration has an unsafe DataPath')
  return { name: section, driver, dataPath: normalize(dataPath) }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

export async function importSwordZip(zipPath: string): Promise<{ modules: string[] }> {
  const staging = await mkdtemp(join(tmpdir(), 'machaira-sword-import-'))
  const copied: string[] = []
  try {
    const files = await extractValidated(zipPath, staging)
    const confs = files.filter((file) => file.startsWith('mods.d/') && file.endsWith('.conf'))
    if (confs.length === 0) throw new SwordImportError('Archive contains no SWORD module configuration')
    const configs = await Promise.all(confs.map(async (file) => ({ file, ...parseSwordModuleConfig(await readFile(join(staging, file), 'utf8')) })))
    const knownNames = new Set((await listCatalog()).map((module) => module.name.toLocaleLowerCase()))
    for (const config of configs) {
      if (knownNames.has(config.name.toLocaleLowerCase())) throw new SwordImportError(`Module name ${config.name} already exists in the catalog`)
      knownNames.add(config.name.toLocaleLowerCase())
      const dataPrefix = config.dataPath.replaceAll('\\', '/').replace(/^modules\//, 'modules/')
      if (!files.some((file) => file === dataPrefix || file.startsWith(`${dataPrefix}/`))) {
        throw new SwordImportError(`Module ${config.name} is missing its configured data files`)
      }
    }
    for (const relative of files.filter((file) => !file.startsWith('mods.d/'))) {
      const destination = join(SWORD_DATA_DIR, relative)
      if (await exists(destination)) throw new SwordImportError(`Import collides with existing file ${relative}`)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(staging, relative), destination)
      copied.push(destination)
    }
    for (const config of configs) {
      const destination = join(SWORD_DATA_DIR, config.file)
      if (await exists(destination)) throw new SwordImportError(`Import collides with existing file ${config.file}`)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(staging, config.file), destination)
      copied.push(destination)
    }
    await refreshLocalModules()
    return { modules: configs.map((config) => config.name) }
  } catch (error) {
    await Promise.all(copied.reverse().map((path) => rm(path, { force: true })))
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(zipPath, { force: true })
  }
}
