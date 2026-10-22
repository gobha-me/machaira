// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CrossReferencesPanel from './CrossReferencesPanel.vue'
import ConnectionsGraph from './ConnectionsGraph.vue'

const target = { book: 'John', chapter: 1, verseStart: 1, verseEnd: 3 }
const base = { moduleName: 'LSV', refLabel: 'Genesis 1:1', emptyReason: 'No references available.' }

describe('cross-reference surfaces', () => {
  for (const variant of ['rail', 'page'] as const) {
    it(`shows attribution and resolved navigation in the ${variant} surface while preserving unparsed authored notes`, async () => {
      const wrapper = mount(CrossReferencesPanel, { props: {
        ...base, variant, entries: [
          { verse: 1, text: 'John 1:1–3', target, votes: 383 },
          { verse: 1, text: '<script>unsafe shorthand</script>' }
        ]
      } })
      expect(wrapper.get('a[href="https://www.openbible.info/labs/cross-references/"]').text()).toBe('OpenBible.info')
      expect(wrapper.get('a[href="https://creativecommons.org/licenses/by/4.0/"]').text()).toBe('CC BY 4.0')
      expect(wrapper.get('.xref-link').text()).toContain('383 votes')
      await wrapper.get('.xref-link').trigger('click')
      expect(wrapper.emitted('open-reference')).toEqual([[target]])
      expect(wrapper.find('script').exists()).toBe(false)
      expect(wrapper.findAll('.xref-entry button')).toHaveLength(1)
      wrapper.unmount()
    })
  }

  it('keeps an empty or unselected passage honest and never emits a navigation event', async () => {
    const wrapper = mount(CrossReferencesPanel, { props: { ...base, entries: [] } })
    expect(wrapper.text()).toContain('No references available.')
    expect(wrapper.find('.xref-link').exists()).toBe(false)
    expect(wrapper.emitted('open-reference')).toBeUndefined()
    await wrapper.setProps({ refLabel: '' })
    expect(wrapper.text()).toContain('Select a passage')
    expect(wrapper.text()).toContain('OpenBible.info')
    wrapper.unmount()
  })

  it('shows attribution in the Journal graph even when no target is available', () => {
    const wrapper = mount(ConnectionsGraph, { props: { selectedId: null, payload: {
      nodes: [], edges: [], semanticState: 'unavailable', warnings: [],
      crossReferenceAttribution: {
        name: 'OpenBible.info', url: 'https://www.openbible.info/labs/cross-references/',
        license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', changes: 'Mapped'
      }
    } } })
    expect(wrapper.text()).toContain('OpenBible.info')
    expect(wrapper.get('button.cross').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
