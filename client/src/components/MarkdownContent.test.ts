// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownContent from './MarkdownContent.vue'

describe('MarkdownContent', () => {
  it('reacts cleanly as streamed source text grows', async () => {
    const wrapper = mount(MarkdownContent, { props: { source: 'An opening thought' } })
    expect(wrapper.text()).toBe('An opening thought')
    expect(wrapper.findAll('li')).toHaveLength(0)

    await wrapper.setProps({ source: 'An opening thought\n\n- first point\n- second point' })

    expect(wrapper.text()).toContain('An opening thought')
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['first point', 'second point'])
    expect(wrapper.findAll('p')).toHaveLength(1)
  })

  it('emits a canonical target from an activated generated reference link', async () => {
    const wrapper = mount(MarkdownContent, {
      props: { source: 'Compare 1 Cor 13:4-7.', scriptureLinks: true }
    })

    await wrapper.get('a.scripture-reference').trigger('click')

    expect(wrapper.emitted('open-scripture')).toEqual([[
      { book: '1Cor', chapter: 13, verseStart: 4, verseEnd: 7 }
    ]])
  })
})
