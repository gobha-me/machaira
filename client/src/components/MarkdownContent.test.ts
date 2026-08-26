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
})
