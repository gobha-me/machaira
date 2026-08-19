import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { openDatabase } from '../src/database.ts'
import { SecretStore } from '../src/secrets.ts'
import {
  EmbeddingProviderService,
  SemanticIndexService,
  type SemanticSources
} from '../src/semantic.ts'

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
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
      name: 'WEB', type: 'BIBLE', description: 'World English Bible', language: 'en',
      version: '1', hasStrongs: false, hasGreekStrongsKeys: false,
      hasHebrewStrongsKeys: false, hasFootnotes: false, hasHeadings: false,
      hasRedLetterWords: false, hasCrossReferences: false, locked: false, installed: true
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

describe('semantic index', () => {
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
        model: 'text-embedding-example', apiKey: 'plaintext-embedding-secret'
      })
      assert.deepEqual(saved, {
        kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-example', hasApiKey: true
      })
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
})
