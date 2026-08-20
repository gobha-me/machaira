import type { MachairaDatabase } from './database.js'
import type { SecretStore } from './secrets.js'
import {
  VoiceConfigError,
  limitedProviderError,
  parseVoiceOrder,
  voiceEndpoint,
  voiceProviderUrl,
  voiceString,
  type VoiceTier
} from './voice-providers.js'

export type TtsTier = VoiceTier
export type TtsProviderKind = 'openai-compatible' | 'venice'

export interface TtsEndpointConfig {
  provider: TtsProviderKind
  baseUrl: string
  model: string
  voice: string
  hasApiKey: boolean
}

export interface TtsConfig {
  order: TtsTier[]
  local: TtsEndpointConfig | null
  cloud: TtsEndpointConfig | null
}

interface StoredTtsConfig {
  provider_order_json: string
  local_provider: TtsProviderKind | null
  local_base_url: string | null
  local_model: string | null
  local_voice: string | null
  cloud_provider: TtsProviderKind | null
  cloud_base_url: string | null
  cloud_model: string | null
  cloud_voice: string | null
}

interface EndpointInput {
  provider: TtsProviderKind
  baseUrl: string
  model: string
  voice: string
  apiKey?: string
  clearApiKey: boolean
}

const PROVIDERS = new Set<TtsProviderKind>(['openai-compatible', 'venice'])
const LOCAL_KEY = 'tts-local-api-key'
const CLOUD_KEY = 'tts-cloud-api-key'
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

export const TtsInputError = VoiceConfigError
export class TtsProviderError extends Error {}

function parseEndpoint(value: unknown, tier: 'local' | 'cloud'): EndpointInput | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TtsInputError(`${tier === 'local' ? 'Local' : 'Cloud'} provider is invalid`)
  }
  const input = value as Record<string, unknown>
  if (typeof input.provider !== 'string' || !PROVIDERS.has(input.provider as TtsProviderKind)) {
    throw new TtsInputError('TTS provider is invalid')
  }
  const provider = input.provider as TtsProviderKind
  if (tier === 'local' && provider !== 'openai-compatible') {
    throw new TtsInputError('Local TTS must use an OpenAI-compatible endpoint')
  }
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') {
    throw new TtsInputError('clearApiKey must be a boolean')
  }
  const apiKey = input.apiKey === undefined
    ? undefined
    : voiceString(input.apiKey, 'API key', 4096)
  if (apiKey !== undefined && input.clearApiKey === true) {
    throw new TtsInputError('Cannot replace and clear the API key together')
  }
  return {
    provider,
    baseUrl: voiceProviderUrl(input.baseUrl),
    model: voiceString(input.model, 'TTS model', 200),
    voice: voiceString(input.voice, 'TTS voice', 200),
    apiKey,
    clearApiKey: input.clearApiKey === true
  }
}

function storedEndpoint(
  row: StoredTtsConfig,
  tier: 'local' | 'cloud',
  hasApiKey: boolean
): TtsEndpointConfig | null {
  const provider = row[`${tier}_provider`]
  const baseUrl = row[`${tier}_base_url`]
  const model = row[`${tier}_model`]
  const voice = row[`${tier}_voice`]
  if (!provider || !baseUrl || !model || !voice) return null
  return { provider, baseUrl, model, voice, hasApiKey }
}

async function limitedAudio(response: Response): Promise<Buffer> {
  if (!response.body) throw new TtsProviderError('TTS provider returned empty audio')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_AUDIO_BYTES) throw new TtsProviderError('TTS provider returned oversized audio')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (!size) throw new TtsProviderError('TTS provider returned empty audio')
  return Buffer.concat(chunks, size)
}

export class TtsService {
  constructor(
    private readonly db: MachairaDatabase,
    private readonly secrets: SecretStore
  ) {}

  get(userId: string): TtsConfig {
    const row = this.db.prepare(`
      SELECT provider_order_json,
        local_provider, local_base_url, local_model, local_voice,
        cloud_provider, cloud_base_url, cloud_model, cloud_voice
      FROM tts_configs WHERE user_id = ?
    `).get(userId) as StoredTtsConfig | undefined
    if (!row) return { order: ['browser'], local: null, cloud: null }
    let order: TtsTier[] = ['browser']
    try {
      order = parseVoiceOrder(JSON.parse(row.provider_order_json))
    } catch {
      // A corrupt preference must not accidentally enable a remote provider.
    }
    return {
      order,
      local: storedEndpoint(row, 'local', this.secrets.has(userId, LOCAL_KEY)),
      cloud: storedEndpoint(row, 'cloud', this.secrets.has(userId, CLOUD_KEY))
    }
  }

  save(userId: string, value: unknown): TtsConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TtsInputError('TTS configuration is required')
    }
    const input = value as Record<string, unknown>
    const order = parseVoiceOrder(input.order)
    const local = parseEndpoint(input.local, 'local')
    const cloud = parseEndpoint(input.cloud, 'cloud')
    if (order.includes('local') && !local) {
      throw new TtsInputError('Configure the local provider before enabling it')
    }
    if (order.includes('cloud') && !cloud) {
      throw new TtsInputError('Configure the cloud provider before enabling it')
    }
    const existing = this.get(userId)
    const localIdentityUnchanged = !!local
      && local.provider === existing.local?.provider
      && local.baseUrl === existing.local.baseUrl
    const cloudIdentityUnchanged = !!cloud
      && cloud.provider === existing.cloud?.provider
      && cloud.baseUrl === existing.cloud.baseUrl
    const cloudWillHaveKey = cloud && (
      cloud.apiKey !== undefined
      || (!cloud.clearApiKey && cloudIdentityUnchanged && existing.cloud?.hasApiKey === true)
    )
    if (cloud && !cloudWillHaveKey) {
      throw new TtsInputError('An API key is required for the cloud provider')
    }

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO tts_configs (
          user_id, provider_order_json,
          local_provider, local_base_url, local_model, local_voice,
          cloud_provider, cloud_base_url, cloud_model, cloud_voice, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          provider_order_json = excluded.provider_order_json,
          local_provider = excluded.local_provider,
          local_base_url = excluded.local_base_url,
          local_model = excluded.local_model,
          local_voice = excluded.local_voice,
          cloud_provider = excluded.cloud_provider,
          cloud_base_url = excluded.cloud_base_url,
          cloud_model = excluded.cloud_model,
          cloud_voice = excluded.cloud_voice,
          updated_at = excluded.updated_at
      `).run(
        userId, JSON.stringify(order),
        local?.provider ?? null, local?.baseUrl ?? null, local?.model ?? null, local?.voice ?? null,
        cloud?.provider ?? null, cloud?.baseUrl ?? null, cloud?.model ?? null, cloud?.voice ?? null,
        Date.now()
      )
      this.updateSecret(userId, LOCAL_KEY, local, localIdentityUnchanged)
      this.updateSecret(userId, CLOUD_KEY, cloud, cloudIdentityUnchanged)
    })()
    return this.get(userId)
  }

  private updateSecret(
    userId: string,
    name: string,
    config: EndpointInput | null,
    identityUnchanged: boolean
  ): void {
    if (!config || config.clearApiKey || !identityUnchanged) this.secrets.remove(userId, name)
    if (config?.apiKey !== undefined) this.secrets.set(userId, name, config.apiKey)
  }

  async speech(
    userId: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<{ audio: Buffer; contentType: string }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TtsInputError('Speech request is required')
    }
    const body = input as Record<string, unknown>
    if (body.provider !== 'local' && body.provider !== 'cloud') {
      throw new TtsInputError('Speech provider must be local or cloud')
    }
    const tier = body.provider
    const text = voiceString(body.text, 'Speech text', 4096)
    const config = this.get(userId)
    if (!config.order.includes(tier)) throw new TtsInputError(`${tier} TTS is not enabled`)
    const selected = config[tier]
    if (!selected) throw new TtsInputError(`${tier} TTS is not configured`)
    const apiKey = this.secrets.get(userId, tier === 'local' ? LOCAL_KEY : CLOUD_KEY)
    if (tier === 'cloud' && !apiKey) throw new TtsInputError('The cloud TTS provider needs an API key')

    const timeoutSignal = AbortSignal.timeout(60_000)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const headers: Record<string, string> = {
      accept: 'audio/mpeg',
      'content-type': 'application/json'
    }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    let response: Response
    try {
      response = await fetch(voiceEndpoint(selected.baseUrl, 'audio/speech'), {
        method: 'POST',
        redirect: 'error',
        signal: combinedSignal,
        headers,
        body: JSON.stringify({
          model: selected.model,
          voice: selected.voice,
          input: text,
          response_format: 'mp3',
          speed: 1
        })
      })
    } catch (error) {
      if (combinedSignal.aborted) throw new TtsProviderError('TTS request timed out or was cancelled')
      throw new TtsProviderError(`Could not reach TTS provider: ${(error as Error).message}`)
    }
    if (!response.ok) {
      throw new TtsProviderError(`TTS provider rejected the request (${response.status}): ${await limitedProviderError(response)}`)
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
    if (!contentType.startsWith('audio/')) {
      throw new TtsProviderError('TTS provider did not return audio')
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new TtsProviderError('TTS provider returned oversized audio')
    }
    const audio = await limitedAudio(response)
    return { audio, contentType }
  }
}
