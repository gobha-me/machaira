import { describe, expect, it } from 'vitest'
import { pathologicalModule } from '../test/fixtures/moduleInfo'
import { catalogSearchText } from './library'

describe('Library catalog discovery', () => {
  it('adds both canon aliases to every audited Deuterocanon module', () => {
    const text = catalogSearchText({
      ...pathologicalModule,
      name: 'OpaqueModuleCode',
      description: 'An edition whose repository metadata has no canon keyword',
      about: undefined,
      tradition: undefined
    })
    expect(text).toContain('apocrypha')
    expect(text).toContain('deuterocanon')
    expect(text).toContain('tob')
  })
})
