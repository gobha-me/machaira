import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import DiscoveryCombobox from './DiscoveryCombobox.vue'
import { filterDiscoveryChoices, isStaleDiscoveryChoice, type DiscoveryChoice } from './discoveryChoices'

const choices: DiscoveryChoice[] = [
  { id: 'unknown-model', name: 'Unknown Model', meta: 'owner-b', compatibility: 'unknown' },
  { id: 'confirmed-z', name: 'Zulu', meta: 'private', compatibility: 'confirmed' },
  { id: 'confirmed-a', name: 'Alpha', meta: '1M context', compatibility: 'confirmed' }
]

describe('discovery choices', () => {
  it('searches IDs, names, and metadata while grouping confirmed choices first', () => {
    expect(filterDiscoveryChoices(choices, '').map((choice) => choice.id)).toEqual([
      'confirmed-a', 'confirmed-z', 'unknown-model'
    ])
    expect(filterDiscoveryChoices(choices, 'OWNER-B').map((choice) => choice.id)).toEqual(['unknown-model'])
    expect(filterDiscoveryChoices(choices, '1m').map((choice) => choice.id)).toEqual(['confirmed-a'])
  })

  it('preserves manual IDs and only marks them stale after a list was loaded', async () => {
    expect(isStaleDiscoveryChoice(choices, 'manual-new-model', false)).toBe(false)
    expect(isStaleDiscoveryChoice(choices, 'manual-new-model', true)).toBe(true)
    const app = createSSRApp({
      render: () => h(DiscoveryCombobox, {
        id: 'provider-model', modelValue: 'manual-new-model', options: choices, loaded: true, label: 'Model'
      })
    })
    const html = await renderToString(app)
    expect(html).toContain('value="manual-new-model"')
    expect(html).toContain('id="provider-model"')
    expect(html).toContain('name="provider-model"')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('data-1p-ignore="true"')
    expect(html).toContain('will be preserved')
  })
})
