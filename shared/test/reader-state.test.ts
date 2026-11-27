import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parsePreferences,
  parseReadingCursor,
  parseUserPreferences,
  validModuleName
} from '../src/reader-state.ts'

const cursor = { moduleName: 'WEB', book: 'Gen', chapter: 1, updated_at: 0 }
const booleanPreferences = [
  'extraSpacing', 'followAlong', 'drawApocrypha', 'alwaysCite',
  'showFootnotes', 'showStrongs', 'studyPartnerOpen'
] as const

describe('account-synced reader contracts', () => {
  it('accepts the full module-name alphabet and both length boundaries', () => {
    for (const name of ['A', '0', 'A_0.-z', 'x'.repeat(128)]) {
      assert.equal(validModuleName(name), true, JSON.stringify(name))
    }
    for (const value of [null, undefined, 42, true, {}, [], '', '_WEB', '.WEB', '-WEB',
      'x'.repeat(129), 'WEB/path', 'WEB\\path', 'WEB name', 'WÉB', 'WEB\n']) {
      assert.equal(validModuleName(value), false, JSON.stringify(value))
    }
  })

  it('rejects forbidden characters at every position in otherwise valid names', () => {
    for (const character of ['/', '\\', ':', ' ', '\t', '\n', '\0', 'é']) {
      for (let index = 0; index <= 8; index++) {
        const name = 'A1234567'.slice(0, index) + character + 'A1234567'.slice(index)
        assert.equal(validModuleName(name), false, JSON.stringify(name))
      }
    }
  })

  it('round-trips cursors at book, chapter, and timestamp boundaries', () => {
    for (const book of ['A', '1', '1_John.-', 'b'.repeat(32)]) {
      for (const chapter of [1, Number.MAX_SAFE_INTEGER]) {
        for (const updated_at of [0, Number.MAX_SAFE_INTEGER]) {
          const value = { ...cursor, book, chapter, updated_at }
          assert.deepEqual(parseReadingCursor(value), value)
        }
      }
    }
  })

  it('rejects malformed cursor shapes, missing fields, and extra fields', () => {
    for (const value of [null, undefined, [], 'cursor', 1, {}, { ...cursor, extra: true }]) {
      assert.equal(parseReadingCursor(value), null)
    }
    for (const key of Object.keys(cursor)) {
      const incomplete: Record<string, unknown> = { ...cursor }
      delete incomplete[key]
      assert.equal(parseReadingCursor(incomplete), null, key)
    }
  })

  it('validates each cursor field without coercing user input', () => {
    const invalidFields: Record<string, unknown[]> = {
      moduleName: [null, 1, '', '_WEB', 'x'.repeat(129)],
      book: [null, 1, '', '_Gen', 'Gen 1', 'Gén', 'b'.repeat(33), 'Gen\n'],
      chapter: [null, '1', true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
      updated_at: [null, '0', true, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
    }
    for (const [key, values] of Object.entries(invalidFields)) {
      for (const value of values) assert.equal(parseReadingCursor({ ...cursor, [key]: value }), null, key)
    }
  })

  it('accepts partial preferences and drops unknown or inherited keys', () => {
    assert.deepEqual(parsePreferences({}), {})
    assert.deepEqual(parsePreferences({ theme: 'ink', futurePreference: { anything: true } }), { theme: 'ink' })
    const inherited: unknown = Object.assign(Object.create({ theme: 'invalid', showStrongs: 'yes' }), { followAlong: false })
    assert.deepEqual(parsePreferences(inherited), { followAlong: false })
    for (const value of [null, undefined, [], 'settings', 1, true]) {
      assert.equal(parsePreferences(value), null)
    }
  })

  it('requires every toggle to be a boolean while retaining false values', () => {
    for (const key of booleanPreferences) {
      for (const value of [true, false]) assert.deepEqual(parsePreferences({ [key]: value }), { [key]: value })
      for (const value of [null, undefined, 0, 1, '', 'false', [], {}]) {
        assert.equal(parsePreferences({ theme: 'paper', [key]: value }), null, key)
      }
    }
  })

  it('validates themes and complete six-digit accent colors', () => {
    for (const theme of ['paper', 'ink']) assert.deepEqual(parsePreferences({ theme }), { theme })
    for (const theme of ['', 'Paper', 'dark', null, true, 1]) assert.equal(parsePreferences({ theme }), null)
    for (const accent of ['', '#000000', '#abcdef', '#ABCDEF', '#0aF19C']) {
      assert.deepEqual(parsePreferences({ accent }), { accent })
    }
    for (const accent of ['#abc', '#1234567', '123456', '#12345g', '#123456\n', ' #123456', null, 123456,
      { toString: () => '#123456' }]) {
      assert.equal(parsePreferences({ accent }), null)
    }
  })

  it('accepts inclusive finite text-scale bounds without rounding values', () => {
    for (const textScale of [0.9, 1, 1.125, 1.4]) {
      assert.deepEqual(parsePreferences({ textScale }), { textScale })
    }
    for (const textScale of [0.9 - Number.EPSILON, 1.4 + Number.EPSILON, 0, -1, NaN, Infinity, -Infinity, '1', null]) {
      assert.equal(parsePreferences({ textScale }), null)
    }
  })

  it('allows unset module choices and validates both scalar choices', () => {
    for (const key of ['defaultModuleName', 'commentaryModuleName']) {
      for (const value of [null, 'WEB', 'x'.repeat(128)]) {
        assert.deepEqual(parsePreferences({ [key]: value }), { [key]: value })
      }
      for (const value of ['', '_WEB', 'x'.repeat(129), 1, false, [], undefined]) {
        assert.equal(parsePreferences({ [key]: value }), null, key)
      }
    }
  })

  it('validates comparison-list bounds and every entry including the last', () => {
    for (const compareModuleNames of [null, [], ['WEB', 'KJV'], Array<string>(128).fill('WEB')]) {
      assert.deepEqual(parsePreferences({ compareModuleNames }), { compareModuleNames })
    }
    for (const compareModuleNames of ['WEB', {}, 1, Array<string>(129).fill('WEB'), ['WEB', ''],
      [...Array<string>(127).fill('WEB'), '../KJV']]) {
      assert.equal(parsePreferences({ compareModuleNames }), null)
    }
  })

  it('round-trips a complete preferences object and rejects an invalid field among valid fields', () => {
    const preferences = {
      theme: 'ink', accent: '#a1B2c3', textScale: 1.2,
      ...Object.fromEntries(booleanPreferences.map((key, index) => [key, index % 2 === 0])),
      defaultModuleName: 'WEB', compareModuleNames: ['WEB', 'KJV'], commentaryModuleName: null
    }
    assert.deepEqual(parsePreferences(preferences), preferences)
    assert.equal(parsePreferences({ ...preferences, textScale: '1.2' }), null)
  })

  it('validates the timestamped preference envelope and strips only unknown inner fields', () => {
    for (const updated_at of [0, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(parseUserPreferences({ preferences: {}, updated_at }), { preferences: {}, updated_at })
      assert.deepEqual(parseUserPreferences({ preferences: { theme: 'ink', future: true }, updated_at }), {
        preferences: { theme: 'ink' }, updated_at
      })
    }
    for (const value of [null, undefined, [], {}, { preferences: {} }, { updated_at: 0 },
      { preferences: null, updated_at: 0 }, { preferences: { theme: 'dark' }, updated_at: 0 },
      { preferences: {}, updated_at: 0, future: true }]) assert.equal(parseUserPreferences(value), null)
    for (const updated_at of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined]) {
      assert.equal(parseUserPreferences({ preferences: {}, updated_at }), null)
    }
  })
})
