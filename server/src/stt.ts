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

export type SttTier = VoiceTier
export type SttProviderKind = 'openai-compatible' | 'venice'

export interface SttEndpointConfig {
  provider: SttProviderKind
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface SttConfig {
  order: SttTier[]
  local: SttEndpointConfig | null
  cloud: SttEndpointConfig | null
}

interface StoredSttConfig {
  provider_order_json: string
  local_provider: SttProviderKind | null
  local_base_url: string | null
  local_model: string | null
  cloud_provider: SttProviderKind | null
  cloud_base_url: string | null
  cloud_model: string | null
}

interface EndpointInput {
  provider: SttProviderKind
  baseUrl: string
  model: string
  apiKey?: string
  clearApiKey: boolean
}

const PROVIDERS = new Set<SttProviderKind>(['openai-compatible', 'venice'])
const LOCAL_KEY = 'stt-local-api-key'
const CLOUD_KEY = 'stt-cloud-api-key'
const MAX_RESPONSE_BYTES = 256 * 1024

export { VoiceConfigError as SttInputError }
export class SttProviderError extends Error {}
export class SttBusyError extends Error {}

function parseEndpoint(value: unknown, tier: 'local' | 'cloud'): EndpointInput | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceConfigError(`${tier === 'local' ? 'Local' : 'Cloud'} provider is invalid`)
  }
  const input = value as Record<string, unknown>
  if (typeof input.provider !== 'string' || !PROVIDERS.has(input.provider as SttProviderKind)) {
    throw new VoiceConfigError('STT provider is invalid')
  }
  const provider = input.provider as SttProviderKind
  if (tier === 'local' && provider !== 'openai-compatible') {
    throw new VoiceConfigError('Local STT must use an OpenAI-compatible endpoint')
  }
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') {
    throw new VoiceConfigError('clearApiKey must be a boolean')
  }
  const apiKey = input.apiKey === undefined
    ? undefined
    : voiceString(input.apiKey, 'API key', 4096)
  if (apiKey !== undefined && input.clearApiKey === true) {
    throw new VoiceConfigError('Cannot replace and clear the API key together')
  }
  return {
    provider,
    baseUrl: voiceProviderUrl(input.baseUrl),
    model: voiceString(input.model, 'STT model', 200),
    apiKey,
    clearApiKey: input.clearApiKey === true
  }
}

function storedEndpoint(
  row: StoredSttConfig,
  tier: 'local' | 'cloud',
  hasApiKey: boolean
): SttEndpointConfig | null {
  const provider = row[`${tier}_provider`]
  const baseUrl = row[`${tier}_base_url`]
  const model = row[`${tier}_model`]
  if (!provider || !baseUrl || !model) return null
  return { provider, baseUrl, model, hasApiKey }
}

async function limitedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new SttProviderError('STT provider returned an oversized response')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export class SttService {
  private readonly activeUsers = new Set<string>()
  private activeLocal = 0
  private activeCloud = 0

  constructor(
    private readonly db: MachairaDatabase,
    private readonly secrets: SecretStore
  ) {}

  get(userId: string): SttConfig {
    const row = this.db.prepare(`
      SELECT provider_order_json,
        local_provider, local_base_url, local_model,
        cloud_provider, cloud_base_url, cloud_model
      FROM stt_configs WHERE user_id = ?
    `).get(userId) as StoredSttConfig | undefined
    if (!row) return { order: ['browser'], local: null, cloud: null }
    let order: SttTier[] = ['browser']
    try {
      order = parseVoiceOrder(JSON.parse(row.provider_order_json))
    } catch {
      // Corrupt state must never opt a user into remote microphone processing.
    }
    return {
      order,
      local: storedEndpoint(row, 'local', this.secrets.has(userId, LOCAL_KEY)),
      cloud: storedEndpoint(row, 'cloud', this.secrets.has(userId, CLOUD_KEY))
    }
  }

  save(userId: string, value: unknown): SttConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new VoiceConfigError('STT configuration is required')
    }
    const input = value as Record<string, unknown>
    const order = parseVoiceOrder(input.order)
    const local = parseEndpoint(input.local, 'local')
    const cloud = parseEndpoint(input.cloud, 'cloud')
    if (order.includes('local') && !local) {
      throw new VoiceConfigError('Configure the local provider before enabling it')
    }
    if (order.includes('cloud') && !cloud) {
      throw new VoiceConfigError('Configure the cloud provider before enabling it')
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
      throw new VoiceConfigError('An API key is required for the cloud provider')
    }

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO stt_configs (
          user_id, provider_order_json,
          local_provider, local_base_url, local_model,
          cloud_provider, cloud_base_url, cloud_model, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          provider_order_json = excluded.provider_order_json,
          local_provider = excluded.local_provider,
          local_base_url = excluded.local_base_url,
          local_model = excluded.local_model,
          cloud_provider = excluded.cloud_provider,
          cloud_base_url = excluded.cloud_base_url,
          cloud_model = excluded.cloud_model,
          updated_at = excluded.updated_at
      `).run(
        userId, JSON.stringify(order),
        local?.provider ?? null, local?.baseUrl ?? null, local?.model ?? null,
        cloud?.provider ?? null, cloud?.baseUrl ?? null, cloud?.model ?? null,
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

  private resolvedEndpoint(
    userId: string,
    tier: 'local' | 'cloud',
    staged?: unknown
  ): { endpoint: SttEndpointConfig; apiKey: string | null } {
    const saved = this.get(userId)[tier]
    if (staged === undefined) {
      if (!saved) throw new VoiceConfigError(`${tier} STT is not configured`)
      return {
        endpoint: saved,
        apiKey: this.secrets.get(userId, tier === 'local' ? LOCAL_KEY : CLOUD_KEY)
      }
    }
    const parsed = parseEndpoint(staged, tier)
    if (!parsed) throw new VoiceConfigError(`${tier} STT is not configured`)
    const identityUnchanged = parsed.provider === saved?.provider && parsed.baseUrl === saved.baseUrl
    const storedKey = identityUnchanged
      ? this.secrets.get(userId, tier === 'local' ? LOCAL_KEY : CLOUD_KEY)
      : null
    return {
      endpoint: { ...parsed, hasApiKey: parsed.apiKey !== undefined || !!storedKey },
      apiKey: parsed.apiKey ?? storedKey
    }
  }

  async check(userId: string, value: unknown, signal?: AbortSignal): Promise<{
    ok: true
    modelAvailable: boolean | null
    message: string
  }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new VoiceConfigError('Connection check is required')
    }
    const input = value as Record<string, unknown>
    if (input.tier !== 'local' && input.tier !== 'cloud') {
      throw new VoiceConfigError('Connection tier must be local or cloud')
    }
    const tier = input.tier
    const selected = this.resolvedEndpoint(userId, tier, input.endpoint)
    if (tier === 'cloud' && !selected.apiKey) {
      throw new VoiceConfigError('The cloud STT provider needs an API key')
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    if (selected.apiKey) headers.authorization = `Bearer ${selected.apiKey}`
    const timeout = AbortSignal.timeout(10_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(voiceEndpoint(selected.endpoint.baseUrl, 'models'), {
        headers, redirect: 'error', signal: combined
      })
    } catch (error) {
      if (combined.aborted) throw new SttProviderError('STT connection check timed out or was cancelled')
      throw new SttProviderError(`Could not reach STT provider: ${(error as Error).message}`)
    }
    if (!response.ok) {
      throw new SttProviderError(
        `STT provider rejected the connection check (${response.status}): ${await limitedProviderError(response)}`
      )
    }
    const raw = await limitedText(response)
    let modelAvailable: boolean | null = null
    try {
      const payload = JSON.parse(raw) as { data?: { id?: unknown }[] }
      if (Array.isArray(payload.data)) {
        modelAvailable = payload.data.some((model) => model.id === selected.endpoint.model)
      }
    } catch {
      // Some compatible endpoints expose a healthful but non-OpenAI model listing.
    }
    return {
      ok: true,
      modelAvailable,
      message: modelAvailable === false
        ? 'Provider is reachable, but the configured model is not currently listed'
        : 'Provider is reachable'
    }
  }

  async transcribe(
    userId: string,
    tier: 'local' | 'cloud',
    audio: Buffer,
    signal?: AbortSignal
  ): Promise<string> {
    const config = this.get(userId)
    if (!config.order.includes(tier)) throw new VoiceConfigError(`${tier} STT is not enabled`)
    const selected = config[tier]
    if (!selected) throw new VoiceConfigError(`${tier} STT is not configured`)
    const apiKey = this.secrets.get(userId, tier === 'local' ? LOCAL_KEY : CLOUD_KEY)
    if (tier === 'cloud' && !apiKey) throw new VoiceConfigError('The cloud STT provider needs an API key')
    if (this.activeUsers.has(userId)) throw new SttBusyError('A transcription is already in progress')
    if (tier === 'local' && this.activeLocal >= 1) throw new SttBusyError('Local transcription is busy')
    if (tier === 'cloud' && this.activeCloud >= 4) throw new SttBusyError('Cloud transcription is busy')

    this.activeUsers.add(userId)
    if (tier === 'local') this.activeLocal += 1
    else this.activeCloud += 1
    try {
      const form = new FormData()
      form.set('model', selected.model)
      form.set('response_format', 'json')
      form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'recording.wav')
      const headers: Record<string, string> = { accept: 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      const timeout = AbortSignal.timeout(tier === 'local' ? 300_000 : 120_000)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      let response: Response
      try {
        response = await fetch(voiceEndpoint(selected.baseUrl, 'audio/transcriptions'), {
          method: 'POST', headers, body: form, redirect: 'error', signal: combined
        })
      } catch (error) {
        if (combined.aborted) throw new SttProviderError('STT request timed out or was cancelled')
        throw new SttProviderError(`Could not reach STT provider: ${(error as Error).message}`)
      }
      if (!response.ok) {
        throw new SttProviderError(
          `STT provider rejected the request (${response.status}): ${await limitedProviderError(response)}`
        )
      }
      const raw = await limitedText(response)
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new SttProviderError('STT provider returned malformed JSON')
      }
      const text = (payload as { text?: unknown })?.text
      if (typeof text !== 'string' || !text.trim()) {
        throw new SttProviderError('STT provider returned an empty transcript')
      }
      return text.trim()
    } finally {
      this.activeUsers.delete(userId)
      if (tier === 'local') this.activeLocal -= 1
      else this.activeCloud -= 1
    }
  }
}
