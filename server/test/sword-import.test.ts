import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseSwordModuleConfig, SwordImportError, validateSwordModuleFiles } from '../src/sword-import.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/sword-import/${name}`, import.meta.url), 'utf8')
}

const asv = fixture('asv.conf')
const asvFiles = JSON.parse(fixture('asv-files.json')) as string[]
const dictionary = fixture('2babdict.conf')
const dictionaryFiles = JSON.parse(fixture('2babdict-files.json')) as string[]

function withPath(path: string): string {
  return asv.replace(/^DataPath=.*$/m, `DataPath=${path}`)
}

describe('SWORD import DataPath matching', () => {
  it('matches the real CrossWire ASV archive with its leading dot and trailing slash', () => {
    const config = parseSwordModuleConfig(asv)
    assert.equal(config.dataPath, 'modules/texts/ztext/asv')
    assert.doesNotThrow(() => validateSwordModuleFiles(config, asvFiles))
  })

  it('normalizes repeated dot prefixes and trailing directory separators', () => {
    for (const path of ['modules/texts/ztext/asv', '././modules/texts/ztext/asv///']) {
      const config = parseSwordModuleConfig(withPath(path))
      assert.equal(config.dataPath, 'modules/texts/ztext/asv')
      assert.doesNotThrow(() => validateSwordModuleFiles(config, asvFiles))
    }
  })

  it('rejects traversal, backslashes, absolute paths, NUL, and paths outside modules', () => {
    for (const path of [
      '../modules/texts/ztext/asv', 'modules/../modules/texts/ztext/asv',
      'modules/texts/ztext/asv/..', '/modules/texts/ztext/asv',
      'C:/modules/texts/ztext/asv', './modules\\texts\\ztext\\asv',
      'modules/texts/\0asv', 'mods.d/asv.conf', './', 'modules/'
    ]) {
      assert.throws(() => parseSwordModuleConfig(withPath(path)), SwordImportError, JSON.stringify(path))
    }
  })

  it('rejects missing files and similarly named sibling directories', () => {
    const config = parseSwordModuleConfig(asv)
    for (const files of [[], ['mods.d/asv.conf'], ['modules/texts/ztext/asv-other/ot.bzz']]) {
      assert.throws(() => validateSwordModuleFiles(config, files), /missing its configured data files/)
    }
  })

  it('matches real RawLD filename stems without accepting similarly named modules', () => {
    const config = parseSwordModuleConfig(dictionary)
    assert.doesNotThrow(() => validateSwordModuleFiles(config, dictionaryFiles))
    assert.throws(() => validateSwordModuleFiles(config, dictionaryFiles.map((file) => file.replace('2babdict.dat', '2babdict-other.dat').replace('2babdict.idx', '2babdict-other.idx'))), SwordImportError)
    assert.throws(() => validateSwordModuleFiles(config, [`${config.dataPath}.txt`]), SwordImportError)
  })
})
