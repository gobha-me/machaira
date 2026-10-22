// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import userEvent from '@testing-library/user-event'
import Toggle from './Toggle.vue'

afterEach(() => { document.body.innerHTML = '' })

describe('toggle keyboard boundaries', () => {
  it('accepts Space and Enter without submitting a form, and rejects activation when disabled', async () => {
    const wrapper = mount(Toggle, { props: { modelValue: false }, attachTo: document.body })
    const user = userEvent.setup()
    try {
      const control = wrapper.get('button')
      expect(control.attributes('type')).toBe('button')
      expect(control.attributes('role')).toBe('switch')
      expect(control.attributes('aria-checked')).toBe('false')
      await user.tab()
      expect(document.activeElement).toBe(control.element)
      await user.keyboard(' ')
      await user.keyboard('{Enter}')
      expect(wrapper.emitted('update:modelValue')).toEqual([[true], [true]])
      await wrapper.setProps({ modelValue: true, disabled: true })
      expect(control.attributes('aria-checked')).toBe('true')
      await user.click(control.element)
      await control.trigger('click')
      await user.keyboard(' {Enter}')
      expect(wrapper.emitted('update:modelValue')).toHaveLength(2)
    } finally {
      wrapper.unmount()
    }
  })
})
