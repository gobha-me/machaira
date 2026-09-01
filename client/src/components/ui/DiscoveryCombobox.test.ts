// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import DiscoveryCombobox from './DiscoveryCombobox.vue'
import { filterDiscoveryChoices, isStaleDiscoveryChoice, type DiscoveryChoice } from './discoveryChoices'

const choices: DiscoveryChoice[] = [
  { id: 'unknown-model', name: 'Unknown Model', meta: 'owner-b', compatibility: 'unknown' },
  { id: 'confirmed-z', name: 'Zulu', meta: 'private', compatibility: 'confirmed' },
  { id: 'confirmed-a', name: 'Alpha', meta: '1M context', compatibility: 'confirmed' }
]

const voices: DiscoveryChoice[] = [
  { id: 'af_sky', name: 'Sky', compatibility: 'confirmed' },
  { id: 'af_heart', name: 'Heart', compatibility: 'confirmed' },
  { id: 'am_adam', name: 'Adam', compatibility: 'confirmed' }
]

function mountHarness(options = voices, loaded = true) {
  const committed = vi.fn()
  const harness = defineComponent({
    components: { DiscoveryCombobox },
    setup() {
      const value = ref('af_sky')
      return { committed, loaded, options, value }
    },
    template: `
      <DiscoveryCombobox
        id="tts-voice"
        v-model="value"
        :options="options"
        :loaded="loaded"
        label="TTS voice"
        @commit="committed"
      />
    `
  })
  return { committed, wrapper: mount(harness) }
}

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

  it('filters voices by display name and ID and selects with the keyboard', async () => {
    const { wrapper } = mountHarness()
    const input = wrapper.get('input')

    await input.trigger('focus')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3)
    expect(input.attributes('aria-expanded')).toBe('true')
    expect((input.element as HTMLInputElement).selectionStart).toBe(0)
    expect((input.element as HTMLInputElement).selectionEnd).toBe('af_sky'.length)

    await input.setValue('ADAM')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(wrapper.get('[role="option"]').text()).toContain('Adam')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.attributes('aria-activedescendant')).toBe(wrapper.get('[role="option"]').attributes('id'))
    await input.trigger('keydown', { key: 'Enter' })
    expect((input.element as HTMLInputElement).value).toBe('am_adam')
    expect(input.attributes('aria-expanded')).toBe('false')

    await input.trigger('focus')
    await input.setValue('AF_HE')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(wrapper.get('[role="option"]').text()).toContain('af_heart')
  })

  it('supports pointer selection and commits manual IDs when discovery is empty', async () => {
    const discovered = mountHarness()
    const discoveredInput = discovered.wrapper.get('input')
    await discoveredInput.trigger('focus')
    await discoveredInput.setValue('heart')
    await discovered.wrapper.get('[role="option"]').trigger('mousedown')
    expect((discoveredInput.element as HTMLInputElement).value).toBe('af_heart')

    const manual = mountHarness([], false)
    const manualInput = manual.wrapper.get('input')
    expect(manual.wrapper.get('.toggle').attributes()).toHaveProperty('disabled')
    await manualInput.trigger('focus')
    expect((manualInput.element as HTMLInputElement).selectionStart).toBe(0)
    expect((manualInput.element as HTMLInputElement).selectionEnd).toBe('af_sky'.length)
    await manualInput.setValue('custom-voice')
    await manualInput.trigger('blur')
    expect(manual.committed).toHaveBeenCalledOnce()
    expect(manual.committed).toHaveBeenCalledWith('custom-voice')
    expect((manualInput.element as HTMLInputElement).value).toBe('custom-voice')
  })
})
