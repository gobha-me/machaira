import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { pathologicalModule } from '../../test/fixtures/moduleInfo'
import SourceRow from './SourceRow.vue'

describe('SourceRow', () => {
  it.each([
    { installed: false, installing: false, progress: 0, action: 'Get' },
    { installed: true, installing: false, progress: 0, action: 'Remove' },
    { installed: false, installing: true, progress: 73, action: 'Installing 73%' }
  ])('keeps complete pathological metadata beside $action state', async (state) => {
    const app = createSSRApp({
      render: () => h(SourceRow, { module: pathologicalModule, last: true, ...state })
    })

    const html = await renderToString(app)

    expect(html).toContain(pathologicalModule.name)
    expect(html).toContain(pathologicalModule.description)
    expect(html).toContain(pathologicalModule.distributionLicense)
    expect(html).toContain(state.action)
  })
})
