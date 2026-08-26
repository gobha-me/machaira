// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownEditor from './MarkdownEditor.vue'

describe('MarkdownEditor', () => {
  it('switches between source editing and preview without changing the source', async () => {
    const source = '# Grace\n\nOriginal **Markdown**.'
    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: { source }
    })
    const buttons = wrapper.findAll('.mode-toggle button')

    expect(wrapper.get('textarea').element.value).toBe(source)
    expect(buttons[0].attributes('aria-pressed')).toBe('true')

    await buttons[1].trigger('click')

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.get('[aria-label="Note preview"] h1').text()).toBe('Grace')
    expect(wrapper.get('[aria-label="Note preview"] strong').text()).toBe('Markdown')
    expect(wrapper.emitted('update:source')).toBeUndefined()

    await wrapper.findAll('.mode-toggle button')[0].trigger('click')
    expect(wrapper.get('textarea').element.value).toBe(source)
    expect(document.activeElement).toBe(wrapper.get('textarea').element)
    wrapper.unmount()
  })

  it('emits the exact edited Markdown and shows an honest empty preview', async () => {
    const wrapper = mount(MarkdownEditor, { props: { source: '' } })
    const edited = '## Heading\n\n- one\n- two'

    await wrapper.get('textarea').setValue(edited)
    expect(wrapper.emitted('update:source')).toEqual([[edited]])

    await wrapper.setProps({ source: edited })
    await wrapper.findAll('.mode-toggle button')[1].trigger('click')
    expect(wrapper.get('[aria-label="Note preview"] h2').text()).toBe('Heading')

    await wrapper.setProps({ source: '' })
    expect(wrapper.get('.preview-empty').text()).toBe('Nothing to preview yet.')
  })
})
