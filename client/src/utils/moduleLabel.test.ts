import { describe, expect, it } from 'vitest'
import { moduleLabel } from './moduleLabel'

describe('module display labels', () => {
  it.each(['enggnv1599eb', 'Geneva1599'])('labels the opaque Geneva catalog ID %s', (name) => {
    expect(moduleLabel({ name, description: '', abbreviation: '' })).toBe('Geneva 1599')
  })

  it('keeps LSV recognizable even with a long catalog description', () => {
    expect(moduleLabel({ name: 'LSV', description: 'Literal Standard Version' })).toBe('LSV')
  })

  it('handles missing and blank metadata without inventing a translation name', () => {
    expect(moduleLabel({ name: 'engTranslation', description: 'Full name', abbreviation: ' Short ' })).toBe('Short')
    expect(moduleLabel({ name: 'engTranslation', description: ' Full name ', abbreviation: '  ' })).toBe('Full name')
    expect(moduleLabel({ name: 'engTranslation', description: '  ' })).toBe('engTranslation')
    expect(moduleLabel({ name: 'constructor', description: '' })).toBe('constructor')
  })
})
