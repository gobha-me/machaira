import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { describe, it, type TestContext } from 'node:test'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/database.ts'
import { SecretStore } from '../src/secrets.ts'
import { MAX_BUNDLED_TTS_QUEUE_SIZE, TtsService } from '../src/tts.ts'

const bundled = {
  source: 'bundled' as const, engine: 'kokoro',
  baseUrl: 'http://127.0.0.1:8880/v1', model: 'kokoro', voice: 'af_heart'
}
const input = { provider: 'local', text: 'Light' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Hold actual audio bodies open, rather than just delaying response headers: a
// slot must cover synthesis and the entire response read, including read errors.
function controlledProvider(t: TestContext) {
  const calls: Array<{
    text: string
    signal: AbortSignal
    end: () => void
    fail: () => void
  }> = []
  let changed = deferred<void>()
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const signal = init.signal!
    signal.throwIfAborted()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => controller.error(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        const cleanup = () => signal.removeEventListener('abort', onAbort)
        calls.push({
          text: JSON.parse(String(init.body)).input,
          signal,
          end() {
            cleanup()
            controller.enqueue(Buffer.from('audio'))
            controller.close()
          },
          fail() {
            cleanup()
            controller.error(new Error('audio connection broke'))
          }
        })
        changed.resolve()
        changed = deferred<void>()
      }
    })
    return new Response(stream, { headers: { 'content-type': 'audio/mpeg' } })
  })
  return {
    calls,
    async waitFor(count: number) {
      while (calls.length < count) await changed.promise
    }
  }
}

function service(t: TestContext, source: 'bundled' | 'external' = 'bundled') {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  for (const id of ['first', 'second']) {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, NULL, 1)')
      .run(id, id, id, 'unused', 'member')
  }
  return new TtsService(db, new SecretStore(db, randomBytes(32)), { ...bundled, source })
}

describe('bundled TTS queue', { timeout: 10_000 }, () => {
  it('serializes across accounts and saved overrides until audio is fully read, in FIFO order', async (t) => {
    const provider = controlledProvider(t)
    const tts = service(t)
    tts.save('second', {
      order: ['local'],
      local: { provider: 'openai-compatible', ...bundled, baseUrl: `${bundled.baseUrl}/` }
    })
    const first = tts.speech('first', { ...input, text: 'first' })
    await provider.waitFor(1)
    const second = tts.speech('second', { ...input, text: 'second' })
    const third = tts.speech('first', { ...input, text: 'third' })
    await setImmediate()
    assert.deepEqual(provider.calls.map((call) => call.text), ['first'])
    provider.calls[0].end()
    assert.equal((await first).audio.toString(), 'audio')
    await provider.waitFor(2)
    assert.deepEqual(provider.calls.map((call) => call.text), ['first', 'second'])
    provider.calls[1].end()
    await second
    await provider.waitFor(3)
    provider.calls[2].end()
    await third
    assert.deepEqual(provider.calls.map((call) => call.text), ['first', 'second', 'third'])
  })

  it('bounds the waiting queue, validates before admission, and removes a cancelled waiter', async (t) => {
    const provider = controlledProvider(t)
    const tts = service(t)
    const active = tts.speech('first', input)
    await provider.waitFor(1)
    const cancelled = new AbortController()
    const waiting = Array.from({ length: MAX_BUNDLED_TTS_QUEUE_SIZE }, (_, index) =>
      tts.speech('second', { ...input, text: `queued ${index}` }, index === 3 ? cancelled.signal : undefined))
    const cancelledResult = assert.rejects(waiting[3], /cancelled while queued/)
    await assert.rejects(tts.speech('first', input), /queue is full.*try again later/)
    await assert.rejects(tts.speech('first', { ...input, text: '' }), /Speech text is required/)
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    await assert.rejects(tts.speech('first', input, alreadyCancelled.signal), /cancelled/)
    assert.equal(provider.calls.length, 1)

    cancelled.abort()
    await cancelledResult
    const replacement = tts.speech('first', { ...input, text: 'replacement' })
    await assert.rejects(tts.speech('first', input), /queue is full/)
    provider.calls[0].end()
    await active
    for (let index = 1; index <= MAX_BUNDLED_TTS_QUEUE_SIZE; index++) {
      await provider.waitFor(index + 1)
      provider.calls[index].end()
    }
    await Promise.all([...waiting.filter((_, index) => index !== 3), replacement])
    assert.deepEqual(provider.calls.map((call) => call.text), [
      'Light', ...Array.from({ length: MAX_BUNDLED_TTS_QUEUE_SIZE }, (_, index) => `queued ${index}`)
        .filter((text) => text !== 'queued 3'), 'replacement'
    ])
  })

  it('releases an active slot when cancelled during audio streaming or when the stream fails', async (t) => {
    const provider = controlledProvider(t)
    const tts = service(t)
    const abort = new AbortController()
    const active = tts.speech('first', input, abort.signal)
    const cancelled = assert.rejects(active, /cancelled/)
    await provider.waitFor(1)
    const next = tts.speech('second', input)
    const failed = assert.rejects(next, /audio connection broke/)
    abort.abort()
    await cancelled
    await provider.waitFor(2)
    const last = tts.speech('first', input)
    provider.calls[1].fail()
    await failed
    await provider.waitFor(3)
    provider.calls[2].end()
    await last
  })

  it('starts synthesis timeouts only after admission and frees the slot on a timeout before headers', async (t) => {
    const tts = service(t)
    const timeouts: AbortController[] = []
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      assert.equal(milliseconds, 60_000)
      const controller = new AbortController()
      timeouts.push(controller)
      return controller.signal
    })
    const started = deferred<void>()
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      if (++calls > 1) return new Response('audio', { headers: { 'content-type': 'audio/mpeg' } })
      started.resolve()
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    })
    const active = tts.speech('first', input)
    const timedOut = assert.rejects(active, /timed out/)
    await started.promise
    const queued = tts.speech('second', input)
    await setImmediate()
    assert.equal(timeouts.length, 1)
    assert.equal(calls, 1)
    timeouts[0].abort(new DOMException('Synthesis deadline exceeded', 'TimeoutError'))
    await timedOut
    assert.equal((await queued).audio.toString(), 'audio')
    assert.equal(timeouts.length, 2)
  })

  it('releases a slot after connection failures, HTTP errors, or invalid audio', async (t) => {
    const tts = service(t)
    for (const failure of ['connection', 'http', 'type', 'empty', 'oversized']) {
      const started = deferred<void>()
      const response = deferred<Response>()
      let calls = 0
      t.mock.method(globalThis, 'fetch', async () => {
        if (++calls > 1) return new Response('audio', { headers: { 'content-type': 'audio/mpeg' } })
        started.resolve()
        return response.promise
      })
      const first = tts.speech('first', input)
      const rejected = assert.rejects(first, /Could not reach|HTTP 503|did not return audio|empty audio|oversized audio/)
      await started.promise
      const next = tts.speech('second', input)
      if (failure === 'connection') response.reject(new Error('connection refused'))
      else response.resolve(new Response(failure === 'empty' ? '' : 'invalid', {
        status: failure === 'http' ? 503 : 200,
        headers: {
          'content-type': failure === 'type' ? 'application/json' : 'audio/mpeg',
          ...(failure === 'oversized' ? { 'content-length': String(11 * 1024 * 1024) } : {})
        }
      }))
      await rejected
      assert.equal((await next).audio.toString(), 'audio')
      assert.equal(calls, 2)
      t.mock.restoreAll()
    }
  })

  it('does not serialize external deployment providers or unrelated account endpoints', async (t) => {
    const provider = controlledProvider(t)
    const external = service(t, 'external')
    const bundledService = service(t)
    bundledService.save('second', {
      order: ['local'], local: { ...bundled, provider: 'openai-compatible', baseUrl: 'https://other.invalid/v1' }
    })
    const requests = [
      external.speech('first', input), external.speech('second', input),
      bundledService.speech('first', input), bundledService.speech('second', input)
    ]
    await provider.waitFor(4)
    for (const call of provider.calls) call.end()
    await Promise.all(requests)
  })
})

describe('bundled TTS HTTP admission and disconnects', { timeout: 10_000 }, () => {
  it('returns a clear 429 at capacity while health stays available, then drains the queue', async (t) => {
    const provider = controlledProvider(t)
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false,
      registerFeatureRoutes: false, deploymentProviders: { tts: bundled }
    })
    t.after(() => app.close())
    const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
      username: 'Owner', password: 'correct horse battery staple'
    } })
    const headers = { cookie: String(bootstrap.headers['set-cookie']).split(';')[0] }
    const speech = () => app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload: input })
    // Starting each injection and yielding lets its handler reach admission before
    // sending the overflow request; no provider response is released yet.
    const pending = []
    for (let index = 0; index <= MAX_BUNDLED_TTS_QUEUE_SIZE; index++) {
      pending.push(speech().then((response) => response))
      await setImmediate()
    }
    const overflow = await speech()
    assert.equal(overflow.statusCode, 429)
    assert.match(overflow.json().error, /Bundled TTS queue is full.*try again later/)
    assert.equal(provider.calls.length, 1)
    assert.equal((await app.inject('/api/health')).statusCode, 200)
    assert.equal((await app.inject({
      method: 'POST', url: '/api/tts/speech', headers, payload: { ...input, provider: 'browser' }
    })).statusCode, 400)
    for (let index = 0; index <= MAX_BUNDLED_TTS_QUEUE_SIZE; index++) {
      await provider.waitFor(index + 1)
      provider.calls[index].end()
    }
    for (const response of await Promise.all(pending)) assert.equal(response.statusCode, 200)
  })

  it('cancels provider work after a socket closes with the entire request body already sent', async (t) => {
    const provider = controlledProvider(t)
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false,
      registerFeatureRoutes: false, deploymentProviders: { tts: bundled }
    })
    t.after(() => app.close())
    const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
      username: 'Owner', password: 'correct horse battery staple'
    } })
    const headers = { cookie: String(bootstrap.headers['set-cookie']).split(';')[0] }
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const request = httpRequest(`${address}/api/tts/speech`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }
    })
    const closed = new Promise<void>((resolve) => request.once('close', resolve))
    request.on('error', () => { /* Destroying a pending request causes ECONNRESET. */ })
    request.end(JSON.stringify(input))
    await provider.waitFor(1)
    const next = app.inject({ method: 'POST', url: '/api/tts/speech', headers, payload: input })
      .then((response) => response)
    await setImmediate()
    request.destroy()
    await closed
    await provider.waitFor(2)
    assert.equal(provider.calls[0].signal.aborted, true)
    provider.calls[1].end()
    assert.equal((await next).statusCode, 200)
  })
})
