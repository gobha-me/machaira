// @vitest-environment happy-dom
// Focused behavioral a11y coverage avoids a repository-wide lint migration: existing
// prose gesture templates need a separate semantic rewrite. Keyboard activation,
// dynamic focus containment, and error recovery also require runtime assertions.
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import userEvent from '@testing-library/user-event'
import ModalDialog from './ModalDialog.vue'

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => {
  mounted.forEach((wrapper) => wrapper.unmount())
  mounted.length = 0
  document.body.innerHTML = ''
})

function setup(content = '<button id="first">Close</button><button disabled>Disabled</button><button hidden>Hidden</button><button style="display:none">Invisible</button><button id="last">Last</button>') {
  const host = mount(defineComponent({
    components: { ModalDialog },
    setup: () => ({ open: ref(false) }),
    template: `<button id="opener" @click="open = true">Open</button>
      <ModalDialog v-if="open" labelledby="title" @close="open = false">
        <article><h2 id="title">Details</h2>${content}</article>
      </ModalDialog>`
  }), { attachTo: document.body })
  mounted.push(host)
  return { host, user: userEvent.setup(), opener: host.get('#opener').element as HTMLButtonElement }
}

describe('modal keyboard and focus contract', () => {
  it('names the dialog, makes the background inert, wraps both Tab boundaries, and rejects outside focus', async () => {
    const { user, opener } = setup()
    await user.click(opener)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Details')
    expect(opener.parentElement?.getAttribute('inert')).toBe('')
    expect(opener.parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement?.id).toBe('first')
    await user.tab({ shift: true })
    expect(document.activeElement?.id).toBe('last')
    await user.tab()
    expect(document.activeElement?.id).toBe('first')
    await user.tab()
    expect(document.activeElement?.id).toBe('last')
    opener.focus()
    expect(dialog.contains(document.activeElement)).toBe(true)
    // Also guard programmatic focus into content appended after the modal opened.
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(document.activeElement?.id).toBe('first')
    await user.keyboard('{Escape}')
    await nextTick()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(opener.parentElement?.hasAttribute('inert')).toBe(false)
    expect(opener.parentElement?.hasAttribute('aria-hidden')).toBe(false)
    // Reopening must capture the invoker again and install exactly one focus trap.
    await user.keyboard('{Enter}')
    expect(document.activeElement?.id).toBe('first')
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(opener)
  })

  it('keeps focus inside when all controls are disabled or removed', async () => {
    const { user, opener } = setup('<button id="only" disabled>Only action</button>')
    await user.click(opener)
    await user.tab()
    const dialog = document.querySelector('[role="dialog"]')
    expect(document.activeElement).toBe(dialog)
    document.getElementById('only')!.remove()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(dialog)
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(opener)
  })

  it('closes only on the backdrop and restores existing background attributes on unmount', async () => {
    const background = document.createElement('div')
    background.setAttribute('inert', 'inert')
    background.setAttribute('aria-hidden', 'false')
    document.body.append(background)
    const { host, user, opener } = setup()
    await user.click(opener)
    await user.click(document.querySelector('article')!)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await user.click(document.querySelector('[role="dialog"]')!)
    expect(document.activeElement).toBe(opener)
    expect(background.getAttribute('inert')).toBe('inert')
    expect(background.getAttribute('aria-hidden')).toBe('false')
    await user.click(opener)
    opener.remove()
    host.unmount()
    expect(background.getAttribute('inert')).toBe('inert')
    expect(background.getAttribute('aria-hidden')).toBe('false')
    // A disposed trap must not redirect focus into the removed dialog.
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)
  })
})
