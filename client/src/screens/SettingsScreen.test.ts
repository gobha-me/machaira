// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type DiscoveredModel, type ProviderDiscoveryResult } from '../services/api'
import SettingsScreen from './SettingsScreen.vue'

vi.mock('../services/db', () => ({
  exportAll: vi.fn(),
  legacyImportComplete: vi.fn(() => false),
  legacyPersonalData: vi.fn(async () => ({ notes: [], highlights: [] })),
  markLegacyImportComplete: vi.fn()
}))

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

function discoveredModel(id: string, name: string): DiscoveredModel {
  return { id, name, compatibility: 'confirmed', capabilities: ['tts'] }
}

function discoveryResult(
  models: DiscoveredModel[],
  voices: { id: string; name: string }[]
): ProviderDiscoveryResult {
  return {
    supported: true,
    source: 'venice',
    cached: false,
    fetchedAt: 1,
    truncated: false,
    models,
    voices
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function mountSettings(): Promise<VueWrapper> {
  const pinia = createPinia()
  const wrapper = mount(SettingsScreen, { global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

async function selectOpenOption(wrapper: VueWrapper, inputId: string, query: string): Promise<void> {
  const input = wrapper.get(inputId)
  await input.trigger('focus')
  await input.setValue(query)
  const option = wrapper.findAll('[role="option"]').find((candidate) => candidate.text().includes(query))
  expect(option, `expected a discovery option matching ${query}`).toBeDefined()
  await option!.trigger('mousedown')
}

describe('Settings provider controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    vi.spyOn(api, 'deploymentProviders').mockResolvedValue({})
  })

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

  it('searches and selects discovered cloud voices while local voices remain manual', async () => {
    const discover = vi.spyOn(api, 'discoverProvider').mockResolvedValue(discoveryResult(
      [discoveredModel('tts-kokoro', 'Kokoro')],
      [
        { id: 'af_sky', name: 'Sky' },
        { id: 'am_adam', name: 'Adam' }
      ]
    ))
    const wrapper = await mountSettings()

    const localVoice = wrapper.get('#tts-local-voice')
    expect(localVoice.element.closest('.provider-field')?.textContent).toContain('Enter a voice ID manually')
    await localVoice.setValue('local-custom')
    await localVoice.trigger('blur')
    expect((localVoice.element as HTMLInputElement).value).toBe('local-custom')
    expect(discover).not.toHaveBeenCalled()

    await wrapper.get('#tts-cloud-discovery').trigger('click')
    await flushPromises()
    const cloudVoice = wrapper.get('#tts-cloud-voice')
    expect(cloudVoice.element.closest('.provider-field')?.textContent).toContain('search provider voices by name or ID')
    await cloudVoice.trigger('focus')
    await cloudVoice.setValue('ADAM')
    const options = wrapper.findAll('[role="option"]')
    expect(options).toHaveLength(1)
    expect(options[0]!.text()).toContain('am_adam')
    await options[0]!.trigger('mousedown')
    expect((cloudVoice.element as HTMLInputElement).value).toBe('am_adam')
  })

  it('keeps the current model and voice when older model-specific discovery finishes last', async () => {
    const modelA = deferred<ProviderDiscoveryResult>()
    const modelB = deferred<ProviderDiscoveryResult>()
    const discover = vi.spyOn(api, 'discoverProvider')
      .mockResolvedValueOnce(discoveryResult([
        discoveredModel('model-a', 'Model A'),
        discoveredModel('model-b', 'Model B')
      ], [{ id: 'voice-initial', name: 'Initial' }]))
      .mockImplementation((input) => {
        if (input.model === 'model-a') return modelA.promise
        if (input.model === 'model-b') return modelB.promise
        throw new Error(`Unexpected model ${input.model}`)
      })
    const wrapper = await mountSettings()

    await wrapper.get('#tts-cloud-discovery').trigger('click')
    await flushPromises()
    await selectOpenOption(wrapper, '#tts-cloud-model', 'Model A')
    await selectOpenOption(wrapper, '#tts-cloud-model', 'Model B')

    modelB.resolve(discoveryResult([
      discoveredModel('model-a', 'Model A'),
      discoveredModel('model-b', 'Model B')
    ], [{ id: 'voice-b', name: 'Voice B' }]))
    await flushPromises()
    expect((wrapper.get('#tts-cloud-model').element as HTMLInputElement).value).toBe('model-b')

    modelA.resolve(discoveryResult([
      discoveredModel('model-a', 'Model A'),
      discoveredModel('model-b', 'Model B')
    ], [{ id: 'voice-a', name: 'Voice A' }]))
    await flushPromises()

    const cloudVoice = wrapper.get('#tts-cloud-voice')
    expect((cloudVoice.element as HTMLInputElement).value).toBe('af_sky')
    await cloudVoice.trigger('focus')
    expect(wrapper.findAll('[role="option"]').map((option) => option.text())).toEqual(['Voice Bvoice-b'])
    expect(cloudVoice.element.closest('.discovery-combobox')?.querySelector('.stale')?.textContent)
      .toContain('will be preserved')
    expect(discover.mock.calls.map(([input]) => input.model)).toEqual(['tts-kokoro', 'model-a', 'model-b'])
  })

  it('keeps an empty discovered voice catalog usable through manual entry', async () => {
    vi.spyOn(api, 'discoverProvider').mockResolvedValue(discoveryResult(
      [discoveredModel('tts-kokoro', 'Kokoro')], []
    ))
    const wrapper = await mountSettings()

    await wrapper.get('#tts-cloud-discovery').trigger('click')
    await flushPromises()
    const cloudVoice = wrapper.get('#tts-cloud-voice')
    expect(cloudVoice.element.closest('.provider-field')?.textContent).toContain('did not report any voices')
    await cloudVoice.setValue('manual-cloud-voice')
    await cloudVoice.trigger('blur')
    expect((cloudVoice.element as HTMLInputElement).value).toBe('manual-cloud-voice')
    expect(cloudVoice.element.closest('.discovery-combobox')?.querySelector('.stale')?.textContent)
      .toContain('will be preserved')
  })
})
