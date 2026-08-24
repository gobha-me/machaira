import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bookInfo, isDeuterocanonicalBook } from '../src/books.js'
import { auditedCoverage } from '../src/catalog-audit.js'
import { parseSwordModuleConfig, SwordImportError, validateSwordArchivePath } from '../src/sword-import.js'

describe('catalog coverage', () => {
  it('classifies expanded OSIS books centrally', () => {
    for (const code of ['AddPs', 'Ps151', '3Macc', '4Macc', 'EpLao']) {
      assert.equal(isDeuterocanonicalBook(code), true)
      assert.equal(bookInfo(code).section, 'apocrypha')
    }
  })

  it('only trusts an audit for the exact repository, name, and version', () => {
    assert.ok(auditedCoverage('CrossWire', 'KJVA', '3.1'))
    assert.equal(auditedCoverage('CrossWire', 'KJVA', 'future-version'), undefined)
    assert.equal(auditedCoverage('Another repository', 'KJVA', '3.1'), undefined)
  })
})

describe('SWORD ZIP validation', () => {
  it('accepts module roots and rejects traversal, absolute paths, and backslashes', () => {
    assert.equal(validateSwordArchivePath('mods.d/example.conf'), 'mods.d/example.conf')
    assert.equal(validateSwordArchivePath('modules/texts/ztext/example/data'), 'modules/texts/ztext/example/data')
    for (const path of ['../mods.d/evil.conf', '/mods.d/evil.conf', 'mods.d\\evil.conf', 'readme.txt']) {
      assert.throws(() => validateSwordArchivePath(path), SwordImportError)
    }
  })

  it('validates module names, drivers, and relative data paths', () => {
    assert.deepEqual(parseSwordModuleConfig('[Enoch]\nModDrv=RawGenBook\nDataPath=./modules/genbook/rawgenbook/enoch\n'), {
      name: 'Enoch', driver: 'RawGenBook', dataPath: 'modules/genbook/rawgenbook/enoch'
    })
    assert.throws(() => parseSwordModuleConfig('[Bad]\nModDrv=Unknown\nDataPath=../escape\n'), SwordImportError)
    assert.throws(() => parseSwordModuleConfig('[One]\n[Two]\nModDrv=RawGenBook\nDataPath=modules/two\n'), SwordImportError)
  })
})
