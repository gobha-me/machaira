import { createHash } from 'node:crypto'
import type { MachairaDatabase } from './database.js'
import type { SecretStore } from './secrets.js'

export type DiscoveryTarget =
  | 'chat'
  | 'embedding'
  | 'tts-local'
  | 'tts-cloud'
  | 'stt-local'
  | 'stt-cloud'

export type DiscoveryProvider = 'openai-compatible' | 'anthropic' | 'local' | 'venice'
export type ModelCapability = 'chat' | 'embedding' | 'stt' | 'tts'
export type DiscoverySource = 'openai-compatible' | 'anthropic' | 'ollama' | 'venice'
export type DiscoveryErrorCode =
  | 'invalid_request'
  | 'provider_unauthorized'
  | 'provider_unreachable'
  | 'provider_unsupported'
  | 'provider_timeout'
  | 'provider_malformed'
  | 'provider_response_too_large'

export interface DiscoveredModel {
  id: string
  name: string
  owner?: string
  compatibility: 'confirmed' | 'unknown'
  capabilities: ModelCapability[]
  description?: string
  contextTokens?: number
  maxOutputTokens?: number
  privacy?: string
  pricing?: { inputUsd?: number; outputUsd?: number }
  deprecatedAt?: string
  sizeBytes?: number
  parameterSize?: string
  quantization?: string
}

export interface DiscoveredVoice {
  id: string
  name: string
}

export interface DiscoveryResult {
  supported: true
  source: DiscoverySource
  cached: boolean
  fetchedAt: number
  truncated: boolean
  models: DiscoveredModel[]
  voices: DiscoveredVoice[]
}

interface DiscoveryInput {
  target: DiscoveryTarget
  provider: DiscoveryProvider
  baseUrl: string
  apiKey?: string
  model?: string
  refresh: boolean
}

interface CacheEntry {
  expiresAt: number
  result: Omit<DiscoveryResult, 'cached'>
}

interface ResponseBudget {
  bytes: number
}

interface ModelPage {
  source: DiscoverySource
  models: DiscoveredModel[]
  truncated: boolean
}

type Fetcher = typeof fetch

const TARGETS = new Set<DiscoveryTarget>([
  'chat', 'embedding', 'tts-local', 'tts-cloud', 'stt-local', 'stt-cloud'
])
const PROVIDERS = new Set<DiscoveryProvider>(['openai-compatible', 'anthropic', 'local', 'venice'])
const TARGET_PROVIDERS: Record<DiscoveryTarget, Set<DiscoveryProvider>> = {
  chat: new Set(['openai-compatible', 'anthropic', 'local']),
  embedding: new Set(['openai-compatible', 'local']),
  'tts-local': new Set(['openai-compatible']),
  'tts-cloud': new Set(['openai-compatible', 'venice']),
  'stt-local': new Set(['openai-compatible']),
  'stt-cloud': new Set(['openai-compatible', 'venice'])
}
const SECRET_NAMES: Record<DiscoveryTarget, string> = {
  chat: 'ai-provider-api-key',
  embedding: 'embedding-provider-api-key',
  'tts-local': 'tts-local-api-key',
  'tts-cloud': 'tts-cloud-api-key',
  'stt-local': 'stt-local-api-key',
  'stt-cloud': 'stt-cloud-api-key'
}
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 500
const MAX_PAGES = 10
const PAGE_SIZE = 100
const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

export class DiscoveryInputError extends Error {
  readonly code: DiscoveryErrorCode = 'invalid_request'
}

export class ProviderDiscoveryError extends Error {
  constructor(
    message: string,
    readonly code: Exclude<DiscoveryErrorCode, 'invalid_request'>
  ) {
    super(message)
    this.name = 'ProviderDiscoveryError'
  }
}

function stringField(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new DiscoveryInputError(`${name} is required`)
  const result = value.trim()
  if (result.length > max) throw new DiscoveryInputError(`${name} is too long`)
  return result
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.trim().slice(0, max)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function discoveryProviderUrl(value: unknown): string {
  const raw = stringField(value, 'Base URL', 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DiscoveryInputError('Base URL must be a valid HTTP or HTTPS URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new DiscoveryInputError('Base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DiscoveryInputError('Base URL cannot include credentials, a query, or a fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function endpoint(baseUrl: string, suffix: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
  return url
}

function ollamaTagsEndpoint(baseUrl: string): URL | null {
  const url = new URL(baseUrl)
  if (!/\/v1$/i.test(url.pathname)) return null
  url.pathname = url.pathname.replace(/\/v1$/i, '/api/tags')
  return url
}

function capabilityForTarget(target: DiscoveryTarget): ModelCapability {
  if (target === 'chat' || target === 'embedding') return target
  return target.startsWith('tts-') ? 'tts' : 'stt'
}

function providerTypeForCapability(capability: ModelCapability): string {
  if (capability === 'chat') return 'text'
  if (capability === 'stt') return 'asr'
  return capability
}

function parseInput(value: unknown): DiscoveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiscoveryInputError('Provider discovery request is required')
  }
  const body = value as Record<string, unknown>
  if (typeof body.target !== 'string' || !TARGETS.has(body.target as DiscoveryTarget)) {
    throw new DiscoveryInputError('Discovery target is invalid')
  }
  if (typeof body.provider !== 'string' || !PROVIDERS.has(body.provider as DiscoveryProvider)) {
    throw new DiscoveryInputError('Discovery provider is invalid')
  }
  const target = body.target as DiscoveryTarget
  const provider = body.provider as DiscoveryProvider
  if (!TARGET_PROVIDERS[target].has(provider)) {
    throw new DiscoveryInputError(`Provider ${provider} is not supported for ${target}`)
  }
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') {
    throw new DiscoveryInputError('refresh must be a boolean')
  }
  const apiKey = body.apiKey === undefined ? undefined : stringField(body.apiKey, 'API key', 4096)
  const model = body.model === undefined ? undefined : stringField(body.model, 'Model', 200)
  if (model && !target.startsWith('tts-')) {
    throw new DiscoveryInputError('A model may only be supplied for TTS voice discovery')
  }
  return {
    target,
    provider,
    baseUrl: discoveryProviderUrl(body.baseUrl),
    apiKey,
    model,
    refresh: body.refresh === true
  }
}

function capabilitiesFromItem(item: Record<string, unknown>): { values: ModelCapability[]; reported: boolean } {
  const values = new Set<ModelCapability>()
  let reported = false
  const type = optionalString(item.type, 40)?.toLowerCase()
  if (type && type !== 'model') {
    reported = true
    if (type === 'text' || type === 'chat' || type === 'completion') values.add('chat')
    if (type === 'embedding' || type === 'embeddings') values.add('embedding')
    if (type === 'asr' || type === 'stt' || type === 'transcription') values.add('stt')
    if (type === 'tts' || type === 'speech') values.add('tts')
  }
  if (Array.isArray(item.capabilities)) {
    reported = true
    for (const raw of item.capabilities) {
      if (typeof raw !== 'string') continue
      const capability = raw.toLowerCase()
      if (capability === 'chat' || capability === 'completion' || capability === 'generate') values.add('chat')
      if (capability === 'embedding' || capability === 'embeddings') values.add('embedding')
      if (capability === 'asr' || capability === 'stt' || capability === 'transcription') values.add('stt')
      if (capability === 'tts' || capability === 'speech') values.add('tts')
    }
  }
  return { values: [...values], reported }
}

function normalizeGenericModel(value: unknown, requested: ModelCapability): DiscoveredModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const id = optionalString(item.id ?? item.model, 200)
  if (!id) return null
  const capabilities = capabilitiesFromItem(item)
  if (capabilities.reported && capabilities.values.length && !capabilities.values.includes(requested)) return null
  const spec = item.model_spec && typeof item.model_spec === 'object' && !Array.isArray(item.model_spec)
    ? item.model_spec as Record<string, unknown>
    : {}
  const pricingValue = spec.pricing && typeof spec.pricing === 'object' && !Array.isArray(spec.pricing)
    ? spec.pricing as Record<string, unknown>
    : {}
  const pricingInput = pricingValue.input && typeof pricingValue.input === 'object'
    ? pricingValue.input as Record<string, unknown>
    : {}
  const pricingOutput = pricingValue.output && typeof pricingValue.output === 'object'
    ? pricingValue.output as Record<string, unknown>
    : {}
  const inputUsd = finiteNumber(pricingInput.usd)
  const outputUsd = finiteNumber(pricingOutput.usd)
  const pricing = inputUsd !== undefined || outputUsd !== undefined ? { inputUsd, outputUsd } : undefined
  return {
    id,
    name: optionalString(item.display_name ?? spec.name ?? item.name, 300) ?? id,
    ...(optionalString(item.owned_by ?? item.owner, 200) ? { owner: optionalString(item.owned_by ?? item.owner, 200) } : {}),
    compatibility: capabilities.values.includes(requested) ? 'confirmed' : 'unknown',
    capabilities: capabilities.values,
    ...(optionalString(spec.description ?? item.description, 1000) ? { description: optionalString(spec.description ?? item.description, 1000) } : {}),
    ...(positiveInteger(spec.availableContextTokens ?? item.context_length ?? item.context_window) ? { contextTokens: positiveInteger(spec.availableContextTokens ?? item.context_length ?? item.context_window) } : {}),
    ...(positiveInteger(item.max_tokens ?? item.max_output_tokens) ? { maxOutputTokens: positiveInteger(item.max_tokens ?? item.max_output_tokens) } : {}),
    ...(optionalString(spec.privacy ?? item.privacy, 100) ? { privacy: optionalString(spec.privacy ?? item.privacy, 100) } : {}),
    ...(pricing ? { pricing } : {}),
    ...(optionalString((spec.deprecation as Record<string, unknown> | undefined)?.date ?? item.shutdown_date, 100) ? { deprecatedAt: optionalString((spec.deprecation as Record<string, unknown> | undefined)?.date ?? item.shutdown_date, 100) } : {})
  }
}

function normalizeOllamaModel(value: unknown): DiscoveredModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const id = optionalString(item.model ?? item.name, 200)
  if (!id) return null
  const details = item.details && typeof item.details === 'object' && !Array.isArray(item.details)
    ? item.details as Record<string, unknown>
    : {}
  return {
    id,
    name: optionalString(item.name, 300) ?? id,
    owner: 'Ollama',
    compatibility: 'unknown',
    capabilities: [],
    ...(positiveInteger(item.size) ? { sizeBytes: positiveInteger(item.size) } : {}),
    ...(optionalString(details.parameter_size, 100) ? { parameterSize: optionalString(details.parameter_size, 100) } : {}),
    ...(optionalString(details.quantization_level, 100) ? { quantization: optionalString(details.quantization_level, 100) } : {})
  }
}

function normalizeAnthropicModel(value: unknown): DiscoveredModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const id = optionalString(item.id, 200)
  if (!id) return null
  return {
    id,
    name: optionalString(item.display_name, 300) ?? id,
    owner: 'Anthropic',
    compatibility: 'confirmed',
    capabilities: ['chat'],
    ...(positiveInteger(item.max_input_tokens) ? { contextTokens: positiveInteger(item.max_input_tokens) } : {}),
    ...(positiveInteger(item.max_tokens) ? { maxOutputTokens: positiveInteger(item.max_tokens) } : {})
  }
}

function sortedUnique(models: DiscoveredModel[]): DiscoveredModel[] {
  const unique = new Map<string, DiscoveredModel>()
  for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model)
  return [...unique.values()].sort((left, right) => {
    if (left.compatibility !== right.compatibility) return left.compatibility === 'confirmed' ? -1 : 1
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  })
}

function voicesFromModel(value: unknown): DiscoveredVoice[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const item = value as Record<string, unknown>
  const spec = item.model_spec && typeof item.model_spec === 'object' && !Array.isArray(item.model_spec)
    ? item.model_spec as Record<string, unknown>
    : item
  if (!Array.isArray(spec.voices)) return []
  const voices: DiscoveredVoice[] = []
  for (const value of spec.voices) {
    if (typeof value === 'string' && value.trim()) {
      voices.push({ id: value.trim().slice(0, 200), name: value.trim().slice(0, 300) })
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const voice = value as Record<string, unknown>
      const id = optionalString(voice.id ?? voice.voice, 200)
      if (id) voices.push({ id, name: optionalString(voice.name ?? voice.display_name, 300) ?? id })
    }
  }
  return [...new Map(voices.map((voice) => [voice.id, voice])).values()]
    .sort((left, right) => left.name.localeCompare(right.name))
}

export class ProviderDiscoveryService {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly db: MachairaDatabase,
    private readonly secrets: SecretStore,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS
  ) {}

  async discover(userId: string, value: unknown, signal?: AbortSignal): Promise<DiscoveryResult> {
    const input = parseInput(value)
    const apiKey = this.resolveApiKey(userId, input)
    if (this.requiresApiKey(input) && !apiKey) {
      throw new DiscoveryInputError('An API key is required to load models from this provider')
    }
    const key = createHash('sha256').update(JSON.stringify({
      userId,
      target: input.target,
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model ?? null,
      credential: createHash('sha256').update(apiKey ?? '').digest('hex')
    })).digest('hex')
    const cached = this.cache.get(key)
    if (!input.refresh && cached && cached.expiresAt > this.now()) {
      return { ...cached.result, cached: true }
    }

    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const budget = { bytes: 0 }
    const capability = capabilityForTarget(input.target)
    let page: ModelPage
    if (input.provider === 'anthropic') {
      page = await this.discoverAnthropic(input.baseUrl, apiKey!, combined, budget)
    } else if (input.provider === 'venice') {
      page = await this.discoverVenice(input.baseUrl, apiKey!, capability, combined, budget)
    } else if (input.provider === 'local') {
      page = await this.discoverLocal(input.baseUrl, apiKey, capability, combined, budget)
    } else {
      page = await this.discoverOpenAiCompatible(input.baseUrl, apiKey, capability, combined, budget)
    }

    let voices: DiscoveredVoice[] = []
    if (input.provider === 'venice' && capability === 'tts' && input.model) {
      voices = await this.discoverVeniceVoices(input.baseUrl, apiKey!, input.model, combined, budget)
    }
    const result: Omit<DiscoveryResult, 'cached'> = {
      supported: true,
      source: page.source,
      fetchedAt: this.now(),
      truncated: page.truncated,
      models: page.models,
      voices
    }
    this.cache.set(key, { expiresAt: this.now() + CACHE_TTL_MS, result })
    this.pruneCache()
    return { ...result, cached: false }
  }

  private resolveApiKey(userId: string, input: DiscoveryInput): string | null {
    if (input.apiKey !== undefined) return input.apiKey
    const saved = this.savedIdentity(userId, input.target)
    if (!saved || saved.provider !== input.provider || saved.baseUrl !== input.baseUrl) return null
    return this.secrets.get(userId, SECRET_NAMES[input.target])
  }

  private savedIdentity(userId: string, target: DiscoveryTarget): { provider: string; baseUrl: string } | null {
    let row: { provider: string | null; base_url: string | null } | undefined
    if (target === 'chat') {
      row = this.db.prepare('SELECT kind AS provider, base_url FROM ai_provider_configs WHERE user_id = ?')
        .get(userId) as typeof row
    } else if (target === 'embedding') {
      row = this.db.prepare('SELECT kind AS provider, base_url FROM embedding_provider_configs WHERE user_id = ?')
        .get(userId) as typeof row
    } else {
      const tier = target.endsWith('-local') ? 'local' : 'cloud'
      const table = target.startsWith('tts-') ? 'tts_configs' : 'stt_configs'
      row = this.db.prepare(`SELECT ${tier}_provider AS provider, ${tier}_base_url AS base_url FROM ${table} WHERE user_id = ?`)
        .get(userId) as typeof row
    }
    return row?.provider && row.base_url ? { provider: row.provider, baseUrl: row.base_url } : null
  }

  private requiresApiKey(input: DiscoveryInput): boolean {
    if (input.provider === 'anthropic' || input.provider === 'venice') return true
    if (input.provider === 'local' || input.target.endsWith('-local')) return false
    return true
  }

  private headers(provider: DiscoveryProvider, apiKey: string | null): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01'
      if (apiKey) headers['x-api-key'] = apiKey
    } else if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`
    }
    return headers
  }

  private async discoverOpenAiCompatible(
    baseUrl: string,
    apiKey: string | null,
    capability: ModelCapability,
    signal: AbortSignal,
    budget: ResponseBudget
  ): Promise<ModelPage> {
    const payload = await this.fetchJson(endpoint(baseUrl, 'models'), this.headers('openai-compatible', apiKey), signal, budget)
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new ProviderDiscoveryError('Provider returned a malformed model list', 'provider_malformed')
    }
    const data = (payload as { data: unknown[] }).data
    const models = data.slice(0, MAX_MODELS).map((item) => normalizeGenericModel(item, capability)).filter((item): item is DiscoveredModel => !!item)
    if (data.length && !models.length) {
      throw new ProviderDiscoveryError('Provider model list did not contain valid model records', 'provider_malformed')
    }
    return { source: 'openai-compatible', models: sortedUnique(models), truncated: data.length > MAX_MODELS }
  }

  private async discoverLocal(
    baseUrl: string,
    apiKey: string | null,
    capability: ModelCapability,
    signal: AbortSignal,
    budget: ResponseBudget
  ): Promise<ModelPage> {
    const tagsUrl = ollamaTagsEndpoint(baseUrl)
    if (tagsUrl) {
      try {
        const payload = await this.fetchJson(tagsUrl, this.headers('local', apiKey), signal, budget)
        if (payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown }).models)) {
          const data = (payload as { models: unknown[] }).models
          const models = data.slice(0, MAX_MODELS).map(normalizeOllamaModel).filter((item): item is DiscoveredModel => !!item)
          if (!data.length || models.length) {
            return { source: 'ollama', models: sortedUnique(models), truncated: data.length > MAX_MODELS }
          }
        }
      } catch (error) {
        if (signal.aborted) throw error
        // A local OpenAI-compatible endpoint does not need to implement Ollama's native API.
      }
    }
    return this.discoverOpenAiCompatible(baseUrl, apiKey, capability, signal, budget)
  }

  private async discoverAnthropic(
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
    budget: ResponseBudget
  ): Promise<ModelPage> {
    const models: DiscoveredModel[] = []
    let afterId: string | undefined
    let truncated = false
    const seenCursors = new Set<string>()
    for (let page = 0; page < MAX_PAGES && models.length < MAX_MODELS; page += 1) {
      const url = endpoint(baseUrl, 'models')
      url.searchParams.set('limit', String(PAGE_SIZE))
      if (afterId) url.searchParams.set('after_id', afterId)
      const payload = await this.fetchJson(url, this.headers('anthropic', apiKey), signal, budget)
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
        throw new ProviderDiscoveryError('Anthropic returned a malformed model list', 'provider_malformed')
      }
      const response = payload as { data: unknown[]; has_more?: unknown; last_id?: unknown }
      const pageModels = response.data.map(normalizeAnthropicModel).filter((item): item is DiscoveredModel => !!item)
      if (response.data.length && !pageModels.length) {
        throw new ProviderDiscoveryError('Anthropic model list did not contain valid model records', 'provider_malformed')
      }
      models.push(...pageModels.slice(0, MAX_MODELS - models.length))
      if (response.has_more !== true) break
      const cursor = optionalString(response.last_id, 200)
      if (!cursor || seenCursors.has(cursor)) {
        throw new ProviderDiscoveryError('Anthropic returned an invalid pagination cursor', 'provider_malformed')
      }
      seenCursors.add(cursor)
      afterId = cursor
      if (page === MAX_PAGES - 1 || models.length >= MAX_MODELS) truncated = true
    }
    return { source: 'anthropic', models: sortedUnique(models), truncated }
  }

  private async discoverVenice(
    baseUrl: string,
    apiKey: string,
    capability: ModelCapability,
    signal: AbortSignal,
    budget: ResponseBudget
  ): Promise<ModelPage> {
    const url = endpoint(baseUrl, 'models')
    url.searchParams.set('type', providerTypeForCapability(capability))
    const payload = await this.fetchJson(url, this.headers('venice', apiKey), signal, budget)
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new ProviderDiscoveryError('Venice returned a malformed model list', 'provider_malformed')
    }
    const data = (payload as { data: unknown[] }).data
    const models = data.slice(0, MAX_MODELS).map((value): DiscoveredModel | null => {
      const model = normalizeGenericModel(value, capability)
      return model ? { ...model, compatibility: 'confirmed', capabilities: [capability] } : null
    }).filter((item): item is DiscoveredModel => !!item)
    if (data.length && !models.length) {
      throw new ProviderDiscoveryError('Venice model list did not contain valid model records', 'provider_malformed')
    }
    return { source: 'venice', models: sortedUnique(models), truncated: data.length > MAX_MODELS }
  }

  private async discoverVeniceVoices(
    baseUrl: string,
    apiKey: string,
    model: string,
    signal: AbortSignal,
    budget: ResponseBudget
  ): Promise<DiscoveredVoice[]> {
    const payload = await this.fetchJson(
      endpoint(baseUrl, `models/${encodeURIComponent(model)}`),
      this.headers('venice', apiKey),
      signal,
      budget
    )
    if (!payload || typeof payload !== 'object') {
      throw new ProviderDiscoveryError('Venice returned malformed voice metadata', 'provider_malformed')
    }
    const data = (payload as { data?: unknown }).data ?? payload
    return voicesFromModel(data)
  }

  private async fetchJson(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    budget: ResponseBudget
  ): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(url, { headers, redirect: 'error', signal })
    } catch (error) {
      if (signal.aborted) {
        throw new ProviderDiscoveryError('Provider model discovery timed out or was cancelled', 'provider_timeout')
      }
      throw new ProviderDiscoveryError(`Could not reach provider: ${(error as Error).message}`, 'provider_unreachable')
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      throw new ProviderDiscoveryError('Provider rejected the supplied credentials', 'provider_unauthorized')
    }
    if ([404, 405, 501].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined)
      throw new ProviderDiscoveryError('This provider does not expose model discovery; enter the model ID manually', 'provider_unsupported')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new ProviderDiscoveryError(`Provider rejected model discovery (${response.status})`, 'provider_unreachable')
    }
    const raw = await this.readLimitedText(response, budget, MAX_RESPONSE_BYTES)
    try {
      return JSON.parse(raw)
    } catch {
      throw new ProviderDiscoveryError('Provider returned malformed JSON', 'provider_malformed')
    }
  }

  private async readLimitedText(response: Response, budget: ResponseBudget, perReadLimit: number): Promise<string> {
    if (!response.body) return ''
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > 0 && budget.bytes + declared > MAX_RESPONSE_BYTES) {
      await response.body.cancel().catch(() => undefined)
      throw new ProviderDiscoveryError('Provider model response exceeded 2 MiB', 'provider_response_too_large')
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        budget.bytes += value.byteLength
        if (budget.bytes > MAX_RESPONSE_BYTES) {
          throw new ProviderDiscoveryError('Provider model response exceeded 2 MiB', 'provider_response_too_large')
        }
        if (size > perReadLimit) {
          throw new ProviderDiscoveryError('Provider model response exceeded 2 MiB', 'provider_response_too_large')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    return Buffer.concat(chunks, size).toString('utf8').trim()
  }

  private pruneCache(): void {
    const now = this.now()
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key)
    while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
  }
}
