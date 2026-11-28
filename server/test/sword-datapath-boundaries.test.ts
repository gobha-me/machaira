import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseSwordModuleConfig, SwordImportError, validateSwordModuleFiles } from '../src/sword-import.js'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/sword-import/${name}`, import.meta.url), 'utf8')
}

function withDataPath(config: string, dataPath: string): string {
  return config.replace(/^DataPath=.*$/m, () => `DataPath=${dataPath}`)
}

const asv = fixture('asv.conf')
const asvFiles = JSON.parse(fixture('asv-files.json')) as string[]
const dictionary = fixture('2babdict.conf')
const dictionaryFiles = JSON.parse(fixture('2babdict-files.json')) as string[]

describe('SWORD module layout validation', () => {
  it('preserves adjacent dots within a directory name', () => {
    const dataPath = 'modules/texts/ztext/asv..edition'
    const config = parseSwordModuleConfig(withDataPath(asv, `./${dataPath}/`))
    const files = asvFiles.map((file) => file.replace('modules/texts/ztext/asv/', `${dataPath}/`))

    assert.equal(config.dataPath, dataPath)
    assert.doesNotThrow(() => validateSwordModuleFiles(config, files))
  })

  it('rejects an ASV directory that contains only a README', () => {
    const config = parseSwordModuleConfig(asv)
    const files = ['mods.d/asv.conf', 'modules/texts/ztext/asv/README.txt']

    assert.throws(() => validateSwordModuleFiles(config, files), SwordImportError)
  })

  for (const suffix of ['.dat', '.idx']) {
    it(`rejects a RawLD module missing its ${suffix} file`, () => {
      const config = parseSwordModuleConfig(dictionary)
      const files = dictionaryFiles.filter((file) => !file.endsWith(suffix))

      assert.throws(() => validateSwordModuleFiles(config, files), SwordImportError)
    })
  }

  it('rejects a RawLD path ending in a slash when its data files are siblings', () => {
    const config = withDataPath(dictionary, './modules/lexdict/rawld/2babdict/2babdict/')

    assert.throws(() => {
      validateSwordModuleFiles(parseSwordModuleConfig(config), dictionaryFiles)
    }, SwordImportError)
  })
})
