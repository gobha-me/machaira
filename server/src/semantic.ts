import { createHash, randomUUID } from 'node:crypto'
import type { MachairaDatabase } from './database.js'
import type { SecretStore } from './secrets.js'
import {
  getModuleBooks,
  listInstalledModules,
  readPlainChapter,
  type ModuleBook,
  type PlainVerse,
  type RepoModuleInfo
} from './sword.js'

export type EmbeddingProviderKind = 'openai-compatible' | 'local'

export interface EmbeddingProviderConfig {
  kind: EmbeddingProviderKind
  baseUrl: string
  model: string
  batchSize: number
  hasApiKey: boolean
}

export interface SemanticIndexStatus {
  state: 'unconfigured' | 'empty' | 'building' | 'ready' | 'stale' | 'failed'
  chunkCount: number
  modules: string[]
  model: string | null
  updatedAt: number | null
  lastError: string | null
}

export interface SemanticSearchHit {
  module: string
  book: string
  bookName: string
  chapter: number
  verse: number
  content: string
  distance: number
}

export interface SemanticPassageSeed {
  module: string
  book: string
  chapter: number
  verseStart: number | null
  verseEnd: number | null
}

export interface SemanticNeighborResult {
  state: SemanticIndexStatus['state']
  results: SemanticSearchHit[]
}

interface StoredEmbeddingConfig {
  kind: EmbeddingProviderKind
  base_url: string
  model: string
  batch_size: number
}

interface RunRow {
  id: string
  user_id: string
  provider_signature: string
  module_signature: string
  dimension: number | null
  status: 'building' | 'ready' | 'failed'
  chunk_count: number
  created_at: number
  completed_at: number | null
  error: string | null
}

export interface SemanticSources {
  installed(): Promise<RepoModuleInfo[]>
  books(module: string): Promise<ModuleBook[]>
  chapter(module: string, book: string, chapter: number): Promise<PlainVerse[]>
}

const DEFAULT_SOURCES: SemanticSources = {
  installed: listInstalledModules,
  books: getModuleBooks,
  chapter: readPlainChapter
}

const API_KEY_SECRET = 'embedding-provider-api-key'
const DEFAULT_URLS: Record<EmbeddingProviderKind, string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  local: 'http://127.0.0.1:11434/v1'
}
const PROVIDER_KINDS = new Set<EmbeddingProviderKind>(['openai-compatible', 'local'])
const DEFAULT_REBUILD_BATCH_SIZE = 32
const MAX_EMBEDDING_BATCH_SIZE = 64
const MAX_DIMENSION = 8192

export class SemanticInputError extends Error {}
export class SemanticStateError extends Error {}
export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseBody?: string
  ) {
    super(message)
    this.name = 'EmbeddingProviderError'
  }
}

function stringField(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new SemanticInputError(`${name} is required`)
  const result = value.trim()
  if (result.length > max) throw new SemanticInputError(`${name} is too long`)
  return result
}

function integerField(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SemanticInputError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function providerUrl(value: unknown, kind: EmbeddingProviderKind): string {
  const raw = value == null || value === '' ? DEFAULT_URLS[kind] : stringField(value, 'Base URL', 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SemanticInputError('Base URL must be a valid HTTP or HTTPS URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SemanticInputError('Base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SemanticInputError('Base URL cannot include credentials, a query, or a fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function endpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
  return url.toString()
}

function signature(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function providerSignature(config: EmbeddingProviderConfig): string {
  return signature({ kind: config.kind, baseUrl: config.baseUrl, model: config.model })
}

function bibleModules(modules: RepoModuleInfo[]): RepoModuleInfo[] {
  return modules
    .filter((module) => module.type === 'BIBLE' && !module.locked)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function moduleSignature(modules: RepoModuleInfo[]): string {
  return signature(bibleModules(modules).map((module) => ({
    name: module.name,
    version: module.version ?? null
  })))
}

function vectorTable(dimension: number): string {
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_DIMENSION) {
    throw new EmbeddingProviderError(`Provider returned an unsupported embedding dimension (${dimension})`)
  }
  return `semantic_vectors_d${dimension}`
}

function ensureVectorTable(db: MachairaDatabase, dimension: number): string {
  const table = vectorTable(dimension)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimension}] distance_metric=cosine,
      run_id TEXT PARTITION KEY,
      module TEXT
    )
  `)
  return table
}

async function limitedBody(response: Response, max = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ''
  try {
    while (result.length <= max) {
      const { done, value } = await reader.read()
      result += decoder.decode(value, { stream: !done })
      if (done) break
    }
  } finally {
    if (result.length > max) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (result.length > max) throw new EmbeddingProviderError('Provider returned an oversized response')
  return result
}

export class EmbeddingProviderService {
  constructor(
    private readonly db: MachairaDatabase,
    private readonly secrets: SecretStore
  ) {}

  get(userId: string): EmbeddingProviderConfig | null {
    const row = this.db.prepare(`
      SELECT kind, base_url, model, batch_size FROM embedding_provider_configs WHERE user_id = ?
    `).get(userId) as StoredEmbeddingConfig | undefined
    if (!row) return null
    return {
      kind: row.kind,
      baseUrl: row.base_url,
      model: row.model,
      batchSize: row.batch_size,
      hasApiKey: this.secrets.has(userId, API_KEY_SECRET)
    }
  }

  save(userId: string, input: unknown): EmbeddingProviderConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new SemanticInputError('Embedding provider configuration is required')
    }
    const body = input as Record<string, unknown>
    if (typeof body.kind !== 'string' || !PROVIDER_KINDS.has(body.kind as EmbeddingProviderKind)) {
      throw new SemanticInputError('Embedding provider kind is invalid')
    }
    const kind = body.kind as EmbeddingProviderKind
    const baseUrl = providerUrl(body.baseUrl, kind)
    const model = stringField(body.model, 'Embedding model', 200)
    const existing = this.get(userId)
    const batchSize = body.batchSize === undefined
      ? existing?.batchSize ?? DEFAULT_REBUILD_BATCH_SIZE
      : integerField(body.batchSize, 'Embedding batch size', 1, MAX_EMBEDDING_BATCH_SIZE)
    const apiKey = body.apiKey === undefined ? undefined : stringField(body.apiKey, 'API key', 4096)
    if (body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean') {
      throw new SemanticInputError('clearApiKey must be a boolean')
    }
    if (apiKey !== undefined && body.clearApiKey === true) {
      throw new SemanticInputError('Cannot replace and clear the API key together')
    }

    const kindChanged = existing !== null && existing.kind !== kind
    const willHaveKey = apiKey !== undefined
      || (!kindChanged && body.clearApiKey !== true && existing?.hasApiKey === true)
    if (kind === 'openai-compatible' && !willHaveKey) {
      throw new SemanticInputError('An API key is required for this provider')
    }

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO embedding_provider_configs (user_id, kind, base_url, model, batch_size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          kind = excluded.kind,
          base_url = excluded.base_url,
          model = excluded.model,
          batch_size = excluded.batch_size,
          updated_at = excluded.updated_at
      `).run(userId, kind, baseUrl, model, batchSize, Date.now())
      if (apiKey !== undefined) this.secrets.set(userId, API_KEY_SECRET, apiKey)
      else if (body.clearApiKey === true || kindChanged) this.secrets.remove(userId, API_KEY_SECRET)
    })()
    return this.get(userId)!
  }

  remove(userId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM embedding_provider_configs WHERE user_id = ?').run(userId)
      this.secrets.remove(userId, API_KEY_SECRET)
    })()
  }

  credentials(userId: string): { config: EmbeddingProviderConfig; apiKey: string | null } {
    const config = this.get(userId)
    if (!config) throw new SemanticStateError('Configure an embedding provider in Settings first')
    const apiKey = this.secrets.get(userId, API_KEY_SECRET)
    if (config.kind === 'openai-compatible' && !apiKey) {
      throw new SemanticStateError('The configured embedding provider needs an API key')
    }
    return { config, apiKey }
  }
}

export async function requestEmbeddings(
  credentials: { config: EmbeddingProviderConfig; apiKey: string | null },
  inputs: string[],
  signal?: AbortSignal
): Promise<number[][]> {
  if (inputs.length < 1 || inputs.length > MAX_EMBEDDING_BATCH_SIZE) {
    throw new SemanticInputError(
      `Embedding batches must contain between 1 and ${MAX_EMBEDDING_BATCH_SIZE} inputs`
    )
  }
  if (inputs.some((input) => !input || input.length > 20_000)) {
    throw new SemanticInputError('Embedding inputs must contain between 1 and 20,000 characters')
  }
  const timeout = AbortSignal.timeout(60_000)
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (credentials.apiKey) headers.authorization = `Bearer ${credentials.apiKey}`

  let response: Response
  try {
    response = await fetch(endpoint(credentials.config.baseUrl, 'embeddings'), {
      method: 'POST',
      redirect: 'error',
      signal: combinedSignal,
      headers,
      body: JSON.stringify({ model: credentials.config.model, input: inputs })
    })
  } catch (error) {
    if (combinedSignal.aborted) throw new EmbeddingProviderError('Embedding request timed out or was cancelled')
    throw new EmbeddingProviderError(`Could not reach embedding provider: ${(error as Error).message}`)
  }

  const raw = await limitedBody(response)
  if (!response.ok) {
    const detail = raw.slice(0, 2000)
    throw new EmbeddingProviderError(
      `Embedding provider rejected the request (${response.status}): ${detail || response.statusText}`,
      response.status,
      detail
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new EmbeddingProviderError('Embedding provider returned invalid JSON')
  }
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new EmbeddingProviderError('Embedding provider returned the wrong number of vectors')
  }
  const ordered = data.map((entry, fallbackIndex) => {
    const item = entry as { index?: unknown; embedding?: unknown }
    const index = typeof item.index === 'number' ? item.index : fallbackIndex
    if (!Array.isArray(item.embedding) || item.embedding.length < 1 || item.embedding.length > MAX_DIMENSION) {
      throw new EmbeddingProviderError('Embedding provider returned an invalid vector')
    }
    const embedding = item.embedding.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbeddingProviderError('Embedding provider returned a non-numeric vector')
      }
      return value
    })
    return { index, embedding }
  }).sort((left, right) => left.index - right.index)

  if (ordered.some((entry, index) => entry.index !== index)) {
    throw new EmbeddingProviderError('Embedding provider returned invalid vector indexes')
  }
  const dimension = ordered[0].embedding.length
  if (ordered.some((entry) => entry.embedding.length !== dimension)) {
    throw new EmbeddingProviderError('Embedding provider returned inconsistent vector dimensions')
  }
  return ordered.map((entry) => entry.embedding)
}

interface AdaptiveEmbeddingResult {
  vectors: number[][]
  reducedBatchSize: number | null
}

function isBatchLimitError(error: unknown): error is EmbeddingProviderError {
  if (!(error instanceof EmbeddingProviderError) || ![400, 413, 422].includes(error.status ?? 0)) {
    return false
  }
  const detail = `${error.responseBody ?? ''}\n${error.message}`
  return /\bbatch(?:[\s_-]+size)?\b/i.test(detail)
    && /(?:too[\s_-]+(?:large|many)|max(?:imum)?|limit|exceed|greater[\s_-]+than|>)/i.test(detail)
}

function reportedBatchLimit(error: EmbeddingProviderError, attempted: number): number | null {
  const detail = `${error.responseBody ?? ''}\n${error.message}`
  const patterns = [
    /max(?:imum)?(?:\s+allowed)?\s+batch(?:\s+size)?\D{0,12}(\d+)/i,
    /batch(?:\s+size)?\s+(?:limit|max(?:imum)?|must\s+be)\D{0,12}(\d+)/i,
    /(?:limit|max(?:imum)?)\D{0,12}(\d+)\s+(?:inputs?|items?)/i
  ]
  for (const pattern of patterns) {
    const value = Number(detail.match(pattern)?.[1])
    if (Number.isSafeInteger(value) && value >= 1 && value < attempted) return value
  }
  return null
}

async function requestEmbeddingsAdaptive(
  credentials: { config: EmbeddingProviderConfig; apiKey: string | null },
  inputs: string[],
  signal?: AbortSignal
): Promise<AdaptiveEmbeddingResult> {
  try {
    return { vectors: await requestEmbeddings(credentials, inputs, signal), reducedBatchSize: null }
  } catch (error) {
    if (!isBatchLimitError(error) || inputs.length === 1 || signal?.aborted) throw error

    const chunkSize = reportedBatchLimit(error, inputs.length)
      ?? Math.max(1, Math.floor(inputs.length / 2))
    const vectors: number[][] = []
    let reducedBatchSize = chunkSize
    for (let start = 0; start < inputs.length; start += chunkSize) {
      const result = await requestEmbeddingsAdaptive(
        credentials,
        inputs.slice(start, start + chunkSize),
        signal
      )
      vectors.push(...result.vectors)
      if (result.reducedBatchSize !== null) {
        reducedBatchSize = Math.min(reducedBatchSize, result.reducedBatchSize)
      }
    }
    const dimension = vectors[0]?.length
    if (!dimension || vectors.some((vector) => vector.length !== dimension)) {
      throw new EmbeddingProviderError('Embedding dimension changed within a retried batch')
    }
    return { vectors, reducedBatchSize }
  }
}

export class SemanticIndexService {
  private readonly building = new Set<string>()

  constructor(
    private readonly db: MachairaDatabase,
    private readonly providers: EmbeddingProviderService,
    private readonly sources: SemanticSources = DEFAULT_SOURCES
  ) {
    const interrupted = this.db.prepare(`
      SELECT * FROM semantic_index_runs WHERE status = 'building'
    `).all() as RunRow[]
    for (const run of interrupted) {
      this.cleanupVectors(run.id, run.dimension)
      this.db.prepare('DELETE FROM semantic_chunks WHERE run_id = ?').run(run.id)
      this.db.prepare(`
        UPDATE semantic_index_runs
        SET status = 'failed', chunk_count = 0, completed_at = ?, error = ?
        WHERE id = ?
      `).run(Date.now(), 'Index rebuild was interrupted by a server restart', run.id)
    }
  }

  async status(userId: string): Promise<SemanticIndexStatus> {
    const provider = this.providers.get(userId)
    if (!provider) return {
      state: 'unconfigured', chunkCount: 0, modules: [], model: null, updatedAt: null, lastError: null
    }
    const modules = bibleModules(await this.sources.installed())
    const active = this.activeRun(userId)
    const latest = this.latestRun(userId)
    const stale = active !== null && (
      active.provider_signature !== providerSignature(provider)
      || active.module_signature !== moduleSignature(modules)
    )
    const state = this.building.has(userId)
      ? 'building'
      : active
        ? stale ? 'stale' : 'ready'
        : latest?.status === 'failed' ? 'failed' : 'empty'
    return {
      state,
      chunkCount: active?.chunk_count ?? 0,
      modules: active ? this.runModules(active.id) : [],
      model: active ? provider.model : null,
      updatedAt: active?.completed_at ?? null,
      lastError: latest?.status === 'failed' ? latest.error : null
    }
  }

  async rebuild(
    userId: string,
    onProgress: (progress: { module: string; processed: number; batchSize: number }) => void,
    signal?: AbortSignal
  ): Promise<SemanticIndexStatus> {
    if (this.building.has(userId)) throw new SemanticStateError('An index rebuild is already running')
    const credentials = this.providers.credentials(userId)
    const modules = bibleModules(await this.sources.installed())
    if (modules.length === 0) throw new SemanticStateError('Install at least one unlocked Bible module first')

    this.building.add(userId)
    const runId = randomUUID()
    let dimension: number | null = null
    let processed = 0
    let effectiveBatchSize = credentials.config.batchSize
    this.db.prepare(`
      INSERT INTO semantic_index_runs
        (id, user_id, provider_signature, module_signature, status, created_at)
      VALUES (?, ?, ?, ?, 'building', ?)
    `).run(runId, userId, providerSignature(credentials.config), moduleSignature(modules), Date.now())

    try {
      for (const module of modules) {
        const pending: PlainVerse[] = []
        const flush = async () => {
          if (pending.length === 0) return
          if (signal?.aborted) throw new EmbeddingProviderError('Index rebuild was cancelled')
          const batch = pending.splice(0, effectiveBatchSize)
          const result = await requestEmbeddingsAdaptive(credentials, batch.map((verse) =>
            `${verse.bookName} ${verse.chapter}:${verse.verse}\n${verse.content}`), signal)
          if (result.reducedBatchSize !== null) {
            effectiveBatchSize = Math.min(effectiveBatchSize, result.reducedBatchSize)
          }
          const vectors = result.vectors
          const batchDimension = vectors[0].length
          if (dimension === null) {
            dimension = batchDimension
            ensureVectorTable(this.db, dimension)
            this.db.prepare('UPDATE semantic_index_runs SET dimension = ? WHERE id = ?')
              .run(dimension, runId)
          } else if (batchDimension !== dimension) {
            throw new EmbeddingProviderError('Embedding dimension changed during rebuild')
          }
          const table = ensureVectorTable(this.db, dimension)
          const insertChunk = this.db.prepare(`
            INSERT INTO semantic_chunks
              (run_id, module, book, book_name, chapter, verse, content)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          const insertVector = this.db.prepare(`
            INSERT INTO ${table} (chunk_id, embedding, run_id, module) VALUES (?, ?, ?, ?)
          `)
          this.db.transaction(() => {
            for (let index = 0; index < batch.length; index += 1) {
              const verse = batch[index]
              const result = insertChunk.run(
                runId, verse.module, verse.book, verse.bookName,
                verse.chapter, verse.verse, verse.content
              )
              insertVector.run(
                BigInt(result.lastInsertRowid),
                Buffer.from(new Float32Array(vectors[index]).buffer),
                runId,
                verse.module
              )
            }
          })()
          processed += batch.length
          this.db.prepare('UPDATE semantic_index_runs SET chunk_count = ? WHERE id = ?')
            .run(processed, runId)
          onProgress({ module: module.name, processed, batchSize: effectiveBatchSize })
        }

        for (const book of await this.sources.books(module.name)) {
          for (let chapter = 1; chapter <= book.chapters; chapter += 1) {
            for (const verse of await this.sources.chapter(module.name, book.code, chapter)) {
              pending.push(verse)
              if (pending.length === effectiveBatchSize) await flush()
            }
          }
        }
        while (pending.length > 0) await flush()
      }
      if (processed === 0 || dimension === null) throw new SemanticStateError('Installed modules contained no indexable verses')

      const previous = this.activeRun(userId)
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE semantic_index_runs
          SET status = 'ready', chunk_count = ?, completed_at = ?, error = NULL
          WHERE id = ?
        `).run(processed, Date.now(), runId)
        this.db.prepare(`
          INSERT INTO semantic_active_indexes (user_id, run_id) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET run_id = excluded.run_id
        `).run(userId, runId)
      })()
      if (previous && previous.id !== runId) this.removeRun(previous)
      this.building.delete(userId)
      return await this.status(userId)
    } catch (error) {
      this.cleanupVectors(runId, dimension)
      this.db.prepare('DELETE FROM semantic_chunks WHERE run_id = ?').run(runId)
      this.db.prepare(`
        UPDATE semantic_index_runs
        SET status = 'failed', chunk_count = 0, completed_at = ?, error = ?
        WHERE id = ?
      `).run(Date.now(), (error as Error).message.slice(0, 2000), runId)
      throw error
    } finally {
      this.building.delete(userId)
    }
  }

  async search(userId: string, input: unknown, signal?: AbortSignal): Promise<SemanticSearchHit[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new SemanticInputError('Semantic search request is required')
    }
    const body = input as Record<string, unknown>
    const query = stringField(body.query, 'Query', 1000)
    if (!Array.isArray(body.modules) || body.modules.length < 1 || body.modules.length > 50) {
      throw new SemanticInputError('Modules must contain between 1 and 50 names')
    }
    const requested = body.modules.map((module, index) => stringField(module, `Module ${index + 1}`, 200))
    const limit = body.limit === undefined ? 50 : Number(body.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SemanticInputError('Result limit must be between 1 and 100')
    }

    const credentials = this.providers.credentials(userId)
    const installed = bibleModules(await this.sources.installed())
    const active = this.activeRun(userId)
    if (!active || active.dimension === null) throw new SemanticStateError('Build the semantic index in Settings first')
    if (
      active.provider_signature !== providerSignature(credentials.config)
      || active.module_signature !== moduleSignature(installed)
    ) throw new SemanticStateError('The semantic index is stale; rebuild it in Settings')

    const installedNames = new Set(installed.map((module) => module.name))
    const modules = [...new Set(requested)].filter((module) => installedNames.has(module))
    if (modules.length === 0) return []
    const [vector] = await requestEmbeddings(credentials, [query], signal)
    if (vector.length !== active.dimension) {
      throw new SemanticStateError('The provider embedding dimension changed; rebuild the index')
    }
    const table = ensureVectorTable(this.db, active.dimension)
    const nearest = this.db.prepare(`
      SELECT chunk_id, distance FROM ${table}
      WHERE embedding MATCH ? AND k = ? AND run_id = ? AND module = ?
      ORDER BY distance
    `)
    const ranked: Array<{ chunkId: number | bigint; distance: number }> = []
    const queryVector = Buffer.from(new Float32Array(vector).buffer)
    for (const module of modules) {
      const rows = nearest.all(queryVector, limit, active.id, module) as Array<{
        chunk_id: number | bigint
        distance: number
      }>
      ranked.push(...rows.map((row) => ({ chunkId: row.chunk_id, distance: row.distance })))
    }
    ranked.sort((left, right) => left.distance - right.distance)

    const getChunk = this.db.prepare(`
      SELECT module, book, book_name, chapter, verse, content
      FROM semantic_chunks WHERE id = ? AND run_id = ?
    `)
    return ranked.slice(0, limit).flatMap((match) => {
      const chunk = getChunk.get(match.chunkId, active.id) as {
        module: string
        book: string
        book_name: string
        chapter: number
        verse: number
        content: string
      } | undefined
      return chunk ? [{
        module: chunk.module,
        book: chunk.book,
        bookName: chunk.book_name,
        chapter: chunk.chapter,
        verse: chunk.verse,
        content: chunk.content,
        distance: match.distance
      }] : []
    })
  }

  /**
   * Find neighbors for already-indexed Scripture without contacting the embedding provider.
   * Range and chapter seeds use the mean of their stored verse vectors.
   */
  async neighbors(
    userId: string,
    seed: SemanticPassageSeed,
    limit = 4
  ): Promise<SemanticNeighborResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new SemanticInputError('Neighbor limit must be between 1 and 20')
    }
    const status = await this.status(userId)
    if (status.state !== 'ready') return { state: status.state, results: [] }

    const active = this.activeRun(userId)
    if (!active || active.dimension === null) return { state: status.state, results: [] }
    const table = ensureVectorTable(this.db, active.dimension)
    const sourceChunks = this.db.prepare(`
      SELECT id, verse FROM semantic_chunks
      WHERE run_id = ? AND module = ? AND book = ? AND chapter = ?
        AND (? IS NULL OR verse >= ?)
        AND (? IS NULL OR verse <= ?)
      ORDER BY verse
    `).all(
      active.id, seed.module, seed.book, seed.chapter,
      seed.verseStart, seed.verseStart,
      seed.verseEnd, seed.verseEnd
    ) as Array<{ id: number | bigint; verse: number }>
    if (sourceChunks.length === 0) return { state: status.state, results: [] }

    const getVector = this.db.prepare(`SELECT embedding FROM ${table} WHERE chunk_id = ? AND run_id = ?`)
    const average = new Float32Array(active.dimension)
    let vectorCount = 0
    for (const chunk of sourceChunks) {
      const row = getVector.get(chunk.id, active.id) as { embedding: Buffer } | undefined
      if (!row) continue
      // Copy out of Node's pooled Buffer so the Float32Array always starts at an aligned offset.
      const vector = new Float32Array(Uint8Array.from(row.embedding).buffer)
      if (vector.length !== active.dimension) continue
      for (let index = 0; index < vector.length; index += 1) average[index] += vector[index]
      vectorCount += 1
    }
    if (vectorCount === 0) return { state: status.state, results: [] }
    for (let index = 0; index < average.length; index += 1) average[index] /= vectorCount
    const magnitude = Math.sqrt(average.reduce((sum, value) => sum + value * value, 0))
    if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) {
      return { state: status.state, results: [] }
    }

    const nearest = this.db.prepare(`
      SELECT chunk_id, distance FROM ${table}
      WHERE embedding MATCH ? AND k = ? AND run_id = ? AND module = ?
      ORDER BY distance
    `).all(
      Buffer.from(average.buffer),
      Math.min(512, limit + sourceChunks.length + 8),
      active.id,
      seed.module
    ) as Array<{ chunk_id: number | bigint; distance: number }>
    const sourceIds = new Set(sourceChunks.map((chunk) => String(chunk.id)))
    const getChunk = this.db.prepare(`
      SELECT module, book, book_name, chapter, verse, content
      FROM semantic_chunks WHERE id = ? AND run_id = ?
    `)
    return {
      state: status.state,
      results: nearest.flatMap((match) => {
        if (sourceIds.has(String(match.chunk_id))) return []
        const chunk = getChunk.get(match.chunk_id, active.id) as {
          module: string
          book: string
          book_name: string
          chapter: number
          verse: number
          content: string
        } | undefined
        return chunk ? [{
          module: chunk.module,
          book: chunk.book,
          bookName: chunk.book_name,
          chapter: chunk.chapter,
          verse: chunk.verse,
          content: chunk.content,
          distance: match.distance
        }] : []
      }).slice(0, limit)
    }
  }

  private activeRun(userId: string): RunRow | null {
    return this.db.prepare(`
      SELECT r.* FROM semantic_active_indexes a
      JOIN semantic_index_runs r ON r.id = a.run_id
      WHERE a.user_id = ? AND r.status = 'ready'
    `).get(userId) as RunRow | undefined ?? null
  }

  private latestRun(userId: string): RunRow | null {
    return this.db.prepare(`
      SELECT * FROM semantic_index_runs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(userId) as RunRow | undefined ?? null
  }

  private runModules(runId: string): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT module FROM semantic_chunks WHERE run_id = ? ORDER BY module
    `).all(runId) as Array<{ module: string }>).map((row) => row.module)
  }

  private cleanupVectors(runId: string, dimension: number | null): void {
    if (dimension === null) return
    const table = ensureVectorTable(this.db, dimension)
    this.db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId)
  }

  private removeRun(run: RunRow): void {
    this.cleanupVectors(run.id, run.dimension)
    this.db.prepare('DELETE FROM semantic_index_runs WHERE id = ?').run(run.id)
  }
}
