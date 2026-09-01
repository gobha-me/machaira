import { createPinia } from 'pinia'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import SettingsScreen from './SettingsScreen.vue'

const providerControlIds = [
  'tts-browser-priority',
  'tts-local-priority',
  'tts-local-base-url',
  'tts-local-model',
  'tts-local-voice',
  'tts-local-api-key',
  'tts-cloud-priority',
  'tts-cloud-provider',
  'tts-cloud-base-url',
  'tts-cloud-model',
  'tts-cloud-voice',
  'tts-cloud-api-key',
  'tts-remote-audio-cache-size',
  'stt-browser-priority',
  'stt-local-priority',
  'stt-local-base-url',
  'stt-local-model',
  'stt-local-api-key',
  'stt-cloud-priority',
  'stt-cloud-provider',
  'stt-cloud-base-url',
  'stt-cloud-model',
  'stt-cloud-api-key',
  'study-provider-kind',
  'study-provider-base-url',
  'study-provider-model',
  'study-provider-api-key',
  'embedding-provider-kind',
  'embedding-provider-base-url',
  'embedding-provider-model',
  'embedding-provider-batch-size',
  'embedding-provider-api-key'
]

const ordinaryAutofillTargets = [
  'tts-local-base-url',
  'tts-local-model',
  'tts-local-voice',
  'tts-cloud-base-url',
  'tts-cloud-model',
  'tts-cloud-voice',
  'stt-local-base-url',
  'stt-local-model',
  'stt-cloud-base-url',
  'stt-cloud-model',
  'study-provider-base-url',
  'study-provider-model',
  'embedding-provider-base-url',
  'embedding-provider-model'
]

const secretIds = [
  'tts-local-api-key',
  'tts-cloud-api-key',
  'stt-local-api-key',
  'stt-cloud-api-key',
  'study-provider-api-key',
  'embedding-provider-api-key'
]

function controlTag(html: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = html.match(new RegExp(`<(?:input|select)[^>]*\\sid="${escaped}"[^>]*>`, 'g')) ?? []
  expect(matches, `${id} should identify exactly one form control`).toHaveLength(1)
  return matches[0]!
}

describe('Settings provider controls', () => {
  it('associates every provider field with a visible label', async () => {
    const app = createSSRApp({ render: () => h(SettingsScreen) })
    app.use(createPinia())

    const html = await renderToString(app)

    for (const id of providerControlIds) {
      expect(controlTag(html, id)).toContain(`name="${id}"`)
      expect(html).toMatch(new RegExp(`<label[^>]*\\sfor="${id}"`))
    }
  })

  it('marks provider identifiers and secrets as non-login credentials', async () => {
    const app = createSSRApp({ render: () => h(SettingsScreen) })
    app.use(createPinia())

    const html = await renderToString(app)

    for (const id of ordinaryAutofillTargets) {
      const tag = controlTag(html, id)
      expect(tag).toContain('autocomplete="off"')
      expect(tag).toContain('data-1p-ignore="true"')
      expect(tag).toContain('data-bwignore="true"')
      expect(tag).toContain('data-lpignore="true"')
    }
    for (const id of secretIds) {
      const tag = controlTag(html, id)
      expect(tag).toContain('type="password"')
      expect(tag).toContain('autocomplete="new-password"')
      expect(html).toContain(`aria-controls="${id}"`)
    }
  })

  it('renders the bounded remote audio buffer control', async () => {
    const app = createSSRApp({ render: () => h(SettingsScreen) })
    app.use(createPinia())

    const html = await renderToString(app)
    const tag = controlTag(html, 'tts-remote-audio-cache-size')

    expect(tag).toContain('type="number"')
    expect(tag).toContain('min="3"')
    expect(tag).toContain('max="8"')
    expect(tag).toContain('step="1"')
    expect(html).toContain('Remote audio buffer')
  })
})
