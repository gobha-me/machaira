import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ProviderSecretInput from './ProviderSecretInput.vue'

describe('ProviderSecretInput', () => {
  it('renders a masked, autofill-resistant secret with an accessible reveal control', async () => {
    const app = createSSRApp({
      render: () => h(ProviderSecretInput, {
        id: 'provider-api-key',
        modelValue: 'staged-secret',
        label: 'Provider API key',
        placeholder: 'API key'
      })
    })

    const html = await renderToString(app)

    expect(html).toContain('id="provider-api-key"')
    expect(html).toContain('name="provider-api-key"')
    expect(html).toContain('type="password"')
    expect(html).toContain('autocomplete="new-password"')
    expect(html).toContain('data-1p-ignore="true"')
    expect(html).toContain('data-bwignore="true"')
    expect(html).toContain('data-lpignore="true"')
    expect(html).toContain('aria-controls="provider-api-key"')
    expect(html).toContain('aria-label="Show Provider API key"')
    expect(html).toContain('aria-pressed="false"')
  })
})
