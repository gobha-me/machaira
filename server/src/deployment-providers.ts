export type DeploymentProviderCapability = 'embeddings' | 'stt' | 'tts'
export type DeploymentProviderSource = 'bundled' | 'external'
export type DeploymentProviderReadinessState = 'ready' | 'starting' | 'unavailable' | 'unchecked'

export interface DeploymentProviderConfig {
  source: DeploymentProviderSource
  engine: string
  baseUrl: string
  model: string
  batchSize?: number
  voice?: string
}

export type DeploymentProviderConfigMap = Partial<Record<DeploymentProviderCapability, DeploymentProviderConfig>>

export interface DeploymentProviderDescriptor extends DeploymentProviderConfig {
  readiness: {
    state: DeploymentProviderReadinessState
    checkedAt: number | null
    message?: string
  }
}

export type DeploymentProviderDescriptorMap = Partial<Record<DeploymentProviderCapability, DeploymentProviderDescriptor>>

const CAPABILITIES = new Set<DeploymentProviderCapability>(['embeddings', 'stt', 'tts'])
const SOURCES = new Set<DeploymentProviderSource>(['bundled', 'external'])
const BUNDLED_ENGINES: Record<DeploymentProviderCapability, string> = {
  embeddings: 'ollama',
  stt: 'speaches',
  tts: 'kokoro'
}
const MAX_HEALTH_BYTES = 64 * 1024
const HEALTH_TIMEOUT_MS = 3_000
const HEALTH_CACHE_MS = 10_000

export class DeploymentProviderConfigError extends Error {}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DeploymentProviderConfigError(`${name} is required`)
  }
  const result = value.trim()
  if (result.length > max) throw new DeploymentProviderConfigError(`${name} is too long`)
  return result
}

function providerUrl(value: unknown, name: string): string {
  const raw = requiredString(value, name, 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DeploymentProviderConfigError(`${name} must be a valid HTTP or HTTPS URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new DeploymentProviderConfigError(`${name} must use HTTP or HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DeploymentProviderConfigError(`${name} cannot include credentials, a query, or a fragment`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function parseProvider(capability: DeploymentProviderCapability, value: unknown): DeploymentProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeploymentProviderConfigError(`${capability} provider must be an object`)
  }
  const input = value as Record<string, unknown>
  if (typeof input.source !== 'string' || !SOURCES.has(input.source as DeploymentProviderSource)) {
    throw new DeploymentProviderConfigError(`${capability} provider source must be bundled or external`)
  }
  const source = input.source as DeploymentProviderSource
  const engine = requiredString(input.engine, `${capability} provider engine`, 100)
  if (source === 'bundled' && engine !== BUNDLED_ENGINES[capability]) {
    throw new DeploymentProviderConfigError(
      `${capability} bundled provider engine must be ${BUNDLED_ENGINES[capability]}`
    )
  }
  const provider: DeploymentProviderConfig = {
    source,
    engine,
    baseUrl: providerUrl(input.baseUrl, `${capability} provider base URL`),
    model: requiredString(input.model, `${capability} provider model`, 200)
  }
  if (capability === 'embeddings') {
    if (!Number.isSafeInteger(input.batchSize) || (input.batchSize as number) < 1 || (input.batchSize as number) > 64) {
      throw new DeploymentProviderConfigError('embeddings provider batchSize must be an integer between 1 and 64')
    }
    provider.batchSize = input.batchSize as number
  }
  if (capability === 'tts') {
    provider.voice = requiredString(input.voice, 'tts provider voice', 200)
  }
  return provider
}

export function parseDeploymentProviders(value: string | undefined): DeploymentProviderConfigMap {
  if (!value?.trim()) return {}
  let payload: unknown
  try {
    payload = JSON.parse(value)
  } catch {
    throw new DeploymentProviderConfigError('MACHAIRA_DEPLOYMENT_PROVIDERS_JSON must contain valid JSON')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DeploymentProviderConfigError('MACHAIRA_DEPLOYMENT_PROVIDERS_JSON must contain an object')
  }
  const result: DeploymentProviderConfigMap = {}
  for (const [key, provider] of Object.entries(payload as Record<string, unknown>)) {
    if (!CAPABILITIES.has(key as DeploymentProviderCapability)) {
      throw new DeploymentProviderConfigError(`Unknown deployment provider capability: ${key}`)
    }
    result[key as DeploymentProviderCapability] = parseProvider(key as DeploymentProviderCapability, provider)
  }
  return result
}

function endpoint(baseUrl: string, suffix: string, stripV1 = false): string {
  const url = new URL(baseUrl)
  let path = url.pathname.replace(/\/+$/, '')
  if (stripV1) path = path.replace(/\/v1$/, '')
  url.pathname = `${path}/${suffix.replace(/^\/+/, '')}`
  return url.toString()
}

async function limitedBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ''
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_HEALTH_BYTES) throw new Error('readiness response was too large')
      result += decoder.decode(value, { stream: true })
    }
    result += decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return result
}

function includesModel(payload: unknown, model: string, engine: 'ollama' | 'speaches'): boolean {
  const list = engine === 'ollama'
    ? (payload as { models?: unknown })?.models
    : (payload as { data?: unknown })?.data
  if (!Array.isArray(list)) return false
  return list.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const item = entry as { id?: unknown; name?: unknown; model?: unknown }
    return [item.id, item.name, item.model].includes(model)
  })
}

interface CachedReadiness {
  state: Exclude<DeploymentProviderReadinessState, 'unchecked'>
  checkedAt: number
  message?: string
}

export class DeploymentProviderService {
  private readonly cache = new Map<DeploymentProviderCapability, CachedReadiness>()
  private readonly everReady = new Set<DeploymentProviderCapability>()

  constructor(
    private readonly providers: DeploymentProviderConfigMap,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now
  ) {}

  async list(): Promise<DeploymentProviderDescriptorMap> {
    const entries = await Promise.all(Object.entries(this.providers).map(async ([key, provider]) => {
      const capability = key as DeploymentProviderCapability
      return [capability, {
        ...provider,
        readiness: provider.source === 'external'
          ? { state: 'unchecked' as const, checkedAt: null }
          : await this.check(capability, provider)
      }] as const
    }))
    return Object.fromEntries(entries) as DeploymentProviderDescriptorMap
  }

  private async check(
    capability: DeploymentProviderCapability,
    provider: DeploymentProviderConfig
  ): Promise<CachedReadiness> {
    const now = this.clock()
    const cached = this.cache.get(capability)
    if (cached && now - cached.checkedAt < HEALTH_CACHE_MS) return cached

    let url: string
    if (provider.engine === 'ollama') url = endpoint(provider.baseUrl, 'api/tags', true)
    else if (provider.engine === 'speaches') url = endpoint(provider.baseUrl, 'models')
    else url = endpoint(provider.baseUrl, 'health', true)

    const signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    let readiness: CachedReadiness
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { accept: 'application/json' }
      })
      if (!response.ok) throw new Error(`readiness check returned HTTP ${response.status}`)
      const raw = await limitedBody(response)
      let payload: unknown = null
      if (provider.engine === 'ollama' || provider.engine === 'speaches') {
        try {
          payload = raw ? JSON.parse(raw) : null
        } catch {
          throw new Error('readiness response was not valid JSON')
        }
      }
      if (provider.engine === 'ollama' && !includesModel(payload, provider.model, 'ollama')) {
        throw new Error(`model ${provider.model} is not installed`)
      }
      if (provider.engine === 'speaches' && !includesModel(payload, provider.model, 'speaches')) {
        throw new Error(`model ${provider.model} is not loaded`)
      }
      this.everReady.add(capability)
      readiness = { state: 'ready', checkedAt: now }
    } catch (error) {
      const state = this.everReady.has(capability) ? 'unavailable' : 'starting'
      const message = signal.aborted
        ? 'readiness check timed out'
        : (error as Error).message.slice(0, 500)
      readiness = { state, checkedAt: now, message }
    }
    this.cache.set(capability, readiness)
    return readiness
  }
}
