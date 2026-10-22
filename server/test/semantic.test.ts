import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import timers from 'node:timers/promises'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { openDatabase } from '../src/database.ts'
import { SecretStore } from '../src/secrets.ts'
import {
  EmbeddingProviderService,
  SemanticIndexService,
  type SemanticSources
} from '../src/semantic.ts'

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: Error) => response.destroy(error))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      // Timeout tests deliberately leave response bodies unfinished.
      server.closeAllConnections()
    })
  }
}

async function requestBody(request: IncomingMessage): Promise<{ input: string[] }> {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw) as { input: string[] }
}

function seedUser(db: ReturnType<typeof openDatabase>, id = 'user-1'): void {
  db.prepare(`
    INSERT INTO users (id, username, username_normalized, password_hash, role, created_at)
    VALUES (?, 'Owner', 'owner', 'hash', 'admin', 1)
  `).run(id)
}

const sources: SemanticSources = {
  async installed() {
    return [{
      id: 'CrossWire:WEB', name: 'WEB', type: 'BIBLE', description: 'World English Bible', language: 'en',
      version: '1', hasStrongs: false, hasGreekStrongsKeys: false,
      hasHebrewStrongsKeys: false, hasFootnotes: false, hasHeadings: false,
      hasRedLetterWords: false, hasCrossReferences: false, locked: false, installed: true,
      kind: 'scripture', collection: 'bible', coverage: [], coverageSource: 'live',
      format: 'bundled', coverageSummary: 'No additional books',
      aiEligibility: 'public-domain'
    }]
  },
  async books() {
    return [{ code: 'John', name: 'John', section: 'nt', chapters: 1 }]
  },
  async chapter() {
    return [
      { module: 'WEB', book: 'John', bookName: 'John', chapter: 1, verse: 1, content: 'Love one another.' },
      { module: 'WEB', book: 'John', bookName: 'John', chapter: 1, verse: 2, content: 'Grace and truth.' },
      { module: 'WEB', book: 'John', bookName: 'John', chapter: 1, verse: 3, content: 'A lamp in darkness.' }
    ]
  }
}

function generatedSources(verseCount: number): SemanticSources {
  return {
    ...sources,
    async chapter() {
      return Array.from({ length: verseCount }, (_, index) => ({
        module: 'WEB',
        book: 'John',
        bookName: 'John',
        chapter: 1,
        verse: index + 1,
        content: `Generated verse ${index + 1}.`
      }))
    }
  }
}

function sendVectors(response: ServerResponse, inputs: string[]): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    data: inputs.map((_input, index) => ({ index, embedding: [1, index % 2] }))
  }))
}

function recordRetryDelays(t: TestContext): number[] {
  const delays: number[] = []
  // Keep HTTP/abort handling real while observing backoff without waiting 30s.
  t.mock.method(timers, 'setTimeout', async (milliseconds: number) => {
    delays.push(milliseconds)
  })
  return delays
}

describe('semantic index', () => {
  it('keeps a deployment-default index ready across database reopen and detects changed defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-default-index-'))
    const filename = join(dir, 'machaira.sqlite')
    const key = randomBytes(32)
    const upstream = await listen(async (request, response) => {
      assert.equal(request.headers.authorization, undefined)
      sendVectors(response, (await requestBody(request)).input)
    })
    const descriptor = {
      source: 'external' as const, engine: 'tei', baseUrl: `${upstream.baseUrl}/`,
      model: 'minilm', batchSize: 16
    }
    let db = openDatabase(filename)
    try {
      seedUser(db)
      let providers = new EmbeddingProviderService(db, new SecretStore(db, key), descriptor)
      assert.equal((await new SemanticIndexService(db, providers, sources).rebuild('user-1', () => undefined)).state, 'ready')
      db.close()
      db = openDatabase(filename)
      providers = new EmbeddingProviderService(db, new SecretStore(db, key), { ...descriptor, baseUrl: upstream.baseUrl })
      const index = new SemanticIndexService(db, providers, sources)
      assert.equal((await index.status('user-1')).state, 'ready')
      assert.equal((await index.search('user-1', { query: 'love', modules: ['WEB'] })).length, 3)
      const changed = new EmbeddingProviderService(db, new SecretStore(db, key), { ...descriptor, model: 'different-model' })
      assert.equal((await new SemanticIndexService(db, changed, sources).status('user-1')).state, 'stale')
      providers.remove('user-1')
      db.close()
      db = openDatabase(filename)
      providers = new EmbeddingProviderService(db, new SecretStore(db, key), descriptor)
      assert.equal(providers.get('user-1'), null)
      assert.equal((await new SemanticIndexService(db, providers, sources).status('user-1')).state, 'unconfigured')
      assert.throws(() => providers.credentials('user-1'), /Configure an embedding provider/)
    } finally {
      db.close()
      await upstream.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('owns the rebuild lock before awaiting sources and releases it after failure', async () => {
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    providers.save('user-1', { kind: 'local', baseUrl: 'https://provider.invalid/v1', model: 'test' })
    let rejectSources!: (error: Error) => void
    let sourceCalls = 0
    const blockedSources = new Promise<Awaited<ReturnType<SemanticSources['installed']>>>(
      (_resolve, reject) => { rejectSources = reject }
    )
    const index = new SemanticIndexService(db, providers, {
      ...sources,
      installed() { sourceCalls += 1; return blockedSources }
    })
    try {
      const first = index.rebuild('user-1', () => undefined)
      await assert.rejects(index.rebuild('user-1', () => undefined), /already running/)
      assert.equal(sourceCalls, 1)
      rejectSources(new Error('source failure'))
      await assert.rejects(first, /source failure/)
      // A retry reaches source discovery rather than encountering a leaked lock.
      await assert.rejects(index.rebuild('user-1', () => undefined), /source failure/)
      assert.equal(sourceCalls, 2)
    } finally {
      db.close()
    }
  })

  it('releases the lock after unconfigured, empty-corpus, and cancelled setup', async () => {
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, { ...sources, async installed() { return [] } })
    try {
      await assert.rejects(index.rebuild('user-1', () => undefined), /Configure an embedding provider/)
      providers.save('user-1', { kind: 'local', baseUrl: 'https://provider.invalid/v1', model: 'test' })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(index.rebuild('user-1', () => undefined), /Install a public-domain corpus/)
      }
      const aborted = new AbortController()
      aborted.abort(new Error('cancelled during setup'))
      await assert.rejects(index.rebuild('user-1', () => undefined, aborted.signal), /cancelled during setup/)
      await assert.rejects(index.rebuild('user-1', () => undefined), /Install a public-domain corpus/)
    } finally {
      db.close()
    }
  })

  it('filters module kind and apocryphal books before semantic top-k ranking', async () => {
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: body.input.map((text, index) => ({
        index, embedding: /love/i.test(text) ? [1, 0] : [0, 1]
      })) }))
    })
    const scopedSources: SemanticSources = {
      ...sources,
      async installed() {
        const [bible] = await sources.installed()
        return [bible, { ...bible, id: 'Local:Ancient', name: 'Ancient', type: 'GENBOOK', kind: 'general-book', collection: 'ancient-writings' }]
      },
      async books() {
        return [{ code: 'John', name: 'John', section: 'nt', chapters: 1 }, { code: 'Tob', name: 'Tobit', section: 'apocrypha', chapters: 1 }]
      },
      async chapter(module, book) {
        return [{ module, book, bookName: book, chapter: 1, verse: 1, content: book === 'John' ? 'Love' : 'Other words' }]
      },
      async generalBookEntries() { return [{ key: 'Entry', title: 'Entry', content: 'Other words' }] }
    }
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'test' })
    const index = new SemanticIndexService(db, providers, scopedSources)
    try {
      await index.rebuild('user-1', () => undefined)
      const query = { query: 'love', modules: ['WEB', 'Ancient'], limit: 1 }
      const all = await index.search('user-1', query)
      assert.equal(all[0].kind, 'scripture')
      const apocrypha = await index.search('user-1', { ...query, scope: 'apocrypha' })
      assert.equal(apocrypha.length, 1)
      assert.equal(apocrypha[0].kind, 'scripture')
      if (apocrypha[0].kind === 'scripture') assert.equal(apocrypha[0].book, 'Tob')
      const ancient = await index.search('user-1', { ...query, scope: 'ancient-writings' })
      assert.equal(ancient[0].kind, 'general-book')
      assert.deepEqual(await index.search('user-1', { ...query, modules: ['Ancient'], scope: 'scripture' }), [])
      await assert.rejects(index.search('user-1', { ...query, scope: 'invalid' }), /Invalid search scope/)
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('isolates embedding configuration and never exposes or stores plaintext keys', () => {
    const db = openDatabase(':memory:')
    seedUser(db)
    db.prepare(`
      INSERT INTO users (id, username, username_normalized, password_hash, role, created_at)
      VALUES ('user-2', 'Reader', 'reader', 'hash', 'member', 2)
    `).run()
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    try {
      const saved = providers.save('user-1', {
        kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-example', batchSize: 17, apiKey: 'plaintext-embedding-secret'
      })
      assert.deepEqual(saved, {
        kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-example', batchSize: 17, hasApiKey: true
      })
      assert.throws(() => providers.save('user-1', {
        kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-example', batchSize: 0
      }), /integer between 1 and 64/)
      assert.throws(() => providers.save('user-1', {
        kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-example', batchSize: 32.5
      }), /integer between 1 and 64/)
      const retained = providers.save('user-1', {
        kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-example'
      })
      assert.equal(retained.batchSize, 17)
      assert.equal(providers.get('user-2'), null)
      const row = db.prepare(`
        SELECT ciphertext FROM user_secrets WHERE user_id = 'user-1' AND name = 'embedding-provider-api-key'
      `).get() as { ciphertext: Buffer }
      assert.equal(row.ciphertext.includes(Buffer.from('plaintext-embedding-secret')), false)
    } finally {
      db.close()
    }
  })

  it('stores per-user provider settings, rebuilds staged vectors, and ranks by meaning', async () => {
    let fail = false
    let embeddingRequests = 0
    const upstream = await listen(async (request, response) => {
      embeddingRequests += 1
      assert.equal(request.url, '/v1/embeddings')
      if (fail) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end('{"error":"offline"}')
        return
      }
      const body = await requestBody(request)
      const data = body.input.map((input, index) => ({
        index,
        embedding: /love/i.test(input) ? [1, 0] : /grace/i.test(input) ? [0, 1] : [-1, 0]
      }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data }))
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    db.prepare(`
      INSERT INTO users (id, username, username_normalized, password_hash, role, created_at)
      VALUES ('user-2', 'Reader', 'reader', 'hash', 'member', 2)
    `).run()
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, sources)
    try {
      assert.deepEqual(await index.status('user-1'), {
        state: 'unconfigured', chunkCount: 0, modules: [], model: null,
        updatedAt: null, lastError: null
      })
      providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny' })
      const progress: number[] = []
      const built = await index.rebuild('user-1', ({ processed }) => progress.push(processed))
      assert.equal(built.state, 'ready')
      assert.equal(built.chunkCount, 3)
      assert.deepEqual(built.modules, ['WEB'])
      assert.deepEqual(progress, [3])

      const hits = await index.search('user-1', { query: 'teachings about love', modules: ['WEB'], limit: 2 })
      assert.equal(hits.length, 2)
      assert.equal(hits[0].verse, 1)
      assert.equal(hits[0].distance, 0)

      const beforeNeighbors = embeddingRequests
      const neighbors = await index.neighbors('user-1', {
        module: 'WEB', book: 'John', chapter: 1, verseStart: 1, verseEnd: 1
      }, 2)
      assert.equal(neighbors.state, 'ready')
      assert.deepEqual(neighbors.results.map((hit) => hit.verse), [2, 3])
      assert.equal(embeddingRequests, beforeNeighbors, 'stored vectors should avoid an upstream request')

      providers.save('user-2', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny' })
      const isolated = await index.neighbors('user-2', {
        module: 'WEB', book: 'John', chapter: 1, verseStart: 1, verseEnd: 1
      })
      assert.deepEqual(isolated, { state: 'empty', results: [] })

      fail = true
      await assert.rejects(index.rebuild('user-1', () => undefined), /503/)
      const preserved = await index.status('user-1')
      assert.equal(preserved.state, 'ready')
      assert.equal(preserved.chunkCount, 3)
      assert.match(preserved.lastError ?? '', /503/)
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('indexes Generic Book entries only after a non-public-domain license opt-in', async () => {
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: body.input.map((input, index) => ({
        index, embedding: /watchers/i.test(input) ? [1, 0] : [0, 1]
      })) }))
    })
    const generalSources: SemanticSources = {
      async installed() {
        return [{
          id: 'Local import:Ancient', name: 'Ancient', type: 'GENBOOK',
          description: 'Ancient writing', language: 'en', distributionLicense: 'CC BY-SA',
          hasStrongs: false, hasGreekStrongsKeys: false, hasHebrewStrongsKeys: false,
          hasFootnotes: false, hasHeadings: false, hasRedLetterWords: false,
          hasCrossReferences: false, locked: false, installed: true, kind: 'general-book',
          collection: 'ancient-writings', coverage: [], coverageSource: 'live',
          format: 'standalone', coverageSummary: 'Standalone ancient writing',
          aiEligibility: 'review-required'
        }]
      },
      async books() { return [] },
      async chapter() { return [] },
      async generalBookEntries() {
        return [
          { key: '/Ancient/Watchers', title: 'Watchers', content: 'The watchers gathered.', depth: 1 },
          { key: '/Ancient/Journey', title: 'Journey', content: 'A distant journey.', depth: 1 }
        ]
      }
    }
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generalSources)
    try {
      providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny' })
      await assert.rejects(index.rebuild('user-1', () => undefined), /enable an installed module/)
      assert.throws(() => index.setCorpusPreference('user-1', {
        module: 'Ancient', enabled: true, licenseAcknowledged: false
      }), /Acknowledge the module license/)
      index.setCorpusPreference('user-1', {
        module: 'Ancient', enabled: true, licenseAcknowledged: true
      })
      const built = await index.rebuild('user-1', () => undefined)
      assert.equal(built.chunkCount, 2)
      const [hit] = await index.search('user-1', { query: 'watchers', modules: ['Ancient'] })
      assert.equal(hit.kind, 'general-book')
      if (hit.kind === 'general-book') {
        assert.equal(hit.key, '/Ancient/Watchers')
        assert.equal(hit.title, 'Watchers')
      }
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('marks an index stale after embedding configuration changes', async () => {
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: body.input.map((_input, index) => ({ index, embedding: [1, 0] })) }))
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, sources)
    try {
      providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'first' })
      await index.rebuild('user-1', () => undefined)
      providers.save('user-1', {
        kind: 'local', baseUrl: upstream.baseUrl, model: 'first', batchSize: 16
      })
      assert.equal((await index.status('user-1')).state, 'ready')
      providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'second' })
      assert.equal((await index.status('user-1')).state, 'stale')
      await assert.rejects(
        index.search('user-1', { query: 'love', modules: ['WEB'] }),
        /stale/
      )
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('uses the configured provider batch size across a multi-batch rebuild', async () => {
    const requestSizes: number[] = []
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      requestSizes.push(body.input.length)
      sendVectors(response, body.input)
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generatedSources(70))
    try {
      providers.save('user-1', {
        kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 20
      })
      const progress: Array<{ processed: number; batchSize: number }> = []
      const built = await index.rebuild('user-1', ({ processed, batchSize }) => {
        progress.push({ processed, batchSize })
      })
      assert.equal(built.chunkCount, 70)
      assert.deepEqual(requestSizes, [20, 20, 20, 10])
      assert.deepEqual(progress, [
        { processed: 20, batchSize: 20 },
        { processed: 40, batchSize: 20 },
        { processed: 60, batchSize: 20 },
        { processed: 70, batchSize: 20 }
      ])
    } finally {
      db.close()
      await upstream.close()
    }
  })

  for (const failure of ['timeout', 'body timeout'] as const) {
    it(`retries ${failure}, then halves an odd batch and continues without losing or duplicating inputs`, async (t) => {
      const delays = recordRetryDelays(t)
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
      t.mock.method(AbortSignal, 'timeout', () => originalTimeout(100))
      const requestSizes: number[] = []
      const completedInputs: string[] = []
      const upstream = await listen(async (request, response) => {
        const body = await requestBody(request)
        requestSizes.push(body.input.length)
        if (requestSizes.length <= 3) {
          if (failure === 'timeout') return // No headers: exercise fetch's timeout path.
          if (failure === 'body timeout') {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.write('{"data":[') // Headers arrive, but the body never finishes.
            return
          }
        }
        completedInputs.push(...body.input)
        sendVectors(response, body.input)
      })
      const db = openDatabase(':memory:')
      seedUser(db)
      const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
      const index = new SemanticIndexService(db, providers, generatedSources(11))
      try {
        providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 5 })
        const progress: Array<{ processed: number; batchSize: number }> = []
        const built = await index.rebuild('user-1', ({ processed, batchSize }) => progress.push({ processed, batchSize }))
        assert.equal(built.state, 'ready')
        assert.equal(built.chunkCount, 11)
        assert.deepEqual(requestSizes, [5, 5, 5, 2, 2, 1, 2, 2, 2])
        assert.deepEqual(delays, [500, 1000])
        assert.deepEqual(completedInputs, Array.from({ length: 11 }, (_, i) => `John 1:${i + 1}\nGenerated verse ${i + 1}.`))
        assert.deepEqual(progress, [
          { processed: 5, batchSize: 2 }, { processed: 7, batchSize: 2 },
          { processed: 9, batchSize: 2 }, { processed: 11, batchSize: 2 }
        ])
        assert.equal(providers.get('user-1')?.batchSize, 5, 'reduction must only affect this run')
      } finally {
        db.close()
        await upstream.close()
      }
    })
  }

  for (const status of [429, 502]) {
    it(`recovers from ${status} within the retry budget without reducing the batch size`, async (t) => {
      const delays = recordRetryDelays(t)
      const requestSizes: number[] = []
      const upstream = await listen(async (request, response) => {
        const body = await requestBody(request)
        requestSizes.push(body.input.length)
        if (requestSizes.length <= 2) {
          response.writeHead(status)
          response.end('temporary gateway failure')
        } else sendVectors(response, body.input)
      })
      const db = openDatabase(':memory:')
      seedUser(db)
      const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
      const index = new SemanticIndexService(db, providers, generatedSources(9))
      try {
        providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 4 })
        assert.equal((await index.rebuild('user-1', () => undefined)).chunkCount, 9)
        assert.deepEqual(requestSizes, [4, 4, 4, 4, 1])
        assert.deepEqual(delays, [500, 1000])
      } finally {
        db.close()
        await upstream.close()
      }
    })
  }

  for (const status of [429, 500, 503, 599]) {
    it(`exhausts ${status} retries without splitting, removes staged data and preserves the active index`, async (t) => {
      const delays = recordRetryDelays(t)
      let failing = false
      const requestSizes: number[] = []
      const upstream = await listen(async (request, response) => {
        const body = await requestBody(request)
        requestSizes.push(body.input.length)
        // Stage one successful batch in the replacement run before the outage.
        if (failing && requestSizes.length > 1) {
          response.writeHead(status)
          // Even misleading batch-limit text in a 429/5xx must not cause splitting.
          response.end('provider offline: maximum batch size 1')
        } else sendVectors(response, body.input)
      })
      const db = openDatabase(':memory:')
      seedUser(db)
      const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
      const index = new SemanticIndexService(db, providers, generatedSources(9))
      try {
        providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 4 })
        await index.rebuild('user-1', () => undefined)
        const activeBefore = db.prepare('SELECT * FROM semantic_active_indexes').all()
        const chunksBefore = db.prepare('SELECT * FROM semantic_chunks ORDER BY id').all()
        const vectorsBefore = db.prepare('SELECT * FROM semantic_vectors_d2 ORDER BY chunk_id').all()
        failing = true
        requestSizes.length = 0
        await assert.rejects(index.rebuild('user-1', () => undefined), new RegExp(`failed after 3 attempts at batch size 4.*retry limit reached.*${status}.*provider offline`))
        assert.deepEqual(requestSizes, [4, 4, 4, 4])
        assert.deepEqual(delays, [500, 1000])
        assert.deepEqual(db.prepare('SELECT * FROM semantic_active_indexes').all(), activeBefore)
        assert.deepEqual(db.prepare('SELECT * FROM semantic_chunks ORDER BY id').all(), chunksBefore)
        assert.deepEqual(db.prepare('SELECT * FROM semantic_vectors_d2 ORDER BY chunk_id').all(), vectorsBefore)
        const failed = db.prepare("SELECT chunk_count FROM semantic_index_runs WHERE status = 'failed'").all()
        assert.deepEqual(failed, [{ chunk_count: 0 }])
        const indexStatus = await index.status('user-1')
        assert.equal(indexStatus.state, 'ready')
        assert.equal(indexStatus.chunkCount, 9)
        assert.match(indexStatus.lastError ?? '', /retry limit reached/)
        failing = false
        assert.equal((await index.search('user-1', { query: 'love', modules: ['WEB'] })).length, 9)
        // The failed run must also release the rebuild lock.
        assert.equal((await index.rebuild('user-1', () => undefined)).state, 'ready')
      } finally {
        db.close()
        await upstream.close()
      }
    })
  }

  const retryNow = Date.UTC(2030, 0, 1)
  for (const status of [429, 503]) {
    for (const [name, header, expectedDelay] of [
      ['missing', undefined, 500],
      ['zero', '0', 500],
      ['seconds', '2', 2000],
      ['at cap', '30', 30_000],
      ['above cap', '31', 30_000],
      ['overflowing seconds', '9'.repeat(400), 30_000],
      ['negative', '-1', 500],
      ['fractional', '1.5', 500],
      ['exponent', '1e3', 500],
      ['empty', '', 500],
      ['invalid date', 'not a date', 500],
      ['future date', new Date(retryNow + 5000).toUTCString(), 5000],
      ['capped date', new Date(retryNow + 60_000).toUTCString(), 30_000],
      ['past date', new Date(retryNow - 5000).toUTCString(), 500]
    ] as const) {
      it(`handles ${name} Retry-After on ${status} without splitting or exceeding the retry budget`, async (t) => {
        t.mock.method(Date, 'now', () => retryNow)
        const delays = recordRetryDelays(t)
        const requestSizes: number[] = []
        const upstream = await listen(async (request, response) => {
          const body = await requestBody(request)
          requestSizes.push(body.input.length)
          // The next response omits Retry-After: a previous value must not stick.
          response.writeHead(status, requestSizes.length === 1 && header !== undefined
            ? { 'retry-after': header } : {})
          response.end('unavailable')
        })
        const db = openDatabase(':memory:')
        seedUser(db)
        const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
        const index = new SemanticIndexService(db, providers, generatedSources(8))
        try {
          providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 8 })
          await assert.rejects(index.rebuild('user-1', () => assert.fail('failed batch must not advance progress')),
            /failed after 3 attempts at batch size 8.*retry limit reached/)
          assert.deepEqual(requestSizes, [8, 8, 8])
          assert.deepEqual(delays, [expectedDelay, 1000])
          assert.equal((await index.status('user-1')).state, 'failed')
          assert.deepEqual(db.prepare('SELECT * FROM semantic_chunks').all(), [])
        } finally {
          db.close()
          await upstream.close()
        }
      })
    }
  }

  for (const failure of ['timeout', 'body timeout'] as const) {
    it(`bounds permanent ${failure} at batch size 8 to exactly 12 requests and skips all sibling batches`, async (t) => {
      const delays = recordRetryDelays(t)
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
      t.mock.method(AbortSignal, 'timeout', () => originalTimeout(100))
      const requestedInputs: string[][] = []
      const upstream = await listen(async (request, response) => {
        requestedInputs.push((await requestBody(request)).input)
        if (failure === 'body timeout') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.write('{"data":[')
        }
        // Permanently stall every request, including singletons.
      })
      const db = openDatabase(':memory:')
      seedUser(db)
      const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
      const index = new SemanticIndexService(db, providers, generatedSources(16))
      try {
        providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 8 })
        await assert.rejects(index.rebuild('user-1', () => assert.fail('failed batch must not advance progress')),
          /failed after 3 attempts at batch size 1.*retry limit reached.*timed out/)
        assert.equal(requestedInputs.length, 12, '3 attempts * 4 sizes; the first failing child stops recursion')
        assert.deepEqual(requestedInputs.map((inputs) => inputs.length), [8, 8, 8, 4, 4, 4, 2, 2, 2, 1, 1, 1])
        for (const inputs of requestedInputs) {
          assert.deepEqual(inputs, requestedInputs[0].slice(0, inputs.length), 'only the first child may run')
        }
        assert.deepEqual(delays, [500, 1000, 500, 1000, 500, 1000, 500, 1000])
        assert.equal((await index.status('user-1')).state, 'failed')
        assert.deepEqual(db.prepare('SELECT * FROM semantic_chunks').all(), [])
      } finally {
        db.close()
        await upstream.close()
      }
    })
  }

  it('stops retrying immediately when cancelled during backoff', async () => {
    const abort = new AbortController()
    let requests = 0
    const upstream = await listen(async (request, response) => {
      await requestBody(request)
      requests += 1
      response.writeHead(429, { 'retry-after': '120' })
      response.end('rate limited')
      setTimeout(() => abort.abort(), 50)
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, sources)
    try {
      providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny' })
      await assert.rejects(index.rebuild('user-1', () => undefined, abort.signal), /aborted|cancelled/)
      assert.equal(requests, 1)
      assert.equal((await index.status('user-1')).state, 'failed')
      assert.deepEqual(db.prepare('SELECT * FROM semantic_chunks').all(), [])
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('reuses the minimum batch size for remaining inputs after repeated timeouts', async (t) => {
    recordRetryDelays(t)
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    t.mock.method(AbortSignal, 'timeout', () => originalTimeout(100))
    const requestSizes: number[] = []
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      requestSizes.push(body.input.length)
      if (body.input.length > 1) return // A provider that only completes singletons.
      sendVectors(response, body.input)
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generatedSources(7))
    try {
      providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 5 })
      assert.equal((await index.rebuild('user-1', () => undefined)).chunkCount, 7)
      assert.deepEqual(requestSizes, [5, 5, 5, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1])
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('fails immediately on malformed vectors after a transient failure', async () => {
    let requests = 0
    const upstream = await listen(async (request, response) => {
      await requestBody(request)
      requests += 1
      response.writeHead(requests === 1 ? 500 : 200)
      response.end(requests === 1 ? 'temporary failure' : '{"data":[{"embedding":[null]}]}')
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generatedSources(1))
    try {
      providers.save('user-1', { kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 1 })
      await assert.rejects(index.rebuild('user-1', () => undefined), /non-numeric vector/)
      assert.equal(requests, 2)
      assert.equal((await index.status('user-1')).state, 'failed')
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('reduces a rejected 64-input batch to the reported limit and continues at 32', async () => {
    const requestSizes: number[] = []
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      requestSizes.push(body.input.length)
      if (body.input.length > 32) {
        response.writeHead(422, { 'content-type': 'text/plain' })
        response.end('batch size 64 > maximum allowed batch size 32')
        return
      }
      sendVectors(response, body.input)
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generatedSources(70))
    try {
      providers.save('user-1', {
        kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 64
      })
      const progress: Array<{ processed: number; batchSize: number }> = []
      const built = await index.rebuild('user-1', ({ processed, batchSize }) => {
        progress.push({ processed, batchSize })
      })
      assert.equal(built.state, 'ready')
      assert.equal(built.chunkCount, 70)
      assert.deepEqual(requestSizes, [64, 32, 32, 6])
      assert.deepEqual(progress, [
        { processed: 64, batchSize: 32 },
        { processed: 70, batchSize: 32 }
      ])
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('rejects inconsistent vector dimensions across adaptive sub-batches', async () => {
    let acceptedBatches = 0
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      if (body.input.length > 32) {
        response.writeHead(422, { 'content-type': 'text/plain' })
        response.end('maximum allowed batch size 32')
        return
      }
      acceptedBatches += 1
      const embedding = acceptedBatches === 1 ? [1, 0] : [1, 0, 0]
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: body.input.map((_input, index) => ({ index, embedding }))
      }))
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generatedSources(64))
    try {
      providers.save('user-1', {
        kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 64
      })
      await assert.rejects(
        index.rebuild('user-1', () => undefined),
        /dimension changed within a retried batch/
      )
      assert.equal((await index.status('user-1')).state, 'failed')
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('cancels during an adaptive retry without sending further sub-batches', async () => {
    const requestSizes: number[] = []
    const abort = new AbortController()
    const upstream = await listen(async (request, response) => {
      const body = await requestBody(request)
      requestSizes.push(body.input.length)
      if (body.input.length === 64) {
        response.writeHead(422, { 'content-type': 'text/plain' })
        response.end('maximum allowed batch size 32')
        return
      }
      abort.abort()
      await delay(20)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"data":[]}')
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generatedSources(64))
    try {
      providers.save('user-1', {
        kind: 'local', baseUrl: upstream.baseUrl, model: 'tiny', batchSize: 64
      })
      await assert.rejects(index.rebuild('user-1', () => undefined, abort.signal), /cancelled/)
      assert.deepEqual(requestSizes, [64, 32])
      assert.equal((await index.status('user-1')).state, 'failed')
    } finally {
      db.close()
      await upstream.close()
    }
  })

  it('does not retry a non-batch-related 422 response', async () => {
    let requests = 0
    const upstream = await listen(async (request, response) => {
      await requestBody(request)
      requests += 1
      response.writeHead(422, { 'content-type': 'application/json' })
      response.end('{"error":"model is unavailable"}')
    })
    const db = openDatabase(':memory:')
    seedUser(db)
    const providers = new EmbeddingProviderService(db, new SecretStore(db, randomBytes(32)))
    const index = new SemanticIndexService(db, providers, generatedSources(70))
    try {
      providers.save('user-1', {
        kind: 'local', baseUrl: upstream.baseUrl, model: 'missing', batchSize: 64
      })
      await assert.rejects(index.rebuild('user-1', () => undefined), /model is unavailable/)
      assert.equal(requests, 1)
    } finally {
      db.close()
      await upstream.close()
    }
  })
})

describe('semantic provider migration', () => {
  it('upgrades schema v4 provider rows with the conservative batch default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machaira-semantic-migration-'))
    const filename = join(dir, 'machaira.sqlite')
    const old = new Database(filename)
    old.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (4, 1);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled_at INTEGER, created_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('user-1', 'Owner', 'owner', 'hash', 'admin', NULL, 1);
      CREATE TABLE embedding_provider_configs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'local')),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO embedding_provider_configs
        VALUES ('user-1', 'local', 'http://localhost:11434/v1', 'tiny', 1);
    `)
    old.close()

    const db = openDatabase(filename)
    try {
      const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get() as { version: number }
      const provider = db.prepare(`
        SELECT batch_size FROM embedding_provider_configs WHERE user_id = 'user-1'
      `).get() as { batch_size: number }
      assert.equal(version.version, 12)
      assert.equal(provider.batch_size, 32)
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
