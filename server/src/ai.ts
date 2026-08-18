import type { MachairaDatabase } from './database.js'
import type { SecretStore } from './secrets.js'

export type AiProviderKind = 'openai-compatible' | 'anthropic' | 'local'
export type ChatRole = 'user' | 'assistant'

export interface AiProviderConfig {
  kind: AiProviderKind
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface ChatInput {
  passage: { reference: string; module: string; content: string }
  messages: { role: ChatRole; content: string }[]
  preferences: { alwaysCite: boolean; drawApocrypha: boolean }
}

interface StoredProviderConfig {
  kind: AiProviderKind
  base_url: string
  model: string
}

const API_KEY_SECRET = 'ai-provider-api-key'
const DEFAULT_URLS: Record<AiProviderKind, string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  local: 'http://127.0.0.1:11434/v1'
}
const PROVIDER_KINDS = new Set<AiProviderKind>(['openai-compatible', 'anthropic', 'local'])

export class AiInputError extends Error {}
export class AiProviderError extends Error {}

function stringField(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new AiInputError(`${name} is required`)
  const result = value.trim()
  if (result.length > max) throw new AiInputError(`${name} is too long`)
  return result
}

function providerUrl(value: unknown, kind: AiProviderKind): string {
  const raw = value == null || value === '' ? DEFAULT_URLS[kind] : stringField(value, 'Base URL', 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AiInputError('Base URL must be a valid HTTP or HTTPS URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AiInputError('Base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiInputError('Base URL cannot include credentials, a query, or a fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function endpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
  return url.toString()
}

export class AiProviderService {
  constructor(
    private readonly db: MachairaDatabase,
    private readonly secrets: SecretStore
  ) {}

  get(userId: string): AiProviderConfig | null {
    const row = this.db.prepare(`
      SELECT kind, base_url, model FROM ai_provider_configs WHERE user_id = ?
    `).get(userId) as StoredProviderConfig | undefined
    if (!row) return null
    return {
      kind: row.kind,
      baseUrl: row.base_url,
      model: row.model,
      hasApiKey: this.secrets.has(userId, API_KEY_SECRET)
    }
  }

  save(userId: string, input: unknown): AiProviderConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AiInputError('Provider configuration is required')
    }
    const body = input as Record<string, unknown>
    if (typeof body.kind !== 'string' || !PROVIDER_KINDS.has(body.kind as AiProviderKind)) {
      throw new AiInputError('Provider kind is invalid')
    }
    const kind = body.kind as AiProviderKind
    const baseUrl = providerUrl(body.baseUrl, kind)
    const model = stringField(body.model, 'Model', 200)
    const apiKey = body.apiKey === undefined ? undefined : stringField(body.apiKey, 'API key', 4096)
    if (body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean') {
      throw new AiInputError('clearApiKey must be a boolean')
    }
    if (apiKey !== undefined && body.clearApiKey === true) {
      throw new AiInputError('Cannot replace and clear the API key together')
    }

    const existing = this.get(userId)
    const kindChanged = existing !== null && existing.kind !== kind
    const willHaveKey = apiKey !== undefined
      || (!kindChanged && body.clearApiKey !== true && existing?.hasApiKey === true)
    if (kind !== 'local' && !willHaveKey) {
      throw new AiInputError('An API key is required for this provider')
    }

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO ai_provider_configs (user_id, kind, base_url, model, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          kind = excluded.kind,
          base_url = excluded.base_url,
          model = excluded.model,
          updated_at = excluded.updated_at
      `).run(userId, kind, baseUrl, model, Date.now())
      if (apiKey !== undefined) this.secrets.set(userId, API_KEY_SECRET, apiKey)
      else if (body.clearApiKey === true || kindChanged) this.secrets.remove(userId, API_KEY_SECRET)
    })()
    return this.get(userId)!
  }

  remove(userId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM ai_provider_configs WHERE user_id = ?').run(userId)
      this.secrets.remove(userId, API_KEY_SECRET)
    })()
  }

  credentials(userId: string): { config: AiProviderConfig; apiKey: string | null } {
    const config = this.get(userId)
    if (!config) throw new AiInputError('Connect a provider in Settings before starting a chat')
    const apiKey = this.secrets.get(userId, API_KEY_SECRET)
    if (config.kind !== 'local' && !apiKey) throw new AiInputError('The configured provider needs an API key')
    return { config, apiKey }
  }
}

export function parseChatInput(input: unknown): ChatInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AiInputError('Chat request is required')
  }
  const body = input as Record<string, unknown>
  if (!body.passage || typeof body.passage !== 'object' || Array.isArray(body.passage)) {
    throw new AiInputError('Passage context is required')
  }
  const passage = body.passage as Record<string, unknown>
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 20) {
    throw new AiInputError('Chat must contain between 1 and 20 messages')
  }
  const messages = body.messages.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AiInputError(`Message ${index + 1} is invalid`)
    }
    const message = entry as Record<string, unknown>
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new AiInputError(`Message ${index + 1} has an invalid role`)
    }
    return {
      role: message.role as ChatRole,
      content: stringField(message.content, `Message ${index + 1}`, 12_000)
    }
  })
  if (messages.at(-1)?.role !== 'user') throw new AiInputError('The final message must be from the user')

  const preferences = body.preferences && typeof body.preferences === 'object'
    ? body.preferences as Record<string, unknown>
    : {}
  return {
    passage: {
      reference: stringField(passage.reference, 'Passage reference', 300),
      module: stringField(passage.module, 'Passage module', 200),
      content: stringField(passage.content, 'Passage content', 30_000)
    },
    messages,
    preferences: {
      alwaysCite: preferences.alwaysCite !== false,
      drawApocrypha: preferences.drawApocrypha === true
    }
  }
}

function systemPrompt(input: ChatInput): string {
  const instructions = [
    'You are Sword, a careful Bible study partner.',
    'Answer the user about the supplied passage. Distinguish the passage text from interpretation, avoid inventing quotations, and acknowledge uncertainty.',
    input.preferences.alwaysCite
      ? 'Include scripture references for interpretive claims whenever possible.'
      : 'Use scripture references when they materially help the answer.',
    input.preferences.drawApocrypha
      ? 'You may draw on apocryphal or deuterocanonical sources, but label them clearly.'
      : 'Do not draw on apocryphal or deuterocanonical sources unless the user explicitly asks.',
    '',
    `Current passage: ${input.passage.reference}`,
    `Translation/module: ${input.passage.module}`,
    input.passage.content
  ]
  return instructions.join('\n')
}

async function limitedError(response: Response): Promise<string> {
  if (!response.body) return response.statusText || `HTTP ${response.status}`
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < 2000) {
      const { done, value } = await reader.read()
      text += decoder.decode(value, { stream: !done })
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return text.slice(0, 2000).trim() || response.statusText || `HTTP ${response.status}`
}

async function* sseData(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new AiProviderError('Provider returned an empty stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 1_000_000) throw new AiProviderError('Provider sent an oversized stream event')
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield data
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}

function openAiText(payload: unknown): string {
  const delta = (payload as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta?.content
  if (typeof delta === 'string') return delta
  if (Array.isArray(delta)) {
    return delta.map((part) => {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text
      return ''
    }).join('')
  }
  return ''
}

export async function* streamProviderChat(
  credentials: { config: AiProviderConfig; apiKey: string | null },
  input: ChatInput,
  signal: AbortSignal
): AsyncGenerator<string> {
  const { config, apiKey } = credentials
  const timeoutSignal = AbortSignal.timeout(120_000)
  const combinedSignal = AbortSignal.any([signal, timeoutSignal])
  const prompt = systemPrompt(input)

  let response: Response
  try {
    if (config.kind === 'anthropic') {
      response = await fetch(endpoint(config.baseUrl, 'messages'), {
        method: 'POST',
        redirect: 'error',
        signal: combinedSignal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey!,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 2048,
          stream: true,
          system: prompt,
          messages: input.messages
        })
      })
    } else {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      response = await fetch(endpoint(config.baseUrl, 'chat/completions'), {
        method: 'POST',
        redirect: 'error',
        signal: combinedSignal,
        headers,
        body: JSON.stringify({
          model: config.model,
          stream: true,
          messages: [{ role: 'system', content: prompt }, ...input.messages]
        })
      })
    }
  } catch (error) {
    if (combinedSignal.aborted) throw new AiProviderError('Provider request timed out or was cancelled')
    throw new AiProviderError(`Could not reach provider: ${(error as Error).message}`)
  }

  if (!response.ok) {
    throw new AiProviderError(`Provider rejected the request (${response.status}): ${await limitedError(response)}`)
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    throw new AiProviderError('Provider did not return an event stream')
  }

  let emitted = false
  try {
    for await (const data of sseData(response)) {
      if (data === '[DONE]') break
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      if (config.kind === 'anthropic') {
        const event = payload as { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } }
        if (event.type === 'error') throw new AiProviderError(event.error?.message ?? 'Anthropic stream failed')
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          emitted = true
          yield event.delta.text
        }
      } else {
        const providerError = (payload as { error?: { message?: string } })?.error
        if (providerError) throw new AiProviderError(providerError.message ?? 'Provider stream failed')
        const text = openAiText(payload)
        if (text) {
          emitted = true
          yield text
        }
      }
    }
    if (!emitted) throw new AiProviderError('Provider returned no response text')
  } catch (error) {
    if (error instanceof AiProviderError) throw error
    if (combinedSignal.aborted) throw new AiProviderError('Provider request timed out or was cancelled')
    throw new AiProviderError(`Provider stream failed: ${(error as Error).message}`)
  }
}
