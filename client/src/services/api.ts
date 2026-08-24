// Typed client for the local SWORD backend (proxied at /api in dev).

export interface ModuleInfo {
  id: string
  name: string
  type: string
  description: string
  language: string
  abbreviation?: string
  distributionLicense?: string
  repository?: string
  version?: string
  versification?: string
  size?: number
  about?: string
  hasStrongs: boolean
  hasGreekStrongsKeys: boolean
  hasHebrewStrongsKeys: boolean
  hasFootnotes: boolean
  hasHeadings: boolean
  hasRedLetterWords: boolean
  hasCrossReferences: boolean
  locked: boolean
  installed: boolean
  kind: 'scripture' | 'general-book' | 'lexicon' | 'commentary'
  collection: 'bible' | 'deuterocanon' | 'ancient-writings' | 'reference'
  tradition?: string
  coverage: string[]
  coverageSource: 'live' | 'audit' | 'unknown'
  format: 'bundled' | 'standalone' | 'reference'
  coverageSummary: string
  aiEligibility: 'public-domain' | 'review-required'
}

export interface RepositoryDiagnostic {
  name: string
  status: 'healthy' | 'failed' | 'cached' | 'unknown'
  moduleCount: number
  message?: string
}

export interface CatalogPayload {
  modules: ModuleInfo[]
  diagnostics: {
    refreshedAt: number
    usedCachedCatalog: boolean
    repositories: RepositoryDiagnostic[]
  }
}

export interface BookEntry {
  code: string
  name: string
  section: 'ot' | 'nt' | 'apocrypha'
  chapters: number
}

export interface VerseNote {
  label: string
  text: string
}

export type VerseSegment =
  | { kind: 'text'; text: string }
  | { kind: 'note'; label: string; text: string }
  | { kind: 'word'; text: string; strongs: string[] }

export interface ChapterVerse {
  n: number
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
  crossReferences: string[]
  crossReferenceTargets?: ScriptureTarget[]
}

export interface ChapterPayload {
  module: string
  book: string
  bookName: string
  chapter: number
  verses: ChapterVerse[]
}

export interface CompareRow {
  module: string
  hasStrongs: boolean
  license: string
  verses: { n: number; text: string | null }[]
}

export interface StrongsPayload {
  key: string
  transcription: string
  phonetic: string
  definition: string
  references: unknown[]
}

export interface CommentaryEntry {
  n: number
  text: string
  notes: VerseNote[]
  segments: VerseSegment[]
}

export interface CommentaryPayload {
  module: string
  book: string
  bookName: string
  chapter: number
  locked: boolean
  entries: CommentaryEntry[]
}

export interface ScriptureSearchHit {
  kind: 'scripture'
  module: string
  book: string
  bookName: string
  chapter: number
  verse: number
  content: string
}

export interface GeneralBookSearchHit {
  kind: 'general-book'
  module: string
  key: string
  title: string
  content: string
}

export type SearchHit = ScriptureSearchHit | GeneralBookSearchHit

export type SemanticSearchHit = SearchHit & { distance: number }

export interface GeneralBookEntry {
  key: string
  title: string
  content: string
  depth: number
}

export interface ScriptureTarget {
  book: string
  chapter: number
  verseStart: number | null
  verseEnd: number | null
}

export interface ConnectionSeed extends ScriptureTarget {
  module: string
}

export interface ConnectionNode extends ConnectionSeed {
  id: string
  bookName: string
  label: string
  content: string
  seed: boolean
}

export interface ConnectionEdge {
  source: string
  target: string
  kind: 'cross-reference' | 'thematic'
  distance?: number
}

export interface ConnectionsPayload {
  nodes: ConnectionNode[]
  edges: ConnectionEdge[]
  semanticState: SemanticIndexStatus['state'] | 'unavailable'
  warnings: string[]
}

export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  refs: string[]
  createdAt: number
  updatedAt: number
}

export interface Highlight {
  key: string
  color: string
}

export interface PersonalDataImportResult {
  notesImported: number
  notesSkipped: number
  highlightsImported: number
  highlightsSkipped: number
}

export type UserRole = 'admin' | 'member'

export interface AuthUser {
  id: string
  username: string
  role: UserRole
}

export interface ManagedUser extends AuthUser {
  disabled: boolean
  createdAt: number
}

export type AuthStatus =
  | { state: 'bootstrap' }
  | { state: 'anonymous' }
  | { state: 'authenticated'; user: AuthUser }

export type AiProviderKind = 'openai-compatible' | 'anthropic' | 'local'

export interface AiProviderConfig {
  kind: AiProviderKind
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export type EmbeddingProviderKind = 'openai-compatible' | 'local'

export interface EmbeddingProviderConfig {
  kind: EmbeddingProviderKind
  baseUrl: string
  model: string
  batchSize: number
  hasApiKey: boolean
}

export type DeploymentProviderCapability = 'embeddings' | 'stt' | 'tts'
export type DeploymentProviderSource = 'bundled' | 'external'
export type DeploymentProviderReadinessState = 'ready' | 'starting' | 'unavailable' | 'unchecked'

export interface DeploymentProviderDescriptor {
  source: DeploymentProviderSource
  engine: string
  baseUrl: string
  model: string
  batchSize?: number
  voice?: string
  readiness: {
    state: DeploymentProviderReadinessState
    checkedAt: number | null
    message?: string
  }
}

export type DeploymentProviderMap = Partial<Record<DeploymentProviderCapability, DeploymentProviderDescriptor>>

export type TtsTier = 'browser' | 'local' | 'cloud'
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

export interface TtsEndpointInput {
  provider: TtsProviderKind
  baseUrl: string
  model: string
  voice: string
  apiKey?: string
  clearApiKey?: boolean
}

export type SttTier = 'browser' | 'local' | 'cloud'
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

export interface SttEndpointInput {
  provider: SttProviderKind
  baseUrl: string
  model: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface SttConnectionResult {
  ok: true
  modelAvailable: boolean | null
  message: string
}

export type DiscoveryTarget =
  | 'chat'
  | 'embedding'
  | 'tts-local'
  | 'tts-cloud'
  | 'stt-local'
  | 'stt-cloud'

export type DiscoveryProvider = 'openai-compatible' | 'anthropic' | 'local' | 'venice'
export type ModelCapability = 'chat' | 'embedding' | 'stt' | 'tts'

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

export interface ProviderDiscoveryResult {
  supported: true
  source: 'openai-compatible' | 'anthropic' | 'ollama' | 'venice'
  cached: boolean
  fetchedAt: number
  truncated: boolean
  models: DiscoveredModel[]
  voices: DiscoveredVoice[]
}

export interface ProviderDiscoveryInput {
  target: DiscoveryTarget
  provider: DiscoveryProvider
  baseUrl: string
  apiKey?: string
  model?: string
  refresh?: boolean
}

export interface SemanticIndexStatus {
  state: 'unconfigured' | 'empty' | 'building' | 'ready' | 'stale' | 'failed'
  chunkCount: number
  modules: string[]
  model: string | null
  updatedAt: number | null
  lastError: string | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  passage: { reference: string; module: string; content: string }
  messages: ChatMessage[]
  preferences: { alwaysCite: boolean; drawApocrypha: boolean }
}

let unauthorizedHandler: (() => void) | null = null

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler
}

async function request(url: string, init?: RequestInit, notifyUnauthorized = true): Promise<Response> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  if (res.status === 401 && notifyUnauthorized) unauthorizedHandler?.()
  return res
}

async function requestJson<T>(url: string, init?: RequestInit, notifyUnauthorized = true): Promise<T> {
  const res = await request(url, init, notifyUnauthorized)
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as ApiErrorBody)
  return res.json() as Promise<T>
}

async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await request(url, init)
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as ApiErrorBody)
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }
}

export async function consumeSseEvents(
  response: Response,
  handler: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  if (!response.body) throw new Error('Server returned no response stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 1_000_000) throw new Error('Response stream event is too large')
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/)
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
        const raw = lines.filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n')
        if (!raw) continue
        const data = JSON.parse(raw) as Record<string, unknown>
        if (event === 'error') throw new Error(
          typeof data.message === 'string' ? data.message : 'Server stream failed'
        )
        if (event) handler(event, data)
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}

export async function consumeSse(
  response: Response,
  handlers: { delta: (text: string) => void; done?: () => void }
): Promise<void> {
  return consumeSseEvents(response, (event, data) => {
    if (event === 'delta' && typeof data.text === 'string') handlers.delta(data.text)
    else if (event === 'done') handlers.done?.()
  })
}

async function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url)
}

export interface ApiErrorBody {
  error?: string
  message?: string
  code?: string
}

export class ApiError extends Error {
  status: number
  body: ApiErrorBody
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error ?? `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

export const api = {
  async repositories(): Promise<string[]> {
    return (await getJson<{ repositories: string[] }>('/api/repositories')).repositories
  },

  async sources(type: 'BIBLE' | 'GENBOOK' | 'DICT' | 'COMMENTARY' = 'BIBLE'): Promise<ModuleInfo[]> {
    return (await getJson<{ modules: ModuleInfo[] }>(`/api/sources?type=${type}`)).modules
  },

  async catalog(refresh = false): Promise<CatalogPayload> {
    return refresh
      ? requestJson<CatalogPayload>('/api/catalog/refresh', { method: 'POST' })
      : getJson<CatalogPayload>('/api/catalog')
  },

  async installed(): Promise<ModuleInfo[]> {
    return (await getJson<{ modules: ModuleInfo[] }>('/api/sources/installed')).modules
  },

  async uninstall(module: string): Promise<void> {
    const res = await request(`/api/sources/${encodeURIComponent(module)}`, { method: 'DELETE' })
    if (!res.ok) throw new ApiError(res.status, {})
  },

  /** Install a module, streaming progress via SSE. Resolves when done. */
  install(repository: string, module: string, onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      request('/api/sources/install', json('POST', { repository, module }))
        .then((res) => {
          if (!res.ok) throw new ApiError(res.status, {})
          if (!res.body) return reject(new Error('no stream'))
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          const pump = (): Promise<void> =>
            reader.read().then(({ done, value }) => {
              if (done) return resolve()
              buffer += decoder.decode(value, { stream: true })
              const events = buffer.split('\n\n')
              buffer = events.pop() ?? ''
              for (const chunk of events) {
                const evLine = chunk.split('\n').find((l) => l.startsWith('event:'))
                const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))
                const ev = evLine?.slice(6).trim()
                const data = dataLine ? JSON.parse(dataLine.slice(5).trim()) : {}
                if (ev === 'progress') onProgress(data.pct)
                else if (ev === 'done') {
                  onProgress(100)
                  resolve()
                } else if (ev === 'error') reject(new Error(data.message))
              }
              return pump()
            })
          return pump()
        })
        .catch(reject)
    })
  },

  async importSword(file: File): Promise<string[]> {
    const body = new FormData()
    body.append('module', file)
    return (await requestJson<{ modules: string[] }>('/api/sources/import', { method: 'POST', body })).modules
  },

  async generalBookEntries(module: string): Promise<GeneralBookEntry[]> {
    return (await getJson<{ entries: GeneralBookEntry[] }>(`/api/general-books/${encodeURIComponent(module)}/entries`)).entries
  },

  async corpusPreferences(): Promise<Record<string, boolean>> {
    return (await getJson<{ preferences: Record<string, boolean> }>('/api/corpus/preferences')).preferences
  },

  async setCorpusPreference(module: string, enabled: boolean): Promise<void> {
    await requestJson('/api/corpus/preferences', json('PUT', { module, enabled, licenseAcknowledged: enabled }))
  },

  async books(module: string): Promise<BookEntry[]> {
    return (await getJson<{ books: BookEntry[] }>(`/api/modules/${encodeURIComponent(module)}/books`))
      .books
  },

  async chapter(module: string, book: string, chapter: number): Promise<ChapterPayload> {
    return getJson<ChapterPayload>(
      `/api/read/${encodeURIComponent(module)}/${encodeURIComponent(book)}/${chapter}`
    )
  },

  async compare(book: string, chapter: number, lo: number, hi: number, modules: string[]) {
    const verse = lo === hi ? `${lo}` : `${lo}-${hi}`
    return getJson<{ translations: CompareRow[]; bookName: string }>(
      `/api/compare/${encodeURIComponent(book)}/${chapter}/${verse}?modules=${modules.join(',')}`
    )
  },

  async strongs(key: string): Promise<StrongsPayload> {
    return getJson<StrongsPayload>(`/api/strongs/${encodeURIComponent(key)}`)
  },

  async commentary(module: string, book: string, chapter: number): Promise<CommentaryPayload> {
    return getJson<CommentaryPayload>(
      `/api/commentary/${encodeURIComponent(module)}/${encodeURIComponent(book)}/${chapter}`
    )
  },

  async search(q: string, modules: string[]): Promise<SearchHit[]> {
    const res = await getJson<{ results: SearchHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}&modules=${modules.join(',')}`
    )
    return res.results
  },

  async semanticSearch(query: string, modules: string[], limit = 50): Promise<SemanticSearchHit[]> {
    return (await requestJson<{ results: SemanticSearchHit[] }>(
      '/api/semantic-search',
      json('POST', { query, modules, limit })
    )).results
  },

  async connections(seeds: ConnectionSeed[]): Promise<ConnectionsPayload> {
    return requestJson<ConnectionsPayload>('/api/connections', json('POST', { seeds }))
  },

  async embeddingProvider(): Promise<EmbeddingProviderConfig | null> {
    return (await getJson<{ provider: EmbeddingProviderConfig | null }>('/api/embeddings/provider')).provider
  },

  async deploymentProviders(): Promise<DeploymentProviderMap> {
    return (await getJson<{ providers: DeploymentProviderMap }>('/api/providers/deployment')).providers
  },

  async saveEmbeddingProvider(input: {
    kind: EmbeddingProviderKind
    baseUrl: string
    model: string
    batchSize?: number
    apiKey?: string
    clearApiKey?: boolean
  }): Promise<EmbeddingProviderConfig> {
    return (await requestJson<{ provider: EmbeddingProviderConfig }>(
      '/api/embeddings/provider', json('PUT', input)
    )).provider
  },

  async removeEmbeddingProvider(): Promise<void> {
    return requestVoid('/api/embeddings/provider', { method: 'DELETE' })
  },

  async semanticIndexStatus(): Promise<SemanticIndexStatus> {
    return (await getJson<{ index: SemanticIndexStatus }>('/api/semantic-index')).index
  },

  async rebuildSemanticIndex(
    onProgress: (progress: { module: string; processed: number; batchSize: number }) => void
  ): Promise<SemanticIndexStatus> {
    const response = await request('/api/semantic-index/rebuild', { method: 'POST' })
    if (!response.ok) {
      throw new ApiError(response.status, (await response.json().catch(() => ({}))) as ApiErrorBody)
    }
    let status: SemanticIndexStatus | null = null
    await consumeSseEvents(response, (event, data) => {
      if (
        event === 'progress'
        && typeof data.module === 'string'
        && typeof data.processed === 'number'
        && typeof data.batchSize === 'number'
      ) {
        onProgress({ module: data.module, processed: data.processed, batchSize: data.batchSize })
      } else if (event === 'done') {
        status = data as unknown as SemanticIndexStatus
      }
    })
    if (!status) throw new Error('Index rebuild ended without a final status')
    return status
  },

  async notes(): Promise<Note[]> {
    return (await getJson<{ notes: Note[] }>('/api/notes')).notes
  },

  async createNote(seed: Partial<Pick<Note, 'title' | 'body' | 'tags' | 'refs'>> = {}): Promise<Note> {
    return (await requestJson<{ note: Note }>('/api/notes', json('POST', seed))).note
  },

  async updateNote(id: string, patch: Partial<Pick<Note, 'title' | 'body' | 'tags' | 'refs'>>): Promise<Note> {
    return (await requestJson<{ note: Note }>(
      `/api/notes/${encodeURIComponent(id)}`,
      json('PATCH', patch)
    )).note
  },

  async deleteNote(id: string): Promise<void> {
    return requestVoid(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async highlights(): Promise<Highlight[]> {
    return (await getJson<{ highlights: Highlight[] }>('/api/highlights')).highlights
  },

  async setHighlight(key: string, color: string): Promise<void> {
    return requestVoid('/api/highlights', json('PUT', { key, color }))
  },

  async deleteHighlight(key: string): Promise<void> {
    return requestVoid(`/api/highlights/${encodeURIComponent(key)}`, { method: 'DELETE' })
  },

  async updateHighlights(set: Highlight[], remove: string[]): Promise<void> {
    return requestVoid('/api/highlights/batch', json('POST', { set, remove }))
  },

  async importPersonalData(notes: Note[], highlights: Highlight[]): Promise<PersonalDataImportResult> {
    return requestJson<PersonalDataImportResult>(
      '/api/personal-data/import',
      json('POST', { notes, highlights })
    )
  },

  async aiProvider(): Promise<AiProviderConfig | null> {
    return (await getJson<{ provider: AiProviderConfig | null }>('/api/ai/provider')).provider
  },

  async saveAiProvider(input: {
    kind: AiProviderKind
    baseUrl: string
    model: string
    apiKey?: string
    clearApiKey?: boolean
  }): Promise<AiProviderConfig> {
    return (await requestJson<{ provider: AiProviderConfig }>(
      '/api/ai/provider',
      json('PUT', input)
    )).provider
  },

  async removeAiProvider(): Promise<void> {
    return requestVoid('/api/ai/provider', { method: 'DELETE' })
  },

  async ttsConfig(): Promise<TtsConfig> {
    return (await getJson<{ config: TtsConfig }>('/api/tts/config')).config
  },

  async saveTtsConfig(input: {
    order: TtsTier[]
    local: TtsEndpointInput | null
    cloud: TtsEndpointInput | null
  }): Promise<TtsConfig> {
    return (await requestJson<{ config: TtsConfig }>(
      '/api/tts/config', json('PUT', input)
    )).config
  },

  async ttsSpeech(provider: 'local' | 'cloud', text: string, signal?: AbortSignal): Promise<Blob> {
    const response = await request('/api/tts/speech', { ...json('POST', { provider, text }), signal })
    if (!response.ok) {
      throw new ApiError(
        response.status,
        (await response.json().catch(() => ({}))) as ApiErrorBody
      )
    }
    return response.blob()
  },

  async sttConfig(): Promise<SttConfig> {
    return (await getJson<{ config: SttConfig }>('/api/stt/config')).config
  },

  async saveSttConfig(input: {
    order: SttTier[]
    local: SttEndpointInput | null
    cloud: SttEndpointInput | null
  }): Promise<SttConfig> {
    return (await requestJson<{ config: SttConfig }>(
      '/api/stt/config', json('PUT', input)
    )).config
  },

  async checkStt(
    tier: 'local' | 'cloud',
    endpoint?: SttEndpointInput,
    signal?: AbortSignal
  ): Promise<SttConnectionResult> {
    return requestJson<SttConnectionResult>(
      '/api/stt/check',
      { ...json('POST', { tier, ...(endpoint ? { endpoint } : {}) }), signal }
    )
  },

  async discoverProvider(input: ProviderDiscoveryInput, signal?: AbortSignal): Promise<ProviderDiscoveryResult> {
    return requestJson<ProviderDiscoveryResult>(
      '/api/providers/discover', { ...json('POST', input), signal }
    )
  },

  async sttTranscription(
    provider: 'local' | 'cloud',
    audio: Blob,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<string> {
    const form = new FormData()
    form.set('provider', provider)
    form.set('durationMs', String(durationMs))
    form.set('file', audio, `recording.${audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm'}`)
    return (await requestJson<{ text: string }>(
      '/api/stt/transcriptions', { method: 'POST', body: form, signal }
    )).text
  },

  async streamChat(
    input: ChatRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await request('/api/ai/chat', { ...json('POST', input), signal })
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as ApiErrorBody)
    await consumeSse(res, { delta: onDelta })
  },

  async authStatus(): Promise<AuthStatus> {
    return requestJson<AuthStatus>('/api/auth/status', undefined, false)
  },

  async bootstrap(username: string, password: string): Promise<AuthUser> {
    return (await requestJson<{ user: AuthUser }>(
      '/api/auth/bootstrap',
      json('POST', { username, password }),
      false
    )).user
  },

  async login(username: string, password: string): Promise<AuthUser> {
    return (await requestJson<{ user: AuthUser }>(
      '/api/auth/login',
      json('POST', { username, password }),
      false
    )).user
  },

  async logout(): Promise<void> {
    return requestVoid('/api/auth/logout', json('POST'))
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return requestVoid('/api/auth/password', json('POST', { currentPassword, newPassword }))
  },

  async users(): Promise<ManagedUser[]> {
    return (await getJson<{ users: ManagedUser[] }>('/api/users')).users
  },

  async createUser(username: string, password: string, role: UserRole): Promise<ManagedUser> {
    return (await requestJson<{ user: ManagedUser }>(
      '/api/users',
      json('POST', { username, password, role })
    )).user
  },

  async setUserDisabled(id: string, disabled: boolean): Promise<void> {
    return requestVoid(`/api/users/${encodeURIComponent(id)}`, json('PATCH', { disabled }))
  },

  async resetUserPassword(id: string, password: string): Promise<void> {
    return requestVoid(`/api/users/${encodeURIComponent(id)}/password`, json('POST', { password }))
  }
}
